/**
 * LAYER 4: DECISION/PROVENANCE tools
 *
 * Full decision lifecycle: Proposal → Approval → Action → Outcome
 * Every step has evidence links back to events, signals, and rules.
 *
 * Also includes: findings (shared workspace), memory (cross-session).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeQuery } from '../database/index.js';
import { ScenarioLoader } from '../config/index.js';
import { filterPiiFromFinding } from '../governance/index.js';
import { getAuthContext } from '../auth/context.js';

let loader: ScenarioLoader | null = null;

export function initPersistTools(scenarioPath: string) {
	loader = new ScenarioLoader(scenarioPath);
}

export function registerPersistTools(server: McpServer) {
	// ─── Findings (shared workspace) ───

	server.tool(
		'write_finding',
		'Store an intermediate finding for the current session (shared workspace)',
		{
			session_id: z.string().describe('Current decision session ID'),
			finding: z.string().describe('The finding content (PII must not be included)'),
			confidence: z.enum(['high', 'medium', 'low']).describe('Confidence in this finding'),
			data_sources: z.array(z.string()).optional().describe('Tables/measures used'),
		},
		async ({ session_id, finding, confidence, data_sources }) => {
			const ctx = getAuthContext();
			const agent_id = ctx.agentId;
			try {
				const safeFinding = filterPiiFromFinding(finding);
				const result = await executeQuery(
					`INSERT INTO decision_findings (session_id, agent_id, finding, confidence, data_sources, auth_method, token_hash, correlation_id)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
					 RETURNING finding_id, created_at`,
					[
						session_id,
						agent_id,
						safeFinding,
						confidence,
						data_sources ?? null,
						ctx.authMethod,
						ctx.tokenHash,
						ctx.sessionId,
					],
				);
				const row = result.rows[0] as { finding_id: number; created_at: string };
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								finding_id: row.finding_id,
								session_id,
								agent_id,
								stored: true,
								timestamp: row.created_at,
							}),
						},
					],
				};
			} catch (err) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
				};
			}
		},
	);

	server.tool(
		'read_findings',
		'Read all agent findings for the current session',
		{
			session_id: z.string().describe('Session to read findings from'),
			agent_filter: z.string().optional().describe('Only return findings from this agent'),
		},
		async ({ session_id, agent_filter }) => {
			try {
				let sql: string;
				let params: unknown[];
				if (agent_filter) {
					sql = `SELECT finding_id, agent_id, finding, confidence, data_sources, created_at
					       FROM decision_findings WHERE session_id = $1 AND agent_id = $2
					       ORDER BY created_at ASC`;
					params = [session_id, agent_filter];
				} else {
					sql = `SELECT finding_id, agent_id, finding, confidence, data_sources, created_at
					       FROM decision_findings WHERE session_id = $1
					       ORDER BY created_at ASC`;
					params = [session_id];
				}
				const result = await executeQuery(sql, params);
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ session_id, findings: result.rows, total: result.rowCount }),
						},
					],
				};
			} catch (err) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
				};
			}
		},
	);

	// ─── Decision Lifecycle: Proposal → Approval → Action → Outcome ───

	/**
	 * propose_decision — Agent proposes an action with evidence.
	 *
	 * Evidence links connect the proposal to:
	 * - Event IDs that triggered it (from Layer 3 event log)
	 * - Signal types that informed it (from process intelligence)
	 * - Business rules that constrain it (from Layer 2)
	 */
	server.tool(
		'propose_decision',
		'Propose a decision with evidence links to events, signals, and rules',
		{
			session_id: z.string().describe('Current session ID'),
			proposed_action: z.string().describe('What action is proposed'),
			confidence: z.enum(['high', 'medium', 'low']).describe('Confidence in the proposal'),
			risk_class: z.enum(['low', 'medium', 'high', 'critical']).describe('Risk classification'),
			evidence_event_ids: z.array(z.number()).optional().describe('Event IDs that triggered this proposal'),
			evidence_signal_types: z.array(z.string()).optional().describe('Process signal types that informed this'),
			evidence_rules: z.array(z.string()).optional().describe('Business rules that apply'),
		},
		async ({
			session_id,
			proposed_action,
			confidence,
			risk_class,
			evidence_event_ids,
			evidence_signal_types,
			evidence_rules,
		}) => {
			const ctx = getAuthContext();
			const agent_id = ctx.agentId;
			try {
				// Validate evidence links before storing
				const validationErrors: string[] = [];

				if (evidence_event_ids?.length) {
					const eventCheck = await executeQuery(
						`SELECT event_id FROM events WHERE event_id = ANY($1::integer[])`,
						[evidence_event_ids],
					);
					const foundIds = new Set((eventCheck.rows as Array<{ event_id: number }>).map((r) => r.event_id));
					const missing = evidence_event_ids.filter((id) => !foundIds.has(id));
					if (missing.length > 0) {
						validationErrors.push(`Event IDs not found: ${missing.join(', ')}`);
					}
				}

				if (evidence_rules?.length && loader) {
					const knownRules = new Set(loader.businessRules.map((r) => r.name));
					const missing = evidence_rules.filter((r) => !knownRules.has(r));
					if (missing.length > 0) {
						validationErrors.push(`Business rules not found: ${missing.join(', ')}`);
					}
				}

				if (evidence_signal_types?.length) {
					const validSignals = new Set([
						'event_distribution',
						'failure_rates',
						'step_durations',
						'delay_patterns',
					]);
					const missing = evidence_signal_types.filter((s) => !validSignals.has(s));
					if (missing.length > 0) {
						validationErrors.push(`Signal types not recognized: ${missing.join(', ')}`);
					}
				}

				if (validationErrors.length > 0) {
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({
									error: `Evidence validation failed: ${validationErrors.join('; ')}`,
								}),
							},
						],
					};
				}

				const result = await executeQuery(
					`INSERT INTO decision_proposals (session_id, agent_id, proposed_action, confidence, risk_class,
					   evidence_event_ids, evidence_signal_types, evidence_rules, auth_method, token_hash, correlation_id)
					 VALUES ($1, $2, $3, $4, $5, $6::integer[], $7::text[], $8::text[], $9, $10, $11)
					 RETURNING proposal_id, status, created_at`,
					[
						session_id,
						agent_id,
						proposed_action,
						confidence,
						risk_class,
						evidence_event_ids ?? null,
						evidence_signal_types ?? null,
						evidence_rules ?? null,
						ctx.authMethod,
						ctx.tokenHash,
						ctx.sessionId,
					],
				);
				const row = result.rows[0] as { proposal_id: number; status: string; created_at: string };

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								proposal_id: row.proposal_id,
								session_id,
								agent_id,
								risk_class,
								status: row.status,
								requires_approval: risk_class !== 'low',
								timestamp: row.created_at,
							}),
						},
					],
				};
			} catch (err) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
				};
			}
		},
	);

	/**
	 * approve_decision — Approve or reject a proposal.
	 *
	 * Low risk: auto-approved by harness.
	 * Medium: human review optional.
	 * High/critical: human approval required.
	 */
	server.tool(
		'approve_decision',
		'Approve or reject a decision proposal (auto for low risk, human for high)',
		{
			proposal_id: z.number().describe('Proposal to approve/reject'),
			approved: z.boolean().describe('true = approve, false = reject'),
			approved_by: z.string().describe('Who approved: "auto" or "human:operator_name"'),
			reason: z.string().optional().describe('Reason for approval/rejection'),
		},
		async ({ proposal_id, approved, approved_by, reason }) => {
			try {
				// Permission check: verify the approver has rights for this risk class
				const proposalCheck = await executeQuery(
					'SELECT risk_class FROM decision_proposals WHERE proposal_id = $1',
					[proposal_id],
				);
				if (proposalCheck.rowCount === 0) {
					return {
						content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Proposal not found' }) }],
					};
				}
				const riskClass = (proposalCheck.rows[0] as { risk_class: string }).risk_class;

				// Check approver permissions if it's an agent (not "auto" or "human:*")
				if (loader && !approved_by.startsWith('human:') && approved_by !== 'auto') {
					const permissions = loader.agents.permissions ?? {};
					const approverPerms = permissions[approved_by];
					if (approverPerms && !approverPerms.can_approve.includes(riskClass)) {
						return {
							content: [
								{
									type: 'text' as const,
									text: JSON.stringify({
										error: `Agent ${approved_by} cannot approve ${riskClass}-risk proposals. Allowed: ${approverPerms.can_approve.join(', ')}`,
									}),
								},
							],
						};
					}
				}

				// Insert approval record
				await executeQuery(
					`INSERT INTO decision_approvals (proposal_id, approved_by, approved, reason)
					 VALUES ($1, $2, $3, $4)`,
					[proposal_id, approved_by, approved, reason ?? null],
				);

				// Update proposal status
				const newStatus = approved ? 'approved' : 'rejected';
				await executeQuery(`UPDATE decision_proposals SET status = $1 WHERE proposal_id = $2`, [
					newStatus,
					proposal_id,
				]);

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								proposal_id,
								approved,
								approved_by,
								new_status: newStatus,
								timestamp: new Date().toISOString(),
							}),
						},
					],
				};
			} catch (err) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
				};
			}
		},
	);

	/**
	 * execute_decision_action — Execute the approved action.
	 *
	 * Only works on approved proposals. Records the action type,
	 * parameters, and result.
	 */
	server.tool(
		'execute_decision_action',
		'Execute an approved decision action (notification, rebooking, etc.)',
		{
			proposal_id: z.number().describe('Approved proposal to execute'),
			executor_id: z.string().describe('Agent or operator executing the action'),
			action_type: z
				.string()
				.describe('Action type: notify_customer, rebook_passenger, issue_compensation, escalate'),
			parameters: z.record(z.string(), z.string()).describe('Action parameters'),
		},
		async ({ proposal_id, executor_id, action_type, parameters }) => {
			try {
				// Verify proposal is approved
				const check = await executeQuery(
					`SELECT status, risk_class FROM decision_proposals WHERE proposal_id = $1`,
					[proposal_id],
				);
				if (check.rowCount === 0) {
					return {
						content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Proposal not found' }) }],
					};
				}
				const proposal = check.rows[0] as { status: string; risk_class: string };
				if (proposal.status !== 'approved') {
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({
									error: `Cannot execute: proposal status is '${proposal.status}', must be 'approved'`,
								}),
							},
						],
					};
				}

				// Permission check: can this executor execute at this risk level?
				if (loader && !executor_id.startsWith('human:')) {
					const permissions = loader.agents.permissions ?? {};
					const execPerms = permissions[executor_id];
					if (execPerms && !execPerms.can_execute.includes(proposal.risk_class)) {
						return {
							content: [
								{
									type: 'text' as const,
									text: JSON.stringify({
										error: `Agent ${executor_id} cannot execute ${proposal.risk_class}-risk actions. Allowed: ${execPerms.can_execute.join(', ')}`,
									}),
								},
							],
						};
					}
				}

				// Insert action record
				const result = await executeQuery(
					`INSERT INTO decision_actions (proposal_id, action_type, parameters, status)
					 VALUES ($1, $2, $3::jsonb, 'completed')
					 RETURNING action_id, created_at`,
					[proposal_id, action_type, JSON.stringify(parameters)],
				);
				const row = result.rows[0] as { action_id: number; created_at: string };

				// Update proposal status
				await executeQuery(`UPDATE decision_proposals SET status = 'executed' WHERE proposal_id = $1`, [
					proposal_id,
				]);

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								action_id: row.action_id,
								proposal_id,
								action_type,
								status: 'completed',
								timestamp: row.created_at,
							}),
						},
					],
				};
			} catch (err) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
				};
			}
		},
	);

	/**
	 * record_outcome — Record the final outcome with evidence links.
	 *
	 * Links the outcome back to events, rules, signals, and proposals.
	 * This becomes searchable precedent for future decisions.
	 */
	server.tool(
		'record_outcome',
		'Record the final decision outcome with evidence links (becomes searchable precedent)',
		{
			session_id: z.string().describe('Session this outcome belongs to'),
			question: z.string().describe('The original question'),
			decision_summary: z.string().describe('Final decision/answer'),
			reasoning: z.string().describe('How the decision was reached'),
			confidence: z.enum(['high', 'medium', 'low']).describe('Confidence'),
			agents_involved: z.array(z.string()).describe('Agent IDs that contributed'),
			cost_usd: z.number().optional().describe('Total LLM cost'),
			evidence_event_ids: z.array(z.number()).optional().describe('Event IDs used as evidence'),
			evidence_rules: z.array(z.string()).optional().describe('Business rules that applied'),
			evidence_signal_types: z.array(z.string()).optional().describe('Process signals used'),
			evidence_proposal_ids: z.array(z.number()).optional().describe('Proposal IDs in this decision'),
		},
		async ({
			session_id,
			question,
			decision_summary,
			reasoning,
			confidence,
			agents_involved,
			cost_usd,
			evidence_event_ids,
			evidence_rules,
			evidence_signal_types,
			evidence_proposal_ids,
		}) => {
			const ctx = getAuthContext();
			try {
				// Validate evidence links
				const validationErrors: string[] = [];

				if (evidence_event_ids?.length) {
					const check = await executeQuery(
						`SELECT event_id FROM events WHERE event_id = ANY($1::integer[])`,
						[evidence_event_ids],
					);
					const found = new Set((check.rows as Array<{ event_id: number }>).map((r) => r.event_id));
					const missing = evidence_event_ids.filter((id) => !found.has(id));
					if (missing.length > 0) validationErrors.push(`Event IDs not found: ${missing.join(', ')}`);
				}

				if (evidence_proposal_ids?.length) {
					const check = await executeQuery(
						`SELECT proposal_id FROM decision_proposals WHERE proposal_id = ANY($1::integer[])`,
						[evidence_proposal_ids],
					);
					const found = new Set((check.rows as Array<{ proposal_id: number }>).map((r) => r.proposal_id));
					const missing = evidence_proposal_ids.filter((id) => !found.has(id));
					if (missing.length > 0) validationErrors.push(`Proposal IDs not found: ${missing.join(', ')}`);
				}

				if (evidence_rules?.length && loader) {
					const knownRules = new Set(loader.businessRules.map((r) => r.name));
					const missing = evidence_rules.filter((r) => !knownRules.has(r));
					if (missing.length > 0) validationErrors.push(`Rules not found: ${missing.join(', ')}`);
				}

				if (validationErrors.length > 0) {
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({
									error: `Evidence validation failed: ${validationErrors.join('; ')}`,
								}),
							},
						],
					};
				}

				const safeSummary = filterPiiFromFinding(decision_summary);
				const safeReasoning = filterPiiFromFinding(reasoning);
				const result = await executeQuery(
					`INSERT INTO decision_outcomes (session_id, question, decision_summary, reasoning, confidence,
					   agents_involved, cost_usd, evidence_event_ids, evidence_rules, evidence_signal_types, evidence_proposal_ids,
					   auth_method, token_hash, correlation_id)
					 VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8::integer[], $9::text[], $10::text[], $11::integer[], $12, $13, $14)
					 RETURNING outcome_id, created_at`,
					[
						session_id,
						question,
						safeSummary,
						safeReasoning,
						confidence,
						agents_involved,
						cost_usd ?? 0,
						evidence_event_ids ?? null,
						evidence_rules ?? null,
						evidence_signal_types ?? null,
						evidence_proposal_ids ?? null,
						ctx.authMethod,
						ctx.tokenHash,
						ctx.sessionId,
					],
				);
				const row = result.rows[0] as { outcome_id: number; created_at: string };

				// Update all proposals in this session to completed
				if (evidence_proposal_ids?.length) {
					await executeQuery(
						`UPDATE decision_proposals SET status = 'completed' WHERE proposal_id = ANY($1::integer[])`,
						[evidence_proposal_ids],
					);
				}

				// Auto-capture episodic memory from outcome
				try {
					// Determine scope: use first agent's bundle, or 'global' if orchestrator
					const firstAgent = agents_involved[0];
					const agentBundle = loader?.agents?.agents?.[firstAgent]?.bundle;
					const scopeType = agentBundle ? 'bundle' : 'global';
					const scopeId = agentBundle ?? 'global';

					await executeQuery(
						`INSERT INTO memory_entries (memory_type, scope_type, scope_id, status, title, summary, content,
						   confidence, source_outcome_id, evidence_event_ids, evidence_rules, evidence_signal_types)
						 VALUES ('episodic', $1, $2, 'candidate', $3, $4, $5::jsonb, $6,
						         $7, $8::integer[], $9::text[], $10::text[])`,
						[
							scopeType,
							scopeId,
							question.substring(0, 200),
							safeSummary,
							JSON.stringify({
								question,
								decision: safeSummary,
								reasoning: safeReasoning,
								agents: agents_involved,
								session_id,
							}),
							confidence === 'high' ? 0.9 : confidence === 'medium' ? 0.6 : 0.3,
							row.outcome_id,
							evidence_event_ids ?? null,
							evidence_rules ?? null,
							evidence_signal_types ?? null,
						],
					);
				} catch {
					// Non-critical: don't fail the outcome if memory capture fails
				}

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								outcome_id: row.outcome_id,
								session_id,
								stored: true,
								memory_captured: true,
								timestamp: row.created_at,
							}),
						},
					],
				};
			} catch (err) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
				};
			}
		},
	);

	// ─── Memory (cross-session) ───

	server.tool(
		'save_memory',
		'Save agent memory that persists across sessions',
		{
			key: z.string().describe('Memory key (topic or category)'),
			content: z.string().describe('Memory content to persist'),
		},
		async ({ key, content }) => {
			const agent_id = getAuthContext().agentId;
			try {
				const safeContent = filterPiiFromFinding(content);
				await executeQuery(
					`INSERT INTO agent_memory (agent_id, key, content)
					 VALUES ($1, $2, $3)
					 ON CONFLICT (agent_id, key) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
					[agent_id, key, safeContent],
				);
				// Also write to memory_entries as semantic candidate
				try {
					await executeQuery(
						`INSERT INTO memory_entries (memory_type, scope_type, scope_id, status, title, summary, content, confidence)
						 VALUES ('semantic', 'agent', $1, 'candidate', $2, $3, $4::jsonb, 0.5)`,
						[agent_id, key, safeContent, JSON.stringify({ key, content: safeContent, agent_id })],
					);
				} catch {
					// Non-critical
				}
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ agent_id, key, saved: true, timestamp: new Date().toISOString() }),
						},
					],
				};
			} catch (err) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
				};
			}
		},
	);

	server.tool(
		'recall_memory',
		'Retrieve memories — legacy KV + structured memory_entries with scope filtering',
		{
			key: z.string().optional().describe('Specific key for legacy memory, or keyword for structured search'),
			scope: z
				.enum(['agent', 'bundle', 'global', 'all'])
				.optional()
				.default('all')
				.describe('Scope filter for structured memories'),
		},
		async ({ key, scope }) => {
			const agent_id = getAuthContext().agentId;
			try {
				// Legacy KV memory
				let legacySql: string;
				let legacyParams: unknown[];
				if (key) {
					legacySql = `SELECT key, content, updated_at FROM agent_memory
					             WHERE agent_id = $1 AND key = $2 ORDER BY updated_at DESC`;
					legacyParams = [agent_id, key];
				} else {
					legacySql = `SELECT key, content, updated_at FROM agent_memory
					             WHERE agent_id = $1 ORDER BY updated_at DESC`;
					legacyParams = [agent_id];
				}
				const legacyResult = await executeQuery(legacySql, legacyParams);

				// Structured memory_entries — scope-aware
				const scopeConditions: string[] = [];
				const structuredParams: unknown[] = [];
				let paramIdx = 0;

				if (scope === 'agent' || scope === 'all') {
					paramIdx++;
					structuredParams.push(agent_id);
					scopeConditions.push(`(scope_type = 'agent' AND scope_id = $${paramIdx})`);
				}
				if (scope === 'bundle' || scope === 'all') {
					// Get agent's bundle from config
					const agentBundle = loader?.agents?.agents?.[agent_id]?.bundle;
					if (agentBundle) {
						paramIdx++;
						structuredParams.push(agentBundle);
						scopeConditions.push(`(scope_type = 'bundle' AND scope_id = $${paramIdx})`);
					}
				}
				if (scope === 'global' || scope === 'all') {
					scopeConditions.push(`scope_type = 'global'`);
				}

				const scopeWhere = scopeConditions.length > 0 ? `AND (${scopeConditions.join(' OR ')})` : '';

				// Search by keyword if key provided
				let keyFilter = '';
				if (key) {
					paramIdx++;
					structuredParams.push(`%${key}%`);
					keyFilter = `AND (LOWER(title) LIKE LOWER($${paramIdx}) OR LOWER(summary) LIKE LOWER($${paramIdx}))`;
				}

				const structuredResult = await executeQuery(
					`SELECT memory_id, memory_type, scope_type, scope_id, status, title, summary,
					        confidence, created_at, valid_from, valid_to, source_outcome_id,
					        evidence_rules, evidence_signal_types
					 FROM memory_entries
					 WHERE status IN ('candidate', 'active') ${scopeWhere} ${keyFilter}
					 ORDER BY confidence DESC, created_at DESC
					 LIMIT 20`,
					structuredParams,
				);

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								agent_id,
								legacy_memories: legacyResult.rows,
								structured_memories: structuredResult.rows,
								total: (legacyResult.rowCount ?? 0) + (structuredResult.rowCount ?? 0),
							}),
						},
					],
				};
			} catch (err) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
				};
			}
		},
	);
}

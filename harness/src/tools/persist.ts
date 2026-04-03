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

export function registerPersistTools(server: McpServer) {
	// ─── Findings (shared workspace, unchanged) ───

	server.tool(
		'write_finding',
		'Store an intermediate finding for the current session (shared workspace)',
		{
			session_id: z.string().describe('Current decision session ID'),
			agent_id: z.string().describe('Agent writing the finding'),
			finding: z.string().describe('The finding content (PII must not be included)'),
			confidence: z.enum(['high', 'medium', 'low']).describe('Confidence in this finding'),
			data_sources: z.array(z.string()).optional().describe('Tables/measures used'),
		},
		async ({ session_id, agent_id, finding, confidence, data_sources }) => {
			try {
				const sources = data_sources ? `ARRAY[${data_sources.map((s) => `'${s}'`).join(',')}]` : 'NULL';
				const result = await executeQuery(
					`INSERT INTO decision_findings (session_id, agent_id, finding, confidence, data_sources)
					 VALUES ('${session_id}', '${agent_id}', '${finding.replace(/'/g, "''")}', '${confidence}', ${sources})
					 RETURNING finding_id, created_at`,
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
				const filter = agent_filter ? `AND agent_id = '${agent_filter}'` : '';
				const result = await executeQuery(
					`SELECT finding_id, agent_id, finding, confidence, data_sources, created_at
					 FROM decision_findings WHERE session_id = '${session_id}' ${filter}
					 ORDER BY created_at ASC`,
				);
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
			agent_id: z.string().describe('Agent proposing the decision'),
			proposed_action: z.string().describe('What action is proposed'),
			confidence: z.enum(['high', 'medium', 'low']).describe('Confidence in the proposal'),
			risk_class: z.enum(['low', 'medium', 'high', 'critical']).describe('Risk classification'),
			evidence_event_ids: z.array(z.number()).optional().describe('Event IDs that triggered this proposal'),
			evidence_signal_types: z.array(z.string()).optional().describe('Process signal types that informed this'),
			evidence_rules: z.array(z.string()).optional().describe('Business rules that apply'),
		},
		async ({
			session_id,
			agent_id,
			proposed_action,
			confidence,
			risk_class,
			evidence_event_ids,
			evidence_signal_types,
			evidence_rules,
		}) => {
			try {
				const eventIds = evidence_event_ids?.length ? `ARRAY[${evidence_event_ids.join(',')}]` : 'NULL';
				const signalTypes = evidence_signal_types?.length
					? `ARRAY[${evidence_signal_types.map((s) => `'${s}'`).join(',')}]`
					: 'NULL';
				const rules = evidence_rules?.length
					? `ARRAY[${evidence_rules.map((r) => `'${r}'`).join(',')}]`
					: 'NULL';

				const result = await executeQuery(
					`INSERT INTO decision_proposals (session_id, agent_id, proposed_action, confidence, risk_class,
					   evidence_event_ids, evidence_signal_types, evidence_rules)
					 VALUES ('${session_id}', '${agent_id}', '${proposed_action.replace(/'/g, "''")}',
					   '${confidence}', '${risk_class}', ${eventIds}, ${signalTypes}, ${rules})
					 RETURNING proposal_id, status, created_at`,
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
				// Insert approval record
				const reasonSql = reason ? `'${reason.replace(/'/g, "''")}'` : 'NULL';
				await executeQuery(
					`INSERT INTO decision_approvals (proposal_id, approved_by, approved, reason)
					 VALUES (${proposal_id}, '${approved_by}', ${approved}, ${reasonSql})`,
				);

				// Update proposal status
				const newStatus = approved ? 'approved' : 'rejected';
				await executeQuery(
					`UPDATE decision_proposals SET status = '${newStatus}' WHERE proposal_id = ${proposal_id}`,
				);

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
			action_type: z
				.string()
				.describe('Action type: notify_customer, rebook_passenger, issue_compensation, escalate'),
			parameters: z.record(z.string()).describe('Action parameters'),
		},
		async ({ proposal_id, action_type, parameters }) => {
			try {
				// Verify proposal is approved
				const check = await executeQuery(
					`SELECT status, risk_class FROM decision_proposals WHERE proposal_id = ${proposal_id}`,
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

				// Insert action record
				const paramsJson = JSON.stringify(parameters).replace(/'/g, "''");
				const result = await executeQuery(
					`INSERT INTO decision_actions (proposal_id, action_type, parameters, status)
					 VALUES (${proposal_id}, '${action_type}', '${paramsJson}'::jsonb, 'completed')
					 RETURNING action_id, created_at`,
				);
				const row = result.rows[0] as { action_id: number; created_at: string };

				// Update proposal status
				await executeQuery(
					`UPDATE decision_proposals SET status = 'executed' WHERE proposal_id = ${proposal_id}`,
				);

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
			try {
				const agents = `ARRAY[${agents_involved.map((a) => `'${a}'`).join(',')}]`;
				const eventIds = evidence_event_ids?.length ? `ARRAY[${evidence_event_ids.join(',')}]` : 'NULL';
				const rules = evidence_rules?.length
					? `ARRAY[${evidence_rules.map((r) => `'${r}'`).join(',')}]`
					: 'NULL';
				const signals = evidence_signal_types?.length
					? `ARRAY[${evidence_signal_types.map((s) => `'${s}'`).join(',')}]`
					: 'NULL';
				const proposals = evidence_proposal_ids?.length ? `ARRAY[${evidence_proposal_ids.join(',')}]` : 'NULL';

				const result = await executeQuery(
					`INSERT INTO decision_outcomes (session_id, question, decision_summary, reasoning, confidence,
					   agents_involved, cost_usd, evidence_event_ids, evidence_rules, evidence_signal_types, evidence_proposal_ids)
					 VALUES ('${session_id}', '${question.replace(/'/g, "''")}', '${decision_summary.replace(/'/g, "''")}',
					   '${reasoning.replace(/'/g, "''")}', '${confidence}', ${agents}, ${cost_usd ?? 0},
					   ${eventIds}, ${rules}, ${signals}, ${proposals})
					 RETURNING outcome_id, created_at`,
				);
				const row = result.rows[0] as { outcome_id: number; created_at: string };

				// Update all proposals in this session to completed
				if (evidence_proposal_ids?.length) {
					await executeQuery(
						`UPDATE decision_proposals SET status = 'completed' WHERE proposal_id = ANY(ARRAY[${evidence_proposal_ids.join(',')}])`,
					);
				}

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								outcome_id: row.outcome_id,
								session_id,
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

	// ─── Memory (cross-session, unchanged) ───

	server.tool(
		'save_memory',
		'Save agent memory that persists across sessions',
		{
			agent_id: z.string().describe('Agent saving the memory'),
			key: z.string().describe('Memory key (topic or category)'),
			content: z.string().describe('Memory content to persist'),
		},
		async ({ agent_id, key, content }) => {
			try {
				await executeQuery(
					`INSERT INTO agent_memory (agent_id, key, content)
					 VALUES ('${agent_id}', '${key.replace(/'/g, "''")}', '${content.replace(/'/g, "''")}')
					 ON CONFLICT (agent_id, key) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
				);
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
		'Retrieve agent memory from previous sessions',
		{
			agent_id: z.string().describe('Agent recalling memory'),
			key: z.string().optional().describe('Specific memory key, or omit for all'),
		},
		async ({ agent_id, key }) => {
			try {
				const filter = key ? `AND key = '${key.replace(/'/g, "''")}'` : '';
				const result = await executeQuery(
					`SELECT key, content, updated_at FROM agent_memory
					 WHERE agent_id = '${agent_id}' ${filter} ORDER BY updated_at DESC`,
				);
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ agent_id, memories: result.rows, total: result.rowCount }),
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

/**
 * LAYER 5: ACTION/PERMISSION tools
 *
 * Governed execution with risk classification, permission checks,
 * and approval gates. Integrates with Layer 4 decision lifecycle.
 *
 * Every action goes through:
 * 1. Risk classification (from policy.yml)
 * 2. Permission check (can this agent propose/execute at this risk level?)
 * 3. Approval gate (auto for low, human for high/critical)
 * 4. Execution (only after approval)
 * 5. Autonomy tracking (progressive trust building)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { evaluateGovernance, filterPiiFromResults } from '../governance/index.js';
import { executeQuery } from '../database/index.js';
import { ScenarioLoader } from '../config/index.js';

let loader: ScenarioLoader | null = null;

export function initActionTools(scenarioPath: string) {
	loader = new ScenarioLoader(scenarioPath);
}

export function registerActionTools(server: McpServer) {
	// ─── query_data (unchanged — governance enforced internally) ───

	server.tool(
		'query_data',
		'Execute a SQL query — governance is enforced automatically by the harness',
		{
			agent_id: z.string().describe('Agent executing the query'),
			sql: z.string().describe('SQL query to execute'),
			reason: z.string().optional().describe('Why this query is needed (for audit trail)'),
		},
		async ({ agent_id, sql, reason }) => {
			const governance = await evaluateGovernance({ agent_id, sql });

			if (!governance.allowed) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{
									status: 'blocked',
									reason: governance.reason,
									blocked_columns: governance.blocked_columns,
									suggestion: 'Adjust your query to comply with policy, then retry.',
								},
								null,
								2,
							),
						},
					],
				};
			}

			try {
				const result = await executeQuery(sql, undefined, 30000);
				// Defense in depth: always filter ALL known PII columns from results
				const filtered = filterPiiFromResults(
					result.rows,
					governance.all_pii_columns ?? governance.blocked_columns ?? [],
				);
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{
									status: 'success',
									rows: filtered,
									row_count: result.rowCount,
									execution_time_ms: result.durationMs,
									contract_id: governance.contract_id,
									applicable_rules: governance.applicable_rules,
									warnings: governance.warnings,
								},
								null,
								2,
							),
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{
									status: 'error',
									reason: `Query execution failed: ${(err as Error).message}`,
									contract_id: governance.contract_id,
								},
								null,
								2,
							),
						},
					],
				};
			}
		},
	);

	// ─── query_metrics (unchanged — scaffold) ───

	server.tool(
		'query_metrics',
		'Query semantic measures and dimensions — governance enforced automatically',
		{
			agent_id: z.string().describe('Agent executing the query'),
			measures: z.array(z.string()).describe("Measure names (e.g. ['bookings.total_revenue'])"),
			dimensions: z.array(z.string()).optional().describe('Dimensions to group by'),
			filters: z.array(z.object({ dimension: z.string(), operator: z.string(), value: z.string() })).optional(),
		},
		async ({ agent_id, measures, dimensions, filters }) => {
			const governance = await evaluateGovernance({ agent_id, metric_refs: measures });
			if (!governance.allowed) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ status: 'blocked', reason: governance.reason }),
						},
					],
				};
			}
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								_scaffold: true,
								status: 'success',
								measures,
								dimensions,
								filters,
								result: [{ placeholder: 'metric results' }],
								generated_sql: 'placeholder: SQL from semantic engine',
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	// ─── execute_action (Layer 5: full risk/permission/approval) ───

	/**
	 * execute_action — Trigger an action with risk classification and approval.
	 *
	 * Flow:
	 * 1. Classify risk from policy.yml (action_type → risk_class)
	 * 2. Check agent permissions (can this agent propose at this risk level?)
	 * 3. If low risk + auto-approved → execute immediately
	 * 4. If high/critical → create proposal, require human approval
	 * 5. Track for progressive autonomy
	 */
	server.tool(
		'execute_action',
		'Trigger an action — risk classified, permissions checked, approval enforced automatically',
		{
			agent_id: z.string().describe('Agent requesting the action'),
			action_type: z
				.string()
				.describe('Action type (notify_customer, rebook_passenger, issue_compensation, etc.)'),
			parameters: z.record(z.string(), z.string()).describe('Action-specific parameters'),
			reason: z.string().describe('Why this action is needed'),
			session_id: z.string().optional().describe('Session ID for decision tracking'),
			evidence_event_ids: z.array(z.number()).optional().describe('Evidence: event IDs'),
			evidence_rules: z.array(z.string()).optional().describe('Evidence: business rules'),
		},
		async ({ agent_id, action_type, parameters, reason, session_id, evidence_event_ids, evidence_rules }) => {
			if (!loader) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Harness not initialized' }) }],
				};
			}

			try {
				const policy = loader.policy;
				const agentsConfig = loader.agents;

				// ── Step 1: Risk classification ──
				const riskMap = policy.actions?.risk_classification ?? {};
				const riskClass = riskMap[action_type] ?? 'high'; // unknown actions default to high
				const approvalMap = policy.actions?.approval_requirements ?? {};
				const approvalRequirement = approvalMap[riskClass] ?? 'human_required';

				// ── Step 2: Permission check ──
				const permissions = agentsConfig.permissions ?? {};
				const agentPerms = permissions[agent_id];
				if (agentPerms && !agentPerms.can_propose.includes(riskClass)) {
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({
									status: 'denied',
									reason: `Agent ${agent_id} cannot propose ${riskClass}-risk actions. Allowed: ${agentPerms.can_propose.join(', ')}`,
									risk_class: riskClass,
								}),
							},
						],
					};
				}

				// ── Step 3: Check progressive autonomy ──
				let autoApproved = false;
				if (approvalRequirement === 'auto') {
					autoApproved = true;
				} else {
					// Check if progressive autonomy has promoted this risk class
					const autonomyResult = await executeQuery(
						`SELECT auto_approved FROM autonomy_stats WHERE risk_class = $1`,
						[riskClass],
					);
					if (autonomyResult.rowCount > 0) {
						autoApproved = (autonomyResult.rows[0] as { auto_approved: boolean }).auto_approved;
					}
				}

				// ── Step 4: Create proposal in Layer 4 ──
				const eventIdsParam = evidence_event_ids?.length ? evidence_event_ids : null;
				const rulesParam = evidence_rules?.length ? evidence_rules : null;
				const sid = session_id ?? `action-${Date.now()}`;

				const proposalResult = await executeQuery(
					`INSERT INTO decision_proposals (session_id, agent_id, proposed_action, confidence, risk_class,
					   evidence_event_ids, evidence_rules, status)
					 VALUES ($1, $2, $3,
					   'high', $4, $5, $6,
					   $7)
					 RETURNING proposal_id`,
					[
						sid,
						agent_id,
						reason,
						riskClass,
						eventIdsParam,
						rulesParam,
						autoApproved ? 'approved' : 'pending',
					],
				);
				const proposalId = (proposalResult.rows[0] as { proposal_id: number }).proposal_id;

				if (autoApproved) {
					// Auto-approve and execute
					await executeQuery(
						`INSERT INTO decision_approvals (proposal_id, approved_by, approved, reason)
						 VALUES ($1, 'auto', true, $2)`,
						[proposalId, `Auto-approved: ${riskClass} risk`],
					);

					await executeQuery(
						`INSERT INTO decision_actions (proposal_id, action_type, parameters, status)
						 VALUES ($1, $2, $3::jsonb, 'completed')`,
						[proposalId, action_type, JSON.stringify(parameters)],
					);

					await executeQuery(`UPDATE decision_proposals SET status = 'executed' WHERE proposal_id = $1`, [
						proposalId,
					]);

					// Track for progressive autonomy
					await executeQuery(
						`UPDATE autonomy_stats SET total_decisions = total_decisions + 1,
						   successful_decisions = successful_decisions + 1, updated_at = NOW()
						 WHERE risk_class = $1`,
						[riskClass],
					);

					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({
									status: 'executed',
									proposal_id: proposalId,
									action_type,
									risk_class: riskClass,
									approval: 'auto',
									message: `Action executed (${riskClass} risk, auto-approved)`,
								}),
							},
						],
					};
				} else {
					// Requires human approval
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({
									status: 'pending_approval',
									proposal_id: proposalId,
									action_type,
									risk_class: riskClass,
									approval_required: approvalRequirement,
									message: `Action queued for ${approvalRequirement} (${riskClass} risk). Proposal ID: ${proposalId}`,
								}),
							},
						],
					};
				}
			} catch (err) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
				};
			}
		},
	);

	// ─── get_permissions (Task 5) ───

	/**
	 * get_permissions — What is this agent allowed to do?
	 *
	 * Returns which risk levels the agent can propose, approve, and execute.
	 * Also returns the current risk classification for each action type.
	 */
	server.tool(
		'get_permissions',
		'Check what actions an agent is permitted to propose, approve, and execute',
		{
			agent_id: z.string().describe('Agent to check permissions for'),
		},
		async ({ agent_id }) => {
			if (!loader) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Harness not initialized' }) }],
				};
			}

			const agentsConfig = loader.agents;
			const policy = loader.policy;
			const permissions = agentsConfig.permissions ?? {};
			const agentPerms = permissions[agent_id] ?? { can_propose: [], can_approve: [], can_execute: [] };

			// Get current autonomy stats
			let autonomyStats: Array<{ risk_class: string; total_decisions: number; auto_approved: boolean }> = [];
			try {
				const result = await executeQuery(
					'SELECT risk_class, total_decisions, auto_approved FROM autonomy_stats',
				);
				autonomyStats = result.rows as typeof autonomyStats;
			} catch {
				// Table might not exist yet
			}

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								agent_id,
								permissions: {
									can_propose: agentPerms.can_propose,
									can_approve: agentPerms.can_approve,
									can_execute: agentPerms.can_execute,
								},
								risk_classification: policy.actions?.risk_classification ?? {},
								approval_requirements: policy.actions?.approval_requirements ?? {},
								progressive_autonomy: autonomyStats,
							},
							null,
							2,
						),
					},
				],
			};
		},
	);
}

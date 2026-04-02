/**
 * CONTROL tools — "Boundaries on what agents can do"
 *
 * These are the tools agents CALL THEMSELVES to understand their boundaries.
 * The agent asks: "Who am I? What can I access? What rules must I follow?"
 *
 * Policy enforcement (PII blocking, SQL validation, bundle checks) happens
 * INTERNALLY inside the harness when agents call action tools like query_data.
 * Agents don't check their own policy — the harness does it for them.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ScenarioLoader } from '../config/index.js';
import { authenticateAgent } from '../governance/index.js';

let loader: ScenarioLoader | null = null;

export function initControlTools(scenarioPath: string) {
	loader = new ScenarioLoader(scenarioPath);
}

export function registerControlTools(server: McpServer) {
	/**
	 * initialize_agent — Complete operating environment for an agent.
	 *
	 * Called once when an agent starts working on a task. Returns everything
	 * the agent needs: identity, system prompt, scope, available tools,
	 * applicable rules, and constraints.
	 */
	server.tool(
		'initialize_agent',
		'Get the complete operating environment — identity, prompt, scope, context, memory, constraints',
		{
			agent_id: z.string().describe('Agent identifier (from agents.yml)'),
			session_id: z.string().describe('Current decision session ID'),
			question: z.string().optional().describe('The question this agent is working on'),
		},
		async ({ agent_id, session_id, question }) => {
			if (!loader) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Harness not initialized' }) }],
				};
			}

			// ── Identity ──
			const identity = authenticateAgent(agent_id);
			if (!identity.authenticated) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ error: `Unknown agent: ${agent_id}` }),
						},
					],
				};
			}

			const agentsConfig = loader.agents;
			const agentConfig = agentsConfig.agents[agent_id];

			// ── Scope: bundle, tables, PII, joins ──
			let tables: string[] = [];
			let allowedJoins: string[] = [];
			let timeFilterRequirements: Array<{ table: string; column: string; max_days: number }> = [];

			if (agentConfig.bundle) {
				try {
					const bundle = loader.getBundle(agentConfig.bundle);
					tables = bundle.tables.map((t) => `${t.schema}.${t.table}`);
					allowedJoins = (bundle.joins ?? []).map(
						(j) => `${j.left.table}.${j.left.column} = ${j.right.table}.${j.right.column}`,
					);
					timeFilterRequirements = (bundle.time_filters ?? []).map((tf) => ({
						table: tf.table,
						column: tf.column,
						max_days: tf.max_days,
					}));
				} catch {
					// Bundle not found — empty scope
				}
			}

			// PII columns the agent cannot query
			const piiColumns = [...loader.getPiiColumns()];

			// ── Semantic measures and dimensions available to this agent ──
			const semanticModel = loader.semanticModel;
			const bundleTables = new Set(tables.map((t) => t.split('.').pop()!));
			const availableMeasures: string[] = [];
			const availableDimensions: string[] = [];

			for (const model of semanticModel.models) {
				if (bundleTables.has(model.table.table)) {
					for (const m of model.measures) {
						availableMeasures.push(`${model.name}.${m.name}`);
					}
					for (const d of model.dimensions) {
						availableDimensions.push(`${model.name}.${d.name}`);
					}
				}
			}

			// ── Business rules applicable to this agent's scope ──
			const allRules = loader.businessRules;
			const applicableRules = matchRulesToScope(allRules, tables, availableMeasures);

			// ── Tools available based on role ──
			const toolsAvailable = agentConfig.can_query
				? ['query_data', 'query_metrics', 'get_business_rules', 'write_finding', 'read_findings']
				: ['get_context', 'read_findings', 'log_decision', 'get_business_rules'];

			if (agentConfig.role === 'orchestrator') {
				toolsAvailable.push('get_confidence', 'verify_result');
			}

			// ── Constraints ──
			const policy = loader.policy;
			const interAgent = agentsConfig.inter_agent;

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								identity: {
									agent_id,
									role: agentConfig.role,
									display_name: agentConfig.display_name,
									authenticated: true,
								},
								system_prompt: agentConfig.system_prompt ?? '',
								scope: {
									bundle: agentConfig.bundle ?? null,
									tables,
									blocked_columns: piiColumns,
									measures: availableMeasures,
									dimensions: availableDimensions,
									allowed_joins: allowedJoins,
									time_filter_requirements: timeFilterRequirements,
								},
								tools_available: toolsAvailable,
								rules: applicableRules.map((r) => ({
									name: r.name,
									severity: r.severity,
									description: r.description,
									guidance: r.guidance,
								})),
								constraints: {
									max_llm_calls: interAgent.max_llm_calls_per_agent,
									cost_limit_usd: interAgent.cost_limit_per_decision,
									query_timeout_seconds: policy.agent_limits.max_query_execution_time_seconds,
									max_rows: policy.defaults.max_rows,
									can_delegate_to: agentConfig.can_delegate_to ?? [],
								},
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	/**
	 * get_business_rules — What rules must this agent follow?
	 *
	 * Given tables or metrics, returns all applicable business rules
	 * with severity, guidance, and rationale.
	 */
	server.tool(
		'get_business_rules',
		'Find all business rules applicable to given tables, metrics, or query context',
		{
			tables: z.array(z.string()).optional().describe('Tables being queried'),
			metric_refs: z.array(z.string()).optional().describe('Metrics being used'),
			sql: z.string().optional().describe('SQL for text-based rule matching'),
		},
		async ({ tables, metric_refs, sql }) => {
			if (!loader) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Harness not initialized' }) }],
				};
			}

			const allRules = loader.businessRules;
			const matched = matchRulesToContext(allRules, tables, metric_refs, sql);

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								matched_rules: matched.map((r) => ({
									name: r.rule.name,
									category: r.rule.category,
									severity: r.rule.severity,
									description: r.rule.description,
									guidance: r.rule.guidance,
									matched_on: r.matched_on,
									rationale: r.rule.rationale ?? null,
								})),
								total: matched.length,
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

// ─── Rule matching logic ───

import type { BusinessRule } from '../config/index.js';

interface MatchedRule {
	rule: BusinessRule;
	matched_on: string[];
}

/**
 * Match rules to an agent's scope (for initialize_agent).
 * Returns rules whose applies_to entries overlap with the agent's tables or measures.
 */
function matchRulesToScope(rules: BusinessRule[], tables: string[], measures: string[]): BusinessRule[] {
	const tableNames = new Set(tables.map((t) => t.split('.').pop()!.toLowerCase()));
	const measureNames = new Set(measures.map((m) => m.toLowerCase()));

	return rules.filter((rule) =>
		rule.applies_to.some((target) => {
			const lower = target.toLowerCase();
			// Check if target matches a table name (e.g. "bookings.total_bookings" → "bookings")
			const tablePart = lower.split('.')[0];
			if (tableNames.has(tablePart)) return true;
			// Check if target matches a measure name
			if (measureNames.has(lower)) return true;
			return false;
		}),
	);
}

/**
 * Match rules to a query context (for get_business_rules).
 * More granular — returns which specific applies_to entry triggered the match.
 */
function matchRulesToContext(
	rules: BusinessRule[],
	tables?: string[],
	metricRefs?: string[],
	sql?: string,
): MatchedRule[] {
	const tableNames = new Set((tables ?? []).map((t) => t.split('.').pop()!.toLowerCase()));
	const metricNames = new Set((metricRefs ?? []).map((m) => m.toLowerCase()));
	const sqlLower = (sql ?? '').toLowerCase();

	const matched: MatchedRule[] = [];

	for (const rule of rules) {
		const matchedOn: string[] = [];

		for (const target of rule.applies_to) {
			const lower = target.toLowerCase();
			const tablePart = lower.split('.')[0];

			// Table match
			if (tableNames.has(tablePart)) {
				matchedOn.push(`table: ${tablePart}`);
			}
			// Metric match
			if (metricNames.has(lower)) {
				matchedOn.push(`metric: ${lower}`);
			}
			// SQL text match (check if table or metric name appears in SQL)
			if (sqlLower && (sqlLower.includes(tablePart) || sqlLower.includes(lower))) {
				if (!matchedOn.some((m) => m.startsWith('table:') || m.startsWith('metric:'))) {
					matchedOn.push(`sql_text: ${lower}`);
				}
			}
		}

		if (matchedOn.length > 0) {
			matched.push({ rule, matched_on: matchedOn });
		}
	}

	return matched;
}

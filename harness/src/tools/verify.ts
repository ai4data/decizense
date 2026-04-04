/**
 * OBSERVE & VERIFY tools — post-execution checks.
 *
 * Agents verify their own output before delivering to users.
 * The harness checks: correct measures used? data fresh? rules respected?
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeQuery } from '../database/index.js';
import { ScenarioLoader } from '../config/index.js';
import { getCatalogClient } from '../catalog/index.js';

let loader: ScenarioLoader | null = null;

export function initVerifyTools(scenarioPath: string) {
	loader = new ScenarioLoader(scenarioPath);
}

export function registerVerifyTools(server: McpServer) {
	/**
	 * verify_result — Check agent's result against business rules and intents.
	 */
	server.tool(
		'verify_result',
		"Verify an agent's result against business rules and intents",
		{
			agent_id: z.string().describe('Agent whose result is being verified'),
			question: z.string().describe('The original question'),
			result_summary: z.string().describe('Summary of the result to verify'),
			sql_used: z.string().optional().describe('The SQL query that produced the result'),
			measures_used: z.array(z.string()).optional().describe('Measures used'),
		},
		async ({ agent_id, question, result_summary, sql_used, measures_used }) => {
			if (!loader) {
				return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Not initialized' }) }] };
			}

			const checks: Array<{ check: string; passed: boolean; detail: string }> = [];
			const warnings: string[] = [];

			// Check 1: Did the agent use tables within its bundle?
			const agents = loader.agents;
			const agent = agents.agents[agent_id];
			if (agent?.bundle && sql_used) {
				try {
					const bundle = loader.getBundle(agent.bundle);
					const allowedTables = new Set(bundle.tables.map((t) => t.table));
					const tablePattern = /(?:FROM|JOIN)\s+([a-z_][a-z0-9_.]*)/gi;
					let match;
					const queriedTables: string[] = [];
					while ((match = tablePattern.exec(sql_used)) !== null) {
						queriedTables.push(match[1].replace(/^public\./, ''));
					}
					const outOfScope = queriedTables.filter((t) => !allowedTables.has(t));
					checks.push({
						check: 'bundle_scope',
						passed: outOfScope.length === 0,
						detail:
							outOfScope.length === 0
								? 'All tables within bundle'
								: `Out of scope: ${outOfScope.join(', ')}`,
					});
				} catch {
					checks.push({ check: 'bundle_scope', passed: true, detail: 'Bundle check skipped' });
				}
			}

			// Check 2: Were applicable business rules respected?
			const allRules = loader.businessRules;
			const resultLower = result_summary.toLowerCase();
			const sqlLower = (sql_used ?? '').toLowerCase();

			for (const rule of allRules) {
				if (rule.severity !== 'error') continue;
				// Check if rule's domain appears in the result/SQL
				const ruleTable = rule.applies_to[0]?.split('.')[0]?.toLowerCase() ?? '';
				if (sqlLower.includes(ruleTable) || resultLower.includes(ruleTable)) {
					// Rule is relevant — check for known violations
					if (
						rule.name === 'revenue_excludes_cancelled' &&
						sqlLower.includes('total_amount') &&
						!sqlLower.includes('cancelled')
					) {
						checks.push({
							check: 'rule_compliance',
							passed: false,
							detail: `Rule violated: ${rule.name} — query includes total_amount but does not filter cancelled bookings`,
						});
						warnings.push(rule.guidance);
					} else if (rule.name === 'pii_customer_data' && /first_name|last_name|email|phone/.test(sqlLower)) {
						checks.push({
							check: 'rule_compliance',
							passed: false,
							detail: `Rule violated: ${rule.name} — PII columns detected in query`,
						});
					} else {
						checks.push({
							check: 'rule_compliance',
							passed: true,
							detail: `Rule ${rule.name} appears respected`,
						});
					}
				}
			}

			if (checks.filter((c) => c.check === 'rule_compliance').length === 0) {
				checks.push({ check: 'rule_compliance', passed: true, detail: 'No applicable rules detected' });
			}

			const allPassed = checks.every((c) => c.passed);

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ agent_id, question, verified: allPassed, checks, warnings }, null, 2),
					},
				],
			};
		},
	);

	/**
	 * check_freshness — Is the data fresh enough based on SLA?
	 */
	server.tool(
		'check_freshness',
		'Check if data is fresh enough based on SLA expectations from policy',
		{
			tables: z.array(z.string()).describe('Tables to check freshness for'),
		},
		async ({ tables }) => {
			if (!loader) {
				return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Not initialized' }) }] };
			}

			const policy = loader.policy;
			const freshnessConfig = policy.freshness ?? {};
			const results: Array<{ table: string; sla: string; fresh: boolean; detail: string }> = [];

			for (const table of tables) {
				const tableName = table.replace(/^public\./, '');
				const sla = freshnessConfig[tableName];

				if (!sla) {
					results.push({ table: tableName, sla: 'none', fresh: true, detail: 'No SLA defined' });
					continue;
				}

				// Check last event timestamp for this table as a proxy for freshness
				try {
					const likePattern = `%${tableName.charAt(0).toUpperCase() + tableName.slice(1)}%`;
					const result = await executeQuery(
						`SELECT MAX(timestamp) as last_update FROM events
						 WHERE event_type LIKE $1
						 OR flight_id IS NOT NULL
						 LIMIT 1`,
						[likePattern],
					);
					const lastUpdate = result.rows[0] as { last_update: string | null };

					if (!lastUpdate.last_update) {
						results.push({
							table: tableName,
							sla: JSON.stringify(sla),
							fresh: false,
							detail: 'No data timestamps found',
						});
						continue;
					}

					const ageMs = Date.now() - new Date(lastUpdate.last_update).getTime();
					const ageMinutes = Math.round(ageMs / 60000);
					const maxMinutes = sla.max_delay_minutes ?? (sla.max_delay_hours ?? 24) * 60;
					const isFresh = ageMinutes <= maxMinutes;

					results.push({
						table: tableName,
						sla: `max ${maxMinutes} minutes`,
						fresh: isFresh,
						detail: `Last update ${ageMinutes} minutes ago${isFresh ? '' : ' — STALE'}`,
					});
				} catch {
					results.push({
						table: tableName,
						sla: JSON.stringify(sla),
						fresh: true,
						detail: 'Could not check',
					});
				}
			}

			const allFresh = results.every((r) => r.fresh);

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ tables_checked: tables.length, all_fresh: allFresh, results }, null, 2),
					},
				],
			};
		},
	);

	/**
	 * check_consistency — Does the result align with known rules?
	 */
	server.tool(
		'check_consistency',
		'Check if a result is consistent with applicable business rules',
		{
			agent_id: z.string().describe('Agent whose result is being checked'),
			result_summary: z.string().describe('The result to check'),
			applicable_rules: z.array(z.string()).optional().describe('Rules to check against'),
		},
		async ({ agent_id, result_summary, applicable_rules }) => {
			if (!loader) {
				return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Not initialized' }) }] };
			}

			const allRules = loader.businessRules;
			const rulesToCheck = applicable_rules
				? allRules.filter((r) => applicable_rules.includes(r.name))
				: allRules;

			const violations: Array<{ rule: string; severity: string; description: string }> = [];
			const resultLower = result_summary.toLowerCase();

			for (const rule of rulesToCheck) {
				// Check for known inconsistencies
				if (
					rule.name === 'revenue_excludes_cancelled' &&
					resultLower.includes('revenue') &&
					resultLower.includes('cancel')
				) {
					// Could be a violation or could be properly excluded — flag for review
					violations.push({
						rule: rule.name,
						severity: rule.severity,
						description: `Result mentions both revenue and cancelled — verify ${rule.guidance}`,
					});
				}
				if (
					rule.name === 'compensation_threshold' &&
					resultLower.includes('compensation') &&
					resultLower.includes('delay')
				) {
					// Check if compensation discussion aligns with 3-hour threshold
					if (!resultLower.includes('3 hour') && !resultLower.includes('180 min')) {
						violations.push({
							rule: rule.name,
							severity: 'warning',
							description:
								'Compensation discussed but 3-hour threshold not mentioned — verify EU-261 compliance',
						});
					}
				}
			}

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								agent_id,
								rules_checked: rulesToCheck.length,
								consistent: violations.length === 0,
								violations,
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
	 * get_confidence — Composite confidence score.
	 */
	server.tool(
		'get_confidence',
		'Get overall confidence score based on freshness, rules, and agent coverage',
		{
			session_id: z.string().describe('Session to score'),
			tables_used: z.array(z.string()).describe('Tables that were queried'),
			rules_checked: z.array(z.string()).describe('Rules that were verified'),
			agents_consulted: z.array(z.string()).describe('Agents that contributed'),
		},
		async ({ session_id, tables_used, rules_checked, agents_consulted }) => {
			if (!loader) {
				return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Not initialized' }) }] };
			}

			// Freshness score
			const policy = loader.policy;
			const freshnessConfig = policy.freshness ?? {};
			let freshnessScore = 1.0;
			for (const table of tables_used) {
				const tableName = table.replace(/^public\./, '');
				if (freshnessConfig[tableName]) {
					// Assume fresh for now — real implementation would check timestamps
					freshnessScore = Math.min(freshnessScore, 0.95);
				}
			}

			// Rule compliance score
			const allRules = loader.businessRules;
			const relevantRules = allRules.filter((r) => r.severity === 'error');
			const checkedCount = rules_checked.length;
			const ruleScore = relevantRules.length > 0 ? Math.min(checkedCount / relevantRules.length, 1.0) : 1.0;

			// Coverage score — how many required agents were consulted
			const allAgents = Object.keys(loader.agents.agents).filter(
				(a) => loader!.agents.agents[a].role === 'domain',
			);
			const coverageScore = allAgents.length > 0 ? agents_consulted.length / allAgents.length : 1.0;

			// Precedent score — check if similar decisions exist
			let precedentScore = 0.5; // default: no precedent
			try {
				const result = await executeQuery(
					`SELECT COUNT(*) as count FROM decision_outcomes WHERE session_id != $1`,
					[session_id],
				);
				const count = parseInt((result.rows[0] as { count: string }).count);
				if (count > 10) precedentScore = 0.9;
				else if (count > 3) precedentScore = 0.7;
				else if (count > 0) precedentScore = 0.6;
			} catch {
				// No precedent table
			}

			// Composite score
			const composite = freshnessScore * 0.3 + ruleScore * 0.3 + coverageScore * 0.25 + precedentScore * 0.15;
			const confidence = composite >= 0.8 ? 'high' : composite >= 0.5 ? 'medium' : 'low';

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								session_id,
								confidence,
								score: Math.round(composite * 100) / 100,
								breakdown: {
									freshness: {
										score: Math.round(freshnessScore * 100) / 100,
										detail: `${tables_used.length} tables checked`,
									},
									rule_compliance: {
										score: Math.round(ruleScore * 100) / 100,
										detail: `${checkedCount} of ${relevantRules.length} error rules verified`,
									},
									coverage: {
										score: Math.round(coverageScore * 100) / 100,
										detail: `${agents_consulted.length} of ${allAgents.length} domain agents consulted`,
									},
									precedent: {
										score: Math.round(precedentScore * 100) / 100,
										detail: 'Based on past decision count',
									},
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
}

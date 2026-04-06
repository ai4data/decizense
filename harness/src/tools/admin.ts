/**
 * ADMIN tools — for governance teams, not agents during sessions.
 *
 * Audit, gap detection, impact analysis, and decision review.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeQuery } from '../database/index.js';
import { ScenarioLoader } from '../config/index.js';
import { getCatalogClient } from '../catalog/index.js';

let loader: ScenarioLoader | null = null;

export function initAdminTools(scenarioPath: string) {
	loader = new ScenarioLoader(scenarioPath);
}

export function registerAdminTools(server: McpServer) {
	/**
	 * find_governance_gaps — Scan for unblocked PII, ungoverned tables.
	 */
	server.tool(
		'find_governance_gaps',
		'[Admin] Find gaps in governance coverage — unblocked PII, ungoverned tables',
		{
			check: z.enum(['pii', 'bundles', 'rules', 'all']).optional().default('all').describe('Which gaps to check'),
		},
		async ({ check }) => {
			if (!loader) {
				return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Not initialized' }) }] };
			}

			const gaps: Array<{ type: string; entity: string; description: string }> = [];
			const catalog = getCatalogClient();

			// PII gaps: columns tagged as PII in catalog but not in policy
			if (check === 'pii' || check === 'all') {
				if (catalog) {
					try {
						const catalogPii = await catalog.getPiiColumns();
						const policyPii = loader.getPiiColumns();
						for (const col of catalogPii) {
							if (!policyPii.has(col)) {
								gaps.push({
									type: 'pii_not_in_policy',
									entity: col,
									description: `Column ${col} tagged as PII in catalog but not blocked in policy.yml`,
								});
							}
						}
						for (const col of policyPii) {
							if (!catalogPii.has(col)) {
								gaps.push({
									type: 'pii_not_in_catalog',
									entity: col,
									description: `Column ${col} blocked in policy.yml but not tagged as PII in catalog`,
								});
							}
						}
					} catch {
						gaps.push({
							type: 'catalog_error',
							entity: 'catalog',
							description: 'Could not check PII in catalog',
						});
					}
				}
			}

			// Bundle gaps: tables in database not in any bundle
			if (check === 'bundles' || check === 'all') {
				const allBundles = loader.getAllBundles();
				const bundledTables = new Set<string>();
				for (const bundle of allBundles) {
					for (const t of bundle.tables) {
						bundledTables.add(t.table);
					}
				}

				if (catalog) {
					try {
						const catalogTables = await catalog.listTables();
						for (const table of catalogTables) {
							if (!bundledTables.has(table.name)) {
								gaps.push({
									type: 'table_not_in_bundle',
									entity: table.name,
									description: `Table ${table.name} exists in catalog but not in any dataset bundle`,
								});
							}
						}
					} catch {
						// Catalog unavailable
					}
				}
			}

			// Rule gaps: tables in bundles without business rules
			if (check === 'rules' || check === 'all') {
				const allBundles = loader.getAllBundles();
				const allRules = loader.businessRules;
				const ruledTables = new Set<string>();
				for (const rule of allRules) {
					for (const target of rule.applies_to) {
						ruledTables.add(target.split('.')[0].toLowerCase());
					}
				}

				for (const bundle of allBundles) {
					for (const t of bundle.tables) {
						if (!ruledTables.has(t.table.toLowerCase())) {
							gaps.push({
								type: 'table_no_rules',
								entity: `${bundle.bundle_id}/${t.table}`,
								description: `Table ${t.table} in bundle ${bundle.bundle_id} has no business rules`,
							});
						}
					}
				}
			}

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ check, total_gaps: gaps.length, gaps }, null, 2),
					},
				],
			};
		},
	);

	/**
	 * simulate_removal — What breaks if we remove a table?
	 */
	server.tool(
		'simulate_removal',
		'[Admin] Simulate removing a table and report what breaks',
		{
			table_name: z.string().describe('Table name to simulate removing'),
		},
		async ({ table_name }) => {
			if (!loader) {
				return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Not initialized' }) }] };
			}

			const impact: Array<{ type: string; entity: string; description: string }> = [];

			// Check bundles that contain this table
			const allBundles = loader.getAllBundles();
			for (const bundle of allBundles) {
				if (bundle.tables.some((t) => t.table === table_name)) {
					impact.push({
						type: 'bundle_broken',
						entity: bundle.bundle_id,
						description: `Bundle ${bundle.bundle_id} contains ${table_name} — would lose access`,
					});

					// Check joins that reference this table
					for (const join of bundle.joins ?? []) {
						if (join.left.table === table_name || join.right.table === table_name) {
							impact.push({
								type: 'join_broken',
								entity: `${join.left.table}.${join.left.column} = ${join.right.table}.${join.right.column}`,
								description: `Join would break in bundle ${bundle.bundle_id}`,
							});
						}
					}
				}
			}

			// Check business rules that reference this table
			const allRules = loader.businessRules;
			for (const rule of allRules) {
				for (const target of rule.applies_to) {
					if (target.toLowerCase().startsWith(table_name.toLowerCase())) {
						impact.push({
							type: 'rule_orphaned',
							entity: rule.name,
							description: `Rule ${rule.name} applies to ${target} — would become orphaned`,
						});
					}
				}
			}

			// Check semantic model
			const semanticModel = loader.semanticModel;
			for (const model of semanticModel.models) {
				if (model.table.table === table_name) {
					impact.push({
						type: 'model_broken',
						entity: model.name,
						description: `Semantic model ${model.name} wraps ${table_name} — ${model.measures.length} measures and ${model.dimensions.length} dimensions would break`,
					});
				}
			}

			// Check lineage from catalog
			const catalog = getCatalogClient();
			if (catalog) {
				try {
					const serviceName = loader?.scenario?.catalog?.service_name ?? 'default';
					const dbName = loader?.scenario?.database?.name ?? 'db';
					const fqn = `${serviceName}.${dbName}.public.${table_name}`;
					const lineage = await catalog.getLineage(fqn);
					for (const edge of lineage) {
						impact.push({
							type: 'lineage_broken',
							entity: `${edge.from.split('.').pop()} → ${edge.to.split('.').pop()}`,
							description: `Lineage dependency would break`,
						});
					}
				} catch {
					// Catalog unavailable
				}
			}

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								table: table_name,
								total_impact: impact.length,
								impact,
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
	 * graph_stats — Overview statistics.
	 */
	server.tool('graph_stats', '[Admin] Get governance statistics — tables, rules, agents, decisions', {}, async () => {
		if (!loader) {
			return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Not initialized' }) }] };
		}

		const allBundles = loader.getAllBundles();
		const allRules = loader.businessRules;
		const agents = Object.keys(loader.agents.agents);
		const policy = loader.policy;

		// Count decisions from database
		let decisionCount = 0;
		let findingCount = 0;
		try {
			const dResult = await executeQuery('SELECT COUNT(*) as count FROM decision_outcomes');
			decisionCount = parseInt((dResult.rows[0] as { count: string }).count);
			const fResult = await executeQuery('SELECT COUNT(*) as count FROM decision_findings');
			findingCount = parseInt((fResult.rows[0] as { count: string }).count);
		} catch {
			// Tables may not exist
		}

		// Count tables from catalog
		let catalogTableCount = 0;
		let glossaryTermCount = 0;
		const catalog = getCatalogClient();
		if (catalog) {
			try {
				const tables = await catalog.listTables();
				catalogTableCount = tables.length;
				const terms = await catalog.listGlossaryTerms();
				glossaryTermCount = terms.length;
			} catch {
				// Catalog unavailable
			}
		}

		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify(
						{
							catalog: { tables: catalogTableCount, glossary_terms: glossaryTermCount },
							governance: {
								bundles: allBundles.length,
								business_rules: allRules.length,
								pii_columns: [...loader.getPiiColumns()].length,
								agents: agents.length,
							},
							decisions: { outcomes: decisionCount, findings: findingCount },
							policy: {
								max_rows: policy.defaults.max_rows,
								pii_mode: policy.pii.mode,
								risk_levels: Object.keys(policy.actions?.risk_classification ?? {}),
							},
						},
						null,
						2,
					),
				},
			],
		};
	});

	/**
	 * audit_decisions — Query past decisions for compliance.
	 */
	server.tool(
		'audit_decisions',
		'[Admin] Query past decisions for compliance and audit',
		{
			from_date: z.string().optional().describe('Start date (ISO format)'),
			to_date: z.string().optional().describe('End date (ISO format)'),
			agent_id: z.string().optional().describe('Filter by agent'),
			confidence: z.enum(['high', 'medium', 'low']).optional().describe('Filter by confidence'),
			limit: z.number().optional().default(20).describe('Max results'),
		},
		async ({ from_date, to_date, agent_id, confidence, limit }) => {
			try {
				const conditions: string[] = [];
				const params: unknown[] = [];

				if (from_date) {
					params.push(from_date);
					conditions.push(`created_at >= $${params.length}`);
				}
				if (to_date) {
					params.push(to_date);
					conditions.push(`created_at <= $${params.length}`);
				}
				if (confidence) {
					params.push(confidence);
					conditions.push(`confidence = $${params.length}`);
				}
				if (agent_id) {
					params.push(agent_id);
					conditions.push(`$${params.length} = ANY(agents_involved)`);
				}

				const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

				params.push(limit ?? 20);
				const limitParam = `$${params.length}`;

				const result = await executeQuery(
					`SELECT outcome_id, session_id, question, decision_summary, reasoning, confidence,
					        agents_involved, cost_usd, evidence_event_ids, evidence_rules,
					        evidence_signal_types, evidence_proposal_ids, created_at
					 FROM decision_outcomes ${whereClause}
					 ORDER BY created_at DESC LIMIT ${limitParam}`,
					params,
				);

				// Also get proposal/action details for each outcome
				const outcomes = result.rows as Array<Record<string, unknown>>;
				for (const outcome of outcomes) {
					const proposalIds = outcome.evidence_proposal_ids as number[] | null;
					if (proposalIds?.length) {
						const proposals = await executeQuery(
							`SELECT p.proposal_id, p.risk_class, p.status, a.approved_by, a.approved,
							        act.action_type, act.status as action_status
							 FROM decision_proposals p
							 LEFT JOIN decision_approvals a ON p.proposal_id = a.proposal_id
							 LEFT JOIN decision_actions act ON p.proposal_id = act.proposal_id
							 WHERE p.proposal_id = ANY($1)`,
							[proposalIds],
						);
						outcome.proposals = proposals.rows;
					}
				}

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{
									filters: { from_date, to_date, agent_id, confidence },
									total: result.rowCount,
									decisions: outcomes,
								},
								null,
								2,
							),
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

	// ─── Phase 2c admin tools ─────────────────────────────────────────────

	const OPA_URL = process.env.OPA_URL ?? 'http://localhost:8181';

	/**
	 * Replay a single decision against the running OPA sidecar. Posts the
	 * stored input to the OPA REST API and returns the replayed result.
	 */
	async function replayViaOpa(input: unknown): Promise<{ allow: boolean; violations: unknown[] }> {
		const resp = await fetch(`${OPA_URL}/v1/data/dazense/governance/result`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ input }),
		});
		if (!resp.ok) throw new Error(`OPA replay HTTP ${resp.status}`);
		const body = (await resp.json()) as { result?: { allow?: boolean; violations?: unknown[] } };
		return {
			allow: body.result?.allow ?? false,
			violations: body.result?.violations ?? [],
		};
	}

	/**
	 * replay_outcome — Re-evaluate a past governance decision against the
	 * currently loaded OPA policy bundle via the sidecar REST API.
	 */
	server.tool(
		'replay_outcome',
		'[Admin] Re-evaluate a past governance decision against current policy bundle',
		{
			opa_decision_id: z.string().describe('The decision log ID to replay'),
		},
		async ({ opa_decision_id }) => {
			try {
				const logResult = await executeQuery(
					`SELECT opa_decision_id, bundle_revision, input, result, allowed, agent_id, tool_name, timestamp
					 FROM decision_logs WHERE opa_decision_id = $1`,
					[opa_decision_id],
				);
				if (logResult.rowCount === 0) {
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({
									error: `Decision ${opa_decision_id} not found in decision_logs`,
								}),
							},
						],
					};
				}

				const row = logResult.rows[0] as {
					opa_decision_id: string;
					bundle_revision: string;
					input: unknown;
					result: unknown;
					allowed: boolean;
					agent_id: string;
					tool_name: string;
					timestamp: string;
				};

				const replayed = await replayViaOpa(row.input);
				const policyChanged = row.allowed !== replayed.allow;

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{
									opa_decision_id: row.opa_decision_id,
									agent_id: row.agent_id,
									tool_name: row.tool_name,
									timestamp: row.timestamp,
									original: {
										allowed: row.allowed,
										bundle_revision: row.bundle_revision,
										result: row.result,
									},
									replayed: {
										allowed: replayed.allow,
										violations: replayed.violations,
									},
									policy_changed: policyChanged,
									diff: policyChanged
										? `Original: ${row.allowed ? 'ALLOW' : 'DENY'} -> Replay: ${replayed.allow ? 'ALLOW' : 'DENY'}`
										: 'No change',
								},
								null,
								2,
							),
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
	 * policy_drift_report — Replay N recent governance decisions against
	 * the currently loaded OPA policy bundle and report how many would now
	 * be decided differently. Useful for impact analysis before deploying
	 * a policy change: update data.json, restart OPA, run this tool.
	 */
	server.tool(
		'policy_drift_report',
		'[Admin] Replay recent decisions against current policy and report drift',
		{
			since: z.string().optional().describe('Only replay decisions after this timestamp (ISO format)'),
			limit: z.number().optional().default(100).describe('Max decisions to replay'),
		},
		async ({ since, limit }) => {
			try {
				const conditions: string[] = [];
				const params: unknown[] = [];

				if (since) {
					params.push(since);
					conditions.push(`timestamp >= $${params.length}`);
				}

				const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
				params.push(limit ?? 100);
				const limitParam = `$${params.length}`;

				const logResult = await executeQuery(
					`SELECT opa_decision_id, input, allowed, agent_id
					 FROM decision_logs ${whereClause}
					 ORDER BY timestamp DESC LIMIT ${limitParam}`,
					params,
				);

				if (logResult.rowCount === 0) {
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({ total: 0, changed: 0, message: 'No decision logs found' }),
							},
						],
					};
				}

				const changed: Array<{
					opa_decision_id: string;
					agent_id: string;
					original_allowed: boolean;
					replay_allowed: boolean;
				}> = [];

				for (const row of logResult.rows) {
					const r = row as { opa_decision_id: string; input: unknown; allowed: boolean; agent_id: string };
					try {
						const replayed = await replayViaOpa(r.input);
						if (r.allowed !== replayed.allow) {
							changed.push({
								opa_decision_id: r.opa_decision_id,
								agent_id: r.agent_id,
								original_allowed: r.allowed,
								replay_allowed: replayed.allow,
							});
						}
					} catch {
						// OPA replay failed for this row — skip
					}
				}

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{
									total: logResult.rowCount,
									changed: changed.length,
									drift_rate: `${((changed.length / logResult.rowCount) * 100).toFixed(1)}%`,
									examples: changed.slice(0, 10),
								},
								null,
								2,
							),
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

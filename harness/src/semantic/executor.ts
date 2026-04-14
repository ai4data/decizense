/**
 * Semantic executor — orchestrates planner → compiler → governance →
 * pg → response shaping.
 *
 * This is the only module in `harness/src/semantic/` that is allowed
 * to touch the database, the auth context, or the governance pipeline.
 * The pure modules (registry, planner, sql-compiler) stay testable in
 * isolation.
 *
 * Lifecycle:
 *   initSemantic(scenarioPath) → cache loader + registry once.
 *   runMetricQuery(authContext, request) → MetricQueryResult or throws
 *     a SemanticError that the tool wrapper turns into a structured
 *     response.
 */

import type { AuthContext } from '../auth/context.js';
import { ScenarioLoader } from '../config/index.js';
import { executeQuery } from '../database/index.js';
import { evaluateGovernance, filterPiiFromResults } from '../governance/index.js';

import { compile } from './sql-compiler.js';
import { plan, type AgentScope } from './planner.js';
import { SemanticRegistry } from './registry.js';
import type { MetricQueryRequest, MetricQueryResult, QueryPlan } from './types.js';
import { SemanticError } from './types.js';

let loader: ScenarioLoader | null = null;
let registry: SemanticRegistry | null = null;

export function initSemantic(scenarioPath: string): void {
	loader = new ScenarioLoader(scenarioPath);
	// Build registry eagerly so duplicate-name / invalid-aggregation
	// errors in scenario YAML surface at boot, not on first request.
	registry = new SemanticRegistry(loader.semanticModel, loader.getAllBundles());
}

/**
 * Public entry point. Resolves the agent's bundle, plans, compiles,
 * runs governance, executes, and returns a structured result.
 */
export async function runMetricQuery(
	authContext: AuthContext,
	request: MetricQueryRequest,
): Promise<MetricQueryResult> {
	if (!loader || !registry) {
		throw new SemanticError('execution_failed', 'Semantic executor not initialised — call initSemantic first.');
	}

	const scope = resolveAgentScope(loader, authContext.agentId);
	const planned: QueryPlan = plan(request, registry, scope);
	const compiled = compile(planned);

	// ── Governance gate ──────────────────────────────────────────────
	const governance = await evaluateGovernance({
		authContext,
		sql: compiled.sql,
		metric_refs: planned.measures.map((m) => m.ref),
	});
	if (!governance.allowed) {
		throw new SemanticError('governance_blocked', governance.reason ?? 'Governance blocked the metric query.', {
			blocked_columns: governance.blocked_columns ?? [],
			warnings: governance.warnings ?? [],
			applicable_rules: governance.applicable_rules ?? [],
			policy_version: governance.policy_version ?? null,
		});
	}

	// ── Execute ──────────────────────────────────────────────────────
	let rows: Record<string, unknown>[];
	try {
		const result = await executeQuery(compiled.sql, compiled.params);
		rows = result.rows;
	} catch (err) {
		throw new SemanticError('execution_failed', `Postgres rejected the compiled SQL: ${(err as Error).message}`, {
			generated_sql: compiled.sql,
		});
	}

	// ── PII defence-in-depth ─────────────────────────────────────────
	const piiList = governance.all_pii_columns ?? governance.blocked_columns ?? [];
	const filtered = filterPiiFromResults(rows, piiList);

	return {
		status: 'ok',
		rows: filtered,
		row_count: filtered.length,
		generated_sql: compiled.sql,
		resolved_measures: planned.measures.map((m) => ({ ref: m.ref, expression: m.expression })),
		resolved_dimensions: planned.dimensions.map((d) => ({
			ref: d.ref,
			column: d.column,
			...(d.timeGrain ? { time_grain: d.timeGrain } : {}),
		})),
		applied_time_window: planned.appliedTimeWindow,
		governance: {
			policy_version: governance.policy_version ?? null,
			...(governance.contract_id ? { contract_id: governance.contract_id } : {}),
		},
	};
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build the AgentScope the planner needs from the loader + agent id.
 * Returns an empty scope (no tables, no joins) if the agent has no
 * bundle — the planner will then fail with out_of_bundle on the first
 * model it touches, which is the right default-deny behaviour.
 */
function resolveAgentScope(l: ScenarioLoader, agentId: string): AgentScope {
	const agents = l.agents;
	const agentConfig = agents.agents[agentId];
	if (!agentConfig?.bundle) {
		return { bundleId: '(none)', bundleTables: new Set(), bundleJoins: [], timeFilters: [] };
	}
	try {
		const bundle = l.getBundle(agentConfig.bundle);
		return {
			bundleId: bundle.bundle_id,
			bundleTables: new Set(bundle.tables.map((t) => t.table)),
			bundleJoins: bundle.joins ?? [],
			timeFilters: bundle.time_filters ?? [],
		};
	} catch {
		return { bundleId: agentConfig.bundle, bundleTables: new Set(), bundleJoins: [], timeFilters: [] };
	}
}

/**
 * policy/build.ts — Phase 2a bundle builder.
 *
 * Reads scenario YAMLs via the existing harness ScenarioLoader and emits:
 *   - policy/data.json    (OPA data document, frozen for deterministic replay)
 *   - policy/.manifest    (OPA bundle manifest with revision = sha256(data.json))
 *
 * Both files are COMMITTED to the repo. Re-run this script whenever the
 * underlying YAMLs (agents, bundles, policy) change. The sha256 revision
 * stamps are reviewable in PRs and anchor replay to a specific bundle state.
 *
 * The set of information we ship to OPA is intentionally minimal — only
 * what the 8 governance checks actually need:
 *
 *   - agents:         { [agent_id]: { role, bundle, can_query } }
 *   - bundles:        { [bundle_id]: { allowed_tables, joins } }
 *   - pii_columns:    { [table]: [col, ...] }
 *   - policy:         { max_rows, enforce_limit, disallow_multi_statement,
 *                       enforce_bundle_allowlist, allow_execute_sql, pii_mode }
 *
 * Cross-bundle joins are explicitly NOT carried — today's TS governance
 * doesn't enforce them (policy.joins.allow_cross_bundle is false but not
 * checked per-query). Keep Phase 2 behavior-identical; cross-bundle join
 * enforcement is a future change, not a migration concern.
 *
 * Usage:  npx tsx policy/build.ts [scenarioPath]
 * Default scenarioPath: ./scenario/travel
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScenarioLoader } from '../harness/src/config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface BundleData {
	allowed_tables: string[];
	joins: Array<{ left_col: string; right_col: string }>;
}

interface DataDocument {
	agents: Record<string, { role: string; bundle: string | null; can_query: boolean }>;
	bundles: Record<string, BundleData>;
	pii_columns: Record<string, string[]>;
	policy: {
		max_rows: number;
		enforce_limit: boolean;
		disallow_multi_statement: boolean;
		enforce_bundle_allowlist: boolean;
		allow_execute_sql: boolean;
		pii_mode: string;
	};
}

function buildData(scenarioPath: string): DataDocument {
	const loader = new ScenarioLoader(scenarioPath);
	const agents = loader.agents;
	const policy = loader.policy;

	// ── Agents ──
	const agentsOut: DataDocument['agents'] = {};
	for (const [id, cfg] of Object.entries(agents.agents)) {
		agentsOut[id] = {
			role: cfg.role,
			bundle: cfg.bundle ?? null,
			can_query: cfg.can_query,
		};
	}

	// ── Bundles ──
	// Collect the set of unique bundle_ids referenced by at least one agent.
	const bundleIds = new Set<string>();
	for (const cfg of Object.values(agents.agents)) {
		if (cfg.bundle) bundleIds.add(cfg.bundle);
	}

	const bundlesOut: DataDocument['bundles'] = {};
	for (const bundleId of bundleIds) {
		const bundle = loader.getBundle(bundleId);
		// Mirror the TS allow-list construction in governance/index.ts:287-289:
		// both fully-qualified ("public.flights") and unqualified ("flights") forms.
		const allowed = new Set<string>();
		for (const t of bundle.tables) {
			allowed.add(`${t.schema}.${t.table}`.toLowerCase());
			allowed.add(t.table.toLowerCase());
		}
		const joins = (bundle.joins ?? []).map((j) => ({
			left_col: j.left.column.toLowerCase(),
			right_col: j.right.column.toLowerCase(),
		}));
		bundlesOut[bundleId] = {
			allowed_tables: [...allowed].sort(),
			joins,
		};
	}

	// ── PII columns ── shaped as { [table]: [col, ...] } for Rego iteration
	const piiOut: Record<string, string[]> = {};
	for (const [tableKey, cols] of Object.entries(policy.pii.columns)) {
		// tableKey example: "public.customers" → store as "customers" (unqualified)
		// to match the current TS logic which does `split('.').pop()` for column name
		// comparison and normalizes table refs.
		const tableName = tableKey.split('.').pop() ?? tableKey;
		piiOut[tableName] = [...cols].sort();
	}

	// ── Policy knobs ──
	const policyOut: DataDocument['policy'] = {
		max_rows: policy.defaults.max_rows,
		enforce_limit: policy.execution.sql_validation.enforce_limit,
		disallow_multi_statement: policy.execution.sql_validation.disallow_multi_statement,
		enforce_bundle_allowlist: policy.joins.enforce_bundle_allowlist,
		allow_execute_sql: policy.execution.allow_execute_sql,
		pii_mode: policy.pii.mode,
	};

	return {
		agents: agentsOut,
		bundles: bundlesOut,
		pii_columns: piiOut,
		policy: policyOut,
	};
}

function main(): void {
	const scenarioPath = resolve(process.argv[2] ?? 'scenario/travel');
	const outDir = resolve(__dirname);

	const data = buildData(scenarioPath);
	// Canonical JSON: sorted keys → reproducible sha256 across machines.
	const dataJson = JSON.stringify(data, Object.keys(data).sort(), 2) + '\n';

	// Re-serialize with sorted keys at every level for a stable revision.
	const stable = JSON.stringify(sortKeys(data), null, 2) + '\n';
	const revision = createHash('sha256').update(stable).digest('hex');

	const manifest = {
		revision,
		roots: ['dazense/governance'],
	};

	writeFileSync(join(outDir, 'data.json'), stable, 'utf8');
	writeFileSync(join(outDir, '.manifest'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

	console.log(`✓ policy/data.json written (${stable.length} bytes)`);
	console.log(`✓ policy/.manifest written`);
	console.log(`  revision: ${revision}`);
	console.log(`  scenario: ${scenarioPath}`);
	console.log(`  agents:   ${Object.keys(data.agents).length}`);
	console.log(`  bundles:  ${Object.keys(data.bundles).length}`);
	console.log(`  pii tables: ${Object.keys(data.pii_columns).length}`);
	void dataJson; // unused, kept for reference diff vs. stable
}

/** Deep key-sort for deterministic JSON. */
function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value as Record<string, unknown>).sort()) {
			out[k] = sortKeys((value as Record<string, unknown>)[k]);
		}
		return out;
	}
	return value;
}

main();

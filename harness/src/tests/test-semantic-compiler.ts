/**
 * Semantic compiler regression — registry + planner + sql-compiler.
 *
 * No DB, no MCP, no auth. Loads scenario YAML via ScenarioLoader, runs
 * the pure planner + compiler, asserts on plan IR + golden SQL +
 * structured errors. Safe in CI alongside test-scenario-neutral.ts.
 *
 * Coverage:
 *   - Resolution: known refs pass; unknown / unqualified / wrong-model
 *     refs fail with the right SemanticErrorCode.
 *   - Planner: time_range produces two WHERE preds + appliedTimeWindow;
 *     filter classification splits into WHERE vs HAVING; order_by binds
 *     to a selected field; bundle scope blocks out-of-bundle models;
 *     disallowed joins refuse; fanout refusal fires on cross-model
 *     non-distinct aggregations.
 *   - Compiler: golden SQL snapshots for representative queries.
 *   - Ambiguity: two distinct measures named for the "delayed" concept
 *     (snapshot vs event-log style) cannot be silently substituted.
 *   - Non-travel fixture: same code paths run against minimal scenario.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ScenarioLoader } from '../config/index.js';
import { plan, type AgentScope } from '../semantic/planner.js';
import { SemanticRegistry } from '../semantic/registry.js';
import { compile } from '../semantic/sql-compiler.js';
import { SemanticError, type MetricQueryRequest } from '../semantic/types.js';

interface Assertion {
	ok: boolean;
	label: string;
	detail?: string;
}
const results: Assertion[] = [];

function assert(cond: boolean, label: string, detail?: string): void {
	results.push({ ok: cond, label, detail: cond ? undefined : detail });
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
	results.push({
		ok: actual === expected,
		label,
		detail: actual === expected ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
	});
}
function expectError(fn: () => unknown, code: string, label: string): void {
	try {
		fn();
		results.push({ ok: false, label, detail: `expected SemanticError code=${code}, got success` });
	} catch (e) {
		if (e instanceof SemanticError && e.code === code) {
			results.push({ ok: true, label });
		} else if (e instanceof SemanticError) {
			results.push({ ok: false, label, detail: `expected code=${code}, got ${e.code}` });
		} else {
			results.push({ ok: false, label, detail: `expected SemanticError, got ${String(e)}` });
		}
	}
}

const HERE = dirname(fileURLToPath(import.meta.url));
const TRAVEL_PATH = resolve(HERE, '..', '..', '..', 'scenario', 'travel');
const MINIMAL_PATH = resolve(HERE, '..', '..', '..', 'scenario', '_fixtures', 'minimal');

const travel = new ScenarioLoader(TRAVEL_PATH);
const minimal = new ScenarioLoader(MINIMAL_PATH);

const travelRegistry = new SemanticRegistry(travel.semanticModel, travel.getAllBundles());
const minimalRegistry = new SemanticRegistry(minimal.semanticModel, minimal.getAllBundles());

const flightOpsScope: AgentScope = {
	bundleId: 'flights-ops',
	bundleTables: new Set(['flights', 'airports', 'airlines', 'flight_delays']),
	bundleJoins: travel.getBundle('flights-ops').joins ?? [],
	timeFilters: travel.getBundle('flights-ops').time_filters ?? [],
};
const widgetScope: AgentScope = {
	bundleId: 'widgets-ops',
	bundleTables: new Set(['widgets', 'orders']),
	bundleJoins: minimal.getBundle('widgets-ops').joins ?? [],
	timeFilters: [],
};

// ── 1. Registry resolution ────────────────────────────────────────────────

assert(!!travelRegistry.getModel('flights'), 'registry resolves the flights model');
assertEqual(travelRegistry.classifyRef('flights.delayed_flights'), 'measure', 'classifies measure refs');
assertEqual(travelRegistry.classifyRef('flights.airline'), 'dimension', 'classifies dimension refs');
expectError(
	() => travelRegistry.resolveMeasure('flights.no_such'),
	'unknown_measure',
	'unknown measure → unknown_measure',
);
expectError(
	() => travelRegistry.resolveDimension('flights.no_such'),
	'unknown_dimension',
	'unknown dim → unknown_dimension',
);
expectError(() => travelRegistry.resolveMeasure('delayed_flights'), 'ambiguous_ref', 'unqualified ref → ambiguous_ref');
expectError(() => travelRegistry.resolveMeasure('no_such_model.x'), 'unknown_model', 'wrong model → unknown_model');

// ── 2. Planner: simple, single-model, with time range + filter ────────────

const simplePlan = plan(
	{
		measures: ['flights.delayed_flights', 'flights.total_flights'],
		dimensions: ['flights.airline'],
		filters: [{ field: 'flights.status', operator: '!=', value: 'cancelled' }],
		time_range: { start: '2026-03-01', end: '2026-04-01' },
		order_by: [{ field: 'delayed_flights', direction: 'desc' }],
		limit: 10,
	},
	travelRegistry,
	flightOpsScope,
);

assertEqual(simplePlan.models.length, 1, 'single participating model');
assertEqual(simplePlan.measures.length, 2, 'two measures planned');
assertEqual(simplePlan.dimensions.length, 1, 'one dimension planned');
assertEqual(simplePlan.whereFilters.length, 3, 'WHERE = user filter + 2 time bounds');
assertEqual(simplePlan.havingFilters.length, 0, 'no HAVING filters');
assert(!!simplePlan.appliedTimeWindow, 'appliedTimeWindow surfaced');
assertEqual(
	simplePlan.appliedTimeWindow?.column,
	'flights.scheduled_departure',
	'window column resolved from model.time_dimension',
);
assertEqual(simplePlan.params.length, 4, 'params: 1 measure-filter + 1 user filter + 2 time bounds');

// ── 3. Compiler: golden SQL ───────────────────────────────────────────────

const compiled = compile(simplePlan);
// The planner records params in this order:
//   $1 — measure-level filter literal ("delayed")
//   $2, $3 — time_range start / end (planner adds time bounds before
//             the loop over user filters)
//   $4 — user filter literal ("cancelled")
// Compiler renders WHERE clauses in plan.whereFilters order: the
// time-bound predicates first, then the user filter.
const expectedSql = [
	'SELECT "flights"."airline_code" AS "airline", COUNT(flights.flight_id) FILTER (WHERE flights.status = $1) AS "delayed_flights", COUNT(flights.flight_id) AS "total_flights"',
	'FROM "public"."flights" AS "flights"',
	'WHERE "flights"."scheduled_departure" >= $2 AND "flights"."scheduled_departure" < $3 AND "flights"."status" != $4',
	'GROUP BY 1',
	'ORDER BY "delayed_flights" DESC',
	'LIMIT 10',
].join('\n');
assertEqual(compiled.sql, expectedSql, 'golden SQL: airline × delayed + total, March 2026');
assertEqual(compiled.params.length, 4, 'compiled params count matches plan');
assertEqual(compiled.params[0], 'delayed', "param 1 = measure-filter literal 'delayed'");
assertEqual(compiled.params[1], '2026-03-01', 'param 2 = time_range start');
assertEqual(compiled.params[2], '2026-04-01', 'param 3 = time_range end');
assertEqual(compiled.params[3], 'cancelled', "param 4 = user filter literal 'cancelled'");

// ── 4. HAVING filter (post-aggregation, on a measure) ─────────────────────

const havingPlan = plan(
	{
		measures: ['flights.delayed_flights'],
		dimensions: ['flights.airline'],
		filters: [{ field: 'flights.delayed_flights', operator: '>', value: 5 }],
		time_range: { start: '2026-03-01', end: '2026-04-01' },
	},
	travelRegistry,
	flightOpsScope,
);
assertEqual(havingPlan.havingFilters.length, 1, 'measure filter routed to HAVING');
assertEqual(havingPlan.whereFilters.length, 2, 'WHERE has only the time bounds');
const havingSql = compile(havingPlan).sql;
assert(havingSql.includes('HAVING'), 'compiled SQL contains HAVING');
assert(havingSql.includes('> $'), 'HAVING uses parameterised comparison');

// ── 5. Time grain → date_trunc ───────────────────────────────────────────

const grainPlan = plan(
	{
		measures: ['flights.total_flights'],
		dimensions: ['flights.scheduled_departure'],
		time_grain: 'week',
		time_range: { start: '2026-03-01', end: '2026-04-01' },
	},
	travelRegistry,
	flightOpsScope,
);
const grainSql = compile(grainPlan).sql;
assert(grainSql.includes("date_trunc('week'"), "time_grain=week → date_trunc('week', ...)");

// ── 6. Bundle scope refusal ───────────────────────────────────────────────

expectError(
	() => plan({ measures: ['bookings.total_bookings'] as string[] }, travelRegistry, flightOpsScope),
	'out_of_bundle',
	'flight_ops cannot query bookings model (out_of_bundle)',
);

// ── 7. Disallowed join (cross-model where bundle has no edge) ─────────────

const noJoinScope: AgentScope = {
	bundleId: 'flights-ops-no-joins',
	bundleTables: new Set(['flights', 'flight_delays']),
	bundleJoins: [], // no joins declared
	timeFilters: [], // strip the bundle's time-filter requirement so we test the join failure cleanly
};
expectError(
	() =>
		plan(
			{
				measures: ['flights.total_flights'],
				dimensions: ['delays.delay_reason'],
			} as MetricQueryRequest,
			travelRegistry,
			noJoinScope,
		),
	'disallowed_join',
	'cross-model query with no allowed_joins → disallowed_join',
);

// ── 8a. Join orientation — reversed bundle join must not self-join ───────
// Reviewer R4 finding #2: if a bundle stores the join as
// "flight_delays.flight_id = flights.flight_id" and the planner picks
// "flights" as primary, a naive implementation would set rightAlias =
// flights, producing INNER JOIN "flights" AS "flights" ON … which is a
// duplicate-alias self-join. The planner must normalise so leftAlias is
// always the primary (already-FROMed) model.
const reversedJoinScope: AgentScope = {
	bundleId: 'flights-ops-reversed',
	bundleTables: new Set(['flights', 'flight_delays']),
	bundleJoins: [
		// Note: flight_delays appears on the left, flights on the right.
		{
			left: { schema: 'public', table: 'flight_delays', column: 'flight_id' },
			right: { schema: 'public', table: 'flights', column: 'flight_id' },
		},
	],
	timeFilters: [],
};

const reversedPlan = plan(
	{
		// One measure (flights), one dimension (delays). Triggers a join
		// without triggering fanout_refused (which only fires when measures
		// span multiple models). Lets us test orientation in isolation.
		measures: ['flights.total_flights'],
		dimensions: ['delays.delay_reason'],
	},
	travelRegistry,
	reversedJoinScope,
);
assertEqual(reversedPlan.joins.length, 1, 'one join planned');
const j = reversedPlan.joins[0];
assert(j.leftAlias !== j.rightAlias, 'reversed-orientation join: leftAlias != rightAlias (no self-join)');
assert(j.leftAlias === reversedPlan.models[0].alias, 'leftAlias is the primary (FROM) model');
const reversedSql = compile(reversedPlan).sql;
// Structural check: the JOIN target alias must differ from the FROM
// alias. A self-join from the orientation bug would produce
//   FROM "public"."flights" AS "flights"
//   INNER JOIN "public"."flights" AS "flights" ON …
// — same table, same alias on both sides.
const fromMatch = reversedSql.match(/FROM "[^"]+"\."([^"]+)" AS "([^"]+)"/);
const joinMatch = reversedSql.match(/INNER JOIN "[^"]+"\."([^"]+)" AS "([^"]+)"/);
assert(!!fromMatch && !!joinMatch, 'SQL has both FROM and JOIN clauses');
if (fromMatch && joinMatch) {
	assert(fromMatch[1] !== joinMatch[1], 'FROM table != JOIN table (no duplicate-table self-join)');
	assert(fromMatch[2] !== joinMatch[2], 'FROM alias != JOIN alias (no duplicate-alias)');
}

// ── 8. Fanout refusal — sums across one_to_many would double-count ────────

const fanoutScope: AgentScope = {
	bundleId: 'flights-ops-fanout',
	bundleTables: new Set(['flights', 'flight_delays']),
	bundleJoins: [
		{
			left: { schema: 'public', table: 'flights', column: 'flight_id' },
			right: { schema: 'public', table: 'flight_delays', column: 'flight_id' },
		},
	],
	timeFilters: [],
};
expectError(
	() =>
		plan(
			{
				// Asking for a sum/count from BOTH models across the join.
				measures: ['flights.total_flights', 'delays.total_delays'],
			} as MetricQueryRequest,
			travelRegistry,
			fanoutScope,
		),
	'fanout_refused',
	'cross-model non-distinct aggregation across one_to_many → fanout_refused',
);

// ── 9. Ambiguity regression — "delayed" can mean two different things ────

// Travel exposes flights.delayed_flights (snapshot: status='delayed') AND
// delays.total_delays (event-log row count). They are distinct
// measures with distinct refs and the planner must NOT silently substitute
// one for the other when the caller picks a specific one.
const snapshotResolved = travelRegistry.resolveMeasure('flights.delayed_flights');
assert(
	snapshotResolved.measure.aggregation === 'count' &&
		(snapshotResolved.measure.filters ?? []).some((f) => f.value === 'delayed'),
	'flights.delayed_flights resolves to the snapshot definition (status=delayed FILTER)',
);
const eventResolved = travelRegistry.resolveMeasure('delays.total_delays');
assert(eventResolved.model.name === 'delays', 'delays.total_delays resolves to the event-log model (different table)');
assert(
	snapshotResolved.model.table.table !== eventResolved.model.table.table,
	'two "delayed" interpretations live on different tables — substitution is impossible',
);

// ── 10. Non-travel fixture: same compiler runs end-to-end ─────────────────

const minimalPlan = plan(
	{
		measures: ['orders.paid_orders', 'orders.total_orders'],
		dimensions: ['orders.status'],
		time_range: { start: '2026-03-01', end: '2026-04-01' },
		limit: 50,
	},
	minimalRegistry,
	widgetScope,
);
const minimalSql = compile(minimalPlan).sql;
assert(minimalSql.includes('FROM "public"."orders"'), 'minimal scenario compiles against orders table');
assert(
	minimalSql.includes('FILTER (WHERE orders.status = $'),
	'measure-level filter in minimal compiles to FILTER WHERE',
);
assert(!minimalSql.includes('flights'), 'minimal SQL contains no travel terms (no leakage)');

// ── 11. Limit clamping ────────────────────────────────────────────────────

expectError(
	() =>
		plan(
			{
				measures: ['flights.total_flights'],
				time_range: { start: '2026-03-01', end: '2026-04-01' },
				limit: -1,
			},
			travelRegistry,
			flightOpsScope,
		),
	'invalid_value',
	'negative limit → invalid_value',
);

const bigPlan = plan(
	{
		measures: ['flights.total_flights'],
		time_range: { start: '2026-03-01', end: '2026-04-01' },
		limit: 1_000_000,
	},
	travelRegistry,
	flightOpsScope,
);
assert(bigPlan.limit <= 50_000, 'huge limit clamped to MAX_LIMIT');

// 11b. Time-filter requirement: omitting time_range on a bundle that
// requires it must fail with time_filter_required.
expectError(
	() => plan({ measures: ['flights.total_flights'] }, travelRegistry, flightOpsScope),
	'time_filter_required',
	'missing time_range on a time-required bundle → time_filter_required',
);

// 11c. Time-filter requirement: a window WIDER than max_days must fail.
// Reviewer R5 finding: previously the planner only checked filter
// presence, not the window width. Two-year window over a 90-day-max
// bundle must surface as time_filter_required with actual_days echoed.
expectError(
	() =>
		plan(
			{
				measures: ['flights.total_flights'],
				time_range: { start: '2024-01-01', end: '2026-01-01' }, // 731 days
			},
			travelRegistry,
			flightOpsScope,
		),
	'time_filter_required',
	'time window wider than max_days → time_filter_required (max_days enforced)',
);

// ── Report ─────────────────────────────────────────────────────────────────

console.log('Semantic compiler regression\n');
let failed = 0;
for (const r of results) {
	console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
	if (!r.ok) failed++;
}
if (failed > 0) {
	console.error(`\n${failed} assertion(s) failed`);
	process.exit(1);
}
console.log(`\n✅ All ${results.length} assertions passed`);

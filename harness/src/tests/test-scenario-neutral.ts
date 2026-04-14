/**
 * Scenario-neutrality regression.
 *
 * Proves that harness runtime code (signal dispatch, rule evaluation)
 * works against a non-travel scenario without any harness source
 * change. Also proves backward compatibility for the travel scenario.
 *
 * No database, no catalog, no MCP — pure loader + pure evaluator.
 * Safe to run under scripts/smoke-test.sh after the existing
 * test-query.ts and test-semantic-grounding.ts blocks.
 *
 * Usage (from harness/):
 *   npx tsx src/tests/test-scenario-neutral.ts
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ScenarioLoader, type BusinessRule } from '../config/index.js';
import { evaluateRule } from '../governance/rule-check.js';
import { bindSignalParams } from '../tools/event.js';

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

const HERE = dirname(fileURLToPath(import.meta.url));
const TRAVEL_PATH = resolve(HERE, '..', '..', '..', 'scenario', 'travel');
const MINIMAL_PATH = resolve(HERE, '..', '..', '..', 'scenario', '_fixtures', 'minimal');

// ── 1. Both scenarios load ─────────────────────────────────────────────────
const travel = new ScenarioLoader(TRAVEL_PATH);
const minimal = new ScenarioLoader(MINIMAL_PATH);

assert(travel.scenario.name === 'travel', 'travel scenario loads');
assertEqual(minimal.scenario.name, 'minimal', 'minimal (non-travel) scenario loads');

// ── 2. Signals are scenario-scoped ─────────────────────────────────────────
const travelSignals = travel.signals.map((s) => s.name).sort();
const minimalSignals = minimal.signals.map((s) => s.name).sort();

assert(
	travelSignals.join(',') === 'delay_patterns,event_distribution,failure_rates,step_durations',
	'travel signals are the four previously-hardcoded ones (now data)',
	`got: ${travelSignals.join(',')}`,
);
assertEqual(
	minimalSignals.join(','),
	'order_status_distribution,order_status_for_widget',
	'minimal signals are non-travel',
);
assert(
	!minimalSignals.includes('delay_patterns'),
	'minimal scenario does NOT inherit travel signals — no travel leakage',
);

// ── 3. Signal SQL templates use pg placeholders, not string interpolation ──
for (const s of travel.signals) {
	assert(
		!/\$\{|{{\s*\w+\s*}}/.test(s.sql),
		`travel signal "${s.name}" uses pg placeholders only (no string interpolation)`,
	);
}
for (const s of minimal.signals) {
	assert(
		!/\$\{|{{\s*\w+\s*}}/.test(s.sql),
		`minimal signal "${s.name}" uses pg placeholders only (no string interpolation)`,
	);
}

// ── 4. Rule evaluator: travel rules ────────────────────────────────────────
const travelRules = travel.businessRules;
const travelPiiColumns = new Set(Array.from(travel.getPiiColumns()).map((f) => f.split('.').pop() ?? f));

const revenueRule = travelRules.find((r) => r.name === 'revenue_excludes_cancelled');
assert(!!revenueRule, 'travel has revenue_excludes_cancelled rule');
if (revenueRule) {
	assert(!!revenueRule.check, 'revenue_excludes_cancelled has a `check` block (Phase 3 migration)');

	// Violates the rule — touches total_amount, does not filter cancelled.
	const bad = evaluateRule(revenueRule, {
		sql: 'SELECT SUM(total_amount) FROM public.bookings',
		resultSummary: '',
		piiColumnNames: travelPiiColumns,
	});
	assertEqual(bad.outcome.status, 'fail', 'revenue rule FAILS on SQL without cancelled filter');

	// Respects the rule.
	const good = evaluateRule(revenueRule, {
		sql: "SELECT SUM(total_amount) FROM public.bookings WHERE status <> 'cancelled'",
		resultSummary: '',
		piiColumnNames: travelPiiColumns,
	});
	assertEqual(good.outcome.status, 'pass', 'revenue rule PASSES on SQL filtering cancelled');

	// Does not apply — SQL touches neither total_amount nor revenue.
	const na = evaluateRule(revenueRule, {
		sql: 'SELECT COUNT(*) FROM public.flights',
		resultSummary: '',
		piiColumnNames: travelPiiColumns,
	});
	assertEqual(na.outcome.status, 'not_applicable', 'revenue rule is NOT APPLICABLE to unrelated SQL');
}

const piiRule = travelRules.find((r) => r.name === 'pii_customer_data');
assert(!!piiRule, 'travel has pii_customer_data rule');
if (piiRule) {
	const bad = evaluateRule(piiRule, {
		sql: 'SELECT first_name, email FROM public.customers',
		resultSummary: '',
		piiColumnNames: travelPiiColumns,
	});
	assertEqual(bad.outcome.status, 'fail', 'pii rule FAILS when SQL names blocked_columns');

	const good = evaluateRule(piiRule, {
		sql: 'SELECT loyalty_tier, COUNT(*) FROM public.customers GROUP BY loyalty_tier',
		resultSummary: '',
		piiColumnNames: travelPiiColumns,
	});
	assertEqual(good.outcome.status, 'pass', 'pii rule PASSES on aggregate SQL with no PII columns');
}

// ── 5. Rule evaluator: minimal rules (proves generic path, not travel-specific) ─
const minimalRules = minimal.businessRules;
const minimalPiiColumns = new Set(Array.from(minimal.getPiiColumns()).map((f) => f.split('.').pop() ?? f));

const widgetRevenueRule = minimalRules.find((r: BusinessRule) => r.name === 'widget_revenue_excludes_refunded');
assert(!!widgetRevenueRule, 'minimal has widget_revenue_excludes_refunded rule');
if (widgetRevenueRule) {
	const bad = evaluateRule(widgetRevenueRule, {
		sql: 'SELECT SUM(order_amount) FROM public.orders',
		piiColumnNames: minimalPiiColumns,
	});
	assertEqual(bad.outcome.status, 'fail', 'minimal widget-revenue rule FAILS without refunded filter');

	const good = evaluateRule(widgetRevenueRule, {
		sql: "SELECT SUM(order_amount) FROM public.orders WHERE status <> 'refunded'",
		piiColumnNames: minimalPiiColumns,
	});
	assertEqual(good.outcome.status, 'pass', 'minimal widget-revenue rule PASSES when filtering refunded');
}

const widgetPiiRule = minimalRules.find((r: BusinessRule) => r.name === 'widget_pii_blocked');
assert(!!widgetPiiRule, 'minimal has widget_pii_blocked rule');
if (widgetPiiRule) {
	const bad = evaluateRule(widgetPiiRule, {
		sql: 'SELECT customer_email FROM public.customers',
		piiColumnNames: minimalPiiColumns,
	});
	assertEqual(bad.outcome.status, 'fail', 'minimal pii rule FAILS on customer_email (minimal-specific column)');
}

const widgetEuRule = minimalRules.find((r: BusinessRule) => r.name === 'widget_eu_export_manual');
assert(!!widgetEuRule, 'minimal has widget_eu_export_manual rule');
if (widgetEuRule) {
	const out = evaluateRule(widgetEuRule, { sql: 'anything', piiColumnNames: minimalPiiColumns });
	assertEqual(
		out.outcome.status,
		'manual',
		'rule without `check` block reports manual-verification-needed (not silent pass)',
	);
}

// ── 6. Event schema is scenario-scoped (Fix #1) ────────────────────────────
const travelEvents = travel.eventSchema;
const minimalEvents = minimal.eventSchema;

assert(!!travelEvents, 'travel has an event schema');
assert(!!minimalEvents, 'minimal has an event schema');
if (travelEvents && minimalEvents) {
	const travelKeys = travelEvents.correlation_keys
		.map((k) => k.name)
		.sort()
		.join(',');
	const minimalKeys = minimalEvents.correlation_keys
		.map((k) => k.name)
		.sort()
		.join(',');
	assertEqual(travelKeys, 'booking_id,customer_id,flight_id,ticket_id', 'travel correlation keys');
	assertEqual(minimalKeys, 'order_id,widget_id', 'minimal correlation keys (no travel leakage)');
	assert(
		!minimalEvents.correlation_keys.some((k) => k.name === 'booking_id' || k.name === 'flight_id'),
		'minimal event schema does NOT inherit travel correlation keys',
	);
}

// ── 7. Optional signal params: omitted + no default = NULL (Fix #2) ────────
const optionalSignal = minimal.signals.find((s) => s.name === 'order_status_for_widget');
assert(!!optionalSignal, 'minimal has order_status_for_widget signal');
if (optionalSignal) {
	const widget = optionalSignal.params.find((p) => p.name === 'widget_id');
	assert(!!widget, 'order_status_for_widget declares widget_id param');
	assert(widget?.required === false, 'widget_id is optional');
	assert(widget?.default === undefined, 'widget_id has no default');
	// Direct binder exercise: omitted + no default = bind SQL NULL.
	const bound = bindSignalParams(optionalSignal, {});
	if ('error' in bound) {
		assert(false, 'bindSignalParams errored on omitted optional param — Fix #2 regression', bound.error);
	} else {
		assertEqual(bound.values.length, 1, 'one placeholder bound');
		assertEqual(bound.values[0], null, 'omitted optional param binds SQL NULL (Fix #2)');
	}
	// Providing the value still works.
	const boundProvided = bindSignalParams(optionalSignal, { widget_id: 42 });
	if ('error' in boundProvided) {
		assert(false, 'bindSignalParams errored with a provided int', boundProvided.error);
	} else {
		assertEqual(boundProvided.values[0], 42, 'provided int binds through normally');
	}
}

// ── 8. Travel rule does NOT apply to minimal SQL (no leakage) ──────────────
if (revenueRule) {
	const out = evaluateRule(revenueRule, {
		sql: 'SELECT SUM(order_amount) FROM public.orders', // minimal-shaped SQL
		piiColumnNames: minimalPiiColumns,
	});
	assertEqual(
		out.outcome.status,
		'not_applicable',
		'travel revenue rule is NOT APPLICABLE to non-travel (order_amount) SQL — gate works',
	);
}

// ── Report ─────────────────────────────────────────────────────────────────
console.log('Scenario-neutrality test\n');
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

/**
 * Regression test — Tier 1 semantic-layer plumbing.
 *
 * Purpose
 * -------
 * Prevents the specific failure class that prompted this tier:
 *   - Sub-agent LLM writing SQL against fake CTE aliases like `base_flights`.
 *   - Sub-agent LLM writing SQL against fabricated columns like `created_at`.
 *
 * Strategy
 * --------
 * The test does NOT invoke the LLM. It exercises the pure prompt builder with
 * fixture data that mirrors what `initialize_agent` + `get_entity_details` +
 * `get_business_rules` return. It then asserts that the resulting system
 * prompt carries:
 *   - every real column from the fixture (name + type),
 *   - the exact real column the LLM should use for dates (scheduled_departure
 *     for flights, booking_date for bookings),
 *   - the governed measures / dimensions / allowed_joins from the scope,
 *   - the guidance field on business rules (not just the description),
 *   - an explicit anti-hallucination hint ("base_flights") so we can prove
 *     the rule that forbids CTE-as-table-name made it into context.
 *
 * If anything in runSubagentStep ever drops semantic-layer fields again, this
 * test breaks first.
 *
 * Usage:
 *   npx tsx src/test-semantic-grounding.ts
 */

import type { EntityDetails } from './harness-client.js';
import { buildSubagentSystemPrompt } from './workflows/deep-agent/sub-agent-prompt.js';

interface Assertion {
	ok: boolean;
	label: string;
	detail?: string;
}

const results: Assertion[] = [];

function assertContains(prompt: string, needle: string, label: string): void {
	results.push({
		ok: prompt.includes(needle),
		label,
		detail: prompt.includes(needle) ? undefined : `missing substring: ${JSON.stringify(needle)}`,
	});
}

function assertAbsent(prompt: string, needle: string, label: string): void {
	results.push({
		ok: !prompt.includes(needle),
		label,
		detail: prompt.includes(needle) ? `unexpectedly present: ${JSON.stringify(needle)}` : undefined,
	});
}

// ── Fixtures: shapes match harness responses ────────────────────────────────

const flightsEntity: EntityDetails = {
	name: 'flights',
	fqn: 'public.flights',
	description: 'Flight schedules, delays, cancellations.',
	columns: [
		{ name: 'flight_id', type: 'integer', pii: false },
		{ name: 'flight_number', type: 'varchar', pii: false },
		{ name: 'airline_code', type: 'varchar', pii: false },
		{ name: 'origin', type: 'varchar', pii: false },
		{ name: 'destination', type: 'varchar', pii: false },
		{ name: 'scheduled_departure', type: 'timestamp', pii: false },
		{ name: 'scheduled_arrival', type: 'timestamp', pii: false },
		{ name: 'actual_departure', type: 'timestamp', pii: false },
		{ name: 'status', type: 'varchar', pii: false },
	],
};

const customersEntity: EntityDetails = {
	name: 'customers',
	fqn: 'public.customers',
	description: 'Customer profiles (PII sensitive).',
	columns: [
		{ name: 'customer_id', type: 'integer', pii: false },
		{ name: 'first_name', type: 'varchar', pii: true },
		{ name: 'last_name', type: 'varchar', pii: true },
		{ name: 'email', type: 'varchar', pii: true },
		{ name: 'loyalty_tier', type: 'varchar', pii: false },
	],
};

// Deliberately simulate a catalog hiccup for one table — builder must NOT
// explode and must still produce a usable prompt for the rest.
const degradedEntity: EntityDetails = {
	name: 'flight_delays',
	fqn: 'public.flight_delays',
	columns: [],
	error: 'simulated catalog timeout',
};

const flightsOpsPrompt = buildSubagentSystemPrompt({
	basePrompt: 'You are the Flight Operations Agent.',
	maxRows: 500,
	scope: {
		tables: ['public.flights', 'public.flight_delays'],
		measures: ['flights.delayed_flights', 'flights.total_flights'],
		dimensions: ['flights.airline_code', 'flights.origin'],
		allowedJoins: ['flights.origin = airports.airport_code'],
		blockedColumns: [],
	},
	entityDetails: [flightsEntity, degradedEntity],
	rules: [
		{
			severity: 'error',
			name: 'checkin_window',
			description: 'Check-in cuts off 45 minutes before scheduled_departure.',
			guidance: 'Compare now() against scheduled_departure - interval 45 minutes.',
			rationale: 'Ops SLA: ground staff need 45 minutes to finalise.',
		},
	],
});

const customerPrompt = buildSubagentSystemPrompt({
	basePrompt: 'You are the Customer Service Agent.',
	maxRows: 500,
	scope: {
		tables: ['public.customers'],
		measures: ['customers.customers_by_tier'],
		dimensions: ['customers.loyalty_tier'],
		allowedJoins: [],
		blockedColumns: ['first_name', 'last_name', 'email', 'phone'],
	},
	entityDetails: [customersEntity],
	rules: [],
});

// ── Assertions: flight_ops prompt carries the semantic layer ────────────────

assertContains(flightsOpsPrompt, 'public.flights', 'FQN present for flights');
assertContains(flightsOpsPrompt, 'scheduled_departure timestamp', 'real date column with type');
assertContains(flightsOpsPrompt, 'flight_number varchar', 'flight_number with type');
assertContains(flightsOpsPrompt, 'flights.delayed_flights', 'measure carried over from scope');
assertContains(flightsOpsPrompt, 'flights.airline_code', 'dimension carried over from scope');
assertContains(flightsOpsPrompt, 'flights.origin = airports.airport_code', 'allowed join carried over from scope');
assertContains(flightsOpsPrompt, 'guidance:    Compare now()', 'rule guidance (not just description)');
assertContains(flightsOpsPrompt, 'rationale:   Ops SLA', 'rule rationale forwarded');
assertContains(flightsOpsPrompt, 'base_flights', 'anti-hallucination hint mentions base_flights literally');
assertContains(flightsOpsPrompt, 'details unavailable', 'degraded entity surfaces fallback message, not a crash');

// ── Assertions: customer_service prompt enforces PII markers ────────────────

assertContains(customerPrompt, 'first_name varchar [PII — blocked]', 'PII column marked inline');
assertContains(customerPrompt, 'email varchar [PII — blocked]', 'PII email marked inline');
assertContains(customerPrompt, 'PII columns — globally blocked', 'blocked_columns section present');
assertAbsent(customerPrompt, 'You are the Flight Operations Agent.', 'no base-prompt bleed between agents');

// ── Assertions: invariant properties of every emitted prompt ────────────────

for (const [label, prompt] of [
	['flight_ops', flightsOpsPrompt] as const,
	['customer_service', customerPrompt] as const,
]) {
	assertContains(prompt, 'Authoritative schema from the catalog', `${label}: schema section present`);
	assertContains(prompt, 'Query discipline', `${label}: discipline section present`);
	assertContains(prompt, 'Max rows: 500', `${label}: max-rows constraint carried`);
	assertAbsent(prompt, 'Tables: none', `${label}: no stale "Tables: none" fallback`);
	// Regression for the exact hallucinated column we saw in orch-deep-2
	assertAbsent(prompt, 'created_at timestamp', `${label}: does not advertise a fake created_at column`);
}

// ── Report ─────────────────────────────────────────────────────────────────

console.log('Semantic-grounding plumbing test\n');
let failed = 0;
for (const r of results) {
	const mark = r.ok ? '✓' : '✗';
	console.log(`  ${mark} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
	if (!r.ok) failed++;
}
if (failed > 0) {
	console.error(`\n${failed} assertion(s) failed`);
	process.exit(1);
}
console.log(`\n✅ All ${results.length} assertions passed`);

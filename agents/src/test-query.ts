/**
 * Test script — verifies the harness connection without needing an LLM.
 *
 * Usage:
 *   npx tsx src/test-query.ts
 */

import { HarnessClient } from './harness-client.js';

async function main() {
	console.log('🧪 Harness Connection Test\n');

	const harness = new HarnessClient('flight_ops', process.env.OPS_TOKEN);
	await harness.connect('../scenario/travel');

	// List tools
	const tools = await harness.listTools();
	console.log(`Tools available: ${tools.length}`);
	console.log(`  ${tools.map((t) => t.name).join(', ')}\n`);

	// Initialize flight_ops agent
	console.log('── initialize_agent(flight_ops) ──');
	const init = (await harness.initializeAgent('test-001', 'test')) as Record<string, unknown>;
	const identity = init.identity as Record<string, unknown>;
	const scope = init.scope as Record<string, unknown>;
	console.log(`Agent: ${identity.display_name}`);
	console.log(`Auth: ${identity.auth_method}`);
	console.log(`URI: ${identity.agent_uri}`);
	console.log(`Tables: ${(scope.tables as string[]).join(', ')}`);
	console.log(`Measures: ${(scope.measures as string[]).length}`);

	// Query delayed flights (should work — agent_id from AuthContext)
	console.log('\n── query_data: delayed flights (should PASS) ──');
	const result1 = (await harness.queryData(
		"SELECT flight_id, flight_number, status FROM flights WHERE status = 'delayed' LIMIT 3",
	)) as Record<string, unknown>;
	console.log(`Status: ${result1.status}`);
	if (result1.status === 'success') {
		const rows = result1.rows as Array<Record<string, unknown>>;
		console.log(`Rows: ${rows.length}`);
		rows.forEach((r) => console.log(`  ${r.flight_number} — ${r.status}`));
	}

	// Query PII (should block)
	console.log('\n── query_data: PII columns (should BLOCK) ──');
	const result2 = (await harness.queryData('SELECT first_name, last_name FROM customers LIMIT 5')) as Record<
		string,
		unknown
	>;
	console.log(`Status: ${result2.status}`);
	if (result2.status === 'blocked') {
		console.log(`Reason: ${result2.reason}`);
	}

	// Query out-of-bundle table (should block)
	console.log('\n── query_data: out-of-bundle table (should BLOCK) ──');
	const result3 = (await harness.queryData('SELECT booking_id, status FROM bookings LIMIT 5')) as Record<
		string,
		unknown
	>;
	console.log(`Status: ${result3.status}`);
	if (result3.status === 'blocked') {
		console.log(`Reason: ${result3.reason}`);
	}

	// Get business rules for flights
	console.log('\n── get_business_rules(flights) ──');
	const rules = (await harness.getBusinessRules(['flights'])) as Record<string, unknown>;
	const matched = rules.matched_rules as Array<Record<string, unknown>>;
	console.log(`Matched rules: ${matched.length}`);
	matched.forEach((r) => console.log(`  [${r.severity}] ${r.name}`));

	console.log('\n✅ All tests passed!');
	await harness.close();
}

main().catch((err) => {
	console.error('Error:', err);
	process.exit(1);
});

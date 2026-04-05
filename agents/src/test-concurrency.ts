/**
 * Phase 1a concurrency test — the critical verification for HTTP transport.
 *
 * Opens two HarnessClient connections AS TWO DIFFERENT AGENTS in parallel,
 * runs governance-sensitive queries concurrently, and asserts that each
 * agent only sees its own identity. Any cross-contamination would mean the
 * per-session AuthContext map is broken and agents could see each other's
 * data.
 *
 * Expected:
 *   - flight_ops sees flights tables, BLOCKED on bookings table
 *   - booking sees bookings tables, BLOCKED on flights table
 *   - Neither ever sees the other's identity
 *
 * Usage:
 *   # Start the harness as a long-lived HTTP server in one terminal:
 *   HARNESS_ALLOW_INSECURE_CONFIG_ONLY=true HARNESS_TRANSPORT=http \
 *     SCENARIO_PATH=../scenario/travel npx tsx src/server.ts
 *
 *   # Run the concurrency test in another:
 *   npx tsx agents/src/test-concurrency.ts
 */

import { HarnessClient } from './harness-client.js';
import { runWithRootSpan } from './tracing.js';

interface TestResult {
	agentId: string;
	initIdentity: string;
	queryStatus: string;
	crossBundleStatus: string;
	crossBundleBlockedReason: string | undefined;
}

async function runAgent(agentId: string, ownQuery: string, crossQuery: string, sessionId: string): Promise<TestResult> {
	const harness = new HarnessClient(agentId);
	await harness.connect();

	const init = (await harness.initializeAgent(sessionId, 'concurrency test')) as {
		identity?: { agent_id?: string };
		error?: string;
	};
	if (init.error) throw new Error(`${agentId} init failed: ${init.error}`);

	const ownResult = (await harness.queryData(ownQuery)) as { status: string };
	const crossResult = (await harness.queryData(crossQuery)) as { status: string; reason?: string };

	await harness.close();

	return {
		agentId,
		initIdentity: init.identity?.agent_id ?? 'MISSING',
		queryStatus: ownResult.status,
		crossBundleStatus: crossResult.status,
		crossBundleBlockedReason: crossResult.reason,
	};
}

async function main(): Promise<void> {
	console.log('🔀 Phase 1a Concurrency Test\n');

	await runWithRootSpan('dazense-test-concurrency', 'test.concurrency', {}, async () => {
		// Run both agents truly in parallel via Promise.all — they share the same
		// harness process but MUST NOT share identity state.
		const [flightResult, bookingResult] = await Promise.all([
			runAgent(
				'flight_ops',
				"SELECT flight_id, flight_number FROM flights WHERE status = 'delayed' LIMIT 2",
				'SELECT booking_id FROM bookings LIMIT 1',
				'conc-test-flight-1',
			),
			runAgent(
				'booking',
				'SELECT booking_id, status FROM bookings LIMIT 2',
				'SELECT flight_id FROM flights LIMIT 1',
				'conc-test-booking-1',
			),
		]);

		// Assertions
		const failures: string[] = [];

		console.log('── flight_ops session ──');
		console.log(`  init identity:      ${flightResult.initIdentity}`);
		console.log(`  own query:          ${flightResult.queryStatus}`);
		console.log(`  cross-bundle query: ${flightResult.crossBundleStatus}`);
		if (flightResult.crossBundleBlockedReason) {
			console.log(`  cross-bundle reason: ${flightResult.crossBundleBlockedReason.slice(0, 80)}...`);
		}
		if (flightResult.initIdentity !== 'flight_ops') {
			failures.push(`flight_ops session reported wrong identity: "${flightResult.initIdentity}"`);
		}
		if (flightResult.queryStatus !== 'success') {
			failures.push(`flight_ops should succeed on own bundle query, got "${flightResult.queryStatus}"`);
		}
		if (flightResult.crossBundleStatus !== 'blocked') {
			failures.push(`flight_ops should be BLOCKED on bookings query, got "${flightResult.crossBundleStatus}"`);
		}

		console.log('\n── booking session ──');
		console.log(`  init identity:      ${bookingResult.initIdentity}`);
		console.log(`  own query:          ${bookingResult.queryStatus}`);
		console.log(`  cross-bundle query: ${bookingResult.crossBundleStatus}`);
		if (bookingResult.crossBundleBlockedReason) {
			console.log(`  cross-bundle reason: ${bookingResult.crossBundleBlockedReason.slice(0, 80)}...`);
		}
		if (bookingResult.initIdentity !== 'booking') {
			failures.push(`booking session reported wrong identity: "${bookingResult.initIdentity}"`);
		}
		if (bookingResult.queryStatus !== 'success') {
			failures.push(`booking should succeed on own bundle query, got "${bookingResult.queryStatus}"`);
		}
		if (bookingResult.crossBundleStatus !== 'blocked') {
			failures.push(`booking should be BLOCKED on flights query, got "${bookingResult.crossBundleStatus}"`);
		}

		console.log('\n── Result ──');
		if (failures.length === 0) {
			console.log('✅ PASS — each agent sees only its own identity and bundle scope');
		} else {
			console.log('❌ FAIL — identity isolation broken:');
			for (const f of failures) console.log(`   - ${f}`);
			process.exitCode = 1;
		}
	});
}

main().catch((err) => {
	console.error('Error:', err);
	process.exit(1);
});

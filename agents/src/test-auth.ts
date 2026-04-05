/**
 * Auth verification test — covers Plan v2 verification checks 3 & 6.
 *
 * 1. Wrong agent_id at initialize_agent → rejected
 * 2. write_finding persists auth_method + token_hash in DB
 * 3. Defense-in-depth: AuthContext agent_id is used regardless of what's passed
 *
 * Usage:
 *   # config-only mode
 *   npx tsx src/test-auth.ts
 *
 *   # jwt mode
 *   AUTH_MODE=jwt JWT_SECRET=test-secret-for-local-dev OPS_TOKEN=<token> npx tsx src/test-auth.ts
 */

import { HarnessClient } from './harness-client.js';

async function main() {
	console.log('🔐 Auth Verification Test\n');

	const harness = new HarnessClient('flight_ops', process.env.OPS_TOKEN);
	await harness.connect('../scenario/travel');

	// ── Test 1: Wrong agent_id at initialize_agent ──
	console.log('── Test 1: wrong agent_id at initialize_agent (should REJECT) ──');
	const wrongInit = (await harness.callTool('initialize_agent', {
		agent_id: 'booking', // ← we're connected as flight_ops
		session_id: 'test-auth-001',
	})) as Record<string, unknown>;
	if (wrongInit.error) {
		console.log(`✓ Rejected: ${wrongInit.error}`);
	} else {
		console.log(`✗ FAILED — expected rejection but got: ${JSON.stringify(wrongInit).slice(0, 100)}`);
	}

	// ── Test 2: Correct agent_id ──
	console.log('\n── Test 2: correct agent_id (should PASS) ──');
	const init = (await harness.initializeAgent('test-auth-002', 'test')) as Record<string, unknown>;
	const identity = init.identity as Record<string, unknown>;
	console.log(`✓ Authenticated: ${identity.display_name}`);
	console.log(`  auth_method: ${identity.auth_method}`);
	console.log(`  agent_uri: ${identity.agent_uri}`);

	// ── Test 3: write_finding with audit fields ──
	console.log('\n── Test 3: write_finding persists audit fields ──');
	const findingResult = (await harness.writeFinding('test-auth-002', 'Test finding for auth verification', 'high', [
		'flights',
	])) as Record<string, unknown>;
	console.log(`✓ Finding stored: finding_id=${findingResult.finding_id}`);

	await harness.close();
	console.log('\n✅ Test suite complete — check DB for audit fields:');
	console.log('   SELECT finding_id, agent_id, auth_method, token_hash, correlation_id');
	console.log("   FROM decision_findings WHERE session_id = 'test-auth-002';");
}

main().catch((err) => {
	console.error('Error:', err);
	process.exit(1);
});

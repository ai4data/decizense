/**
 * Phase 2a OPA equivalence battery — agents/src/test-opa-equivalence.ts
 *
 * Runs ~30 SQL queries against a running harness in SHADOW MODE
 * (HARNESS_TRANSPORT=http + OPA_ENABLED=true + OPA_SHADOW=true). For each
 * case:
 *
 *   1. the test asserts the in-code governance result matches the EXPECTED
 *      outcome (this guards against accidental regression)
 *   2. the harness shadow hook writes any in-code vs. OPA disagreement to
 *      stderr as "[opa-shadow] MISMATCH ..."
 *
 * The verify-phase-2a.sh wrapper then greps the harness stderr log for
 * any MISMATCH lines — zero mismatches is the Phase 2a gate.
 *
 * The battery covers EVERY governance check in
 * harness/src/governance/index.ts plus a set of allow cases per agent:
 *
 *   - can_query            (orchestrator cannot query)
 *   - read_only            (UPDATE / DELETE / DROP / INSERT)
 *   - single_statement     (two statements separated by ;)
 *   - bundle_scope         (out-of-bundle table per agent)
 *   - join_allowlist       (unauthorized JOIN condition)
 *   - pii_check            (direct column name, SELECT *)
 *   - limit_check          (missing LIMIT, LIMIT > max_rows)
 *   - valid allow cases    (each domain agent, in-scope query with LIMIT)
 *
 * Prerequisites (enforced by verify-phase-2a.sh):
 *   - travel_postgres running on :5433
 *   - OPA sidecar running on :8181
 *   - harness running as HTTP transport on :9080 with:
 *       OPA_ENABLED=true
 *       OPA_SHADOW=true
 *       HARNESS_ALLOW_INSECURE_CONFIG_ONLY=true  (so X-Agent-Id is trusted)
 *
 * Usage:
 *   npx tsx agents/src/test-opa-equivalence.ts
 */

import { HarnessClient } from './harness-client.js';

type AgentId = 'flight_ops' | 'booking' | 'customer_service' | 'orchestrator' | 'unknown_agent_xyz';

interface Case {
	id: string;
	agent: AgentId;
	sql: string;
	expected: 'allow' | 'block';
	/** If expected is "block", the test asserts the in-code reason mentions this substring. */
	expectedReasonSubstring?: string;
	note: string;
}

const cases: Case[] = [
	// ─── ALLOW: valid in-scope queries per agent ────────────────────────────
	{
		id: 'allow.flight_ops.basic',
		agent: 'flight_ops',
		sql: "SELECT flight_id, flight_number, status FROM flights WHERE status = 'delayed' LIMIT 10",
		expected: 'allow',
		note: 'flight_ops query on in-scope flights table with LIMIT',
	},
	{
		id: 'allow.flight_ops.airports',
		agent: 'flight_ops',
		sql: 'SELECT airport_code, name FROM airports LIMIT 25',
		expected: 'allow',
		note: 'flight_ops query on airports (in-bundle)',
	},
	{
		id: 'allow.flight_ops.join',
		agent: 'flight_ops',
		sql: 'SELECT f.flight_id, a.name FROM flights f JOIN airports a ON f.origin = a.airport_code LIMIT 5',
		expected: 'allow',
		note: 'flight_ops allowed join (flights.origin = airports.airport_code)',
	},
	{
		id: 'allow.flight_ops.delays_join',
		agent: 'flight_ops',
		sql: 'SELECT d.delay_minutes FROM flight_delays d JOIN flights f ON d.flight_id = f.flight_id LIMIT 5',
		expected: 'allow',
		note: 'flight_ops allowed join (flight_delays.flight_id = flights.flight_id)',
	},
	{
		id: 'allow.booking.basic',
		agent: 'booking',
		sql: 'SELECT booking_id, status FROM bookings LIMIT 10',
		expected: 'allow',
		note: 'booking query on in-scope bookings',
	},
	{
		id: 'allow.booking.join',
		agent: 'booking',
		sql: 'SELECT t.ticket_id, b.status FROM tickets t JOIN bookings b ON t.booking_id = b.booking_id LIMIT 5',
		expected: 'allow',
		note: 'booking allowed join tickets↔bookings',
	},
	{
		id: 'allow.booking.payments_join',
		agent: 'booking',
		sql: 'SELECT p.amount FROM payments p JOIN bookings b ON p.booking_id = b.booking_id LIMIT 5',
		expected: 'allow',
		note: 'booking allowed join payments↔bookings',
	},
	{
		id: 'allow.customer_service.nonpii',
		agent: 'customer_service',
		sql: 'SELECT customer_id, loyalty_tier FROM customers LIMIT 20',
		expected: 'allow',
		note: 'customer_service allowed (non-PII columns only)',
	},

	// ─── BLOCK: bundle scope ────────────────────────────────────────────────
	{
		id: 'block.bundle_scope.flight_ops_reads_bookings',
		agent: 'flight_ops',
		sql: 'SELECT booking_id FROM bookings LIMIT 5',
		expected: 'block',
		expectedReasonSubstring: 'bundle',
		note: 'flight_ops cannot read bookings table',
	},
	{
		id: 'block.bundle_scope.booking_reads_flights',
		agent: 'booking',
		sql: 'SELECT flight_id FROM flights LIMIT 5',
		expected: 'block',
		expectedReasonSubstring: 'bundle',
		note: 'booking cannot read flights table directly',
	},
	{
		id: 'block.bundle_scope.customer_reads_payments',
		agent: 'customer_service',
		sql: 'SELECT amount FROM payments LIMIT 5',
		expected: 'block',
		expectedReasonSubstring: 'bundle',
		note: 'customer_service cannot read payments table',
	},

	// ─── BLOCK: PII (explicit columns) ──────────────────────────────────────
	{
		id: 'block.pii.first_name',
		agent: 'customer_service',
		sql: 'SELECT first_name FROM customers LIMIT 10',
		expected: 'block',
		expectedReasonSubstring: 'PII',
		note: 'explicit first_name column blocked',
	},
	{
		id: 'block.pii.email_phone',
		agent: 'customer_service',
		sql: 'SELECT email, phone FROM customers LIMIT 10',
		expected: 'block',
		expectedReasonSubstring: 'PII',
		note: 'explicit email + phone blocked',
	},
	{
		id: 'block.pii.last_name',
		agent: 'customer_service',
		sql: 'SELECT last_name, tier FROM customers LIMIT 10',
		expected: 'block',
		expectedReasonSubstring: 'PII',
		note: 'mix of PII and non-PII columns — still blocked',
	},

	// ─── BLOCK: PII via SELECT * on a PII-bearing table ────────────────────
	{
		id: 'block.pii.select_star_customers',
		agent: 'customer_service',
		sql: 'SELECT * FROM customers LIMIT 5',
		expected: 'block',
		expectedReasonSubstring: 'PII',
		note: 'SELECT * on customers is blocked',
	},

	// ─── BLOCK: missing LIMIT ──────────────────────────────────────────────
	{
		id: 'block.limit.missing',
		agent: 'flight_ops',
		sql: 'SELECT flight_id FROM flights',
		expected: 'block',
		expectedReasonSubstring: 'LIMIT',
		note: 'no LIMIT clause',
	},
	{
		id: 'block.limit.missing.booking',
		agent: 'booking',
		sql: 'SELECT booking_id FROM bookings',
		expected: 'block',
		expectedReasonSubstring: 'LIMIT',
		note: 'no LIMIT clause (booking)',
	},

	// ─── BLOCK: LIMIT above max_rows ────────────────────────────────────────
	{
		id: 'block.limit.too_large',
		agent: 'flight_ops',
		sql: 'SELECT flight_id FROM flights LIMIT 5000',
		expected: 'block',
		expectedReasonSubstring: 'exceeds',
		note: 'LIMIT 5000 > max_rows 500',
	},

	// ─── BLOCK: multi-statement ────────────────────────────────────────────
	{
		id: 'block.multi_statement',
		agent: 'flight_ops',
		sql: 'SELECT flight_id FROM flights LIMIT 1; SELECT flight_id FROM flights LIMIT 1',
		expected: 'block',
		expectedReasonSubstring: 'statements',
		note: 'two statements separated by ;',
	},

	// ─── BLOCK: write operations ──────────────────────────────────────────
	{
		id: 'block.write.delete',
		agent: 'flight_ops',
		sql: "DELETE FROM flights WHERE flight_id = 'F9999'",
		expected: 'block',
		expectedReasonSubstring: 'Write',
		note: 'DELETE is not read-only',
	},
	{
		id: 'block.write.update',
		agent: 'booking',
		sql: "UPDATE bookings SET status = 'cancelled' WHERE booking_id = 'B1'",
		expected: 'block',
		expectedReasonSubstring: 'Write',
		note: 'UPDATE is not read-only',
	},
	{
		id: 'block.write.drop',
		agent: 'flight_ops',
		sql: 'DROP TABLE flights',
		expected: 'block',
		expectedReasonSubstring: 'Write',
		note: 'DROP is not read-only',
	},
	{
		id: 'block.write.insert',
		agent: 'booking',
		sql: "INSERT INTO bookings (booking_id) VALUES ('X1')",
		expected: 'block',
		expectedReasonSubstring: 'Write',
		note: 'INSERT is not read-only',
	},

	// ─── BLOCK: join not in bundle allowlist ───────────────────────────────
	{
		id: 'block.join.not_allowlisted',
		agent: 'flight_ops',
		sql: 'SELECT f.flight_id FROM flights f JOIN airports a ON f.airline_code = a.airport_code LIMIT 5',
		expected: 'block',
		expectedReasonSubstring: 'allowlist',
		note: 'flights.airline_code = airports.airport_code is not a bundle join',
	},

	// ─── BLOCK: unknown agent (authenticate check) ────────────────────────
	{
		id: 'block.authenticate.unknown_agent',
		agent: 'unknown_agent_xyz',
		sql: 'SELECT 1 LIMIT 1',
		expected: 'block',
		expectedReasonSubstring: 'Unknown agent',
		note: 'agent not in agents.yml → blocked at authenticate',
	},

	// ─── BLOCK: orchestrator cannot query (can_query check) ────────────────
	{
		id: 'block.can_query.orchestrator',
		agent: 'orchestrator',
		sql: 'SELECT flight_id FROM flights LIMIT 10',
		expected: 'block',
		expectedReasonSubstring: 'cannot execute',
		note: 'orchestrator role has can_query=false',
	},

	// ─── BLOCK: PII column in WHERE clause (not just SELECT) ──────────────
	{
		id: 'block.pii.where_clause',
		agent: 'customer_service',
		sql: "SELECT customer_id FROM customers WHERE email = 'test@example.com' LIMIT 10",
		expected: 'block',
		expectedReasonSubstring: 'PII',
		note: 'PII column in WHERE clause is still blocked',
	},

	// ─── BLOCK: LIMIT exceeds max_rows (different value from earlier case) ─
	{
		id: 'block.limit.over_max_999',
		agent: 'booking',
		sql: 'SELECT booking_id FROM bookings LIMIT 999',
		expected: 'block',
		expectedReasonSubstring: 'exceeds',
		note: 'LIMIT 999 > max_rows 500',
	},
];

interface CaseResult {
	id: string;
	agent: AgentId;
	expected: 'allow' | 'block';
	actual: 'allow' | 'block' | 'error';
	reason?: string;
	pass: boolean;
	detail?: string;
}

const TOKEN_ENV: Record<AgentId, string> = {
	flight_ops: 'OPS_TOKEN',
	booking: 'BOOKING_TOKEN',
	customer_service: 'CUSTOMER_TOKEN',
	orchestrator: 'ORCHESTRATOR_TOKEN',
	unknown_agent_xyz: '', // no token — config-only mode trusts X-Agent-Id header
};

async function runCase(c: Case): Promise<CaseResult> {
	const token = process.env[TOKEN_ENV[c.agent]];
	const harness = new HarnessClient(c.agent, token);
	try {
		await harness.connect();
		await harness.initializeAgent(`opa-equiv-${c.id}`, 'equivalence test');
		const res = (await harness.queryData(c.sql, 'OPA equivalence test')) as Record<string, unknown>;
		const status = res.status as string;
		const reason = res.reason as string | undefined;

		const actual: 'allow' | 'block' | 'error' =
			status === 'success' ? 'allow' : status === 'blocked' ? 'block' : 'error';

		let pass = actual === c.expected;
		let detail: string | undefined;
		if (pass && c.expected === 'block' && c.expectedReasonSubstring) {
			if (!reason || !reason.toLowerCase().includes(c.expectedReasonSubstring.toLowerCase())) {
				pass = false;
				detail = `reason "${reason ?? '(none)'}" missing substring "${c.expectedReasonSubstring}"`;
			}
		}

		return { id: c.id, agent: c.agent, expected: c.expected, actual, reason, pass, detail };
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		// Transport-level rejections (e.g. unknown agent, auth failure) are
		// still valid "block" outcomes — the agent WAS denied access, just at
		// a layer before governance. Count them as block when the error text
		// matches the expected reason substring.
		const isTransportBlock =
			c.expected === 'block' &&
			!!c.expectedReasonSubstring &&
			errMsg.toLowerCase().includes(c.expectedReasonSubstring.toLowerCase());
		return {
			id: c.id,
			agent: c.agent,
			expected: c.expected,
			actual: isTransportBlock ? 'block' : 'error',
			reason: errMsg,
			pass: isTransportBlock,
			detail: isTransportBlock ? undefined : errMsg,
		};
	} finally {
		try {
			await harness.close();
		} catch {
			/* ignore */
		}
	}
}

async function main(): Promise<void> {
	console.log(`🧪 OPA Equivalence Battery — ${cases.length} cases\n`);

	const results: CaseResult[] = [];
	for (const c of cases) {
		const r = await runCase(c);
		results.push(r);
		const marker = r.pass ? '✓' : '✗';
		console.log(`  ${marker} ${r.id.padEnd(40)} expected=${r.expected} actual=${r.actual}`);
		if (!r.pass) {
			console.log(`      ${r.detail ?? ''}`);
			if (r.reason) console.log(`      reason: ${r.reason}`);
		}
	}

	const passed = results.filter((r) => r.pass).length;
	const failed = results.length - passed;
	console.log(`\n── Summary ──`);
	console.log(`  total:  ${results.length}`);
	console.log(`  passed: ${passed}`);
	console.log(`  failed: ${failed}`);

	if (failed > 0) {
		console.log(`\n❌ FAIL — ${failed} in-code assertion(s) failed`);
		console.log('   Note: the bash wrapper also greps the harness log for [opa-shadow] MISMATCH lines');
		process.exit(1);
	}

	console.log(`\n✅ PASS — all in-code assertions matched expected outcomes`);
	console.log('   Phase 2a gate: now verify the harness stderr log has ZERO [opa-shadow] MISMATCH lines');
}

main().catch((err) => {
	console.error('Error:', err);
	process.exit(1);
});

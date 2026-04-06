/**
 * Phase 3 delegation test — RFC 8693 act claim.
 *
 * Creates a JWT for flight_ops agent with act={sub:"alice"} to simulate
 * a user delegating to an agent via token exchange. Then runs a query
 * and verifies:
 *   1. initialize_agent returns delegated_subject in the identity block
 *   2. The query succeeds (delegation doesn't break governance)
 *   3. The decision_logs row contains delegated_subject="alice"
 *   4. A non-delegated JWT does NOT have delegated_subject
 *
 * Uses shared_secret strategy (no Zitadel needed). The harness must be
 * running in JWT mode:
 *
 *   AUTH_MODE=jwt JWT_SECRET=test-secret-32chars-min-length!! \
 *   HARNESS_TRANSPORT=http SCENARIO_PATH=../scenario/travel \
 *   npx tsx src/server.ts
 *
 * Usage:
 *   JWT_SECRET=test-secret-32chars-min-length!! npx tsx src/test-delegation.ts
 */

import jwt from 'jsonwebtoken';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client as PgClient } from 'pg';

const JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-32chars-min-length!!';
const HARNESS_URL = process.env.HARNESS_URL ?? 'http://127.0.0.1:9080/mcp';

function makeToken(sub: string, act?: { sub: string }): string {
	const payload: Record<string, unknown> = {
		sub,
		iss: 'test-issuer',
		aud: 'dazense-harness',
	};
	if (act) payload.act = act;
	return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

async function connectWithToken(token: string): Promise<McpClient> {
	const client = new McpClient({ name: 'delegation-test', version: '0.1' });
	const transport = new StreamableHTTPClientTransport(new URL(HARNESS_URL), {
		requestInit: {
			headers: { Authorization: `Bearer ${token}` },
		},
	});
	await client.connect(transport);
	return client;
}

async function callTool(client: McpClient, name: string, args: Record<string, unknown>): Promise<unknown> {
	const result = await client.callTool({ name, arguments: args });
	const content = result.content as Array<{ type: string; text?: string }>;
	const text = content?.[0]?.text;
	if (!text) return result;
	try {
		return JSON.parse(text);
	} catch {
		return { raw: text };
	}
}

async function countDelegatedLogs(delegatedSubject: string): Promise<number> {
	const pg = new PgClient({
		host: process.env.TRAVEL_DB_HOST ?? 'localhost',
		port: Number(process.env.TRAVEL_DB_PORT ?? 5433),
		database: 'travel_db',
		user: 'travel_admin',
		password: 'travel_pass',
	});
	await pg.connect();
	try {
		const res = await pg.query<{ count: string }>(
			'SELECT COUNT(*) FROM decision_logs WHERE delegated_subject = $1',
			[delegatedSubject],
		);
		return Number(res.rows[0]?.count ?? 0);
	} finally {
		await pg.end();
	}
}

async function main(): Promise<void> {
	console.log('🔑 Phase 3 Delegation Test\n');
	const failures: string[] = [];

	// ── Test 1: delegated token (act claim present) ──
	console.log('── Test 1: delegated token (ops-agent acting as alice) ──');
	const delegatedToken = makeToken('ops-agent', { sub: 'alice' });
	const client1 = await connectWithToken(delegatedToken);
	const init1 = (await callTool(client1, 'initialize_agent', {
		agent_id: 'flight_ops',
		session_id: 'delegation-test-001',
		question: 'Phase 3 delegation test',
	})) as { identity?: { delegated_subject?: string; auth_method?: string; agent_id?: string } };

	const id1 = (init1 as Record<string, unknown>).identity as Record<string, unknown> | undefined;
	console.log(`  agent_id:           ${id1?.agent_id}`);
	console.log(`  auth_method:        ${id1?.auth_method}`);
	console.log(`  delegated_subject:  ${id1?.delegated_subject ?? '(none)'}`);

	if (id1?.delegated_subject !== 'alice') {
		failures.push(`expected delegated_subject=alice, got ${id1?.delegated_subject}`);
	}
	if (id1?.auth_method !== 'jwt') {
		failures.push(`expected auth_method=jwt, got ${id1?.auth_method}`);
	}

	// Query with delegated token — should succeed (delegation doesn't break governance)
	const q1 = (await callTool(client1, 'query_data', {
		sql: "SELECT flight_id, status FROM flights WHERE status = 'delayed' LIMIT 3",
		reason: 'Delegation test query',
	})) as { status?: string };
	console.log(`  query status:       ${q1.status}`);
	if (q1.status !== 'success') {
		failures.push(`delegated query should succeed, got status=${q1.status}`);
	}
	await client1.close().catch(() => {});

	// ── Test 2: non-delegated token (no act claim) ──
	console.log('\n── Test 2: non-delegated token (ops-agent, no act) ──');
	const plainToken = makeToken('ops-agent');
	const client2 = await connectWithToken(plainToken);
	const init2 = (await callTool(client2, 'initialize_agent', {
		agent_id: 'flight_ops',
		session_id: 'delegation-test-002',
		question: 'Phase 3 no-delegation test',
	})) as { identity?: { delegated_subject?: string; auth_method?: string } };

	const id2 = (init2 as Record<string, unknown>).identity as Record<string, unknown> | undefined;
	console.log(`  auth_method:        ${id2?.auth_method}`);
	console.log(`  delegated_subject:  ${id2?.delegated_subject ?? '(none)'}`);

	if (id2?.delegated_subject) {
		failures.push(`non-delegated token should have no delegated_subject, got ${id2.delegated_subject}`);
	}
	await client2.close().catch(() => {});

	// ── Test 3: decision_logs contain delegated_subject ──
	console.log('\n── Test 3: decision_logs audit trail ──');
	// Small delay to let best-effort log flush
	await new Promise((r) => setTimeout(r, 1000));
	const aliceLogs = await countDelegatedLogs('alice');
	console.log(`  decision_logs rows with delegated_subject='alice': ${aliceLogs}`);
	if (aliceLogs < 1) {
		failures.push(`expected at least 1 decision_log row with delegated_subject=alice, got ${aliceLogs}`);
	}

	// ── Summary ──
	console.log('\n── Summary ──');
	if (failures.length === 0) {
		console.log('✅ PASS — delegation chain is correctly captured in identity + audit trail');
	} else {
		console.log('❌ FAIL:');
		for (const f of failures) console.log(`   - ${f}`);
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error('Error:', err);
	process.exit(1);
});

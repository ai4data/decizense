/**
 * Phase 1c idempotency test — orchestrator workflow.
 *
 * Starts the orchestrator workflow twice in the SAME process, with the same
 * WORKFLOW_ID, against the running HTTP harness. DBOS must dedupe — only ONE
 * workflow execution should occur, and the second call must return the
 * checkpointed result from the first.
 *
 * Assertions:
 *   1. Both calls return identical plans, subagent results, and decision
 *   2. Exactly 1 row in dbos.workflow_status for the workflow_id
 *   3. Exactly N findings rows for the sub-agents (one per sub-agent, not 2N)
 *   4. Exactly 1 decision_outcomes row for the session
 *
 * Uses DAZENSE_LLM_MOCK=true so results are deterministic.
 *
 * Prerequisites:
 *   - travel_postgres running
 *   - Harness running as HTTP server on localhost:9080 (started by the verify script)
 *
 * Usage:
 *   DAZENSE_LLM_MOCK=true npx tsx src/test-orchestrator-idempotency.ts
 */

import { Client } from 'pg';
import { initAgentDbos, shutdownAgentDbos } from './workflows/dbos-init.js';
import { startOrchestratorWorkflow } from './workflows/orchestrator.js';

async function countRows(sql: string, params: unknown[]): Promise<number> {
	const client = new Client({
		host: process.env.TRAVEL_DB_HOST ?? 'localhost',
		port: Number(process.env.TRAVEL_DB_PORT ?? 5433),
		database: process.env.TRAVEL_DB_NAME ?? 'travel_db',
		user: process.env.TRAVEL_DB_USER ?? 'travel_admin',
		password: process.env.TRAVEL_DB_PASSWORD ?? 'travel_pass',
	});
	await client.connect();
	try {
		const res = await client.query<{ count: string }>(sql, params);
		return Number(res.rows[0]?.count ?? 0);
	} finally {
		await client.end();
	}
}

async function main(): Promise<void> {
	console.log('🔁 Phase 1c Orchestrator Idempotency Test\n');

	if (process.env.DAZENSE_LLM_MOCK !== 'true') {
		console.error('This test requires DAZENSE_LLM_MOCK=true for deterministic assertions');
		process.exit(2);
	}

	const workflowId = `orch-idempotency-${Date.now()}`;
	const sessionId = `orch-session-idempotency-${Date.now()}`;
	const question = 'Idempotency test: will flight F1001 be delayed and affect my connection?';

	console.log(`Workflow ID: ${workflowId}`);
	console.log(`Session ID:  ${sessionId}\n`);

	await initAgentDbos('dazense-test-orchestrator-idempotency');

	try {
		console.log('── First call ──');
		const r1 = await startOrchestratorWorkflow({ workflowId, sessionId, question });
		console.log(`  plan:           [${r1.plan.map((p) => p.id).join(', ')}]`);
		console.log(`  subagent count: ${r1.subagentResults.length}`);
		console.log(`  decision:       ${r1.decision.slice(0, 60)}...`);
		console.log(`  outcomeStored:  ${r1.outcomeStored}`);

		console.log('\n── Second call (same workflow_id) ──');
		const r2 = await startOrchestratorWorkflow({ workflowId, sessionId, question });
		console.log(`  plan:           [${r2.plan.map((p) => p.id).join(', ')}]`);
		console.log(`  subagent count: ${r2.subagentResults.length}`);
		console.log(`  decision:       ${r2.decision.slice(0, 60)}...`);
		console.log(`  outcomeStored:  ${r2.outcomeStored}`);

		console.log('\n── Assertions ──');
		const failures: string[] = [];

		// 1. Identical returns
		if (r1.plan.length !== r2.plan.length)
			failures.push(`plan length differs: ${r1.plan.length} vs ${r2.plan.length}`);
		if (r1.subagentResults.length !== r2.subagentResults.length)
			failures.push(`subagent count differs: ${r1.subagentResults.length} vs ${r2.subagentResults.length}`);
		if (r1.decision !== r2.decision) failures.push('decision text differs between calls');

		// 2. DBOS workflow count
		const wfCount = await countRows(`SELECT COUNT(*) FROM dbos.workflow_status WHERE workflow_uuid = $1`, [
			workflowId,
		]);
		console.log(`  dbos.workflow_status rows for ${workflowId}: ${wfCount}`);
		if (wfCount !== 1) failures.push(`expected 1 dbos workflow_status row, got ${wfCount}`);

		// 3. Findings count = exactly subagent count (not 2×, despite two invocations)
		const expectedFindings = r1.subagentResults.length;
		const findingsCount = await countRows(`SELECT COUNT(*) FROM decision_findings WHERE session_id = $1`, [
			sessionId,
		]);
		console.log(`  decision_findings rows for ${sessionId}: ${findingsCount} (expected ${expectedFindings})`);
		if (findingsCount !== expectedFindings)
			failures.push(`expected exactly ${expectedFindings} findings, got ${findingsCount}`);

		// 4. Outcomes count
		const outcomesCount = await countRows(`SELECT COUNT(*) FROM decision_outcomes WHERE session_id = $1`, [
			sessionId,
		]);
		console.log(`  decision_outcomes rows for ${sessionId}: ${outcomesCount}`);
		if (outcomesCount !== 1) failures.push(`expected 1 outcome row, got ${outcomesCount}`);

		if (failures.length === 0) {
			console.log('\n✅ PASS - DBOS deduped the orchestrator workflow; no duplicate side effects');
		} else {
			console.log('\n❌ FAIL:');
			for (const f of failures) console.log(`   - ${f}`);
			process.exitCode = 1;
		}
	} finally {
		await shutdownAgentDbos();
	}
}

main().catch((err) => {
	console.error('Error:', err);
	process.exit(1);
});

/**
 * Phase 1b idempotency test.
 *
 * Starts a decision workflow twice with the SAME workflow_id. DBOS must
 * dedupe — only ONE outcome row should appear in decision_outcomes for
 * that workflow_id, and both calls must return the same outcome_id.
 *
 * This is the Plan v3 interactive workflow_id guarantee:
 *   "caller provides workflow_id; calling twice with the same id returns
 *    the original result, no re-execution."
 *
 * Prerequisites:
 *   - travel_postgres + dazense_jaeger running
 *   - Harness running as HTTP server on localhost:9080 (start before this test)
 *
 * Usage:
 *   npx tsx src/test-idempotency.ts
 */

import { HarnessClient } from './harness-client.js';
import { runWithRootSpan } from './tracing.js';

async function main() {
	console.log('🔁 Phase 1b Idempotency Test\n');

	await runWithRootSpan('dazense-test-idempotency', 'test.idempotency', {}, async () => {
		const workflowId = `wf-idempotency-${Date.now()}`;
		const sessionId = `sess-idempotency-${Date.now()}`;
		const question = 'Idempotency verification: rebook a customer whose flight was cancelled';

		const baseArgs = {
			workflow_id: workflowId,
			session_id: sessionId,
			question,
			proposed_action: 'rebook passenger on next available flight',
			risk_class: 'low',
			confidence: 'high',
			action_type: 'rebook_passenger',
			parameters: { booking_id: '42', reason: 'cancellation' },
		};

		console.log(`Workflow ID: ${workflowId}`);
		console.log(`Session ID:  ${sessionId}\n`);

		// Two separate HarnessClient connections (different MCP sessions),
		// same logical workflow_id. DBOS must recognize this as idempotent.
		console.log('── First call ──');
		const h1 = new HarnessClient('flight_ops');
		await h1.connect();
		const r1 = (await h1.callTool('start_decision_workflow', baseArgs)) as {
			outcome_id?: number;
			proposal_id?: number;
			workflow_id?: string;
			error?: string;
			status?: string;
		};
		await h1.close();
		console.log(`  status:     ${r1.status}`);
		console.log(`  outcome_id: ${r1.outcome_id}`);
		console.log(`  proposal_id:${r1.proposal_id}`);
		if (r1.error) {
			console.log(`  ERROR:      ${r1.error}`);
			process.exitCode = 1;
			return;
		}

		console.log('\n── Second call (same workflow_id, new MCP session) ──');
		const h2 = new HarnessClient('flight_ops');
		await h2.connect();
		const r2 = (await h2.callTool('start_decision_workflow', baseArgs)) as typeof r1;
		await h2.close();
		console.log(`  status:     ${r2.status}`);
		console.log(`  outcome_id: ${r2.outcome_id}`);
		console.log(`  proposal_id:${r2.proposal_id}`);

		console.log('\n── Assertions ──');
		const failures: string[] = [];
		if (r1.outcome_id == null) failures.push('first call did not return outcome_id');
		if (r2.outcome_id == null) failures.push('second call did not return outcome_id');
		if (r1.outcome_id !== r2.outcome_id) {
			failures.push(`outcome_id mismatch: first=${r1.outcome_id} second=${r2.outcome_id} — DBOS did NOT dedupe`);
		}
		if (r1.proposal_id !== r2.proposal_id) {
			failures.push(`proposal_id mismatch: first=${r1.proposal_id} second=${r2.proposal_id}`);
		}
		if (r1.workflow_id !== workflowId || r2.workflow_id !== workflowId) {
			failures.push('workflow_id not echoed correctly in responses');
		}

		if (failures.length === 0) {
			console.log('✅ PASS — both calls returned the same outcome_id (workflow deduped by DBOS)');
			console.log(`   workflow_id=${workflowId} outcome_id=${r1.outcome_id}`);
		} else {
			console.log('❌ FAIL:');
			for (const f of failures) console.log(`   - ${f}`);
			process.exitCode = 1;
		}
	});
}

main().catch((err) => {
	console.error('Error:', err);
	process.exit(1);
});

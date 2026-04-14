/**
 * Orchestrator agent entrypoint — Plan v3 Phase 1c.
 *
 * Thin DBOS client. The real orchestration lifecycle lives in
 * src/workflows/orchestrator.ts as a durable DBOS workflow. This file:
 *
 *   1. Initializes DBOS (opens connection to the shared `dbos` schema in
 *      travel_db — same one the harness uses)
 *   2. Reads the workflow_id (required per Plan v3 R2.1 interactive rule,
 *      and MUST start with `orch-` so it never collides with harness-side
 *      decision workflow IDs)
 *   3. Calls startOrchestratorWorkflow(input)
 *   4. Prints the result
 *   5. Shuts DBOS down
 *
 * Crash recovery: if this process dies mid-workflow (e.g., via CRASH_AFTER_STEP),
 * starting the orchestrator again with the SAME WORKFLOW_ID resumes from the
 * last completed step — DBOS.launch() auto-recovers pending workflows.
 *
 * Usage:
 *   # Happy path:
 *   WORKFLOW_ID=orch-wf-123 npx tsx src/orchestrator.ts "Will I miss my connection?"
 *
 *   # Deterministic test mode:
 *   DAZENSE_LLM_MOCK=true WORKFLOW_ID=orch-test-1 npx tsx src/orchestrator.ts "..."
 */

import { loadRepoEnv } from './load-env.js';
import { initAgentTracing, shutdownAgentTracing, getAgentTracer } from './tracing.js';
import { initAgentDbos, shutdownAgentDbos } from './workflows/dbos-init.js';
import { startOrchestratorWorkflow } from './workflows/orchestrator.js';

loadRepoEnv();

const WORKFLOW_ID_PREFIX = 'orch-';

function resolveWorkflowId(): string {
	const raw = process.env.WORKFLOW_ID;
	if (!raw) {
		console.error(
			'ERROR: WORKFLOW_ID is required for interactive mode (Plan v3 R2.1 canonical rule). ' +
				'Provide a stable workflow ID via the WORKFLOW_ID env var.',
		);
		process.exit(2);
	}
	if (!raw.startsWith(WORKFLOW_ID_PREFIX)) {
		console.error(
			`ERROR: orchestrator workflow IDs must start with "${WORKFLOW_ID_PREFIX}" to avoid ` +
				`collisions with harness-side decision workflows. Got: "${raw}"`,
		);
		process.exit(2);
	}
	return raw;
}

async function main(): Promise<void> {
	const question = process.argv[2] ?? 'Will I miss my connection if flight F1001 is delayed?';
	const workflowId = resolveWorkflowId();
	const sessionId = `orch-session-${workflowId.slice(WORKFLOW_ID_PREFIX.length)}`;

	console.log(`\n🎯 Orchestrator (durable, DBOS)`);
	console.log(`Workflow ID: ${workflowId}`);
	console.log(`Session ID:  ${sessionId}`);
	console.log(`Question:    "${question}"\n`);

	// Tracing (optional; disabled if OTel collector unreachable — Phase 0)
	initAgentTracing('dazense-agent-orchestrator');
	const tracer = getAgentTracer('dazense-agent-orchestrator');

	// DBOS runtime — MUST be launched before startOrchestratorWorkflow
	await initAgentDbos('dazense-agent-orchestrator');

	try {
		await tracer.startActiveSpan('orchestrator.run', async (span) => {
			span.setAttribute('dazense.workflow.id', workflowId);
			span.setAttribute('dazense.session.id', sessionId);
			span.setAttribute('dazense.question.length', question.length);
			try {
				const result = await startOrchestratorWorkflow({ workflowId, sessionId, question });

				console.log(`\nPlan: ${result.plan.map((p) => p.id).join(', ')}`);
				console.log(`Sub-agent results:`);
				for (const r of result.subagentResults) {
					console.log(`  [${r.agentId}] ${r.answer.substring(0, 100)}${r.answer.length > 100 ? '...' : ''}`);
				}
				console.log('\n' + '═'.repeat(60));
				console.log('\n🎯 ORCHESTRATOR DECISION:\n');
				console.log(result.decision);
				console.log('\n' + '═'.repeat(60));
				console.log(`\nOutcome stored: ${result.outcomeStored}`);
				console.log(`Workflow: ${result.workflowId}`);
				console.log('✅ Orchestrator workflow completed');
			} finally {
				span.end();
			}
		});
	} finally {
		await shutdownAgentDbos();
		await shutdownAgentTracing();
	}
}

main().catch((err) => {
	console.error('Error:', (err as Error).message || err);
	process.exit(1);
});

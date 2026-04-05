/**
 * One-shot workflow firing helper used by the crash recovery test.
 *
 * Reads the workflow arguments from env vars and invokes start_decision_workflow
 * against the HTTP harness. If the harness crashes mid-workflow (via
 * CRASH_AFTER_STEP on the harness side), the MCP connection will error out —
 * that error is expected and is caught so the shell test can continue.
 *
 * Env vars:
 *   FIRE_WORKFLOW_ID        — required, the workflow_id to use
 *   FIRE_SESSION_ID         — required, session identifier for audit
 *   FIRE_QUESTION           — optional, default "crash recovery test"
 *   FIRE_RISK_CLASS         — optional, default "low"
 */

import { HarnessClient } from './harness-client.js';

async function main() {
	const workflowId = process.env.FIRE_WORKFLOW_ID;
	const sessionId = process.env.FIRE_SESSION_ID;
	if (!workflowId || !sessionId) {
		console.error('FIRE_WORKFLOW_ID and FIRE_SESSION_ID are required');
		process.exit(2);
	}

	const harness = new HarnessClient('flight_ops');
	try {
		await harness.connect();
		const result = await harness.callTool('start_decision_workflow', {
			workflow_id: workflowId,
			session_id: sessionId,
			question: process.env.FIRE_QUESTION ?? 'crash recovery test',
			proposed_action: 'crash recovery test action',
			risk_class: process.env.FIRE_RISK_CLASS ?? 'low',
			confidence: 'high',
			action_type: 'test',
			parameters: { key: 'value' },
		});
		console.log(JSON.stringify(result));
	} catch (err) {
		// Expected when the harness crashes mid-workflow
		console.log(`fire-workflow: connection error (expected on crash): ${(err as Error).message}`);
	} finally {
		try {
			await harness.close();
		} catch {
			/* ignore */
		}
	}
}

main().catch((err) => {
	console.error('fire-workflow unexpected error:', err);
	process.exit(1);
});

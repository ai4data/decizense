/**
 * Phase 2c admin-tool verification.
 *
 * Calls MCP admin tools over the normal HarnessClient path and asserts
 * replay/drift expectations. Intended for scripts/verify-phase-2c.sh.
 *
 * Required env:
 *   - ORCHESTRATOR_TOKEN (JWT for orchestrator-agent)
 *   - REPLAY_ID (decision_logs.opa_decision_id to replay)
 *
 * Optional env:
 *   - EXPECT_REPLAY_CHANGED=true|false (default: true)
 *   - EXPECT_DRIFT_CHANGED_MIN=<number> (default: 1)
 */

import { HarnessClient } from './harness-client.js';

interface ReplayOutcomeResult {
	error?: string;
	policy_changed?: boolean;
}

interface DriftReportResult {
	error?: string;
	total?: number;
	changed?: number;
}

async function main(): Promise<void> {
	const token = process.env.ORCHESTRATOR_TOKEN;
	const replayId = process.env.REPLAY_ID;
	const expectReplayChanged = (process.env.EXPECT_REPLAY_CHANGED ?? 'true') === 'true';
	const expectDriftChangedMin = Number(process.env.EXPECT_DRIFT_CHANGED_MIN ?? '1');

	if (!token) throw new Error('ORCHESTRATOR_TOKEN is required');
	if (!replayId) throw new Error('REPLAY_ID is required');

	const harness = new HarnessClient('orchestrator', token);
	await harness.connect();

	try {
		const replay = (await harness.callTool('replay_outcome', {
			opa_decision_id: replayId,
		})) as ReplayOutcomeResult;

		if (replay.error) {
			throw new Error(`replay_outcome returned error: ${replay.error}`);
		}

		if (expectReplayChanged && replay.policy_changed !== true) {
			throw new Error('Expected replay_outcome.policy_changed=true, got false');
		}
		if (!expectReplayChanged && replay.policy_changed === true) {
			throw new Error('Expected replay_outcome.policy_changed=false, got true');
		}

		const drift = (await harness.callTool('policy_drift_report', {
			limit: 200,
		})) as DriftReportResult;

		if (drift.error) {
			throw new Error(`policy_drift_report returned error: ${drift.error}`);
		}

		if (typeof drift.total !== 'number') {
			throw new Error(`Expected policy_drift_report.total to be a number, got ${typeof drift.total}`);
		}
		if (typeof drift.changed !== 'number') {
			throw new Error(`Expected policy_drift_report.changed to be a number, got ${typeof drift.changed}`);
		}
		if (drift.changed > drift.total) {
			throw new Error(`Inconsistent drift report: changed (${drift.changed}) > total (${drift.total})`);
		}

		if (drift.changed < expectDriftChangedMin) {
			throw new Error(`Expected policy_drift_report.changed >= ${expectDriftChangedMin}, got ${drift.changed}`);
		}

		console.log(
			JSON.stringify(
				{
					replay,
					drift,
				},
				null,
				2,
			),
		);
	} finally {
		await harness.close();
	}
}

main().catch((err) => {
	console.error('Error:', err);
	process.exit(1);
});

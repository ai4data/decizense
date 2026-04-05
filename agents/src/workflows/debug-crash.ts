/**
 * Crash-injection hook for Phase 1c orchestrator tests.
 *
 * Set CRASH_AFTER_STEP=<step_name> in the agent env to make the workflow
 * exit(1) right after a specific step's checkpoint has been persisted. The
 * NEXT agent invocation (without the env var) should auto-recover via DBOS
 * and complete the remaining steps.
 *
 * Supported step names match runStep `name` options in orchestrator.ts:
 *   - get_context
 *   - plan_subagents
 *   - run_subagent_<agentId>   (e.g. run_subagent_flight_ops)
 *   - combine_findings
 *   - record_outcome
 *
 * Never set in production.
 */
export function maybeCrashAfter(stepName: string): void {
	const target = process.env.CRASH_AFTER_STEP;
	if (target && target === stepName) {
		console.error(`[orchestrator workflow] CRASH_AFTER_STEP=${stepName} - exiting to simulate crash`);
		setTimeout(() => process.exit(42), 50);
	}
}

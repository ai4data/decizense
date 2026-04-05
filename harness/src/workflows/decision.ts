/**
 * Decision workflow — the Plan v3 Phase 1b vertical slice.
 *
 * Proves DBOS end-to-end with one concrete decision flow:
 *
 *   1. Record workflow run (DB write, step)
 *   2. Propose decision — insert into decision_proposals (step)
 *   3. Approve decision — insert into decision_approvals (step)
 *   4. Execute action — insert into decision_actions (step)
 *   5. Record outcome — insert into decision_outcomes (step)
 *   6. Mark workflow run complete (step)
 *
 * Each step is wrapped in DBOS.runStep so its result is checkpointed to the
 * `dbos` schema. If the harness crashes between step 3 and step 4, restarting
 * the harness resumes the workflow from step 4 — steps 1-3 are NOT re-run.
 *
 * The workflow_id comes from the caller (Plan v3 interactive rule). Calling
 * runDecisionWorkflow twice with the same workflow_id produces only ONE
 * outcome row because DBOS dedupes on workflow_id.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { executeQuery } from '../database/index.js';

/**
 * Crash-injection hook for the Phase 1b crash recovery test. Set
 * CRASH_AFTER_STEP=<step_name> in the harness env to make the workflow
 * exit(1) after that step's checkpoint has been persisted. The NEXT
 * harness start (without the env var) should auto-recover via DBOS
 * and complete the remaining steps.
 *
 * Never set this in production. Step names match the runStep `name` option
 * in this file: record_workflow_run, propose_decision, approve_decision,
 * execute_action, record_outcome, complete_workflow_run.
 */
function maybeCrashAfter(stepName: string): void {
	const target = process.env.CRASH_AFTER_STEP;
	if (target && target === stepName) {
		console.error(`[decision workflow] CRASH_AFTER_STEP=${stepName} — exiting to simulate crash`);
		// Small delay so the checkpoint write finishes before we kill the process
		setTimeout(() => process.exit(42), 50);
	}
}

export interface DecisionWorkflowInput {
	workflowId: string;
	sessionId: string;
	agentId: string;
	question: string;
	proposedAction: string;
	riskClass: 'low' | 'medium' | 'high' | 'critical';
	confidence: 'high' | 'medium' | 'low';
	actionType: string;
	parameters: Record<string, string>;
	authMethod: string;
	tokenHash: string | null;
}

export interface DecisionWorkflowResult {
	workflowId: string;
	runId: string;
	proposalId: number;
	actionId: number;
	outcomeId: number;
	autoApproved: boolean;
}

/**
 * The workflow function. Do NOT call this directly — use startDecisionWorkflow()
 * which wraps it in DBOS.startWorkflow with the caller-provided workflowID.
 *
 * DBOS requirements:
 * - Non-step code inside this function runs on every replay, so it must be
 *   deterministic. All I/O is inside DBOS.runStep() calls.
 * - Step return values are serialized via superjson and stored in
 *   dbos.operation_outputs; don't return huge blobs.
 */
async function decisionWorkflowFn(input: DecisionWorkflowInput): Promise<DecisionWorkflowResult> {
	const {
		workflowId,
		sessionId,
		agentId,
		question,
		proposedAction,
		riskClass,
		confidence,
		actionType,
		parameters,
		authMethod,
		tokenHash,
	} = input;

	// Step 1: record the workflow run. ON CONFLICT DO NOTHING against the
	// partial unique index uniq_workflow_runs_workflow_id so replays cannot
	// duplicate the row — fallback SELECT retrieves the existing id.
	const runId = await DBOS.runStep(
		async () => {
			const result = await executeQuery(
				`INSERT INTO decision_workflow_runs
				   (workflow_id, session_id, agent_id, question, status, auth_method, token_hash)
				 VALUES ($1, $2, $3, $4, 'running', $5, $6)
				 ON CONFLICT (workflow_id) WHERE workflow_id IS NOT NULL DO NOTHING
				 RETURNING run_id`,
				[workflowId, sessionId, agentId, question, authMethod, tokenHash],
			);
			if (result.rowCount > 0) {
				return (result.rows[0] as { run_id: string }).run_id;
			}
			const existing = await executeQuery(
				`SELECT run_id FROM decision_workflow_runs WHERE workflow_id = $1 LIMIT 1`,
				[workflowId],
			);
			return (existing.rows[0] as { run_id: string }).run_id;
		},
		{ name: 'record_workflow_run' },
	);
	maybeCrashAfter('record_workflow_run');

	// Step 2: propose the decision. Unique on workflow_id → replay-safe.
	const proposalId = await DBOS.runStep(
		async () => {
			const result = await executeQuery(
				`INSERT INTO decision_proposals
				   (session_id, agent_id, proposed_action, confidence, risk_class, status,
				    auth_method, token_hash, correlation_id, workflow_id)
				 VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)
				 ON CONFLICT (workflow_id) WHERE workflow_id IS NOT NULL DO NOTHING
				 RETURNING proposal_id`,
				[
					sessionId,
					agentId,
					proposedAction,
					confidence,
					riskClass,
					authMethod,
					tokenHash,
					sessionId,
					workflowId,
				],
			);
			if (result.rowCount > 0) {
				return (result.rows[0] as { proposal_id: number }).proposal_id;
			}
			const existing = await executeQuery(
				`SELECT proposal_id FROM decision_proposals WHERE workflow_id = $1 LIMIT 1`,
				[workflowId],
			);
			return (existing.rows[0] as { proposal_id: number }).proposal_id;
		},
		{ name: 'propose_decision' },
	);
	maybeCrashAfter('propose_decision');

	// Step 3: approve (auto for low-risk, this slice always auto-approves).
	// ON CONFLICT on the (proposal_id, approved_by) unique index makes the
	// approval insert replay-safe — a retried step cannot duplicate approvals.
	// The UPDATE is idempotent by construction (setting status to the same value).
	const autoApproved = riskClass === 'low';
	await DBOS.runStep(
		async () => {
			await executeQuery(
				`INSERT INTO decision_approvals (proposal_id, approved_by, approved, reason)
				 VALUES ($1, 'auto', $2, $3)
				 ON CONFLICT (proposal_id, approved_by) DO NOTHING`,
				[
					proposalId,
					autoApproved,
					autoApproved ? 'auto-approved low-risk' : 'auto-rejected, would require human',
				],
			);
			await executeQuery(`UPDATE decision_proposals SET status = $1 WHERE proposal_id = $2`, [
				autoApproved ? 'approved' : 'rejected',
				proposalId,
			]);
		},
		{ name: 'approve_decision' },
	);
	maybeCrashAfter('approve_decision');

	// Step 4: execute the action (only if approved). Unique on workflow_id
	// → replay-safe, even if the proposal's status update re-runs.
	let actionId = -1;
	if (autoApproved) {
		actionId = await DBOS.runStep(
			async () => {
				const result = await executeQuery(
					`INSERT INTO decision_actions
					   (proposal_id, action_type, parameters, status, workflow_id)
					 VALUES ($1, $2, $3::jsonb, 'completed', $4)
					 ON CONFLICT (workflow_id) WHERE workflow_id IS NOT NULL DO NOTHING
					 RETURNING action_id`,
					[proposalId, actionType, JSON.stringify(parameters), workflowId],
				);
				await executeQuery(`UPDATE decision_proposals SET status = 'executed' WHERE proposal_id = $1`, [
					proposalId,
				]);
				if (result.rowCount > 0) {
					return (result.rows[0] as { action_id: number }).action_id;
				}
				const existing = await executeQuery(
					`SELECT action_id FROM decision_actions WHERE workflow_id = $1 LIMIT 1`,
					[workflowId],
				);
				return (existing.rows[0] as { action_id: number }).action_id;
			},
			{ name: 'execute_action' },
		);
		maybeCrashAfter('execute_action');
	}

	// Step 5: record the outcome. Unique on workflow_id → replay-safe.
	const outcomeId = await DBOS.runStep(
		async () => {
			const result = await executeQuery(
				`INSERT INTO decision_outcomes
				   (proposal_id, session_id, question, decision_summary, reasoning, confidence,
				    agents_involved, cost_usd, evidence_proposal_ids,
				    auth_method, token_hash, correlation_id, workflow_id)
				 VALUES ($1, $2, $3, $4, $5, $6, $7::text[], 0, $8::integer[], $9, $10, $11, $12)
				 ON CONFLICT (workflow_id) WHERE workflow_id IS NOT NULL DO NOTHING
				 RETURNING outcome_id`,
				[
					proposalId,
					sessionId,
					question,
					proposedAction,
					autoApproved ? 'Auto-approved and executed' : 'Auto-rejected (non-low risk)',
					confidence,
					[agentId],
					[proposalId],
					authMethod,
					tokenHash,
					sessionId,
					workflowId,
				],
			);
			if (result.rowCount > 0) {
				return (result.rows[0] as { outcome_id: number }).outcome_id;
			}
			const existing = await executeQuery(
				`SELECT outcome_id FROM decision_outcomes WHERE workflow_id = $1 LIMIT 1`,
				[workflowId],
			);
			return (existing.rows[0] as { outcome_id: number }).outcome_id;
		},
		{ name: 'record_outcome' },
	);
	maybeCrashAfter('record_outcome');

	// Step 6: mark workflow run completed
	await DBOS.runStep(
		async () => {
			await executeQuery(
				`UPDATE decision_workflow_runs
				 SET status = 'completed', completed_at = NOW()
				 WHERE run_id = $1`,
				[runId],
			);
		},
		{ name: 'complete_workflow_run' },
	);
	maybeCrashAfter('complete_workflow_run');

	return { workflowId, runId, proposalId, actionId, outcomeId, autoApproved };
}

/**
 * The registered workflow — this is what agents invoke via startWorkflow.
 * Registration happens at module load; the workflow itself is idempotent
 * on workflow_id thanks to DBOS's built-in dedupe.
 */
export const decisionWorkflow = DBOS.registerWorkflow(decisionWorkflowFn, {
	name: 'dazenseDecisionWorkflow',
});

/**
 * Start a decision workflow with a caller-provided workflow_id.
 *
 * Plan v3 R2.1: interactive mode MUST have an explicit workflow_id. Callers
 * of this function must satisfy that rule themselves — this function does
 * not derive workflow_ids.
 *
 * Returns immediately with the workflow handle. Call .getResult() to await
 * completion, or inspect via DBOS.getWorkflowStatus(workflowId).
 */
export async function startDecisionWorkflow(input: DecisionWorkflowInput): Promise<DecisionWorkflowResult> {
	const handle = await DBOS.startWorkflow(decisionWorkflow, { workflowID: input.workflowId })(input);
	return handle.getResult() as Promise<DecisionWorkflowResult>;
}

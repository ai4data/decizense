/**
 * WORKFLOW tools — Plan v3 Phase 1b durable execution.
 *
 * Exposes the decision workflow as an MCP tool. Enforces the canonical
 * workflow_id rule (interactive mode REQUIRES explicit workflow_id; batch
 * mode derives from intent_version).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createHash } from 'crypto';
import { getCurrentAuthContext } from '../auth/context.js';
import { setAuthAttributes, getActiveSpan } from '../observability/span.js';
import { startDecisionWorkflow } from '../workflows/decision.js';
import { isDbosLaunched } from '../workflows/dbos-init.js';

/**
 * Resolve the workflow_id per the Plan v3 Phase 1b canonical rule.
 *
 *   IF caller provides workflow_id → use it
 *   ELSE IF HARNESS_MODE=batch AND intent_version provided →
 *     workflow_id = sha256(caller + question + intent_version)[0:32]
 *   ELSE → throw AuthError (interactive mode requires explicit workflow_id)
 */
function resolveWorkflowId(
	callerSubject: string,
	question: string,
	providedWorkflowId: string | undefined,
	intentVersion: string | undefined,
): string {
	if (providedWorkflowId) return providedWorkflowId;

	const isBatch = process.env.HARNESS_MODE === 'batch';
	if (isBatch && intentVersion) {
		return createHash('sha256').update(`${callerSubject}|${question}|${intentVersion}`).digest('hex').slice(0, 32);
	}
	throw new Error(
		'workflow_id is required for interactive queries. ' +
			'Set HARNESS_MODE=batch and provide intent_version to use derived IDs, or pass workflow_id explicitly.',
	);
}

export function registerWorkflowTools(server: McpServer): void {
	server.tool(
		'start_decision_workflow',
		'Start a durable decision workflow (Plan v3 Phase 1b). Calling twice with the same workflow_id returns the original result — idempotency guaranteed by DBOS.',
		{
			workflow_id: z
				.string()
				.optional()
				.describe(
					'Explicit workflow ID (required in interactive mode). Same ID + same workflow = dedupe; different workflow = error.',
				),
			intent_version: z
				.string()
				.optional()
				.describe('Freshness dimension for batch mode derivation (HARNESS_MODE=batch only)'),
			session_id: z.string().describe('Application-level session ID for audit correlation'),
			question: z.string().describe('The question or decision being recorded'),
			proposed_action: z.string().describe('What action is being proposed'),
			risk_class: z
				.enum(['low', 'medium', 'high', 'critical'])
				.describe('Risk classification — only low auto-approves in this slice'),
			confidence: z.enum(['high', 'medium', 'low']).describe('Confidence in the proposal'),
			action_type: z.string().describe('Action type (e.g. notify_customer, rebook_passenger)'),
			parameters: z.record(z.string(), z.string()).describe('Action-specific parameters'),
		},
		async (args, extra) => {
			if (!isDbosLaunched()) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								error: 'DBOS not launched in this harness — start_decision_workflow requires HARNESS_TRANSPORT=http with DBOS init',
							}),
						},
					],
				};
			}

			const ctx = getCurrentAuthContext(extra);
			const span = getActiveSpan();
			if (span) {
				setAuthAttributes(span, ctx);
				span.setAttribute('dazense.workflow.risk_class', args.risk_class);
				span.setAttribute('dazense.workflow.confidence', args.confidence);
			}

			let workflowId: string;
			try {
				workflowId = resolveWorkflowId(ctx.agentId, args.question, args.workflow_id, args.intent_version);
			} catch (err) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
				};
			}
			if (span) span.setAttribute('dazense.workflow.id', workflowId);

			try {
				const result = await startDecisionWorkflow({
					workflowId,
					sessionId: args.session_id,
					agentId: ctx.agentId,
					question: args.question,
					proposedAction: args.proposed_action,
					riskClass: args.risk_class,
					confidence: args.confidence,
					actionType: args.action_type,
					parameters: args.parameters,
					authMethod: ctx.authMethod,
					tokenHash: ctx.tokenHash,
				});

				if (span) {
					span.setAttribute('dazense.workflow.outcome_id', result.outcomeId);
					span.setAttribute('dazense.workflow.auto_approved', result.autoApproved);
				}

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								status: 'completed',
								workflow_id: result.workflowId,
								run_id: result.runId,
								proposal_id: result.proposalId,
								action_id: result.actionId,
								outcome_id: result.outcomeId,
								auto_approved: result.autoApproved,
								agent_id: ctx.agentId,
							}),
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								status: 'error',
								workflow_id: workflowId,
								error: (err as Error).message,
							}),
						},
					],
				};
			}
		},
	);
}

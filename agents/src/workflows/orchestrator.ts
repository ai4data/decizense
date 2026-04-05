/**
 * Orchestrator workflow — Plan v3 Phase 1c.
 *
 * Converts the existing orchestrator lifecycle into a durable DBOS workflow.
 * Each step is checkpointed to the shared `dbos` schema in travel_db, so if
 * the agent process crashes mid-flight, the NEXT invocation with the same
 * workflow_id resumes from the last completed step.
 *
 * Lifecycle (unchanged from the original agents/src/orchestrator.ts):
 *   1. get_context           — harness catalog lookup for the question
 *   2. plan_subagents        — LLM call, returns list of {agentId, subQuestion}
 *   3. run_subagent_<id>     — per sub-agent step: its own HarnessClient session,
 *                              LLM loop with query_data, write_finding
 *   4. combine_findings      — LLM call, returns final decision text
 *   5. record_outcome        — harness.record_outcome call
 *
 * Sub-agent steps run in parallel via Promise.all of runStep calls. Each step
 * is independently checkpointed, so a crash during one sub-agent does not
 * force the others to re-run on recovery.
 *
 * Idempotency: same workflow_id + same workflow name → DBOS returns the
 * existing handle without re-executing. The orchestrator entrypoint enforces
 * an `orch-` prefix on all workflow IDs so they never collide with the
 * harness-side dazenseDecisionWorkflow (which uses different, unprefixed IDs).
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { HarnessClient } from '../harness-client.js';
import { callLLM } from '../llm.js';
import { maybeCrashAfter } from './debug-crash.js';

export interface OrchestratorWorkflowInput {
	workflowId: string;
	sessionId: string;
	question: string;
}

interface SubagentPlan {
	id: string;
	sub_question: string;
}

interface SubagentResult {
	agentId: string;
	answer: string;
}

export interface OrchestratorWorkflowResult {
	workflowId: string;
	sessionId: string;
	question: string;
	plan: SubagentPlan[];
	subagentResults: SubagentResult[];
	decision: string;
	outcomeStored: boolean;
}

const TOKEN_ENV_MAP: Record<string, string> = {
	flight_ops: 'OPS_TOKEN',
	booking: 'BOOKING_TOKEN',
	customer_service: 'CUSTOMER_TOKEN',
	orchestrator: 'ORCHESTRATOR_TOKEN',
};

/**
 * Open a short-lived HarnessClient connection for a given agent, run the
 * provided async body, and close the connection cleanly.
 */
async function withHarnessClient<T>(agentId: string, fn: (h: HarnessClient) => Promise<T>): Promise<T> {
	const token = process.env[TOKEN_ENV_MAP[agentId] ?? ''];
	const harness = new HarnessClient(agentId, token);
	try {
		await harness.connect();
		return await fn(harness);
	} finally {
		try {
			await harness.close();
		} catch {
			/* ignore */
		}
	}
}

/**
 * Step: run one sub-agent. Each call creates its own HarnessClient (so the
 * harness sees it as a distinct MCP session under the sub-agent's identity),
 * executes the LLM loop with the sub-agent's governance scope, writes its
 * finding, and returns the answer text.
 *
 * Retries of this step (post-crash) are safe because write_finding computes
 * a server-side idempotency_key from (session_id, agent_id, finding,
 * confidence, data_sources) and dedupes via a unique index.
 */
async function runSubagentStep(agentId: string, subQuestion: string, sessionId: string): Promise<SubagentResult> {
	return withHarnessClient(agentId, async (harness) => {
		const init = (await harness.initializeAgent(sessionId, subQuestion)) as {
			identity?: { authenticated?: boolean; display_name?: string };
			scope?: { tables?: string[] };
			constraints?: { max_rows?: number };
			system_prompt?: string;
		};
		if (!init.identity?.authenticated) {
			return { agentId, answer: `Agent ${agentId} not authenticated` };
		}
		const tables = init.scope?.tables?.join(', ') ?? 'none';
		const rules = (await harness.getBusinessRules(
			init.scope?.tables?.map((t: string) => t.split('.').pop() ?? '') ?? [],
		)) as {
			matched_rules?: Array<{ severity: string; name: string; description: string }>;
		};
		const rulesContext = (rules.matched_rules ?? [])
			.map((r) => `- [${r.severity}] ${r.name}: ${r.description}`)
			.join('\n');

		const systemPrompt = `${init.system_prompt ?? ''}
Tables: ${tables}
Max rows: ${init.constraints?.max_rows ?? 500}. Always include LIMIT.
${rulesContext ? `Rules:\n${rulesContext}` : ''}
ONLY query tables in your bundle. Be concise. Return a factual finding.`;

		const answer = await callLLM(systemPrompt, subQuestion, async (sql: string, reason: string) => {
			return await harness.queryData(sql, reason);
		});

		await harness.writeFinding(sessionId, answer, 'high', init.scope?.tables ?? []);
		return { agentId, answer };
	});
}

/**
 * The workflow function. Non-step code (the function body outside DBOS.runStep
 * calls) runs on every replay — it must be deterministic. All I/O is wrapped
 * in runStep so results are checkpointed.
 */
async function orchestratorWorkflowFn(input: OrchestratorWorkflowInput): Promise<OrchestratorWorkflowResult> {
	const { workflowId, sessionId, question } = input;

	// Step 1: get context from the harness
	const context = await DBOS.runStep(
		async () => {
			return withHarnessClient('orchestrator', async (harness) => {
				return harness.callTool('get_context', { question });
			});
		},
		{ name: 'get_context' },
	);
	maybeCrashAfter('get_context');

	const glossaryTerms =
		(context as { matched_glossary_terms?: Array<{ name: string; description: string }> }).matched_glossary_terms ??
		[];

	// Step 2: plan which sub-agents to involve via the LLM
	const plan = await DBOS.runStep(
		async () => {
			return withHarnessClient('orchestrator', async (harness) => {
				const orchestratorInit = (await harness.initializeAgent(sessionId, question)) as {
					constraints?: { can_delegate_to?: string[] };
				};
				const delegateTo = orchestratorInit.constraints?.can_delegate_to ?? [];
				const agentDescriptions = delegateTo.map((id) => `- ${id}`).join('\n');

				const planPrompt = `You are an orchestrator that decomposes complex questions.
Given a question, decide which domain agents to involve and what each should investigate.

Available agents:
${agentDescriptions}

Question: "${question}"

Respond ONLY with a JSON object like:
{"agents": [{"id": "agent_id_here", "sub_question": "..."}, ...]}

Include only agents that are needed. Be specific in sub-questions.`;

				const planResponse = await callLLM(planPrompt, 'Plan the investigation', async () => ({}));
				let parsedPlan: SubagentPlan[];
				try {
					const jsonMatch = planResponse.match(/\{[\s\S]*\}/);
					const parsed = JSON.parse(jsonMatch?.[0] ?? '{"agents": []}');
					parsedPlan = parsed.agents ?? [];
				} catch {
					parsedPlan = [
						{ id: 'flight_ops', sub_question: question },
						{ id: 'booking', sub_question: question },
					];
				}
				return parsedPlan;
			});
		},
		{ name: 'plan_subagents' },
	);
	maybeCrashAfter('plan_subagents');

	// Step 3: run sub-agents in parallel. Each sub-agent is its own step so
	// step-level checkpointing + retries apply per sub-agent.
	const subagentResults = await Promise.all(
		plan.map((agent) =>
			DBOS.runStep(async () => runSubagentStep(agent.id, agent.sub_question, sessionId), {
				name: `run_subagent_${agent.id}`,
			}).then((res) => {
				maybeCrashAfter(`run_subagent_${agent.id}`);
				return res;
			}),
		),
	);

	// Step 4: combine findings into a final decision via LLM
	const decision = await DBOS.runStep(
		async () => {
			const combinePrompt = `You are an orchestrator combining findings from multiple agents into a final decision.

Original question: "${question}"

Agent findings:
${subagentResults.map((r) => `[${r.agentId}]: ${r.answer}`).join('\n\n')}

${
	glossaryTerms.length > 0
		? `Relevant business terms: ${glossaryTerms.map((t) => `${t.name}: ${t.description}`).join('; ')}`
		: ''
}

Provide a clear, actionable decision. Include:
1. Direct answer to the question
2. Key facts from each agent
3. Confidence level (high/medium/low) and why
4. Recommended next action if any`;

			return callLLM(combinePrompt, 'Combine findings into a decision', async () => ({}));
		},
		{ name: 'combine_findings' },
	);
	maybeCrashAfter('combine_findings');

	// Step 5: record the outcome via the harness. The harness tool writes to
	// decision_outcomes; the workflow_id we pass correlates this outcome back
	// to the DBOS workflow and is indexed under Phase 1b's partial unique key.
	const outcomeStored = await DBOS.runStep(
		async () => {
			return withHarnessClient('orchestrator', async (harness) => {
				await harness.callTool('record_outcome', {
					session_id: sessionId,
					question,
					decision_summary: decision.substring(0, 500),
					reasoning: `Combined findings from ${subagentResults
						.map((r) => r.agentId)
						.join(', ')}. ${glossaryTerms.length} glossary terms matched.`,
					confidence: 'high',
					agents_involved: subagentResults.map((r) => r.agentId),
					cost_usd: 0.15,
					evidence_rules: [],
					evidence_signal_types: [],
				});
				return true;
			});
		},
		{ name: 'record_outcome' },
	);
	maybeCrashAfter('record_outcome');

	return { workflowId, sessionId, question, plan, subagentResults, decision, outcomeStored };
}

export const orchestratorWorkflow = DBOS.registerWorkflow(orchestratorWorkflowFn, {
	name: 'dazenseOrchestratorWorkflow',
});

/**
 * Start the orchestrator workflow with a caller-provided workflow_id.
 * Plan v3 R2.1: interactive callers MUST supply the workflow_id. The
 * `orch-` prefix is enforced by the entrypoint (agents/src/orchestrator.ts).
 */
export async function startOrchestratorWorkflow(input: OrchestratorWorkflowInput): Promise<OrchestratorWorkflowResult> {
	const handle = await DBOS.startWorkflow(orchestratorWorkflow, { workflowID: input.workflowId })(input);
	return handle.getResult() as Promise<OrchestratorWorkflowResult>;
}

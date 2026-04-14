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
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, hasToolCall, type LanguageModel, type ModelMessage, stepCountIs } from 'ai';

import { HarnessClient } from '../harness-client.js';
import { callLLM } from '../llm.js';
import { maybeCrashAfter } from './debug-crash.js';
import { buildSystemPrompt } from './deep-agent/prompts.js';
import { buildSubagentSystemPrompt } from './deep-agent/sub-agent-prompt.js';
import { initialState, renderState, type DeepAgentState } from './deep-agent/state.js';
import { ALLOWED_SUBAGENTS, createTaskTool, type AllowedSubagent } from './deep-agent/tools/task.js';
import { createFinalizeTool } from './deep-agent/tools/finalize.js';
import { createReadNotesTool, createWriteNoteTool } from './deep-agent/tools/scratchpad.js';
import { createWriteTodosTool } from './deep-agent/tools/todos.js';

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
	// Deep-agent loop state exposed for CLI visibility (optional so older
	// callers still type-check). Populated only by the deep-agent workflow.
	todos?: Array<{ id: string; content: string; status: string }>;
	notes?: Record<string, string>;
	turns?: number;
	confidence?: 'high' | 'medium' | 'low';
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
			scope?: {
				tables?: string[];
				measures?: string[];
				dimensions?: string[];
				allowed_joins?: string[];
				blocked_columns?: string[];
			};
			constraints?: { max_rows?: number };
			system_prompt?: string;
		};
		if (!init.identity?.authenticated) {
			return { agentId, answer: `Agent ${agentId} not authenticated` };
		}

		const tables = init.scope?.tables ?? [];
		const bareTableNames = tables.map((t) => t.split('.').pop() ?? t);

		// Fetch live entity details for every table in scope — this is the
		// authoritative column list that previously lived only as hand-typed
		// prose in scenario/travel/agents.yml. Failures per table fall through
		// to the builder which surfaces them as "(details unavailable)" so a
		// flaky catalog never takes the whole run down.
		const entityDetails = await Promise.all(
			bareTableNames.map(async (name) => {
				try {
					return await harness.getEntityDetails(name);
				} catch (err) {
					return {
						name,
						fqn: name,
						columns: [],
						error: err instanceof Error ? err.message : String(err),
					};
				}
			}),
		);

		const rulesResp = (await harness.getBusinessRules(bareTableNames)) as {
			matched_rules?: Array<{
				severity: string;
				name: string;
				description?: string;
				guidance?: string;
				rationale?: string | null;
			}>;
		};

		const systemPrompt = buildSubagentSystemPrompt({
			basePrompt: init.system_prompt ?? '',
			maxRows: init.constraints?.max_rows ?? 500,
			scope: {
				tables,
				measures: init.scope?.measures ?? [],
				dimensions: init.scope?.dimensions ?? [],
				allowedJoins: init.scope?.allowed_joins ?? [],
				blockedColumns: init.scope?.blocked_columns ?? [],
			},
			entityDetails,
			rules: rulesResp.matched_rules ?? [],
		});

		const answer = await callLLM(
			systemPrompt,
			subQuestion,
			async (sql: string, reason: string) => harness.queryData(sql, reason),
			{
				metricsFn: async (args) => harness.callTool('query_metrics', args),
			},
		);

		await harness.writeFinding(sessionId, answer, 'high', tables);
		return { agentId, answer };
	});
}

const MAX_TURNS = 12;

/**
 * Build the Vercel AI SDK LanguageModel for the orchestrator. We hit the
 * existing Azure cognitiveservices deployment via createOpenAI's custom
 * fetch escape hatch — `@ai-sdk/azure` assumes the new openai.azure.com
 * URL shape which our deployment does not use.
 */
function buildOrchestratorModel(): LanguageModel {
	const apiKey = process.env.AZURE_OPENAI_API_KEY;
	const endpoint = (process.env.AZURE_OPENAI_ENDPOINT ?? '').replace(/\/+$/, '');
	const deployment = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
	const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-01-preview';
	if (!apiKey || !endpoint || !deployment) {
		throw new Error(
			'Set AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and AZURE_OPENAI_CHAT_DEPLOYMENT for the orchestrator.',
		);
	}

	const provider = createOpenAI({
		apiKey,
		baseURL: 'https://unused.invalid', // overridden by the fetch below
		fetch: (async (_url: unknown, init?: RequestInit) => {
			const azureUrl = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
			const headers = new Headers(init?.headers);
			headers.delete('authorization');
			headers.set('api-key', apiKey);
			return fetch(azureUrl, { ...init, headers });
		}) as unknown as typeof fetch,
	});
	// .chat() targets /chat/completions; the default provider() uses the
	// /responses endpoint which our cognitiveservices URL doesn't expose.
	return provider.chat(deployment) as unknown as LanguageModel;
}

/**
 * Deep-agent workflow function. Replays the deterministic loop body each
 * time DBOS recovers from a crash; only the LLM/tool calls inside DBOS.runStep
 * are checkpointed and skipped on replay.
 */
async function orchestratorWorkflowFn(input: OrchestratorWorkflowInput): Promise<OrchestratorWorkflowResult> {
	const { workflowId, sessionId, question } = input;
	const state: DeepAgentState = initialState();

	// One-shot harness context fetch — surfaces relevant tables and glossary
	// terms; pre-seeded into the scratchpad so the LLM sees it from turn 0.
	const context = await DBOS.runStep(
		async () => {
			return withHarnessClient('orchestrator', async (harness) => {
				return harness.callTool('get_context', { question });
			});
		},
		{ name: 'get_context' },
	);
	maybeCrashAfter('get_context');

	const ctx = context as {
		relevant_tables?: Array<{ name: string }>;
		matched_glossary_terms?: Array<{ name: string; description: string }>;
	};
	const relevantTables = (ctx.relevant_tables ?? []).map((t) => t.name).join(', ') || '(none)';
	const relevantTerms =
		(ctx.matched_glossary_terms ?? []).map((t) => `${t.name}: ${t.description}`).join('; ') || '(none)';
	state.notes['catalog_context'] = `Relevant tables: ${relevantTables}\nGlossary terms: ${relevantTerms}`;

	// Build the deep-agent tools. Closures over `state` so each tool call
	// mutates the workflow state in place; that state is what gets snapshotted
	// at each turn boundary.
	const model = buildOrchestratorModel();
	const systemPrompt = buildSystemPrompt(`Catalog context for this run:\n${state.notes['catalog_context']}`);

	const tools = {
		write_todos: createWriteTodosTool(state),
		write_note: createWriteNoteTool(state),
		read_notes: createReadNotesTool(state),
		task: createTaskTool({
			state,
			sessionId,
			runner: async (subagentType, description, sid) => {
				return runSubagentStep(subagentType, description, sid);
			},
		}),
		finalize: createFinalizeTool({
			state,
			recordOutcome: async ({ decision, confidence, evidence }) => {
				await withHarnessClient('orchestrator', async (harness) => {
					await harness.callTool('record_outcome', {
						session_id: sessionId,
						question,
						decision_summary: decision.substring(0, 500),
						reasoning: `Deep-agent loop, ${state.taskResults.length} sub-agent task(s), ${state.turn + 1} turn(s). Evidence: ${evidence.join(' | ')}`,
						confidence,
						agents_involved: Array.from(new Set(state.taskResults.map((r) => r.subagentType))),
						cost_usd: 0.15,
						evidence_rules: [],
						evidence_signal_types: [],
					});
				});
			},
		}),
	};

	// Multi-turn loop. Each turn = one LLM call (one tool invocation), wrapped
	// in DBOS.runStep so it checkpoints. The loop itself is deterministic;
	// crash recovery replays the loop body and DBOS short-circuits already-
	// completed turn_N steps from the durable log.
	const transcript: ModelMessage[] = [];
	while (!state.finalized && state.turn < MAX_TURNS) {
		const turnIndex = state.turn;
		await DBOS.runStep(
			async () => {
				const messages: ModelMessage[] = [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: `Question: ${question}` },
					{ role: 'system', content: renderState(state) },
					...transcript,
				];

				const result = await generateText({
					model,
					messages,
					tools,
					stopWhen: [hasToolCall('finalize'), stepCountIs(1)],
				});

				transcript.push(...result.response.messages);
				return { tools_called: result.toolCalls.map((c) => c.toolName), text: result.text };
			},
			{ name: `turn_${turnIndex}` },
		);
		maybeCrashAfter(`turn_${turnIndex}`);
		state.turn += 1;
	}

	if (!state.finalized) {
		// Loop exhausted without finalize — synthesise a low-confidence summary
		// from whatever we collected so the workflow still records an outcome.
		const fallbackDecision =
			state.taskResults.length > 0
				? state.taskResults.map((r) => `[${r.subagentType}] ${r.answer}`).join('\n\n')
				: 'No sub-agent results were collected before the turn limit was reached.';
		await withHarnessClient('orchestrator', async (harness) => {
			await harness.callTool('record_outcome', {
				session_id: sessionId,
				question,
				decision_summary: fallbackDecision.substring(0, 500),
				reasoning: `Deep-agent loop exhausted ${MAX_TURNS} turns without calling finalize.`,
				confidence: 'low',
				agents_involved: Array.from(new Set(state.taskResults.map((r) => r.subagentType))),
				cost_usd: 0.15,
				evidence_rules: [],
				evidence_signal_types: [],
			});
		});
		state.final = { decision: fallbackDecision, confidence: 'low', evidence: [] };
	}

	const decisionText = state.final?.decision ?? '';
	return {
		workflowId,
		sessionId,
		question,
		plan: state.taskResults.map((r) => ({ id: r.subagentType, sub_question: r.description })),
		subagentResults: state.taskResults.map((r) => ({ agentId: r.subagentType, answer: r.answer })),
		decision: decisionText,
		outcomeStored: true,
		todos: state.todos.map((t) => ({ id: t.id, content: t.content, status: t.status })),
		notes: { ...state.notes },
		turns: state.turn,
		confidence: state.final?.confidence,
	};
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

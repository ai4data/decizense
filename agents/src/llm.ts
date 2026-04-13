/**
 * Shared LLM client — Azure OpenAI or OpenAI.
 *
 * Provides a callLLM function that handles the tool-calling loop.
 * All agents use this instead of duplicating LLM code.
 *
 * Test/dev mock: set DAZENSE_LLM_MOCK=true to bypass real LLM calls and
 * return deterministic canned answers. This makes Phase 1c crash recovery
 * tests hermetic. The mock is REFUSED when DAZENSE_PROFILE=production —
 * production profile must use a real LLM (enforced by assertMockAllowed).
 */

type QueryFn = (sql: string, reason: string) => Promise<unknown>;

// ─── Mock mode (dev/test only) ─────────────────────────────────────────────

function isMockEnabled(): boolean {
	return process.env.DAZENSE_LLM_MOCK === 'true';
}

function assertMockAllowed(): void {
	if (process.env.DAZENSE_PROFILE === 'production') {
		throw new Error(
			'DAZENSE_LLM_MOCK=true is refused under DAZENSE_PROFILE=production. Use a real LLM in production.',
		);
	}
}

let mockWarningLogged = false;
function logMockWarningOnce(): void {
	if (mockWarningLogged) return;
	console.error('[llm] WARNING: DAZENSE_LLM_MOCK=true - deterministic canned responses are used, no real LLM calls.');
	mockWarningLogged = true;
}

/**
 * Deterministic canned response for tests. Shape mirrors a real LLM answer
 * so orchestrator logic treats it identically. The mock recognizes a couple
 * of prompt patterns used by the orchestrator workflow and returns predictable
 * JSON for planning / combining.
 */
function mockLlmResponse(systemPrompt: string, question: string): string {
	// Planner prompt (orchestrator.ts builds this): "You are an orchestrator
	// that decomposes complex questions... Respond ONLY with a JSON object..."
	if (systemPrompt.includes('decomposes complex questions')) {
		return JSON.stringify({
			agents: [
				{ id: 'flight_ops', sub_question: 'Mock flight check for: ' + question.slice(0, 60) },
				{ id: 'booking', sub_question: 'Mock booking check for: ' + question.slice(0, 60) },
			],
		});
	}

	// Combiner prompt: "You are an orchestrator combining findings..."
	if (systemPrompt.includes('combining findings')) {
		return (
			'MOCK DECISION: analyzed findings from sub-agents. ' +
			'Recommended action: verify with real data. Confidence: medium.'
		);
	}

	// Sub-agent mock — return a canned finding text without invoking any tools
	return 'MOCK FINDING for "' + question.slice(0, 80) + '" - canned sub-agent response for deterministic tests';
}

async function callAzureChat(
	messages: Array<{ role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string }>,
	tools?: any[],
): Promise<any> {
	const resourceName = process.env.AZURE_RESOURCE_NAME || 'deepmig';
	const deployment = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || 'gpt-5.4';
	const apiKey = process.env.AZURE_OPENAI_API_KEY;
	const apiVersion = '2024-12-01-preview';

	if (!apiKey) {
		throw new Error('Set AZURE_OPENAI_API_KEY or OPENAI_API_KEY');
	}

	const url = `https://${resourceName}.cognitiveservices.azure.com/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

	const body: any = { messages, max_completion_tokens: 1500 };
	if (tools) body.tools = tools;

	const resp = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`Azure API error ${resp.status}: ${err.substring(0, 200)}`);
	}

	return resp.json();
}

/**
 * Run the LLM agent loop with a query tool.
 * Returns the final text answer.
 */
export async function callLLM(
	systemPrompt: string,
	question: string,
	queryFn: QueryFn,
	maxSteps = 12,
): Promise<string> {
	if (isMockEnabled()) {
		assertMockAllowed();
		logMockWarningOnce();
		// Mock bypasses the tool loop entirely — deterministic for tests.
		void queryFn; // explicitly not called in mock mode
		return mockLlmResponse(systemPrompt, question);
	}

	const tools = [
		{
			type: 'function',
			function: {
				name: 'query_data',
				description: 'Execute a governed SQL query against the database',
				parameters: {
					type: 'object',
					properties: {
						sql: { type: 'string', description: 'SQL query to execute' },
						reason: { type: 'string', description: 'Why this query is needed' },
					},
					required: ['sql', 'reason'],
				},
			},
		},
	];

	const messages: any[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: question },
	];

	// Track the most recent governed-tool result so we can surface a
	// meaningful fallback message when the LLM exits without text — avoids
	// the downstream UI / orchestrator ever seeing a generic "No answer".
	let lastToolResult: unknown = undefined;

	for (let step = 0; step < maxSteps; step++) {
		const response = await callAzureChat(messages, tools);
		const choice = response.choices[0];
		const msg = choice.message;

		if (msg.tool_calls && msg.tool_calls.length > 0) {
			messages.push(msg);
			for (const toolCall of msg.tool_calls) {
				const args = JSON.parse(toolCall.function.arguments);
				const result = await queryFn(args.sql, args.reason);
				lastToolResult = result;
				messages.push({
					role: 'tool',
					content: JSON.stringify(result),
					tool_call_id: toolCall.id,
				});
			}
			continue;
		}

		if (msg.content) {
			return msg.content;
		}

		if (choice.finish_reason === 'stop') break;
	}

	return fallbackAnswerFromToolResult(lastToolResult);
}

/**
 * When the LLM loop ends without a textual answer, derive a best-effort
 * message from the last tool result so callers never see "No response".
 * Callers include: runSubagentStep (then write_finding), the deep-agent
 * orchestrator's task tool, and the single-agent CLI scripts.
 */
function fallbackAnswerFromToolResult(result: unknown): string {
	if (result && typeof result === 'object') {
		const r = result as { status?: unknown; reason?: unknown; error?: unknown };
		if (r.status === 'blocked' && typeof r.reason === 'string' && r.reason.trim()) {
			return `Blocked by governance: ${r.reason}`;
		}
		if (typeof r.error === 'string' && r.error.trim()) {
			return `Tool error: ${r.error}`;
		}
	}
	return 'No answer generated within step limit.';
}

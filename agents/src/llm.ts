/**
 * Shared LLM client — Azure OpenAI or OpenAI.
 *
 * Provides a callLLM function that handles the tool-calling loop.
 * All agents use this instead of duplicating LLM code.
 */

type QueryFn = (sql: string, reason: string) => Promise<unknown>;

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
export async function callLLM(systemPrompt: string, question: string, queryFn: QueryFn, maxSteps = 7): Promise<string> {
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

	for (let step = 0; step < maxSteps; step++) {
		const response = await callAzureChat(messages, tools);
		const choice = response.choices[0];
		const msg = choice.message;

		if (msg.tool_calls && msg.tool_calls.length > 0) {
			messages.push(msg);
			for (const toolCall of msg.tool_calls) {
				const args = JSON.parse(toolCall.function.arguments);
				const result = await queryFn(args.sql, args.reason);
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

	return 'No answer generated within step limit.';
}

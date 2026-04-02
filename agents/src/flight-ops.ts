/**
 * Flight Operations Agent
 *
 * A domain agent that connects to the dazense harness and answers
 * flight operations questions using governed SQL queries.
 *
 * Usage:
 *   AZURE_OPENAI_API_KEY=... AZURE_RESOURCE_NAME=deepmig AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-5.4 \
 *     npx tsx src/flight-ops.ts "Which flights are delayed today?"
 */

import { HarnessClient } from './harness-client.js';

const AGENT_ID = 'flight_ops';
const SESSION_ID = `session-${Date.now()}`;

// Azure OpenAI direct client (bypasses AI SDK schema issues)
async function callAzureChat(
	messages: Array<{ role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string }>,
	tools?: any[],
): Promise<any> {
	const resourceName = process.env.AZURE_RESOURCE_NAME || 'deepmig';
	const deployment = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || 'gpt-5.4';
	const apiKey = process.env.AZURE_OPENAI_API_KEY!;
	const apiVersion = '2024-12-01-preview';

	const url = `https://${resourceName}.cognitiveservices.azure.com/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

	const body: any = {
		messages,
		max_completion_tokens: 1000,
	};
	if (tools) body.tools = tools;

	const resp = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'api-key': apiKey,
		},
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`Azure API error ${resp.status}: ${err}`);
	}

	return resp.json();
}

async function main() {
	const question = process.argv[2] || 'Which flights are delayed today?';
	console.log(`\n🛫 Flight Operations Agent`);
	console.log(`Question: "${question}"\n`);

	// ── Step 1: Connect to harness ──
	console.log('Connecting to harness...');
	const harness = new HarnessClient();
	await harness.connect('../scenario/travel');

	// ── Step 2: Initialize agent ──
	console.log('Initializing agent...');
	const init = (await harness.initializeAgent(AGENT_ID, SESSION_ID, question)) as any;

	console.log(`Identity: ${init.identity.display_name} (${init.identity.role})`);
	console.log(`Bundle: ${init.scope.bundle}`);
	console.log(`Tables: ${init.scope.tables.join(', ')}`);
	console.log(`Rules: ${init.rules.length} applicable`);

	// ── Step 3: Get business rules ──
	const rulesResult = (await harness.getBusinessRules(['flights', 'flight_delays'])) as any;
	const rulesContext = rulesResult.matched_rules
		.map((r: any) => `- [${r.severity}] ${r.name}: ${r.description}\n  Guidance: ${r.guidance}`)
		.join('\n');

	// ── Step 4: Run the agent loop ──
	console.log('\nAsking LLM...\n');

	const systemPrompt = `${init.system_prompt}

You have access to these PostgreSQL tables: ${init.scope.tables.join(', ')}
Maximum rows per query: ${init.constraints.max_rows}
Always include LIMIT in your queries.

Applicable business rules:
${rulesContext}

IMPORTANT: You can ONLY query tables in your bundle. Do NOT query tables outside your scope.
When you have the answer, respond with a clear summary.`;

	const tools = [
		{
			type: 'function',
			function: {
				name: 'query_data',
				description: 'Execute a governed SQL query against the travel database',
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

	// Agent loop — up to 5 tool call rounds
	for (let step = 0; step < 5; step++) {
		const response = await callAzureChat(messages, tools);
		const choice = response.choices[0];
		const msg = choice.message;

		// If model wants to call tools
		if (msg.tool_calls && msg.tool_calls.length > 0) {
			messages.push(msg); // Add assistant message with tool calls

			for (const toolCall of msg.tool_calls) {
				const args = JSON.parse(toolCall.function.arguments);
				console.log(`  📊 Query: ${args.sql}`);
				console.log(`  📝 Reason: ${args.reason}`);

				const result = await harness.queryData(AGENT_ID, args.sql, args.reason);
				const r = result as any;

				if (r.status === 'blocked') {
					console.log(`  ❌ BLOCKED: ${r.reason}\n`);
				} else {
					console.log(`  ✅ ${r.row_count} rows in ${r.execution_time_ms}ms\n`);
				}

				messages.push({
					role: 'tool',
					content: JSON.stringify(result),
					tool_call_id: toolCall.id,
				});
			}
			continue; // Next iteration — model will process tool results
		}

		// Model gave a final text answer
		if (msg.content) {
			console.log('─'.repeat(60));
			console.log('\n📋 Agent Answer:\n');
			console.log(msg.content);

			// Write finding to shared workspace
			await harness.writeFinding(SESSION_ID, AGENT_ID, msg.content, 'high', ['flights', 'flight_delays']);
			console.log('\n✅ Finding written to shared workspace');
			break;
		}

		// Finished without text (shouldn't happen)
		if (choice.finish_reason === 'stop') break;
	}

	await harness.close();
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});

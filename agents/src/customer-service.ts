/**
 * Customer Service Agent — queries customers (PII blocked) via harness.
 *
 * Usage:
 *   AZURE_OPENAI_API_KEY=... npx tsx src/customer-service.ts "How many Gold tier customers?"
 */

import { HarnessClient } from './harness-client.js';
import { callLLM } from './llm.js';
import { runWithRootSpan } from './tracing.js';

const AGENT_ID = 'customer_service';

async function main() {
	const question = process.argv[2] || 'How many customers per loyalty tier?';
	const sessionId = process.argv[3] || `session-${Date.now()}`;
	console.log(`\n👤 Customer Service Agent`);
	console.log(`Question: "${question}"\n`);

	await runWithRootSpan(
		'dazense-agent-customer-service',
		'agent.run',
		{ 'dazense.agent.id': AGENT_ID, 'dazense.session.id': sessionId, 'dazense.question.length': question.length },
		async () => {
			const token = process.env.CUSTOMER_TOKEN;
			const harness = new HarnessClient(AGENT_ID, token);
			await harness.connect('../scenario/travel');

			const init = (await harness.initializeAgent(sessionId, question)) as any;
			console.log(`Identity: ${init.identity.display_name}`);
			console.log(`Tables: ${init.scope.tables.join(', ')}`);
			console.log(`PII blocked: ${init.scope.blocked_columns.join(', ')}\n`);

			const systemPrompt = `${init.system_prompt}
Tables: ${init.scope.tables.join(', ')}
Max rows: ${init.constraints.max_rows}. Always include LIMIT.
PII BLOCKED columns: first_name, last_name, email, phone — NEVER query these.
Use customer_id for identification. Report tier and eligibility only.`;

			const answer = await callLLM(systemPrompt, question, async (sql: string, reason: string) => {
				console.log(`  📊 ${sql.substring(0, 80)}...`);
				return await harness.queryData(sql, reason);
			});

			console.log(`\n📋 Answer: ${answer.substring(0, 200)}`);

			await harness.writeFinding(sessionId, answer, 'high', ['customers']);
			console.log('✅ Finding written');

			await harness.close();
		},
	);
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});

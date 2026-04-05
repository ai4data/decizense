/**
 * Flight Operations Agent — queries flights, delays, airports via harness.
 *
 * Usage:
 *   AZURE_OPENAI_API_KEY=... npx tsx src/flight-ops.ts "Which flights are delayed?"
 */

import { HarnessClient } from './harness-client.js';
import { callLLM } from './llm.js';
import { runWithRootSpan } from './tracing.js';

const AGENT_ID = 'flight_ops';

async function main() {
	const question = process.argv[2] || 'Which flights are delayed today?';
	const sessionId = process.argv[3] || `session-${Date.now()}`;
	console.log(`\n🛫 Flight Operations Agent`);
	console.log(`Question: "${question}"\n`);

	await runWithRootSpan(
		'dazense-agent-flight-ops',
		'agent.run',
		{ 'dazense.agent.id': AGENT_ID, 'dazense.session.id': sessionId, 'dazense.question.length': question.length },
		async () => {
			const token = process.env.OPS_TOKEN;
			const harness = new HarnessClient(AGENT_ID, token);
			await harness.connect('../scenario/travel');

			const init = (await harness.initializeAgent(sessionId, question)) as any;
			console.log(`Identity: ${init.identity.display_name} (${init.identity.auth_method})`);
			console.log(`Tables: ${init.scope.tables.join(', ')}\n`);

			const rules = (await harness.getBusinessRules(['flights', 'flight_delays'])) as any;
			const rulesContext = rules.matched_rules
				.map((r: any) => `- [${r.severity}] ${r.name}: ${r.description}`)
				.join('\n');

			const systemPrompt = `${init.system_prompt}
Tables: ${init.scope.tables.join(', ')}
Max rows: ${init.constraints.max_rows}. Always include LIMIT.
Rules:\n${rulesContext}
ONLY query tables in your bundle. Respond with a clear finding.`;

			const answer = await callLLM(systemPrompt, question, async (sql: string, reason: string) => {
				console.log(`  📊 ${sql.substring(0, 80)}...`);
				return await harness.queryData(sql, reason);
			});

			console.log(`\n📋 Answer: ${answer.substring(0, 200)}`);

			await harness.writeFinding(sessionId, answer, 'high', ['flights', 'flight_delays']);
			console.log('✅ Finding written');

			await harness.close();
		},
	);
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});

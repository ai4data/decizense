/**
 * Booking Agent — queries bookings, tickets, payments via harness.
 *
 * Usage:
 *   AZURE_OPENAI_API_KEY=... npx tsx src/booking.ts "How many bookings in March 2026?"
 */

import { HarnessClient } from './harness-client.js';
import { callLLM } from './llm.js';

const AGENT_ID = 'booking';

async function main() {
	const question = process.argv[2] || 'How many bookings were made in March 2026?';
	const sessionId = process.argv[3] || `session-${Date.now()}`;
	console.log(`\n📋 Booking Agent`);
	console.log(`Question: "${question}"\n`);

	const harness = new HarnessClient();
	await harness.connect('../scenario/travel');

	const init = (await harness.initializeAgent(AGENT_ID, sessionId, question)) as any;
	console.log(`Identity: ${init.identity.display_name}`);
	console.log(`Tables: ${init.scope.tables.join(', ')}\n`);

	const rules = (await harness.getBusinessRules(['bookings', 'tickets', 'payments'])) as any;
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
		return await harness.queryData(AGENT_ID, sql, reason);
	});

	console.log(`\n📋 Answer: ${answer.substring(0, 200)}`);

	await harness.writeFinding(sessionId, AGENT_ID, answer, 'high', ['bookings', 'tickets', 'payments']);
	console.log('✅ Finding written');

	await harness.close();
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});

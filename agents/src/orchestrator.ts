/**
 * Orchestrator Agent — decomposes questions, delegates to domain agents,
 * combines findings into decisions.
 *
 * The orchestrator does NOT query databases directly. It:
 * 1. Gets context from the harness (glossary, lineage, rules)
 * 2. Plans which domain agents to involve
 * 3. Runs each domain agent with a focused sub-question
 * 4. Reads all findings from the shared workspace
 * 5. Combines into a final decision with confidence score
 * 6. Records the outcome with evidence links
 *
 * Usage:
 *   AZURE_OPENAI_API_KEY=... npx tsx src/orchestrator.ts "Will I miss my connection?"
 */

import { HarnessClient } from './harness-client.js';
import { callLLM } from './llm.js';
import { runWithRootSpan } from './tracing.js';

const SESSION_ID = `session-${Date.now()}`;

// Domain agent runner — spawns a harness connection and runs one agent
async function runDomainAgent(agentId: string, subQuestion: string, sessionId: string): Promise<string> {
	// Each domain agent gets its own token from env
	const tokenEnvMap: Record<string, string> = {
		flight_ops: 'OPS_TOKEN',
		booking: 'BOOKING_TOKEN',
		customer_service: 'CUSTOMER_TOKEN',
	};
	const token = process.env[tokenEnvMap[agentId] ?? ''];

	const harness = new HarnessClient(agentId, token);
	await harness.connect('../scenario/travel');

	const init = (await harness.initializeAgent(sessionId, subQuestion)) as any;
	if (!init.identity?.authenticated) {
		await harness.close();
		return `Agent ${agentId} not found`;
	}

	const tables = init.scope.tables?.join(', ') ?? 'none';

	const rules = (await harness.getBusinessRules(
		init.scope.tables?.map((t: string) => t.split('.').pop()) ?? [],
	)) as any;
	const rulesContext = (rules.matched_rules ?? [])
		.map((r: any) => `- [${r.severity}] ${r.name}: ${r.description}`)
		.join('\n');

	const systemPrompt = `${init.system_prompt ?? ''}
Tables: ${tables}
Max rows: ${init.constraints?.max_rows ?? 500}. Always include LIMIT.
${rulesContext ? `Rules:\n${rulesContext}` : ''}
ONLY query tables in your bundle. Be concise. Return a factual finding.`;

	const answer = await callLLM(systemPrompt, subQuestion, async (sql: string, reason: string) => {
		return await harness.queryData(sql, reason);
	});

	// Write finding to shared workspace
	await harness.writeFinding(sessionId, answer, 'high', init.scope.tables ?? []);

	await harness.close();
	return answer;
}

async function main() {
	const question = process.argv[2] || 'Will I miss my connection if flight F1001 is delayed?';
	console.log(`\n🎯 Orchestrator`);
	console.log(`Question: "${question}"\n`);

	await runWithRootSpan(
		'dazense-agent-orchestrator',
		'orchestrator.run',
		{
			'dazense.agent.id': 'orchestrator',
			'dazense.session.id': SESSION_ID,
			'dazense.question.length': question.length,
		},
		async () => {
			// ── Step 1: Get context from harness ──
			console.log('Step 1: Getting context...');
			const token = process.env.ORCHESTRATOR_TOKEN;
			const harness = new HarnessClient('orchestrator', token);
			await harness.connect('../scenario/travel');

			const context = (await harness.callTool('get_context', { question })) as any;

			const glossaryTerms = context.matched_glossary_terms ?? [];
			if (glossaryTerms.length > 0) {
				console.log(`  Glossary matches: ${glossaryTerms.map((t: any) => t.name).join(', ')}`);
			}

			// ── Step 2: Plan — which agents to involve ──
			console.log('\nStep 2: Planning...');

			const orchestratorInit = (await harness.initializeAgent(SESSION_ID, question)) as any;
			const delegateTo = orchestratorInit.constraints?.can_delegate_to ?? [];

			// Get agent details for planning prompt (each needs its own connection)
			const agentDescriptions: string[] = [];
			for (const agentId of delegateTo) {
				const tokenEnvMap: Record<string, string> = {
					flight_ops: 'OPS_TOKEN',
					booking: 'BOOKING_TOKEN',
					customer_service: 'CUSTOMER_TOKEN',
				};
				const agentToken = process.env[tokenEnvMap[agentId] ?? ''];
				const agentHarness = new HarnessClient(agentId, agentToken);
				await agentHarness.connect('../scenario/travel');
				const agentInit = (await agentHarness.initializeAgent(SESSION_ID)) as any;
				if (agentInit.identity?.authenticated) {
					const tables = agentInit.scope?.tables?.join(', ') ?? 'none';
					agentDescriptions.push(`- ${agentId}: ${agentInit.identity.display_name} (tables: ${tables})`);
				}
				await agentHarness.close();
			}

			// Use LLM to decompose the question into sub-tasks
			const planPrompt = `You are an orchestrator that decomposes complex questions.
Given a question, decide which domain agents to involve and what each should investigate.

Available agents:
${agentDescriptions.join('\n')}

Question: "${question}"

Respond ONLY with a JSON object like:
{"agents": [{"id": "agent_id_here", "sub_question": "..."}, ...]}

Include only agents that are needed. Be specific in sub-questions.`;

			const planResponse = await callLLM(planPrompt, 'Plan the investigation', async () => ({}));

			let plan: Array<{ id: string; sub_question: string }>;
			try {
				const jsonMatch = planResponse.match(/\{[\s\S]*\}/);
				const parsed = JSON.parse(jsonMatch?.[0] ?? '{"agents": []}');
				plan = parsed.agents;
			} catch {
				// Default plan if LLM doesn't return valid JSON
				plan = [
					{ id: 'flight_ops', sub_question: question },
					{ id: 'booking', sub_question: question },
				];
			}

			console.log(`  Plan: ${plan.map((a) => `${a.id} → "${a.sub_question.substring(0, 50)}..."`).join(', ')}`);

			// ── Step 3: Run domain agents ──
			console.log('\nStep 3: Running domain agents...');
			const agentResults: Array<{ id: string; answer: string }> = [];

			for (const agent of plan) {
				console.log(`\n  --- ${agent.id} ---`);
				const answer = await runDomainAgent(agent.id, agent.sub_question, SESSION_ID);
				agentResults.push({ id: agent.id, answer });
				console.log(`  Finding: ${answer.substring(0, 100)}...`);
			}

			// ── Step 4: Read all findings ──
			console.log('\nStep 4: Reading findings...');
			const findings = (await harness.callTool('read_findings', { session_id: SESSION_ID })) as any;
			console.log(`  Total findings: ${findings.total ?? findings.findings?.length ?? 0}`);

			// ── Step 5: Combine into decision ──
			console.log('\nStep 5: Combining into decision...');

			const combinePrompt = `You are an orchestrator combining findings from multiple agents into a final decision.

Original question: "${question}"

Agent findings:
${agentResults.map((r) => `[${r.id}]: ${r.answer}`).join('\n\n')}

${glossaryTerms.length > 0 ? `Relevant business terms: ${glossaryTerms.map((t: any) => `${t.name}: ${t.description}`).join('; ')}` : ''}

Provide a clear, actionable decision. Include:
1. Direct answer to the question
2. Key facts from each agent
3. Confidence level (high/medium/low) and why
4. Recommended next action if any`;

			const decision = await callLLM(combinePrompt, 'Combine findings into a decision', async () => ({}));

			// ── Step 6: Record outcome ──
			console.log('\nStep 6: Recording outcome...');

			await harness.callTool('record_outcome', {
				session_id: SESSION_ID,
				question,
				decision_summary: decision.substring(0, 500),
				reasoning: `Combined findings from ${agentResults.map((r) => r.id).join(', ')}. ${glossaryTerms.length} glossary terms matched.`,
				confidence: 'high',
				agents_involved: agentResults.map((r) => r.id),
				cost_usd: 0.15,
				evidence_rules: ['checkin_window', 'rebooking_priority_connections'],
				evidence_signal_types: ['delay_patterns'],
			});

			// ── Final output ──
			console.log('\n' + '═'.repeat(60));
			console.log('\n🎯 ORCHESTRATOR DECISION:\n');
			console.log(decision);
			console.log('\n' + '═'.repeat(60));
			console.log(`\nSession: ${SESSION_ID}`);
			console.log(`Agents consulted: ${agentResults.map((r) => r.id).join(', ')}`);
			console.log('✅ Decision recorded as precedent');

			await harness.close();
		},
	);
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});

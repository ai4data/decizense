/**
 * Phase 1c negative test — production guardrail on the LLM mock.
 *
 * Asserts that DAZENSE_LLM_MOCK=true combined with DAZENSE_PROFILE=production
 * throws (and the error message mentions production). This proves the
 * guardrail in agents/src/llm.ts is actually enforced, not just present.
 *
 * Usage (inside the verification script):
 *   DAZENSE_LLM_MOCK=true DAZENSE_PROFILE=production npx tsx src/test-llm-mock-guardrail.ts
 *
 * Exit codes:
 *   0 — guardrail fired as expected (PASS)
 *   1 — guardrail did NOT fire or the error message was unexpected (FAIL)
 */

import { callLLM } from './llm.js';

async function main(): Promise<void> {
	console.log('🛡️  LLM Mock Production Guardrail Test\n');

	if (process.env.DAZENSE_LLM_MOCK !== 'true') {
		console.error('FAIL: test requires DAZENSE_LLM_MOCK=true to set up the negative condition');
		process.exit(1);
	}
	if (process.env.DAZENSE_PROFILE !== 'production') {
		console.error('FAIL: test requires DAZENSE_PROFILE=production to trigger the guardrail');
		process.exit(1);
	}

	try {
		// This should throw before making any LLM call.
		const result = await callLLM(
			'You are an orchestrator that decomposes complex questions',
			'guardrail test question',
			async () => ({}),
		);
		console.error('FAIL: callLLM did not throw; returned:', result.slice(0, 80));
		process.exit(1);
	} catch (err) {
		const msg = (err as Error).message;
		console.log(`Caught error: ${msg}`);
		if (!msg.includes('production')) {
			console.error('FAIL: error thrown but message does not mention "production"');
			process.exit(1);
		}
		if (!msg.includes('DAZENSE_LLM_MOCK')) {
			console.error('FAIL: error thrown but message does not mention DAZENSE_LLM_MOCK');
			process.exit(1);
		}
		console.log('\n✅ PASS - production guardrail refused the mock as expected');
		process.exit(0);
	}
}

main().catch((err) => {
	console.error('UNEXPECTED:', err);
	process.exit(1);
});

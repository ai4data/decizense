import { randomUUID } from 'node:crypto';
import { HarnessClient } from './harness-client.js';

function assert(cond: boolean, label: string): void {
	if (!cond) throw new Error(`FAIL: ${label}`);
}

async function main(): Promise<void> {
	const caseId = randomUUID();
	const sessionId = `slice-${caseId.slice(0, 8)}`;
	const harness = new HarnessClient('flight_ops');
	await harness.connect();
	harness.setCaseId(caseId);
	await harness.initializeAgent(sessionId, 'slice test');

	// 1) write_finding succeeds (server requires case_id + request_id) and echoes ids
	const finding = (await harness.writeFinding(sessionId, 'slice finding', 'high', ['flights'])) as {
		case_id?: string;
		request_id?: string;
		stored?: boolean;
	};
	assert(finding.stored === true, 'finding stored');
	assert(finding.case_id === caseId, 'finding echoes case_id');
	assert(typeof finding.request_id === 'string', 'finding echoes request_id');

	// 2) PRIOR-RISK PATH: record_outcome retry with the same request_id returns the
	//    prior persisted result (goes through the server's withIdempotentTransaction).
	const outcomeReq = randomUUID();
	const outcomeArgs = {
		session_id: sessionId,
		question: 'why are flights delayed?',
		decision_summary: 'weather',
		reasoning: 'storm front',
		confidence: 'high' as const,
		agents_involved: ['flight_ops'],
		request_id: outcomeReq,
	};
	const firstOutcome = (await harness.callTool('record_outcome', { ...outcomeArgs })) as { outcome_id: string };
	const retryOutcome = (await harness.callTool('record_outcome', { ...outcomeArgs })) as { outcome_id: string };
	assert(typeof firstOutcome.outcome_id === 'string', 'first record_outcome returns outcome_id');
	assert(firstOutcome.outcome_id === retryOutcome.outcome_id, 'record_outcome retry returns prior outcome_id');

	await harness.close();
	console.log('✅ phase 2 vertical slice: ids injected; record_outcome retry returns prior result');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

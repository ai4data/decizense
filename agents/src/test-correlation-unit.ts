import { randomUUID } from 'node:crypto';
import { CORRELATED_TOOLS, withCorrelation } from './correlation.js';

function assert(cond: boolean, label: string): void {
	if (!cond) throw new Error(`FAIL: ${label}`);
}

const caseId = randomUUID();

// Correlated tool: injects case_id + a uuid request_id when absent
const a = withCorrelation('write_finding', { finding: 'x' }, caseId);
assert(a.case_id === caseId, 'write_finding gets case_id');
assert(
	typeof a.request_id === 'string' && (a.request_id as string).length === 36,
	'write_finding gets uuid request_id',
);

// Read-but-correlated tool: also correlated (OPA/audit), not business-state-changing
const q = withCorrelation('query_metrics', { measures: ['flights.delayed_flights'] }, caseId);
assert(q.case_id === caseId && typeof q.request_id === 'string', 'query_metrics is correlated');

// Non-correlated read tool: untouched
const b = withCorrelation('get_entity_details', { entity_id: 'flights' }, caseId);
assert(!('case_id' in b) && !('request_id' in b), 'get_entity_details not correlated');

// Retry: caller-supplied request_id is preserved
const fixed = randomUUID();
const c = withCorrelation('record_outcome', { request_id: fixed, question: 'q' }, caseId);
assert(c.request_id === fixed, 'provided request_id preserved for retry');
assert(c.case_id === caseId, 'record_outcome gets case_id');

assert(!CORRELATED_TOOLS.has('read_findings'), 'read_findings is not correlated');

console.log('✅ correlation helper unit tests pass');

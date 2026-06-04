import { describe, expect, it } from 'vitest';

import { CORRELATED_TOOLS, injectCorrelation, stripCorrelationSchema } from '../src/services/correlation';

const TRUSTED_CASE = '11111111-1111-4111-8111-111111111111';

describe('injectCorrelation (backend — model is untrusted)', () => {
	it('overwrites model-supplied case_id and request_id for correlated tools', () => {
		const out = injectCorrelation(
			'write_finding',
			{ finding: 'x', case_id: 'attacker-case', request_id: 'attacker-req' },
			TRUSTED_CASE,
		);
		expect(out.case_id).toBe(TRUSTED_CASE);
		expect(out.request_id).not.toBe('attacker-req');
		expect(typeof out.request_id).toBe('string');
		expect((out.request_id as string).length).toBe(36);
		expect(out.finding).toBe('x');
	});

	it('strips model-supplied ids and adds none when no trusted caseId (fail-closed)', () => {
		const out = injectCorrelation('record_outcome', { question: 'q', case_id: 'spoof', request_id: 'spoof' });
		expect('case_id' in out).toBe(false);
		expect('request_id' in out).toBe(false);
		expect(out.question).toBe('q');
	});

	it('is a no-op for non-correlated tools', () => {
		const out = injectCorrelation('get_entity_details', { entity_id: 'flights', case_id: 'x' }, TRUSTED_CASE);
		expect(out).toEqual({ entity_id: 'flights', case_id: 'x' });
	});

	it('covers query_metrics as correlated', () => {
		expect(CORRELATED_TOOLS.has('query_metrics')).toBe(true);
		const out = injectCorrelation('query_metrics', { measures: ['flights.delayed'] }, TRUSTED_CASE);
		expect(out.case_id).toBe(TRUSTED_CASE);
		expect(typeof out.request_id).toBe('string');
	});
});

describe('stripCorrelationSchema (hide ids from the model)', () => {
	it('removes case_id/request_id from properties and required', () => {
		const schema = {
			type: 'object',
			properties: {
				finding: { type: 'string' },
				case_id: { type: 'string' },
				request_id: { type: 'string' },
			},
			required: ['finding', 'case_id', 'request_id'],
		};
		const out = stripCorrelationSchema(schema);
		expect(out.properties.case_id).toBeUndefined();
		expect(out.properties.request_id).toBeUndefined();
		expect(out.properties.finding).toBeDefined();
		expect(out.required).toEqual(['finding']);
	});

	it('does not mutate the input schema', () => {
		const schema = { type: 'object', properties: { case_id: { type: 'string' } }, required: ['case_id'] };
		stripCorrelationSchema(schema);
		expect(schema.properties.case_id).toBeDefined();
		expect(schema.required).toEqual(['case_id']);
	});
});

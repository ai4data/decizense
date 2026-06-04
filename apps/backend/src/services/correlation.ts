// Backend correlation. Unlike the agents-side helper (which PRESERVES a
// caller-supplied request_id because those callers are trusted, non-LLM code),
// the backend's only tool caller is the LLM via the AI SDK — which is UNTRUSTED
// for correlation ids. So here we OVERWRITE any model-supplied case_id/request_id
// with trusted values and strip those fields from the schemas the model sees.
import { randomUUID } from 'node:crypto';

/**
 * Correlated tools require case_id + request_id (ContextGraph-MCP Phase 1):
 * business-state-changing tools plus query_data/query_metrics (reads correlated
 * for OPA/audit). Pure reads are excluded.
 */
export const CORRELATED_TOOLS = new Set<string>([
	'query_data',
	'query_metrics',
	'write_finding',
	'propose_decision',
	'approve_decision',
	'execute_decision_action',
	'execute_action',
	'record_outcome',
	'save_memory',
]);

const CORRELATION_FIELDS = ['case_id', 'request_id'] as const;

/**
 * Inject trusted correlation ids for correlated tools, OVERWRITING anything the
 * model supplied: case_id is the trusted per-turn id, request_id is always
 * freshly minted. If no trusted caseId is available, the model-supplied ids are
 * still stripped and none are added — the server then rejects the call
 * (fail-closed), which is correct: the LLM must never control correlation.
 */
export function injectCorrelation(
	toolName: string,
	args: Record<string, unknown>,
	caseId?: string,
): Record<string, unknown> {
	if (!CORRELATED_TOOLS.has(toolName)) {
		return args;
	}
	const rest = { ...args };
	for (const field of CORRELATION_FIELDS) {
		delete rest[field];
	}
	if (!caseId) {
		return rest;
	}
	return { ...rest, case_id: caseId, request_id: randomUUID() };
}

/**
 * Remove case_id/request_id from a model-facing JSON schema so the LLM never
 * sees or is prompted to supply them. Top-level params only (that's where the
 * correlation fields live).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stripCorrelationSchema(schema: any): any {
	if (!schema || typeof schema !== 'object') {
		return schema;
	}
	const stripped = { ...schema };
	if (stripped.properties && typeof stripped.properties === 'object') {
		stripped.properties = { ...stripped.properties };
		for (const field of CORRELATION_FIELDS) {
			delete stripped.properties[field];
		}
	}
	if (Array.isArray(stripped.required)) {
		stripped.required = stripped.required.filter((name: string) => !CORRELATION_FIELDS.includes(name as never));
	}
	return stripped;
}

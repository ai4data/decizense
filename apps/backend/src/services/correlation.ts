// NOTE: kept byte-identical to agents/src/correlation.ts until a shared package
// exists. The backend must NOT import across workspaces (from agents/src).
import { randomUUID } from 'node:crypto';

/**
 * Correlated tools require case_id + request_id (ContextGraph-MCP Phase 1).
 * This includes business-state-changing tools AND query_data/query_metrics,
 * which are reads but must be correlated for OPA decision-log / audit purposes.
 * Pure reads (get_*, read_findings, recall_memory, search_precedent) are excluded.
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

/**
 * Inject case_id (business-case correlation) and a fresh request_id (per-call
 * idempotency) for correlated tools. A caller-supplied request_id is preserved
 * so retries dedupe. Non-correlated tools pass through unchanged.
 */
export function withCorrelation(
	toolName: string,
	args: Record<string, unknown>,
	caseId: string,
): Record<string, unknown> {
	if (!CORRELATED_TOOLS.has(toolName)) {
		return args;
	}
	return {
		...args,
		case_id: args.case_id ?? caseId,
		request_id: args.request_id ?? randomUUID(),
	};
}

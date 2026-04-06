/**
 * OPA HTTP client — Plan v3 Phase 2c.
 *
 * Minimal REST client for an OPA sidecar (docker-compose.opa.yml). The
 * harness calls this to evaluate governance decisions declaratively via
 * policy/dazense.rego + policy/data.json.
 *
 * Phase 2b made OPA authoritative. Phase 2c adds decision logging: every
 * evaluate() call synchronously inserts a row into the decision_logs table
 * with the full input, result, and bundle_revision. This enables the
 * replay_outcome and policy_drift_report admin tools.
 *
 * Configuration:
 *   OPA_URL          default http://localhost:8181
 *   OPA_TIMEOUT_MS   per-request timeout (default 2000)
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeQuery } from '../database/index.js';

export interface OpaParsedSql {
	tables: string[];
	columns: string[];
	has_limit: boolean;
	limit_value: number | null;
	is_read_only: boolean;
	statement_count: number;
	joins: Array<{ left_col: string; right_col: string }>;
}

export interface OpaInput {
	agent_id: string;
	tool_name: 'query_data' | 'query_metrics';
	sql: string;
	metric_refs: string[];
	parsed: OpaParsedSql;
}

export interface OpaViolation {
	check: string;
	detail: string;
}

export interface OpaEvalResult {
	allow: boolean;
	violations: OpaViolation[];
	bundle_revision: string | null;
	/** Unique ID for this decision log entry (Phase 2c). */
	opa_decision_id: string;
}

const OPA_URL = process.env.OPA_URL ?? 'http://localhost:8181';
const OPA_TIMEOUT_MS = Number(process.env.OPA_TIMEOUT_MS ?? 2000);

let cachedBundleRevision: string | null = null;

/**
 * Load the bundle revision from policy/.manifest. The revision is a sha256
 * hash of the sorted data.json computed by policy/build.ts. It's attached
 * to every OpaEvalResult so decision logs can point at an exact bundle
 * state (Phase 2c).
 *
 * Best-effort: if the manifest is missing or unreadable we return null and
 * downstream code treats it as "unknown bundle".
 */
export function getBundleRevision(): string | null {
	if (cachedBundleRevision !== null) return cachedBundleRevision;
	try {
		const __filename = fileURLToPath(import.meta.url);
		const manifestPath = resolve(dirname(__filename), '..', '..', '..', 'policy', '.manifest');
		const raw = readFileSync(manifestPath, 'utf8');
		const parsed = JSON.parse(raw) as { revision?: string };
		cachedBundleRevision = parsed.revision ?? null;
	} catch {
		cachedBundleRevision = null;
	}
	return cachedBundleRevision;
}

/**
 * Health check: is OPA reachable and is the bundle loaded?
 * Used by harness startup when OPA_ENABLED=true so a misconfigured sidecar
 * fails the process fast instead of silently disabling governance.
 */
export async function healthCheck(): Promise<{ ok: boolean; error?: string }> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), OPA_TIMEOUT_MS);
		const resp = await fetch(`${OPA_URL}/health`, { signal: controller.signal });
		clearTimeout(timer);
		if (!resp.ok) return { ok: false, error: `OPA health returned ${resp.status}` };
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Evaluate a governance decision against the OPA policy bundle.
 * Returns { allow, violations[], bundle_revision, opa_decision_id }.
 *
 * Phase 2c: after every evaluation, a row is synchronously inserted into
 * decision_logs with the full input, result, and bundle revision. Logging
 * failures are swallowed (best-effort) — they must never block governance.
 *
 * @param input  The OPA input document (agent_id, sql, parsed, etc.)
 * @param sessionId  Optional MCP session ID for correlation.
 * @param contractId  Optional contract ID assigned by the allow path.
 */
export async function evaluate(input: OpaInput, sessionId?: string, contractId?: string): Promise<OpaEvalResult> {
	const url = `${OPA_URL}/v1/data/dazense/governance/result`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), OPA_TIMEOUT_MS);
	const decisionId = `opa-${randomUUID()}`;
	const bundleRevision = getBundleRevision();

	let evalResult: OpaEvalResult;

	try {
		const resp = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ input }),
			signal: controller.signal,
		});

		if (!resp.ok) {
			evalResult = {
				allow: false,
				violations: [{ check: 'opa_error', detail: `OPA HTTP ${resp.status}` }],
				bundle_revision: bundleRevision,
				opa_decision_id: decisionId,
			};
		} else {
			const body = (await resp.json()) as { result?: { allow?: boolean; violations?: OpaViolation[] } };
			const result = body.result;
			if (!result || typeof result.allow !== 'boolean') {
				evalResult = {
					allow: false,
					violations: [{ check: 'opa_error', detail: 'OPA returned malformed result' }],
					bundle_revision: bundleRevision,
					opa_decision_id: decisionId,
				};
			} else {
				evalResult = {
					allow: result.allow,
					violations: result.violations ?? [],
					bundle_revision: bundleRevision,
					opa_decision_id: decisionId,
				};
			}
		}
	} catch (err) {
		evalResult = {
			allow: false,
			violations: [{ check: 'opa_error', detail: err instanceof Error ? err.message : String(err) }],
			bundle_revision: bundleRevision,
			opa_decision_id: decisionId,
		};
	} finally {
		clearTimeout(timer);
	}

	// Phase 2c: log the decision (best-effort, never blocks governance)
	logDecision(decisionId, input, evalResult, sessionId, contractId).catch((err) => {
		process.stderr.write(`[opa-client] decision log write failed (swallowed): ${err}\n`);
	});

	return evalResult;
}

/**
 * Insert a decision log row. Best-effort — callers .catch() errors.
 */
async function logDecision(
	decisionId: string,
	input: OpaInput,
	result: OpaEvalResult,
	sessionId?: string,
	contractId?: string,
): Promise<void> {
	const sqlHash = input.sql ? createHash('sha256').update(input.sql).digest('hex').slice(0, 64) : null;
	await executeQuery(
		`INSERT INTO decision_logs
			(opa_decision_id, bundle_revision, agent_id, session_id, tool_name,
			 sql_hash, input, result, allowed, contract_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		[
			decisionId,
			result.bundle_revision ?? 'unknown',
			input.agent_id,
			sessionId ?? null,
			input.tool_name,
			sqlHash,
			JSON.stringify(input),
			JSON.stringify({ allow: result.allow, violations: result.violations }),
			result.allow,
			contractId ?? null,
		],
	);
}

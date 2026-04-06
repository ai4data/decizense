/**
 * OPA HTTP client — Plan v3 Phase 2a.
 *
 * Minimal REST client for an OPA sidecar (docker-compose.opa.yml). The
 * harness calls this to evaluate governance decisions declaratively via
 * policy/dazense.rego + policy/data.json.
 *
 * Phase 2a: OPA runs in SHADOW mode. `evaluate()` is called alongside the
 * in-code governance pipeline and results are compared; mismatches are
 * logged. The in-code result is still returned to the caller.
 * Phase 2b:  OPA becomes authoritative and the in-code rules are deleted.
 *
 * Configuration:
 *   OPA_URL          default http://localhost:8181
 *   OPA_ENABLED      if "true" the harness startup performs a health check
 *                    and loads the bundle revision. If OPA is unreachable
 *                    in that mode, the harness fails fast.
 *   OPA_TIMEOUT_MS   per-request timeout (default 2000)
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * Returns { allow, violations[], bundle_revision }.
 *
 * On ANY error (network, OPA error, shape mismatch) returns allow=false with
 * a synthetic violation. The caller (Phase 2a shadow hook) should treat
 * errors as "evaluation failed, log and move on" — the in-code result is
 * still authoritative in 2a. In 2b the harness should fail-closed.
 */
export async function evaluate(input: OpaInput): Promise<OpaEvalResult> {
	const url = `${OPA_URL}/v1/data/dazense/governance/result`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), OPA_TIMEOUT_MS);

	try {
		const resp = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ input }),
			signal: controller.signal,
		});

		if (!resp.ok) {
			return {
				allow: false,
				violations: [{ check: 'opa_error', detail: `OPA HTTP ${resp.status}` }],
				bundle_revision: getBundleRevision(),
			};
		}

		const body = (await resp.json()) as { result?: { allow?: boolean; violations?: OpaViolation[] } };
		const result = body.result;
		if (!result || typeof result.allow !== 'boolean') {
			return {
				allow: false,
				violations: [{ check: 'opa_error', detail: 'OPA returned malformed result' }],
				bundle_revision: getBundleRevision(),
			};
		}

		return {
			allow: result.allow,
			violations: result.violations ?? [],
			bundle_revision: getBundleRevision(),
		};
	} catch (err) {
		return {
			allow: false,
			violations: [{ check: 'opa_error', detail: err instanceof Error ? err.message : String(err) }],
			bundle_revision: getBundleRevision(),
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Governance shadow comparator — Plan v3 Phase 2a.
 *
 * The harness still uses the in-code governance pipeline as the source of
 * truth. When OPA_SHADOW=true, every call to evaluateGovernance also fires
 * this helper, which:
 *
 *   1. builds an OpaInput from the same parsed SQL the in-code rules saw
 *   2. POSTs it to the OPA sidecar
 *   3. compares the OPA verdict to the in-code verdict
 *   4. logs any disagreement to stderr with enough context to debug
 *
 * Nothing in the harness request path depends on the comparison result.
 * Failures are swallowed; the shadow is fire-and-forget.
 *
 * When Phase 2b lands, evaluateGovernance's body is replaced with a direct
 * call to opaClient.evaluate() and this helper is deleted.
 */

import { evaluate as opaEvaluate, type OpaInput, type OpaParsedSql } from './opa-client.js';
import type { GovernanceResult } from './index.js';

export interface ShadowParsedSql {
	tables: string[];
	columns: string[];
	hasLimit: boolean;
	limitValue: number | null;
	isReadOnly: boolean;
	statementCount: number;
	joins: Array<{ leftCol: string; rightCol: string }>;
}

/**
 * Convert the in-code parseSql shape into the flat snake_case shape the
 * Rego policy expects. Keeping this mapping in one place lets Phase 2b
 * delete the wrapper in one edit.
 */
function toOpaParsed(parsed: ShadowParsedSql): OpaParsedSql {
	return {
		tables: parsed.tables,
		columns: parsed.columns,
		has_limit: parsed.hasLimit,
		limit_value: parsed.limitValue,
		is_read_only: parsed.isReadOnly,
		statement_count: parsed.statementCount,
		joins: parsed.joins.map((j) => ({ left_col: j.leftCol, right_col: j.rightCol })),
	};
}

export interface ShadowContext {
	agentId: string;
	toolName: 'query_data' | 'query_metrics';
	sql: string | null;
	metricRefs: string[];
	parsed: ShadowParsedSql | null;
}

/**
 * Fire-and-forget comparison of the in-code result vs. OPA. Returns a
 * Promise the caller may or may not await. Errors are logged and never
 * thrown so shadow mode can never affect the request path.
 */
export async function shadowCompare(ctx: ShadowContext, inCodeResult: GovernanceResult): Promise<void> {
	if (process.env.OPA_SHADOW !== 'true') return;

	try {
		const input: OpaInput = {
			agent_id: ctx.agentId,
			tool_name: ctx.toolName,
			sql: ctx.sql ?? '',
			metric_refs: ctx.metricRefs,
			parsed: ctx.parsed
				? toOpaParsed(ctx.parsed)
				: {
						tables: [],
						columns: [],
						has_limit: false,
						limit_value: null,
						is_read_only: true,
						statement_count: 0,
						joins: [],
					},
		};

		const opaResult = await opaEvaluate(input);

		// Skip synthetic opa_error violations from the comparison — those
		// indicate an OPA-side problem, not a policy disagreement.
		const opaSynthetic = opaResult.violations.some((v) => v.check === 'opa_error');
		if (opaSynthetic) {
			process.stderr.write(
				`[opa-shadow] OPA error during shadow compare, skipping: ${JSON.stringify(opaResult.violations)}\n`,
			);
			return;
		}

		const agree = inCodeResult.allowed === opaResult.allow;
		if (!agree) {
			process.stderr.write(
				`[opa-shadow] MISMATCH agent=${ctx.agentId} tool=${ctx.toolName} ` +
					`in_code=${inCodeResult.allowed} opa=${opaResult.allow}\n` +
					`  in_code_reason: ${inCodeResult.reason ?? '(none)'}\n` +
					`  opa_violations: ${JSON.stringify(opaResult.violations)}\n` +
					`  sql: ${(ctx.sql ?? '').slice(0, 200)}\n`,
			);
			return;
		}

		// Same verdict — also check the reason maps to at least one OPA
		// violation when blocked. This catches cases where both say "deny"
		// but for different reasons (a subtle drift we want to see).
		if (!inCodeResult.allowed && opaResult.violations.length > 0) {
			const inCodeCheck = (inCodeResult.checks ?? []).find((c) => !c.passed)?.name;
			const opaChecks = new Set(opaResult.violations.map((v) => v.check));
			if (inCodeCheck && !opaChecks.has(inCodeCheck)) {
				process.stderr.write(
					`[opa-shadow] REASON-DRIFT agent=${ctx.agentId} both=deny ` +
						`in_code_check=${inCodeCheck} opa_checks=${[...opaChecks].join(',')}\n`,
				);
			}
		}
	} catch (err) {
		process.stderr.write(
			`[opa-shadow] comparison threw (swallowed): ${err instanceof Error ? err.message : String(err)}\n`,
		);
	}
}

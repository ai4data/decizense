/**
 * Pure evaluator for BusinessRule.check metadata.
 *
 * The harness used to hardcode string matches on specific travel rule
 * names (revenue_excludes_cancelled, pii_customer_data, compensation_
 * threshold) inside tools/verify.ts. This module replaces that with a
 * generic evaluator driven entirely by each rule's declared `check`
 * block. A rule without a `check` reports `manual-verification-needed`
 * — the right honest answer when the scenario hasn't given us a way
 * to verify mechanically.
 *
 * No imports from database, catalog, auth, or MCP — keeps the
 * evaluator side-effect-free and unit-testable without harness
 * bootstrap.
 */

import type { BusinessRule, PatternSet, RuleCheck } from '../config/index.js';

export interface RuleCheckInput {
	sql?: string;
	resultSummary?: string;
	/** Normalised PII column names the bundle blocks (e.g. "first_name"). */
	piiColumnNames?: Set<string>;
}

export type CheckOutcome =
	| { status: 'pass'; method: RuleCheck['kind'] | 'none'; detail: string }
	| { status: 'fail'; method: RuleCheck['kind']; detail: string; message?: string }
	| { status: 'not_applicable'; method: RuleCheck['kind']; detail: string }
	| { status: 'manual'; method: 'manual' | 'none'; detail: string };

export interface RuleCheckResult {
	rule: string;
	severity: BusinessRule['severity'];
	outcome: CheckOutcome;
}

export function evaluateRule(rule: BusinessRule, input: RuleCheckInput): RuleCheckResult {
	const base = { rule: rule.name, severity: rule.severity };
	const check = rule.check;

	if (!check) {
		return {
			...base,
			outcome: {
				status: 'manual',
				method: 'none',
				detail: `Rule "${rule.name}" has no machine-checkable definition — manual verification required.`,
			},
		};
	}

	switch (check.kind) {
		case 'sql_pattern':
			return {
				...base,
				outcome: evaluatePattern(check.applies_when, check.require, input.sql, 'sql_pattern', check.message),
			};
		case 'text_pattern':
			return {
				...base,
				outcome: evaluatePattern(
					check.applies_when,
					check.require,
					input.resultSummary,
					'text_pattern',
					check.message,
				),
			};
		case 'pii_columns':
			return { ...base, outcome: evaluatePii(input.sql ?? '', input.piiColumnNames ?? new Set(), check.message) };
		case 'query_result':
			// Query execution is a side effect — evaluated by the caller.
			return {
				...base,
				outcome: {
					status: 'manual',
					method: 'manual',
					detail: `Rule "${rule.name}" uses a query_result check; caller must execute and compare.`,
				},
			};
		case 'manual':
			return {
				...base,
				outcome: {
					status: 'manual',
					method: 'manual',
					detail: check.message ?? `Rule "${rule.name}" is verified out-of-band.`,
				},
			};
	}
}

function evaluatePattern(
	applies_when: PatternSet | undefined,
	require: PatternSet | undefined,
	candidate: string | undefined,
	method: 'sql_pattern' | 'text_pattern',
	message: string | undefined,
): CheckOutcome {
	if (candidate === undefined) {
		return {
			status: 'not_applicable',
			method,
			detail: `No ${method === 'sql_pattern' ? 'SQL' : 'result text'} supplied.`,
		};
	}
	const text = candidate.toLowerCase();

	if (applies_when) {
		const gateMatches = patternMatches(text, applies_when);
		if (!gateMatches.ok) {
			return {
				status: 'not_applicable',
				method,
				detail: `Gate (applies_when) did not match: ${gateMatches.reason}`,
			};
		}
	}

	if (!require) {
		return { status: 'pass', method, detail: 'Gate matched and no further constraints.' };
	}

	const required = patternMatches(text, require);
	if (required.ok) {
		return { status: 'pass', method, detail: 'All required patterns satisfied.' };
	}
	return {
		status: 'fail',
		method,
		detail: required.reason,
		message,
	};
}

function patternMatches(text: string, set: PatternSet): { ok: true } | { ok: false; reason: string } {
	for (const tok of set.require_all ?? []) {
		if (!text.includes(tok.toLowerCase())) {
			return { ok: false, reason: `Missing required token "${tok}"` };
		}
	}
	if (set.require_any && set.require_any.length > 0) {
		const anyFound = set.require_any.some((tok) => text.includes(tok.toLowerCase()));
		if (!anyFound) {
			return { ok: false, reason: `None of the alternative tokens present: ${set.require_any.join(', ')}` };
		}
	}
	for (const tok of set.forbid_any ?? []) {
		if (text.includes(tok.toLowerCase())) {
			return { ok: false, reason: `Forbidden token "${tok}" present` };
		}
	}
	return { ok: true };
}

function evaluatePii(sql: string, piiColumnNames: Set<string>, message: string | undefined): CheckOutcome {
	const text = sql.toLowerCase();
	if (piiColumnNames.size === 0) {
		return {
			status: 'not_applicable',
			method: 'pii_columns',
			detail: 'No PII columns declared in scenario policy.',
		};
	}
	const hits: string[] = [];
	for (const col of piiColumnNames) {
		const needle = col.toLowerCase();
		// Word-boundary-ish match: column name surrounded by non-identifier characters.
		const re = new RegExp(`(^|[^a-z0-9_])${escapeRegex(needle)}([^a-z0-9_]|$)`);
		if (re.test(text)) {
			hits.push(col);
		}
	}
	if (hits.length > 0) {
		return {
			status: 'fail',
			method: 'pii_columns',
			detail: `PII columns referenced: ${hits.join(', ')}`,
			message,
		};
	}
	return { status: 'pass', method: 'pii_columns', detail: 'No PII columns referenced.' };
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generic business rules matcher.
 *
 * Given a contract's tables, metric refs, and SQL columns, this module finds
 * which business rules from business_rules.yml are relevant. It works for any
 * project — the matching is purely based on the `applies_to` field of each rule.
 *
 * Matching strategy (applied per rule, per `applies_to` entry):
 *   - "orders"                → matches any table whose name ends with "orders"
 *   - "orders.total_revenue"  → matches metric ref "orders.total_revenue"
 *   - "customers.first_name"  → matches table+column reference
 *
 * The matcher normalises both sides (strips schema prefix like "main.") so
 * "main.orders" matches "orders" and vice versa.
 */

import type { BusinessRuleInfo } from '../agents/user-rules';

export interface MatchContext {
	/** Tables referenced in the query, e.g. ["main.orders", "main.customers"] */
	tables: string[];
	/** Metric refs from semantic model, e.g. ["orders.total_revenue"] */
	metric_refs?: string[];
	/** SQL query string (for column-level matching) */
	sql_query?: string;
	/** Explicit column references, e.g. ["first_name", "status"] */
	columns?: string[];
}

export interface MatchedRule {
	name: string;
	severity: string;
	category: string;
	matched_on: string[];
}

/**
 * Returns all business rules whose `applies_to` entries overlap with the
 * contract's tables, metrics, or columns.
 */
export function matchBusinessRules(rules: BusinessRuleInfo[], context: MatchContext): MatchedRule[] {
	const matched: MatchedRule[] = [];

	// Normalise tables: "main.orders" → ["orders", "main.orders"]
	const tableNames = new Set<string>();
	for (const t of context.tables) {
		tableNames.add(t);
		const shortName = t.includes('.') ? t.split('.').pop()! : t;
		tableNames.add(shortName);
	}

	// Normalise metric refs
	const metricRefs = new Set(context.metric_refs ?? []);

	// SQL lowercase for column matching
	const sqlLower = context.sql_query?.toLowerCase();

	// Explicit columns
	const explicitColumns = new Set((context.columns ?? []).map((c) => c.toLowerCase()));

	for (const rule of rules) {
		if (!rule.applies_to || rule.applies_to.length === 0) {
			continue;
		}

		const matchedOn: string[] = [];

		for (const ref of rule.applies_to) {
			// ref can be: "orders", "orders.total_revenue", "customers.first_name"
			const parts = ref.split('.');
			const refTable = parts[0]; // e.g. "orders" or "customers"
			const refField = parts[1]; // e.g. "total_revenue", "first_name", or undefined

			if (!refField) {
				// Table-level rule: matches if any contract table matches
				if (tableNames.has(refTable)) {
					matchedOn.push(ref);
				}
			} else {
				// Field-level rule: could be a metric ref or a column ref

				// 1. Check metric refs (exact match)
				if (metricRefs.has(ref)) {
					matchedOn.push(ref);
					continue;
				}

				// 2. Check if the table is in scope AND the field appears in SQL or columns
				if (tableNames.has(refTable)) {
					// Check explicit columns
					if (explicitColumns.has(refField.toLowerCase())) {
						matchedOn.push(ref);
						continue;
					}
					// Check SQL text
					if (sqlLower && sqlLower.includes(refField.toLowerCase())) {
						matchedOn.push(ref);
						continue;
					}
					// For metric refs that look like "model.measure", also check if the
					// table is referenced even without explicit column match — the rule
					// is still relevant context for that table's measures
					if (tableNames.has(refTable) && metricRefs.size > 0) {
						// Check if any metric ref starts with the same model name
						for (const mr of metricRefs) {
							if (mr.startsWith(`${refTable}.`)) {
								matchedOn.push(ref);
								break;
							}
						}
					}
				}
			}
		}

		if (matchedOn.length > 0) {
			matched.push({
				name: rule.name,
				severity: rule.severity,
				category: rule.category,
				matched_on: [...new Set(matchedOn)],
			});
		}
	}

	return matched;
}

/**
 * Returns just the rule names — convenience wrapper for populating
 * `guidance_rules_referenced` in the contract.
 */
export function getReferencedRuleNames(rules: BusinessRuleInfo[], context: MatchContext): string[] {
	return matchBusinessRules(rules, context).map((r) => r.name);
}

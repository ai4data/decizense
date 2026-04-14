/**
 * SQL compiler — QueryPlan → { sql, params }.
 *
 * Pure: no DB, no MCP. Emits a parameterised PostgreSQL statement.
 * Values never appear in the SQL text — every value lives in
 * `plan.params` and is referenced via $1, $2, …
 *
 * Identifier discipline: every column / table / alias the compiler
 * touches comes from the registry (which loaded scenario YAML); the
 * caller has no way to inject identifiers. Identifiers are
 * double-quoted to survive reserved words and case-sensitivity.
 */

import type {
	CompiledSql,
	HavingPredicate,
	PlannedDimension,
	PlannedJoin,
	PlannedMeasure,
	PlannedModel,
	QueryPlan,
	WherePredicate,
} from './types.js';

export function compile(plan: QueryPlan): CompiledSql {
	const select = buildSelect(plan.dimensions, plan.measures);
	const from = buildFrom(plan.models[0]);
	const joins = buildJoins(plan.models, plan.joins);
	const where = buildWhere(plan.whereFilters);
	const groupBy = buildGroupBy(plan.dimensions);
	const having = buildHaving(plan.havingFilters);
	const orderBy = buildOrderBy(plan.orderBy);
	// LIMIT is bound as a positional pg parameter (its index is set by
	// the planner) so no integer literal is interpolated into SQL text.
	const limit = `LIMIT $${plan.limitParamIndex}`;

	const parts = [select, from, joins, where, groupBy, having, orderBy, limit].filter((s) => s && s.length > 0);
	const sql = parts.join('\n');

	return {
		sql,
		params: [...plan.params],
		debug: {
			models: plan.models.map((m) => `${m.schema}.${m.table} AS "${m.alias}"`),
			measures: plan.measures.map((m) => `${m.expression} AS "${m.outputAlias}"`),
			dimensions: plan.dimensions.map((d) => formatDimensionExpression(d)),
		},
	};
}

// ── SELECT ────────────────────────────────────────────────────────────────

function buildSelect(dims: PlannedDimension[], measures: PlannedMeasure[]): string {
	const dimCols = dims.map((d) => `${formatDimensionExpression(d)} AS ${q(d.outputAlias)}`);
	const measCols = measures.map((m) => `${m.expression} AS ${q(m.outputAlias)}`);
	if (dimCols.length === 0 && measCols.length === 0) return 'SELECT 1';
	return `SELECT ${[...dimCols, ...measCols].join(', ')}`;
}

function formatDimensionExpression(d: PlannedDimension): string {
	if (d.timeGrain) {
		// Grain literal is in plan.params at d.timeGrainParamIndex; pg
		// accepts date_trunc(text, timestamp), so a placeholder works.
		// Cast keeps pg's type inference happy when the param is bound
		// as text.
		return `date_trunc($${d.timeGrainParamIndex}::text, ${qualifyColumn(d.column)})`;
	}
	return qualifyColumn(d.column);
}

// ── FROM / JOIN ───────────────────────────────────────────────────────────

function buildFrom(primary: PlannedModel): string {
	return `FROM ${q(primary.schema)}.${q(primary.table)} AS ${q(primary.alias)}`;
}

function buildJoins(models: PlannedModel[], joins: PlannedJoin[]): string {
	if (joins.length === 0) return '';
	const lines: string[] = [];
	const aliasIndex = new Map(models.map((m) => [m.alias, m]));
	for (const j of joins) {
		const right = aliasIndex.get(j.rightAlias);
		if (!right) continue;
		lines.push(
			`INNER JOIN ${q(right.schema)}.${q(right.table)} AS ${q(right.alias)} ON ${qualifyColumn(j.leftAlias + '.' + j.leftColumn)} = ${qualifyColumn(j.rightAlias + '.' + j.rightColumn)}`,
		);
	}
	return lines.join('\n');
}

// ── WHERE / HAVING ────────────────────────────────────────────────────────

function buildWhere(filters: WherePredicate[]): string {
	if (filters.length === 0) return '';
	const parts = filters.map((f) => renderPredicate(qualifyColumn(f.column), f.operator, f.paramIndices));
	return `WHERE ${parts.join(' AND ')}`;
}

function buildHaving(filters: HavingPredicate[]): string {
	if (filters.length === 0) return '';
	const parts = filters.map((f) => renderPredicate(`(${f.measureExpression})`, f.operator, f.paramIndices));
	return `HAVING ${parts.join(' AND ')}`;
}

function renderPredicate(lhs: string, operator: string, paramIndices: number[]): string {
	switch (operator) {
		case '=':
		case '!=':
		case '<':
		case '<=':
		case '>':
		case '>=':
			return `${lhs} ${operator} $${paramIndices[0]}`;
		case 'in':
			return `${lhs} IN (${paramIndices.map((i) => `$${i}`).join(', ')})`;
		case 'not_in':
			return `${lhs} NOT IN (${paramIndices.map((i) => `$${i}`).join(', ')})`;
		case 'is_null':
			return `${lhs} IS NULL`;
		case 'is_not_null':
			return `${lhs} IS NOT NULL`;
		case 'between':
			return `${lhs} BETWEEN $${paramIndices[0]} AND $${paramIndices[1]}`;
		default:
			throw new Error(`Unrenderable operator "${operator}"`);
	}
}

// ── GROUP BY / ORDER BY ───────────────────────────────────────────────────

function buildGroupBy(dims: PlannedDimension[]): string {
	if (dims.length === 0) return '';
	// Reference dimensions by their SELECT-list position (1-indexed) so
	// time-grain expressions don't have to be repeated. Postgres accepts
	// positional GROUP BY references.
	const positions = dims.map((_, i) => String(i + 1));
	return `GROUP BY ${positions.join(', ')}`;
}

function buildOrderBy(orderBy: { expression: string; direction: 'asc' | 'desc' }[]): string {
	if (orderBy.length === 0) return '';
	const parts = orderBy.map((o) => `${q(o.expression)} ${o.direction.toUpperCase()}`);
	return `ORDER BY ${parts.join(', ')}`;
}

// ── Identifier quoting ────────────────────────────────────────────────────

/**
 * Double-quote an identifier, escaping any embedded double quotes.
 * Inputs are scenario-defined (table / column / alias names from YAML)
 * — never user-supplied values — so this is defence-in-depth, not the
 * primary safety boundary.
 */
function q(ident: string): string {
	return `"${ident.replace(/"/g, '""')}"`;
}

/**
 * Take a "alias.column" or "column" and quote each component.
 */
function qualifyColumn(ref: string): string {
	const parts = ref.split('.');
	if (parts.length === 1) return q(parts[0]);
	return parts.map(q).join('.');
}

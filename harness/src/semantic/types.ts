/**
 * Semantic compiler — IR + public request/response types.
 *
 * The flow is request → planner → plan → sql-compiler → executor.
 * Everything here is data; the modules that build / consume these
 * types are pure (no harness, no DB, no MCP) and unit-testable in
 * isolation.
 *
 * Naming convention:
 *   "ref"   — caller-visible token like "flights.delayed_flights"
 *   "field" — the bare suffix after the dot, e.g. "delayed_flights"
 *   "model" — a SemanticModelEntry (one row in semantic_model.yml)
 */

// ── Request (caller-supplied) ──────────────────────────────────────────────

export type ComparisonOp = '=' | '!=' | '<' | '<=' | '>' | '>=';
export type SetOp = 'in' | 'not_in';
export type NullOp = 'is_null' | 'is_not_null';
export type RangeOp = 'between';
export type FilterOp = ComparisonOp | SetOp | NullOp | RangeOp;

export type FilterValue = string | number | boolean | null;

export interface RequestFilter {
	/** Dimension or measure ref. Measure refs go to HAVING after planning. */
	field: string;
	operator: FilterOp;
	/** Single value for comparison ops; ignored for null ops. */
	value?: FilterValue;
	/** For `in` / `not_in`. */
	values?: FilterValue[];
	/** For `between` — inclusive [low, high]. */
	range?: [FilterValue, FilterValue];
}

export interface TimeRange {
	/** ISO-8601 inclusive lower bound. */
	start: string;
	/** ISO-8601 exclusive upper bound. */
	end: string;
}

export type TimeGrain = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour';

export interface OrderBy {
	/** Either a measure or dimension ref. */
	field: string;
	direction: 'asc' | 'desc';
}

export interface MetricQueryRequest {
	measures: string[]; // required, at least one
	dimensions?: string[];
	filters?: RequestFilter[];
	time_range?: TimeRange;
	/**
	 * Truncate the dominant time dimension to this grain and group by
	 * the truncated value. Mutually compatible with explicit dimensions.
	 */
	time_grain?: TimeGrain;
	order_by?: OrderBy[];
	limit?: number;
}

// ── Resolved IR (planner output) ───────────────────────────────────────────

/**
 * One semantic model that participates in the query, with the alias
 * the compiler will use for it.
 */
export interface PlannedModel {
	name: string;
	alias: string;
	schema: string;
	table: string;
	/** Time-dimension column name (bare, no model prefix), if declared. */
	timeDimensionColumn: string | null;
}

export interface PlannedJoin {
	leftAlias: string;
	leftColumn: string;
	rightAlias: string;
	rightColumn: string;
	/**
	 * Detected cardinality based on the column on each side. Conservative:
	 * if uncertain we mark as 'one_to_many' which makes the planner refuse
	 * raw aggregates across the join.
	 */
	cardinality: 'one_to_one' | 'one_to_many' | 'many_to_many';
}

export interface PlannedMeasure {
	ref: string; // e.g. "bookings.total_revenue"
	field: string; // "total_revenue"
	modelAlias: string;
	/** SQL fragment, e.g. "SUM(bookings.total_amount)". Pre-built by planner. */
	expression: string;
	/** Output alias the compiler will use (== field for now). */
	outputAlias: string;
}

export interface PlannedDimension {
	ref: string; // e.g. "bookings.airline_code"
	field: string;
	modelAlias: string;
	/** Fully qualified column, e.g. "bookings.airline_code". */
	column: string;
	outputAlias: string;
	/** If set, GROUP BY uses date_trunc(grain, column) instead of column. */
	timeGrain?: TimeGrain;
	/**
	 * When timeGrain is set, the grain literal is stamped into
	 * QueryPlan.params and the placeholder index lives here. Compiler
	 * emits `date_trunc($N, column)` with no string interpolation.
	 */
	timeGrainParamIndex?: number;
}

/**
 * A predicate that lives in WHERE (pre-aggregation) — i.e. it filters
 * raw rows before grouping. References dimension columns only.
 */
export interface WherePredicate {
	column: string; // qualified, e.g. "bookings.status"
	operator: FilterOp;
	/** Indices into QueryPlan.params. Always at least one for non-null ops. */
	paramIndices: number[];
}

/**
 * A predicate that lives in HAVING (post-aggregation) — i.e. it filters
 * the aggregated result. References measure aliases.
 */
export interface HavingPredicate {
	measureExpression: string; // the SQL fragment of the measure being filtered
	operator: FilterOp;
	paramIndices: number[];
}

export interface PlannedOrderBy {
	expression: string; // either a measure expression or a column
	direction: 'asc' | 'desc';
}

export interface QueryPlan {
	/** Ordered for deterministic SQL output. */
	models: PlannedModel[];
	joins: PlannedJoin[];
	measures: PlannedMeasure[];
	dimensions: PlannedDimension[];
	whereFilters: WherePredicate[];
	havingFilters: HavingPredicate[];
	orderBy: PlannedOrderBy[];
	limit: number;
	/**
	 * Index into params holding the integer LIMIT value. Compiler emits
	 * `LIMIT $N` rather than interpolating a literal.
	 */
	limitParamIndex: number;
	/**
	 * The actual time window applied (after time_range and time_grain),
	 * surfaced in the response so callers can see what was queried.
	 */
	appliedTimeWindow: { column: string; start: string; end: string; grain?: TimeGrain } | null;
	/**
	 * Positional pg parameters in declaration order. SQL placeholders
	 * are $1, $2, ... matching this array's indices + 1.
	 */
	params: unknown[];
}

// ── Compiler output ────────────────────────────────────────────────────────

export interface CompiledSql {
	sql: string;
	params: unknown[];
	/** Useful for logging / debugging; same as plan, echoed for convenience. */
	debug?: { models: string[]; measures: string[]; dimensions: string[] };
}

// ── Executor output ────────────────────────────────────────────────────────

export interface MetricQueryResult {
	status: 'ok';
	rows: Record<string, unknown>[];
	row_count: number;
	generated_sql: string;
	resolved_measures: Array<{ ref: string; expression: string }>;
	resolved_dimensions: Array<{ ref: string; column: string; time_grain?: TimeGrain }>;
	applied_time_window: { column: string; start: string; end: string; grain?: TimeGrain } | null;
	governance: {
		policy_version: string | null;
		contract_id?: string;
	};
}

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * Reasons the compiler / planner / executor refuses to run. Each maps
 * to a structured response shape returned from query_metrics. Codes are
 * stable strings so callers can branch on them.
 */
export type SemanticErrorCode =
	| 'unknown_measure'
	| 'unknown_dimension'
	| 'ambiguous_ref'
	| 'unknown_model'
	| 'measure_required'
	| 'invalid_aggregation'
	| 'invalid_operator'
	| 'invalid_value'
	| 'invalid_time_range'
	| 'invalid_time_grain'
	| 'no_time_dimension'
	| 'out_of_bundle'
	| 'disallowed_join'
	| 'fanout_refused'
	| 'time_filter_required'
	| 'governance_blocked'
	| 'execution_failed';

export class SemanticError extends Error {
	readonly code: SemanticErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: SemanticErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = 'SemanticError';
		this.code = code;
		this.details = details;
	}

	toResponse(): { status: 'error'; code: SemanticErrorCode; reason: string; details: Record<string, unknown> } {
		return { status: 'error', code: this.code, reason: this.message, details: this.details };
	}
}

// ── Constants ──────────────────────────────────────────────────────────────

export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 50_000;

export const ALLOWED_AGGREGATIONS = new Set(['count', 'count_distinct', 'sum', 'avg', 'min', 'max']);

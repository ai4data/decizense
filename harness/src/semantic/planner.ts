/**
 * Semantic planner — MetricQueryRequest → QueryPlan.
 *
 * Pure: only depends on the registry, the request, and the agent's
 * scope (bundle tables + allowed_joins + time-filter requirements).
 * No SQL is built here; the SQL compiler does that.
 *
 * Responsibilities:
 *   1. Validate every measure / dimension ref against the registry.
 *   2. Compose measure-level filters with the user's filters.
 *   3. Split filters into pre-aggregation (WHERE) vs post-aggregation
 *      (HAVING) buckets by classifying their target ref.
 *   4. Enforce bundle scope and allowed_joins.
 *   5. Translate time_range and time_grain into pg-bound parameters
 *      and a date_trunc dimension when appropriate.
 *   6. Detect fan-out joins across multiple models and refuse to
 *      compute raw aggregates that would silently double-count.
 */

import type { BundleConfig, SemanticModelEntry } from '../config/index.js';

import type {
	FilterOp,
	HavingPredicate,
	MetricQueryRequest,
	OrderBy,
	PlannedDimension,
	PlannedJoin,
	PlannedMeasure,
	PlannedModel,
	PlannedOrderBy,
	QueryPlan,
	RequestFilter,
	TimeGrain,
	WherePredicate,
} from './types.js';
import { DEFAULT_LIMIT, MAX_LIMIT, SemanticError } from './types.js';
import type { SemanticRegistry } from './registry.js';

export interface AgentScope {
	/**
	 * Tables in the agent's bundle, as bare names (e.g. ["flights",
	 * "flight_delays"]). Used to gate which models the request may use.
	 */
	bundleTables: Set<string>;
	bundleId: string;
	/** Bundle joins; planner uses only joins both of whose sides are in scope. */
	bundleJoins: BundleConfig['joins'];
	/** Time-filter requirements (table, column, max_days). */
	timeFilters: BundleConfig['time_filters'];
}

const SET_OPS = new Set<FilterOp>(['in', 'not_in']);
const NULL_OPS = new Set<FilterOp>(['is_null', 'is_not_null']);
const RANGE_OPS = new Set<FilterOp>(['between']);

export function plan(request: MetricQueryRequest, registry: SemanticRegistry, scope: AgentScope): QueryPlan {
	if (!request.measures || request.measures.length === 0) {
		throw new SemanticError('measure_required', 'At least one measure is required.');
	}

	const params: unknown[] = [];
	const recordParam = (v: unknown): number => {
		params.push(v);
		return params.length;
	};

	// ── Resolve measures, derive participating models ─────────────────────
	const resolvedMeasures = request.measures.map((ref) => registry.resolveMeasure(ref));
	const measureModels = new Set<string>();
	for (const m of resolvedMeasures) measureModels.add(m.model.name);

	// ── Resolve dimensions ────────────────────────────────────────────────
	const resolvedDimensions = (request.dimensions ?? []).map((ref) => registry.resolveDimension(ref));
	const dimensionModels = new Set<string>();
	for (const d of resolvedDimensions) dimensionModels.add(d.model.name);

	// ── Bundle-scope check ─────────────────────────────────────────────────
	const allParticipatingModels = new Set([...measureModels, ...dimensionModels]);
	for (const m of allParticipatingModels) {
		const model = registry.getModel(m)!;
		if (!scope.bundleTables.has(model.table.table)) {
			throw new SemanticError(
				'out_of_bundle',
				`Model "${m}" maps to table "${model.table.schema}.${model.table.table}" which is not in bundle "${scope.bundleId}".`,
				{ bundle: scope.bundleId, allowed_tables: Array.from(scope.bundleTables) },
			);
		}
	}

	// ── Build PlannedModel list (deterministic order: alphabetical) ───────
	const modelNames = Array.from(allParticipatingModels).sort();
	const modelByAlias = new Map<string, PlannedModel>();
	const planned: PlannedModel[] = modelNames.map((name) => {
		const m = registry.getModel(name)!;
		const pm: PlannedModel = {
			name,
			alias: name, // alias === model name; deterministic and human-readable
			schema: m.table.schema,
			table: m.table.table,
			timeDimensionColumn: m.time_dimension ?? null,
		};
		modelByAlias.set(pm.alias, pm);
		return pm;
	});

	// ── Joins ─────────────────────────────────────────────────────────────
	const joins: PlannedJoin[] = [];
	if (planned.length > 1) {
		const primary = planned[0];
		for (let i = 1; i < planned.length; i++) {
			const other = planned[i];
			const edge = registry.getJoin(primary.name, other.name);
			if (!edge || !joinIsInBundleScope(edge, scope.bundleJoins)) {
				throw new SemanticError(
					'disallowed_join',
					`No allowed join between "${primary.name}" and "${other.name}" in bundle "${scope.bundleId}".`,
					{
						bundle: scope.bundleId,
						declared_in_bundle: (scope.bundleJoins ?? []).map(
							(j) => `${j.left.table}.${j.left.column} = ${j.right.table}.${j.right.column}`,
						),
					},
				);
			}
			// Normalise orientation so leftAlias is always the model that's
			// already in the FROM clause (primary) and rightAlias is the new
			// model being joined in. Without this, a bundle join authored as
			// "flight_delays.flight_id = flights.flight_id" with primary=
			// flights would produce a self-join on flights — the rightAlias
			// column comes from edge.rightModel which equals primary.
			//
			// Cardinality stays one_to_many — see fanout-refusal note below.
			const primaryIsLeft = edge.leftModel === primary.name;
			joins.push({
				leftAlias: primary.alias,
				leftColumn: primaryIsLeft ? edge.leftColumn : edge.rightColumn,
				rightAlias: other.alias,
				rightColumn: primaryIsLeft ? edge.rightColumn : edge.leftColumn,
				cardinality: 'one_to_many',
			});
		}

		// Fanout refusal: if the request mixes a non-distinct sum/count
		// across a one_to_many join, the result will double-count.
		const fanoutJoin = joins.find((j) => j.cardinality !== 'one_to_one');
		if (fanoutJoin) {
			const offending = resolvedMeasures.find(
				(m) => ['sum', 'count', 'avg'].includes(m.measure.aggregation) && measureModels.has(m.model.name),
			);
			if (offending && measureModels.size > 1) {
				throw new SemanticError(
					'fanout_refused',
					`Refusing to compute "${offending.ref}" across a one-to-many join (${fanoutJoin.leftAlias} → ${fanoutJoin.rightAlias}) — would double-count rows on the parent side. Aggregate per-model, or request a count_distinct measure.`,
					{
						join: `${fanoutJoin.leftAlias}.${fanoutJoin.leftColumn} = ${fanoutJoin.rightAlias}.${fanoutJoin.rightColumn}`,
						participating_models: Array.from(measureModels),
					},
				);
			}
		}
	}

	// ── Plan measures (build SQL expressions) ─────────────────────────────
	const measures: PlannedMeasure[] = resolvedMeasures.map((rm) => {
		const expr = buildMeasureExpression(rm.model, rm.measure, recordParam);
		return {
			ref: rm.ref,
			field: rm.measure.name,
			modelAlias: rm.model.name,
			expression: expr,
			outputAlias: rm.measure.name,
		};
	});

	// ── Plan dimensions (apply optional time_grain) ───────────────────────
	const dimensions: PlannedDimension[] = resolvedDimensions.map((rd) => {
		const baseColumn = `${rd.model.name}.${rd.dimension.column}`;
		const isTime = rd.dimension.column === rd.model.time_dimension;
		return {
			ref: rd.ref,
			field: rd.dimension.name,
			modelAlias: rd.model.name,
			column: baseColumn,
			outputAlias: rd.dimension.name,
			timeGrain: request.time_grain && isTime ? request.time_grain : undefined,
		};
	});

	// ── Time range → WHERE filter on the primary time dimension ──────────
	let appliedTimeWindow: QueryPlan['appliedTimeWindow'] = null;
	const whereFilters: WherePredicate[] = [];
	if (request.time_range) {
		const tr = request.time_range;
		validateTimeRange(tr);
		const tdModel = pickTimeDimensionModel(planned, modelByAlias, registry);
		if (!tdModel) {
			throw new SemanticError(
				'no_time_dimension',
				'time_range was supplied but no participating model declares a time_dimension.',
				{ models: planned.map((p) => p.name) },
			);
		}
		const col = `${tdModel.alias}.${tdModel.timeDimensionColumn}`;
		whereFilters.push({
			column: col,
			operator: '>=',
			paramIndices: [recordParam(tr.start)],
		});
		whereFilters.push({
			column: col,
			operator: '<',
			paramIndices: [recordParam(tr.end)],
		});
		appliedTimeWindow = { column: col, start: tr.start, end: tr.end, grain: request.time_grain };
	}

	// ── User filters → WHERE / HAVING split ──────────────────────────────
	const havingFilters: HavingPredicate[] = [];
	for (const f of request.filters ?? []) {
		const cls = registry.classifyRef(f.field);
		if (cls === 'dimension') {
			whereFilters.push(buildWherePredicate(f, registry, recordParam));
		} else {
			havingFilters.push(buildHavingPredicate(f, registry, recordParam));
		}
	}

	// ── Time-filter requirements ─────────────────────────────────────────
	// Bundle declares the requirement as { table, column, max_days } —
	// table is the database name. Our WHERE predicates reference columns
	// as "<modelAlias>.<column>", and modelAlias may differ from the
	// table name when scenario-author names the model differently
	// (e.g. model "delays" over table "flight_delays"). Map the
	// requirement to the planned model that backs that table before
	// comparing.
	for (const req of scope.timeFilters ?? []) {
		const planForReqTable = planned.find((p) => p.table === req.table);
		if (!planForReqTable) continue;
		const col = `${planForReqTable.alias}.${req.column}`;
		const onCol = whereFilters.filter((w) => w.column === col);
		if (onCol.length === 0) {
			throw new SemanticError(
				'time_filter_required',
				`Bundle "${scope.bundleId}" requires a time filter on ${col} (max ${req.max_days} days).`,
				{ table: req.table, column: req.column, max_days: req.max_days, model_alias: planForReqTable.alias },
			);
		}
		// Enforce max_days. Look for a lower bound (>= or >) and an upper
		// bound (< or <=). If either side is missing or the values don't
		// parse as dates, refuse — the requirement is "the query must be
		// bounded to ≤ max_days", which we can only verify when both ends
		// are present and parseable.
		const lower = onCol.find((w) => w.operator === '>=' || w.operator === '>');
		const upper = onCol.find((w) => w.operator === '<' || w.operator === '<=');
		if (!lower || !upper) {
			throw new SemanticError(
				'time_filter_required',
				`Bundle "${scope.bundleId}" requires a bounded time window on ${col} (max ${req.max_days} days). Supply both a lower (>= or >) and an upper (< or <=) bound.`,
				{ table: req.table, column: req.column, max_days: req.max_days, model_alias: planForReqTable.alias },
			);
		}
		const startVal = params[lower.paramIndices[0] - 1];
		const endVal = params[upper.paramIndices[0] - 1];
		const startMs = parseToMs(startVal);
		const endMs = parseToMs(endVal);
		if (startMs === null || endMs === null) {
			throw new SemanticError(
				'time_filter_required',
				`Bundle "${scope.bundleId}" requires a parseable time window on ${col} (got start=${String(startVal)}, end=${String(endVal)}).`,
				{ table: req.table, column: req.column, max_days: req.max_days, model_alias: planForReqTable.alias },
			);
		}
		const widthDays = Math.ceil((endMs - startMs) / 86_400_000);
		if (widthDays > req.max_days) {
			throw new SemanticError(
				'time_filter_required',
				`Time window on ${col} is ${widthDays} days; bundle "${scope.bundleId}" allows at most ${req.max_days}.`,
				{
					table: req.table,
					column: req.column,
					max_days: req.max_days,
					actual_days: widthDays,
					start: String(startVal),
					end: String(endVal),
					model_alias: planForReqTable.alias,
				},
			);
		}
	}

	// ── Order by ──────────────────────────────────────────────────────────
	const orderBy: PlannedOrderBy[] = (request.order_by ?? []).map((o) => buildOrderBy(o, measures, dimensions));

	// ── Limit ─────────────────────────────────────────────────────────────
	const limit = clampLimit(request.limit);

	return {
		models: planned,
		joins,
		measures,
		dimensions,
		whereFilters,
		havingFilters,
		orderBy,
		limit,
		appliedTimeWindow,
		params,
	};
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildMeasureExpression(
	model: SemanticModelEntry,
	measure: SemanticModelEntry['measures'][number],
	recordParam: (v: unknown) => number,
): string {
	const col = `${model.name}.${measure.column}`;
	const inner =
		measure.aggregation === 'count_distinct'
			? `COUNT(DISTINCT ${col})`
			: `${aggToSql(measure.aggregation)}(${col})`;
	const filterClauses: string[] = [];
	for (const f of measure.filters ?? []) {
		assertSimpleOperator(f.operator);
		const idx = recordParam(f.value);
		filterClauses.push(`${model.name}.${f.column} ${f.operator} $${idx}`);
	}
	if (filterClauses.length === 0) return inner;
	return `${inner} FILTER (WHERE ${filterClauses.join(' AND ')})`;
}

function aggToSql(agg: string): string {
	switch (agg) {
		case 'count':
			return 'COUNT';
		case 'sum':
			return 'SUM';
		case 'avg':
			return 'AVG';
		case 'min':
			return 'MIN';
		case 'max':
			return 'MAX';
		default:
			throw new SemanticError('invalid_aggregation', `Unsupported aggregation "${agg}".`);
	}
}

function assertSimpleOperator(op: string): void {
	if (!['=', '!=', '<', '<=', '>', '>='].includes(op)) {
		throw new SemanticError(
			'invalid_operator',
			`Measure-level filter operator must be a simple comparison (got "${op}").`,
		);
	}
}

function buildWherePredicate(
	f: RequestFilter,
	registry: SemanticRegistry,
	recordParam: (v: unknown) => number,
): WherePredicate {
	const dim = registry.resolveDimension(f.field);
	const column = `${dim.model.name}.${dim.dimension.column}`;
	return buildPredicate(f, recordParam, (op, idxs) => ({ column, operator: op, paramIndices: idxs }));
}

function buildHavingPredicate(
	f: RequestFilter,
	registry: SemanticRegistry,
	recordParam: (v: unknown) => number,
): HavingPredicate {
	const meas = registry.resolveMeasure(f.field);
	const measureExpression = buildMeasureExpression(meas.model, meas.measure, recordParam);
	return buildPredicate(f, recordParam, (op, idxs) => ({ measureExpression, operator: op, paramIndices: idxs }));
}

function buildPredicate<T>(
	f: RequestFilter,
	recordParam: (v: unknown) => number,
	mk: (op: FilterOp, paramIndices: number[]) => T,
): T {
	const op = f.operator;
	if (NULL_OPS.has(op)) return mk(op, []);
	if (SET_OPS.has(op)) {
		if (!f.values || f.values.length === 0) {
			throw new SemanticError('invalid_value', `Operator "${op}" requires non-empty "values".`, {
				field: f.field,
			});
		}
		return mk(op, f.values.map(recordParam));
	}
	if (RANGE_OPS.has(op)) {
		if (!f.range || f.range.length !== 2) {
			throw new SemanticError('invalid_value', `Operator "${op}" requires "range": [low, high].`, {
				field: f.field,
			});
		}
		return mk(op, [recordParam(f.range[0]), recordParam(f.range[1])]);
	}
	if (f.value === undefined || f.value === null) {
		throw new SemanticError('invalid_value', `Operator "${op}" requires "value".`, { field: f.field });
	}
	return mk(op, [recordParam(f.value)]);
}

function buildOrderBy(o: OrderBy, measures: PlannedMeasure[], dimensions: PlannedDimension[]): PlannedOrderBy {
	const m = measures.find((x) => x.ref === o.field || x.field === o.field || x.outputAlias === o.field);
	if (m) return { expression: m.outputAlias, direction: o.direction };
	const d = dimensions.find((x) => x.ref === o.field || x.field === o.field || x.outputAlias === o.field);
	if (d) return { expression: d.outputAlias, direction: o.direction };
	throw new SemanticError('unknown_dimension', `order_by field "${o.field}" is not a selected measure or dimension.`);
}

function pickTimeDimensionModel(
	planned: PlannedModel[],
	modelByAlias: Map<string, PlannedModel>,
	registry: SemanticRegistry,
): PlannedModel | null {
	void registry; // reserved for future preference logic
	void modelByAlias;
	const withTd = planned.find((p) => p.timeDimensionColumn);
	return withTd ?? null;
}

function validateTimeRange(tr: { start: string; end: string }): void {
	const ok = (s: string) => /^\d{4}-\d{2}-\d{2}(T|$)/.test(s);
	if (!ok(tr.start) || !ok(tr.end)) {
		throw new SemanticError('invalid_time_range', `time_range start/end must be ISO-8601 dates.`, {
			time_range: tr,
		});
	}
	if (tr.start >= tr.end) {
		throw new SemanticError('invalid_time_range', `time_range start must be < end.`, { time_range: tr });
	}
}

function clampLimit(n?: number): number {
	if (n === undefined) return DEFAULT_LIMIT;
	if (!Number.isInteger(n) || n <= 0) {
		throw new SemanticError('invalid_value', `limit must be a positive integer (got ${n}).`);
	}
	return Math.min(n, MAX_LIMIT);
}

/**
 * Confirm the registry-provided edge is also explicitly declared in
 * the agent's bundle. Comparison is on (table, column) pairs and is
 * direction-agnostic.
 */
function joinIsInBundleScope(
	edge: ReturnType<SemanticRegistry['getJoin']>,
	bundleJoins: AgentScope['bundleJoins'],
): boolean {
	if (!edge || !bundleJoins) return false;
	const leftKey = `${edge.source.left.table}.${edge.source.left.column}`;
	const rightKey = `${edge.source.right.table}.${edge.source.right.column}`;
	return bundleJoins.some((j) => {
		const a = `${j.left.table}.${j.left.column}`;
		const b = `${j.right.table}.${j.right.column}`;
		return (a === leftKey && b === rightKey) || (a === rightKey && b === leftKey);
	});
}

/**
 * Parse a stored param value into epoch ms, or null if it doesn't
 * look like a date. Accepts ISO strings (the only shape time_range
 * values are stored in today) and Date instances.
 */
function parseToMs(v: unknown): number | null {
	if (v instanceof Date) {
		const t = v.getTime();
		return Number.isFinite(t) ? t : null;
	}
	if (typeof v === 'string') {
		const t = Date.parse(v);
		return Number.isFinite(t) ? t : null;
	}
	return null;
}

export function timeGrainToSqlUnit(grain: TimeGrain): string {
	switch (grain) {
		case 'year':
			return 'year';
		case 'quarter':
			return 'quarter';
		case 'month':
			return 'month';
		case 'week':
			return 'week';
		case 'day':
			return 'day';
		case 'hour':
			return 'hour';
	}
}

/**
 * Semantic registry — indexed view of `semantic_model.yml` + bundle joins.
 *
 * Pure: takes the parsed YAML structures (already loaded by the
 * scenario loader) and exposes lookup helpers + structural validation.
 * No DB, no MCP, no harness imports beyond config types.
 *
 * Resolution rules:
 *   - "model.field" — fully qualified, the only supported form.
 *   - bare "field"  — rejected with `ambiguous_ref` even when unique.
 *     Forces the request to be self-documenting; avoids cross-scenario
 *     surprises when a name later collides.
 */

import type {
	BundleConfig,
	BundleJoin,
	SemanticDimension,
	SemanticMeasure,
	SemanticModel,
	SemanticModelEntry,
} from '../config/index.js';

import { ALLOWED_AGGREGATIONS, SemanticError } from './types.js';

export interface ResolvedMeasure {
	ref: string;
	model: SemanticModelEntry;
	measure: SemanticMeasure;
}

export interface ResolvedDimension {
	ref: string;
	model: SemanticModelEntry;
	dimension: SemanticDimension;
}

export interface JoinEdge {
	leftModel: string;
	leftColumn: string;
	rightModel: string;
	rightColumn: string;
	/** Original BundleJoin (kept for diagnostics). */
	source: BundleJoin;
}

export class SemanticRegistry {
	private readonly modelsByName: Map<string, SemanticModelEntry>;
	private readonly modelByTable: Map<string, SemanticModelEntry>;
	private readonly joinsByPair: Map<string, JoinEdge>; // key = "a|b" sorted

	constructor(model: SemanticModel, bundles: BundleConfig[]) {
		this.modelsByName = new Map();
		this.modelByTable = new Map();
		this.joinsByPair = new Map();

		for (const m of model.models) {
			if (this.modelsByName.has(m.name)) {
				throw new SemanticError('ambiguous_ref', `Duplicate semantic model name "${m.name}".`);
			}
			this.modelsByName.set(m.name, m);
			this.modelByTable.set(`${m.table.schema}.${m.table.table}`, m);
			this.validateModel(m);
		}

		// Index joins from every bundle — at planner time we further
		// constrain to joins inside the agent's bundle.
		for (const bundle of bundles) {
			for (const j of bundle.joins ?? []) {
				const left = this.modelByTable.get(`${j.left.schema}.${j.left.table}`);
				const right = this.modelByTable.get(`${j.right.schema}.${j.right.table}`);
				if (!left || !right) continue;
				const edge: JoinEdge = {
					leftModel: left.name,
					leftColumn: j.left.column,
					rightModel: right.name,
					rightColumn: j.right.column,
					source: j,
				};
				const key = pairKey(left.name, right.name);
				if (!this.joinsByPair.has(key)) this.joinsByPair.set(key, edge);
			}
		}
	}

	// ── Lookup ────────────────────────────────────────────────────────────

	getModel(name: string): SemanticModelEntry | undefined {
		return this.modelsByName.get(name);
	}

	listModels(): SemanticModelEntry[] {
		return Array.from(this.modelsByName.values());
	}

	resolveMeasure(ref: string): ResolvedMeasure {
		const { model, field } = this.splitRef(ref, 'measure');
		const measure = model.measures.find((m) => m.name === field);
		if (!measure) {
			throw new SemanticError('unknown_measure', `Unknown measure "${ref}".`, {
				model: model.name,
				field,
				available: model.measures.map((m) => `${model.name}.${m.name}`),
				suggestion: closestName(
					field,
					model.measures.map((m) => m.name),
				),
			});
		}
		return { ref, model, measure };
	}

	resolveDimension(ref: string): ResolvedDimension {
		const { model, field } = this.splitRef(ref, 'dimension');
		const dimension = model.dimensions.find((d) => d.name === field);
		if (!dimension) {
			throw new SemanticError('unknown_dimension', `Unknown dimension "${ref}".`, {
				model: model.name,
				field,
				available: model.dimensions.map((d) => `${model.name}.${d.name}`),
				suggestion: closestName(
					field,
					model.dimensions.map((d) => d.name),
				),
			});
		}
		return { ref, model, dimension };
	}

	/**
	 * Try to resolve `ref` as either a measure or a dimension. Used by
	 * the filter-classifier to decide WHERE vs HAVING.
	 */
	classifyRef(ref: string): 'measure' | 'dimension' {
		const { model, field } = this.splitRef(ref, 'field');
		if (model.measures.some((m) => m.name === field)) return 'measure';
		if (model.dimensions.some((d) => d.name === field)) return 'dimension';
		throw new SemanticError('unknown_dimension', `Unknown ref "${ref}".`, {
			model: model.name,
			field,
		});
	}

	getJoin(modelA: string, modelB: string): JoinEdge | undefined {
		return this.joinsByPair.get(pairKey(modelA, modelB));
	}

	// ── Internals ─────────────────────────────────────────────────────────

	private splitRef(ref: string, kind: string): { model: SemanticModelEntry; field: string } {
		const dot = ref.indexOf('.');
		if (dot < 0) {
			throw new SemanticError('ambiguous_ref', `${kind} ref "${ref}" must be qualified as "<model>.<field>".`, {
				available_models: Array.from(this.modelsByName.keys()),
			});
		}
		const modelName = ref.slice(0, dot);
		const field = ref.slice(dot + 1);
		const model = this.modelsByName.get(modelName);
		if (!model) {
			throw new SemanticError('unknown_model', `Unknown model "${modelName}" in ref "${ref}".`, {
				available_models: Array.from(this.modelsByName.keys()),
			});
		}
		if (!field) {
			throw new SemanticError('ambiguous_ref', `Empty field in ref "${ref}".`);
		}
		return { model, field };
	}

	private validateModel(m: SemanticModelEntry): void {
		const dimNames = new Set<string>();
		for (const d of m.dimensions ?? []) {
			if (dimNames.has(d.name)) {
				throw new SemanticError('ambiguous_ref', `Duplicate dimension "${m.name}.${d.name}".`);
			}
			dimNames.add(d.name);
		}
		const measureNames = new Set<string>();
		for (const meas of m.measures ?? []) {
			if (measureNames.has(meas.name)) {
				throw new SemanticError('ambiguous_ref', `Duplicate measure "${m.name}.${meas.name}".`);
			}
			measureNames.add(meas.name);
			if (!ALLOWED_AGGREGATIONS.has(meas.aggregation)) {
				throw new SemanticError(
					'invalid_aggregation',
					`Measure "${m.name}.${meas.name}" uses unsupported aggregation "${meas.aggregation}".`,
					{ allowed: Array.from(ALLOWED_AGGREGATIONS) },
				);
			}
		}
		// Dimension and measure names must not collide — otherwise classifyRef
		// can't decide WHERE vs HAVING.
		for (const name of dimNames) {
			if (measureNames.has(name)) {
				throw new SemanticError(
					'ambiguous_ref',
					`Name "${m.name}.${name}" is used by both a dimension and a measure.`,
				);
			}
		}
	}
}

function pairKey(a: string, b: string): string {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Levenshtein-ish closest-name suggestion for "did you mean?" hints.
 * Tiny, dependency-free.
 */
function closestName(target: string, candidates: string[]): string | undefined {
	let best: { name: string; dist: number } | undefined;
	for (const c of candidates) {
		const d = editDistance(target, c);
		if (!best || d < best.dist) best = { name: c, dist: d };
	}
	return best && best.dist <= Math.max(2, Math.floor(target.length / 3)) ? best.name : undefined;
}

function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	const dp: number[] = new Array(n + 1);
	for (let j = 0; j <= n; j++) dp[j] = j;
	for (let i = 1; i <= m; i++) {
		let prev = dp[0];
		dp[0] = i;
		for (let j = 1; j <= n; j++) {
			const tmp = dp[j];
			dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
			prev = tmp;
		}
	}
	return dp[n];
}

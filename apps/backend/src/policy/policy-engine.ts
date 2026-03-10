import type { CheckResultSchema, DatasetBundle, PolicyConfig } from '@dazense/shared/tools/build-contract';
import type z from 'zod/v3';

import type { SemanticModelInfo } from '../agents/user-rules';

type CheckResult = z.infer<typeof CheckResultSchema>;

export type PolicyDecision =
	| { status: 'allow'; checks: CheckResult[] }
	| { status: 'block'; reason: string; fixes: string[]; checks: CheckResult[] }
	| { status: 'needs_clarification'; questions: string[]; checks: CheckResult[] };

interface ContractDraft {
	bundle_id?: string | null;
	tables: string[];
	joins?: Array<{
		left: { schema: string; table: string; column: string };
		right: { schema: string; table: string; column: string };
	}>;
	metric_refs?: string[];
	time_window?: { type?: string; resolved_start?: string; resolved_end?: string };
	tool: 'execute_sql' | 'query_metrics';
	params: Record<string, unknown>;
	ambiguity?: { is_ambiguous: boolean; notes: string[] };
}

interface EvaluatePolicyOptions {
	/** Semantic models loaded from semantic_model.yml. Used to validate metric_refs. */
	semanticModels?: SemanticModelInfo[] | null;
	/** Matched business rules for this query. Used to add advisory checks. */
	matchedBusinessRules?: Array<{ name: string; severity: string; category: string; matched_on: string[] }>;
}

/**
 * Pure policy evaluation function. No file I/O.
 *
 * Runs checks in order and collects all results. Returns the worst outcome:
 * block > needs_clarification > allow.
 */
export function evaluatePolicy(
	draft: ContractDraft,
	policy: PolicyConfig,
	bundles: DatasetBundle[],
	options?: EvaluatePolicyOptions,
): PolicyDecision {
	const checks: CheckResult[] = [];
	const blockReasons: string[] = [];
	const fixes: string[] = [];
	const questions: string[] = [];

	const selectedBundle = draft.bundle_id ? bundles.find((b) => b.bundle_id === draft.bundle_id) : undefined;

	// ── 0. Ambiguity check ──
	if (draft.ambiguity?.is_ambiguous) {
		const ambiguityNotes = draft.ambiguity.notes;
		questions.push(...ambiguityNotes.map((note) => note));
		if (questions.length === 0) {
			questions.push('The question is ambiguous. Please clarify your intent.');
		}
		checks.push({
			name: 'ambiguity_check',
			status: 'fail',
			detail: `Ambiguous request: ${ambiguityNotes.join('; ') || 'multiple interpretations possible'}.`,
		});
	} else {
		checks.push({ name: 'ambiguity_check', status: 'pass' });
	}

	// ── 1. Bundle requirement check ──
	if (policy.execution.require_bundle && !draft.bundle_id) {
		const bundleNames = bundles.map((b) => b.bundle_id);
		questions.push(`Which dataset bundle should we use? Available: ${bundleNames.join(', ')}`);
		checks.push({
			name: 'bundle_required',
			status: 'fail',
			detail: 'Policy requires a dataset bundle but none was specified.',
		});
	} else if (draft.bundle_id && !selectedBundle) {
		blockReasons.push(`Unknown bundle: "${draft.bundle_id}".`);
		fixes.push(`Use one of: ${bundles.map((b) => b.bundle_id).join(', ')}`);
		checks.push({
			name: 'bundle_exists',
			status: 'fail',
			detail: `Bundle "${draft.bundle_id}" not found.`,
		});
	} else {
		checks.push({ name: 'bundle_required', status: 'pass' });
	}

	// ── 2. Bundle tables check ──
	if (selectedBundle && policy.joins.enforce_bundle_allowlist) {
		const allowedTables = new Set(selectedBundle.tables.map((t) => `${t.schema}.${t.table}`));

		for (const table of draft.tables) {
			if (!allowedTables.has(table)) {
				blockReasons.push(`Table "${table}" is not in bundle "${selectedBundle.bundle_id}".`);
				fixes.push(`Allowed tables: ${[...allowedTables].join(', ')}`);
				checks.push({
					name: 'bundle_tables_only',
					status: 'fail',
					detail: `Table "${table}" not in bundle.`,
				});
			}
		}

		if (!checks.some((c) => c.name === 'bundle_tables_only' && c.status === 'fail')) {
			checks.push({ name: 'bundle_tables_only', status: 'pass' });
		}
	} else if (!selectedBundle && draft.bundle_id === undefined) {
		// No bundle selected and not required — pass with warning
		checks.push({
			name: 'bundle_tables_only',
			status: 'warn',
			detail: 'No bundle selected; table allowlist not enforced.',
		});
	} else {
		checks.push({ name: 'bundle_tables_only', status: 'pass' });
	}

	// ── 3. Join allowlist check ──
	if (selectedBundle && policy.joins.enforce_bundle_allowlist && draft.joins && draft.joins.length > 0) {
		for (const join of draft.joins) {
			const leftKey = `${join.left.schema}.${join.left.table}.${join.left.column}`;
			const rightKey = `${join.right.schema}.${join.right.table}.${join.right.column}`;

			const allowed = selectedBundle.joins.some((bj) => {
				const bjLeft = `${bj.left.schema}.${bj.left.table}.${bj.left.column}`;
				const bjRight = `${bj.right.schema}.${bj.right.table}.${bj.right.column}`;
				// Match in either direction
				return (bjLeft === leftKey && bjRight === rightKey) || (bjLeft === rightKey && bjRight === leftKey);
			});

			if (!allowed) {
				blockReasons.push(`Join ${leftKey} ↔ ${rightKey} is not in the bundle's allowlist.`);
				fixes.push('Only use joins defined in the dataset bundle.');
				checks.push({
					name: 'bundle_join_allowlist',
					status: 'fail',
					detail: `Join ${leftKey} ↔ ${rightKey} not allowed.`,
				});
			}
		}

		if (!checks.some((c) => c.name === 'bundle_join_allowlist' && c.status === 'fail')) {
			checks.push({ name: 'bundle_join_allowlist', status: 'pass' });
		}
	} else {
		checks.push({ name: 'bundle_join_allowlist', status: 'pass' });
	}

	// ── 4. PII block check ──
	if (policy.pii.mode === 'block') {
		const piiColumns = policy.pii.columns;
		// Check if any draft tables have PII columns referenced in params
		// We check against the SQL columns if available in params
		const sqlQuery = draft.params.sql_query as string | undefined;
		const piiViolations: string[] = [];

		for (const table of draft.tables) {
			const blockedCols = piiColumns[table];
			if (!blockedCols || blockedCols.length === 0) {
				continue;
			}

			// If we have a SQL query, do a basic text check for PII column names
			if (sqlQuery) {
				const sqlLower = sqlQuery.toLowerCase();
				for (const col of blockedCols) {
					if (sqlLower.includes(col.toLowerCase())) {
						piiViolations.push(`${table}.${col}`);
					}
				}
			}
		}

		if (piiViolations.length > 0) {
			blockReasons.push(`PII columns referenced: ${piiViolations.join(', ')}.`);
			fixes.push('Remove PII columns from the query. These columns are blocked by policy.');
			checks.push({
				name: 'pii_block',
				status: 'fail',
				detail: `PII violation: ${piiViolations.join(', ')}`,
			});
		} else {
			checks.push({ name: 'pii_block', status: 'pass' });
		}
	} else {
		checks.push({ name: 'pii_block', status: 'pass' });
	}

	// ── 5. Time filter check ──
	const timeFilterTables = selectedBundle?.defaults?.require_time_filter_for_tables ?? [];
	const bundleStartDate = selectedBundle?.defaults?.data_start_date;
	const bundleEndDate = selectedBundle?.defaults?.demo_current_date;

	// Auto-resolve "all_time" time window to the bundle's date range
	if (draft.time_window?.type === 'all_time' && selectedBundle) {
		if (bundleStartDate && bundleEndDate) {
			draft.time_window.resolved_start = bundleStartDate;
			draft.time_window.resolved_end = bundleEndDate;
		}
	}

	if (policy.defaults.require_time_filter_for_fact_tables && timeFilterTables.length > 0) {
		const needsTimeFilter = draft.tables.some((t) => timeFilterTables.includes(t));

		if (needsTimeFilter && !draft.time_window) {
			// Build actionable feedback with available date range
			const dateRangeHint =
				bundleStartDate && bundleEndDate ? ` Dataset covers ${bundleStartDate} to ${bundleEndDate}.` : '';
			const allTimeHint =
				bundleStartDate && bundleEndDate
					? ' You can also use time_window type "all_time" to cover the full dataset range.'
					: '';
			questions.push(
				`Time filter required for fact table.${dateRangeHint} Specify a time_window with resolved_start and resolved_end (ISO dates).${allTimeHint}`,
			);
			checks.push({
				name: 'time_filter_required',
				status: 'fail',
				detail: `Fact table requires a time filter but none was provided.${dateRangeHint}`,
			});
		} else {
			checks.push({ name: 'time_filter_required', status: 'pass' });
		}
	} else {
		checks.push({ name: 'time_filter_required', status: 'pass' });
	}

	// ── 6. Limit check ──
	const limit = draft.params.limit as number | undefined;
	if (policy.defaults.require_limit_for_raw_rows && draft.tool === 'execute_sql') {
		if (limit === undefined || limit > policy.defaults.max_rows) {
			// Auto-fix: we'll note it but still allow — the SQL validator will enforce at execution time
			checks.push({
				name: 'limit_check',
				status: 'warn',
				detail: `Limit should be ≤ ${policy.defaults.max_rows}. Will be enforced at execution.`,
			});
		} else {
			checks.push({ name: 'limit_check', status: 'pass' });
		}
	} else {
		checks.push({ name: 'limit_check', status: 'pass' });
	}

	// ── 7. Metric validation check ──
	const semanticModels = options?.semanticModels;
	if (draft.metric_refs && draft.metric_refs.length > 0 && semanticModels) {
		// Build lookup: model_name → { table, schema, measures }
		const modelMap = new Map(semanticModels.map((m) => [m.name, m]));

		for (const ref of draft.metric_refs) {
			const dotIdx = ref.indexOf('.');
			if (dotIdx === -1) {
				blockReasons.push(`Invalid metric ref "${ref}". Expected format: "model_name.measure_name".`);
				fixes.push(`Available models: ${semanticModels.map((m) => m.name).join(', ')}`);
				checks.push({
					name: 'metric_exists',
					status: 'fail',
					detail: `"${ref}" is not in model.measure format.`,
				});
				continue;
			}

			const modelName = ref.slice(0, dotIdx);
			const measureName = ref.slice(dotIdx + 1);
			const model = modelMap.get(modelName);

			if (!model) {
				blockReasons.push(`Model "${modelName}" not found in semantic_model.yml.`);
				fixes.push(`Available models: ${semanticModels.map((m) => m.name).join(', ')}`);
				checks.push({
					name: 'metric_exists',
					status: 'fail',
					detail: `Model "${modelName}" does not exist.`,
				});
				continue;
			}

			if (!(measureName in model.measures)) {
				const available = Object.keys(model.measures).join(', ');
				blockReasons.push(`Measure "${measureName}" not found on model "${modelName}".`);
				fixes.push(`Available measures on ${modelName}: ${available}`);
				checks.push({
					name: 'metric_exists',
					status: 'fail',
					detail: `Measure "${measureName}" does not exist on model "${modelName}".`,
				});
				continue;
			}

			checks.push({
				name: 'metric_exists',
				status: 'pass',
				detail: `${ref} found in semantic model.`,
			});

			// Check that the metric's underlying table is in the selected bundle
			if (selectedBundle && policy.joins.enforce_bundle_allowlist) {
				const allowedTables = new Set(selectedBundle.tables.map((t) => `${t.schema}.${t.table}`));
				// Model table is stored as just "table" name; we need to check with the schema
				// The semantic model stores schema separately (defaults to "main")
				const modelFqTable = `${model.table}`;
				const matchesBundle = [...allowedTables].some(
					(t) => t.endsWith(`.${model.table}`) || t === modelFqTable,
				);

				if (!matchesBundle) {
					blockReasons.push(
						`Metric "${ref}" uses table "${model.table}" which is not in bundle "${selectedBundle.bundle_id}".`,
					);
					fixes.push(`Bundle "${selectedBundle.bundle_id}" contains: ${[...allowedTables].join(', ')}`);
					checks.push({
						name: 'metric_table_in_bundle',
						status: 'fail',
						detail: `Table "${model.table}" (from model "${modelName}") not in bundle.`,
					});
				} else {
					checks.push({
						name: 'metric_table_in_bundle',
						status: 'pass',
						detail: `Table "${model.table}" is in bundle "${selectedBundle.bundle_id}".`,
					});
				}
			}
		}

		if (
			!checks.some((c) => c.name === 'metric_exists' && c.status === 'fail') &&
			!checks.some((c) => c.name === 'metric_table_in_bundle' && c.status === 'fail')
		) {
			// All metric checks passed — already added individually
		}
	} else if (draft.metric_refs && draft.metric_refs.length > 0 && !semanticModels) {
		checks.push({
			name: 'metric_exists',
			status: 'warn',
			detail: 'No semantic_model.yml found; metric refs not validated.',
		});
	} else {
		checks.push({ name: 'metric_exists', status: 'pass' });
	}

	// ── 8. Execution permission check ──
	if (draft.tool === 'execute_sql' && !policy.execution.allow_execute_sql) {
		blockReasons.push('execute_sql is disabled by policy.');
		fixes.push('Use query_metrics instead, or ask an admin to enable execute_sql.');
		checks.push({ name: 'execution_allowed', status: 'fail' });
	} else if (draft.tool === 'query_metrics' && !policy.execution.allow_query_metrics) {
		blockReasons.push('query_metrics is disabled by policy.');
		fixes.push('Ask an admin to enable query_metrics.');
		checks.push({ name: 'execution_allowed', status: 'fail' });
	} else {
		checks.push({ name: 'execution_allowed', status: 'pass' });
	}

	// ── 9. Business rules advisory ──
	const matchedRules = options?.matchedBusinessRules ?? [];
	if (matchedRules.length > 0) {
		const critical = matchedRules.filter((r) => r.severity === 'critical');
		const others = matchedRules.filter((r) => r.severity !== 'critical');

		if (critical.length > 0) {
			checks.push({
				name: 'business_rules',
				status: 'pass',
				detail: `${critical.length} critical rule(s) apply: ${critical.map((r) => r.name).join(', ')}. Guidance enforced via semantic model filters.`,
			});
		}
		if (others.length > 0) {
			checks.push({
				name: 'business_rules_advisory',
				status: 'pass',
				detail: `${others.length} advisory rule(s) noted: ${others.map((r) => r.name).join(', ')}.`,
			});
		}
	} else {
		checks.push({ name: 'business_rules', status: 'pass', detail: 'No applicable business rules.' });
	}

	// ── Determine overall decision ──
	if (blockReasons.length > 0) {
		return {
			status: 'block',
			reason: blockReasons.join(' '),
			fixes: [...new Set(fixes)],
			checks,
		};
	}

	if (questions.length > 0) {
		return {
			status: 'needs_clarification',
			questions,
			checks,
		};
	}

	return { status: 'allow', checks };
}

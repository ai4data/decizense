import type { DatasetBundle, PolicyConfig } from '@dazense/shared/tools/build-contract';
import { describe, expect, it } from 'vitest';

import { evaluatePolicy } from '../src/policy/policy-engine';

// ── Helpers ──

function makePolicy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
	return {
		version: 1,
		defaults: {
			max_rows: 200,
			max_preview_rows: 20,
			require_limit_for_raw_rows: true,
			require_time_filter_for_fact_tables: true,
			time_filter_max_days_default: 90,
		},
		pii: {
			mode: 'block',
			tags: ['PII'],
			columns: {},
		},
		certification: {
			prefer: 'certified',
			require_for_execute_sql: false,
			require_for_query_metrics: false,
		},
		joins: {
			enforce_bundle_allowlist: true,
			allow_cross_bundle: false,
		},
		execution: {
			allow_execute_sql: true,
			allow_query_metrics: true,
			require_contract: false,
			require_bundle: false,
			sql_validation: {
				mode: 'parse',
				disallow_multi_statement: true,
				enforce_limit: true,
			},
		},
		...overrides,
	};
}

function makeBundle(overrides: Partial<DatasetBundle> = {}): DatasetBundle {
	return {
		version: 1,
		bundle_id: 'jaffle_shop',
		warehouse: { type: 'duckdb', database_id: 'local' },
		tables: [
			{ schema: 'main', table: 'customers' },
			{ schema: 'main', table: 'orders' },
		],
		joins: [
			{
				left: { schema: 'main', table: 'orders', column: 'customer_id' },
				right: { schema: 'main', table: 'customers', column: 'id' },
				type: 'many_to_one',
			},
		],
		...overrides,
	};
}

function makeDraft(overrides: Record<string, unknown> = {}) {
	return {
		bundle_id: 'jaffle_shop',
		tables: ['main.customers', 'main.orders'],
		joins: [],
		metric_refs: [],
		tool: 'execute_sql' as const,
		params: { sql_query: 'SELECT id, status FROM main.orders LIMIT 10' },
		...overrides,
	};
}

// ── Tests ──

describe('evaluatePolicy', () => {
	describe('bundle requirement', () => {
		it('passes when bundle is provided', () => {
			const result = evaluatePolicy(makeDraft(), makePolicy(), [makeBundle()]);
			expect(result.status).toBe('allow');
			const check = result.checks.find((c) => c.name === 'bundle_required');
			expect(check?.status).toBe('pass');
		});

		it('needs_clarification when require_bundle is true and no bundle specified', () => {
			const policy = makePolicy({
				execution: {
					...makePolicy().execution,
					require_bundle: true,
				},
			});
			const result = evaluatePolicy(makeDraft({ bundle_id: undefined }), policy, [makeBundle()]);
			expect(result.status).toBe('needs_clarification');
			if (result.status === 'needs_clarification') {
				expect(result.questions.length).toBeGreaterThan(0);
			}
		});

		it('blocks when bundle_id does not exist', () => {
			const result = evaluatePolicy(makeDraft({ bundle_id: 'nonexistent' }), makePolicy(), [makeBundle()]);
			expect(result.status).toBe('block');
			if (result.status === 'block') {
				expect(result.reason).toContain('nonexistent');
			}
		});
	});

	describe('bundle tables check', () => {
		it('passes when all tables are in the bundle', () => {
			const result = evaluatePolicy(makeDraft(), makePolicy(), [makeBundle()]);
			expect(result.status).toBe('allow');
			const check = result.checks.find((c) => c.name === 'bundle_tables_only');
			expect(check?.status).toBe('pass');
		});

		it('blocks when a table is not in the bundle', () => {
			const result = evaluatePolicy(
				makeDraft({ tables: ['main.customers', 'main.secret_table'] }),
				makePolicy(),
				[makeBundle()],
			);
			expect(result.status).toBe('block');
			if (result.status === 'block') {
				expect(result.reason).toContain('secret_table');
			}
		});

		it('warns when no bundle is selected and not required', () => {
			const result = evaluatePolicy(makeDraft({ bundle_id: undefined }), makePolicy(), [makeBundle()]);
			expect(result.status).toBe('allow');
			const check = result.checks.find((c) => c.name === 'bundle_tables_only');
			expect(check?.status).toBe('warn');
		});
	});

	describe('join allowlist check', () => {
		it('passes when join is in the bundle allowlist', () => {
			const result = evaluatePolicy(
				makeDraft({
					joins: [
						{
							left: { schema: 'main', table: 'orders', column: 'customer_id' },
							right: { schema: 'main', table: 'customers', column: 'id' },
						},
					],
				}),
				makePolicy(),
				[makeBundle()],
			);
			expect(result.status).toBe('allow');
			const check = result.checks.find((c) => c.name === 'bundle_join_allowlist');
			expect(check?.status).toBe('pass');
		});

		it('blocks when join is not in the bundle allowlist', () => {
			const result = evaluatePolicy(
				makeDraft({
					joins: [
						{
							left: { schema: 'main', table: 'orders', column: 'product_id' },
							right: { schema: 'main', table: 'products', column: 'id' },
						},
					],
				}),
				makePolicy(),
				[makeBundle()],
			);
			expect(result.status).toBe('block');
			if (result.status === 'block') {
				expect(result.reason).toContain('not in the bundle');
			}
		});

		it('matches joins in reverse direction', () => {
			const result = evaluatePolicy(
				makeDraft({
					joins: [
						{
							left: { schema: 'main', table: 'customers', column: 'id' },
							right: { schema: 'main', table: 'orders', column: 'customer_id' },
						},
					],
				}),
				makePolicy(),
				[makeBundle()],
			);
			expect(result.status).toBe('allow');
		});
	});

	describe('PII block check', () => {
		it('passes when no PII columns are referenced', () => {
			const policy = makePolicy({
				pii: {
					mode: 'block',
					tags: ['PII'],
					columns: { 'main.customers': ['first_name', 'last_name', 'email'] },
				},
			});
			const result = evaluatePolicy(
				makeDraft({
					params: { sql_query: 'SELECT id, status FROM main.customers LIMIT 10' },
				}),
				policy,
				[makeBundle()],
			);
			expect(result.status).toBe('allow');
			const check = result.checks.find((c) => c.name === 'pii_block');
			expect(check?.status).toBe('pass');
		});

		it('blocks when PII columns are referenced in SQL', () => {
			const policy = makePolicy({
				pii: {
					mode: 'block',
					tags: ['PII'],
					columns: { 'main.customers': ['first_name', 'last_name', 'email'] },
				},
			});
			const result = evaluatePolicy(
				makeDraft({
					tables: ['main.customers'],
					params: { sql_query: 'SELECT first_name, email FROM main.customers LIMIT 10' },
				}),
				policy,
				[makeBundle()],
			);
			expect(result.status).toBe('block');
			if (result.status === 'block') {
				expect(result.reason).toContain('PII');
				expect(result.reason).toContain('first_name');
			}
		});

		it('passes when PII mode is mask (not block)', () => {
			const policy = makePolicy({
				pii: {
					mode: 'mask',
					tags: ['PII'],
					columns: { 'main.customers': ['email'] },
				},
			});
			const result = evaluatePolicy(
				makeDraft({
					tables: ['main.customers'],
					params: { sql_query: 'SELECT email FROM main.customers LIMIT 10' },
				}),
				policy,
				[makeBundle()],
			);
			const check = result.checks.find((c) => c.name === 'pii_block');
			expect(check?.status).toBe('pass');
		});
	});

	describe('time filter check', () => {
		it('needs_clarification when fact table requires time filter and none provided', () => {
			const bundle = makeBundle({
				defaults: {
					require_time_filter_for_tables: ['main.orders'],
				},
			});
			const result = evaluatePolicy(makeDraft({ time_window: undefined }), makePolicy(), [bundle]);
			expect(result.status).toBe('needs_clarification');
			if (result.status === 'needs_clarification') {
				expect(result.questions[0]).toContain('time filter');
			}
		});

		it('passes when time_window is provided', () => {
			const bundle = makeBundle({
				defaults: {
					require_time_filter_for_tables: ['main.orders'],
				},
			});
			const result = evaluatePolicy(makeDraft({ time_window: { type: 'last_30_days' } }), makePolicy(), [bundle]);
			expect(result.status).toBe('allow');
			const check = result.checks.find((c) => c.name === 'time_filter_required');
			expect(check?.status).toBe('pass');
		});
	});

	describe('limit check', () => {
		it('warns when no limit is provided for execute_sql', () => {
			const result = evaluatePolicy(
				makeDraft({ params: { sql_query: 'SELECT * FROM main.orders' } }),
				makePolicy(),
				[makeBundle()],
			);
			const check = result.checks.find((c) => c.name === 'limit_check');
			expect(check?.status).toBe('warn');
		});

		it('passes when limit is within max_rows', () => {
			const result = evaluatePolicy(
				makeDraft({ params: { sql_query: 'SELECT * FROM main.orders', limit: 50 } }),
				makePolicy(),
				[makeBundle()],
			);
			const check = result.checks.find((c) => c.name === 'limit_check');
			expect(check?.status).toBe('pass');
		});
	});

	describe('execution permission check', () => {
		it('blocks when execute_sql is disabled', () => {
			const policy = makePolicy({
				execution: {
					...makePolicy().execution,
					allow_execute_sql: false,
				},
			});
			const result = evaluatePolicy(makeDraft(), policy, [makeBundle()]);
			expect(result.status).toBe('block');
			if (result.status === 'block') {
				expect(result.reason).toContain('execute_sql is disabled');
			}
		});

		it('blocks when query_metrics is disabled', () => {
			const policy = makePolicy({
				execution: {
					...makePolicy().execution,
					allow_query_metrics: false,
				},
			});
			const result = evaluatePolicy(makeDraft({ tool: 'query_metrics' }), policy, [makeBundle()]);
			expect(result.status).toBe('block');
			if (result.status === 'block') {
				expect(result.reason).toContain('query_metrics is disabled');
			}
		});

		it('passes when tool is allowed', () => {
			const result = evaluatePolicy(makeDraft(), makePolicy(), [makeBundle()]);
			const check = result.checks.find((c) => c.name === 'execution_allowed');
			expect(check?.status).toBe('pass');
		});
	});

	describe('metric validation', () => {
		const semanticModels = [
			{
				name: 'orders',
				table: 'orders',
				schema: 'main',
				measures: {
					order_count: { type: 'count' },
					total_amount: { type: 'sum', column: 'amount' },
				},
				dimensions: {},
				joins: {},
			},
		];

		it('passes for valid metric refs', () => {
			const result = evaluatePolicy(
				makeDraft({
					metric_refs: ['orders.order_count'],
					tool: 'query_metrics',
				}),
				makePolicy(),
				[makeBundle()],
				{ semanticModels },
			);
			const check = result.checks.find((c) => c.name === 'metric_exists' && c.status === 'pass');
			expect(check).toBeDefined();
		});

		it('blocks for invalid metric ref format', () => {
			const result = evaluatePolicy(
				makeDraft({
					metric_refs: ['bad_format'],
					tool: 'query_metrics',
				}),
				makePolicy(),
				[makeBundle()],
				{ semanticModels },
			);
			expect(result.status).toBe('block');
			if (result.status === 'block') {
				expect(result.reason).toContain('model_name.measure_name');
			}
		});

		it('blocks for nonexistent model', () => {
			const result = evaluatePolicy(
				makeDraft({
					metric_refs: ['nonexistent.order_count'],
					tool: 'query_metrics',
				}),
				makePolicy(),
				[makeBundle()],
				{ semanticModels },
			);
			expect(result.status).toBe('block');
			if (result.status === 'block') {
				expect(result.reason).toContain('nonexistent');
			}
		});

		it('blocks for nonexistent measure', () => {
			const result = evaluatePolicy(
				makeDraft({
					metric_refs: ['orders.fake_measure'],
					tool: 'query_metrics',
				}),
				makePolicy(),
				[makeBundle()],
				{ semanticModels },
			);
			expect(result.status).toBe('block');
			if (result.status === 'block') {
				expect(result.reason).toContain('fake_measure');
			}
		});

		it('warns when no semantic models are available', () => {
			const result = evaluatePolicy(
				makeDraft({
					metric_refs: ['orders.order_count'],
					tool: 'query_metrics',
				}),
				makePolicy(),
				[makeBundle()],
				{ semanticModels: null },
			);
			const check = result.checks.find((c) => c.name === 'metric_exists');
			expect(check?.status).toBe('warn');
		});
	});

	describe('overall decision priority', () => {
		it('block takes priority over needs_clarification', () => {
			const policy = makePolicy({
				execution: {
					...makePolicy().execution,
					allow_execute_sql: false,
					require_bundle: true,
				},
			});
			const result = evaluatePolicy(makeDraft({ bundle_id: undefined }), policy, [makeBundle()]);
			// Both a block (execute_sql disabled) and a question (no bundle) exist
			// Block should take priority
			expect(result.status).toBe('block');
		});
	});
});

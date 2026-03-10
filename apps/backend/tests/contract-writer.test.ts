import type { Contract } from '@dazense/shared/tools/build-contract';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadContract, persistContract } from '../src/contracts/contract-writer';

const TEST_DIR = join(import.meta.dirname, '.tmp-contract-test');

function makeContract(id: string = 'test-abc'): Contract {
	return {
		version: 1,
		contract_id: id,
		created_at: '2025-01-01T00:00:00.000Z',
		project_path: TEST_DIR,
		actor: { role: 'user', user_id: 'local' },
		request: { user_prompt: 'test query' },
		scope: {
			dataset_bundles: ['jaffle_shop'],
			tables: ['main.customers'],
		},
		meaning: {
			metrics: [],
			guidance_rules_referenced: [],
		},
		execution: {
			tool: 'execute_sql',
			params: {},
		},
		policy: {
			decision: 'allow',
			checks: [{ name: 'pii_block', status: 'pass' }],
		},
	};
}

describe('contract-writer', () => {
	beforeEach(() => {
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true });
		}
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true });
		}
	});

	it('persist and load round-trip', () => {
		const contract = makeContract('round-trip');
		const filePath = persistContract(contract, TEST_DIR);

		expect(existsSync(filePath)).toBe(true);
		expect(filePath).toContain('round-trip.json');

		const loaded = loadContract('round-trip', TEST_DIR);
		expect(loaded).not.toBeNull();
		expect(loaded?.contract_id).toBe('round-trip');
		expect(loaded?.scope.tables).toEqual(['main.customers']);
		expect(loaded?.policy.checks).toHaveLength(1);
	});

	it('returns null for nonexistent contract', () => {
		const loaded = loadContract('nonexistent', TEST_DIR);
		expect(loaded).toBeNull();
	});

	it('creates contracts/runs directory if missing', () => {
		const runsDir = join(TEST_DIR, 'contracts', 'runs');
		expect(existsSync(runsDir)).toBe(false);

		persistContract(makeContract(), TEST_DIR);

		expect(existsSync(runsDir)).toBe(true);
	});

	it('handles multiple contracts', () => {
		persistContract(makeContract('first'), TEST_DIR);
		persistContract(makeContract('second'), TEST_DIR);

		expect(loadContract('first', TEST_DIR)?.contract_id).toBe('first');
		expect(loadContract('second', TEST_DIR)?.contract_id).toBe('second');
	});

	describe('provenance fields — contract completeness', () => {
		it('persists all required provenance fields', () => {
			const contract: Contract = {
				version: 1,
				contract_id: 'provenance-test',
				created_at: '2025-01-15T10:30:00.000Z',
				project_path: TEST_DIR,
				actor: { role: 'user', user_id: 'test-user' },
				request: { user_prompt: 'What is total revenue?' },
				scope: {
					dataset_bundles: ['jaffle_shop'],
					tables: ['main.orders'],
					approved_joins: [
						{
							left_table: 'main.orders',
							left_column: 'customer_id',
							right_table: 'main.customers',
							right_column: 'id',
						},
					],
					time_window: { type: 'all_time', resolved_start: '2018-01-01', resolved_end: '2018-04-09' },
					time_columns: { 'main.orders': 'order_date' },
				},
				meaning: {
					metrics: ['orders.total_revenue'],
					guidance_rules_referenced: ['exclude_returned_orders_from_revenue', 'net_revenue_definition'],
				},
				execution: {
					tool: 'query_metrics',
					params: { model_name: 'orders', measures: ['total_revenue'] },
				},
				policy: {
					decision: 'allow',
					checks: [
						{ name: 'ambiguity_check', status: 'pass' },
						{ name: 'bundle_required', status: 'pass' },
						{ name: 'pii_block', status: 'pass' },
						{ name: 'time_filter_required', status: 'pass' },
					],
				},
			};

			persistContract(contract, TEST_DIR);
			const loaded = loadContract('provenance-test', TEST_DIR);

			expect(loaded).not.toBeNull();
			// Core identity
			expect(loaded?.contract_id).toBe('provenance-test');
			expect(loaded?.created_at).toBe('2025-01-15T10:30:00.000Z');
			expect(loaded?.actor.user_id).toBe('test-user');
			// Request
			expect(loaded?.request.user_prompt).toBe('What is total revenue?');
			// Scope — dataset bundles, tables, joins, time
			expect(loaded?.scope.dataset_bundles).toEqual(['jaffle_shop']);
			expect(loaded?.scope.tables).toEqual(['main.orders']);
			expect(loaded?.scope.approved_joins).toHaveLength(1);
			expect(loaded?.scope.time_window?.type).toBe('all_time');
			expect(loaded?.scope.time_window?.resolved_start).toBe('2018-01-01');
			expect(loaded?.scope.time_columns?.['main.orders']).toBe('order_date');
			// Meaning — metrics and business rules
			expect(loaded?.meaning.metrics).toEqual(['orders.total_revenue']);
			expect(loaded?.meaning.guidance_rules_referenced).toContain('exclude_returned_orders_from_revenue');
			expect(loaded?.meaning.guidance_rules_referenced).toContain('net_revenue_definition');
			// Execution
			expect(loaded?.execution.tool).toBe('query_metrics');
			expect(loaded?.execution.params.model_name).toBe('orders');
			// Policy
			expect(loaded?.policy.decision).toBe('allow');
			expect(loaded?.policy.checks).toHaveLength(4);
			expect(loaded?.policy.checks.map((c) => c.name)).toEqual(
				expect.arrayContaining(['ambiguity_check', 'bundle_required', 'pii_block', 'time_filter_required']),
			);
		});

		it('returns null for fake/unknown contract_id', () => {
			persistContract(makeContract('real-contract'), TEST_DIR);
			const loaded = loadContract('fake-unknown-id', TEST_DIR);
			expect(loaded).toBeNull();
		});
	});
});

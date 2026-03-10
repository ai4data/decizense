import type { Contract, PolicyConfig } from '@dazense/shared/tools/build-contract';
import { describe, expect, it } from 'vitest';

import { SqlValidationError, validateSqlAgainstContract } from '../src/policy/sql-validator';

// ── Helpers ──

function makeContract(overrides: Partial<Contract> = {}): Contract {
	return {
		version: 1,
		contract_id: 'test-abc',
		created_at: '2025-01-01T00:00:00.000Z',
		project_path: '/test',
		actor: { role: 'user', user_id: 'local' },
		request: { user_prompt: 'test query' },
		scope: {
			dataset_bundles: ['jaffle_shop'],
			tables: ['main.customers', 'main.orders'],
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
			checks: [],
		},
		...overrides,
	};
}

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
			require_contract: true,
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

// ── Tests ──

describe('validateSqlAgainstContract', () => {
	it('passes valid SQL with correct tables and LIMIT', () => {
		expect(() =>
			validateSqlAgainstContract('SELECT id, status FROM main.orders LIMIT 10', makeContract(), makePolicy()),
		).not.toThrow();
	});

	describe('read-only enforcement', () => {
		it('blocks DROP TABLE', () => {
			expect(() => validateSqlAgainstContract('DROP TABLE main.orders', makeContract(), makePolicy())).toThrow(
				SqlValidationError,
			);
		});

		it('blocks INSERT', () => {
			expect(() =>
				validateSqlAgainstContract('INSERT INTO main.orders (id) VALUES (1)', makeContract(), makePolicy()),
			).toThrow(SqlValidationError);
		});

		it('blocks DELETE', () => {
			expect(() =>
				validateSqlAgainstContract('DELETE FROM main.orders WHERE id = 1', makeContract(), makePolicy()),
			).toThrow(SqlValidationError);
		});

		it('blocks UPDATE', () => {
			expect(() =>
				validateSqlAgainstContract('UPDATE main.orders SET status = 1', makeContract(), makePolicy()),
			).toThrow(SqlValidationError);
		});

		it('blocks ALTER TABLE', () => {
			expect(() =>
				validateSqlAgainstContract('ALTER TABLE main.orders ADD COLUMN foo TEXT', makeContract(), makePolicy()),
			).toThrow(SqlValidationError);
		});

		it('blocks TRUNCATE', () => {
			expect(() => validateSqlAgainstContract('TRUNCATE main.orders', makeContract(), makePolicy())).toThrow(
				SqlValidationError,
			);
		});
	});

	describe('multi-statement check', () => {
		it('blocks multi-statement SQL', () => {
			expect(() =>
				validateSqlAgainstContract('SELECT 1; DROP TABLE main.orders;', makeContract(), makePolicy()),
			).toThrow(SqlValidationError);
		});

		it('allows multi-statement when disabled in policy', () => {
			const policy = makePolicy({
				execution: {
					...makePolicy().execution,
					sql_validation: {
						mode: 'parse',
						disallow_multi_statement: false,
						enforce_limit: false,
					},
				},
			});
			expect(() => validateSqlAgainstContract('SELECT 1; SELECT 2;', makeContract(), policy)).not.toThrow();
		});
	});

	describe('table scope check', () => {
		it('blocks SQL referencing tables outside contract scope', () => {
			try {
				validateSqlAgainstContract('SELECT * FROM main.secret_data LIMIT 10', makeContract(), makePolicy());
				expect.unreachable('Should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(SqlValidationError);
				expect((err as SqlValidationError).violations).toEqual(
					expect.arrayContaining([expect.stringContaining('secret_data')]),
				);
			}
		});

		it('passes SQL referencing only in-scope tables', () => {
			expect(() =>
				validateSqlAgainstContract('SELECT id FROM main.customers LIMIT 10', makeContract(), makePolicy()),
			).not.toThrow();
		});
	});

	describe('JOIN table scope check', () => {
		it('blocks JOIN on out-of-scope table', () => {
			try {
				validateSqlAgainstContract(
					'SELECT o.id FROM main.orders o JOIN main.secret_data s ON o.id = s.id LIMIT 10',
					makeContract(),
					makePolicy(),
				);
				expect.unreachable('Should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(SqlValidationError);
				expect((err as SqlValidationError).violations).toEqual(
					expect.arrayContaining([expect.stringContaining('secret_data')]),
				);
			}
		});

		it('passes JOIN on in-scope tables', () => {
			expect(() =>
				validateSqlAgainstContract(
					'SELECT o.id FROM main.orders o JOIN main.customers c ON o.customer_id = c.id LIMIT 10',
					makeContract(),
					makePolicy(),
				),
			).not.toThrow();
		});
	});

	describe('JOIN edge allowlist check', () => {
		it('blocks JOIN on unapproved edge when allowlist is active', () => {
			const contract = makeContract({
				scope: {
					dataset_bundles: ['jaffle_shop'],
					tables: ['main.customers', 'main.orders'],
					approved_joins: [
						{
							left_table: 'main.orders',
							left_column: 'customer_id',
							right_table: 'main.customers',
							right_column: 'id',
						},
					],
				},
			});
			try {
				validateSqlAgainstContract(
					'SELECT o.id FROM main.orders o JOIN main.customers c ON o.status = c.name LIMIT 10',
					contract,
					makePolicy(),
				);
				expect.unreachable('Should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(SqlValidationError);
				expect((err as SqlValidationError).violations).toEqual(
					expect.arrayContaining([expect.stringContaining('approved join allowlist')]),
				);
			}
		});

		it('passes JOIN on approved edge', () => {
			const contract = makeContract({
				scope: {
					dataset_bundles: ['jaffle_shop'],
					tables: ['main.customers', 'main.orders'],
					approved_joins: [
						{
							left_table: 'main.orders',
							left_column: 'customer_id',
							right_table: 'main.customers',
							right_column: 'id',
						},
					],
				},
			});
			expect(() =>
				validateSqlAgainstContract(
					'SELECT o.id FROM main.orders o JOIN main.customers c ON o.customer_id = c.id LIMIT 10',
					contract,
					makePolicy(),
				),
			).not.toThrow();
		});

		it('passes JOIN on approved edge (reversed column order)', () => {
			const contract = makeContract({
				scope: {
					dataset_bundles: ['jaffle_shop'],
					tables: ['main.customers', 'main.orders'],
					approved_joins: [
						{
							left_table: 'main.orders',
							left_column: 'customer_id',
							right_table: 'main.customers',
							right_column: 'id',
						},
					],
				},
			});
			// SQL has the condition in reverse order: c.id = o.customer_id
			expect(() =>
				validateSqlAgainstContract(
					'SELECT o.id FROM main.orders o JOIN main.customers c ON c.id = o.customer_id LIMIT 10',
					contract,
					makePolicy(),
				),
			).not.toThrow();
		});

		it('skips edge check when approved_joins is empty (no bundle)', () => {
			// Default contract has no approved_joins → edge check should not fire
			expect(() =>
				validateSqlAgainstContract(
					'SELECT o.id FROM main.orders o JOIN main.customers c ON o.status = c.name LIMIT 10',
					makeContract(),
					makePolicy(),
				),
			).not.toThrow();
		});
	});

	describe('PII column check', () => {
		const piiPolicy = makePolicy({
			pii: {
				mode: 'block',
				tags: ['PII'],
				columns: { 'main.customers': ['first_name', 'email'] },
			},
		});

		it('blocks SQL selecting PII columns', () => {
			try {
				validateSqlAgainstContract(
					'SELECT first_name, id FROM main.customers LIMIT 10',
					makeContract(),
					piiPolicy,
				);
				expect.unreachable('Should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(SqlValidationError);
				expect((err as SqlValidationError).violations).toEqual(
					expect.arrayContaining([expect.stringContaining('first_name')]),
				);
			}
		});

		it('blocks SELECT * when table has PII columns', () => {
			try {
				validateSqlAgainstContract('SELECT * FROM main.customers LIMIT 10', makeContract(), piiPolicy);
				expect.unreachable('Should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(SqlValidationError);
				expect((err as SqlValidationError).violations).toEqual(
					expect.arrayContaining([expect.stringContaining('SELECT *')]),
				);
			}
		});

		it('passes when PII mode is not block', () => {
			const maskPolicy = makePolicy({
				pii: {
					mode: 'mask',
					tags: ['PII'],
					columns: { 'main.customers': ['email'] },
				},
			});
			expect(() =>
				validateSqlAgainstContract('SELECT email FROM main.customers LIMIT 10', makeContract(), maskPolicy),
			).not.toThrow();
		});
	});

	describe('LIMIT enforcement', () => {
		it('blocks SQL without LIMIT clause', () => {
			try {
				validateSqlAgainstContract('SELECT id FROM main.orders', makeContract(), makePolicy());
				expect.unreachable('Should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(SqlValidationError);
				expect((err as SqlValidationError).violations).toEqual(
					expect.arrayContaining([expect.stringContaining('LIMIT')]),
				);
			}
		});

		it('blocks LIMIT exceeding max_rows', () => {
			try {
				validateSqlAgainstContract(
					'SELECT id FROM main.orders LIMIT 999',
					makeContract(),
					makePolicy(), // max_rows = 200
				);
				expect.unreachable('Should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(SqlValidationError);
				expect((err as SqlValidationError).violations).toEqual(
					expect.arrayContaining([expect.stringContaining('exceeds')]),
				);
			}
		});

		it('passes LIMIT within max_rows', () => {
			expect(() =>
				validateSqlAgainstContract(
					'SELECT id FROM main.orders LIMIT 100',
					makeContract(),
					makePolicy(), // max_rows = 200
				),
			).not.toThrow();
		});

		it('passes LIMIT exactly at max_rows', () => {
			expect(() =>
				validateSqlAgainstContract(
					'SELECT id FROM main.orders LIMIT 200',
					makeContract(),
					makePolicy(), // max_rows = 200
				),
			).not.toThrow();
		});

		it('passes when enforce_limit is disabled', () => {
			const policy = makePolicy({
				execution: {
					...makePolicy().execution,
					sql_validation: {
						mode: 'parse',
						disallow_multi_statement: true,
						enforce_limit: false,
					},
				},
			});
			expect(() =>
				validateSqlAgainstContract('SELECT id FROM main.orders', makeContract(), policy),
			).not.toThrow();
		});
	});

	describe('time filter enforcement', () => {
		it('blocks SQL without WHERE when contract has time_window', () => {
			const contract = makeContract({
				scope: {
					dataset_bundles: ['jaffle_shop'],
					tables: ['main.orders'],
					time_window: { type: 'last_30_days' },
				},
			});
			try {
				validateSqlAgainstContract('SELECT id FROM main.orders LIMIT 10', contract, makePolicy());
				expect.unreachable('Should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(SqlValidationError);
				expect((err as SqlValidationError).violations).toEqual(
					expect.arrayContaining([expect.stringContaining('WHERE')]),
				);
			}
		});

		it('passes SQL with WHERE when contract has time_window', () => {
			const contract = makeContract({
				scope: {
					dataset_bundles: ['jaffle_shop'],
					tables: ['main.orders'],
					time_window: { type: 'last_30_days' },
				},
			});
			expect(() =>
				validateSqlAgainstContract(
					"SELECT id FROM main.orders WHERE created_at > '2025-01-01' LIMIT 10",
					contract,
					makePolicy(),
				),
			).not.toThrow();
		});

		it('passes SQL without WHERE when contract has no time_window', () => {
			expect(() =>
				validateSqlAgainstContract(
					'SELECT id FROM main.orders LIMIT 10',
					makeContract(), // no time_window
					makePolicy(),
				),
			).not.toThrow();
		});

		it('blocks SQL with WHERE on wrong column when time_columns is set', () => {
			const contract = makeContract({
				scope: {
					dataset_bundles: ['jaffle_shop'],
					tables: ['main.orders'],
					time_window: { type: 'last_30_days' },
					time_columns: { 'main.orders': 'order_date' },
				},
			});
			try {
				validateSqlAgainstContract(
					"SELECT id FROM main.orders WHERE status = 'active' LIMIT 10",
					contract,
					makePolicy(),
				);
				expect.unreachable('Should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(SqlValidationError);
				expect((err as SqlValidationError).violations).toEqual(
					expect.arrayContaining([expect.stringContaining('order_date')]),
				);
			}
		});

		it('passes SQL with WHERE on correct time column', () => {
			const contract = makeContract({
				scope: {
					dataset_bundles: ['jaffle_shop'],
					tables: ['main.orders'],
					time_window: { type: 'last_30_days' },
					time_columns: { 'main.orders': 'order_date' },
				},
			});
			expect(() =>
				validateSqlAgainstContract(
					"SELECT id FROM main.orders WHERE order_date > '2025-01-01' LIMIT 10",
					contract,
					makePolicy(),
				),
			).not.toThrow();
		});
	});

	it('collects multiple violations', () => {
		const piiPolicy = makePolicy({
			pii: {
				mode: 'block',
				tags: ['PII'],
				columns: { 'main.customers': ['email'] },
			},
		});
		try {
			// No LIMIT + PII column + out-of-scope table
			validateSqlAgainstContract(
				'SELECT email FROM main.customers JOIN main.secret_data ON 1=1',
				makeContract(),
				piiPolicy,
			);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(SqlValidationError);
			// Should have at least 2 violations (PII + no LIMIT, possibly out-of-scope table)
			expect((err as SqlValidationError).violations.length).toBeGreaterThanOrEqual(2);
		}
	});
});

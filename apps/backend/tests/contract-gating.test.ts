/**
 * Tests for the strict contract-gating path (require_contract=true).
 *
 * These tests verify that execute_sql and query_metrics correctly:
 * 1. Reject calls without a contract_id when require_contract=true
 * 2. Reject calls with a fake/unknown contract_id
 * 3. Reject calls where the contract tool doesn't match
 * 4. Reject calls where the contract decision is not "allow"
 * 5. Allow calls with a valid contract and matching parameters
 *
 * The gate logic is tested by extracting the validation functions
 * from the tool implementations and testing them directly.
 */
import type { Contract, PolicyConfig } from '@dazense/shared/tools/build-contract';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadContract, persistContract } from '../src/contracts/contract-writer';
import { validateSqlAgainstContract } from '../src/policy/sql-validator';

// ── Helpers ──

const TEST_DIR = join(import.meta.dirname, '.tmp-contract-gate-test');

function makePolicy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
	return {
		version: 1,
		defaults: {
			max_rows: 200,
			max_preview_rows: 20,
			require_limit_for_raw_rows: true,
			require_time_filter_for_fact_tables: false,
			time_filter_max_days_default: 90,
		},
		pii: {
			mode: 'block',
			tags: ['PII'],
			columns: { 'main.customers': ['first_name', 'last_name'] },
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
			require_bundle: true,
			sql_validation: {
				mode: 'parse',
				disallow_multi_statement: true,
				enforce_limit: true,
			},
		},
		...overrides,
	};
}

function makeContract(overrides: Partial<Contract> = {}): Contract {
	return {
		version: 1,
		contract_id: 'gate-test-001',
		created_at: new Date().toISOString(),
		project_path: TEST_DIR,
		actor: { role: 'user', user_id: 'local' },
		request: { user_prompt: 'How many orders are there?' },
		scope: {
			dataset_bundles: ['jaffle_shop'],
			tables: ['main.orders'],
		},
		meaning: {
			metrics: [],
			guidance_rules_referenced: [],
		},
		execution: {
			tool: 'execute_sql',
			params: { sql_query: 'SELECT count(*) FROM main.orders LIMIT 1' },
		},
		policy: {
			decision: 'allow',
			checks: [
				{ name: 'bundle_required', status: 'pass' },
				{ name: 'pii_block', status: 'pass' },
			],
		},
		...overrides,
	};
}

/**
 * Simulate the execute_sql contract gate logic from execute-sql.ts.
 * This is a pure extraction of the gate — no HTTP calls.
 */
function executeSqlGate(
	sql_query: string,
	contract_id: string | undefined,
	policy: PolicyConfig,
	projectFolder: string,
): { contract: Contract | null; error?: string } {
	if (contract_id) {
		const contract = loadContract(contract_id, projectFolder);
		if (policy.execution.require_contract) {
			if (!contract) {
				return { contract: null, error: `Invalid contract_id "${contract_id}". No matching contract found.` };
			}
			if (contract.execution.tool !== 'execute_sql') {
				return {
					contract,
					error: `Contract was issued for "${contract.execution.tool}", not "execute_sql".`,
				};
			}
			if (contract.policy.decision !== 'allow') {
				return {
					contract,
					error: `Contract decision is "${contract.policy.decision}", not "allow".`,
				};
			}
			try {
				validateSqlAgainstContract(sql_query, contract, policy);
			} catch (err) {
				return { contract, error: (err as Error).message };
			}
		}
		return { contract };
	} else if (policy.execution.require_contract) {
		return { contract: null, error: 'Contract required. Call build_contract first.' };
	}
	return { contract: null };
}

/**
 * Simulate the query_metrics contract gate logic from query-metrics.ts.
 */
function queryMetricsGate(
	contract_id: string | undefined,
	model_name: string,
	measures: string[],
	policy: PolicyConfig,
	projectFolder: string,
): { contract: Contract | null; error?: string } {
	if (contract_id) {
		const contract = loadContract(contract_id, projectFolder);
		if (policy.execution.require_contract) {
			if (!contract) {
				return { contract: null, error: `Invalid contract_id "${contract_id}". No matching contract found.` };
			}
			if (contract.execution.tool !== 'query_metrics') {
				return {
					contract,
					error: `Contract was issued for "${contract.execution.tool}", not "query_metrics".`,
				};
			}
			if (contract.policy.decision !== 'allow') {
				return {
					contract,
					error: `Contract decision is "${contract.policy.decision}", not "allow".`,
				};
			}
			// Check model_name matches
			const contractModelName = contract.execution.params.model_name as string | undefined;
			if (contractModelName && contractModelName !== model_name) {
				return {
					contract,
					error: `Contract was issued for model "${contractModelName}", but call uses "${model_name}".`,
				};
			}
			// Check measures match
			const contractMeasures = contract.execution.params.measures as string[] | undefined;
			if (contractMeasures && contractMeasures.length > 0) {
				for (const measure of measures) {
					if (!contractMeasures.includes(measure)) {
						return {
							contract,
							error: `Measure "${measure}" is not in the contract.`,
						};
					}
				}
			}
		}
		return { contract };
	} else if (policy.execution.require_contract) {
		return { contract: null, error: 'Contract required. Call build_contract first.' };
	}
	return { contract: null };
}

// ── Tests ──

describe('contract gating (require_contract=true)', () => {
	const policy = makePolicy();

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

	describe('execute_sql gate', () => {
		it('rejects when no contract_id provided and require_contract=true', () => {
			const result = executeSqlGate('SELECT 1', undefined, policy, TEST_DIR);
			expect(result.error).toContain('Contract required');
		});

		it('rejects with fake/unknown contract_id', () => {
			const result = executeSqlGate('SELECT 1', 'nonexistent-id', policy, TEST_DIR);
			expect(result.error).toContain('Invalid contract_id');
			expect(result.error).toContain('nonexistent-id');
		});

		it('rejects when contract tool is query_metrics, not execute_sql', () => {
			const contract = makeContract({
				contract_id: 'wrong-tool',
				execution: {
					tool: 'query_metrics',
					params: { model_name: 'orders', measures: ['total_revenue'] },
				},
			});
			persistContract(contract, TEST_DIR);

			const result = executeSqlGate('SELECT count(*) FROM main.orders LIMIT 1', 'wrong-tool', policy, TEST_DIR);
			expect(result.error).toContain('query_metrics');
			expect(result.error).toContain('not "execute_sql"');
		});

		it('rejects when contract decision is "block"', () => {
			const contract = makeContract({
				contract_id: 'blocked-contract',
				policy: {
					decision: 'block',
					checks: [{ name: 'pii_block', status: 'fail', detail: 'PII detected' }],
				},
			});
			persistContract(contract, TEST_DIR);

			const result = executeSqlGate(
				'SELECT count(*) FROM main.orders LIMIT 1',
				'blocked-contract',
				policy,
				TEST_DIR,
			);
			expect(result.error).toContain('block');
			expect(result.error).toContain('not "allow"');
		});

		it('rejects when SQL violates contract (out-of-scope table)', () => {
			const contract = makeContract({ contract_id: 'scope-test' });
			persistContract(contract, TEST_DIR);

			const result = executeSqlGate('SELECT * FROM main.secret_data LIMIT 10', 'scope-test', policy, TEST_DIR);
			expect(result.error).toContain('secret_data');
		});

		it('allows with valid contract and matching SQL', () => {
			const contract = makeContract({ contract_id: 'valid-sql' });
			persistContract(contract, TEST_DIR);

			const result = executeSqlGate('SELECT count(*) FROM main.orders LIMIT 1', 'valid-sql', policy, TEST_DIR);
			expect(result.error).toBeUndefined();
			expect(result.contract).not.toBeNull();
			expect(result.contract?.contract_id).toBe('valid-sql');
		});
	});

	describe('query_metrics gate', () => {
		it('rejects when no contract_id provided and require_contract=true', () => {
			const result = queryMetricsGate(undefined, 'orders', ['total_revenue'], policy, TEST_DIR);
			expect(result.error).toContain('Contract required');
		});

		it('rejects with fake/unknown contract_id', () => {
			const result = queryMetricsGate('fake-id', 'orders', ['total_revenue'], policy, TEST_DIR);
			expect(result.error).toContain('Invalid contract_id');
		});

		it('rejects when contract tool is execute_sql, not query_metrics', () => {
			const contract = makeContract({
				contract_id: 'sql-not-metrics',
				execution: {
					tool: 'execute_sql',
					params: { sql_query: 'SELECT 1' },
				},
			});
			persistContract(contract, TEST_DIR);

			const result = queryMetricsGate('sql-not-metrics', 'orders', ['total_revenue'], policy, TEST_DIR);
			expect(result.error).toContain('execute_sql');
			expect(result.error).toContain('not "query_metrics"');
		});

		it('rejects when contract model_name does not match call', () => {
			const contract = makeContract({
				contract_id: 'model-mismatch',
				execution: {
					tool: 'query_metrics',
					params: { model_name: 'orders', measures: ['total_revenue'] },
				},
			});
			persistContract(contract, TEST_DIR);

			const result = queryMetricsGate('model-mismatch', 'customers', ['total_revenue'], policy, TEST_DIR);
			expect(result.error).toContain('orders');
			expect(result.error).toContain('customers');
		});

		it('rejects when measure is not in the contract', () => {
			const contract = makeContract({
				contract_id: 'measure-mismatch',
				execution: {
					tool: 'query_metrics',
					params: { model_name: 'orders', measures: ['total_revenue'] },
				},
			});
			persistContract(contract, TEST_DIR);

			const result = queryMetricsGate('measure-mismatch', 'orders', ['secret_measure'], policy, TEST_DIR);
			expect(result.error).toContain('secret_measure');
			expect(result.error).toContain('not in the contract');
		});

		it('allows with valid contract and matching parameters', () => {
			const contract = makeContract({
				contract_id: 'valid-metrics',
				execution: {
					tool: 'query_metrics',
					params: { model_name: 'orders', measures: ['total_revenue', 'order_count'] },
				},
			});
			persistContract(contract, TEST_DIR);

			const result = queryMetricsGate('valid-metrics', 'orders', ['total_revenue'], policy, TEST_DIR);
			expect(result.error).toBeUndefined();
			expect(result.contract?.contract_id).toBe('valid-metrics');
		});
	});

	describe('require_contract=false (permissive mode)', () => {
		const permissivePolicy = makePolicy({
			execution: {
				...makePolicy().execution,
				require_contract: false,
			},
		});

		it('allows execute_sql without contract_id', () => {
			const result = executeSqlGate('SELECT 1', undefined, permissivePolicy, TEST_DIR);
			expect(result.error).toBeUndefined();
		});

		it('allows query_metrics without contract_id', () => {
			const result = queryMetricsGate(undefined, 'orders', ['total_revenue'], permissivePolicy, TEST_DIR);
			expect(result.error).toBeUndefined();
		});
	});
});

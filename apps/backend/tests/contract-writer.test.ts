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
});

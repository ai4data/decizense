import React from 'react';
import { describe, expect, it } from 'vitest';

import { BuildContractOutput } from '../../src/components/tool-outputs';
import { renderToMarkdown } from '../../src/lib/markdown';
import { printOutput } from './print-output';

describe('BuildContractOutput', () => {
	it('renders allow status with contract details', () => {
		const result = renderToMarkdown(
			<BuildContractOutput
				output={{
					status: 'allow',
					contract_id: 'abc123',
					contract: {
						version: 1,
						contract_id: 'abc123',
						created_at: '2025-01-01T00:00:00.000Z',
						project_path: '/test',
						actor: { role: 'user', user_id: 'local' },
						request: { user_prompt: 'Show me order counts' },
						scope: {
							dataset_bundles: ['jaffle_shop'],
							tables: ['main.orders'],
						},
						execution: {
							tool: 'execute_sql',
							params: {},
						},
						policy: {
							decision: 'allow',
							checks: [
								{ name: 'bundle_required', status: 'pass' },
								{ name: 'pii_block', status: 'pass' },
								{ name: 'limit_check', status: 'warn', detail: 'Limit should be ≤ 200.' },
							],
						},
					},
				}}
			/>,
		);
		printOutput('build_contract', 'allow', result);

		expect(result).toContain('Contract Approved');
		expect(result).toContain('abc123');
		expect(result).toContain('jaffle_shop');
		expect(result).toContain('main.orders');
		expect(result).toContain('[pass] bundle_required');
		expect(result).toContain('[warn] limit_check');
	});

	it('renders block status with reason and fixes', () => {
		const result = renderToMarkdown(
			<BuildContractOutput
				output={{
					status: 'block',
					reason: 'PII columns referenced: main.customers.email.',
					fixes: ['Remove PII columns from the query.'],
					checks: [
						{ name: 'pii_block', status: 'fail', detail: 'PII violation: main.customers.email' },
						{ name: 'bundle_required', status: 'pass' },
					],
				}}
			/>,
		);
		printOutput('build_contract', 'block', result);

		expect(result).toContain('Contract Blocked');
		expect(result).toContain('PII columns referenced');
		expect(result).toContain('Remove PII columns');
		expect(result).toContain('[fail] pii_block');
	});

	it('renders needs_clarification with questions', () => {
		const result = renderToMarkdown(
			<BuildContractOutput
				output={{
					status: 'needs_clarification',
					questions: ['Which dataset bundle should we use? Available: jaffle_shop, analytics'],
					checks: [{ name: 'bundle_required', status: 'fail', detail: 'No bundle specified.' }],
				}}
			/>,
		);
		printOutput('build_contract', 'needs_clarification', result);

		expect(result).toContain('Clarification Needed');
		expect(result).toContain('Which dataset bundle');
		expect(result).toContain('[fail] bundle_required');
	});
});

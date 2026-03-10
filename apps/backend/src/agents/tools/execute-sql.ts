import type { executeSql } from '@dazense/shared/tools';
import { executeSql as schemas } from '@dazense/shared/tools';
import type { Contract, Provenance } from '@dazense/shared/tools/build-contract';

import { ExecuteSqlOutput, renderToModelOutput } from '../../components/tool-outputs';
import { loadContract } from '../../contracts/contract-writer';
import { env } from '../../env';
import { validateSqlAgainstContract } from '../../policy/sql-validator';
import { createTool, type ToolContext } from '../../types/tools';
import { getPolicies } from '../user-rules';

function buildProvenance(contract: Contract): Provenance {
	return {
		contract_id: contract.contract_id,
		bundle_id: contract.scope.dataset_bundles[0],
		tables: contract.scope.tables,
		checks: contract.policy.checks
			.filter((c) => c.status === 'pass' || c.status === 'warn')
			.map((c) => ({
				name: c.name,
				status: c.status as 'pass' | 'warn',
				...(c.detail && { detail: c.detail }),
			})),
	};
}

export async function executeQuery(
	{ sql_query, database_id, contract_id }: executeSql.Input,
	context: ToolContext,
): Promise<executeSql.Output> {
	const dazenseProjectFolder = context.projectFolder;

	// ── Contract gate + provenance ──
	const policy = getPolicies(dazenseProjectFolder);
	let provenance: Provenance | undefined;

	if (contract_id) {
		const contract = loadContract(contract_id, dazenseProjectFolder);
		if (policy?.execution?.require_contract) {
			if (!contract) {
				throw new Error(`Invalid contract_id "${contract_id}". No matching contract found.`);
			}
			// Verify contract was issued for execute_sql
			if (contract.execution.tool !== 'execute_sql') {
				throw new Error(
					`Contract was issued for "${contract.execution.tool}", not "execute_sql". Call build_contract again.`,
				);
			}
			if (contract.policy.decision !== 'allow') {
				throw new Error(`Contract decision is "${contract.policy.decision}", not "allow".`);
			}
			validateSqlAgainstContract(sql_query, contract, policy);
		}
		if (contract) {
			provenance = buildProvenance(contract);
		}
	} else if (policy?.execution?.require_contract) {
		throw new Error('Contract required. Call build_contract first to create an execution contract.');
	}

	const response = await fetch(`http://localhost:${env.FASTAPI_PORT}/execute_sql`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			sql: sql_query,
			dazense_project_folder: dazenseProjectFolder,
			...(database_id && { database_id }),
		}),
	});

	if (!response.ok) {
		const errorData = await response.json().catch(() => ({ detail: response.statusText }));
		throw new Error(`Error executing SQL query: ${JSON.stringify(errorData.detail)}`);
	}

	const data = await response.json();
	return {
		_version: '1',
		...data,
		id: `query_${crypto.randomUUID().slice(0, 8)}`,
		...(provenance && { provenance }),
	};
}

export default createTool({
	description:
		'Execute a SQL query against the connected database and return the results. If multiple databases are configured, specify the database_id.',
	inputSchema: schemas.InputSchema,
	outputSchema: schemas.OutputSchema,
	execute: executeQuery,
	toModelOutput: ({ output }) => renderToModelOutput(ExecuteSqlOutput({ output }), output),
});

import type { queryMetrics } from '@dazense/shared/tools';
import { queryMetrics as schemas } from '@dazense/shared/tools';
import type { Contract, Provenance } from '@dazense/shared/tools/build-contract';

import { QueryMetricsOutput, renderToModelOutput } from '../../components/tool-outputs';
import { loadContract } from '../../contracts/contract-writer';
import { env } from '../../env';
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

function validateContractMatchesCall(
	contract: Contract,
	model_name: string,
	measures: string[],
	dimensions?: string[],
	filters?: Array<{ column: string; operator: string; value?: unknown }>,
	order_by?: Array<{ column: string; ascending: boolean }>,
	limit?: number,
): void {
	const violations: string[] = [];

	// Contract must be for query_metrics
	if (contract.execution.tool !== 'query_metrics') {
		violations.push(`Contract was issued for "${contract.execution.tool}", not "query_metrics".`);
	}

	// Contract must have been allowed
	if (contract.policy.decision !== 'allow') {
		violations.push(`Contract decision is "${contract.policy.decision}", not "allow".`);
	}

	// Check model_name matches contract params (if recorded)
	const contractModelName = contract.execution.params.model_name as string | undefined;
	if (contractModelName && contractModelName !== model_name) {
		violations.push(`Contract was issued for model "${contractModelName}", but call uses "${model_name}".`);
	}

	// Check measures are a subset of what the contract approved
	const contractMeasures = contract.execution.params.measures as string[] | undefined;
	if (contractMeasures && contractMeasures.length > 0) {
		for (const measure of measures) {
			if (!contractMeasures.includes(measure)) {
				violations.push(
					`Measure "${measure}" is not in the contract. Approved: ${contractMeasures.join(', ')}`,
				);
			}
		}
	}

	// Check dimensions are a subset of what the contract approved
	const contractDimensions = contract.execution.params.dimensions as string[] | undefined;
	if (contractDimensions && contractDimensions.length > 0 && dimensions) {
		for (const dim of dimensions) {
			if (!contractDimensions.includes(dim)) {
				violations.push(
					`Dimension "${dim}" is not in the contract. Approved: ${contractDimensions.join(', ')}`,
				);
			}
		}
	}

	// Check each filter matches an approved filter (column + operator + value)
	const contractFilters = contract.execution.params.filters as
		| Array<{ column: string; operator: string; value: unknown }>
		| undefined;
	if (contractFilters && contractFilters.length > 0 && filters) {
		for (const filter of filters) {
			const match = contractFilters.some(
				(cf) =>
					cf.column === filter.column &&
					cf.operator === filter.operator &&
					JSON.stringify(cf.value) === JSON.stringify(filter.value),
			);
			if (!match) {
				violations.push(
					`Filter {column: "${filter.column}", operator: "${filter.operator}", value: ${JSON.stringify(filter.value)}} is not in the contract.`,
				);
			}
		}
	}

	// Check each order_by matches an approved order_by (column + direction)
	const contractOrderBy = contract.execution.params.order_by as
		| Array<{ column: string; ascending: boolean }>
		| undefined;
	if (contractOrderBy && contractOrderBy.length > 0 && order_by) {
		for (const ob of order_by) {
			const match = contractOrderBy.some((co) => co.column === ob.column && co.ascending === ob.ascending);
			if (!match) {
				violations.push(
					`Order by {column: "${ob.column}", ascending: ${ob.ascending}} is not in the contract.`,
				);
			}
		}
	}

	// Check limit does not exceed contract limit
	const contractLimit = contract.execution.params.limit as number | undefined;
	if (contractLimit !== undefined && limit !== undefined && limit > contractLimit) {
		violations.push(`Limit ${limit} exceeds the contract limit of ${contractLimit}.`);
	}

	if (violations.length > 0) {
		throw new Error(
			`Contract mismatch: ${violations.join(' ')} Call build_contract again with the correct parameters.`,
		);
	}
}

async function executeQueryMetrics(
	{ model_name, measures, dimensions, filters, order_by, limit, database_id, contract_id }: queryMetrics.Input,
	context: ToolContext,
): Promise<queryMetrics.Output> {
	// ── Contract gate + provenance ──
	const policy = getPolicies(context.projectFolder);
	let provenance: Provenance | undefined;

	if (contract_id) {
		const contract = loadContract(contract_id, context.projectFolder);
		if (policy?.execution?.require_contract) {
			if (!contract) {
				throw new Error(`Invalid contract_id "${contract_id}". No matching contract found.`);
			}
			validateContractMatchesCall(contract, model_name, measures, dimensions, filters, order_by, limit);
		}
		if (contract) {
			provenance = buildProvenance(contract);
		}
	} else if (policy?.execution?.require_contract) {
		throw new Error('Contract required. Call build_contract first to create an execution contract.');
	}

	const response = await fetch(`http://localhost:${env.FASTAPI_PORT}/query_metrics`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			dazense_project_folder: context.projectFolder,
			model_name,
			measures,
			dimensions,
			filters,
			order_by,
			limit,
			...(database_id && { database_id }),
		}),
	});

	if (!response.ok) {
		const errorData = await response.json().catch(() => ({ detail: response.statusText }));
		throw new Error(`Error querying metrics: ${JSON.stringify(errorData.detail)}`);
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
		'Query pre-defined metrics from the semantic layer. Use this instead of writing raw SQL when the required measures and dimensions are available in the semantic model.',
	inputSchema: schemas.InputSchema,
	outputSchema: schemas.OutputSchema,
	execute: executeQueryMetrics,
	toModelOutput: ({ output }) => renderToModelOutput(QueryMetricsOutput({ output }), output),
});

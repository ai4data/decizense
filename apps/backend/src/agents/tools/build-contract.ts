import { buildContract as schemas } from '@dazense/shared/tools';
import type { Contract, DatasetBundle } from '@dazense/shared/tools/build-contract';

import { BuildContractOutput, renderToModelOutput } from '../../components/tool-outputs';
import { persistContract } from '../../contracts/contract-writer';
import { matchBusinessRules } from '../../policy/business-rules-matcher';
import { evaluatePolicy } from '../../policy/policy-engine';
import { createTool, type ToolContext } from '../../types/tools';
import { getBusinessRules, getDatasetBundles, getPolicies, getSemanticModels } from '../user-rules';

export default createTool({
	description:
		'Build an execution contract before running a query. This validates the query plan against dataset bundles and policies, returning allow/block/needs_clarification. You MUST call this before execute_sql or query_metrics.',
	inputSchema: schemas.InputSchema,
	outputSchema: schemas.OutputSchema,
	execute: async (input, context) => {
		return buildContract(input, context);
	},
	toModelOutput: ({ output }) => renderToModelOutput(BuildContractOutput({ output }), output),
});

async function buildContract(input: schemas.Input, context: ToolContext): Promise<schemas.Output> {
	const projectFolder = context.projectFolder;
	const policy = getPolicies(projectFolder);
	const bundles = getDatasetBundles(projectFolder) ?? [];
	const semanticModels = getSemanticModels();
	const businessRules = getBusinessRules() ?? [];

	// Match business rules against the query context
	const matchedRules = matchBusinessRules(businessRules, {
		tables: input.tables,
		metric_refs: input.metric_refs,
		sql_query: input.params?.sql_query as string | undefined,
	});

	// If no policy file exists, return allow with a warning (backward compat)
	if (!policy) {
		const contractId = crypto.randomUUID().slice(0, 8);
		const contract = buildContractObject(
			input,
			contractId,
			projectFolder,
			bundles,
			[
				{
					name: 'no_policy',
					status: 'warn' as const,
					detail: 'No policies/policy.yml found. Running without enforcement.',
				},
			],
			matchedRules,
		);
		persistContract(contract, projectFolder);
		return {
			status: 'allow',
			contract_id: contractId,
			contract,
		};
	}

	// Run policy evaluation
	const decision = evaluatePolicy(
		{
			bundle_id: input.bundle_id,
			tables: input.tables,
			joins: input.joins,
			metric_refs: input.metric_refs,
			time_window: input.time_window,
			tool: input.tool,
			params: input.params,
			ambiguity: input.ambiguity,
		},
		policy,
		bundles,
		{ semanticModels, matchedBusinessRules: matchedRules },
	);

	if (decision.status === 'block') {
		return {
			status: 'block',
			reason: decision.reason,
			fixes: decision.fixes,
			checks: decision.checks,
		};
	}

	if (decision.status === 'needs_clarification') {
		return {
			status: 'needs_clarification',
			questions: decision.questions,
			checks: decision.checks,
		};
	}

	// Allow — persist and return
	const contractId = crypto.randomUUID().slice(0, 8);
	const contract = buildContractObject(input, contractId, projectFolder, bundles, decision.checks, matchedRules);
	persistContract(contract, projectFolder);

	return {
		status: 'allow',
		contract_id: contractId,
		contract,
	};
}

function buildContractObject(
	input: schemas.Input,
	contractId: string,
	projectFolder: string,
	bundles: DatasetBundle[],
	checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; detail?: string }>,
	matchedRules?: Array<{ name: string; severity: string; category: string; matched_on: string[] }>,
): Contract {
	const selectedBundle = input.bundle_id ? bundles.find((b) => b.bundle_id === input.bundle_id) : undefined;

	// Store approved join edges from the bundle for SQL-level enforcement
	const approvedJoins = (selectedBundle?.joins ?? []).map((j) => ({
		left_table: `${j.left.schema}.${j.left.table}`,
		left_column: j.left.column,
		right_table: `${j.right.schema}.${j.right.table}`,
		right_column: j.right.column,
	}));

	// Store time columns from the bundle for time filter enforcement
	const timeColumns = selectedBundle?.defaults?.time_column_by_table ?? {};

	return {
		version: 1,
		contract_id: contractId,
		created_at: new Date().toISOString(),
		project_path: projectFolder,
		actor: {
			role: 'user',
			user_id: 'local',
		},
		request: {
			user_prompt: input.user_prompt,
			intent: input.metric_refs && input.metric_refs.length > 0 ? 'metric_query' : 'sql_query',
			ambiguity: input.ambiguity
				? {
						is_ambiguous: input.ambiguity.is_ambiguous,
						notes: input.ambiguity.notes,
					}
				: undefined,
		},
		scope: {
			dataset_bundles: input.bundle_id ? [input.bundle_id] : [],
			tables: input.tables,
			approved_joins: approvedJoins,
			time_columns: timeColumns,
			time_window: input.time_window,
		},
		meaning: {
			metrics: (input.metric_refs ?? []).map((id) => ({ id })),
			guidance_rules_referenced: (matchedRules ?? []).map((r) => r.name),
		},
		execution: {
			tool: input.tool,
			params: input.params,
		},
		policy: {
			decision: 'allow',
			checks,
		},
	};
}

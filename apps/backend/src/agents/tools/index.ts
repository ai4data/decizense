import { existsSync } from 'fs';
import { join } from 'path';

import { env } from '../../env';
import { mcpService } from '../../services/mcp.service';
import { AgentSettings } from '../../types/agent-settings';
import buildContract from './build-contract';
import classify from './classify';
import displayChart from './display-chart';
import executePython, { isPythonAvailable } from './execute-python';
import executeSql from './execute-sql';
import getBusinessContext from './get-business-context';
import grep from './grep';
import list from './list';
import queryMetrics from './query-metrics';
import read from './read';
import search from './search';
import suggestFollowUps from './suggest-follow-ups';

function hasSemanticModel(): boolean {
	const projectFolder = env.DAZENSE_DEFAULT_PROJECT_PATH;
	return !!projectFolder && existsSync(join(projectFolder, 'semantics', 'semantic_model.yml'));
}

function hasBusinessRules(): boolean {
	const projectFolder = env.DAZENSE_DEFAULT_PROJECT_PATH;
	return !!projectFolder && existsSync(join(projectFolder, 'semantics', 'business_rules.yml'));
}

function hasPolicies(): boolean {
	const projectFolder = env.DAZENSE_DEFAULT_PROJECT_PATH;
	return !!projectFolder && existsSync(join(projectFolder, 'policies', 'policy.yml'));
}

export const tools = {
	display_chart: displayChart,
	...(executePython && { execute_python: executePython }),
	execute_sql: executeSql,
	grep,
	list,
	read,
	search,
	suggest_follow_ups: suggestFollowUps,
};

export { isPythonAvailable };

export const getTools = (agentSettings: AgentSettings | null) => {
	const mcpTools = mcpService.getMcpTools();

	const { execute_python, ...baseTools } = tools;

	return {
		...baseTools,
		...mcpTools,
		...(agentSettings?.experimental?.pythonSandboxing && execute_python && { execute_python }),
		...(hasSemanticModel() && { query_metrics: queryMetrics }),
		...(hasBusinessRules() && { get_business_context: getBusinessContext }),
		...(hasBusinessRules() && { classify }),
		...(hasPolicies() && { build_contract: buildContract }),
	};
};

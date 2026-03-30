import type { graphImpact } from '@dazense/shared/tools';
import { graphImpact as schemas } from '@dazense/shared/tools';

import { GraphImpactOutput, renderToModelOutput } from '../../components/tool-outputs';
import { buildFromProject } from '../../graph/graph-builder';
import { resolveEntityId } from '../../graph/resolve-entity';
import { createTool, type ToolContext } from '../../types/tools';

async function execute({ entity_id }: graphImpact.Input, context: ToolContext): Promise<graphImpact.Output> {
	const graph = buildFromProject(context.projectFolder);
	const resolvedId = resolveEntityId(graph, entity_id);

	if (!resolvedId) {
		return {
			_version: '1',
			entity_id,
			resolved_id: '',
			affected: [],
			summary: `No graph node found matching "${entity_id}".`,
		};
	}

	const affected = graph.impactOf(resolvedId);

	// Group by type for summary
	const byType: Record<string, string[]> = {};
	for (const node of affected) {
		const list = byType[node.type] ?? [];
		list.push(node.id);
		byType[node.type] = list;
	}

	const parts = Object.entries(byType).map(([type, ids]) => `${ids.length} ${type}(s)`);
	const summary =
		affected.length === 0
			? `${resolvedId} has no downstream dependents.`
			: `A change to ${resolvedId} would impact ${parts.join(', ')}.`;

	return {
		_version: '1',
		entity_id,
		resolved_id: resolvedId,
		affected: affected.map((n) => ({ id: n.id, type: n.type })),
		summary,
	};
}

export default createTool({
	description:
		'Measure the downstream impact of a graph entity. Shows what measures, models, and rules would be affected if a column or table changes. Use this to answer "what breaks if this changes?" questions.',
	inputSchema: schemas.InputSchema,
	outputSchema: schemas.OutputSchema,
	execute,
	toModelOutput: ({ output }) => renderToModelOutput(GraphImpactOutput({ output }), output),
});

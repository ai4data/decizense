import type { graphLineage } from '@dazense/shared/tools';
import { graphLineage as schemas } from '@dazense/shared/tools';

import { GraphLineageOutput, renderToModelOutput } from '../../components/tool-outputs';
import { buildFromProject } from '../../graph/graph-builder';
import { resolveEntityId } from '../../graph/resolve-entity';
import { createTool, type ToolContext } from '../../types/tools';

async function execute({ entity_id }: graphLineage.Input, context: ToolContext): Promise<graphLineage.Output> {
	const graph = buildFromProject(context.projectFolder);
	const resolvedId = resolveEntityId(graph, entity_id);

	if (!resolvedId) {
		return {
			_version: '1',
			entity_id,
			resolved_id: '',
			upstream: [],
			summary: `No graph node found matching "${entity_id}".`,
		};
	}

	const upstream = graph.lineageOf(resolvedId);

	// Group by type for summary
	const byType: Record<string, string[]> = {};
	for (const node of upstream) {
		const list = byType[node.type] ?? [];
		list.push(node.id);
		byType[node.type] = list;
	}

	const parts = Object.entries(byType).map(([type, ids]) => `${ids.length} ${type}(s)`);
	const summary =
		upstream.length === 0
			? `${resolvedId} has no upstream dependencies.`
			: `${resolvedId} depends on ${parts.join(', ')}.`;

	return {
		_version: '1',
		entity_id,
		resolved_id: resolvedId,
		upstream: upstream.map((n) => ({ id: n.id, type: n.type })),
		summary,
	};
}

export default createTool({
	description:
		'Trace the upstream lineage of a graph entity. Shows what columns, tables, and rules a measure or dimension depends on. Use this to answer "what does this metric depend on?" questions.',
	inputSchema: schemas.InputSchema,
	outputSchema: schemas.OutputSchema,
	execute,
	toModelOutput: ({ output }) => renderToModelOutput(GraphLineageOutput({ output }), output),
});

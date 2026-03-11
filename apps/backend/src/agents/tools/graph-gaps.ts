import type { graphGaps } from '@dazense/shared/tools';
import { graphGaps as schemas } from '@dazense/shared/tools';

import { GraphGapsOutput, renderToModelOutput } from '../../components/tool-outputs';
import { buildFromProject } from '../../graph/graph-builder';
import { EdgeType, NodeType } from '../../graph/types';
import { createTool, type ToolContext } from '../../types/tools';

interface GapItem {
	node_id: string;
	node_type: string;
	category: string;
	description: string;
}

async function execute({ check }: graphGaps.Input, context: ToolContext): Promise<graphGaps.Output> {
	const graph = buildFromProject(context.projectFolder);
	const gaps: GapItem[] = [];

	// PII: columns classified as PII but not blocked
	if (check === 'all' || check === 'pii') {
		const unblocked = graph.findUnblockedPiiColumns();
		for (const col of unblocked) {
			gaps.push({
				node_id: col.id,
				node_type: col.type,
				category: 'pii',
				description: `${col.id} is classified as PII but not blocked by policy`,
			});
		}
	}

	// Models: tables without semantic models
	if (check === 'all' || check === 'models') {
		const orphans = graph.findGaps(NodeType.Table, EdgeType.WRAPS, NodeType.Model);
		for (const table of orphans) {
			gaps.push({
				node_id: table.id,
				node_type: table.type,
				category: 'models',
				description: `${table.id} has no semantic model`,
			});
		}
	}

	// Rules: measures without business rules
	if (check === 'all' || check === 'rules') {
		const ungoverned = graph.findGaps(NodeType.Measure, EdgeType.APPLIES_TO, NodeType.Rule);
		for (const measure of ungoverned) {
			gaps.push({
				node_id: measure.id,
				node_type: measure.type,
				category: 'rules',
				description: `${measure.id} has no business rule`,
			});
		}
	}

	const summary =
		gaps.length === 0
			? `No governance gaps found (checked: ${check}).`
			: `Found ${gaps.length} governance gap(s) (checked: ${check}).`;

	return {
		_version: '1',
		check,
		gaps,
		summary,
	};
}

export default createTool({
	description:
		'Find governance coverage gaps. Checks for: PII columns not blocked by policy, tables without semantic models, and measures without business rules. Use this to answer "where are we missing governance?" questions.',
	inputSchema: schemas.InputSchema,
	outputSchema: schemas.OutputSchema,
	execute,
	toModelOutput: ({ output }) => renderToModelOutput(GraphGapsOutput({ output }), output),
});

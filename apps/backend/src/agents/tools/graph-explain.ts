import type { graphExplain } from '@dazense/shared/tools';
import { graphExplain as schemas } from '@dazense/shared/tools';

import { GraphExplainOutput, renderToModelOutput } from '../../components/tool-outputs';
import { buildFromProject } from '../../graph/graph-builder';
import { resolveEntityId } from '../../graph/resolve-entity';
import type { GraphEdge } from '../../graph/types';
import { createTool, type ToolContext } from '../../types/tools';

interface EdgeInfo {
	from: string;
	to: string;
	type: string;
	from_type: string;
	to_type: string;
}

function edgeToInfo(graph: ReturnType<typeof buildFromProject>, edge: GraphEdge): EdgeInfo {
	return {
		from: edge.from,
		to: edge.to,
		type: edge.type,
		from_type: graph.getNode(edge.from)?.type ?? 'unknown',
		to_type: graph.getNode(edge.to)?.type ?? 'unknown',
	};
}

async function execute(
	{ entity_id, question: _question }: graphExplain.Input,
	context: ToolContext,
): Promise<graphExplain.Output> {
	const graph = buildFromProject(context.projectFolder);
	const resolvedId = resolveEntityId(graph, entity_id);

	if (!resolvedId) {
		return {
			_version: '1',
			entity_id,
			resolved_id: '',
			node_type: 'unknown',
			properties: {},
			inbound_edges: [],
			outbound_edges: [],
			explanation: `No graph node found matching "${entity_id}".`,
		};
	}

	const node = graph.getNode(resolvedId)!;

	// Build edge info by checking all edges
	const allJson = graph.toJSON();
	const inboundEdges = allJson.edges.filter((e) => e.to === resolvedId).map((e) => edgeToInfo(graph, e));
	const outboundEdges = allJson.edges.filter((e) => e.from === resolvedId).map((e) => edgeToInfo(graph, e));

	// Build explanation
	const explanationParts: string[] = [];
	explanationParts.push(`${resolvedId} is a ${node.type} node.`);

	// Check if blocked (PII)
	const blockedBy = inboundEdges.filter((e) => e.type === 'BLOCKS');
	if (blockedBy.length > 0) {
		explanationParts.push(`It is BLOCKED by ${blockedBy.map((e) => e.from).join(', ')}.`);
	}

	// Check classifications
	const classifiedBy = inboundEdges.filter((e) => e.type === 'CLASSIFIES');
	if (classifiedBy.length > 0) {
		explanationParts.push(`Classified as: ${classifiedBy.map((e) => e.from).join(', ')}.`);
	}

	// Check rules
	const rules = inboundEdges.filter((e) => e.type === 'APPLIES_TO');
	if (rules.length > 0) {
		explanationParts.push(`Governed by rules: ${rules.map((e) => e.from).join(', ')}.`);
	}

	// Check what it defines/reads/aggregates
	const defines = outboundEdges.filter((e) => e.type === 'DEFINES');
	if (defines.length > 0) {
		explanationParts.push(`Defines ${defines.length} entities.`);
	}

	const reads = outboundEdges.filter((e) => e.type === 'READS' || e.type === 'AGGREGATES');
	if (reads.length > 0) {
		explanationParts.push(`Reads from: ${reads.map((e) => e.to).join(', ')}.`);
	}

	// If no edges at all
	if (inboundEdges.length === 0 && outboundEdges.length === 0) {
		explanationParts.push('This node has no edges — it may be orphaned.');
	}

	return {
		_version: '1',
		entity_id,
		resolved_id: resolvedId,
		node_type: node.type,
		properties: node.properties,
		inbound_edges: inboundEdges,
		outbound_edges: outboundEdges,
		explanation: explanationParts.join(' '),
	};
}

export default createTool({
	description:
		'Explain a graph entity — its type, properties, classifications, rules, and relationships. Use this to answer "why is this blocked?", "what rules apply?", or "tell me about this entity" questions.',
	inputSchema: schemas.InputSchema,
	outputSchema: schemas.OutputSchema,
	execute,
	toModelOutput: ({ output }) => renderToModelOutput(GraphExplainOutput({ output }), output),
});

import type { graphImpact } from '@dazense/shared/tools';

import { Block, ListItem, Span, Title, TitledList } from '../../lib/markdown';

export const GraphImpactOutput = ({ output }: { output: graphImpact.Output }) => {
	if (!output.resolved_id) {
		return <Block>No graph node found matching "{output.entity_id}".</Block>;
	}

	if (output.affected.length === 0) {
		return (
			<Block>
				<Title>Impact: {output.resolved_id}</Title>
				<Span>No downstream dependents found.</Span>
			</Block>
		);
	}

	// Group by type
	const byType: Record<string, string[]> = {};
	for (const node of output.affected) {
		const list = byType[node.type] ?? [];
		list.push(node.id);
		byType[node.type] = list;
	}

	return (
		<Block>
			<Title>Impact: {output.resolved_id}</Title>
			<Span>{output.summary}</Span>
			{Object.entries(byType).map(([type, ids]) => (
				<TitledList title={type}>
					{ids.map((id) => (
						<ListItem>{id}</ListItem>
					))}
				</TitledList>
			))}
		</Block>
	);
};

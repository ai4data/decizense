import type { graphExplain } from '@dazense/shared/tools';

import { Block, Bold, ListItem, Span, Title, TitledList } from '../../lib/markdown';

export const GraphExplainOutput = ({ output }: { output: graphExplain.Output }) => {
	if (!output.resolved_id) {
		return <Block>No graph node found matching "{output.entity_id}".</Block>;
	}

	const properties = Object.entries(output.properties).filter(([_, v]) => v != null);

	return (
		<Block>
			<Title>
				{output.resolved_id} ({output.node_type})
			</Title>
			<Span>{output.explanation}</Span>
			{properties.length > 0 && (
				<TitledList title='Properties'>
					{properties.map(([key, value]) => (
						<ListItem>
							<Bold>{key}</Bold>: {String(value)}
						</ListItem>
					))}
				</TitledList>
			)}
			{output.inbound_edges.length > 0 && (
				<TitledList title='Inbound edges'>
					{output.inbound_edges.map((e) => (
						<ListItem>
							{e.from} —[{e.type}]→ {output.resolved_id}
						</ListItem>
					))}
				</TitledList>
			)}
			{output.outbound_edges.length > 0 && (
				<TitledList title='Outbound edges'>
					{output.outbound_edges.map((e) => (
						<ListItem>
							{output.resolved_id} —[{e.type}]→ {e.to}
						</ListItem>
					))}
				</TitledList>
			)}
		</Block>
	);
};

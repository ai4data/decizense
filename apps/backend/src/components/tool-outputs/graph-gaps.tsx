import type { graphGaps } from '@dazense/shared/tools';

import { Block, Bold, ListItem, Span, Title, TitledList } from '../../lib/markdown';

export const GraphGapsOutput = ({ output }: { output: graphGaps.Output }) => {
	if (output.gaps.length === 0) {
		return (
			<Block>
				<Title>Governance Gaps</Title>
				<Span>{output.summary}</Span>
			</Block>
		);
	}

	// Group by category
	const byCategory: Record<string, typeof output.gaps> = {};
	for (const gap of output.gaps) {
		const list = byCategory[gap.category] ?? [];
		list.push(gap);
		byCategory[gap.category] = list;
	}

	return (
		<Block>
			<Title>Governance Gaps</Title>
			<Span>{output.summary}</Span>
			{Object.entries(byCategory).map(([category, gaps]) => (
				<TitledList title={category}>
					{gaps.map((gap) => (
						<ListItem>
							<Bold>{gap.node_id}</Bold> ({gap.node_type}): {gap.description}
						</ListItem>
					))}
				</TitledList>
			))}
		</Block>
	);
};

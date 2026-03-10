import { pluralize } from '@dazense/shared';
import type { queryMetrics } from '@dazense/shared/tools';

import { Block, CodeBlock, ListItem, Span, Title, TitledList } from '../../lib/markdown';
import { truncateMiddle } from '../../utils/utils';

const MAX_ROWS = 20;

const ProvenanceSection = ({ provenance }: { provenance: queryMetrics.Output['provenance'] }) => {
	if (!provenance) {
		return null;
	}
	return (
		<Block>
			<Title level={2}>Provenance</Title>
			<Span>Contract: {provenance.contract_id}</Span>
			{provenance.bundle_id && <Span>Bundle: {provenance.bundle_id}</Span>}
			<Span>Tables: {provenance.tables.join(', ')}</Span>
			<TitledList title='Safety Checks'>
				{provenance.checks.map((check) => (
					<ListItem>
						[{check.status}] {check.name}
						{check.detail ? ` — ${check.detail}` : ''}
					</ListItem>
				))}
			</TitledList>
		</Block>
	);
};

export const QueryMetricsOutput = ({
	output,
	maxRows = MAX_ROWS,
}: {
	output: queryMetrics.Output;
	maxRows?: number;
}) => {
	if (output.data.length === 0) {
		if (output.provenance) {
			return (
				<Block>
					<Span>The metric query was successfully executed and returned no rows.</Span>
					<ProvenanceSection provenance={output.provenance} />
				</Block>
			);
		}
		return <Block>The metric query was successfully executed and returned no rows.</Block>;
	}

	const isTruncated = output.data.length > maxRows;
	const visibleRows = isTruncated ? output.data.slice(0, maxRows) : output.data;
	const remainingRows = isTruncated ? output.data.length - maxRows : 0;

	return (
		<Block>
			<Span>Query ID: {output.id}</Span>
			<Span>
				Model: {output.model_name} | Measures: {output.measures.join(', ')} | Dimensions:{' '}
				{output.dimensions.length > 0 ? output.dimensions.join(', ') : 'none'}
			</Span>

			<TitledList title={`${pluralize('Column', output.columns.length)} (${output.columns.length})`}>
				{output.columns.map((column) => (
					<ListItem>{column}</ListItem>
				))}
			</TitledList>

			<Title>
				{pluralize('Row', output.row_count)} ({output.row_count})
			</Title>

			<Block>
				{visibleRows.map((row, i) => (
					<CodeBlock header={`#${i + 1}`}>
						<Block separator={'\n'}>
							{Object.entries(row).map(([key, value]) => `${key}: ${formatRowValue(value)}`)}
						</Block>
					</CodeBlock>
				))}
			</Block>

			{remainingRows > 0 && <Span>...({remainingRows} more)</Span>}

			{output.provenance && <ProvenanceSection provenance={output.provenance} />}
		</Block>
	);
};

const formatRowValue = (value: unknown) => {
	let strValue = '';
	if (typeof value === 'object') {
		strValue = JSON.stringify(value);
	} else {
		strValue = String(value);
	}
	return truncateMiddle(strValue, 255);
};

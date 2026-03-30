import type { buildContract } from '@dazense/shared/tools';

import { Block, Bold, List, ListItem, Span, Title } from '../../lib/markdown';

export const BuildContractOutput = ({ output }: { output: buildContract.Output }) => {
	if (output.status === 'allow') {
		return (
			<Block>
				<Title>Contract Approved</Title>
				<Span>
					Contract ID: <Bold>{output.contract_id}</Bold>
				</Span>
				<Span>Bundles: {output.contract.scope.dataset_bundles.join(', ') || 'none'}</Span>
				<Span>Tables: {output.contract.scope.tables.join(', ')}</Span>
				<Span>Tool: {output.contract.execution.tool}</Span>
				<Title level={2}>Policy Checks</Title>
				<List>
					{output.contract.policy.checks.map((check) => (
						<ListItem>
							[{check.status}] {check.name}
							{check.detail ? ` — ${check.detail}` : ''}
						</ListItem>
					))}
				</List>
			</Block>
		);
	}

	if (output.status === 'block') {
		return (
			<Block>
				<Title>Contract Blocked</Title>
				<Span>
					<Bold>Reason:</Bold> {output.reason}
				</Span>
				<Title level={2}>Suggested Fixes</Title>
				<List>
					{output.fixes.map((fix) => (
						<ListItem>{fix}</ListItem>
					))}
				</List>
				<Title level={2}>Policy Checks</Title>
				<List>
					{output.checks.map((check) => (
						<ListItem>
							[{check.status}] {check.name}
							{check.detail ? ` — ${check.detail}` : ''}
						</ListItem>
					))}
				</List>
			</Block>
		);
	}

	// needs_clarification
	return (
		<Block>
			<Title>Clarification Needed</Title>
			<List>
				{output.questions.map((q) => (
					<ListItem>{q}</ListItem>
				))}
			</List>
			{output.checks.length > 0 && (
				<Block>
					<Title level={2}>Policy Checks</Title>
					<List>
						{output.checks.map((check) => (
							<ListItem>
								[{check.status}] {check.name}
								{check.detail ? ` — ${check.detail}` : ''}
							</ListItem>
						))}
					</List>
				</Block>
			)}
		</Block>
	);
};

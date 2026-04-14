import { DBOS } from '@dbos-inc/dbos-sdk';
import { tool } from 'ai';
import { z } from 'zod';

import type { DeepAgentState } from '../state.js';

export const ALLOWED_SUBAGENTS = ['flight_ops', 'booking', 'customer_service'] as const;
export type AllowedSubagent = (typeof ALLOWED_SUBAGENTS)[number];

export type SubagentRunner = (
	subagentType: AllowedSubagent,
	description: string,
	sessionId: string,
) => Promise<{ agentId: string; answer: string }>;

/**
 * The task tool is the orchestrator's only path to data. It validates
 * the requested sub-agent against the allow-list, then runs the
 * existing runSubagentStep code path (full bundle scope + business
 * rules + governed query) inside its own DBOS step so each spawn is
 * independently checkpointed.
 */
export function createTaskTool(opts: { state: DeepAgentState; sessionId: string; runner: SubagentRunner }) {
	return tool({
		description:
			'Spawn a sub-agent to answer one concrete sub-question. The sub-question MUST name an entity ' +
			'(table or business term), a metric (count/average/rate/breakdown), and a time window. Vague ' +
			'topic handoffs produce meta-answers, not numbers.',
		inputSchema: z.object({
			description: z
				.string()
				.min(20)
				.max(800)
				.describe('Self-contained sub-question. Entity + metric + time window required.'),
			subagent_type: z.enum(ALLOWED_SUBAGENTS),
		}),
		execute: async ({ description, subagent_type }) => {
			const turn = opts.state.turn;
			const stepName = `task_${opts.state.taskResults.length}_${subagent_type}`;
			const preview = description.length > 100 ? description.slice(0, 97) + '...' : description;
			console.log(`\n🎯 task(${subagent_type}) — ${preview}`);
			const result = await DBOS.runStep(
				async () => opts.runner(subagent_type as AllowedSubagent, description, opts.sessionId),
				{ name: stepName },
			);
			opts.state.taskResults.push({
				subagentType: subagent_type,
				description,
				answer: result.answer,
				turn,
			});
			const answerPreview = result.answer.length > 120 ? result.answer.slice(0, 117) + '...' : result.answer;
			console.log(`    ↳ ${answerPreview}`);
			return result.answer;
		},
	});
}

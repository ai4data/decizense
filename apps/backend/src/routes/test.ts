import { z } from 'zod/v4';

import type { App } from '../app';
import { authMiddleware } from '../middleware/auth';
import { ModelSelection } from '../services/agent.service';
import { TestAgentService, testAgentService } from '../services/test-agent.service';
import { llmProviderSchema } from '../types/llm';

const modelSelectionSchema = z.object({
	provider: llmProviderSchema,
	modelId: z.string(),
});

export const testRoutes = async (app: App) => {
	app.addHook('preHandler', authMiddleware);

	/**
	 * Run a single prompt without persisting to a chat.
	 * Used for testing/evaluation purposes.
	 */
	app.post(
		'/run',
		{
			schema: {
				body: z.object({
					prompt: z.string(),
					model: modelSelectionSchema,
				}),
			},
		},
		async (request, reply) => {
			const projectId = request.project?.id;
			const { prompt, model } = request.body;

			if (!projectId) {
				return reply
					.status(400)
					.send({ error: 'No project configured. Set DAZENSE_DEFAULT_PROJECT_PATH environment variable.' });
			}

			try {
				const modelSelection = model as ModelSelection | undefined;
				const result = await testAgentService.runTest(projectId, prompt, modelSelection);

				return reply.send({
					text: result.text,
					toolCalls: TestAgentService.extractToolCalls(result),
					usage: result.usage,
					cost: result.cost,
					finishReason: result.finishReason,
					durationMs: result.durationMs,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				return reply.status(500).send({ error: message });
			}
		},
	);
};

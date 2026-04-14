import { tool } from 'ai';
import { z } from 'zod';

import type { DeepAgentState } from '../state.js';

export type RecordOutcomeFn = (decision: {
	decision: string;
	confidence: 'high' | 'medium' | 'low';
	evidence: string[];
}) => Promise<void>;

/**
 * Ends the deep-agent loop. Persists the decision via the harness as
 * a precedent and signals the loop to exit by setting state.finalized.
 */
export function createFinalizeTool(opts: { state: DeepAgentState; recordOutcome: RecordOutcomeFn }) {
	return tool({
		description:
			'Record the final decision and end the workflow. Call this only when you have enough governed ' +
			'evidence to answer the original question. Always cite each number with its source agent.',
		inputSchema: z.object({
			decision: z
				.string()
				.min(20)
				.describe('Final answer in plain language. State each number with its source agent and metric.'),
			confidence: z.enum(['high', 'medium', 'low']),
			evidence: z
				.array(z.string().min(5).max(300))
				.min(1)
				.describe('Short citations like "flight_ops: 115 delayed flights, top reason congestion (29)".'),
		}),
		execute: async ({ decision, confidence, evidence }) => {
			console.log(`\n✅ finalize — confidence=${confidence}, evidence=${evidence.length} citation(s)`);
			await opts.recordOutcome({ decision, confidence, evidence });
			opts.state.final = { decision, confidence, evidence };
			opts.state.finalized = true;
			return `Decision recorded with confidence=${confidence}. Workflow will exit.`;
		},
	});
}

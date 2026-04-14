import { tool } from 'ai';
import { z } from 'zod';

import type { DeepAgentState } from '../state.js';

export function createWriteNoteTool(state: DeepAgentState) {
	return tool({
		description:
			'Persist an intermediate fact or interim conclusion to the scratchpad. Use this for facts ' +
			'you have already obtained from sub-agents — never as a substitute for actually querying.',
		inputSchema: z.object({
			title: z.string().min(1).max(80).describe('Short metric-style title, e.g. "march_2026_delay_count"'),
			body: z.string().min(1).max(2000).describe('The fact, with units and source agent if applicable'),
		}),
		execute: async ({ title, body }) => {
			state.notes[title] = body;
			const preview = body.length > 80 ? body.slice(0, 77) + '...' : body;
			console.log(`\n📝 write_note — ${title}`);
			console.log(`    ${preview}`);
			return `Note saved: ${title}`;
		},
	});
}

export function createReadNotesTool(state: DeepAgentState) {
	return tool({
		description:
			'Read the current scratchpad. Returns all notes by title. Note: working state is also re-rendered ' +
			'into your context each turn, so this is rarely needed.',
		inputSchema: z.object({}),
		execute: async () => {
			const titles = Object.keys(state.notes);
			if (titles.length === 0) return '(no notes)';
			return titles.map((t) => `### ${t}\n${state.notes[t]}`).join('\n\n');
		},
	});
}

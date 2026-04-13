import { tool } from 'ai';
import { z } from 'zod';

import type { DeepAgentState, Todo, TodoStatus } from '../state.js';

const TodoItemSchema = z.object({
	id: z.string().min(1).max(40).describe('Stable identifier for this todo'),
	content: z.string().min(1).max(160).describe('What evidence/fact this todo represents'),
	status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
});

export function createWriteTodosTool(state: DeepAgentState) {
	return tool({
		description:
			'Write or update the working todo list. Use merge=true (default) to upsert by id; ' +
			'merge=false replaces the whole list.',
		inputSchema: z.object({
			todos: z
				.array(TodoItemSchema)
				.min(1)
				.describe('Todos to upsert (merge=true) or replace with (merge=false)'),
			merge: z.boolean().default(true),
		}),
		execute: async ({ todos, merge }) => {
			if (merge === false) {
				state.todos = todos as Todo[];
			} else {
				const byId = new Map<string, Todo>(state.todos.map((t) => [t.id, t]));
				for (const t of todos) {
					byId.set(t.id, { id: t.id, content: t.content, status: t.status as TodoStatus });
				}
				state.todos = Array.from(byId.values());
			}
			return formatTodos(state.todos);
		},
	});
}

function formatTodos(todos: Todo[]): string {
	if (todos.length === 0) return '(no todos)';
	return todos
		.map((t) => {
			const mark =
				t.status === 'completed'
					? '[x]'
					: t.status === 'in_progress'
						? '[~]'
						: t.status === 'cancelled'
							? '[-]'
							: '[ ]';
			return `${mark} ${t.id}: ${t.content}`;
		})
		.join('\n');
}

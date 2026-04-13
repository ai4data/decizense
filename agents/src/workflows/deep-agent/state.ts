/**
 * Deep-agent workflow state. The whole object is the unit of DBOS
 * checkpointing between turns: serialise → store → restore on replay.
 *
 * No methods on the type — keeping it a plain shape lets DBOS persist it
 * via JSON without any custom (de)serialiser.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface Todo {
	id: string;
	content: string;
	status: TodoStatus;
}

export interface TaskResult {
	subagentType: string;
	description: string;
	answer: string;
	turn: number;
}

export interface FinalDecision {
	decision: string;
	confidence: 'high' | 'medium' | 'low';
	evidence: string[];
}

export interface DeepAgentState {
	todos: Todo[];
	notes: Record<string, string>; // title -> body
	taskResults: TaskResult[];
	turn: number;
	finalized: boolean;
	final?: FinalDecision;
}

export function initialState(): DeepAgentState {
	return { todos: [], notes: {}, taskResults: [], turn: 0, finalized: false };
}

/**
 * Render the working state into a system-message section that the LLM
 * sees on every turn. Without this re-injection the model would only
 * see its own todos when it last called write_todos.
 */
export function renderState(state: DeepAgentState): string {
	const lines: string[] = ['# Working state (re-rendered each turn)'];

	lines.push('', '## Todos');
	if (state.todos.length === 0) {
		lines.push('(empty — write your initial plan with write_todos)');
	} else {
		for (const t of state.todos) {
			const mark =
				t.status === 'completed'
					? '[x]'
					: t.status === 'in_progress'
						? '[~]'
						: t.status === 'cancelled'
							? '[-]'
							: '[ ]';
			lines.push(`${mark} ${t.id}: ${t.content}`);
		}
	}

	lines.push('', '## Notes (scratchpad)');
	const noteTitles = Object.keys(state.notes);
	if (noteTitles.length === 0) {
		lines.push('(empty)');
	} else {
		for (const title of noteTitles) {
			lines.push(`### ${title}`);
			lines.push(state.notes[title]);
		}
	}

	lines.push('', '## Sub-agent task results so far');
	if (state.taskResults.length === 0) {
		lines.push('(none — spawn a sub-agent with the task tool when ready)');
	} else {
		for (const r of state.taskResults) {
			lines.push(`### turn ${r.turn} — ${r.subagentType}`);
			lines.push(`> ${r.description}`);
			lines.push(r.answer);
		}
	}

	return lines.join('\n');
}

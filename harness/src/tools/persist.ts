/**
 * PERSIST tools — "Durable state across sessions" (shared workspace)
 *
 * The decision store is the agent collaboration surface. Each agent writes
 * intermediate findings. The orchestrator reads all findings to combine
 * into a decision. Decisions become precedent for future sessions.
 *
 * All data persisted to PostgreSQL (same instance as scenario data).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeQuery } from '../database/index.js';

export function registerPersistTools(server: McpServer) {
	/**
	 * write_finding — Agent stores an intermediate result.
	 *
	 * Creates the session if it doesn't exist, then inserts the finding.
	 * PII should not be included in findings (enforced by inter-agent rules).
	 */
	server.tool(
		'write_finding',
		'Store an intermediate finding for the current session (shared workspace)',
		{
			session_id: z.string().describe('Current decision session ID'),
			agent_id: z.string().describe('Agent writing the finding'),
			finding: z.string().describe('The finding content (PII must not be included)'),
			confidence: z.enum(['high', 'medium', 'low']).describe('Confidence in this finding'),
			data_sources: z.array(z.string()).optional().describe('Tables/measures used'),
		},
		async ({ session_id, agent_id, finding, confidence, data_sources }) => {
			try {
				// Ensure session exists
				await executeQuery(
					`INSERT INTO decision_sessions (session_id, question, status)
					 VALUES ('${session_id}', '', 'active')
					 ON CONFLICT (session_id) DO NOTHING`,
				);

				// Insert finding
				const sources = data_sources ? `ARRAY[${data_sources.map((s) => `'${s}'`).join(',')}]` : 'NULL';
				const result = await executeQuery(
					`INSERT INTO decision_findings (session_id, agent_id, finding, confidence, data_sources)
					 VALUES ('${session_id}', '${agent_id}', '${finding.replace(/'/g, "''")}', '${confidence}', ${sources})
					 RETURNING finding_id, created_at`,
				);

				const row = result.rows[0] as { finding_id: number; created_at: string };

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								finding_id: row.finding_id,
								session_id,
								agent_id,
								stored: true,
								timestamp: row.created_at,
							}),
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ error: `Failed to store finding: ${(err as Error).message}` }),
						},
					],
				};
			}
		},
	);

	/**
	 * read_findings — Read all findings in the current session.
	 */
	server.tool(
		'read_findings',
		'Read all agent findings for the current session',
		{
			session_id: z.string().describe('Session to read findings from'),
			agent_filter: z.string().optional().describe('Only return findings from this agent'),
		},
		async ({ session_id, agent_filter }) => {
			try {
				const filter = agent_filter ? `AND agent_id = '${agent_filter}'` : '';
				const result = await executeQuery(
					`SELECT finding_id, agent_id, finding, confidence, data_sources, created_at
					 FROM decision_findings
					 WHERE session_id = '${session_id}' ${filter}
					 ORDER BY created_at ASC`,
				);

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								session_id,
								findings: result.rows,
								total: result.rowCount,
							}),
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ error: `Failed to read findings: ${(err as Error).message}` }),
						},
					],
				};
			}
		},
	);

	/**
	 * log_decision — Record the final decision with full reasoning chain.
	 */
	server.tool(
		'log_decision',
		'Record a final decision with full reasoning chain (becomes precedent)',
		{
			session_id: z.string().describe('Session this decision belongs to'),
			question: z.string().describe('The original question'),
			decision: z.string().describe('The final decision/answer'),
			reasoning: z.string().describe('How the decision was reached'),
			confidence: z.enum(['high', 'medium', 'low']).describe('Confidence in the decision'),
			agents_involved: z.array(z.string()).describe('Agent IDs that contributed'),
			cost_usd: z.number().optional().describe('Total LLM cost for this decision'),
		},
		async ({ session_id, question, decision, reasoning, confidence, agents_involved, cost_usd }) => {
			try {
				// Update session with the question
				await executeQuery(
					`UPDATE decision_sessions SET question = '${question.replace(/'/g, "''")}', status = 'completed'
					 WHERE session_id = '${session_id}'`,
				);

				// Insert decision
				const agents = `ARRAY[${agents_involved.map((a) => `'${a}'`).join(',')}]`;
				const cost = cost_usd ?? 0;
				const result = await executeQuery(
					`INSERT INTO decision_log (session_id, question, decision, reasoning, confidence, agents_involved, cost_usd)
					 VALUES ('${session_id}', '${question.replace(/'/g, "''")}', '${decision.replace(/'/g, "''")}',
					         '${reasoning.replace(/'/g, "''")}', '${confidence}', ${agents}, ${cost})
					 RETURNING decision_id, created_at`,
				);

				const row = result.rows[0] as { decision_id: number; created_at: string };

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								decision_id: row.decision_id,
								session_id,
								stored: true,
								timestamp: row.created_at,
							}),
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ error: `Failed to log decision: ${(err as Error).message}` }),
						},
					],
				};
			}
		},
	);

	/**
	 * save_memory — Persist agent memory across sessions.
	 */
	server.tool(
		'save_memory',
		'Save agent memory that persists across sessions',
		{
			agent_id: z.string().describe('Agent saving the memory'),
			key: z.string().describe('Memory key (topic or category)'),
			content: z.string().describe('Memory content to persist'),
		},
		async ({ agent_id, key, content }) => {
			try {
				await executeQuery(
					`INSERT INTO agent_memory (agent_id, key, content)
					 VALUES ('${agent_id}', '${key.replace(/'/g, "''")}', '${content.replace(/'/g, "''")}')
					 ON CONFLICT (agent_id, key) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
				);

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ agent_id, key, saved: true, timestamp: new Date().toISOString() }),
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ error: `Failed to save memory: ${(err as Error).message}` }),
						},
					],
				};
			}
		},
	);

	/**
	 * recall_memory — Retrieve past agent memory.
	 */
	server.tool(
		'recall_memory',
		'Retrieve agent memory from previous sessions',
		{
			agent_id: z.string().describe('Agent recalling memory'),
			key: z.string().optional().describe('Specific memory key, or omit for all'),
		},
		async ({ agent_id, key }) => {
			try {
				const filter = key ? `AND key = '${key.replace(/'/g, "''")}'` : '';
				const result = await executeQuery(
					`SELECT key, content, updated_at FROM agent_memory
					 WHERE agent_id = '${agent_id}' ${filter}
					 ORDER BY updated_at DESC`,
				);

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								agent_id,
								memories: result.rows,
								total: result.rowCount,
							}),
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ error: `Failed to recall memory: ${(err as Error).message}` }),
						},
					],
				};
			}
		},
	);
}

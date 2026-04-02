/**
 * CONTEXT INJECTION tools — "Right information at the right time"
 *
 * These tools provide agents with the context they need to make decisions.
 * The context graph is the primary source: it contains entities, rules,
 * rationale, glossary terms, lineage, and freshness expectations.
 *
 * Instead of dumping everything into the prompt, get_context() traverses
 * the graph and returns only what's relevant to the agent's question.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerContextTools(server: McpServer) {
	/**
	 * get_context — The primary context injection tool.
	 *
	 * Given a question, traverses the context graph and returns a focused
	 * context window: relevant entities, applicable rules (with rationale),
	 * freshness status, and similar past decisions.
	 *
	 * This is what the orchestrator calls first to understand what data,
	 * rules, and agents are needed for a question.
	 */
	server.tool(
		'get_context',
		'Get assembled context for a question — entities, rules, freshness, precedent',
		{
			question: z.string().describe('The business question to get context for'),
			agent_id: z.string().optional().describe("The requesting agent's identifier"),
		},
		async ({ question, agent_id }) => {
			// TODO: Wire to context graph — traverse intents, match entities, gather rules
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								_scaffold: true,
								question,
								agent_id: agent_id ?? 'unknown',
								entities: ['placeholder: matched entities from graph'],
								rules: ['placeholder: applicable business rules with rationale'],
								freshness: { status: 'placeholder: data freshness per table' },
								precedent: ['placeholder: similar past decisions'],
								suggested_agents: ['placeholder: which domain agents to involve'],
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	/**
	 * get_entity_details — Lookup a specific entity in the context graph.
	 *
	 * Returns the full node with properties, inbound/outbound edges,
	 * and catalog metadata (descriptions, tags, owners from OMD).
	 */
	server.tool(
		'get_entity_details',
		'Get full details of a specific entity from the context graph',
		{
			entity_id: z
				.string()
				.describe("Entity identifier (e.g. 'table:public.flights', 'measure:flights.delayed_flights')"),
		},
		async ({ entity_id }) => {
			// TODO: Wire to context graph — lookup node, gather edges and properties
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								_scaffold: true,
								entity_id,
								type: 'placeholder',
								properties: {},
								inbound_edges: [],
								outbound_edges: [],
								catalog_metadata: { description: '', tags: [], owners: [] },
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	/**
	 * get_lineage — Trace upstream dependencies.
	 *
	 * Shows what feeds into an entity: column → table → staging → raw source.
	 * Combines governance lineage (measure → column) with pipeline lineage
	 * (table → upstream table) from the catalog.
	 */
	server.tool(
		'get_lineage',
		'Trace upstream dependencies of an entity',
		{
			entity_id: z.string().describe('Entity to trace upstream from'),
			max_depth: z.number().optional().default(5).describe('Maximum traversal depth'),
		},
		async ({ entity_id, max_depth }) => {
			// TODO: Wire to context graph — lineageOf() with both governance and pipeline edges
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								_scaffold: true,
								entity_id,
								max_depth,
								upstream: ['placeholder: ordered list of upstream dependencies'],
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	/**
	 * search_glossary — Lookup business terms and their synonyms.
	 *
	 * Resolves business language to technical entities. "Revenue" → finds
	 * the glossary term with synonyms ["Sales", "Net Sales"] and linked
	 * assets [bookings.total_revenue].
	 */
	server.tool(
		'search_glossary',
		'Search for business terms, synonyms, and their linked data assets',
		{
			query: z.string().describe('Business term or concept to search for'),
		},
		async ({ query }) => {
			// TODO: Wire to context graph — search GlossaryTerm nodes by name and synonyms
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								_scaffold: true,
								query,
								matches: [
									{
										term: 'placeholder',
										synonyms: [],
										description: '',
										related_terms: [],
										linked_assets: [],
									},
								],
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	/**
	 * search_precedent — Find similar past decisions.
	 *
	 * Searches the decision store for past decisions related to the current
	 * question. Enables agents to learn from institutional memory instead
	 * of reasoning from scratch every time.
	 */
	server.tool(
		'search_precedent',
		'Find similar past decisions and their outcomes',
		{
			question: z.string().describe('The current question to find precedent for'),
			limit: z.number().optional().default(5).describe('Max number of results'),
		},
		async ({ question, limit }) => {
			// TODO: Wire to decision store — similarity search on past decisions
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								_scaffold: true,
								question,
								limit,
								precedents: [
									{
										decision_id: 'placeholder',
										question: 'placeholder: similar past question',
										outcome: 'placeholder: what was decided',
										confidence: 'placeholder',
										timestamp: 'placeholder',
									},
								],
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	/**
	 * get_rationale — Why does a rule or policy exist?
	 *
	 * Returns the structured reasoning behind a governance rule: the source
	 * (incident, regulation, policy), the reference, the description, and
	 * who authored it.
	 */
	server.tool(
		'get_rationale',
		'Get the reasoning behind a business rule or policy',
		{
			rule_name: z.string().describe('Name of the rule to get rationale for'),
		},
		async ({ rule_name }) => {
			// TODO: Wire to context graph — traverse Rule → JUSTIFIED_BY → Rationale
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								_scaffold: true,
								rule_name,
								rationale: {
									source: 'placeholder: incident|regulation|policy',
									reference: 'placeholder: reference ID',
									description: 'placeholder: why this rule exists',
									author: 'placeholder',
									date: 'placeholder',
								},
							},
							null,
							2,
						),
					},
				],
			};
		},
	);
}

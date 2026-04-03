/**
 * CONTEXT INJECTION tools — "Right information at the right time"
 *
 * These tools read from the catalog (OpenMetadata) first, falling back
 * to local YAML if the catalog is unavailable.
 *
 * Design principle: maximize what comes from OMD, minimize YAML.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getCatalogClient } from '../catalog/index.js';
import { executeQuery } from '../database/index.js';

export function registerContextTools(server: McpServer) {
	/**
	 * get_context — The primary context injection tool.
	 *
	 * Queries the catalog for entities, glossary terms, tags, lineage,
	 * and business rules relevant to the question.
	 */
	server.tool(
		'get_context',
		'Get assembled context for a question — entities, rules, freshness, precedent from catalog',
		{
			question: z.string().describe('The business question to get context for'),
			agent_id: z.string().optional().describe("The requesting agent's identifier"),
		},
		async ({ question, agent_id }) => {
			const catalog = getCatalogClient();

			if (!catalog) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ error: 'Catalog not available', _scaffold: true }),
						},
					],
				};
			}

			// Get tables and glossary from catalog
			const [tables, glossaryTerms] = await Promise.all([catalog.listTables(), catalog.listGlossaryTerms()]);

			// Match glossary terms by checking if question contains term name or synonyms
			const questionLower = question.toLowerCase();
			const matchedTerms = glossaryTerms.filter(
				(t) =>
					questionLower.includes(t.name.toLowerCase()) ||
					t.synonyms.some((s: string) => questionLower.includes(s.toLowerCase())),
			);

			// Find tables linked to matched terms
			const relevantTableNames = new Set<string>();
			for (const term of matchedTerms) {
				for (const table of tables) {
					if (table.glossaryTerms.some((gt) => gt.includes(term.name))) {
						relevantTableNames.add(table.name);
					}
				}
			}

			// If no glossary match, find tables by keyword
			if (relevantTableNames.size === 0) {
				for (const table of tables) {
					if (
						questionLower.includes(table.name.toLowerCase()) ||
						table.description
							.toLowerCase()
							.includes(questionLower.split(' ').filter((w) => w.length > 3)[0] ?? '')
					) {
						relevantTableNames.add(table.name);
					}
				}
			}

			const relevantTables = tables.filter((t) => relevantTableNames.has(t.name));

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								question,
								agent_id: agent_id ?? 'unknown',
								source: 'catalog',
								matched_glossary_terms: matchedTerms.map((t) => ({
									name: t.name,
									description: t.description,
									synonyms: t.synonyms,
									related: t.relatedTerms,
								})),
								relevant_tables: relevantTables.map((t) => ({
									name: t.name,
									description: t.description,
									tier: t.tier,
									pii_columns: t.piiColumns,
									owners: t.owners,
									columns: t.columns.map((c) => c.name),
								})),
								all_pii_columns: tables.flatMap((t) => t.piiColumns.map((c) => `${t.name}.${c}`)),
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
	 * get_entity_details — Lookup a specific table from the catalog.
	 */
	server.tool(
		'get_entity_details',
		'Get full details of a table from the catalog — columns, tags, owners, description',
		{
			entity_id: z.string().describe("Table name (e.g. 'flights', 'bookings')"),
		},
		async ({ entity_id }) => {
			const catalog = getCatalogClient();
			if (!catalog) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Catalog not available' }) }],
				};
			}

			const tables = await catalog.listTables();
			const table = tables.find((t) => t.name === entity_id || t.fqn.includes(entity_id));

			if (!table) {
				return {
					content: [
						{ type: 'text' as const, text: JSON.stringify({ error: `Table ${entity_id} not found` }) },
					],
				};
			}

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								name: table.name,
								fqn: table.fqn,
								description: table.description,
								tier: table.tier,
								owners: table.owners,
								tags: table.tags,
								pii_columns: table.piiColumns,
								columns: table.columns.map((c) => ({
									name: c.name,
									type: c.dataType,
									description: c.description,
									pii: c.isPii,
								})),
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
	 * get_lineage — Trace upstream dependencies from the catalog.
	 */
	server.tool(
		'get_lineage',
		'Trace upstream dependencies of a table from the catalog lineage',
		{
			entity_id: z.string().describe('Table name to trace upstream from'),
			max_depth: z.number().optional().default(3).describe('Maximum traversal depth'),
		},
		async ({ entity_id, max_depth }) => {
			const catalog = getCatalogClient();
			if (!catalog) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Catalog not available' }) }],
				};
			}

			// Build full FQN if not provided
			const fqn = entity_id.includes('.') ? entity_id : `travel_postgres.travel_db.public.${entity_id}`;

			const edges = await catalog.getLineage(fqn, max_depth);

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								entity: entity_id,
								upstream: edges.map((e) => ({
									from: e.from.split('.').pop(),
									to: e.to.split('.').pop(),
								})),
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
	 * search_glossary — Search catalog glossary terms.
	 */
	server.tool(
		'search_glossary',
		'Search for business terms, synonyms, and descriptions from the catalog glossary',
		{
			query: z.string().describe('Business term or concept to search for'),
		},
		async ({ query }) => {
			const catalog = getCatalogClient();
			if (!catalog) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Catalog not available' }) }],
				};
			}

			const terms = await catalog.listGlossaryTerms();
			const queryLower = query.toLowerCase();

			const matches = terms.filter(
				(t) =>
					t.name.toLowerCase().includes(queryLower) ||
					t.description.toLowerCase().includes(queryLower) ||
					t.synonyms.some((s: string) => s.toLowerCase().includes(queryLower)),
			);

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								query,
								matches: matches.map((t) => ({
									name: t.name,
									description: t.description,
									synonyms: t.synonyms,
									related_terms: t.relatedTerms,
								})),
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
	 * search_precedent — Find similar past decisions from the decision store.
	 *
	 * Searches by keyword matching in question and decision text.
	 * Returns past decisions with reasoning and confidence.
	 */
	server.tool(
		'search_precedent',
		'Find similar past decisions and their outcomes',
		{
			question: z.string().describe('The current question to find precedent for'),
			limit: z.number().optional().default(5).describe('Max number of results'),
		},
		async ({ question, limit }) => {
			try {
				// Extract keywords for search (words > 3 chars)
				const keywords = question
					.toLowerCase()
					.split(/\s+/)
					.filter((w) => w.length > 3)
					.slice(0, 5);

				const conditions = keywords
					.map((kw) => `(LOWER(question) LIKE '%${kw}%' OR LOWER(decision) LIKE '%${kw}%')`)
					.join(' OR ');

				const whereClause = conditions ? `WHERE ${conditions}` : '';
				const result = await executeQuery(
					`SELECT decision_id, session_id, question, decision, reasoning, confidence, agents_involved, cost_usd, created_at
					 FROM decision_log ${whereClause}
					 ORDER BY created_at DESC LIMIT ${limit ?? 5}`,
				);

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{ question, precedents: result.rows, total: result.rowCount },
								null,
								2,
							),
						},
					],
				};
			} catch {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ question, precedents: [], total: 0 }, null, 2),
						},
					],
				};
			}
		},
	);

	/**
	 * get_rationale — Why does a rule exist?
	 * Reads from scenario YAML (OMD doesn't model enforcement rules).
	 */
	server.tool(
		'get_rationale',
		'Get the reasoning behind a business rule or policy',
		{
			rule_name: z.string().describe('Name of the rule to get rationale for'),
		},
		async ({ rule_name }) => {
			// This stays in YAML — OMD doesn't model enforcement rules with rationale
			// TODO: Wire to ScenarioLoader.businessRules
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ _scaffold: true, rule_name, rationale: null }, null, 2),
					},
				],
			};
		},
	);
}

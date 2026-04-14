/**
 * Pure builder for the sub-agent system prompt.
 *
 * Isolated from the runtime so the regression test (test-semantic-grounding.ts)
 * can exercise it with fixture data and assert the prompt carries authoritative
 * column names, measures, dimensions, allowed joins, and rule guidance — i.e.
 * the semantic-layer signals that prevent SQL hallucination.
 *
 * Shape is deliberately narrow: this function does NOT call the harness, does
 * NOT invoke the LLM, and has no side effects. Callers are responsible for
 * fetching the inputs.
 */

import type { EntityDetails } from '../../harness-client.js';

export interface SubagentPromptInputs {
	basePrompt: string; // agent's system_prompt from scenario YAML
	maxRows: number;
	scope: {
		tables: string[]; // FQNs like "public.flights"
		measures: string[]; // e.g. "flights.delayed_flights"
		dimensions: string[]; // e.g. "flights.airline_code"
		allowedJoins: string[]; // e.g. "flights.origin = airports.airport_code"
		blockedColumns?: string[]; // PII, may span multiple tables
	};
	entityDetails: EntityDetails[]; // one per table in scope.tables; order matches
	rules: Array<{
		severity: string;
		name: string;
		description?: string;
		guidance?: string;
		rationale?: string | null;
	}>;
}

export function buildSubagentSystemPrompt(inputs: SubagentPromptInputs): string {
	const parts: string[] = [];

	if (inputs.basePrompt.trim()) {
		parts.push(inputs.basePrompt.trim());
	}

	parts.push('# Authoritative schema from the catalog');
	parts.push(
		'These are the ONLY tables and columns you may reference. Do not invent',
		'CTE aliases that look like table names (e.g. "base_flights") and do not',
		'guess column names — everything you need is listed below. Column types',
		'are shown in parentheses; PII columns are marked and are globally blocked.',
		'',
	);

	for (const entity of inputs.entityDetails) {
		if (entity.error || !Array.isArray(entity.columns)) {
			parts.push(
				`## ${entity.name ?? '(unknown)'} — details unavailable: ${entity.error ?? 'no columns returned'}`,
			);
			continue;
		}
		const fqn = entity.fqn || entity.name;
		const cols = entity.columns
			.map((c) => {
				const piiMark = c.pii ? ' [PII — blocked]' : '';
				return `    ${c.name} ${c.type}${piiMark}`;
			})
			.join('\n');
		parts.push(`## ${fqn}`);
		if (entity.description) parts.push(entity.description);
		parts.push(cols);
		parts.push('');
	}

	if (inputs.scope.measures.length > 0) {
		parts.push('# Governed measures available (from semantic_model.yml)');
		parts.push(inputs.scope.measures.map((m) => `  - ${m}`).join('\n'));
		parts.push('');
	}

	if (inputs.scope.dimensions.length > 0) {
		parts.push('# Governed dimensions available');
		parts.push(inputs.scope.dimensions.map((d) => `  - ${d}`).join('\n'));
		parts.push('');
	}

	if (inputs.scope.allowedJoins.length > 0) {
		parts.push('# Allowed joins (any other join is policy-blocked)');
		parts.push(inputs.scope.allowedJoins.map((j) => `  - ${j}`).join('\n'));
		parts.push('');
	}

	if (inputs.scope.blockedColumns && inputs.scope.blockedColumns.length > 0) {
		parts.push('# PII columns — globally blocked');
		parts.push(inputs.scope.blockedColumns.map((c) => `  - ${c}`).join('\n'));
		parts.push('');
	}

	if (inputs.rules.length > 0) {
		parts.push('# Business rules that apply to your scope');
		for (const r of inputs.rules) {
			const headline = `- [${r.severity}] ${r.name}`;
			parts.push(headline);
			if (r.description) parts.push(`    description: ${r.description}`);
			if (r.guidance) parts.push(`    guidance:    ${r.guidance}`);
			if (r.rationale) parts.push(`    rationale:   ${r.rationale}`);
		}
		parts.push('');
	}

	parts.push(
		'# Query discipline',
		`Max rows: ${inputs.maxRows}. Always include an explicit LIMIT on non-aggregate SELECTs.`,
		'',
		'**Prefer the `query_metrics` tool over `query_data` whenever the question can be',
		'expressed as a list of governed measures (and optional dimensions / filters /',
		'time_range / time_grain).** The harness compiles, governs, and returns the SQL',
		'it ran — so business-rule logic baked into a measure (e.g. "delayed_flights"',
		"already filters status = 'delayed') is applied correctly without you re-deriving",
		'it. Pass refs as "model.measure_name" / "model.dimension_name" using the names',
		'in the "Governed measures available" / "Governed dimensions available" sections',
		'above. Use `query_data` only for ad-hoc shapes (cross-tabs, custom predicates,',
		'CTE pipelines) that the semantic model cannot express.',
		'',
		'Qualify every `query_data` table reference with the "public." schema. Never',
		'SELECT * over a PII-bearing table.',
		'',
		'On a blocked result, report the reason verbatim — do not retry blindly and do',
		'not paraphrase "blocked" as "something went wrong".',
	);

	return parts.join('\n');
}

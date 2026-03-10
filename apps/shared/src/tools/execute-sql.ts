import z from 'zod/v3';

import { ProvenanceSchema } from './build-contract';

export const InputSchema = z.object({
	sql_query: z.string().describe('The SQL query to execute'),
	database_id: z
		.string()
		.optional()
		.describe('The database name/id to use. Required if multiple databases are configured.'),
	contract_id: z
		.string()
		.optional()
		.describe('Contract ID from build_contract. Required when execution.require_contract is true in policy.'),
});

export const OutputSchema = z.object({
	_version: z.literal('1').optional(),
	data: z.array(z.any()),
	row_count: z.number(),
	columns: z.array(z.string()),
	/** The id of the query result. May be referenced by the `display_chart` tool call. */
	id: z.custom<`query_${string}`>(),
	/** Provenance from the execution contract, when available. */
	provenance: ProvenanceSchema.optional(),
});

export type Input = z.infer<typeof InputSchema>;
export type Output = z.infer<typeof OutputSchema>;

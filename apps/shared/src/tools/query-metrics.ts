import z from 'zod/v3';

import { ProvenanceSchema } from './build-contract';

export const FilterSchema = z.object({
	column: z.string().describe('Column name to filter on'),
	operator: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in']).default('eq').describe('Filter operator'),
	value: z.any().describe('Value to compare against'),
});

export const OrderBySchema = z.object({
	column: z.string().describe('Column name to order by'),
	ascending: z.boolean().default(true).describe('Sort ascending (true) or descending (false)'),
});

export const InputSchema = z.object({
	model_name: z.string().describe('The semantic model name to query (e.g. "orders", "customers")'),
	measures: z.array(z.string()).min(1).describe('Measures to compute (e.g. ["order_count", "total_amount"])'),
	dimensions: z.array(z.string()).default([]).describe('Dimensions to group by (e.g. ["status", "customer.name"])'),
	filters: z.array(FilterSchema).default([]).describe('Filters to apply'),
	order_by: z.array(OrderBySchema).default([]).describe('Ordering of results'),
	limit: z.number().optional().describe('Maximum number of rows to return'),
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
	model_name: z.string(),
	measures: z.array(z.string()),
	dimensions: z.array(z.string()),
	/** The id of the query result. May be referenced by the `display_chart` tool call. */
	id: z.custom<`query_${string}`>(),
	/** Provenance from the execution contract, when available. */
	provenance: ProvenanceSchema.optional(),
});

export type Input = z.infer<typeof InputSchema>;
export type Output = z.infer<typeof OutputSchema>;

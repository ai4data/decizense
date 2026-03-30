import z from 'zod/v3';

export const InputSchema = z.object({
	entity_id: z
		.string()
		.describe(
			'The graph node ID to measure downstream impact for. Use short names like "main.orders.amount" or full IDs like "column:duckdb-jaffle-shop/main.orders/amount".',
		),
});

export const ImpactNodeSchema = z.object({
	id: z.string(),
	type: z.string(),
});

export const OutputSchema = z.object({
	_version: z.literal('1').optional(),
	entity_id: z.string(),
	resolved_id: z.string(),
	affected: z.array(ImpactNodeSchema),
	summary: z.string(),
});

export type Input = z.infer<typeof InputSchema>;
export type Output = z.infer<typeof OutputSchema>;

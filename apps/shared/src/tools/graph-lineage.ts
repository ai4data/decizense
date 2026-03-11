import z from 'zod/v3';

export const InputSchema = z.object({
	entity_id: z
		.string()
		.describe(
			'The graph node ID to trace upstream lineage for. Use short names like "orders.total_revenue" or full IDs like "measure:jaffle_shop/orders.total_revenue".',
		),
});

export const LineageNodeSchema = z.object({
	id: z.string(),
	type: z.string(),
});

export const OutputSchema = z.object({
	_version: z.literal('1').optional(),
	entity_id: z.string(),
	resolved_id: z.string(),
	upstream: z.array(LineageNodeSchema),
	summary: z.string(),
});

export type Input = z.infer<typeof InputSchema>;
export type Output = z.infer<typeof OutputSchema>;

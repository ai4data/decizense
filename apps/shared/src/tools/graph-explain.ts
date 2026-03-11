import z from 'zod/v3';

export const InputSchema = z.object({
	entity_id: z
		.string()
		.describe(
			'The graph node ID to explain. Use short names like "customers.first_name" or full IDs like "column:duckdb-jaffle-shop/main.customers/first_name".',
		),
	question: z
		.string()
		.optional()
		.describe('Optional question to focus the explanation, e.g. "why blocked?", "what rules apply?"'),
});

export const EdgeInfoSchema = z.object({
	from: z.string(),
	to: z.string(),
	type: z.string(),
	from_type: z.string(),
	to_type: z.string(),
});

export const OutputSchema = z.object({
	_version: z.literal('1').optional(),
	entity_id: z.string(),
	resolved_id: z.string(),
	node_type: z.string(),
	properties: z.record(z.unknown()),
	inbound_edges: z.array(EdgeInfoSchema),
	outbound_edges: z.array(EdgeInfoSchema),
	explanation: z.string(),
});

export type Input = z.infer<typeof InputSchema>;
export type Output = z.infer<typeof OutputSchema>;

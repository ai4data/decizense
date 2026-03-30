import z from 'zod/v3';

export const InputSchema = z.object({
	check: z
		.enum(['pii', 'models', 'rules', 'all'])
		.default('all')
		.describe('Which governance gap check to run: pii, models, rules, or all.'),
});

export const GapEntrySchema = z.object({
	node_id: z.string(),
	node_type: z.string(),
	category: z.string(),
	description: z.string(),
});

export const OutputSchema = z.object({
	_version: z.literal('1').optional(),
	check: z.string(),
	gaps: z.array(GapEntrySchema),
	summary: z.string(),
});

export type Input = z.infer<typeof InputSchema>;
export type Output = z.infer<typeof OutputSchema>;

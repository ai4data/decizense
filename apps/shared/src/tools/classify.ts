import z from 'zod/v3';

export const InputSchema = z.object({
	name: z.string().optional().describe('Retrieve a specific classification by name'),
	tags: z.array(z.string()).default([]).describe('Filter classifications by tags (e.g. ["zone", "fare", "tip"])'),
});

export const ClassificationSchema = z.object({
	name: z.string(),
	description: z.string(),
	condition: z.string().optional(),
	columns: z.array(z.string()).default([]),
	tags: z.array(z.string()),
	characteristics: z.record(z.string()).default({}),
});

export const OutputSchema = z.object({
	_version: z.literal('1').optional(),
	classifications: z.array(ClassificationSchema),
	available_names: z.array(z.string()),
});

export type Input = z.infer<typeof InputSchema>;
export type Output = z.infer<typeof OutputSchema>;

import z from 'zod/v3';

// ── Dataset Bundle schema (for loading datasets/<bundle_id>/dataset.yaml) ──

export const JoinEdgeSchema = z.object({
	schema: z.string(),
	table: z.string(),
	column: z.string(),
});

export const JoinSpecSchema = z.object({
	left: JoinEdgeSchema,
	right: JoinEdgeSchema,
	type: z.enum(['many_to_one', 'one_to_many', 'one_to_one', 'many_to_many']).optional(),
	description: z.string().optional(),
});

export const DatasetBundleSchema = z.object({
	version: z.number().default(1),
	bundle_id: z.string(),
	display_name: z.string().optional(),
	description: z.string().optional(),
	owners: z.array(z.object({ name: z.string(), email: z.string().optional() })).optional(),
	warehouse: z.object({
		type: z.string(),
		database_id: z.string(),
	}),
	tables: z.array(
		z.object({
			schema: z.string(),
			table: z.string(),
		}),
	),
	joins: z.array(JoinSpecSchema).default([]),
	defaults: z
		.object({
			time_column_by_table: z.record(z.string()).optional(),
			max_rows: z.number().optional(),
			require_time_filter_for_tables: z.array(z.string()).optional(),
			demo_current_date: z.string().optional(),
			data_start_date: z.string().optional(),
		})
		.optional(),
	certification: z
		.object({
			level: z.enum(['certified', 'candidate', 'experimental']).default('experimental'),
		})
		.optional(),
	use_cases: z
		.array(
			z.object({
				id: z.string(),
				question_examples: z.array(z.string()).optional(),
			}),
		)
		.optional(),
});

export type DatasetBundle = z.infer<typeof DatasetBundleSchema>;

// ── Policy schema (for loading policies/policy.yml) ──

export const PolicySchema = z.object({
	version: z.number().default(1),
	defaults: z
		.object({
			max_rows: z.number().default(200),
			max_preview_rows: z.number().default(20),
			require_limit_for_raw_rows: z.boolean().default(true),
			require_time_filter_for_fact_tables: z.boolean().default(true),
			time_filter_max_days_default: z.number().default(90),
		})
		.default({}),
	pii: z
		.object({
			mode: z.enum(['block', 'mask']).default('block'),
			tags: z.array(z.string()).default(['PII', 'Sensitive']),
			columns: z.record(z.array(z.string())).default({}),
		})
		.default({}),
	certification: z
		.object({
			prefer: z.enum(['certified', 'candidate', 'experimental']).default('certified'),
			require_for_execute_sql: z.boolean().default(false),
			require_for_query_metrics: z.boolean().default(false),
		})
		.default({}),
	joins: z
		.object({
			enforce_bundle_allowlist: z.boolean().default(true),
			allow_cross_bundle: z.boolean().default(false),
		})
		.default({}),
	execution: z
		.object({
			allow_execute_sql: z.boolean().default(true),
			allow_query_metrics: z.boolean().default(true),
			require_contract: z.boolean().default(false),
			require_bundle: z.boolean().default(false),
			sql_validation: z
				.object({
					mode: z.enum(['parse', 'compile']).default('parse'),
					disallow_multi_statement: z.boolean().default(true),
					enforce_limit: z.boolean().default(true),
				})
				.default({}),
		})
		.default({}),
});

export type PolicyConfig = z.infer<typeof PolicySchema>;

// ── Contract schema ──

export const CheckResultSchema = z.object({
	name: z.string(),
	status: z.enum(['pass', 'fail', 'warn']),
	detail: z.string().optional(),
});

export const ContractSchema = z.object({
	version: z.literal(1).default(1),
	contract_id: z.string(),
	created_at: z.string(),
	project_path: z.string(),
	actor: z.object({
		role: z.string().default('user'),
		user_id: z.string().default('local'),
		session_id: z.string().optional(),
	}),
	request: z.object({
		user_prompt: z.string(),
		intent: z.string().optional(),
		ambiguity: z
			.object({
				is_ambiguous: z.boolean().default(false),
				notes: z.array(z.string()).default([]),
			})
			.optional(),
	}),
	scope: z.object({
		warehouse: z.object({ type: z.string(), database_id: z.string() }).optional(),
		dataset_bundles: z.array(z.string()).default([]),
		tables: z.array(z.string()).default([]),
		/** Approved join edges from the bundle allowlist. */
		approved_joins: z
			.array(
				z.object({
					left_table: z.string(),
					left_column: z.string(),
					right_table: z.string(),
					right_column: z.string(),
				}),
			)
			.default([]),
		/** Time column per table (from bundle defaults.time_column_by_table). */
		time_columns: z.record(z.string()).default({}),
		time_window: z
			.object({
				type: z.string().optional(),
				resolved_start: z.string().optional(),
				resolved_end: z.string().optional(),
			})
			.optional(),
		grain: z.string().optional(),
	}),
	meaning: z
		.object({
			metrics: z
				.array(
					z.object({
						id: z.string(),
						source: z.string().optional(),
						definition_notes: z.array(z.string()).optional(),
					}),
				)
				.default([]),
			guidance_rules_referenced: z.array(z.string()).default([]),
		})
		.optional(),
	execution: z.object({
		tool: z.enum(['execute_sql', 'query_metrics']),
		params: z.record(z.any()),
	}),
	policy: z.object({
		decision: z.enum(['allow', 'block', 'needs_clarification']),
		checks: z.array(CheckResultSchema).default([]),
	}),
});

export type Contract = z.infer<typeof ContractSchema>;

// ── build_contract tool I/O schemas ──

export const TimeWindowSchema = z.object({
	type: z.string().optional().describe('Time window type, e.g. "last_month", "last_7_days"'),
	resolved_start: z.string().optional().describe('Resolved start date (ISO 8601)'),
	resolved_end: z.string().optional().describe('Resolved end date (ISO 8601)'),
});

export const AmbiguitySchema = z.object({
	is_ambiguous: z.boolean().describe('Whether the user question has multiple possible interpretations'),
	notes: z.array(z.string()).default([]).describe('Describe each possible interpretation if ambiguous'),
});

export const InputSchema = z.object({
	user_prompt: z.string().describe('The original user question'),
	ambiguity: AmbiguitySchema.describe(
		'Your assessment of whether the question is ambiguous. If is_ambiguous is true, the contract will return needs_clarification so you can ask the user to disambiguate BEFORE executing.',
	),
	bundle_id: z.string().nullish().describe('Dataset bundle ID. Null or omitted if not chosen yet.'),
	tables: z.array(z.string()).describe('Tables to query (schema.table format)'),
	joins: z.array(JoinSpecSchema).default([]).describe('Join specifications'),
	metric_refs: z.array(z.string()).default([]).describe('Metric IDs from semantic_model.yml'),
	time_window: TimeWindowSchema.optional().describe('Time window for the query'),
	tool: z.enum(['execute_sql', 'query_metrics']).describe('Which execution tool to use'),
	params: z.record(z.any()).default({}).describe('Parameters to pass to the execution tool'),
});

export const OutputSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('allow'),
		contract_id: z.string(),
		contract: ContractSchema,
	}),
	z.object({
		status: z.literal('block'),
		reason: z.string(),
		fixes: z.array(z.string()),
		checks: z.array(CheckResultSchema),
	}),
	z.object({
		status: z.literal('needs_clarification'),
		questions: z.array(z.string()),
		checks: z.array(CheckResultSchema).default([]),
	}),
]);

export type Input = z.infer<typeof InputSchema>;
export type Output = z.infer<typeof OutputSchema>;

// ── Provenance schema (embedded in execute_sql / query_metrics output) ──

export const ProvenanceSchema = z.object({
	contract_id: z.string(),
	bundle_id: z.string().optional(),
	tables: z.array(z.string()),
	checks: z.array(
		z.object({
			name: z.string(),
			status: z.enum(['pass', 'warn']),
			detail: z.string().optional(),
		}),
	),
});

export type Provenance = z.infer<typeof ProvenanceSchema>;

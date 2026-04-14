/**
 * LAYER 3: OPERATIONAL/EVENT tools
 *
 * The event log is the append-only source of truth for what happened.
 * Each booking is a process instance (case_id = booking_id).
 *
 * These tools provide:
 * - Event ingestion (append new events)
 * - Case timelines (full lifecycle of a booking)
 * - Process signals (bottlenecks, patterns, anomalies)
 *
 * Process signals feed Layer 4 (Decision) as evidence for proposals.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
	ScenarioLoader,
	type EventCorrelationKey,
	type EventSchemaConfig,
	type SignalDefinition,
	type SignalParam,
} from '../config/index.js';
import { executeQuery } from '../database/index.js';

let loader: ScenarioLoader | null = null;

export function initEventTools(scenarioPath: string) {
	loader = new ScenarioLoader(scenarioPath);
}

/**
 * Bind caller-provided arguments to a signal's declared params, in the
 * declared order, applying defaults and lightweight validation. Returns
 * the values ready to pass to pg as positional placeholders — or an
 * error string if validation fails. No SQL text manipulation happens
 * here; the template is used verbatim.
 */
export function bindSignalParams(
	def: SignalDefinition,
	args: Record<string, unknown>,
): { values: unknown[] } | { error: string } {
	const values: unknown[] = [];
	for (const p of def.params) {
		const raw = args[p.name];
		const provided = raw !== undefined && raw !== null;

		if (!provided) {
			if (p.required && p.default === undefined) {
				return { error: `Missing required parameter "${p.name}" for signal "${def.name}"` };
			}
			if (p.default === undefined) {
				// Truly optional with no default — bind SQL NULL rather than
				// trying to coerce undefined (which would always error). The
				// scenario-authored template is responsible for handling a
				// NULL bind (e.g. COALESCE($N, default_expr)).
				values.push(null);
				continue;
			}
		}

		const val = provided ? raw : p.default;
		const bound = coerceParam(p, val);
		if ('error' in bound) return bound;
		values.push(bound.value);
	}
	return { values };
}

function jsonContent(payload: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function getEventSchemaOrError(): { value: EventSchemaConfig } | { status: 'unsupported'; reason: string } {
	if (!loader) {
		return { status: 'unsupported', reason: 'Event tools called before initialisation' };
	}
	const schema = loader.eventSchema;
	if (!schema) {
		return {
			status: 'unsupported',
			reason: 'No events schema for this scenario. Add <scenario>/semantics/events.yml with table, type_column, timestamp_column, and correlation_keys.',
		};
	}
	return { value: schema };
}

function bindCorrelations(
	schema: EventSchemaConfig,
	args: Record<string, unknown>,
): { values: Record<string, unknown> } | { error: string } {
	const known = new Set(schema.correlation_keys.map((k) => k.name));
	for (const k of Object.keys(args)) {
		if (!known.has(k)) {
			return { error: `Unknown correlation key "${k}". Declared keys: ${[...known].join(', ')}` };
		}
	}
	const values: Record<string, unknown> = {};
	for (const key of schema.correlation_keys) {
		const v = args[key.name];
		if (v === undefined || v === null) {
			values[key.name] = null;
			continue;
		}
		const coerced = coerceCorrelation(key, v);
		if ('error' in coerced) return { error: coerced.error };
		values[key.name] = coerced.value;
	}
	return { values };
}

function coerceCorrelation(k: EventCorrelationKey, v: unknown): { value: unknown } | { error: string } {
	if (k.kind === 'int') {
		const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
		if (!Number.isFinite(n) || !Number.isInteger(n)) {
			return { error: `Correlation key "${k.name}" must be an integer (got ${JSON.stringify(v)})` };
		}
		return { value: n };
	}
	if (k.kind === 'string') {
		if (typeof v !== 'string') return { error: `Correlation key "${k.name}" must be a string` };
		return { value: v };
	}
	return { error: `Unknown correlation kind for "${k.name}"` };
}

function coerceParam(p: SignalParam, val: unknown): { value: unknown } | { error: string } {
	if (p.kind === 'int') {
		const n = typeof val === 'number' ? val : typeof val === 'string' ? Number(val) : NaN;
		if (!Number.isFinite(n) || !Number.isInteger(n)) {
			return { error: `Parameter "${p.name}" must be an integer (got ${JSON.stringify(val)})` };
		}
		if (p.max !== undefined && n > p.max) {
			return { error: `Parameter "${p.name}" exceeds max (${p.max})` };
		}
		return { value: p.as_interval_days ? `${n} days` : n };
	}
	if (p.kind === 'string') {
		if (typeof val !== 'string') {
			return { error: `Parameter "${p.name}" must be a string` };
		}
		return { value: val };
	}
	return { error: `Unknown param kind for "${p.name}"` };
}

export function registerEventTools(server: McpServer) {
	/**
	 * ingest_event — Append a new event to the operational log.
	 *
	 * Events are immutable and append-only. Once written, they cannot
	 * be modified or deleted. This is the source of truth.
	 */
	server.tool(
		'ingest_event',
		'Append a new event to the operational event log (append-only, immutable). Correlation keys are scenario-defined; see events.yml.',
		{
			event_type: z.string().describe('Event type string (scenario-defined discriminator).'),
			correlations: z
				.record(z.string(), z.union([z.number(), z.string(), z.null()]))
				.optional()
				.describe(
					'Map of correlation-key names to values. Keys must match entries in the scenario events.yml > correlation_keys. Unknown keys are rejected; missing keys are stored as NULL.',
				),
			metadata: z.record(z.string(), z.unknown()).optional().describe('Additional event data as JSON'),
		},
		async ({ event_type, correlations, metadata }) => {
			try {
				const schema = getEventSchemaOrError();
				if ('status' in schema) {
					return jsonContent(schema);
				}
				const binding = bindCorrelations(schema.value, correlations ?? {});
				if ('error' in binding) {
					return jsonContent({ status: 'error', reason: binding.error });
				}

				const metaCol = schema.value.metadata_column;
				const columns: string[] = [schema.value.type_column];
				const placeholders: string[] = ['$1'];
				const values: unknown[] = [event_type];
				let idx = 2;

				for (const key of schema.value.correlation_keys) {
					columns.push(key.column);
					placeholders.push(`$${idx}`);
					values.push(binding.values[key.name] ?? null);
					idx++;
				}
				columns.push(schema.value.timestamp_column);
				placeholders.push('NOW()');
				if (metaCol) {
					columns.push(metaCol);
					placeholders.push(`$${idx}::jsonb`);
					values.push(JSON.stringify(metadata ?? {}));
					idx++;
				}
				const returning = schema.value.id_column
					? `${schema.value.id_column}, ${schema.value.timestamp_column}`
					: schema.value.timestamp_column;

				const sql = `INSERT INTO ${schema.value.table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING ${returning}`;
				const result = await executeQuery(sql, values);
				const row = result.rows[0] as Record<string, unknown>;

				return jsonContent({
					status: 'ok',
					event_type,
					stored: true,
					id: schema.value.id_column ? row[schema.value.id_column] : undefined,
					timestamp: row[schema.value.timestamp_column],
				});
			} catch (err) {
				return jsonContent({ status: 'error', reason: `Failed to ingest event: ${(err as Error).message}` });
			}
		},
	);

	/**
	 * get_case_timeline — Full lifecycle of a booking (process instance).
	 *
	 * Returns all events for a booking_id in chronological order.
	 * Each booking is a process instance for process mining.
	 */
	server.tool(
		'get_case_timeline',
		'Get the full event timeline for a single case (process instance). Case key must match a correlation_keys entry in events.yml.',
		{
			case_key: z.string().describe('Which correlation key identifies the case (e.g. "booking_id" in travel).'),
			case_id: z.union([z.number(), z.string()]).describe('Identifier value for the case.'),
			limit: z.number().int().positive().optional().default(100),
		},
		async ({ case_key, case_id, limit }) => {
			try {
				const schema = getEventSchemaOrError();
				if ('status' in schema) {
					return jsonContent(schema);
				}
				const keyDef = schema.value.correlation_keys.find((k) => k.name === case_key);
				if (!keyDef) {
					return jsonContent({
						status: 'error',
						reason: `Unknown case_key "${case_key}" for this scenario.`,
						available_case_keys: schema.value.correlation_keys.map((k) => k.name),
					});
				}

				const idCol = schema.value.id_column;
				const tsCol = schema.value.timestamp_column;
				const typeCol = schema.value.type_column;
				const metaCol = schema.value.metadata_column;

				const selectCols = [
					idCol ? `${idCol} AS id` : null,
					`${typeCol} AS event_type`,
					`${tsCol} AS ts`,
					...schema.value.correlation_keys.map((k) => k.column),
					metaCol ? `${metaCol} AS metadata` : null,
				]
					.filter(Boolean)
					.join(', ');

				const sql = `SELECT ${selectCols} FROM ${schema.value.table} WHERE ${keyDef.column} = $1 ORDER BY ${tsCol} ASC LIMIT $2`;
				const result = await executeQuery(sql, [case_id, limit]);
				const events = result.rows as Array<Record<string, unknown>>;

				const timeline = events.map((e, i) => {
					const tsNow = e.ts as string;
					const prev = i > 0 ? (events[i - 1].ts as string) : null;
					const durationMinutes = prev
						? Math.round((new Date(tsNow).getTime() - new Date(prev).getTime()) / 60000)
						: null;
					const correlations: Record<string, unknown> = {};
					for (const k of schema.value.correlation_keys) correlations[k.name] = e[k.column];
					return {
						step: i + 1,
						event_type: e.event_type,
						timestamp: tsNow,
						minutes_since_previous: durationMinutes,
						correlations,
						...(metaCol ? { metadata: e.metadata } : {}),
					};
				});

				const totalDuration =
					timeline.length > 1
						? Math.round(
								(new Date(events[events.length - 1].ts as string).getTime() -
									new Date(events[0].ts as string).getTime()) /
									60000,
							)
						: 0;

				return jsonContent({
					status: 'ok',
					case_key,
					case_id,
					total_events: timeline.length,
					timeline,
					total_duration_minutes: totalDuration,
				});
			} catch (err) {
				return jsonContent({ status: 'error', reason: `Failed to get timeline: ${(err as Error).message}` });
			}
		},
	);

	/**
	 * get_process_signals — Operational patterns and bottlenecks.
	 *
	 * Analyzes the event log to produce signals:
	 * - Event type distribution (what happens most)
	 * - Failure rates (payment failures, cancellations)
	 * - Average time between steps (bottleneck detection)
	 * - Delay patterns (by reason, by day, by airport)
	 *
	 * These signals feed decision proposals as evidence.
	 */
	server.tool(
		'get_process_signals',
		'Analyze event log for operational patterns, bottlenecks, and anomalies',
		{
			signal_type: z
				.string()
				.describe('Name of the signal to compute (scenario-defined; see configured_signals in errors).'),
			time_range_days: z.number().optional().describe('Look back N days (if the signal accepts this parameter).'),
		},
		async (args) => {
			try {
				if (!loader) {
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({
									status: 'error',
									reason: 'get_process_signals called before tool initialisation',
								}),
							},
						],
					};
				}

				const signals = loader.signals;
				const requested = args.signal_type;
				const def = signals.find((s) => s.name === requested);

				if (!def) {
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({
									status: 'unsupported',
									signal_type: requested,
									reason: `Signal "${requested}" is not configured for this scenario. Add an entry to <scenario>/semantics/signals.yml.`,
									configured_signals: signals.map((s) => ({
										name: s.name,
										description: s.description,
										params: s.params.map((p) => ({
											name: p.name,
											kind: p.kind,
											required: p.required,
										})),
									})),
								}),
							},
						],
					};
				}

				const bound = bindSignalParams(def, args as Record<string, unknown>);
				if ('error' in bound) {
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({ status: 'error', signal_type: requested, reason: bound.error }),
							},
						],
					};
				}

				const result = await executeQuery(def.sql, bound.values as unknown[]);

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{
									status: 'ok',
									signal_type: def.name,
									description: def.description,
									params: Object.fromEntries(
										def.params.map((p, i) => [
											p.name,
											(args as Record<string, unknown>)[p.name] ?? p.default,
										]),
									),
									data: result.rows,
									row_count: result.rowCount,
								},
								null,
								2,
							),
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								status: 'error',
								reason: `Failed to get signals: ${(err as Error).message}`,
							}),
						},
					],
				};
			}
		},
	);
}

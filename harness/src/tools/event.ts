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
import { ScenarioLoader, type SignalDefinition, type SignalParam } from '../config/index.js';
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
function bindSignalParams(
	def: SignalDefinition,
	args: Record<string, unknown>,
): { values: unknown[] } | { error: string } {
	const values: unknown[] = [];
	for (const p of def.params) {
		const raw = args[p.name];
		const provided = raw !== undefined && raw !== null;
		if (!provided && p.required && p.default === undefined) {
			return { error: `Missing required parameter "${p.name}" for signal "${def.name}"` };
		}
		const val = provided ? raw : p.default;
		const bound = coerceParam(p, val);
		if ('error' in bound) return bound;
		values.push(bound.value);
	}
	return { values };
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
		'Append a new event to the operational event log (append-only, immutable)',
		{
			event_type: z.string().describe('Event type (e.g. FlightDelayed, BookingCreated, RebookingInitiated)'),
			booking_id: z.number().optional().describe('Related booking ID'),
			flight_id: z.number().optional().describe('Related flight ID'),
			customer_id: z.number().optional().describe('Related customer ID'),
			ticket_id: z.number().optional().describe('Related ticket ID'),
			metadata: z.record(z.string(), z.unknown()).optional().describe('Additional event data as JSON'),
		},
		async ({ event_type, booking_id, flight_id, customer_id, ticket_id, metadata }) => {
			try {
				const metaJson = metadata ? JSON.stringify(metadata) : '{}';
				const result = await executeQuery(
					`INSERT INTO events (event_type, booking_id, flight_id, customer_id, ticket_id, timestamp, metadata)
					 VALUES ($1, $2, $3, $4, $5, NOW(), $6::jsonb)
					 RETURNING event_id, timestamp`,
					[
						event_type,
						booking_id ?? null,
						flight_id ?? null,
						customer_id ?? null,
						ticket_id ?? null,
						metaJson,
					],
				);

				const row = result.rows[0] as { event_id: number; timestamp: string };

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								event_id: row.event_id,
								event_type,
								stored: true,
								timestamp: row.timestamp,
							}),
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ error: `Failed to ingest event: ${(err as Error).message}` }),
						},
					],
				};
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
		'Get the full event timeline for a booking (process instance)',
		{
			booking_id: z.number().describe('Booking ID to get timeline for'),
		},
		async ({ booking_id }) => {
			try {
				const result = await executeQuery(
					`SELECT event_id, event_type, timestamp, flight_id, ticket_id, metadata
					 FROM events
					 WHERE booking_id = $1
					 ORDER BY timestamp ASC
					 LIMIT 100`,
					[booking_id],
				);

				// Calculate durations between steps
				const events = result.rows as Array<{
					event_id: number;
					event_type: string;
					timestamp: string;
					flight_id: number | null;
					ticket_id: number | null;
					metadata: Record<string, unknown>;
				}>;

				const timeline = events.map((e, i) => {
					const prev = i > 0 ? events[i - 1] : null;
					const durationMs = prev ? new Date(e.timestamp).getTime() - new Date(prev.timestamp).getTime() : 0;
					const durationMinutes = Math.round(durationMs / 60000);

					return {
						step: i + 1,
						event_type: e.event_type,
						timestamp: e.timestamp,
						minutes_since_previous: i > 0 ? durationMinutes : null,
						flight_id: e.flight_id,
						ticket_id: e.ticket_id,
						metadata: e.metadata,
					};
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{
									booking_id,
									total_events: timeline.length,
									timeline,
									total_duration_minutes:
										timeline.length > 1
											? Math.round(
													(new Date(events[events.length - 1].timestamp).getTime() -
														new Date(events[0].timestamp).getTime()) /
														60000,
												)
											: 0,
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
							text: JSON.stringify({ error: `Failed to get timeline: ${(err as Error).message}` }),
						},
					],
				};
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

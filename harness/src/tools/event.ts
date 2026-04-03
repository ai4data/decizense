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
import { executeQuery } from '../database/index.js';

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
			metadata: z.record(z.unknown()).optional().describe('Additional event data as JSON'),
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
				.enum(['event_distribution', 'failure_rates', 'step_durations', 'delay_patterns'])
				.describe('Type of signal to compute'),
			time_range_days: z.number().optional().default(30).describe('Look back N days'),
		},
		async ({ signal_type, time_range_days }) => {
			try {
				let query: string;
				let description: string;
				const intervalParam = `${time_range_days} days`;

				switch (signal_type) {
					case 'event_distribution':
						description = 'Distribution of event types in the operational log';
						query = `
							SELECT event_type, COUNT(*) as count,
							       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) as percentage
							FROM events
							WHERE timestamp >= NOW() - $1::interval
							GROUP BY event_type
							ORDER BY count DESC
							LIMIT 20`;
						break;

					case 'failure_rates':
						description = 'Payment failure and booking cancellation rates';
						query = `
							SELECT
							  (SELECT COUNT(*) FROM events WHERE event_type = 'PaymentFailed'
							   AND timestamp >= NOW() - $1::interval) as payment_failures,
							  (SELECT COUNT(*) FROM events WHERE event_type = 'PaymentSucceeded'
							   AND timestamp >= NOW() - $1::interval) as payment_successes,
							  (SELECT COUNT(*) FROM events WHERE event_type = 'BookingCancelled'
							   AND timestamp >= NOW() - $1::interval) as cancellations,
							  (SELECT COUNT(*) FROM events WHERE event_type = 'BookingCreated'
							   AND timestamp >= NOW() - $1::interval) as total_bookings`;
						break;

					case 'step_durations':
						description = 'Average time between process steps (bottleneck detection)';
						query = `
							WITH step_pairs AS (
							  SELECT
							    e1.booking_id,
							    e1.event_type as from_step,
							    e2.event_type as to_step,
							    EXTRACT(EPOCH FROM (e2.timestamp - e1.timestamp)) / 60 as minutes
							  FROM events e1
							  JOIN events e2 ON e1.booking_id = e2.booking_id
							    AND e2.timestamp > e1.timestamp
							    AND e2.event_type IN ('PaymentSucceeded', 'TicketIssued', 'CheckInCompleted', 'BoardingStarted')
							    AND e1.event_type IN ('BookingCreated', 'PaymentSucceeded', 'TicketIssued', 'CheckInCompleted')
							  WHERE e1.timestamp >= NOW() - $1::interval
							    AND NOT EXISTS (
							      SELECT 1 FROM events e3
							      WHERE e3.booking_id = e1.booking_id
							        AND e3.timestamp > e1.timestamp
							        AND e3.timestamp < e2.timestamp
							        AND e3.event_type = e2.event_type
							    )
							)
							SELECT from_step, to_step,
							       ROUND(AVG(minutes)::numeric, 1) as avg_minutes,
							       ROUND(MIN(minutes)::numeric, 1) as min_minutes,
							       ROUND(MAX(minutes)::numeric, 1) as max_minutes,
							       COUNT(*) as sample_size
							FROM step_pairs
							WHERE minutes > 0
							GROUP BY from_step, to_step
							ORDER BY avg_minutes DESC
							LIMIT 10`;
						break;

					case 'delay_patterns':
						description = 'Flight delay patterns by reason, day of week, and airport';
						query = `
							SELECT
							  fd.reason,
							  COUNT(*) as delay_count,
							  ROUND(AVG(fd.delay_minutes)::numeric, 1) as avg_minutes,
							  ROUND(MAX(fd.delay_minutes)::numeric, 1) as max_minutes,
							  ROUND(SUM(fd.delay_minutes)::numeric, 0) as total_minutes
							FROM flight_delays fd
							JOIN flights f ON fd.flight_id = f.flight_id
							WHERE fd.reported_at >= NOW() - $1::interval
							GROUP BY fd.reason
							ORDER BY delay_count DESC
							LIMIT 10`;
						break;
				}

				const result = await executeQuery(query, [intervalParam]);

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{
									signal_type,
									description,
									time_range_days,
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
							text: JSON.stringify({ error: `Failed to get signals: ${(err as Error).message}` }),
						},
					],
				};
			}
		},
	);
}

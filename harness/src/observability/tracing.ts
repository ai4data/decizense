/**
 * OpenTelemetry tracing for the dazense harness.
 *
 * Phase 0 — stdio transport. Trace context is propagated from the parent
 * agent process via the TRACEPARENT environment variable (W3C Trace Context
 * format). This module initializes the OTel SDK at harness startup, wires up
 * auto-instrumentation for pg and http, and exposes a tracer for manual
 * span creation in tool handlers.
 *
 * Plan v3 reference: Phase 0 (OpenTelemetry foundation).
 *
 * NOTE: in Phase 1a this evolves — trace context will propagate via W3C
 * traceparent HTTP headers instead of env vars when the harness becomes a
 * long-lived HTTP server. The tracer instance itself does not change.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace, context, propagation, type Tracer } from '@opentelemetry/api';

let sdk: NodeSDK | null = null;
let tracerInstance: Tracer | null = null;
let capturedParentContext: ReturnType<typeof context.active> | null = null;

const SERVICE_NAME = 'dazense-harness';
const SERVICE_VERSION = '0.1.0';

/**
 * Initialize the OTel SDK. Must be called before any other harness setup
 * so auto-instrumentation can patch pg and http modules.
 */
export function initTracing(): void {
	if (sdk) return; // idempotent

	const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
	const enabled = process.env.OTEL_ENABLED !== 'false';

	if (!enabled) {
		console.error('[tracing] OpenTelemetry disabled via OTEL_ENABLED=false');
		return;
	}

	const exporter = new OTLPTraceExporter({
		url: `${otlpEndpoint}/v1/traces`,
	});

	sdk = new NodeSDK({
		resource: resourceFromAttributes({
			[ATTR_SERVICE_NAME]: SERVICE_NAME,
			[ATTR_SERVICE_VERSION]: SERVICE_VERSION,
		}),
		traceExporter: exporter,
		instrumentations: [
			new PgInstrumentation({
				enhancedDatabaseReporting: true,
			}),
			new HttpInstrumentation(),
		],
	});

	sdk.start();
	tracerInstance = trace.getTracer(SERVICE_NAME, SERVICE_VERSION);

	// Capture the parent trace context from env vars so all subsequent spans
	// become children of the agent's root span (Phase 0 — stdio propagation).
	capturedParentContext = extractParentContext();
	const parentInfo = process.env.TRACEPARENT ? ` (parent=${process.env.TRACEPARENT.slice(0, 27)}...)` : '';
	console.error(`[tracing] OpenTelemetry initialized → ${otlpEndpoint}/v1/traces${parentInfo}`);

	process.on('SIGTERM', () => {
		void shutdownTracing();
	});
}

/**
 * Shutdown the tracing SDK, flushing any pending spans.
 */
export async function shutdownTracing(): Promise<void> {
	if (!sdk) return;
	try {
		await sdk.shutdown();
		sdk = null;
		tracerInstance = null;
	} catch (err) {
		console.error('[tracing] Error during shutdown:', err);
	}
}

/**
 * Get the harness tracer. Returns a no-op tracer if OTel is disabled.
 */
export function getTracer(): Tracer {
	if (tracerInstance) return tracerInstance;
	return trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
}

/**
 * Extract trace context from the TRACEPARENT env var (stdio transport).
 * Called once at startup to link the harness process's root span to the
 * parent agent's span when running as a child process.
 *
 * Returns the parent context, or ROOT_CONTEXT if no parent is present.
 */
export function extractParentContext(): ReturnType<typeof propagation.extract> {
	const traceparent = process.env.TRACEPARENT;
	const tracestate = process.env.TRACESTATE;

	if (!traceparent) {
		return context.active();
	}

	return propagation.extract(context.active(), {
		traceparent,
		...(tracestate ? { tracestate } : {}),
	});
}

/**
 * Extract trace context from HTTP-style headers (Phase 1a, HTTP transport).
 * Called per tool invocation with headers from `extra.requestInfo.headers` so
 * every request joins its agent-side root span.
 *
 * Returns the parent context, or undefined if no traceparent header is present.
 */
export function extractParentContextFromHeaders(
	headers: Record<string, string | string[] | undefined> | undefined,
): ReturnType<typeof context.active> | undefined {
	if (!headers) return undefined;

	const carrier: Record<string, string> = {};
	// Header lookup is case-insensitive per HTTP spec; the MCP SDK lower-cases them.
	const tp = headers['traceparent'];
	const ts = headers['tracestate'];
	if (typeof tp === 'string') carrier.traceparent = tp;
	else if (Array.isArray(tp) && tp.length > 0) carrier.traceparent = tp[0];
	if (typeof ts === 'string') carrier.tracestate = ts;
	else if (Array.isArray(ts) && ts.length > 0) carrier.tracestate = ts[0];

	if (!carrier.traceparent) return undefined;
	return propagation.extract(context.active(), carrier);
}

/**
 * Returns the captured parent context (from env at startup — stdio mode only).
 * In HTTP mode, callers should prefer `extractParentContextFromHeaders(extra.requestInfo.headers)`
 * for per-request context. Falls back to the current active context.
 */
export function getParentContext(): ReturnType<typeof context.active> {
	return capturedParentContext ?? context.active();
}

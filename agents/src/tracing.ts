/**
 * Agent-side tracing initialization.
 *
 * Phase 0 — stdio transport. The agent process creates a root span for
 * each question, then propagates trace context to the harness child via
 * the TRACEPARENT env var (W3C Trace Context format). This module boots
 * the OTel SDK and provides helpers for span creation and context export.
 *
 * Phase 1a will replace env-var propagation with W3C HTTP headers.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace, context, propagation, type Tracer } from '@opentelemetry/api';

let sdk: NodeSDK | null = null;
let tracerInstance: Tracer | null = null;

export function initAgentTracing(serviceName: string): void {
	if (sdk) return;

	const enabled = process.env.OTEL_ENABLED !== 'false';
	if (!enabled) return;

	const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

	sdk = new NodeSDK({
		resource: resourceFromAttributes({
			[ATTR_SERVICE_NAME]: serviceName,
			[ATTR_SERVICE_VERSION]: '0.1.0',
		}),
		traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
	});

	sdk.start();
	tracerInstance = trace.getTracer(serviceName, '0.1.0');
}

export function getAgentTracer(serviceName: string): Tracer {
	if (tracerInstance) return tracerInstance;
	return trace.getTracer(serviceName, '0.1.0');
}

/**
 * Inject the current active span's trace context into a plain object,
 * producing the W3C headers `traceparent` (and optionally `tracestate`).
 * Used to pass trace context to the harness child process via env vars.
 */
export function exportTraceContext(): Record<string, string> {
	const carrier: Record<string, string> = {};
	propagation.inject(context.active(), carrier);
	return carrier;
}

export async function shutdownAgentTracing(): Promise<void> {
	if (!sdk) return;
	try {
		await sdk.shutdown();
		sdk = null;
		tracerInstance = null;
	} catch {
		/* ignore */
	}
}

/**
 * Convenience helper: initialize tracing, run fn inside a root span with the
 * given name, attach common attributes, then shutdown. Use this at the top
 * of an agent entrypoint so every sub-call (including harness child spawns)
 * becomes part of one trace.
 *
 * Shutdown ALWAYS runs in finally, even if fn throws, so span data is flushed
 * to the collector before the process exits on an error path.
 */
export async function runWithRootSpan(
	serviceName: string,
	spanName: string,
	attributes: Record<string, string | number | boolean>,
	fn: () => Promise<void>,
): Promise<void> {
	initAgentTracing(serviceName);
	const tracer = getAgentTracer(serviceName);

	try {
		await tracer.startActiveSpan(spanName, async (rootSpan) => {
			try {
				for (const [k, v] of Object.entries(attributes)) {
					rootSpan.setAttribute(k, v);
				}
				await fn();
			} catch (err) {
				rootSpan.recordException(err as Error);
				rootSpan.setStatus({ code: 2, message: (err as Error).message }); // 2 = ERROR
				throw err;
			} finally {
				rootSpan.end();
			}
		});
	} finally {
		await shutdownAgentTracing();
	}
}

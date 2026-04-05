/**
 * Span helpers for tool handlers.
 *
 * Usage:
 *   return withToolSpan('query_data', async (span) => {
 *     span.setAttribute('dazense.sql.hash', sha(sql));
 *     ... handler body ...
 *     return result;
 *   });
 */

import { SpanStatusCode, context, trace, type Span, type SpanOptions } from '@opentelemetry/api';
import { createHash } from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTracer, getParentContext, extractParentContextFromHeaders } from './tracing.js';

/**
 * Wrap an async tool handler in a span. Automatically:
 * - Creates a span named `dazense.tool.<name>`
 * - Records exceptions and sets error status
 * - Ends the span when the handler returns (or throws)
 */
export async function withToolSpan<T>(
	toolName: string,
	fn: (span: Span) => Promise<T>,
	options?: SpanOptions,
	parentCtx?: ReturnType<typeof context.active>,
): Promise<T> {
	const tracer = getTracer();
	// parentCtx (per-request) wins in HTTP mode; falls back to startup-captured
	// env-var context in stdio mode.
	const ctx = parentCtx ?? getParentContext();
	return tracer.startActiveSpan(`dazense.tool.${toolName}`, options ?? {}, ctx, async (span) => {
		try {
			span.setAttribute('dazense.tool.name', toolName);
			const result = await fn(span);
			return result;
		} catch (err) {
			span.recordException(err as Error);
			span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
			throw err;
		} finally {
			span.end();
		}
	});
}

/**
 * Short SHA-256 hash for SQL / inputs (for audit-safe span attributes).
 */
export function shortHash(input: string): string {
	return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Set standard identity attributes on a span from the current AuthContext.
 * Never logs tokens — only the SHA-256 hash and auth method.
 */
export function setAuthAttributes(
	span: Span,
	ctx: {
		agentId: string;
		agentUri: string;
		authMethod: string;
		tokenHash: string | null;
		sessionId: string | null;
	},
): void {
	span.setAttribute('dazense.agent.id', ctx.agentId);
	span.setAttribute('dazense.agent.uri', ctx.agentUri);
	span.setAttribute('dazense.auth.method', ctx.authMethod);
	if (ctx.tokenHash) span.setAttribute('dazense.auth.token_hash', ctx.tokenHash);
	if (ctx.sessionId) span.setAttribute('dazense.session.id', ctx.sessionId);
}

/**
 * Install auto-tracing on every tool registered via `server.tool()`. Call once
 * at startup BEFORE any tool registration. Every handler becomes wrapped in a
 * `dazense.tool.<name>` span automatically; handlers can still add custom
 * attributes via `getActiveSpan()?.setAttribute(...)`.
 */
export function installToolTracing(server: McpServer): void {
	const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
	(server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => {
		// server.tool has many overloads; the handler is always the last argument.
		const handler = args[args.length - 1];
		const toolName = args[0] as string;
		if (typeof handler !== 'function') {
			return originalTool(...args);
		}
		const originalHandler = handler as (...hargs: unknown[]) => Promise<unknown>;
		const wrappedHandler = async (...hargs: unknown[]) => {
			// The MCP SDK passes `extra` as the last argument to every tool handler.
			// Extract the incoming `traceparent` HTTP header (Phase 1a) so this
			// span becomes a child of the agent's root span across the HTTP boundary.
			const extra = hargs[hargs.length - 1] as
				| { requestInfo?: { headers?: Record<string, string | string[] | undefined> } }
				| undefined;
			const headers = extra?.requestInfo?.headers;
			const parentCtx = extractParentContextFromHeaders(headers);
			return withToolSpan(toolName, async () => originalHandler(...hargs), undefined, parentCtx);
		};
		return originalTool(...args.slice(0, -1), wrappedHandler);
	};
}

/**
 * Get the currently active span (inside a tool handler). Returns undefined
 * outside a traced context. Use to add custom attributes without setting up
 * your own span wrapper.
 */
export function getActiveSpan(): Span | undefined {
	return trace.getActiveSpan();
}

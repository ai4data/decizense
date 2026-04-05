/**
 * Harness MCP Client — connects an agent to the dazense harness.
 *
 * Plan v3 Phase 1a: the harness is a long-lived HTTP server. Agents connect
 * over Streamable HTTP (MCP's official HTTP+SSE transport). Identity travels
 * via HTTP headers (X-Agent-Id, Authorization: Bearer) and W3C trace context
 * travels via `traceparent` / `tracestate` headers. The LLM never sees any
 * of these headers — they live on the outbound HTTP request only.
 *
 * Default URL: http://127.0.0.1:9080/mcp (override with HARNESS_HTTP_URL).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { exportTraceContext } from './tracing.js';

export class HarnessClient {
	private client: Client;
	private transport: StreamableHTTPClientTransport | null = null;
	private agentId: string;
	private token: string | undefined;

	constructor(agentId: string, token?: string) {
		this.client = new Client({ name: 'dazense-agent', version: '0.1.0' }, { capabilities: {} });
		this.agentId = agentId;
		this.token = token;
	}

	/**
	 * Connect to the long-lived harness HTTP server.
	 * Identity goes in HTTP headers, never in tool arguments.
	 *
	 * `scenarioPath` is kept for backward-compat with existing callers but is
	 * ignored in HTTP mode — the harness owns scenario selection at its own
	 * startup time.
	 */
	async connect(_scenarioPath?: string): Promise<void> {
		const url = new URL(process.env.HARNESS_HTTP_URL ?? 'http://127.0.0.1:9080/mcp');

		const headers: Record<string, string> = {
			'X-Agent-Id': this.agentId,
		};
		if (this.token) {
			headers['Authorization'] = `Bearer ${this.token}`;
		}

		// W3C trace context propagation — traceparent/tracestate HTTP headers.
		// This replaces the env-var path from Phase 0 (stdio).
		const traceCarrier = exportTraceContext();
		if (traceCarrier.traceparent) headers['traceparent'] = traceCarrier.traceparent;
		if (traceCarrier.tracestate) headers['tracestate'] = traceCarrier.tracestate;

		this.transport = new StreamableHTTPClientTransport(url, {
			requestInit: { headers },
		});

		await this.client.connect(this.transport);
	}

	async listTools() {
		const result = await this.client.listTools();
		return result.tools;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		const result = await this.client.callTool({ name, arguments: args });
		const content = result.content as Array<{ type: string; text: string }>;
		if (content && content[0] && content[0].text) {
			return JSON.parse(content[0].text);
		}
		return result;
	}

	async initializeAgent(sessionId: string, question?: string) {
		return this.callTool('initialize_agent', {
			agent_id: this.agentId,
			session_id: sessionId,
			question,
		});
	}

	async queryData(sql: string, reason?: string) {
		return this.callTool('query_data', { sql, reason });
	}

	async getBusinessRules(tables?: string[], metricRefs?: string[]) {
		return this.callTool('get_business_rules', {
			tables,
			metric_refs: metricRefs,
		});
	}

	async writeFinding(
		sessionId: string,
		finding: string,
		confidence: 'high' | 'medium' | 'low',
		dataSources?: string[],
	) {
		return this.callTool('write_finding', {
			session_id: sessionId,
			finding,
			confidence,
			data_sources: dataSources,
		});
	}

	async close() {
		if (this.transport) {
			await this.transport.close();
		}
	}
}

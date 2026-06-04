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
import { withCorrelation } from './correlation.js';
import { HARNESS_HTTP_URL } from './config.js';

export interface EntityDetailsColumn {
	name: string;
	type: string;
	description?: string;
	pii?: boolean;
}

export interface EntityDetails {
	name: string;
	fqn: string;
	description?: string;
	tier?: string | null;
	owners?: Array<{ name: string; type: string }>;
	tags?: string[];
	pii_columns?: string[];
	columns: EntityDetailsColumn[];
	error?: string;
}

export class HarnessClient {
	private client: Client;
	private transport: StreamableHTTPClientTransport | null = null;
	private agentId: string;
	private token: string | undefined;
	private caseId: string | null = null;

	constructor(agentId: string, token?: string) {
		this.client = new Client({ name: 'dazense-agent', version: '0.1.0' }, { capabilities: {} });
		this.agentId = agentId;
		this.token = token;
	}

	/** Bind the business-case id reused across this client's correlated calls. */
	setCaseId(caseId: string): void {
		this.caseId = caseId;
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
		const url = new URL(HARNESS_HTTP_URL);

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
		const finalArgs = this.caseId ? withCorrelation(name, args, this.caseId) : args;
		const result = await this.client.callTool({ name, arguments: finalArgs });
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

	async getEntityDetails(entityId: string): Promise<EntityDetails> {
		return (await this.callTool('get_entity_details', { entity_id: entityId })) as EntityDetails;
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

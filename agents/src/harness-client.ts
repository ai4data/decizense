/**
 * Harness MCP Client — connects an agent to the dazense harness.
 *
 * Starts the harness MCP server as a child process and provides
 * typed tool wrappers that agents can call.
 *
 * Identity flows via AGENT_TOKEN/AGENT_ID environment variables
 * to the child process — never as tool arguments visible to the model.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { exportTraceContext } from './tracing.js';

export class HarnessClient {
	private client: Client;
	private transport: StdioClientTransport | null = null;
	private agentId: string;
	private token: string | undefined;

	constructor(agentId: string, token?: string) {
		this.client = new Client({ name: 'dazense-agent', version: '0.1.0' }, { capabilities: {} });
		this.agentId = agentId;
		this.token = token;
	}

	/**
	 * Connect to the harness MCP server.
	 * Passes AGENT_TOKEN and AGENT_ID via environment — never as tool args.
	 */
	async connect(scenarioPath: string) {
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			SCENARIO_PATH: scenarioPath,
			AGENT_ID: this.agentId,
		};

		if (this.token) {
			env.AGENT_TOKEN = this.token;
		}

		// Propagate W3C Trace Context to the harness child process via env vars
		// (Phase 0 — stdio transport). Phase 1a will swap to HTTP headers.
		const traceCarrier = exportTraceContext();
		if (traceCarrier.traceparent) {
			env.TRACEPARENT = traceCarrier.traceparent;
		}
		if (traceCarrier.tracestate) {
			env.TRACESTATE = traceCarrier.tracestate;
		}

		this.transport = new StdioClientTransport({
			command: 'npx',
			args: ['tsx', 'src/server.ts'],
			cwd: '../harness',
			env,
		});

		await this.client.connect(this.transport);
	}

	/**
	 * List all available tools from the harness.
	 */
	async listTools() {
		const result = await this.client.listTools();
		return result.tools;
	}

	/**
	 * Call a harness tool and return the parsed result.
	 */
	async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		const result = await this.client.callTool({ name, arguments: args });
		const content = result.content as Array<{ type: string; text: string }>;
		if (content && content[0] && content[0].text) {
			return JSON.parse(content[0].text);
		}
		return result;
	}

	/**
	 * Initialize the agent — get identity, scope, rules, constraints.
	 * agent_id is passed for validation (must match AGENT_ID env).
	 */
	async initializeAgent(sessionId: string, question?: string) {
		return this.callTool('initialize_agent', {
			agent_id: this.agentId,
			session_id: sessionId,
			question,
		});
	}

	/**
	 * Execute a governed SQL query.
	 * agent_id comes from AuthContext (env), not from this call.
	 */
	async queryData(sql: string, reason?: string) {
		return this.callTool('query_data', { sql, reason });
	}

	/**
	 * Get applicable business rules.
	 */
	async getBusinessRules(tables?: string[], metricRefs?: string[]) {
		return this.callTool('get_business_rules', {
			tables,
			metric_refs: metricRefs,
		});
	}

	/**
	 * Write a finding to the shared workspace.
	 * agent_id comes from AuthContext (env), not from this call.
	 */
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

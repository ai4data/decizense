/**
 * Harness MCP Client — connects an agent to the dazense harness.
 *
 * Starts the harness MCP server as a child process and provides
 * typed tool wrappers that agents can call.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export class HarnessClient {
	private client: Client;
	private transport: StdioClientTransport | null = null;

	constructor() {
		this.client = new Client({ name: 'dazense-agent', version: '0.1.0' }, { capabilities: {} });
	}

	/**
	 * Connect to the harness MCP server.
	 * Starts the harness as a child process via stdio transport.
	 */
	async connect(scenarioPath: string) {
		this.transport = new StdioClientTransport({
			command: 'npx',
			args: ['tsx', 'src/server.ts'],
			cwd: '../harness',
			env: {
				...process.env,
				SCENARIO_PATH: scenarioPath,
			},
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
	 * Initialize an agent — get identity, scope, rules, constraints.
	 */
	async initializeAgent(agentId: string, sessionId: string, question?: string) {
		return this.callTool('initialize_agent', {
			agent_id: agentId,
			session_id: sessionId,
			question,
		});
	}

	/**
	 * Execute a governed SQL query.
	 */
	async queryData(agentId: string, sql: string, reason?: string) {
		return this.callTool('query_data', {
			agent_id: agentId,
			sql,
			reason,
		});
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
	 */
	async writeFinding(
		sessionId: string,
		agentId: string,
		finding: string,
		confidence: 'high' | 'medium' | 'low',
		dataSources?: string[],
	) {
		return this.callTool('write_finding', {
			session_id: sessionId,
			agent_id: agentId,
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

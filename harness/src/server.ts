/**
 * dazense Agent Harness — MCP Server
 *
 * This is the entry point. The harness exposes tools organized by the 5 responsibilities:
 *
 *   1. CONTEXT INJECTION — right information at the right time
 *   2. CONTROL           — boundaries on what agents can do
 *   3. ACTION            — governed execution in the real world
 *   4. PERSIST           — durable state across sessions (shared workspace)
 *   5. OBSERVE & VERIFY  — monitor, validate, self-correct
 *
 * Any AI agent (Claude, GPT, LangChain, CrewAI, etc.) connects via MCP
 * and calls these tools. The harness doesn't care which model or framework
 * is calling — it governs all of them equally.
 *
 * Usage:
 *   SCENARIO_PATH=../scenario/travel npx tsx src/server.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ScenarioLoader } from './config/index.js';
import { initCatalog } from './catalog/index.js';
import { initDatabase, closeDatabase } from './database/index.js';
import { initGovernance } from './governance/index.js';
import { registerContextTools } from './tools/context.js';
import { registerControlTools, initControlTools } from './tools/control.js';
import { registerActionTools } from './tools/action.js';
import { registerEventTools } from './tools/event.js';
import { registerPersistTools } from './tools/persist.js';
import { registerVerifyTools } from './tools/verify.js';
import { registerAdminTools } from './tools/admin.js';

const server = new McpServer({
	name: 'dazense-harness',
	version: '0.1.0',
});

// ── Agent-facing tools (agents call these) ──
registerContextTools(server); // Layer 1+2: get_context, get_lineage, search_glossary, etc.
registerControlTools(server); // Layer 2: initialize_agent, get_business_rules
registerEventTools(server); // Layer 3: ingest_event, get_case_timeline, get_process_signals
registerActionTools(server); // Layer 5: query_data, query_metrics, execute_action (governance internal)
registerPersistTools(server); // Layer 4: write_finding, read_findings, log_decision, memory
registerVerifyTools(server); // Verify: verify_result, check_freshness, check_consistency

// ── Admin tools (governance teams, not agents) ──
registerAdminTools(server); // find_governance_gaps, simulate_removal, graph_stats, audit_decisions

// Start the server
async function main() {
	// Load scenario config
	const scenarioPath = process.env.SCENARIO_PATH || '../scenario/travel';
	console.error(`[harness] Loading scenario from: ${scenarioPath}`);

	try {
		const loader = new ScenarioLoader(scenarioPath);
		const scenario = loader.scenario;
		console.error(`[harness] Scenario: ${scenario.display_name} (${scenario.name})`);

		// Initialize database connection
		const db = scenario.database;
		initDatabase({
			host: db.host,
			port: db.port,
			database: db.name,
			user: db.user,
			password: db.password,
		});
		console.error(`[harness] Database: ${db.type}://${db.host}:${db.port}/${db.name}`);

		// Initialize catalog (OMD) connection
		const catalogClient = initCatalog(scenarioPath);
		if (catalogClient) {
			const healthy = await catalogClient.healthCheck();
			console.error(`[harness] Catalog: ${healthy ? 'connected' : 'unreachable'} (${scenario.catalog?.url})`);
		} else {
			console.error('[harness] Catalog: not configured (using YAML only)');
		}

		// Initialize governance and control engines
		initGovernance(scenarioPath);
		initControlTools(scenarioPath);
		const agents = loader.agents;
		const agentNames = Object.keys(agents.agents);
		console.error(`[harness] Agents: ${agentNames.join(', ')}`);

		const policy = loader.policy;
		const piiCount = Object.values(policy.pii.columns).flat().length;
		console.error(`[harness] Policy: ${piiCount} PII columns blocked, max ${policy.defaults.max_rows} rows`);
	} catch (err) {
		console.error(`[harness] Warning: Could not load scenario config: ${(err as Error).message}`);
		console.error(`[harness] Running with scaffold responses only`);
	}

	// Start MCP transport
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error('[harness] dazense Agent Harness MCP server started');

	// Cleanup on exit
	process.on('SIGINT', async () => {
		await closeDatabase();
		process.exit(0);
	});
}

main().catch((err) => {
	console.error('[harness] Fatal error:', err);
	process.exit(1);
});

/**
 * dazense Agent Harness — MCP Server
 *
 * Plan v3 Phase 1a: long-lived HTTP server (default) with stdio as a backward
 * compat mode behind HARNESS_TRANSPORT=stdio. In HTTP mode, each MCP session
 * gets its own transport + McpServer instance; identity is bound per-session
 * in the AuthContext map and never shared across concurrent agents.
 *
 * Usage (HTTP, default):
 *   SCENARIO_PATH=../scenario/travel npx tsx src/server.ts
 *   # listens on http://127.0.0.1:9080/mcp
 *
 * Usage (stdio, legacy):
 *   HARNESS_TRANSPORT=stdio SCENARIO_PATH=../scenario/travel npx tsx src/server.ts
 */

// Tracing MUST be initialized before any other imports that might be auto-instrumented
import { initTracing, shutdownTracing } from './observability/tracing.js';
initTracing();

import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { ScenarioLoader } from './config/index.js';
import { initCatalog } from './catalog/index.js';
import { initDatabase, closeDatabase } from './database/index.js';
import { initGovernance } from './governance/index.js';
import { healthCheck as opaHealthCheck, getBundleRevision as opaBundleRevision } from './governance/opa-client.js';
import {
	AuthError,
	resolveAuthContext,
	verifyAndBuildContext,
	buildConfigOnlyContext,
	setSessionAuthContext,
	deleteSessionAuthContext,
} from './auth/context.js';
import { registerContextTools, initContextTools } from './tools/context.js';
import { registerControlTools, initControlTools } from './tools/control.js';
import { registerActionTools, initActionTools } from './tools/action.js';
import { registerEventTools, initEventTools } from './tools/event.js';
import { registerPersistTools, initPersistTools } from './tools/persist.js';
import { registerVerifyTools, initVerifyTools } from './tools/verify.js';
import { registerAdminTools, initAdminTools } from './tools/admin.js';
import { registerWorkflowTools } from './tools/workflow.js';
import { installToolTracing } from './observability/span.js';
import { initDbos, shutdownDbos } from './workflows/dbos-init.js';

// ─── Shared init ───────────────────────────────────────────────────────────

async function initializeSharedState(): Promise<ScenarioLoader> {
	const scenarioPath = process.env.SCENARIO_PATH || '../scenario/travel';
	console.error(`[harness] Loading scenario from: ${scenarioPath}`);

	const loader = new ScenarioLoader(scenarioPath);
	const scenario = loader.scenario;
	console.error(`[harness] Scenario: ${scenario.display_name} (${scenario.name})`);

	const db = scenario.database;
	initDatabase({
		host: db.host,
		port: db.port,
		database: db.name,
		user: db.user,
		password: db.password,
	});
	console.error(`[harness] Database: ${db.type}://${db.host}:${db.port}/${db.name}`);

	const catalogClient = initCatalog(scenarioPath);
	if (catalogClient) {
		const healthy = await catalogClient.healthCheck();
		console.error(`[harness] Catalog: ${healthy ? 'connected' : 'unreachable'} (${scenario.catalog?.url})`);
	} else {
		console.error('[harness] Catalog: not configured (using YAML only)');
	}

	initGovernance(scenarioPath);

	// Plan v3 Phase 2b: OPA is now authoritative. The sidecar MUST be reachable
	// at startup — fail fast if not. OPA_ENABLED=true is the only supported mode.
	{
		const opaHealth = await opaHealthCheck();
		const revision = opaBundleRevision();
		if (!opaHealth.ok) {
			console.error(`[harness] OPA health check FAILED: ${opaHealth.error}`);
			throw new Error(
				`OPA sidecar is unreachable: ${opaHealth.error}. Start it with: docker compose -f docker/docker-compose.opa.yml up -d`,
			);
		}
		console.error(
			`[harness] OPA: reachable, bundle revision ${revision ? revision.slice(0, 12) : '(missing .manifest)'}`,
		);
	}

	initContextTools(scenarioPath);
	initControlTools(scenarioPath);
	initActionTools(scenarioPath);
	initEventTools(scenarioPath);
	initPersistTools(scenarioPath);
	initVerifyTools(scenarioPath);
	initAdminTools(scenarioPath);

	const agentNames = Object.keys(loader.agents.agents);
	console.error(`[harness] Agents: ${agentNames.join(', ')}`);
	const policy = loader.policy;
	const piiCount = Object.values(policy.pii.columns).flat().length;
	console.error(`[harness] Policy: ${piiCount} PII columns blocked, max ${policy.defaults.max_rows} rows`);

	return loader;
}

/**
 * Create a fresh MCP server with tool tracing and all tool groups registered.
 * Used once for stdio, once per session for HTTP.
 */
function createHarnessMcpServer(): McpServer {
	const server = new McpServer({ name: 'dazense-harness', version: '0.1.0' });
	installToolTracing(server);
	registerContextTools(server);
	registerControlTools(server);
	registerEventTools(server);
	registerActionTools(server);
	registerPersistTools(server);
	registerVerifyTools(server);
	registerAdminTools(server);
	registerWorkflowTools(server); // Plan v3 Phase 1b — DBOS workflow tools
	return server;
}

// ─── Hardening guardrails (Plan v3 R2-2) ──────────────────────────────────

function enforceHardeningGuardrails(loader: ScenarioLoader, transport: 'http' | 'stdio', bind: string): void {
	const scenario = loader.scenario;
	const authMode = scenario.auth?.mode ?? 'config-only';
	const profile = process.env.DAZENSE_PROFILE;

	// Production profile: ANY non-jwt mode is fatal
	if (profile === 'production' && authMode !== 'jwt') {
		throw new AuthError(
			`DAZENSE_PROFILE=production requires AUTH_MODE=jwt (current mode: ${authMode}). No overrides.`,
		);
	}

	// config-only over HTTP: localhost bind + explicit ack flag, never in production
	if (transport === 'http' && authMode === 'config-only') {
		const localhostBinds = new Set(['127.0.0.1', '::1', 'localhost']);
		if (!localhostBinds.has(bind)) {
			throw new AuthError(
				`config-only auth over HTTP requires localhost bind (got "${bind}"). Either bind to 127.0.0.1 or set AUTH_MODE=jwt.`,
			);
		}
		if (process.env.HARNESS_ALLOW_INSECURE_CONFIG_ONLY !== 'true') {
			throw new AuthError(
				'config-only auth over HTTP is insecure (X-Agent-Id header is trivially spoofable). ' +
					'Set HARNESS_ALLOW_INSECURE_CONFIG_ONLY=true to acknowledge, or use AUTH_MODE=jwt.',
			);
		}
		console.error('[harness] WARNING: config-only auth in HTTP mode is insecure — localhost only, dev only.');
	}
}

// ─── HTTP transport mode ──────────────────────────────────────────────────

/**
 * Read a request body into a parsed JSON object. Returns null on empty bodies
 * (GET/DELETE). Rejects on invalid JSON or bodies > 1 MB.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	if (req.method === 'GET' || req.method === 'DELETE') return null;
	const MAX = 1024 * 1024;
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		total += buf.length;
		if (total > MAX) throw new Error('Request body too large');
		chunks.push(buf);
	}
	if (total === 0) return null;
	const body = Buffer.concat(chunks).toString('utf-8');
	return JSON.parse(body);
}

function isInitializeRequest(body: unknown): boolean {
	if (!body || typeof body !== 'object') return false;
	const b = body as { method?: string };
	return b.method === 'initialize';
}

/**
 * Authenticate a new HTTP session from the incoming request headers and
 * build an AuthContext. This runs once per session (at initialize time).
 */
async function authenticateHttpSession(
	loader: ScenarioLoader,
	req: IncomingMessage,
): Promise<ReturnType<typeof buildConfigOnlyContext>> {
	const authConfig = loader.scenario.auth;
	const mode = authConfig?.mode ?? 'config-only';
	const trustDomain = authConfig?.trust_domain ?? 'dazense.local';

	if (mode === 'jwt') {
		const authz = req.headers['authorization'];
		if (typeof authz !== 'string' || !authz.toLowerCase().startsWith('bearer ')) {
			throw new AuthError('AUTH_MODE=jwt requires Authorization: Bearer <token> header');
		}
		const token = authz.slice(7).trim();
		if (!token) throw new AuthError('Empty bearer token');
		return verifyAndBuildContext(loader, authConfig!, trustDomain, token);
	}

	// config-only mode — identity from X-Agent-Id header (only safe on localhost with ack flag,
	// which was already enforced in enforceHardeningGuardrails at startup)
	const agentIdHeader = req.headers['x-agent-id'];
	const agentId = Array.isArray(agentIdHeader) ? agentIdHeader[0] : agentIdHeader;
	if (!agentId) {
		throw new AuthError('config-only mode over HTTP requires X-Agent-Id header');
	}
	return buildConfigOnlyContext(loader, agentId, trustDomain);
}

async function startHttpServer(loader: ScenarioLoader): Promise<void> {
	const port = Number(process.env.HARNESS_HTTP_PORT ?? 9080);
	const bind = process.env.HARNESS_BIND ?? '127.0.0.1';

	enforceHardeningGuardrails(loader, 'http', bind);

	// Plan v3 Phase 1b — DBOS durable workflows. Launched in HTTP mode only
	// because stdio mode's process lifetime is too short for durable execution.
	// Can be disabled via DBOS_DISABLED=true (e.g., for pure MCP regression tests).
	if (process.env.DBOS_DISABLED !== 'true') {
		await initDbos(loader.scenario);
	} else {
		console.error('[dbos] disabled via DBOS_DISABLED=true');
	}

	// Per-session state: one transport + McpServer instance per MCP session
	const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

	const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
		// Only handle /mcp; everything else → 404
		if (!req.url || !req.url.startsWith('/mcp')) {
			res.writeHead(404).end('Not found');
			return;
		}

		let body: unknown = null;
		try {
			body = await readJsonBody(req);
		} catch (err) {
			res.writeHead(400, { 'Content-Type': 'application/json' }).end(
				JSON.stringify({ error: (err as Error).message }),
			);
			return;
		}

		const existingSessionId = req.headers['mcp-session-id'] as string | undefined;

		// Route 1: existing session — reuse its transport
		if (existingSessionId && sessions.has(existingSessionId)) {
			const session = sessions.get(existingSessionId)!;
			await session.transport.handleRequest(req, res, body);
			return;
		}

		// Route 2: new session — must be an initialize request
		if (!existingSessionId && isInitializeRequest(body)) {
			let authCtx;
			try {
				authCtx = await authenticateHttpSession(loader, req);
			} catch (err) {
				const status = err instanceof AuthError ? 401 : 500;
				res.writeHead(status, { 'Content-Type': 'application/json' }).end(
					JSON.stringify({ error: (err as Error).message }),
				);
				return;
			}

			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (sessionId: string) => {
					// Register the session auth context keyed by the MCP session ID.
					// Every subsequent tool call on this session resolves identity from here.
					setSessionAuthContext(sessionId, authCtx);
					sessions.set(sessionId, { transport, server });
					console.error(
						`[harness] session open: ${sessionId.slice(0, 8)}… agent=${authCtx.agentId} method=${authCtx.authMethod}`,
					);
				},
			});

			transport.onclose = () => {
				const sid = transport.sessionId;
				if (sid) {
					deleteSessionAuthContext(sid);
					sessions.delete(sid);
					console.error(`[harness] session close: ${sid.slice(0, 8)}…`);
				}
			};

			const server = createHarnessMcpServer();
			await server.connect(transport);
			await transport.handleRequest(req, res, body);
			return;
		}

		// Route 3: no session ID and not an initialize request — protocol error
		res.writeHead(400, { 'Content-Type': 'application/json' }).end(
			JSON.stringify({
				error: 'Bad Request: missing mcp-session-id header or expected initialize request',
			}),
		);
	});

	await new Promise<void>((resolve) => httpServer.listen(port, bind, resolve));
	console.error(`[harness] HTTP transport listening on http://${bind}:${port}/mcp`);

	const shutdown = async () => {
		console.error('[harness] shutting down HTTP server...');
		httpServer.close();
		for (const { transport } of sessions.values()) {
			try {
				await transport.close();
			} catch {
				/* ignore */
			}
		}
		await shutdownDbos();
		await shutdownTracing();
		await closeDatabase();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

// ─── Stdio transport mode (backward compat) ───────────────────────────────

async function startStdioServer(loader: ScenarioLoader): Promise<void> {
	enforceHardeningGuardrails(loader, 'stdio', '127.0.0.1');

	const authCtx = await resolveAuthContext(loader);
	const authMode = loader.scenario.auth?.mode ?? 'config-only';
	if (authCtx.agentId) {
		console.error(`[harness] Auth: ${authMode} | agent=${authCtx.agentId} | uri=${authCtx.agentUri}`);
	} else {
		console.error(`[harness] Auth: ${authMode} (agent identity will be set by initialize_agent)`);
	}

	const server = createHarnessMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error('[harness] dazense Agent Harness MCP server started (stdio)');

	process.on('SIGINT', async () => {
		await shutdownTracing();
		await closeDatabase();
		process.exit(0);
	});
}

// ─── Entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
	try {
		const loader = await initializeSharedState();
		const transport = (process.env.HARNESS_TRANSPORT ?? 'http').toLowerCase();
		if (transport === 'stdio') {
			await startStdioServer(loader);
		} else if (transport === 'http') {
			await startHttpServer(loader);
		} else {
			throw new Error(`Unknown HARNESS_TRANSPORT: "${transport}" (expected "http" or "stdio")`);
		}
	} catch (err) {
		if (err instanceof AuthError) {
			console.error(`[harness] FATAL: ${err.message}`);
			process.exit(1);
		}
		console.error('[harness] Fatal error:', err);
		process.exit(1);
	}
}

main();

/**
 * AuthContext — identity bound to a connection.
 *
 * Plan v2 (stdio mode): one harness child process per agent; AuthContext is
 * a module-level singleton resolved once from AGENT_TOKEN env var.
 *
 * Plan v3 Phase 1a (HTTP mode): one long-lived harness serves many agents
 * concurrently; AuthContext is stored in a Map keyed by MCP session ID, with
 * TTL and cleanup on disconnect.
 *
 * Both modes coexist during the transition. Tools call `getCurrentAuthContext(extra)`
 * which resolves from `extra.sessionId` in HTTP mode or falls back to the
 * singleton in stdio mode. Tokens are NEVER logged — only the SHA-256 hash.
 */

import type { ScenarioLoader, AuthConfig } from '../config/index.js';
import { createVerifier, tokenHash, type VerifyConfig } from './verify.js';

/**
 * Typed error for authentication failures.
 * Callers (server.ts) use instanceof AuthError to distinguish fatal auth
 * errors from recoverable config errors — no brittle string matching.
 */
export class AuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AuthError';
	}
}

export interface AuthContext {
	// Identity
	agentId: string;
	agentUri: string;

	// Credential metadata
	authMethod: 'jwt' | 'config-only';
	tokenSubject: string | null;
	tokenIssuer: string | null;
	tokenHash: string | null;

	// Session correlation
	sessionId: string | null;
	authenticatedAt: Date;
}

// ─── Singleton path (stdio mode, Plan v2 backward compat) ───

let singletonContext: AuthContext | null = null;

export function getAuthContext(): AuthContext {
	if (!singletonContext) throw new AuthError('AuthContext not initialized — call resolveAuthContext() at startup');
	return singletonContext;
}

export function setSessionId(sessionId: string): void {
	if (!singletonContext) throw new AuthError('AuthContext not initialized');
	singletonContext = { ...singletonContext, sessionId };
}

/**
 * Set the agent_id on a config-only singleton context (called by initialize_agent
 * when no AGENT_ID env var was set — stdio backward compat path only).
 */
export function setAgentIdIfEmpty(agentId: string, trustDomain: string): void {
	if (!singletonContext) throw new AuthError('AuthContext not initialized');
	if (singletonContext.agentId === '') {
		singletonContext = {
			...singletonContext,
			agentId,
			agentUri: `agent://${trustDomain}/${agentId}`,
		};
	}
}

// ─── Session map (HTTP mode, Plan v3 Phase 1a) ───

interface StoredSession {
	context: AuthContext;
	expiresAt: number;
}

const sessionMap = new Map<string, StoredSession>();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
let gcInterval: NodeJS.Timeout | null = null;

/**
 * Register an AuthContext for a new MCP session (HTTP mode).
 * Called by the HTTP transport layer when a session is established.
 */
export function setSessionAuthContext(sessionId: string, ctx: AuthContext): void {
	sessionMap.set(sessionId, {
		context: { ...ctx, sessionId },
		expiresAt: Date.now() + SESSION_TTL_MS,
	});
	startSessionGcIfNeeded();
}

/**
 * Remove a session's AuthContext (on disconnect).
 */
export function deleteSessionAuthContext(sessionId: string): void {
	sessionMap.delete(sessionId);
}

/**
 * Resolve AuthContext for the current tool call.
 *
 * In HTTP mode, pass the `extra` parameter from the MCP tool handler — the
 * session ID comes from `extra.sessionId`. Returns the per-session context.
 *
 * In stdio mode, `extra` may be undefined or lack a sessionId; in that case
 * returns the singleton context for backward compatibility with Plan v2.
 */
export function getCurrentAuthContext(extra?: { sessionId?: string }): AuthContext {
	const sessionId = extra?.sessionId;
	if (sessionId) {
		const stored = sessionMap.get(sessionId);
		if (stored) {
			if (stored.expiresAt > Date.now()) {
				return stored.context;
			}
			// Expired — evict and fall through to error
			sessionMap.delete(sessionId);
			throw new AuthError(`Session ${sessionId} has expired`);
		}
		// HTTP mode but no session registered → fall through to singleton (stdio fallback)
		// or throw if neither exists
	}
	if (singletonContext) return singletonContext;
	throw new AuthError('No AuthContext for this request — neither per-session nor singleton');
}

/**
 * Session count (for tests and health endpoints).
 */
export function sessionAuthContextCount(): number {
	return sessionMap.size;
}

/**
 * Periodic GC for expired sessions.
 */
function startSessionGcIfNeeded(): void {
	if (gcInterval) return;
	gcInterval = setInterval(() => {
		const now = Date.now();
		for (const [id, stored] of sessionMap.entries()) {
			if (stored.expiresAt <= now) sessionMap.delete(id);
		}
		if (sessionMap.size === 0 && gcInterval) {
			clearInterval(gcInterval);
			gcInterval = null;
		}
	}, 60 * 1000);
	// Don't keep the process alive just for GC
	gcInterval.unref?.();
}

// ─── Resolution (token verification + claim mapping) ───

/**
 * Resolve the singleton AuthContext at startup (stdio mode).
 *
 * In jwt mode: reads AGENT_TOKEN from env, verifies it, maps sub → agent_id.
 * In config-only mode: reads AGENT_ID from env (or defaults to empty placeholder).
 */
export async function resolveAuthContext(loader: ScenarioLoader): Promise<AuthContext> {
	const scenario = loader.scenario;
	const authConfig = scenario.auth;
	const mode = authConfig?.mode ?? 'config-only';
	const trustDomain = authConfig?.trust_domain ?? 'dazense.local';

	if (mode === 'jwt') {
		const token = process.env.AGENT_TOKEN;
		if (!token) {
			throw new AuthError('AUTH_MODE=jwt but AGENT_TOKEN environment variable is not set');
		}
		singletonContext = await verifyAndBuildContext(loader, authConfig!, trustDomain, token);
	} else {
		singletonContext = resolveConfigOnlyContext(loader, trustDomain);
	}

	return singletonContext;
}

/**
 * Verify a token + build an AuthContext from it (used by both singleton
 * startup and per-request HTTP authentication).
 */
export async function verifyAndBuildContext(
	loader: ScenarioLoader,
	authConfig: AuthConfig,
	trustDomain: string,
	token: string,
): Promise<AuthContext> {
	const verifyConfig: VerifyConfig = {
		strategy: authConfig.verify_strategy ?? 'shared_secret',
		jwtSecret: authConfig.jwt_secret,
		jwksUri: authConfig.jwks_uri,
		issuer: authConfig.issuer,
		introspectionUrl: authConfig.introspection_url,
	};

	const verifier = createVerifier(verifyConfig);
	const result = await verifier.verify(token, authConfig.audience ?? 'dazense-harness');

	if (!result.valid) {
		throw new AuthError(`Agent token verification failed: ${result.error}`);
	}
	if (!result.sub) {
		throw new AuthError('Agent token missing sub claim — cannot determine agent identity');
	}

	const agentId = resolveAgentIdFromSubject(loader, result.sub);
	if (!agentId) {
		throw new AuthError(`Token sub "${result.sub}" does not match any agent identity.catalog_bot in agents.yml`);
	}

	return {
		agentId,
		agentUri: `agent://${trustDomain}/${agentId}`,
		authMethod: 'jwt',
		tokenSubject: result.sub,
		tokenIssuer: result.iss ?? null,
		tokenHash: tokenHash(token),
		sessionId: null,
		authenticatedAt: new Date(),
	};
}

/**
 * Build a config-only AuthContext for an agent_id that exists in agents.yml
 * (used by HTTP mode when a request carries X-Agent-Id and auth.mode=config-only
 * on localhost with the explicit ack flag).
 */
export function buildConfigOnlyContext(loader: ScenarioLoader, agentId: string, trustDomain: string): AuthContext {
	const agents = loader.agents;
	if (!agents.agents[agentId]) {
		throw new AuthError(`Unknown agent: "${agentId}" not in agents.yml`);
	}
	return {
		agentId,
		agentUri: `agent://${trustDomain}/${agentId}`,
		authMethod: 'config-only',
		tokenSubject: null,
		tokenIssuer: null,
		tokenHash: null,
		sessionId: null,
		authenticatedAt: new Date(),
	};
}

function resolveConfigOnlyContext(loader: ScenarioLoader, trustDomain: string): AuthContext {
	const agentId = process.env.AGENT_ID;
	if (!agentId) {
		// stdio mode placeholder — set later by first initialize_agent call
		return {
			agentId: '',
			agentUri: '',
			authMethod: 'config-only',
			tokenSubject: null,
			tokenIssuer: null,
			tokenHash: null,
			sessionId: null,
			authenticatedAt: new Date(),
		};
	}
	return buildConfigOnlyContext(loader, agentId, trustDomain);
}

/**
 * Map a JWT sub claim to an agent_id by looking up identity.catalog_bot in agents.yml.
 */
function resolveAgentIdFromSubject(loader: ScenarioLoader, subject: string): string | null {
	const agents = loader.agents;
	for (const [agentId, config] of Object.entries(agents.agents)) {
		if (config.identity?.catalog_bot === subject) {
			return agentId;
		}
	}
	return null;
}

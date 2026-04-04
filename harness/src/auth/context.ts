/**
 * AuthContext — immutable identity for the current connection.
 *
 * Resolved once at harness startup from AGENT_TOKEN (env var).
 * Every tool call reads identity from here, never from model input.
 *
 * The token never appears in tool schemas — the model cannot see or leak it.
 */

import { createHash } from 'crypto';
import type { ScenarioLoader } from '../config/index.js';
import { createVerifier, tokenHash, type VerifyConfig } from './verify.js';

export interface AuthContext {
	// Identity
	agentId: string;
	agentUri: string;

	// Credential metadata
	authMethod: 'jwt' | 'config-only';
	tokenSubject: string | null;
	tokenIssuer: string | null;
	tokenHash: string | null;

	// Session (set later by initialize_agent)
	sessionId: string | null;
	authenticatedAt: Date;
}

let context: AuthContext | null = null;

export function getAuthContext(): AuthContext {
	if (!context) throw new Error('AuthContext not initialized — call resolveAuthContext() at startup');
	return context;
}

export function setSessionId(sessionId: string): void {
	if (!context) throw new Error('AuthContext not initialized');
	context = { ...context, sessionId };
}

/**
 * Resolve the AuthContext for this connection.
 *
 * In jwt mode: reads AGENT_TOKEN from env, verifies it, maps sub → agent_id.
 * In config-only mode: reads AGENT_ID from env (or defaults to first agent).
 */
export async function resolveAuthContext(loader: ScenarioLoader): Promise<AuthContext> {
	const scenario = loader.scenario;
	const authConfig = scenario.auth;
	const mode = authConfig?.mode ?? 'config-only';
	const trustDomain = authConfig?.trust_domain ?? 'dazense.local';

	if (mode === 'jwt') {
		context = await resolveJwtContext(loader, authConfig!, trustDomain);
	} else {
		context = resolveConfigOnlyContext(loader, trustDomain);
	}

	return context;
}

async function resolveJwtContext(
	loader: ScenarioLoader,
	authConfig: NonNullable<ReturnType<typeof getAuthConfig>>,
	trustDomain: string,
): Promise<AuthContext> {
	const token = process.env.AGENT_TOKEN;
	if (!token) {
		throw new Error('AUTH_MODE=jwt but AGENT_TOKEN environment variable is not set');
	}

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
		throw new Error(`Agent token verification failed: ${result.error}`);
	}

	if (!result.sub) {
		throw new Error('Agent token missing sub claim — cannot determine agent identity');
	}

	// Map sub claim (catalog_bot name) → agent_id
	const agentId = resolveAgentIdFromSubject(loader, result.sub);
	if (!agentId) {
		throw new Error(`Token sub "${result.sub}" does not match any agent identity.catalog_bot in agents.yml`);
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

function resolveConfigOnlyContext(loader: ScenarioLoader, trustDomain: string): AuthContext {
	const agentId = process.env.AGENT_ID;
	if (!agentId) {
		// No AGENT_ID set — context will be set by first initialize_agent call
		// For backward compat, create a placeholder that gets replaced
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

	// Verify agent exists in config
	const agents = loader.agents;
	if (!agents.agents[agentId]) {
		throw new Error(`AGENT_ID="${agentId}" not found in agents.yml`);
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

/**
 * Set the agent_id on a config-only context (called by initialize_agent
 * when no AGENT_ID env var was set — backward compat path).
 */
export function setAgentIdIfEmpty(agentId: string, trustDomain: string): void {
	if (!context) throw new Error('AuthContext not initialized');
	if (context.agentId === '') {
		context = {
			...context,
			agentId,
			agentUri: `agent://${trustDomain}/${agentId}`,
		};
	}
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

// Helper to extract auth config type
function getAuthConfig() {
	return undefined as
		| {
				mode: string;
				trust_domain?: string;
				verify_strategy?: 'jwks' | 'shared_secret' | 'introspection';
				jwt_secret?: string;
				jwks_uri?: string;
				issuer?: string;
				audience?: string;
				introspection_url?: string;
		  }
		| undefined;
}

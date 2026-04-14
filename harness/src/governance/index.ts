/**
 * INTERNAL GOVERNANCE — Phase 2b: OPA-authoritative.
 *
 * When an agent calls query_data or query_metrics, the harness internally
 * runs these checks before executing. If any check fails, the agent gets
 * a block response — it never knows the internal mechanics.
 *
 * Phase 2b changes:
 *   - The 8 in-code rule checks are DELETED. OPA is now authoritative.
 *   - evaluateGovernance: parseSql → build OpaInput → opaClient.evaluate()
 *     → shape GovernanceResult with the existing checks[] contract.
 *   - AuthContext defense-in-depth stays in TS (pre-OPA).
 *   - parseSql stays in TS (Rego receives the parsed output).
 *   - filterPiiFromResults / filterPiiFromFinding stay in TS
 *     (defense-in-depth on the response, not the gate).
 */

import { ScenarioLoader, type PolicyConfig, type BundleConfig } from '../config/index.js';
import { getCatalogClient, type ICatalogClient } from '../catalog/index.js';
import { getAuthContext, type AuthContext } from '../auth/context.js';
import {
	evaluate as opaEvaluate,
	getBundleRevision,
	updateDecisionLogContract,
	type OpaInput,
	type OpaParsedSql,
} from './opa-client.js';

// ─── Types ───

export interface GovernanceCheck {
	name: string;
	passed: boolean;
	detail?: string;
}

export interface GovernanceResult {
	allowed: boolean;
	reason?: string;
	blocked_columns?: string[];
	all_pii_columns?: string[];
	warnings?: string[];
	applicable_rules?: string[];
	contract_id?: string;
	checks?: GovernanceCheck[];
	/** Bundle revision (sha256) of the OPA policy that evaluated this decision. */
	policy_version?: string | null;
}

export interface AgentIdentity {
	agent_id: string;
	role: 'orchestrator' | 'domain';
	bundle: string | null;
	display_name: string;
	can_query: boolean;
	authenticated: boolean;
}

// ─── SQL Parsing (lightweight, stays in TS) ───

interface ParsedSql {
	tables: string[];
	columns: string[];
	hasLimit: boolean;
	limitValue: number | null;
	isReadOnly: boolean;
	statementCount: number;
	joins: Array<{ leftCol: string; rightCol: string }>;
}

function parseSql(sql: string): ParsedSql {
	const upper = sql.toUpperCase().trim();

	const statements = sql
		.split(';')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	const writeKeywords = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE'];
	const isReadOnly = !writeKeywords.some((kw) => upper.includes(kw));

	const tablePattern = /(?:FROM|JOIN)\s+([a-z_][a-z0-9_.]*)/gi;
	const tables: string[] = [];
	let match;
	while ((match = tablePattern.exec(sql)) !== null) {
		tables.push(match[1].toLowerCase());
	}

	const selectMatch = sql.match(/SELECT\s+([\s\S]*?)(?:\bFROM\b)/i);
	const columns: string[] = [];
	if (selectMatch) {
		const selectClause = selectMatch[1];
		if (selectClause.trim() !== '*') {
			const parts = selectClause.split(',').map((p) => p.trim());
			for (const part of parts) {
				const col = part
					.split(/\s+(?:AS\s+)?/i)
					.pop()
					?.replace(/['"]/g, '');
				if (col) columns.push(col.toLowerCase());
			}
		}
	}

	const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
	const hasLimit = limitMatch !== null;
	const limitValue = limitMatch ? parseInt(limitMatch[1], 10) : null;

	const joinPattern = /JOIN\s+\S+\s+\S*\s*ON\s+(\S+)\s*=\s*(\S+)/gi;
	const joins: Array<{ leftCol: string; rightCol: string }> = [];
	let jMatch: RegExpExecArray | null;
	while ((jMatch = joinPattern.exec(sql)) !== null) {
		const leftCol = jMatch[1].toLowerCase().replace(/\w+\./, '');
		const rightCol = jMatch[2].toLowerCase().replace(/\w+\./, '');
		joins.push({ leftCol, rightCol });
	}

	return {
		tables: [...new Set(tables)],
		columns,
		hasLimit,
		limitValue,
		isReadOnly,
		statementCount: statements.length,
		joins,
	};
}

// ─── Governance pipeline ───

let loader: ScenarioLoader | null = null;

export function initGovernance(scenarioPath: string) {
	loader = new ScenarioLoader(scenarioPath);
}

/**
 * Authenticate an agent and return its identity.
 *
 * Defense in depth: if agentId is provided, verify it matches the connection's
 * AuthContext. This catches any future tool that forgets to resolve identity
 * from AuthContext and instead passes a param through.
 */
export function authenticateAgent(agentId: string): AgentIdentity {
	if (!loader) throw new Error('Governance not initialized');

	try {
		const ctx = getAuthContext();
		if (ctx.agentId && ctx.agentId !== agentId) {
			return {
				agent_id: agentId,
				role: 'domain',
				bundle: null,
				display_name: 'Identity mismatch',
				can_query: false,
				authenticated: false,
			};
		}
	} catch {
		// AuthContext not initialized — allowed only during startup/tests
	}

	const agents = loader.agents;
	const agent = agents.agents[agentId];

	if (!agent) {
		return {
			agent_id: agentId,
			role: 'domain',
			bundle: null,
			display_name: 'Unknown',
			can_query: false,
			authenticated: false,
		};
	}

	return {
		agent_id: agentId,
		role: agent.role,
		bundle: agent.bundle ?? null,
		display_name: agent.display_name,
		can_query: agent.can_query,
		authenticated: true,
	};
}

export interface EvaluateGovernanceParams {
	authContext?: AuthContext;
	agent_id?: string;
	sql?: string;
	tables?: string[];
	columns?: string[];
	metric_refs?: string[];
	/**
	 * Explicit MCP tool name. When omitted, the legacy heuristic is used
	 * (sql present → "query_data", else → "query_metrics"). Callers that
	 * compile SQL but want to be classified as query_metrics (e.g. the
	 * semantic executor) must pass this explicitly.
	 */
	tool_name?: 'query_data' | 'query_metrics';
}

/**
 * Run the full governance pipeline on a query — OPA-authoritative (Phase 2b).
 *
 * 1. Resolve agentId from AuthContext (defense-in-depth, stays in TS)
 * 2. parseSql (stays in TS — Rego receives the parsed output)
 * 3. Build OpaInput and POST to OPA sidecar
 * 4. Map OPA violations to the existing GovernanceCheck[] / GovernanceResult
 *    contract so call-sites (action.ts) are unchanged
 * 5. On allow: collect PII columns for defense-in-depth result filtering
 */
export async function evaluateGovernance(params: EvaluateGovernanceParams): Promise<GovernanceResult> {
	if (!loader) throw new Error('Governance not initialized');

	// ── Resolve agent_id (AuthContext defense-in-depth) ──
	let agentId: string;
	if (params.authContext) {
		agentId = params.authContext.agentId;
		if (params.agent_id && params.agent_id !== agentId) {
			return {
				allowed: false,
				reason: `Identity mismatch: caller passed agent_id="${params.agent_id}" but authContext is "${agentId}"`,
				checks: [{ name: 'authenticate', passed: false, detail: 'identity mismatch' }],
			};
		}
	} else {
		try {
			agentId = getAuthContext().agentId;
			if (params.agent_id && params.agent_id !== agentId) {
				return {
					allowed: false,
					reason: `Identity mismatch: caller passed "${params.agent_id}" but connection is authenticated as "${agentId}"`,
					checks: [{ name: 'authenticate', passed: false, detail: 'identity mismatch' }],
				};
			}
		} catch {
			if (!params.agent_id) {
				return {
					allowed: false,
					reason: 'No authenticated identity available',
					checks: [{ name: 'authenticate', passed: false, detail: 'no AuthContext, no agent_id' }],
				};
			}
			agentId = params.agent_id;
		}
	}

	// ── Parse SQL and build OPA input ──
	const parsed: ParsedSql | null = params.sql ? parseSql(params.sql) : null;

	const opaInput: OpaInput = {
		agent_id: agentId,
		tool_name: params.tool_name ?? (params.sql ? 'query_data' : 'query_metrics'),
		sql: params.sql ?? '',
		metric_refs: params.metric_refs ?? [],
		parsed: parsed
			? {
					tables: parsed.tables,
					columns: parsed.columns,
					has_limit: parsed.hasLimit,
					limit_value: parsed.limitValue,
					is_read_only: parsed.isReadOnly,
					statement_count: parsed.statementCount,
					joins: parsed.joins.map((j) => ({ left_col: j.leftCol, right_col: j.rightCol })),
				}
			: {
					tables: [],
					columns: [],
					has_limit: false,
					limit_value: null,
					is_read_only: true,
					statement_count: 0,
					joins: [],
				},
	};

	// ── Evaluate via OPA (authoritative + Phase 2c decision logging) ──
	const sessionId = params.authContext?.sessionId ?? null;
	const delegatedSubject = params.authContext?.delegatedSubject ?? null;
	const opaResult = await opaEvaluate(opaInput, sessionId ?? undefined, undefined, delegatedSubject);
	const policyVersion = opaResult.bundle_revision;

	// ── Map OPA result to GovernanceResult ──
	if (!opaResult.allow) {
		// OPA returns all violations simultaneously (not early-return). Sort
		// them by the original pipeline's check order so the "reason" text is
		// deterministic and matches the old behavior where the first failing
		// check's message was returned.
		const CHECK_PRIORITY: Record<string, number> = {
			authenticate: 0,
			can_query: 1,
			read_only: 2,
			single_statement: 3,
			bundle_scope: 4,
			join_allowlist: 5,
			execution_permission: 6,
			pii_check: 7,
			limit_check: 8,
			limit_value: 9,
			opa_error: 99,
		};
		const sorted = [...opaResult.violations].sort(
			(a, b) => (CHECK_PRIORITY[a.check] ?? 50) - (CHECK_PRIORITY[b.check] ?? 50),
		);

		const checks: GovernanceCheck[] = sorted.map((v) => ({
			name: v.check,
			passed: false,
			detail: v.detail,
		}));

		// Build a human-readable reason from the highest-priority violation
		const firstViolation = sorted[0];
		const reason = firstViolation?.detail ?? 'Blocked by policy';

		// Extract blocked PII columns if any pii_check violations
		const blockedColumns = opaResult.violations
			.filter((v) => v.check === 'pii_check')
			.map((v) => v.detail.replace('PII column ', '').replace(' is blocked', ''));

		return {
			allowed: false,
			reason,
			blocked_columns: blockedColumns.length > 0 ? blockedColumns : undefined,
			checks,
			policy_version: policyVersion,
		};
	}

	// ── Allowed: build contract + collect PII columns for response filtering ──
	const contractId = `contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	// Back-fill the decision log row with the contract_id (best-effort)
	updateDecisionLogContract(opaResult.opa_decision_id, contractId).catch(() => {});
	const checks: GovernanceCheck[] = [{ name: 'approved', passed: true, detail: `Contract ${contractId}` }];

	// Defense-in-depth: collect all PII columns for result filtering
	// (catalog-live here is fine — this is response filtering, not the gate)
	const allPii = loader.getPiiColumns();
	const catalog = getCatalogClient();
	if (catalog) {
		try {
			const catalogPii = await catalog.getPiiColumns();
			for (const col of catalogPii) allPii.add(col);
		} catch {
			/* catalog unavailable */
		}
	}

	return {
		allowed: true,
		all_pii_columns: [...allPii],
		warnings: [],
		applicable_rules: [],
		contract_id: contractId,
		checks,
		policy_version: policyVersion,
	};
}

/**
 * Filter PII columns from query results (defense in depth).
 */
export function filterPiiFromResults(
	rows: Record<string, unknown>[],
	piiColumnNames: string[],
): Record<string, unknown>[] {
	if (piiColumnNames.length === 0 || rows.length === 0) return rows;

	const blocked = new Set(piiColumnNames.map((c) => c.split('.').pop()!.toLowerCase()));

	return rows.map((row) => {
		const filtered = { ...row };
		for (const key of Object.keys(filtered)) {
			if (blocked.has(key.toLowerCase())) {
				filtered[key] = '[PII BLOCKED]';
			}
		}
		return filtered;
	});
}

/**
 * Filter PII from inter-agent findings.
 */
export function filterPiiFromFinding(finding: string): string {
	if (!loader) return finding;

	const piiColumns = loader.getPiiColumns();
	let filtered = finding;

	for (const piiCol of piiColumns) {
		const colName = piiCol.split('.').pop()!;
		const pattern = new RegExp(`\\b${colName}\\b`, 'gi');
		filtered = filtered.replace(pattern, '[REDACTED]');
	}

	return filtered;
}

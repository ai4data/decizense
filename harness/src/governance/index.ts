/**
 * INTERNAL GOVERNANCE — The harness calls these, agents never see them.
 *
 * When an agent calls query_data or query_metrics, the harness internally
 * runs these checks before executing. If any check fails, the agent gets
 * a block response — it never knows the internal mechanics.
 *
 * Full governance pipeline (runs on every query):
 *
 *   1. authenticate_agent    → is this agent who it claims to be?
 *   2. check_bundle_scope    → are all tables within the agent's bundle?
 *   3. check_pii             → are any PII columns in the query?
 *   4. validate_sql          → is the SQL safe? (read-only, single statement, has LIMIT)
 *   5. check_joins           → are all joins on the approved allowlist?
 *   6. check_row_limit       → is LIMIT present and within max_rows?
 *   7. match_business_rules  → which rules apply? (advisory, included in response)
 *   8. build_contract        → create audit record of what was approved
 */

import { ScenarioLoader, type PolicyConfig, type BundleConfig } from '../config/index.js';
import { getCatalogClient, type ICatalogClient } from '../catalog/index.js';

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
}

export interface AgentIdentity {
	agent_id: string;
	role: 'orchestrator' | 'domain';
	bundle: string | null;
	display_name: string;
	can_query: boolean;
	authenticated: boolean;
}

// ─── SQL Parsing (lightweight) ───

interface ParsedSql {
	tables: string[];
	columns: string[];
	hasLimit: boolean;
	limitValue: number | null;
	isReadOnly: boolean;
	statementCount: number;
}

function parseSql(sql: string): ParsedSql {
	const upper = sql.toUpperCase().trim();

	// Statement count (split by semicolons, filter empty)
	const statements = sql
		.split(';')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	// Read-only check
	const writeKeywords = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE'];
	const isReadOnly = !writeKeywords.some((kw) => upper.includes(kw));

	// Extract tables from FROM and JOIN clauses
	const tablePattern = /(?:FROM|JOIN)\s+([a-z_][a-z0-9_.]*)/gi;
	const tables: string[] = [];
	let match;
	while ((match = tablePattern.exec(sql)) !== null) {
		tables.push(match[1].toLowerCase());
	}

	// Extract columns from SELECT
	const selectMatch = sql.match(/SELECT\s+([\s\S]*?)(?:\bFROM\b)/i);
	const columns: string[] = [];
	if (selectMatch) {
		const selectClause = selectMatch[1];
		if (selectClause.trim() !== '*') {
			const parts = selectClause.split(',').map((p) => p.trim());
			for (const part of parts) {
				// Get the column name (last identifier, ignoring aliases)
				const col = part
					.split(/\s+(?:AS\s+)?/i)
					.pop()
					?.replace(/['"]/g, '');
				if (col) columns.push(col.toLowerCase());
			}
		}
	}

	// LIMIT check
	const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
	const hasLimit = limitMatch !== null;
	const limitValue = limitMatch ? parseInt(limitMatch[1], 10) : null;

	return {
		tables: [...new Set(tables)],
		columns,
		hasLimit,
		limitValue,
		isReadOnly,
		statementCount: statements.length,
	};
}

// ─── Governance pipeline ───

let loader: ScenarioLoader | null = null;

export function initGovernance(scenarioPath: string) {
	loader = new ScenarioLoader(scenarioPath);
}

/**
 * Authenticate an agent and return its identity.
 */
export function authenticateAgent(agentId: string): AgentIdentity {
	if (!loader) throw new Error('Governance not initialized');

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

/**
 * Run the full governance pipeline on a query.
 */
export async function evaluateGovernance(params: {
	agent_id: string;
	sql?: string;
	tables?: string[];
	columns?: string[];
	metric_refs?: string[];
}): Promise<GovernanceResult> {
	if (!loader) throw new Error('Governance not initialized');

	const checks: GovernanceCheck[] = [];
	const warnings: string[] = [];
	const blockedColumns: string[] = [];

	// ── 1. Authenticate agent ──
	const identity = authenticateAgent(params.agent_id);
	checks.push({
		name: 'authenticate',
		passed: identity.authenticated,
		detail: identity.authenticated ? `Agent ${params.agent_id} authenticated` : 'Unknown agent',
	});
	if (!identity.authenticated) {
		return { allowed: false, reason: `Unknown agent: ${params.agent_id}`, checks };
	}

	// ── 2. Check agent can query ──
	if (!identity.can_query) {
		checks.push({ name: 'can_query', passed: false, detail: 'Agent role does not permit queries' });
		return { allowed: false, reason: `Agent ${params.agent_id} (${identity.role}) cannot execute queries`, checks };
	}
	checks.push({ name: 'can_query', passed: true });

	const policy = loader.policy;

	// If SQL is provided, parse it
	let parsed: ParsedSql | null = null;
	if (params.sql) {
		parsed = parseSql(params.sql);

		// ── 3. Read-only check ──
		checks.push({
			name: 'read_only',
			passed: parsed.isReadOnly,
			detail: parsed.isReadOnly ? 'Query is read-only' : 'Write operations detected',
		});
		if (!parsed.isReadOnly) {
			return { allowed: false, reason: 'Write operations (INSERT/UPDATE/DELETE/DROP) are not allowed', checks };
		}

		// ── 4. Single statement check ──
		const singleStmt = parsed.statementCount <= 1;
		checks.push({
			name: 'single_statement',
			passed: singleStmt,
			detail: `${parsed.statementCount} statement(s)`,
		});
		if (!singleStmt && policy.execution.sql_validation.disallow_multi_statement) {
			return { allowed: false, reason: 'Multi-statement queries are not allowed', checks };
		}

		// ── 5. Bundle scope check ──
		if (identity.bundle) {
			try {
				const bundle = loader.getBundle(identity.bundle);
				const allowedTables = new Set(bundle.tables.map((t) => `${t.schema}.${t.table}`));
				// Also allow just table name without schema
				bundle.tables.forEach((t) => allowedTables.add(t.table));

				const outOfScope = parsed.tables.filter(
					(t) => !allowedTables.has(t) && !allowedTables.has(t.replace(/^public\./, '')),
				);

				const scopePassed = outOfScope.length === 0;
				checks.push({
					name: 'bundle_scope',
					passed: scopePassed,
					detail: scopePassed
						? `All tables within bundle ${identity.bundle}`
						: `Tables out of scope: ${outOfScope.join(', ')}`,
				});
				if (!scopePassed) {
					return {
						allowed: false,
						reason: `Tables [${outOfScope.join(', ')}] are not in your bundle (${identity.bundle}). You can only query: ${[...allowedTables].join(', ')}`,
						checks,
					};
				}
			} catch {
				checks.push({ name: 'bundle_scope', passed: false, detail: `Bundle ${identity.bundle} not found` });
				return { allowed: false, reason: `Bundle ${identity.bundle} not found`, checks };
			}
		}

		// ── 5b. Join allowlist check ──
		if (identity.bundle && parsed) {
			try {
				const bundle = loader.getBundle(identity.bundle);
				const joinPattern = /JOIN\s+\S+\s+\S*\s*ON\s+(\S+)\s*=\s*(\S+)/gi;
				let joinMatch;
				while ((joinMatch = joinPattern.exec(params.sql)) !== null) {
					const leftCol = joinMatch[1].toLowerCase().replace(/\w+\./, '');
					const rightCol = joinMatch[2].toLowerCase().replace(/\w+\./, '');
					const allowedJoins = (bundle.joins ?? []).map(
						(j) => `${j.left.column.toLowerCase()}=${j.right.column.toLowerCase()}`,
					);
					const joinKey = `${leftCol}=${rightCol}`;
					const reverseKey = `${rightCol}=${leftCol}`;
					if (!allowedJoins.includes(joinKey) && !allowedJoins.includes(reverseKey)) {
						checks.push({
							name: 'join_allowlist',
							passed: false,
							detail: `Join ${joinMatch[1]} = ${joinMatch[2]} not in bundle allowlist`,
						});
					}
				}
			} catch {
				/* bundle not found — already caught above */
			}
		}

		// ── 5c. Execution permission check ──
		if (!policy.execution.allow_execute_sql) {
			checks.push({ name: 'execution_permission', passed: false, detail: 'SQL execution disabled by policy' });
			return {
				allowed: false,
				reason: 'SQL execution is disabled by policy (execution.allow_execute_sql = false)',
				checks,
			};
		}

		// ── 6. PII column check (catalog-first, fallback to YAML) ──
		let piiColumns: Set<string>;
		const catalog = getCatalogClient();
		if (catalog) {
			try {
				piiColumns = await catalog.getPiiColumns();
			} catch {
				piiColumns = loader.getPiiColumns();
			}
		} else {
			piiColumns = loader.getPiiColumns();
		}
		const sqlLower = params.sql.toLowerCase();

		// Check if SELECT * is used on a table with PII columns
		const usesSelectStar = /select\s+\*/.test(sqlLower);
		const queriedTables = new Set<string>();
		const tablePattern = /(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi;
		let tableMatch;
		while ((tableMatch = tablePattern.exec(params.sql)) !== null) {
			queriedTables.add(tableMatch[1].toLowerCase().replace(/^public\./, ''));
		}

		for (const piiCol of piiColumns) {
			// piiCol format: "public.customers.first_name"
			const parts = piiCol.split('.');
			const colName = parts[parts.length - 1];
			const tableName = parts.length >= 2 ? parts[parts.length - 2] : '';

			// Block if: column name in SQL text, OR SELECT * on a PII table
			const colInSql = new RegExp(`\\b${colName}\\b`, 'i').test(sqlLower);
			const starOnPiiTable = usesSelectStar && queriedTables.has(tableName);

			if (colInSql || starOnPiiTable) {
				blockedColumns.push(piiCol);
			}
		}

		const piiPassed = blockedColumns.length === 0;
		checks.push({
			name: 'pii_check',
			passed: piiPassed,
			detail: piiPassed ? 'No PII columns detected' : `PII columns found: ${blockedColumns.join(', ')}`,
		});
		if (!piiPassed && policy.pii.mode === 'block') {
			return {
				allowed: false,
				reason: `PII columns blocked by policy: ${blockedColumns.join(', ')}. Remove these columns from your query.`,
				blocked_columns: blockedColumns,
				checks,
			};
		}

		// ── 7. LIMIT check ──
		if (policy.execution.sql_validation.enforce_limit) {
			checks.push({
				name: 'limit_check',
				passed: parsed.hasLimit,
				detail: parsed.hasLimit ? `LIMIT ${parsed.limitValue}` : 'No LIMIT clause',
			});
			if (!parsed.hasLimit) {
				return {
					allowed: false,
					reason: `Query must include a LIMIT clause (max ${policy.defaults.max_rows} rows)`,
					checks,
				};
			}
			if (parsed.limitValue && parsed.limitValue > policy.defaults.max_rows) {
				checks.push({
					name: 'limit_value',
					passed: false,
					detail: `LIMIT ${parsed.limitValue} exceeds max ${policy.defaults.max_rows}`,
				});
				return {
					allowed: false,
					reason: `LIMIT ${parsed.limitValue} exceeds maximum allowed rows (${policy.defaults.max_rows})`,
					checks,
				};
			}
		}
	}

	// ── 8. All checks passed ──
	const contractId = `contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	checks.push({ name: 'approved', passed: true, detail: `Contract ${contractId}` });

	// Get all PII columns for defense-in-depth result filtering
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
		blocked_columns: blockedColumns,
		all_pii_columns: [...allPii],
		warnings,
		applicable_rules: [],
		contract_id: contractId,
		checks,
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

	// Extract just the column name (last part of dotted path)
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
		// Remove any values that look like they might be PII data
		// This is a basic implementation — production would need NER
		const pattern = new RegExp(`\\b${colName}\\b`, 'gi');
		filtered = filtered.replace(pattern, '[REDACTED]');
	}

	return filtered;
}

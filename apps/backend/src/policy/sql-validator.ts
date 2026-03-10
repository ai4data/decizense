import type { Contract, PolicyConfig } from '@dazense/shared/tools/build-contract';

/**
 * SQL validation result. Thrown as an error if validation fails.
 */
export class SqlValidationError extends Error {
	constructor(
		message: string,
		public readonly violations: string[],
	) {
		super(message);
		this.name = 'SqlValidationError';
	}
}

interface JoinEdge {
	leftTable: string;
	leftColumn: string;
	rightTable: string;
	rightColumn: string;
}

interface ParsedSqlInfo {
	tables: string[];
	columns: string[];
	hasLimit: boolean;
	limitValue: number | null;
	statementCount: number;
	statementType: string; // e.g. 'select', 'insert', 'drop', 'unknown'
	hasJoin: boolean;
	joinTables: string[];
	joinEdges: JoinEdge[];
}

const BLOCKED_STATEMENT_TYPES = new Set([
	'insert',
	'update',
	'delete',
	'drop',
	'alter',
	'create',
	'truncate',
	'replace',
	'merge',
	'grant',
	'revoke',
]);

/**
 * Parse SQL and extract structural info for validation.
 * Uses node-sql-parser for table extraction (reliable), and regex
 * for columns/LIMIT detection (more robust across SQL dialects).
 *
 * If AST parsing fails entirely, returns a failure marker so the caller
 * can decide whether to block (strict mode) or fall back (legacy mode).
 */
function parseSql(sql: string): ParsedSqlInfo & { parseSucceeded: boolean } {
	const regexInfo = parseSqlRegex(sql);

	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { Parser } = require('node-sql-parser');
		const parser = new Parser();

		const ast = parser.astify(sql, { database: 'PostgreSQL' });
		const statements = Array.isArray(ast) ? ast : [ast];

		const tables = new Set<string>();
		const joinTables = new Set<string>();
		let statementType = 'unknown';

		for (const stmt of statements) {
			// Capture statement type from AST
			if (stmt.type) {
				statementType = String(stmt.type).toLowerCase();
			}
			extractTables(stmt.from, tables);

			// Extract JOIN tables specifically
			if (stmt.from && Array.isArray(stmt.from)) {
				for (const item of stmt.from) {
					if (item?.join) {
						const schema = item.db || item.schema;
						if (item.table) {
							joinTables.add(schema ? `${schema}.${item.table}` : String(item.table));
						}
					}
				}
			}
		}

		return {
			tables: tables.size > 0 ? [...tables] : regexInfo.tables,
			columns: regexInfo.columns,
			hasLimit: regexInfo.hasLimit,
			limitValue: regexInfo.limitValue,
			statementCount: statements.length,
			statementType: statementType || regexInfo.statementType,
			hasJoin: joinTables.size > 0 || regexInfo.hasJoin,
			joinTables: joinTables.size > 0 ? [...joinTables] : regexInfo.joinTables,
			joinEdges: regexInfo.joinEdges,
			parseSucceeded: true,
		};
	} catch {
		return { ...regexInfo, parseSucceeded: false };
	}
}

/**
 * Regex-based SQL parsing. Used as supplement to AST parser for
 * columns/LIMIT and as full fallback in legacy mode.
 */
function parseSqlRegex(sql: string): ParsedSqlInfo {
	// Count statements
	const statementCount = sql.split(';').filter((s) => s.trim().length > 0).length;

	// Detect statement type
	const firstWord = sql.trim().split(/\s+/)[0]?.toLowerCase() ?? 'unknown';
	const statementType = firstWord;

	// Extract table references (FROM and JOIN)
	const tablePattern = /(?:from|join)\s+(?:(\w+)\.)?(\w+)/gi;
	const tables = new Set<string>();
	let match: RegExpExecArray | null;
	while ((match = tablePattern.exec(sql)) !== null) {
		const schema = match[1];
		const table = match[2];
		tables.add(schema ? `${schema}.${table}` : table);
	}

	// Extract JOIN tables specifically
	const joinPattern = /\bjoin\s+(?:(\w+)\.)?(\w+)/gi;
	const joinTables = new Set<string>();
	while ((match = joinPattern.exec(sql)) !== null) {
		const schema = match[1];
		const table = match[2];
		joinTables.add(schema ? `${schema}.${table}` : table);
	}
	const hasJoin = joinTables.size > 0;

	// Build alias map for resolving ON conditions: alias/table name → full qualified name
	const aliasMap: Record<string, string> = {};
	const aliasPatternFull = /(?:from|join)\s+(?:(\w+)\.)?(\w+)(?:\s+(?:as\s+)?(\w+))?/gi;
	let aliasMatch: RegExpExecArray | null;
	while ((aliasMatch = aliasPatternFull.exec(sql)) !== null) {
		const aSchema = aliasMatch[1];
		const aTable = aliasMatch[2];
		const alias = aliasMatch[3];
		const fullName = aSchema ? `${aSchema}.${aTable}` : aTable;
		if (alias) {
			aliasMap[alias.toLowerCase()] = fullName;
		}
		aliasMap[aTable.toLowerCase()] = fullName;
	}

	// Extract JOIN ON condition edges (e.g. ON o.customer_id = c.id)
	const joinEdges: JoinEdge[] = [];
	const onPattern = /\bON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/gi;
	let onMatch: RegExpExecArray | null;
	while ((onMatch = onPattern.exec(sql)) !== null) {
		const leftAlias = onMatch[1].toLowerCase();
		const leftCol = onMatch[2];
		const rightAlias = onMatch[3].toLowerCase();
		const rightCol = onMatch[4];
		joinEdges.push({
			leftTable: aliasMap[leftAlias] || onMatch[1],
			leftColumn: leftCol,
			rightTable: aliasMap[rightAlias] || onMatch[3],
			rightColumn: rightCol,
		});
	}

	// Check for LIMIT and extract value
	const limitMatch = sql.match(/\blimit\s+(\d+)/i);
	const hasLimit = !!limitMatch;
	const limitValue = limitMatch ? parseInt(limitMatch[1], 10) : null;

	// Extract column references from SELECT
	const columns = new Set<string>();
	const selectMatch = sql.match(/select\s+([\s\S]+?)\s+from/i);
	if (selectMatch) {
		const selectClause = selectMatch[1];
		if (selectClause.trim() === '*') {
			columns.add('*');
		} else {
			for (const part of selectClause.split(',')) {
				const trimmed = part.trim();
				const colMatch = trimmed.match(/(?:\w+\.)?(\w+)(?:\s+as\s+\w+)?$/i);
				if (colMatch) {
					columns.add(colMatch[1]);
				}
			}
		}
	}

	return {
		tables: [...tables],
		columns: [...columns],
		hasLimit,
		limitValue,
		statementCount,
		statementType,
		hasJoin,
		joinTables: [...joinTables],
		joinEdges,
	};
}

/**
 * Extract table names from a FROM clause AST node.
 */
function extractTables(from: unknown, tables: Set<string>): void {
	if (!from) {
		return;
	}
	const items = Array.isArray(from) ? from : [from];

	for (const item of items) {
		if (typeof item !== 'object' || item === null) {
			continue;
		}
		const node = item as Record<string, unknown>;

		if (node.table) {
			const schema = node.db || node.schema;
			if (schema) {
				tables.add(`${schema}.${node.table}`);
			} else {
				tables.add(node.table as string);
			}
		}

		if (node.join) {
			extractTables(node.join, tables);
		}
	}
}

/**
 * Validate SQL against a contract and policy.
 * Throws SqlValidationError if violations are found.
 *
 * Fail-closed: if SQL cannot be parsed in strict mode, the query is blocked.
 */
export function validateSqlAgainstContract(sql: string, contract: Contract, policy: PolicyConfig): void {
	const violations: string[] = [];
	const parsed = parseSql(sql);
	const sqlValidation = policy.execution.sql_validation;

	// ── 0. Fail-closed: if parsing failed, block in strict mode ──
	if (!parsed.parseSucceeded) {
		violations.push('SQL could not be parsed. Queries that cannot be validated are blocked in strict mode.');
		throw new SqlValidationError(`SQL validation failed: ${violations.join(' ')}`, violations);
	}

	// ── 1. Read-only enforcement: block non-SELECT statements ──
	if (BLOCKED_STATEMENT_TYPES.has(parsed.statementType)) {
		violations.push(
			`Statement type "${parsed.statementType.toUpperCase()}" is not allowed. Only SELECT queries are permitted.`,
		);
	}

	// ── 2. Multi-statement check ──
	if (sqlValidation.disallow_multi_statement && parsed.statementCount > 1) {
		violations.push('Multi-statement SQL is not allowed by policy.');
	}

	// ── 3. Table scope check ──
	const contractTables = new Set(contract.scope.tables.map((t) => t.toLowerCase()));
	for (const table of parsed.tables) {
		const tableLower = table.toLowerCase();
		if (contractTables.size > 0 && !contractTables.has(tableLower)) {
			violations.push(
				`Table "${table}" is not in the contract scope. Allowed: ${[...contractTables].join(', ')}`,
			);
		}
	}

	// ── 4. JOIN table scope check ──
	// If the SQL contains JOINs, verify all joined tables are in contract scope
	for (const joinTable of parsed.joinTables) {
		const joinTableLower = joinTable.toLowerCase();
		if (contractTables.size > 0 && !contractTables.has(joinTableLower)) {
			violations.push(
				`JOIN table "${joinTable}" is not in the contract scope. Allowed: ${[...contractTables].join(', ')}`,
			);
		}
	}

	// ── 4b. JOIN edge allowlist check ──
	// When a bundle is selected and the policy enforces join allowlists,
	// verify each JOIN ON condition matches an approved edge from the bundle.
	if (
		parsed.hasJoin &&
		policy.joins.enforce_bundle_allowlist &&
		contract.scope.approved_joins &&
		contract.scope.approved_joins.length > 0
	) {
		for (const edge of parsed.joinEdges) {
			const isApproved = contract.scope.approved_joins.some((aj) => {
				const fwd =
					aj.left_table.toLowerCase() === edge.leftTable.toLowerCase() &&
					aj.left_column.toLowerCase() === edge.leftColumn.toLowerCase() &&
					aj.right_table.toLowerCase() === edge.rightTable.toLowerCase() &&
					aj.right_column.toLowerCase() === edge.rightColumn.toLowerCase();
				const rev =
					aj.left_table.toLowerCase() === edge.rightTable.toLowerCase() &&
					aj.left_column.toLowerCase() === edge.rightColumn.toLowerCase() &&
					aj.right_table.toLowerCase() === edge.leftTable.toLowerCase() &&
					aj.right_column.toLowerCase() === edge.leftColumn.toLowerCase();
				return fwd || rev;
			});
			if (!isApproved) {
				violations.push(
					`JOIN edge ${edge.leftTable}.${edge.leftColumn} = ${edge.rightTable}.${edge.rightColumn} is not in the approved join allowlist.`,
				);
			}
		}
	}

	// ── 5. PII column check ──
	if (policy.pii.mode === 'block') {
		const allPiiColumns = new Set<string>();
		for (const [, cols] of Object.entries(policy.pii.columns)) {
			for (const col of cols) {
				allPiiColumns.add(col.toLowerCase());
			}
		}

		for (const col of parsed.columns) {
			if (col === '*') {
				for (const table of contract.scope.tables) {
					const piiCols = policy.pii.columns[table];
					if (piiCols && piiCols.length > 0) {
						violations.push(
							`SELECT * on table "${table}" may expose PII columns: ${piiCols.join(', ')}. Select specific columns instead.`,
						);
					}
				}
			} else if (allPiiColumns.has(col.toLowerCase())) {
				violations.push(`Column "${col}" is tagged as PII and blocked by policy.`);
			}
		}
	}

	// ── 6. LIMIT enforcement (presence + value) ──
	if (sqlValidation.enforce_limit) {
		if (!parsed.hasLimit) {
			violations.push(`SQL must include a LIMIT clause (max ${policy.defaults.max_rows} rows).`);
		} else if (parsed.limitValue !== null && parsed.limitValue > policy.defaults.max_rows) {
			violations.push(`LIMIT ${parsed.limitValue} exceeds policy maximum of ${policy.defaults.max_rows} rows.`);
		}
	}

	// ── 7. Time filter enforcement for fact tables ──
	// When the contract declares a time_window, verify the SQL has a WHERE clause.
	// When time_columns are specified, additionally verify the correct column is referenced.
	if (contract.scope.time_window && policy.defaults.require_time_filter_for_fact_tables) {
		const sqlLower = sql.toLowerCase();
		if (!sqlLower.includes('where')) {
			violations.push('Contract requires a time filter but the SQL has no WHERE clause.');
		} else if (contract.scope.time_columns && Object.keys(contract.scope.time_columns).length > 0) {
			// Extract the WHERE clause text for column checking
			const whereClause =
				sql.match(/\bWHERE\b([\s\S]+?)(?:\bGROUP\b|\bORDER\b|\bLIMIT\b|\bHAVING\b|$)/i)?.[1] ?? '';
			for (const [table, timeCol] of Object.entries(contract.scope.time_columns)) {
				if (parsed.tables.some((t) => t.toLowerCase() === table.toLowerCase())) {
					const timeColRegex = new RegExp(`\\b${timeCol}\\b`, 'i');
					if (!timeColRegex.test(whereClause)) {
						violations.push(
							`Table "${table}" requires time filter on column "${timeCol}" but it is not referenced in the WHERE clause.`,
						);
					}
				}
			}
		}
	}

	if (violations.length > 0) {
		throw new SqlValidationError(`SQL validation failed: ${violations.join(' ')}`, violations);
	}
}

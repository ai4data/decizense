/**
 * Config loader — reads scenario YAML files into typed structures.
 *
 * Resolves environment variables in the format {{ env('VAR_NAME') }}
 * or {{ env('VAR_NAME', 'default') }}.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';

// ─── Types ───

export interface AuthConfig {
	mode: 'jwt' | 'config-only';
	trust_domain?: string;
	verify_strategy?: 'jwks' | 'shared_secret' | 'introspection';
	jwt_secret?: string;
	jwks_uri?: string;
	issuer?: string;
	audience?: string;
	introspection_url?: string;
	/** Phase 3: if true, tokens WITH an act claim are required. Tokens without act are rejected. */
	require_delegation?: boolean;
	/** Phase 3: top-level JWT claim name that identifies the agent (default: "sub").
	 *  Supports top-level keys only (e.g. "azp", "client_id"), not dot-paths. */
	agent_claim?: string;
}

export interface ScenarioConfig {
	name: string;
	display_name: string;
	description: string;
	domain: string;
	database: DatabaseConfig;
	catalog?: CatalogConfig;
	auth?: AuthConfig;
}

export interface DatabaseConfig {
	type: string;
	host: string;
	port: number;
	name: string;
	user: string;
	password: string;
}

export interface CatalogConfig {
	provider: string;
	url: string;
	token?: string;
	service_name?: string;
}

export interface AgentConfig {
	display_name: string;
	description: string;
	role: 'orchestrator' | 'domain';
	bundle?: string;
	can_query: boolean;
	can_delegate_to?: string[];
	identity: { catalog_bot: string; token_env: string };
	system_prompt?: string;
}

export interface AgentPermissions {
	can_propose: string[];
	can_approve: string[];
	can_execute: string[];
}

export interface AgentsConfig {
	agents: Record<string, AgentConfig>;
	permissions?: Record<string, AgentPermissions>;
	inter_agent: {
		data_sharing: string;
		pii_in_findings: string;
		max_agents_per_session: number;
		max_llm_calls_per_agent: number;
		cost_limit_per_decision: number;
	};
}

export interface BundleTable {
	schema: string;
	table: string;
}

export interface BundleJoin {
	left: { schema: string; table: string; column: string };
	right: { schema: string; table: string; column: string };
}

export interface BundleConfig {
	bundle_id: string;
	display_name: string;
	description: string;
	owner: string;
	certification: string;
	tables: BundleTable[];
	joins?: BundleJoin[];
	cross_bundle_joins?: Array<Record<string, unknown>>;
	time_filters?: Array<{ table: string; column: string; required: boolean; max_days: number }>;
}

export interface PolicyConfig {
	version: number;
	defaults: {
		max_rows: number;
		max_preview_rows: number;
		require_limit_for_raw_rows: boolean;
		require_time_filter_for_fact_tables: boolean;
		time_filter_max_days_default: number;
	};
	pii: {
		mode: string;
		tags: string[];
		columns: Record<string, string[]>;
	};
	joins: {
		enforce_bundle_allowlist: boolean;
		allow_cross_bundle: boolean;
	};
	execution: {
		allow_execute_sql: boolean;
		allow_query_metrics: boolean;
		require_contract: boolean;
		require_bundle: boolean;
		sql_validation: {
			mode: string;
			disallow_multi_statement: boolean;
			enforce_limit: boolean;
		};
	};
	agent_limits: {
		max_llm_calls_per_agent: number;
		cost_limit_per_decision_usd: number;
		max_query_execution_time_seconds: number;
	};
	freshness: Record<string, { max_delay_minutes?: number; max_delay_hours?: number; description: string }>;
	actions?: {
		risk_classification: Record<string, string>;
		approval_requirements: Record<string, string>;
		progressive_autonomy?: {
			enabled: boolean;
			low_auto_after_decisions: number;
			medium_auto_after_decisions: number;
			high_auto_after_decisions: number;
			critical_auto_after_decisions: number;
			max_error_rate_for_promotion: number;
		};
	};
}

export interface BusinessRule {
	name: string;
	category: string;
	severity: 'error' | 'warning';
	description: string;
	applies_to: string[];
	guidance: string;
	rationale?: {
		source: string;
		reference: string;
		description: string;
		author?: string;
		date?: string;
	};
	/**
	 * Optional machine-checkable definition. If absent, verify_result /
	 * check_consistency will report `manual-verification-needed` rather
	 * than hardcoding travel-specific rule-name string matches.
	 */
	check?: RuleCheck;
}

/**
 * A RuleCheck tells the verify tools how to detect compliance or
 * violation of this rule mechanically. Several kinds are supported so
 * scenario authors can express rules in whichever shape fits best.
 */
export type RuleCheck =
	| {
			kind: 'sql_pattern';
			/** Require the candidate SQL (lowercased) to contain all tokens. */
			require_all?: string[];
			/** Require the candidate SQL to contain at least one token. */
			require_any?: string[];
			/** Reject the candidate SQL if it contains any of these tokens. */
			forbid_any?: string[];
			/** Human explanation if the check fails. */
			message?: string;
	  }
	| {
			kind: 'pii_columns';
			/** Rejects if the SQL references any column listed in scope.blocked_columns. */
			message?: string;
	  }
	| {
			kind: 'query_result';
			/** Harness-executed query; result must satisfy `expect` to pass. */
			sql: string;
			/** E.g. { column: "count", op: "<=", value: 0 }. */
			expect: { column: string; op: '==' | '!=' | '<' | '<=' | '>' | '>='; value: number | string };
			message?: string;
	  }
	| {
			kind: 'manual';
			/** Rule is enforced out-of-band (human review). */
			message?: string;
	  };

/**
 * Process-signal definition — scenario-provided SQL template that the
 * harness dispatches on via tools/event.ts. Keeps the harness free of
 * travel-specific event names and table references.
 */
export interface SignalDefinition {
	name: string;
	description: string;
	/**
	 * SQL template. Uses pg parameter placeholders ($1, $2, ...) bound
	 * in the order of `params`. No string substitution of runtime values
	 * into the SQL text is permitted — prevents injection.
	 */
	sql: string;
	/**
	 * Ordered list of parameters the caller may supply. Each entry maps
	 * to a pg placeholder ($1 for params[0], $2 for params[1], ...).
	 */
	params: SignalParam[];
	/** Informational only — tables the template reads. */
	required_tables?: string[];
}

export interface SignalParam {
	name: string;
	kind: 'int' | 'string';
	required: boolean;
	default?: number | string;
	/** For int params, an optional max to bound the scan. */
	max?: number;
	/** If present and the caller passes `time_range_days`, format as pg interval. */
	as_interval_days?: boolean;
}

export interface SignalsConfig {
	signals: SignalDefinition[];
}

export interface SemanticMeasure {
	name: string;
	column: string;
	aggregation: string;
	description: string;
	filters?: Array<{ column: string; operator: string; value: string }>;
}

export interface SemanticDimension {
	name: string;
	column: string;
	description: string;
	type?: string;
}

export interface SemanticModelEntry {
	name: string;
	table: { schema: string; table: string };
	description: string;
	time_dimension?: string;
	dimensions: SemanticDimension[];
	measures: SemanticMeasure[];
}

export interface SemanticModel {
	models: SemanticModelEntry[];
}

// ─── Env var resolution ───

function resolveEnvVars(text: string): string {
	return text.replace(/\{\{\s*env\(['"](\w+)['"](?:,\s*['"]([^'"]*)['"'])?\)\s*\}\}/g, (_match, name, defaultVal) => {
		return process.env[name] ?? defaultVal ?? '';
	});
}

function resolveEnvInObject(obj: unknown): unknown {
	if (typeof obj === 'string') return resolveEnvVars(obj);
	if (Array.isArray(obj)) return obj.map(resolveEnvInObject);
	if (obj && typeof obj === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = resolveEnvInObject(value);
		}
		return result;
	}
	return obj;
}

// ─── Loader ───

function loadYaml<T>(filePath: string): T {
	if (!existsSync(filePath)) {
		throw new Error(`Config file not found: ${filePath}`);
	}
	const raw = readFileSync(filePath, 'utf-8');
	const parsed = parseYaml(raw);
	return resolveEnvInObject(parsed) as T;
}

export class ScenarioLoader {
	private scenarioPath: string;

	constructor(scenarioPath: string) {
		this.scenarioPath = resolve(scenarioPath);
	}

	get scenario(): ScenarioConfig {
		return loadYaml<ScenarioConfig>(join(this.scenarioPath, 'scenario.yml'));
	}

	get agents(): AgentsConfig {
		return loadYaml<AgentsConfig>(join(this.scenarioPath, 'agents.yml'));
	}

	get policy(): PolicyConfig {
		return loadYaml<PolicyConfig>(join(this.scenarioPath, 'policies', 'policy.yml'));
	}

	getBundle(bundleId: string): BundleConfig {
		// Search all dataset directories for matching bundle_id
		const datasetsPath = join(this.scenarioPath, 'datasets');
		const dirs = readdirSync(datasetsPath) as string[];
		for (const dir of dirs) {
			const datasetPath = join(datasetsPath, dir, 'dataset.yaml');
			if (existsSync(datasetPath)) {
				const bundle = loadYaml<BundleConfig>(datasetPath);
				if (bundle.bundle_id === bundleId) {
					return bundle;
				}
			}
		}
		throw new Error(`Bundle not found: ${bundleId}`);
	}

	getAllBundles(): BundleConfig[] {
		const datasetsPath = join(this.scenarioPath, 'datasets');
		const dirs = readdirSync(datasetsPath) as string[];
		const bundles: BundleConfig[] = [];
		for (const dir of dirs) {
			const datasetPath = join(datasetsPath, dir, 'dataset.yaml');
			if (existsSync(datasetPath)) {
				bundles.push(loadYaml<BundleConfig>(datasetPath));
			}
		}
		return bundles;
	}

	get businessRules(): BusinessRule[] {
		const data = loadYaml<{ rules: BusinessRule[] }>(join(this.scenarioPath, 'semantics', 'business_rules.yml'));
		return data.rules;
	}

	get semanticModel(): SemanticModel {
		return loadYaml<SemanticModel>(join(this.scenarioPath, 'semantics', 'semantic_model.yml'));
	}

	/**
	 * Scenario-supplied process-signal definitions. Returns an empty
	 * array (not throw) when the scenario has no signals.yml — the
	 * harness must degrade to `unsupported` rather than crash.
	 */
	get signals(): SignalDefinition[] {
		const path = join(this.scenarioPath, 'semantics', 'signals.yml');
		if (!existsSync(path)) return [];
		const data = loadYaml<SignalsConfig>(path);
		return data.signals ?? [];
	}

	/**
	 * Get the PII columns as a flat set: "schema.table.column"
	 */
	getPiiColumns(): Set<string> {
		const policy = this.policy;
		const piiSet = new Set<string>();
		for (const [tableKey, columns] of Object.entries(policy.pii.columns)) {
			for (const col of columns) {
				piiSet.add(`${tableKey}.${col}`);
			}
		}
		return piiSet;
	}

	/**
	 * Get tables allowed for a specific agent (by bundle).
	 */
	getAgentTables(agentId: string): string[] {
		const agents = this.agents;
		const agent = agents.agents[agentId];
		if (!agent || !agent.bundle) return [];
		const bundle = this.getBundle(agent.bundle);
		return bundle.tables.map((t) => `${t.schema}.${t.table}`);
	}
}

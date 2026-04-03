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

export interface ScenarioConfig {
	name: string;
	display_name: string;
	description: string;
	domain: string;
	database: DatabaseConfig;
	catalog?: CatalogConfig;
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

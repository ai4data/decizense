import {
	type DatasetBundle,
	DatasetBundleSchema,
	type PolicyConfig,
	PolicySchema,
} from '@dazense/shared/tools/build-contract';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import YAML from 'yaml';

import { env } from '../env';

/**
 * Reads user-defined rules from RULES.md in the project folder if it exists
 */
export function getUserRules(): string | null {
	const projectFolder = env.DAZENSE_DEFAULT_PROJECT_PATH;

	if (!projectFolder) {
		return null;
	}

	const rulesPath = join(projectFolder, 'RULES.md');

	if (!existsSync(rulesPath)) {
		return null;
	}

	try {
		const rulesContent = readFileSync(rulesPath, 'utf-8');
		return rulesContent;
	} catch (error) {
		console.error('Error reading RULES.md:', error);
		return null;
	}
}

type Connection = {
	type: string;
	database: string;
};

export function getConnections(): Connection[] | null {
	const projectFolder = env.DAZENSE_DEFAULT_PROJECT_PATH;

	if (!projectFolder) {
		return null;
	}

	const databasesPath = join(projectFolder, 'databases');

	if (!existsSync(databasesPath)) {
		return null;
	}

	try {
		const entries = readdirSync(databasesPath, { withFileTypes: true });
		const connections: Connection[] = [];

		for (const entry of entries) {
			if (entry.isDirectory() && entry.name.startsWith('type=')) {
				const type = entry.name.slice('type='.length);
				if (type) {
					const typePath = join(databasesPath, entry.name);
					const dbEntries = readdirSync(typePath, { withFileTypes: true });

					for (const dbEntry of dbEntries) {
						if (dbEntry.isDirectory() && dbEntry.name.startsWith('database=')) {
							const database = dbEntry.name.slice('database='.length);
							if (database) {
								connections.push({ type, database });
							}
						}
					}
				}
			}
		}

		return connections.length > 0 ? connections : null;
	} catch (error) {
		console.error('Error reading databases folder:', error);
		return null;
	}
}

export type SemanticModelInfo = {
	name: string;
	table: string;
	description?: string;
	dimensions: string[];
	measures: Record<string, string>;
	joins: string[];
};

export function getSemanticModels(): SemanticModelInfo[] | null {
	const projectFolder = env.DAZENSE_DEFAULT_PROJECT_PATH;
	if (!projectFolder) {
		return null;
	}

	const yamlPath = join(projectFolder, 'semantics', 'semantic_model.yml');
	if (!existsSync(yamlPath)) {
		return null;
	}

	try {
		const content = readFileSync(yamlPath, 'utf-8');
		const parsed = YAML.parse(content) as Record<string, Record<string, Record<string, unknown>>> | null;
		if (!parsed?.models) {
			return null;
		}

		return Object.entries(parsed.models).map(([name, model]) => ({
			name,
			table: model.table as string,
			description: model.description as string | undefined,
			dimensions: Object.keys((model.dimensions as Record<string, unknown>) || {}),
			measures: Object.fromEntries(
				Object.entries((model.measures as Record<string, Record<string, string>>) || {}).map(([k, v]) => [
					k,
					v.type,
				]),
			),
			joins: Object.keys((model.joins as Record<string, unknown>) || {}),
		}));
	} catch (error) {
		console.error('Error reading semantic_model.yml:', error);
		return null;
	}
}

export type BusinessRuleInfo = {
	name: string;
	category: string;
	severity: string;
	applies_to: string[];
	description: string;
	guidance: string;
};

export function getBusinessRules(): BusinessRuleInfo[] | null {
	const projectFolder = env.DAZENSE_DEFAULT_PROJECT_PATH;
	if (!projectFolder) {
		return null;
	}

	const yamlPath = join(projectFolder, 'semantics', 'business_rules.yml');
	if (!existsSync(yamlPath)) {
		return null;
	}

	try {
		const content = readFileSync(yamlPath, 'utf-8');
		const parsed = YAML.parse(content) as { rules?: BusinessRuleInfo[] } | null;
		if (!parsed?.rules) {
			return null;
		}

		return parsed.rules.map((rule) => ({
			name: rule.name,
			category: rule.category,
			severity: rule.severity || 'info',
			applies_to: ((rule as Record<string, unknown>).applies_to as string[]) ?? [],
			description: rule.description,
			guidance: rule.guidance,
		}));
	} catch (error) {
		console.error('Error reading business_rules.yml:', error);
		return null;
	}
}

export type ClassificationInfo = {
	name: string;
	description: string;
	tags: string[];
};

export function getClassifications(): ClassificationInfo[] | null {
	const projectFolder = env.DAZENSE_DEFAULT_PROJECT_PATH;
	if (!projectFolder) {
		return null;
	}

	const yamlPath = join(projectFolder, 'semantics', 'business_rules.yml');
	if (!existsSync(yamlPath)) {
		return null;
	}

	try {
		const content = readFileSync(yamlPath, 'utf-8');
		const parsed = YAML.parse(content) as { classifications?: Record<string, ClassificationInfo> } | null;
		if (!parsed?.classifications) {
			return null;
		}

		return Object.entries(parsed.classifications).map(([name, classification]) => ({
			name,
			description: classification.description,
			tags: classification.tags || [],
		}));
	} catch (error) {
		console.error('Error reading classifications from business_rules.yml:', error);
		return null;
	}
}

// ── Trusted Analytics Copilot loaders ──

export { type DatasetBundle, type PolicyConfig };

/**
 * Loads and validates all dataset bundles from datasets/<bundle_id>/dataset.yaml
 */
export function getDatasetBundles(projectFolder?: string): DatasetBundle[] | null {
	const folder = projectFolder ?? env.DAZENSE_DEFAULT_PROJECT_PATH;
	if (!folder) {
		return null;
	}

	const datasetsPath = join(folder, 'datasets');
	if (!existsSync(datasetsPath)) {
		return null;
	}

	try {
		const entries = readdirSync(datasetsPath, { withFileTypes: true });
		const bundles: DatasetBundle[] = [];

		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}

			const yamlPath = join(datasetsPath, entry.name, 'dataset.yaml');
			if (!existsSync(yamlPath)) {
				continue;
			}

			const content = readFileSync(yamlPath, 'utf-8');
			const raw = YAML.parse(content);
			const parsed = DatasetBundleSchema.safeParse(raw);

			if (parsed.success) {
				bundles.push(parsed.data);
			} else {
				console.error(`Invalid dataset bundle ${entry.name}/dataset.yaml:`, parsed.error.issues);
			}
		}

		return bundles.length > 0 ? bundles : null;
	} catch (error) {
		console.error('Error reading dataset bundles:', error);
		return null;
	}
}

/**
 * Loads and validates the policy file from policies/policy.yml
 */
export function getPolicies(projectFolder?: string): PolicyConfig | null {
	const folder = projectFolder ?? env.DAZENSE_DEFAULT_PROJECT_PATH;
	if (!folder) {
		return null;
	}

	const policyPath = join(folder, 'policies', 'policy.yml');
	if (!existsSync(policyPath)) {
		return null;
	}

	try {
		const content = readFileSync(policyPath, 'utf-8');
		const raw = YAML.parse(content);
		const parsed = PolicySchema.safeParse(raw);

		if (parsed.success) {
			return parsed.data;
		}

		console.error('Invalid policies/policy.yml:', parsed.error.issues);
		return null;
	} catch (error) {
		console.error('Error reading policies/policy.yml:', error);
		return null;
	}
}

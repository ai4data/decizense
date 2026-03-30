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

export type MeasureFilter = {
	column: string;
	operator: string;
	value: unknown;
};

export type MeasureInfo = {
	type: string;
	column?: string;
	filters?: MeasureFilter[];
};

export type DimensionInfo = {
	column: string;
	description?: string;
};

export type JoinInfo = {
	to_model: string;
	foreign_key: string;
	related_key: string;
	type?: string;
};

export type SemanticModelInfo = {
	name: string;
	table: string;
	schema?: string;
	description?: string;
	primary_key?: string;
	time_dimension?: string;
	dimensions: Record<string, DimensionInfo>;
	measures: Record<string, MeasureInfo>;
	joins: Record<string, JoinInfo>;
};

export function getSemanticModels(projectFolder?: string): SemanticModelInfo[] | null {
	const folder = projectFolder ?? env.DAZENSE_DEFAULT_PROJECT_PATH;
	if (!folder) {
		return null;
	}

	const yamlPath = join(folder, 'semantics', 'semantic_model.yml');
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
			schema: model.schema as string | undefined,
			description: model.description as string | undefined,
			primary_key: model.primary_key as string | undefined,
			time_dimension: model.time_dimension as string | undefined,
			dimensions: Object.fromEntries(
				Object.entries((model.dimensions as Record<string, Record<string, string>>) || {}).map(([k, v]) => [
					k,
					{ column: v.column ?? k, description: v.description },
				]),
			),
			measures: Object.fromEntries(
				Object.entries((model.measures as Record<string, Record<string, unknown>>) || {}).map(([k, v]) => [
					k,
					{
						type: v.type as string,
						column: v.column as string | undefined,
						filters: (v.filters as MeasureFilter[] | undefined) ?? [],
					},
				]),
			),
			joins: Object.fromEntries(
				Object.entries((model.joins as Record<string, Record<string, string>>) || {}).map(([k, v]) => [
					k,
					{
						to_model: v.to_model,
						foreign_key: v.foreign_key,
						related_key: v.related_key,
						type: v.type,
					},
				]),
			),
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

export function getBusinessRules(projectFolder?: string): BusinessRuleInfo[] | null {
	const folder = projectFolder ?? env.DAZENSE_DEFAULT_PROJECT_PATH;
	if (!folder) {
		return null;
	}

	const yamlPath = join(folder, 'semantics', 'business_rules.yml');
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

export function getClassifications(projectFolder?: string): ClassificationInfo[] | null {
	const folder = projectFolder ?? env.DAZENSE_DEFAULT_PROJECT_PATH;
	if (!folder) {
		return null;
	}

	const yamlPath = join(folder, 'semantics', 'business_rules.yml');
	if (!existsSync(yamlPath)) {
		return null;
	}

	try {
		const content = readFileSync(yamlPath, 'utf-8');
		const parsed = YAML.parse(content) as {
			classifications?: ClassificationInfo[] | Record<string, ClassificationInfo>;
		} | null;
		if (!parsed?.classifications) {
			return null;
		}

		// classifications can be an array [{name, ...}] or an object {name: {...}}
		if (Array.isArray(parsed.classifications)) {
			return parsed.classifications.map((cls) => ({
				name: cls.name,
				description: cls.description,
				tags: cls.tags || [],
			}));
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

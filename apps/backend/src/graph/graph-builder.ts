import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import {
	getBusinessRules,
	getClassifications,
	getDatasetBundles,
	getPolicies,
	getSemanticModels,
} from '../agents/user-rules';
import { GovernanceGraph } from './governance-graph';
import { EdgeType, NodeType } from './types';

/**
 * Compile a GovernanceGraph from a project folder.
 * Reads YAML via existing loaders, emits typed nodes + edges.
 */
export function buildFromProject(projectFolder: string): GovernanceGraph {
	const graph = new GovernanceGraph();
	const warnings: string[] = [];

	// Track file hashes for incremental compile detection
	hashFile(graph, join(projectFolder, 'semantics', 'semantic_model.yml'));
	hashFile(graph, join(projectFolder, 'semantics', 'business_rules.yml'));
	hashFile(graph, join(projectFolder, 'policies', 'policy.yml'));
	// Dataset bundles are directories — hash each dataset.yaml
	const bundles = getDatasetBundles(projectFolder);
	if (bundles) {
		for (const bundle of bundles) {
			hashFile(graph, join(projectFolder, 'datasets', bundle.bundle_id, 'dataset.yaml'));
		}
	}

	// ── 1. Dataset bundles → Bundle, Table, JoinEdge nodes ──
	if (bundles) {
		for (const bundle of bundles) {
			const bundleId = `bundle:${bundle.bundle_id}`;
			graph.addNode({
				id: bundleId,
				type: NodeType.Bundle,
				properties: {
					display_name: bundle.display_name ?? bundle.bundle_id,
					certification: bundle.certification?.level ?? 'experimental',
					owners: bundle.owners ?? [],
				},
			});

			const dbId = bundle.warehouse.database_id;

			for (const t of bundle.tables) {
				const tableId = `table:${dbId}/${t.schema}.${t.table}`;
				graph.addNode({
					id: tableId,
					type: NodeType.Table,
					properties: {
						schema: t.schema,
						table: t.table,
						database_type: bundle.warehouse.type,
						database_id: dbId,
					},
				});
				graph.addEdge({ from: bundleId, to: tableId, type: EdgeType.CONTAINS });
			}

			// Time filter tables
			if (bundle.defaults?.require_time_filter_for_tables) {
				for (const tableName of bundle.defaults.require_time_filter_for_tables) {
					// Resolve table name to canonical ID
					const tableId = resolveTableId(tableName, dbId, bundle.tables);
					if (tableId) {
						graph.addEdge({ from: bundleId, to: tableId, type: EdgeType.REQUIRES_TIME_FILTER });
					}
				}
			}

			// Joins → JoinEdge intermediary nodes
			for (const joinSpec of bundle.joins) {
				const leftTableId = `table:${dbId}/${joinSpec.left.schema}.${joinSpec.left.table}`;
				const rightTableId = `table:${dbId}/${joinSpec.right.schema}.${joinSpec.right.table}`;
				const joinNodeId = `join:${bundle.bundle_id}/${joinSpec.left.schema}.${joinSpec.left.table}:${joinSpec.right.schema}.${joinSpec.right.table}`;

				graph.addNode({
					id: joinNodeId,
					type: NodeType.JoinEdge,
					properties: {
						join_type: joinSpec.type ?? 'many_to_one',
						description: joinSpec.description ?? '',
						left_column: joinSpec.left.column,
						right_column: joinSpec.right.column,
					},
				});

				graph.addEdge({ from: bundleId, to: joinNodeId, type: EdgeType.ALLOWS_JOIN });
				graph.addEdge({ from: joinNodeId, to: leftTableId, type: EdgeType.JOIN_LEFT });
				graph.addEdge({ from: joinNodeId, to: rightTableId, type: EdgeType.JOIN_RIGHT });
			}
		}
	}

	// ── 2. Semantic models → Model, Dimension, Measure, Column nodes ──
	const semanticModels = getSemanticModels();
	if (semanticModels && bundles) {
		for (const model of semanticModels) {
			// Resolve which bundle this model belongs to
			const parentBundle = findBundleForTable(model.table, bundles);
			const bundleId = parentBundle?.bundle_id ?? '_unknown';
			const dbId = parentBundle?.warehouse.database_id ?? '_unknown';

			const modelId = `model:${bundleId}/${model.name}`;

			// Determine schema — try to find from bundle tables
			const schemaName = resolveSchema(model.table, parentBundle);
			const tableId = `table:${dbId}/${schemaName}.${model.table}`;

			graph.addNode({
				id: modelId,
				type: NodeType.Model,
				properties: {
					table: model.table,
					description: model.description ?? '',
				},
			});

			// WRAPS → Table
			if (graph.getNode(tableId)) {
				graph.addEdge({ from: modelId, to: tableId, type: EdgeType.WRAPS });
			} else {
				warnings.push(`Model ${model.name} references table ${model.table} not found in any bundle`);
			}

			// Dimensions
			for (const dimName of model.dimensions) {
				const dimId = `dim:${bundleId}/${model.name}.${dimName}`;
				const columnId = `column:${dbId}/${schemaName}.${model.table}/${dimName}`;

				graph.addNode({
					id: dimId,
					type: NodeType.Dimension,
					properties: { column: dimName },
				});

				// Ensure column node exists
				if (!graph.getNode(columnId)) {
					graph.addNode({
						id: columnId,
						type: NodeType.Column,
						properties: { data_type: 'unknown', is_pii: false },
					});
				}

				graph.addEdge({ from: modelId, to: dimId, type: EdgeType.DEFINES });
				graph.addEdge({ from: dimId, to: columnId, type: EdgeType.READS });
			}

			// Measures
			for (const [measureName, measureType] of Object.entries(model.measures)) {
				const measureId = `measure:${bundleId}/${model.name}.${measureName}`;
				graph.addNode({
					id: measureId,
					type: NodeType.Measure,
					properties: { type: measureType },
				});
				graph.addEdge({ from: modelId, to: measureId, type: EdgeType.DEFINES });

				// For non-count measures, the measure aggregates a column with the same name
				// (the actual column info comes from the full YAML, but the summary loader
				// only gives us the type string — so we use measure name as column name heuristic)
				const columnId = `column:${dbId}/${schemaName}.${model.table}/${measureName}`;
				if (!graph.getNode(columnId)) {
					graph.addNode({
						id: columnId,
						type: NodeType.Column,
						properties: { data_type: 'unknown', is_pii: false },
					});
				}
				graph.addEdge({ from: measureId, to: columnId, type: EdgeType.AGGREGATES });
			}

			// Joins between models
			for (const joinTarget of model.joins) {
				const targetModelId = `model:${bundleId}/${joinTarget}`;
				graph.addEdge({ from: modelId, to: targetModelId, type: EdgeType.JOINS_WITH });
			}
		}
	}

	// ── 3. Business rules → Rule nodes + APPLIES_TO edges ──
	const rules = getBusinessRules();
	if (rules) {
		for (const rule of rules) {
			const ruleId = `rule:${rule.name}`;
			graph.addNode({
				id: ruleId,
				type: NodeType.Rule,
				properties: {
					category: rule.category,
					severity: rule.severity,
					guidance: rule.guidance,
					description: rule.description,
				},
			});

			// APPLIES_TO: resolve target models/measures
			for (const target of rule.applies_to) {
				// Try to find matching model or measure nodes
				const matchingNodes = findNodesMatching(graph, target);
				for (const nodeId of matchingNodes) {
					graph.addEdge({ from: ruleId, to: nodeId, type: EdgeType.APPLIES_TO });
				}
			}
		}
	}

	// ── 4. Classifications → Classification nodes + CLASSIFIES edges ──
	const classifications = getClassifications();
	if (classifications) {
		for (const cls of classifications) {
			const classId = `class:${cls.name}`;
			graph.addNode({
				id: classId,
				type: NodeType.Classification,
				properties: {
					description: cls.description ?? '',
					tags: cls.tags,
				},
			});

			// CLASSIFIES edges are established when PII columns are declared in policy
		}
	}

	// ── 5. Policy → Policy node + BLOCKS/CLASSIFIES edges ──
	const policy = getPolicies(projectFolder);
	if (policy) {
		graph.addNode({
			id: 'policy:root',
			type: NodeType.Policy,
			properties: {
				pii_mode: policy.pii.mode,
				max_rows: policy.defaults.max_rows,
				require_contract: policy.execution.require_contract,
				require_bundle: policy.execution.require_bundle,
			},
		});

		// PII columns: policy.pii.columns is Record<string, string[]>
		// key = "schema.table", value = column names
		if (policy.pii.columns) {
			for (const [tableKey, columns] of Object.entries(policy.pii.columns)) {
				for (const colName of columns) {
					// Find the column node across all bundles
					const columnIds = findColumnIds(graph, tableKey, colName);
					for (const columnId of columnIds) {
						// Mark column as PII
						const node = graph.getNode(columnId);
						if (node) {
							node.properties.is_pii = true;
						}

						// BLOCKS edge from policy
						graph.addEdge({ from: 'policy:root', to: columnId, type: EdgeType.BLOCKS });

						// CLASSIFIES edge from PII classification (if it exists)
						const piiClassNode = graph.getNode('class:PII');
						if (piiClassNode) {
							graph.addEdge({ from: 'class:PII', to: columnId, type: EdgeType.CLASSIFIES });
						} else {
							// Create implicit PII classification
							for (const tag of policy.pii.tags) {
								const classNode = graph.getNode(`class:${tag}`);
								if (classNode) {
									graph.addEdge({ from: `class:${tag}`, to: columnId, type: EdgeType.CLASSIFIES });
								}
							}
						}
					}
				}
			}
		}
	}

	if (warnings.length > 0) {
		console.warn('[graph-builder] Compilation warnings:');
		for (const w of warnings) {
			console.warn(`  - ${w}`);
		}
	}

	return graph;
}

// ── Helper functions ──

function hashFile(graph: GovernanceGraph, filePath: string): void {
	if (!existsSync(filePath)) {
		return;
	}
	const content = readFileSync(filePath, 'utf-8');
	const hash = createHash('sha256').update(content).digest('hex');
	graph.setFileHash(filePath, hash);
}

function resolveTableId(
	tableName: string,
	dbId: string,
	tables: Array<{ schema: string; table: string }>,
): string | null {
	// tableName might be "schema.table" or just "table"
	if (tableName.includes('.')) {
		return `table:${dbId}/${tableName}`;
	}
	// Find in bundle tables
	const match = tables.find((t) => t.table === tableName);
	if (match) {
		return `table:${dbId}/${match.schema}.${match.table}`;
	}
	return null;
}

function findBundleForTable(
	tableName: string,
	bundles: Array<{
		bundle_id: string;
		warehouse: { database_id: string; type: string };
		tables: Array<{ schema: string; table: string }>;
	}>,
) {
	for (const bundle of bundles) {
		if (bundle.tables.some((t) => t.table === tableName)) {
			return bundle;
		}
	}
	return null;
}

function resolveSchema(tableName: string, bundle: { tables: Array<{ schema: string; table: string }> } | null): string {
	if (!bundle) {
		return 'main';
	}
	const match = bundle.tables.find((t) => t.table === tableName);
	return match?.schema ?? 'main';
}

/**
 * Find nodes matching a business rule's applies_to target.
 * Targets can be model names, measure names, or patterns like "orders.total_revenue".
 */
function findNodesMatching(graph: GovernanceGraph, target: string): string[] {
	const matches: string[] = [];

	// Try exact match on measures: "model.measure" pattern
	if (target.includes('.')) {
		const measureNodes = graph.getNodesByType(NodeType.Measure);
		for (const node of measureNodes) {
			// measure ID: "measure:bundle/model.measure"
			if (node.id.endsWith(`/${target}`) || node.id.endsWith(`.${target}`)) {
				matches.push(node.id);
			}
		}
	}

	// Try match on model names
	const modelNodes = graph.getNodesByType(NodeType.Model);
	for (const node of modelNodes) {
		if (node.id.endsWith(`/${target}`)) {
			matches.push(node.id);
		}
	}

	// Try match on measure names (short name)
	if (matches.length === 0) {
		const measureNodes = graph.getNodesByType(NodeType.Measure);
		for (const node of measureNodes) {
			const parts = node.id.split('.');
			const shortName = parts[parts.length - 1];
			if (shortName === target) {
				matches.push(node.id);
			}
		}
	}

	return matches;
}

/**
 * Find column IDs matching a table key ("schema.table") and column name.
 */
function findColumnIds(graph: GovernanceGraph, tableKey: string, colName: string): string[] {
	const matches: string[] = [];
	const tableNodes = graph.getNodesByType(NodeType.Table);
	for (const table of tableNodes) {
		const schema = table.properties.schema as string;
		const tableName = table.properties.table as string;
		if (`${schema}.${tableName}` === tableKey || tableName === tableKey) {
			const dbId = table.properties.database_id as string;
			const columnId = `column:${dbId}/${schema}.${tableName}/${colName}`;
			// Ensure column node exists
			if (!graph.getNode(columnId)) {
				graph.addNode({
					id: columnId,
					type: NodeType.Column,
					properties: { data_type: 'unknown', is_pii: true },
				});
			}
			matches.push(columnId);
		}
	}
	return matches;
}

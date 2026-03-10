/**
 * Invariant-based tests for the TypeScript GovernanceGraph.
 * Mirrors the Python Phase 1 tests in cli/tests/dazense_core/graph/test_governance_graph.py.
 *
 * Uses a tmp-dir fixture identical to the Python conftest (NOT the real example/ dir)
 * so tests are hermetic and match the Python test expectations exactly.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import type { GovernanceGraph } from '../../src/graph/governance-graph';
import { buildFromProject } from '../../src/graph/graph-builder';
import { EdgeType, NodeType } from '../../src/graph/types';

// ── Fixture: minimal jaffle_shop project (matches Python conftest) ──

let graph: GovernanceGraph;
let projectPath: string;

beforeAll(() => {
	// Create a tmp dir with the fixture YAML
	projectPath = join(import.meta.dirname, '.tmp-graph-fixture');
	mkdirSync(projectPath, { recursive: true });

	// Set env so the TS loaders find semantic/rules YAML
	process.env.DAZENSE_DEFAULT_PROJECT_PATH = projectPath;

	// datasets/jaffle_shop/dataset.yaml
	const datasetsDir = join(projectPath, 'datasets', 'jaffle_shop');
	mkdirSync(datasetsDir, { recursive: true });
	writeFileSync(
		join(datasetsDir, 'dataset.yaml'),
		YAML.stringify({
			version: 1,
			bundle_id: 'jaffle_shop',
			display_name: 'Jaffle Shop — Core Analytics',
			owners: [{ name: 'Data Team' }],
			warehouse: { type: 'duckdb', database_id: 'duckdb-jaffle-shop' },
			tables: [
				{ schema: 'main', table: 'customers' },
				{ schema: 'main', table: 'orders' },
				{ schema: 'main', table: 'stg_payments' },
			],
			joins: [
				{
					left: { schema: 'main', table: 'orders', column: 'customer_id' },
					right: { schema: 'main', table: 'customers', column: 'customer_id' },
					type: 'many_to_one',
				},
				{
					left: { schema: 'main', table: 'stg_payments', column: 'order_id' },
					right: { schema: 'main', table: 'orders', column: 'order_id' },
					type: 'many_to_one',
				},
			],
			defaults: {
				require_time_filter_for_tables: ['main.orders'],
				max_rows: 200,
			},
			certification: { level: 'certified' },
		}),
	);

	// semantics/semantic_model.yml
	const semanticsDir = join(projectPath, 'semantics');
	mkdirSync(semanticsDir, { recursive: true });
	writeFileSync(
		join(semanticsDir, 'semantic_model.yml'),
		YAML.stringify({
			models: {
				customers: {
					table: 'customers',
					schema: 'main',
					primary_key: 'customer_id',
					dimensions: {
						customer_id: { column: 'customer_id' },
						first_name: { column: 'first_name', description: 'PII' },
						last_name: { column: 'last_name', description: 'PII' },
					},
					measures: {
						customer_count: { type: 'count' },
						total_lifetime_value: { type: 'sum', column: 'customer_lifetime_value' },
						avg_lifetime_value: { type: 'avg', column: 'customer_lifetime_value' },
					},
				},
				orders: {
					table: 'orders',
					schema: 'main',
					primary_key: 'order_id',
					time_dimension: 'order_date',
					dimensions: {
						order_id: { column: 'order_id' },
						order_date: { column: 'order_date' },
						status: { column: 'status' },
						customer_id: { column: 'customer_id' },
					},
					measures: {
						order_count: { type: 'count' },
						total_revenue: {
							type: 'sum',
							column: 'amount',
							filters: [{ column: 'status', operator: 'not_in', value: ['returned', 'return_pending'] }],
						},
						avg_order_value: { type: 'avg', column: 'amount' },
					},
					joins: {
						customer: {
							to_model: 'customers',
							foreign_key: 'customer_id',
							related_key: 'customer_id',
							type: 'many_to_one',
						},
					},
				},
				payments: {
					table: 'stg_payments',
					schema: 'main',
					primary_key: 'payment_id',
					dimensions: {
						payment_id: { column: 'payment_id' },
						payment_method: { column: 'payment_method' },
					},
					measures: {
						payment_count: { type: 'count' },
						total_payment_amount: { type: 'sum', column: 'amount' },
					},
					joins: {
						order: {
							to_model: 'orders',
							foreign_key: 'order_id',
							related_key: 'order_id',
							type: 'many_to_one',
						},
					},
				},
			},
		}),
	);

	// semantics/business_rules.yml
	writeFileSync(
		join(semanticsDir, 'business_rules.yml'),
		YAML.stringify({
			rules: [
				{
					name: 'exclude_returned_orders_from_revenue',
					category: 'metrics',
					severity: 'critical',
					applies_to: ['orders.total_revenue', 'orders.avg_order_value'],
					description: 'Revenue metrics must exclude returned orders.',
					guidance: "Filter WHERE status NOT IN ('returned', 'return_pending').",
				},
				{
					name: 'pii_customer_names',
					category: 'privacy',
					severity: 'critical',
					applies_to: ['customers.first_name', 'customers.last_name'],
					description: 'first_name and last_name are PII.',
					guidance: 'Never include in results unless explicitly requested.',
				},
				{
					name: 'orders_require_time_filter',
					category: 'query_patterns',
					severity: 'warning',
					applies_to: ['orders'],
					description: 'Orders table needs a time filter.',
					guidance: 'Apply time filter on order_date.',
				},
			],
			classifications: [
				{
					name: 'PII',
					description: 'Personally identifiable information',
					tags: ['sensitive', 'restricted'],
				},
				{
					name: 'Financial',
					description: 'Monetary values',
					tags: ['financial'],
				},
			],
		}),
	);

	// policies/policy.yml
	const policiesDir = join(projectPath, 'policies');
	mkdirSync(policiesDir, { recursive: true });
	writeFileSync(
		join(policiesDir, 'policy.yml'),
		YAML.stringify({
			version: 1,
			defaults: { max_rows: 200 },
			pii: {
				mode: 'block',
				tags: ['PII', 'Sensitive'],
				columns: {
					'main.customers': ['first_name', 'last_name'],
				},
			},
			execution: {
				require_contract: false,
				require_bundle: true,
			},
		}),
	);

	graph = buildFromProject(projectPath);
});

afterAll(async () => {
	// Clean up
	const { rmSync } = await import('fs');
	try {
		rmSync(projectPath, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

// ── Invariant 1: Compile produces valid graph ──

describe('Compile', () => {
	it('graph has nodes and edges', () => {
		expect(graph.nodeCount).toBeGreaterThan(0);
		expect(graph.edgeCount).toBeGreaterThan(0);
	});

	it('stats keys are valid types', () => {
		const stats = graph.stats();
		const validNodeTypes = Object.values(NodeType);
		const validEdgeTypes = Object.values(EdgeType);
		for (const key of Object.keys(stats.nodes_by_type)) {
			expect(validNodeTypes).toContain(key);
		}
		for (const key of Object.keys(stats.edges_by_type)) {
			expect(validEdgeTypes).toContain(key);
		}
	});

	it('file hashes are tracked', () => {
		const hashes = graph.fileHashes;
		expect(hashes.size).toBeGreaterThan(0);
		for (const [, hash] of hashes) {
			expect(hash).toHaveLength(64); // sha256 hex
		}
	});
});

// ── Invariant 2: Every measure has an AGGREGATES edge ──

describe('Measure invariants', () => {
	it('every measure has AGGREGATES edge', () => {
		const measures = graph.getNodesByType(NodeType.Measure);
		expect(measures.length).toBeGreaterThan(0);
		for (const measure of measures) {
			const targets = graph.neighbors(measure.id, EdgeType.AGGREGATES, 'forward');
			expect(targets.length, `${measure.id} has no AGGREGATES edge`).toBeGreaterThan(0);
		}
	});

	it('AGGREGATES targets are columns', () => {
		for (const measure of graph.getNodesByType(NodeType.Measure)) {
			const targets = graph.neighbors(measure.id, EdgeType.AGGREGATES, 'forward');
			for (const target of targets) {
				expect(target.type).toBe(NodeType.Column);
			}
		}
	});
});

// ── Invariant 3: Every dimension has a READS edge ──

describe('Dimension invariants', () => {
	it('every dimension has READS edge', () => {
		const dims = graph.getNodesByType(NodeType.Dimension);
		expect(dims.length).toBeGreaterThan(0);
		for (const dim of dims) {
			const targets = graph.neighbors(dim.id, EdgeType.READS, 'forward');
			expect(targets.length, `${dim.id} has no READS edge`).toBeGreaterThan(0);
		}
	});

	it('READS targets are columns', () => {
		for (const dim of graph.getNodesByType(NodeType.Dimension)) {
			const targets = graph.neighbors(dim.id, EdgeType.READS, 'forward');
			for (const target of targets) {
				expect(target.type).toBe(NodeType.Column);
			}
		}
	});
});

// ── Invariant 4: Every model has a WRAPS edge ──

describe('Model invariants', () => {
	it('every model has WRAPS edge', () => {
		const models = graph.getNodesByType(NodeType.Model);
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			const targets = graph.neighbors(model.id, EdgeType.WRAPS, 'forward');
			expect(targets.length, `${model.id} has no WRAPS edge`).toBeGreaterThan(0);
		}
	});

	it('WRAPS targets are tables', () => {
		for (const model of graph.getNodesByType(NodeType.Model)) {
			const targets = graph.neighbors(model.id, EdgeType.WRAPS, 'forward');
			for (const target of targets) {
				expect(target.type).toBe(NodeType.Table);
			}
		}
	});
});

// ── Invariant 5: Every bundle CONTAINS at least one table ──

describe('Bundle invariants', () => {
	it('every bundle contains tables', () => {
		const bundles = graph.getNodesByType(NodeType.Bundle);
		expect(bundles.length).toBeGreaterThan(0);
		for (const bundle of bundles) {
			const tables = graph.neighbors(bundle.id, EdgeType.CONTAINS, 'forward');
			expect(tables.length, `${bundle.id} contains no tables`).toBeGreaterThan(0);
		}
	});
});

// ── Invariant 6: Lineage includes table + column ──

describe('Lineage', () => {
	it('lineage of measure includes Model', () => {
		for (const measure of graph.getNodesByType(NodeType.Measure)) {
			const lineage = graph.lineageOf(measure.id);
			const types = new Set(lineage.map((n) => n.type));
			expect(types.has(NodeType.Model), `lineageOf(${measure.id}) missing Model`).toBe(true);
		}
	});

	it('lineage of total_revenue includes orders', () => {
		const revenueNodes = graph.getNodesByType(NodeType.Measure).filter((n) => n.id.includes('total_revenue'));
		expect(revenueNodes).toHaveLength(1);
		const lineage = graph.lineageOf(revenueNodes[0].id);
		const ids = new Set(lineage.map((n) => n.id));
		expect([...ids].some((id) => id.includes('orders'))).toBe(true);
	});
});

// ── Invariant 7: Impact of column returns measures ──

describe('Impact', () => {
	it('column consumers are measures/dimensions/policy/classifications', () => {
		const amountCols = graph.getNodesByType(NodeType.Column).filter((n) => n.id.includes('orders/amount'));
		if (amountCols.length === 0) {
			return;
		} // skip if no amount column
		const consumers = graph.neighbors(amountCols[0].id, undefined, 'reverse');
		const types = new Set(consumers.map((n) => n.type));
		const allowed = new Set([NodeType.Measure, NodeType.Dimension, NodeType.Policy, NodeType.Classification]);
		for (const t of types) {
			expect(allowed.has(t), `Unexpected consumer type: ${t}`).toBe(true);
		}
	});
});

// ── JoinEdge decomposition ──

describe('JoinEdge decomposition', () => {
	it('ALLOWS_JOIN targets JoinEdge nodes', () => {
		const json = graph.toJSON();
		for (const edge of json.edges) {
			if (edge.type === EdgeType.ALLOWS_JOIN) {
				const target = graph.getNode(edge.to);
				expect(target).not.toBeNull();
				expect(target!.type).toBe(NodeType.JoinEdge);
			}
		}
	});

	it('every JoinEdge has exactly one JOIN_LEFT and one JOIN_RIGHT', () => {
		const joinEdges = graph.getNodesByType(NodeType.JoinEdge);
		expect(joinEdges.length).toBeGreaterThan(0);
		for (const je of joinEdges) {
			const lefts = graph.neighbors(je.id, EdgeType.JOIN_LEFT, 'forward');
			const rights = graph.neighbors(je.id, EdgeType.JOIN_RIGHT, 'forward');
			expect(lefts, `${je.id} JOIN_LEFT`).toHaveLength(1);
			expect(rights, `${je.id} JOIN_RIGHT`).toHaveLength(1);
		}
	});

	it('JOIN_LEFT and JOIN_RIGHT target Tables', () => {
		for (const je of graph.getNodesByType(NodeType.JoinEdge)) {
			for (const edgeType of [EdgeType.JOIN_LEFT, EdgeType.JOIN_RIGHT]) {
				const targets = graph.neighbors(je.id, edgeType, 'forward');
				for (const target of targets) {
					expect(target.type).toBe(NodeType.Table);
				}
			}
		}
	});
});

// ── toJSON structure ──

describe('Serialization', () => {
	it('toJSON node/edge counts match', () => {
		const data = graph.toJSON();
		expect(data.nodes).toHaveLength(graph.nodeCount);
		expect(data.edges).toHaveLength(graph.edgeCount);
	});

	it('nodes have required fields', () => {
		for (const node of graph.toJSON().nodes) {
			expect(node.id).toBeTruthy();
			expect(Object.values(NodeType)).toContain(node.type);
			expect(typeof node.properties).toBe('object');
		}
	});

	it('edges have required fields', () => {
		for (const edge of graph.toJSON().edges) {
			expect(edge.from).toBeTruthy();
			expect(edge.to).toBeTruthy();
			expect(Object.values(EdgeType)).toContain(edge.type);
		}
	});
});

// ── Simulation ──

describe('Simulation', () => {
	it('does not modify original graph', () => {
		const origNodes = graph.nodeCount;
		const origEdges = graph.edgeCount;
		const rules = graph.getNodesByType(NodeType.Rule);
		if (rules.length > 0) {
			graph.simulate([rules[0].id]);
		}
		expect(graph.nodeCount).toBe(origNodes);
		expect(graph.edgeCount).toBe(origEdges);
	});
});

// ── Neighbors API ──

describe('Neighbors', () => {
	it('forward neighbors: bundle contains 3 tables', () => {
		const bundle = graph.getNode('bundle:jaffle_shop');
		expect(bundle).not.toBeNull();
		const tables = graph.neighbors(bundle!.id, EdgeType.CONTAINS, 'forward');
		expect(tables).toHaveLength(3);
	});

	it('reverse neighbors: table belongs to bundle', () => {
		const table = graph.getNode('table:duckdb-jaffle-shop/main.orders');
		expect(table).not.toBeNull();
		const bundles = graph.neighbors(table!.id, EdgeType.CONTAINS, 'reverse');
		expect(bundles).toHaveLength(1);
		expect(bundles[0].id).toBe('bundle:jaffle_shop');
	});
});

// ── Edge cases ──

describe('Edge cases', () => {
	it('get nonexistent node returns null', () => {
		expect(graph.getNode('nonexistent:foo')).toBeNull();
	});

	it('lineage of nonexistent node returns empty', () => {
		expect(graph.lineageOf('nonexistent:foo')).toEqual([]);
	});
});

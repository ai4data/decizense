import type { GovernanceGraph } from './governance-graph';
import { NodeType } from './types';

/**
 * Resolve a user-supplied entity reference to a full graph node ID.
 *
 * Accepts:
 * - Full canonical ID: "measure:jaffle_shop/orders.total_revenue"
 * - Short model.entity: "orders.total_revenue"
 * - Short table ref: "main.orders.amount" → column
 * - Short name: "orders" → model
 */
export function resolveEntityId(graph: GovernanceGraph, input: string): string | null {
	// 1. Exact match
	if (graph.getNode(input)) {
		return input;
	}

	// 2. Try common prefixes
	const prefixes = ['measure:', 'dim:', 'model:', 'column:', 'table:', 'rule:', 'class:', 'bundle:'];
	for (const prefix of prefixes) {
		if (input.startsWith(prefix)) {
			return graph.getNode(input) ? input : null;
		}
	}

	// 3. "model.measure" or "model.dimension" format (e.g. "orders.total_revenue")
	if (input.includes('.')) {
		const parts = input.split('.');

		// Try as measure
		for (const node of graph.getNodesByType(NodeType.Measure)) {
			if (node.id.endsWith(`/${input}`) || node.id.endsWith(`.${input}`)) {
				return node.id;
			}
		}

		// Try as dimension
		for (const node of graph.getNodesByType(NodeType.Dimension)) {
			if (node.id.endsWith(`/${input}`) || node.id.endsWith(`.${input}`)) {
				return node.id;
			}
		}

		// Try as "schema.table.column" (3 parts)
		if (parts.length === 3) {
			const suffix = `/${parts[0]}.${parts[1]}/${parts[2]}`;
			for (const node of graph.getNodesByType(NodeType.Column)) {
				if (node.id.endsWith(suffix)) {
					return node.id;
				}
			}
		}

		// Try as "schema.table"
		if (parts.length === 2) {
			for (const node of graph.getNodesByType(NodeType.Table)) {
				if (node.properties.schema === parts[0] && node.properties.table === parts[1]) {
					return node.id;
				}
			}
		}
	}

	// 4. Short name match on models
	for (const node of graph.getNodesByType(NodeType.Model)) {
		if (node.id.endsWith(`/${input}`)) {
			return node.id;
		}
	}

	// 5. Short name match on rules
	const ruleId = `rule:${input}`;
	if (graph.getNode(ruleId)) {
		return ruleId;
	}

	// 6. Short name match on measures (just the measure name)
	for (const node of graph.getNodesByType(NodeType.Measure)) {
		const shortName = node.id.split('.').pop();
		if (shortName === input) {
			return node.id;
		}
	}

	return null;
}

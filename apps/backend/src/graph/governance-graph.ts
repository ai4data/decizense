import type { EdgeType, GapEntry, GapReport, GraphEdge, GraphJSON, GraphNode, GraphStats } from './types';
import { NodeType } from './types';

export class GovernanceGraph {
	private nodes = new Map<string, GraphNode>();
	private forwardEdges = new Map<string, GraphEdge[]>(); // from → edges
	private reverseEdges = new Map<string, GraphEdge[]>(); // to → edges
	private allEdges: GraphEdge[] = [];
	private _fileHashes = new Map<string, string>();

	// ── Mutation (used by builder only) ──

	addNode(node: GraphNode): void {
		this.nodes.set(node.id, node);
	}

	addEdge(edge: GraphEdge): void {
		this.allEdges.push(edge);
		const fwd = this.forwardEdges.get(edge.from) ?? [];
		fwd.push(edge);
		this.forwardEdges.set(edge.from, fwd);
		const rev = this.reverseEdges.get(edge.to) ?? [];
		rev.push(edge);
		this.reverseEdges.set(edge.to, rev);
	}

	setFileHash(filePath: string, hash: string): void {
		this._fileHashes.set(filePath, hash);
	}

	get fileHashes(): Map<string, string> {
		return new Map(this._fileHashes);
	}

	// ── Read API ──

	getNode(id: string): GraphNode | null {
		return this.nodes.get(id) ?? null;
	}

	getNodesByType(type: NodeType): GraphNode[] {
		return [...this.nodes.values()].filter((n) => n.type === type);
	}

	neighbors(id: string, edgeType?: EdgeType, direction: 'forward' | 'reverse' | 'both' = 'both'): GraphNode[] {
		const result = new Set<string>();

		if (direction === 'forward' || direction === 'both') {
			for (const edge of this.forwardEdges.get(id) ?? []) {
				if (!edgeType || edge.type === edgeType) {
					result.add(edge.to);
				}
			}
		}

		if (direction === 'reverse' || direction === 'both') {
			for (const edge of this.reverseEdges.get(id) ?? []) {
				if (!edgeType || edge.type === edgeType) {
					result.add(edge.from);
				}
			}
		}

		return [...result].map((nid) => this.nodes.get(nid)!).filter(Boolean);
	}

	/** Transitive upstream traversal (follow forward edges — edges point from parent to child). */
	lineageOf(id: string): GraphNode[] {
		return this.traverse(id, 'forward');
	}

	/** Transitive downstream traversal (follow reverse edges — find who depends on me). */
	impactOf(id: string): GraphNode[] {
		return this.traverse(id, 'reverse');
	}

	/**
	 * Find nodes of `sourceType` that have an inbound edge of `requiredEdge`
	 * from a node of `targetType` — but are missing it.
	 *
	 * Example: findGaps(NodeType.Column, EdgeType.BLOCKS, NodeType.Policy)
	 *  → columns that have no BLOCKS edge from a Policy node.
	 */
	findGaps(sourceType: NodeType, requiredEdge: EdgeType, targetType: NodeType): GraphNode[] {
		const gaps: GraphNode[] = [];
		for (const node of this.getNodesByType(sourceType)) {
			const inbound = this.reverseEdges.get(node.id) ?? [];
			const hasRequired = inbound.some(
				(e) => e.type === requiredEdge && this.nodes.get(e.from)?.type === targetType,
			);
			if (!hasRequired) {
				gaps.push(node);
			}
		}
		return gaps;
	}

	/** PII columns that have a CLASSIFIES edge from class:PII but no BLOCKS edge from policy:root. */
	findUnblockedPiiColumns(): GraphNode[] {
		const piiColumns = new Set<string>();

		// Find all columns classified as PII
		for (const edge of this.allEdges) {
			if (edge.type === ('CLASSIFIES' as EdgeType) && edge.from.startsWith('class:')) {
				const classNode = this.nodes.get(edge.from);
				if (classNode) {
					const tags = (classNode.properties.tags as string[]) ?? [];
					if (tags.includes('PII') || edge.from === 'class:PII') {
						piiColumns.add(edge.to);
					}
				}
			}
		}

		// Remove columns that have a BLOCKS edge from policy
		for (const edge of this.allEdges) {
			if (edge.type === ('BLOCKS' as EdgeType) && edge.from.startsWith('policy:')) {
				piiColumns.delete(edge.to);
			}
		}

		return [...piiColumns].map((id) => this.nodes.get(id)!).filter(Boolean);
	}

	/**
	 * Simulate removing nodes and report new gaps.
	 * Non-destructive: operates on a shallow copy.
	 */
	simulate(removals: string[]): GapReport {
		const copy = this.shallowCopy();
		for (const id of removals) {
			copy.removeNode(id);
		}

		const newGaps: GapEntry[] = [];

		// Check: measures without APPLIES_TO from any Rule
		for (const measure of copy.getNodesByType(NodeType.Measure)) {
			const inbound = copy.reverseEdges.get(measure.id) ?? [];
			const hasRule = inbound.some(
				(e) => e.type === ('APPLIES_TO' as EdgeType) && copy.nodes.get(e.from)?.type === NodeType.Rule,
			);
			if (!hasRule) {
				// Was it governed before?
				const originalInbound = this.reverseEdges.get(measure.id) ?? [];
				const wasGoverned = originalInbound.some(
					(e) => e.type === ('APPLIES_TO' as EdgeType) && this.nodes.get(e.from)?.type === NodeType.Rule,
				);
				if (wasGoverned) {
					newGaps.push({
						node_id: measure.id,
						node_type: NodeType.Measure,
						missing_edge: 'APPLIES_TO' as EdgeType,
						description: `${measure.id} loses governance`,
					});
				}
			}
		}

		// Check: PII columns that lost BLOCKS
		const unblockedBefore = new Set(this.findUnblockedPiiColumns().map((n) => n.id));
		const unblockedAfter = copy.findUnblockedPiiColumns();
		for (const col of unblockedAfter) {
			if (!unblockedBefore.has(col.id)) {
				newGaps.push({
					node_id: col.id,
					node_type: NodeType.Column,
					missing_edge: 'BLOCKS' as EdgeType,
					description: `${col.id} loses PII protection`,
				});
			}
		}

		return { removed: removals, new_gaps: newGaps };
	}

	stats(): GraphStats {
		const nodes_by_type: Record<string, number> = {};
		for (const node of this.nodes.values()) {
			nodes_by_type[node.type] = (nodes_by_type[node.type] ?? 0) + 1;
		}

		const edges_by_type: Record<string, number> = {};
		for (const edge of this.allEdges) {
			edges_by_type[edge.type] = (edges_by_type[edge.type] ?? 0) + 1;
		}

		return { nodes_by_type, edges_by_type };
	}

	toJSON(): GraphJSON {
		return {
			nodes: [...this.nodes.values()],
			edges: [...this.allEdges],
		};
	}

	get nodeCount(): number {
		return this.nodes.size;
	}

	get edgeCount(): number {
		return this.allEdges.length;
	}

	// ── Internal helpers ──

	private traverse(startId: string, direction: 'forward' | 'reverse'): GraphNode[] {
		const visited = new Set<string>();
		const queue = [startId];
		const result: GraphNode[] = [];

		while (queue.length > 0) {
			const current = queue.shift()!;
			if (visited.has(current)) {
				continue;
			}
			visited.add(current);

			const edges =
				direction === 'forward'
					? (this.forwardEdges.get(current) ?? [])
					: (this.reverseEdges.get(current) ?? []);

			for (const edge of edges) {
				const neighborId = direction === 'forward' ? edge.to : edge.from;
				if (!visited.has(neighborId)) {
					const node = this.nodes.get(neighborId);
					if (node) {
						result.push(node);
						queue.push(neighborId);
					}
				}
			}
		}

		return result;
	}

	private shallowCopy(): GovernanceGraph {
		const copy = new GovernanceGraph();
		for (const [id, node] of this.nodes) {
			copy.nodes.set(id, node);
		}
		for (const edge of this.allEdges) {
			copy.addEdge(edge);
		}
		return copy;
	}

	private removeNode(id: string): void {
		this.nodes.delete(id);
		// Remove edges involving this node
		const fwdEdges = this.forwardEdges.get(id) ?? [];
		for (const edge of fwdEdges) {
			const rev = this.reverseEdges.get(edge.to);
			if (rev) {
				this.reverseEdges.set(
					edge.to,
					rev.filter((e) => e.from !== id),
				);
			}
		}
		this.forwardEdges.delete(id);

		const revEdges = this.reverseEdges.get(id) ?? [];
		for (const edge of revEdges) {
			const fwd = this.forwardEdges.get(edge.from);
			if (fwd) {
				this.forwardEdges.set(
					edge.from,
					fwd.filter((e) => e.to !== id),
				);
			}
		}
		this.reverseEdges.delete(id);

		this.allEdges = this.allEdges.filter((e) => e.from !== id && e.to !== id);
	}
}

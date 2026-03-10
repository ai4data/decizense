// ── Node types ──

export enum NodeType {
	Bundle = 'Bundle',
	Table = 'Table',
	Column = 'Column',
	Model = 'Model',
	Dimension = 'Dimension',
	Measure = 'Measure',
	Rule = 'Rule',
	Classification = 'Classification',
	Policy = 'Policy',
	JoinEdge = 'JoinEdge',
	Contract = 'Contract',
	PolicyCheck = 'PolicyCheck',
}

// ── Edge types ──

export enum EdgeType {
	// Phase 1: structural edges
	DEFINES = 'DEFINES',
	APPLIES_TO = 'APPLIES_TO',
	BLOCKS = 'BLOCKS',
	REQUIRES_TIME_FILTER = 'REQUIRES_TIME_FILTER',
	JOINS_WITH = 'JOINS_WITH',
	CONTAINS = 'CONTAINS',
	READS = 'READS',
	AGGREGATES = 'AGGREGATES',
	FILTERS_ON = 'FILTERS_ON',
	CLASSIFIES = 'CLASSIFIES',
	WRAPS = 'WRAPS',
	ALLOWS_JOIN = 'ALLOWS_JOIN',
	JOIN_LEFT = 'JOIN_LEFT',
	JOIN_RIGHT = 'JOIN_RIGHT',

	// Phase 2: contract edges
	TOUCHED = 'TOUCHED',
	USED = 'USED',
	REFERENCED = 'REFERENCED',
	DECIDED = 'DECIDED',
	FAILED = 'FAILED',
}

// ── Graph primitives ──

export interface GraphNode {
	id: string;
	type: NodeType;
	properties: Record<string, unknown>;
}

export interface GraphEdge {
	from: string;
	to: string;
	type: EdgeType;
}

// ── Query result types ──

export interface GraphStats {
	nodes_by_type: Record<string, number>;
	edges_by_type: Record<string, number>;
}

export interface GapReport {
	removed: string[];
	new_gaps: GapEntry[];
}

export interface GapEntry {
	node_id: string;
	node_type: NodeType;
	missing_edge: EdgeType;
	description: string;
}

export interface GraphJSON {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

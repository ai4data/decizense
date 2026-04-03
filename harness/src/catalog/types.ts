/**
 * Catalog interface — abstract contract for any metadata platform.
 *
 * Implement this for OpenMetadata, Atlan, Collibra, Purview, or any
 * other catalog. The harness calls these methods — it never knows
 * which catalog is behind them.
 */

export interface CatalogTable {
	name: string;
	fqn: string;
	schema: string;
	description: string;
	columns: CatalogColumn[];
	tags: string[];
	owners: Array<{ name: string; type: string }>;
	piiColumns: string[];
	tier: string | null;
	glossaryTerms: string[];
}

export interface CatalogColumn {
	name: string;
	dataType: string;
	description: string;
	tags: string[];
	isPii: boolean;
}

export interface CatalogGlossaryTerm {
	name: string;
	fqn: string;
	description: string;
	synonyms: string[];
	relatedTerms: string[];
	linkedTables: string[];
}

export interface CatalogLineageEdge {
	from: string;
	to: string;
}

/**
 * The interface every catalog provider must implement.
 * The harness only calls these methods — never OMD-specific APIs.
 */
export interface ICatalogClient {
	/** List all tables for the configured service/database. */
	listTables(): Promise<CatalogTable[]>;

	/** Get PII columns as "schema.table.column" strings. */
	getPiiColumns(): Promise<Set<string>>;

	/** List glossary/business terms with relationships. */
	listGlossaryTerms(glossaryName?: string): Promise<CatalogGlossaryTerm[]>;

	/** Get upstream lineage for a table. */
	getLineage(tableFqn: string, depth?: number): Promise<CatalogLineageEdge[]>;

	/** Run a SPARQL query (optional — not all catalogs support this). */
	sparql?(query: string): Promise<Array<Record<string, { type: string; value: string }>>>;

	/** Check if the catalog is reachable. */
	healthCheck(): Promise<boolean>;
}

# Cookbook 05: Add a New Catalog Provider

The harness reads metadata (tables, PII tags, glossary, lineage) from a pluggable catalog. OpenMetadata is implemented. Here's how to add Atlan, Collibra, Purview, or any other catalog.

## Architecture

```
harness/src/catalog/
  types.ts            ← ICatalogClient interface (don't modify)
  openmetadata.ts     ← OpenMetadata implementation (reference)
  your-catalog.ts     ← Your new implementation
  index.ts            ← Factory (register here)
```

## Step 1: Implement ICatalogClient

Create `harness/src/catalog/atlan.ts`:

```typescript
import type { ICatalogClient, CatalogTable, CatalogColumn, CatalogGlossaryTerm, CatalogLineageEdge } from './types.js';

export class AtlanCatalogClient implements ICatalogClient {
	private baseUrl: string;
	private token: string;

	constructor(config: { url: string; token?: string; serviceName: string }) {
		this.baseUrl = config.url;
		this.token = config.token ?? '';
	}

	async listTables(): Promise<CatalogTable[]> {
		// Call Atlan API
		// Map response to CatalogTable format
		// Return array
	}

	async getPiiColumns(): Promise<Set<string>> {
		// Query Atlan for PII-classified columns
		// Return as Set<"schema.table.column">
	}

	async listGlossaryTerms(): Promise<CatalogGlossaryTerm[]> {
		// Query Atlan glossary API
		// Map to CatalogGlossaryTerm format
	}

	async getLineage(tableFqn: string, depth?: number): Promise<CatalogLineageEdge[]> {
		// Query Atlan lineage API
		// Return upstream edges
	}

	async healthCheck(): Promise<boolean> {
		// Ping Atlan API
	}
}
```

## Step 2: Register in factory

Edit `harness/src/catalog/index.ts`:

```typescript
import { AtlanCatalogClient } from './atlan.js';

const PROVIDERS: Record<string, CatalogFactory> = {
  openmetadata: (config) => new OpenMetadataCatalogClient({ ... }),
  atlan: (config) => new AtlanCatalogClient({
    url: config.url,
    token: config.token,
    serviceName: config.serviceName,
  }),
};
```

## Step 3: Configure scenario

```yaml
# scenario.yml
catalog:
    provider: atlan
    url: https://atlan.company.com
    token: "{{ env('CATALOG_TOKEN') }}"
    service_name: my_database
```

## Interface reference

### listTables()

Return all tables with columns, tags, PII detection, ownership:

```typescript
{
  name: "customers",
  fqn: "service.db.public.customers",
  schema: "public",
  description: "Customer profiles",
  columns: [
    { name: "email", dataType: "VARCHAR", isPii: true, tags: ["PII.Sensitive"] },
    { name: "country", dataType: "VARCHAR", isPii: false, tags: [] },
  ],
  tags: ["Tier.Tier1"],
  owners: [{ name: "Data Team", type: "team" }],
  piiColumns: ["email"],
  tier: "Tier.Tier1",
  glossaryTerms: ["MyGlossary.CustomerData"],
}
```

### getPiiColumns()

Return PII columns as `Set<"schema.table.column">`:

```typescript
Set { "public.customers.email", "public.customers.phone" }
```

### listGlossaryTerms()

Return business terms with relationships:

```typescript
{
  name: "Revenue",
  fqn: "Glossary.Revenue",
  description: "Net revenue after returns",
  synonyms: ["Sales", "Net Sales"],
  relatedTerms: ["Cost", "Margin"],
  linkedTables: [],
}
```

### getLineage()

Return upstream dependency edges:

```typescript
[{ from: 'service.db.public.raw_orders', to: 'service.db.public.orders' }];
```

## Testing

```bash
cd agents
npx tsx src/test-query.ts
```

If the catalog is connected, the harness log shows `[catalog] Provider: atlan` and `[harness] Catalog: connected`.

## No harness code changes needed

The harness only imports `ICatalogClient` from `types.ts`. Your implementation is isolated in its own file. Zero changes to governance, tools, or agents.

# Adding Metadata Providers

dazense supports pluggable metadata providers for graph enrichment. OpenMetadata is the first implementation. This guide explains how to add support for other platforms (Collibra, Alation, Atlan, DataHub, etc.).

## Architecture

```
Metadata Platform (API)
        ↓
   Sync Provider          ← platform-specific: auth, API calls, pagination
        ↓
   Normalized YAML        ← shared format: tables.yml per schema
        ↓
   Graph Enrichment       ← generic: reads YAML, enriches graph nodes
```

The key design: all providers write the **same YAML format**. The graph enrichment layer doesn't know or care which platform produced the file.

## Shared YAML format

Every provider writes files to `<provider_name>/<service>/<database>/<schema>/tables.yml`:

```yaml
service: my-warehouse
database: analytics
schema: public
tables:
    - name: customers
      fqn: 'my-warehouse.analytics.public.customers'
      table_type: Regular
      description: 'Customer master data'
      columns:
          - name: customer_id
            data_type: INTEGER
            description: 'Unique customer identifier'
          - name: email
            data_type: VARCHAR
            description: 'Customer email address'
            tags: ['PII.Email']
      tags: ['certified']
```

## What to implement per provider

### 1. API client (`providers/<name>/client.py`)

Handles authentication, pagination, and data extraction. ~100-200 lines.

```python
@dataclass
class CatalogTable:
    fqn: str
    name: str
    database: str
    schema_name: str
    service: str
    table_type: str
    description: str
    columns: list[CatalogColumn]
    tags: list[str]

@dataclass
class CatalogColumn:
    name: str
    data_type: str
    description: str
    tags: list[str]

class MyPlatformClient:
    def __init__(self, base_url: str, api_key: str): ...
    def health_check(self) -> bool: ...
    def list_sources(self) -> list[dict]: ...
    def list_tables(self, source: str) -> list[CatalogTable]: ...
```

Each platform differs in:

| Aspect               | OpenMetadata             | Collibra            | Alation                  | Atlan              |
| -------------------- | ------------------------ | ------------------- | ------------------------ | ------------------ |
| Auth                 | Email + Base64 password  | OAuth2 / API key    | API token                | API key            |
| Pagination           | Cursor (`after`)         | Offset/limit        | Cursor                   | Offset/limit       |
| Table endpoint       | `/api/v1/tables`         | `/rest/2.0/assets`  | `/integration/v2/table/` | `/api/meta/entity` |
| Column location      | Nested in table response | Separate asset type | Nested                   | Nested             |
| Tags/classifications | `tags[].tagFQN`          | `classifications`   | `custom_fields`          | `classifications`  |

### 2. Sync provider (`providers/<name>/provider.py`)

Maps the platform API to the shared YAML format. ~80 lines. Follows the `SyncProvider` base class:

```python
from ..base import SyncProvider, SyncResult

class MyPlatformSyncProvider(SyncProvider):
    @property
    def name(self) -> str:
        return "MyPlatform"

    @property
    def emoji(self) -> str:
        return "\U0001f50d"

    @property
    def default_output_dir(self) -> str:
        return "myplatform"  # writes to <project>/myplatform/

    def get_items(self, config) -> list[Any]:
        """Return list of sources/services to sync."""
        ...

    def should_sync(self, config) -> bool:
        """Check if the platform is reachable."""
        ...

    def sync(self, items, output_path, project_path=None) -> SyncResult:
        """Fetch tables and write tables.yml files."""
        ...
```

### 3. Register the provider

In `cli/dazense_core/commands/sync/providers/__init__.py`:

```python
from .myplatform.provider import MyPlatformSyncProvider

PROVIDER_REGISTRY: dict[str, SyncProvider] = {
    "notion": NotionSyncProvider(),
    "repositories": RepositorySyncProvider(),
    "databases": DatabaseSyncProvider(),
    "openmetadata": OpenMetadataSyncProvider(),
    "myplatform": MyPlatformSyncProvider(),  # add here
}
```

### 4. Graph enrichment (no changes needed)

The `graph enrich` command reads any `<provider>/<service>/<db>/<schema>/tables.yml` file. As long as the YAML follows the shared format, enrichment works automatically:

- Fills `data_type` for columns that were "unknown"
- Adds `om_description` to matching tables and columns
- Discovers new columns not in the semantic model
- Creates `DISCOVERED_BY` edges for provenance tracking

## Environment variables

Each provider reads credentials from environment variables:

```bash
# OpenMetadata
OPENMETADATA_URL=http://localhost:8585
OPENMETADATA_EMAIL=admin@open-metadata.org
OPENMETADATA_PASSWORD=admin

# Collibra (example)
COLLIBRA_URL=https://my-org.collibra.com
COLLIBRA_API_KEY=your-api-key

# Alation (example)
ALATION_URL=https://my-org.alation.com
ALATION_API_TOKEN=your-token
```

## Usage

```powershell
# Sync from your platform
dazense sync -p myplatform

# Enrich the graph with discovered metadata
dazense graph enrich -p /path/to/project
```

## Effort estimate per provider

| Component        | Lines of code | Complexity                                     |
| ---------------- | ------------- | ---------------------------------------------- |
| API client       | 100-200       | Medium (platform-specific auth and pagination) |
| Sync provider    | 50-80         | Low (boilerplate mapping to shared YAML)       |
| Registration     | 3             | Trivial                                        |
| Graph enrichment | 0             | Already generic                                |
| **Total**        | **~150-280**  |                                                |

The OpenMetadata implementation (`client.py` + `provider.py`) is 300 lines total and can be used as a reference template.

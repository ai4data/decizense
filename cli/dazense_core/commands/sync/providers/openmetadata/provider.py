"""OpenMetadata sync provider — pulls table/column metadata from OM into local YAML + governance snapshot."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from dazense_core.config import DazenseConfig
from dazense_core.ui import create_console

from ..base import SyncProvider, SyncResult
from .client import OMGlossaryTerm, OMLineageEdge, OMTable, OpenMetadataClient

console = create_console()


def _get_client(config: DazenseConfig) -> OpenMetadataClient:
    """Build an OM client from config or env vars."""
    cat = config.catalog
    if cat and cat.provider == "openmetadata":
        url = cat.url
        token = cat.token or os.environ.get("CATALOG_TOKEN") or os.environ.get("OMD_BOT_TOKEN")
        email = cat.email
        password = cat.password
    elif config.openmetadata:
        # Legacy backward compat
        url = config.openmetadata.url
        token = config.openmetadata.token or os.environ.get("CATALOG_TOKEN") or os.environ.get("OMD_BOT_TOKEN")
        email = config.openmetadata.email
        password = config.openmetadata.password
    else:
        url = os.environ.get("CATALOG_URL", "http://localhost:8585")
        token = os.environ.get("CATALOG_TOKEN") or os.environ.get("OMD_BOT_TOKEN")
        email = os.environ.get("CATALOG_EMAIL", "admin@open-metadata.org")
        password = os.environ.get("CATALOG_PASSWORD", "admin")
    return OpenMetadataClient(url, token=token, email=email, password=password)


CatalogSyncProvider = None  # Forward reference, defined below


class OpenMetadataSyncProvider(SyncProvider):
    """Provider that syncs metadata from a catalog platform into local files.

    Fetches table schemas, column metadata, tags, and descriptions from
    the catalog API and writes them to catalog/<service>/<db>/<schema>/tables.yml.

    Currently supports OpenMetadata. Other providers (Atlan, Collibra, Purview)
    can be added by implementing the same client interface.
    """

    @property
    def name(self) -> str:
        return "Catalog"

    @property
    def emoji(self) -> str:
        return "\U0001f50d"

    @property
    def default_output_dir(self) -> str:
        return "catalog"

    def get_items(self, config: DazenseConfig) -> list[Any]:
        """Return list of catalog service names to sync.

        If config.catalog.services is set, use that list.
        Otherwise, discover all services from the catalog API.
        """
        try:
            client = _get_client(config)
            if not client.health_check():
                return []

            # Use configured services if specified
            cat = config.catalog
            if cat and cat.services:
                return list(cat.services)

            # Legacy backward compat
            om = config.openmetadata
            if om and om.services:
                return list(om.services)

            # Otherwise discover all services
            services = client.list_database_services()
            return [s["name"] for s in services]
        except Exception:
            return []

    def should_sync(self, config: DazenseConfig) -> bool:
        """Check if catalog is configured or reachable."""
        if config.catalog:
            return True
        if config.openmetadata:
            return True
        return len(self.get_items(config)) > 0

    def sync(self, items: list[Any], output_path: Path, project_path: Path | None = None) -> SyncResult:
        """Sync table metadata from OpenMetadata services into local YAML."""
        if not items:
            return SyncResult(provider_name=self.name, items_synced=0)

        # Load config to get client settings
        config = DazenseConfig.try_load(path=project_path)
        if not config:
            config = DazenseConfig(project_name="")
        client = _get_client(config)

        total_tables = 0
        total_services = 0

        console.print(f"\n[bold cyan]{self.emoji}  Syncing {self.name}[/bold cyan]")
        console.print(f"[dim]Server:[/dim] {client.base_url}")
        console.print(f"[dim]Services:[/dim] {', '.join(items)}")
        console.print(f"[dim]Location:[/dim] {output_path.absolute()}\n")

        for service_name in items:
            console.print(f"[dim]Service:[/dim] {service_name}")

            tables = client.list_tables(service_name)
            if not tables:
                console.print("  [dim]No tables found[/dim]")
                continue

            total_services += 1

            # Group tables by database.schema
            grouped: dict[str, dict[str, list]] = {}
            for t in tables:
                db_key = t.database or "_default"
                schema_key = t.schema_name or "_default"
                grouped.setdefault(db_key, {}).setdefault(schema_key, []).append(t)

            for db_name, schemas in grouped.items():
                for schema_name, schema_tables in schemas.items():
                    # Write tables.yml for each schema
                    schema_dir = output_path / service_name / db_name / schema_name
                    schema_dir.mkdir(parents=True, exist_ok=True)

                    tables_data = []
                    for t in schema_tables:
                        table_entry = {
                            "name": t.name,
                            "fqn": t.fqn,
                            "table_type": t.table_type,
                            "description": t.description or "",
                            "columns": [
                                {
                                    "name": c.name,
                                    "data_type": c.data_type,
                                    "description": c.description or "",
                                    **({"tags": c.tags} if c.tags else {}),
                                }
                                for c in t.columns
                            ],
                            **({"tags": t.tags} if t.tags else {}),
                        }
                        tables_data.append(table_entry)

                    yml_path = schema_dir / "tables.yml"
                    yml_path.write_text(
                        yaml.dump(
                            {
                                "service": service_name,
                                "database": db_name,
                                "schema": schema_name,
                                "tables": tables_data,
                            },
                            default_flow_style=False,
                            sort_keys=False,
                            allow_unicode=True,
                        )
                    )

                    total_tables += len(schema_tables)
                    console.print(f"  [green]\u2713[/green] {db_name}.{schema_name}: {len(schema_tables)} tables")

        # Fetch all data for governance snapshot
        all_tables: list[OMTable] = []
        for service_name in items:
            all_tables.extend(client.list_tables(service_name))

        glossary_terms = client.list_glossary_terms()
        console.print(f"  [green]\u2713[/green] Glossary: {len(glossary_terms)} terms")

        # Fetch lineage for each table
        lineage_edges: list[OMLineageEdge] = []
        for t in all_tables:
            edges = client.get_table_lineage(t.fqn)
            lineage_edges.extend(edges)
        # Deduplicate edges
        seen_edges: set[tuple[str, str]] = set()
        unique_edges: list[OMLineageEdge] = []
        for e in lineage_edges:
            key = (e.from_fqn, e.to_fqn)
            if key not in seen_edges:
                seen_edges.add(key)
                unique_edges.append(e)
        lineage_edges = unique_edges
        console.print(f"  [green]\u2713[/green] Lineage: {len(lineage_edges)} edges")

        # Write governance snapshot
        snapshot = _build_snapshot(all_tables, glossary_terms, lineage_edges, client.base_url)
        snapshot_path = output_path / "snapshot.json"
        snapshot_path.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False))
        console.print(f"\n[green]\u2713[/green] Governance snapshot: {snapshot_path}")

        # Generate policy.yml from OMD tags
        if project_path:
            policy_path = project_path / "policies" / "policy.yml"
            generated = _generate_policy_from_snapshot(snapshot, policy_path)
            if generated:
                console.print(f"[green]\u2713[/green] Policy generated: {policy_path}")

        summary = f"{total_tables} tables from {total_services} service(s)"
        return SyncResult(
            provider_name=self.name,
            items_synced=total_tables,
            details={"services": total_services, "tables": total_tables},
            summary=summary,
        )


def _build_snapshot(
    tables: list[OMTable],
    glossary_terms: list[OMGlossaryTerm],
    lineage_edges: list[OMLineageEdge],
    base_url: str,
) -> dict:
    """Build the V2 governance snapshot from OM data."""
    tables_dict: dict[str, Any] = {}

    for t in tables:
        # Detect PII columns
        pii_columns = [c.name for c in t.columns if any("PII" in tag or "Sensitive" in tag for tag in c.tags)]

        tables_dict[t.fqn] = {
            "name": t.name,
            "schema": t.schema_name,
            "database": t.database,
            "service": t.service,
            "description": t.description or "",
            "owners": [{"name": o.name, "type": o.type} for o in t.owners],
            "tags": t.tags,
            "pii": {
                "contains_pii": len(pii_columns) > 0,
                "columns": pii_columns,
            },
            "columns": {
                c.name: {
                    "data_type": c.data_type,
                    "description": c.description or "",
                    "tags": c.tags,
                }
                for c in t.columns
            },
        }

    # Glossary
    glossary_dict: dict[str, Any] = {}
    for term in glossary_terms:
        glossary_dict[term.fqn] = {
            "name": term.name,
            "glossary": term.glossary,
            "description": term.description,
            "synonyms": term.synonyms,
            "related_terms": term.related_terms,
        }

    # Lineage
    lineage_list = [{"from": e.from_fqn, "to": e.to_fqn, "type": e.type} for e in lineage_edges]

    return {
        "version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {"type": "openmetadata", "base_url": base_url},
        "tables": tables_dict,
        "glossary": glossary_dict,
        "lineage": lineage_list,
    }


def _generate_policy_from_snapshot(snapshot: dict, policy_path: Path) -> bool:
    """Generate or update policy.yml from OMD governance snapshot.

    PII columns are derived from OMD PII tags. Execution defaults are
    preserved if policy.yml already exists, or set to sensible defaults.

    Returns True if a policy was written.
    """
    # Collect PII columns from snapshot: { "schema.table": [col1, col2] }
    pii_columns: dict[str, list[str]] = {}
    pii_tags_seen: set[str] = set()

    for fqn, table_data in snapshot.get("tables", {}).items():
        pii_cols = table_data.get("pii", {}).get("columns", [])
        if not pii_cols:
            continue

        schema = table_data.get("schema", "")
        name = table_data.get("name", "")
        table_key = f"{schema}.{name}" if schema else name
        pii_columns[table_key] = sorted(pii_cols)

        # Collect PII tag names for the tags list
        for col_name, col_info in table_data.get("columns", {}).items():
            if col_name in pii_cols:
                for tag in col_info.get("tags", []):
                    prefix = tag.split(".")[0]
                    pii_tags_seen.add(prefix)

    # Load existing policy to preserve execution settings
    existing: dict[str, Any] = {}
    if policy_path.exists():
        try:
            existing = yaml.safe_load(policy_path.read_text()) or {}
        except Exception:
            pass

    # Build policy: merge OMD-derived PII with existing execution settings
    policy: dict[str, Any] = {
        "version": 1,
        "# NOTE": "PII columns auto-generated from catalog tags. Do not edit manually.",
        "defaults": existing.get(
            "defaults",
            {
                "max_rows": 200,
                "max_preview_rows": 20,
                "require_limit_for_raw_rows": True,
                "require_time_filter_for_fact_tables": True,
                "time_filter_max_days_default": 90,
            },
        ),
        "pii": {
            "mode": existing.get("pii", {}).get("mode", "block"),
            "tags": sorted(pii_tags_seen) if pii_tags_seen else ["PII", "Sensitive"],
            "columns": pii_columns,
        },
        "certification": existing.get(
            "certification",
            {
                "prefer": "certified",
                "require_for_execute_sql": False,
                "require_for_query_metrics": False,
            },
        ),
        "joins": existing.get(
            "joins",
            {
                "enforce_bundle_allowlist": True,
                "allow_cross_bundle": False,
            },
        ),
        "execution": existing.get(
            "execution",
            {
                "allow_execute_sql": True,
                "allow_query_metrics": True,
                "require_contract": False,
                "require_bundle": True,
                "sql_validation": {
                    "mode": "parse",
                    "disallow_multi_statement": True,
                    "enforce_limit": True,
                },
            },
        ),
    }

    # Remove the NOTE key before writing (yaml doesn't support comment-only keys well)
    note = policy.pop("# NOTE")

    policy_path.parent.mkdir(parents=True, exist_ok=True)
    content = f"# {note}\n" + yaml.dump(policy, default_flow_style=False, sort_keys=False, allow_unicode=True)
    policy_path.write_text(content)

    return True

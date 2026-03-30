"""OpenMetadata sync provider — pulls table/column metadata from OM into local YAML."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml

from dazense_core.config import DazenseConfig
from dazense_core.ui import create_console

from ..base import SyncProvider, SyncResult
from .client import OpenMetadataClient

console = create_console()


def _get_client(config: DazenseConfig) -> OpenMetadataClient:
    """Build an OM client from config or env vars."""
    om = config.openmetadata
    if om:
        url = om.url
        email = om.email
        password = om.password
    else:
        url = os.environ.get("OPENMETADATA_URL", "http://localhost:8585")
        email = os.environ.get("OPENMETADATA_EMAIL", "admin@open-metadata.org")
        password = os.environ.get("OPENMETADATA_PASSWORD", "admin")
    return OpenMetadataClient(url, email, password)


class OpenMetadataSyncProvider(SyncProvider):
    """Provider that syncs metadata from OpenMetadata into local YAML files.

    Fetches table schemas, column metadata, tags, and descriptions from
    the OpenMetadata API and writes them to openmetadata/<service>/<db>/<schema>/tables.yml.

    If openmetadata.services is set in dazense_config.yaml, only those services
    are synced. Otherwise, all services are discovered from the OM API.
    """

    @property
    def name(self) -> str:
        return "OpenMetadata"

    @property
    def emoji(self) -> str:
        return "\U0001f50d"

    @property
    def default_output_dir(self) -> str:
        return "openmetadata"

    def get_items(self, config: DazenseConfig) -> list[Any]:
        """Return list of OM service names to sync.

        If config.openmetadata.services is set, use that list.
        Otherwise, discover all services from the OM API.
        """
        try:
            client = _get_client(config)
            if not client.health_check():
                return []

            # Use configured services if specified
            om = config.openmetadata
            if om and om.services:
                return list(om.services)

            # Otherwise discover all services
            services = client.list_database_services()
            return [s["name"] for s in services]
        except Exception:
            return []

    def should_sync(self, config: DazenseConfig) -> bool:
        """Check if OM is configured or reachable."""
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

        summary = f"{total_tables} tables from {total_services} service(s)"
        return SyncResult(
            provider_name=self.name,
            items_synced=total_tables,
            details={"services": total_services, "tables": total_tables},
            summary=summary,
        )

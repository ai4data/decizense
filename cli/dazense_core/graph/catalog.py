"""Catalog enrichment: abstract provider interface + data types.

Any external metadata catalog (OpenMetadata, Unity Catalog, Atlan, Collibra, …)
can enrich the governance graph by implementing CatalogEnrichmentProvider.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class CatalogColumn:
    """A column discovered by an external catalog."""

    schema_name: str
    table_name: str
    column_name: str
    data_type: str = "unknown"
    description: str = ""
    tags: list[str] = field(default_factory=list)


@dataclass
class CatalogTable:
    """A table discovered by an external catalog."""

    schema_name: str
    table_name: str
    description: str = ""
    fqn: str = ""
    table_type: str = ""
    columns: list[CatalogColumn] = field(default_factory=list)


@dataclass
class CatalogDiscovery:
    """Output of a single catalog service discovery."""

    service_name: str
    tables: list[CatalogTable] = field(default_factory=list)


class CatalogEnrichmentProvider(ABC):
    """Abstract base for catalog enrichment providers.

    Implement this to plug any metadata catalog into dazense graph enrichment.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable provider name (e.g. 'OpenMetadata', 'Unity Catalog')."""
        ...

    @property
    def tag_mappings(self) -> dict[str, str]:
        """Map catalog tag prefixes → governance classification names.

        Override to customize. Default maps common PII-related tags.
        """
        return {"PII": "PII", "Sensitive": "PII", "PersonalData": "PII"}

    @abstractmethod
    def discover(self, path: Path) -> list[CatalogDiscovery]:
        """Read catalog data and return standardized discoveries.

        Args:
            path: Root path to read catalog data from (e.g. openmetadata/ dir).

        Returns:
            List of CatalogDiscovery, one per service/source.
        """
        ...


class OpenMetadataCatalogProvider(CatalogEnrichmentProvider):
    """Reads OpenMetadata sync output (tables.yml files) into CatalogDiscovery."""

    def __init__(self, tag_mappings_override: dict[str, str] | None = None) -> None:
        self._tag_mappings_override = tag_mappings_override

    @property
    def name(self) -> str:
        return "OpenMetadata"

    @property
    def tag_mappings(self) -> dict[str, str]:
        if self._tag_mappings_override is not None:
            return self._tag_mappings_override
        return super().tag_mappings

    def discover(self, path: Path) -> list[CatalogDiscovery]:
        import yaml

        if not path.exists():
            return []

        # Group tables by service
        services: dict[str, CatalogDiscovery] = {}

        for tables_yml in sorted(path.rglob("tables.yml")):
            try:
                data = yaml.safe_load(tables_yml.read_text())
            except Exception:
                continue

            if not data or "tables" not in data:
                continue

            service = data.get("service", "unknown")
            schema_name = data.get("schema", "")

            if service not in services:
                services[service] = CatalogDiscovery(service_name=service)

            for table_data in data["tables"]:
                columns = [
                    CatalogColumn(
                        schema_name=schema_name,
                        table_name=table_data["name"],
                        column_name=col["name"],
                        data_type=col.get("data_type", "unknown"),
                        description=col.get("description", ""),
                        tags=col.get("tags", []),
                    )
                    for col in table_data.get("columns", [])
                ]

                services[service].tables.append(
                    CatalogTable(
                        schema_name=schema_name,
                        table_name=table_data["name"],
                        description=table_data.get("description", ""),
                        fqn=table_data.get("fqn", ""),
                        table_type=table_data.get("table_type", ""),
                        columns=columns,
                    )
                )

        return list(services.values())

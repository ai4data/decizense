"""Tests for catalog graph enrichment (OpenMetadata + generic provider interface)."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from dazense_core.graph.catalog import (
    CatalogColumn,
    CatalogDiscovery,
    CatalogEnrichmentProvider,
    CatalogTable,
    OpenMetadataCatalogProvider,
)
from dazense_core.graph.governance_graph import GovernanceGraph
from dazense_core.graph.types import EdgeType, NodeType


@pytest.fixture
def enriched_graph(tmp_path: Path) -> tuple[GovernanceGraph, list[str]]:
    """Create a graph from fixture, sync OM data, and enrich."""
    # ── Build minimal project ──
    datasets_dir = tmp_path / "datasets" / "jaffle_shop"
    datasets_dir.mkdir(parents=True)
    (datasets_dir / "dataset.yaml").write_text(
        yaml.dump(
            {
                "version": 1,
                "bundle_id": "jaffle_shop",
                "display_name": "Jaffle Shop",
                "warehouse": {"type": "duckdb", "database_id": "duckdb-js"},
                "tables": [
                    {"schema": "main", "table": "orders"},
                    {"schema": "main", "table": "customers"},
                ],
                "joins": [
                    {
                        "left": {"schema": "main", "table": "orders", "column": "customer_id"},
                        "right": {"schema": "main", "table": "customers", "column": "customer_id"},
                        "type": "many_to_one",
                    },
                ],
                "defaults": {"max_rows": 200},
                "certification": {"level": "certified"},
            }
        )
    )

    sem_dir = tmp_path / "semantics"
    sem_dir.mkdir()
    (sem_dir / "semantic_model.yml").write_text(
        yaml.dump(
            {
                "models": {
                    "orders": {
                        "table": "orders",
                        "schema": "main",
                        "primary_key": "order_id",
                        "dimensions": {"order_id": {"column": "order_id"}, "status": {"column": "status"}},
                        "measures": {
                            "order_count": {"type": "count"},
                            "total_revenue": {"type": "sum", "column": "amount"},
                        },
                    },
                },
            }
        )
    )

    (sem_dir / "business_rules.yml").write_text(yaml.dump({"rules": [], "classifications": []}))

    policies_dir = tmp_path / "policies"
    policies_dir.mkdir()
    (policies_dir / "policy.yml").write_text(
        yaml.dump(
            {
                "version": 1,
                "defaults": {"max_rows": 200},
                "pii": {"mode": "block", "tags": ["PII"], "columns": {}},
                "execution": {"require_contract": False, "require_bundle": True},
            }
        )
    )

    # ── Create OM sync output ──
    om_dir = tmp_path / "openmetadata" / "jaffle_shop_postgres" / "jaffle_shop" / "main"
    om_dir.mkdir(parents=True)
    (om_dir / "tables.yml").write_text(
        yaml.dump(
            {
                "service": "jaffle_shop_postgres",
                "database": "jaffle_shop",
                "schema": "main",
                "tables": [
                    {
                        "name": "orders",
                        "fqn": "jaffle_shop_postgres.jaffle_shop.main.orders",
                        "table_type": "Regular",
                        "description": "Customer orders from the Jaffle Shop",
                        "columns": [
                            {"name": "order_id", "data_type": "INT", "description": "Primary key"},
                            {"name": "status", "data_type": "VARCHAR", "description": "Order status"},
                            {"name": "amount", "data_type": "DOUBLE", "description": "Total amount"},
                            {"name": "order_date", "data_type": "DATE", "description": "Date placed"},
                            {
                                "name": "shipping_address",
                                "data_type": "VARCHAR",
                                "description": "Shipping address (PII)",
                            },
                        ],
                    },
                    {
                        "name": "customers",
                        "fqn": "jaffle_shop_postgres.jaffle_shop.main.customers",
                        "table_type": "Regular",
                        "description": "Customer master data",
                        "columns": [
                            {"name": "customer_id", "data_type": "INT", "description": "Primary key"},
                            {"name": "email", "data_type": "VARCHAR", "description": "Customer email", "tags": ["PII"]},
                            {
                                "name": "phone",
                                "data_type": "VARCHAR",
                                "description": "Phone number",
                                "tags": ["PII.Phone"],
                            },
                        ],
                    },
                ],
            }
        )
    )

    # Compile + enrich
    g = GovernanceGraph.compile(tmp_path)
    actions = g.enrich_from_openmetadata(tmp_path / "openmetadata")
    return g, actions


class TestOMEnrichment:
    def test_enrichment_returns_actions(self, enriched_graph: tuple[GovernanceGraph, list[str]]):
        _, actions = enriched_graph
        assert len(actions) > 0

    def test_table_gets_om_description(self, enriched_graph: tuple[GovernanceGraph, list[str]]):
        g, _ = enriched_graph
        orders = g.get_node("table:duckdb-js/main.orders")
        assert orders is not None
        assert orders.properties.get("om_description") == "Customer orders from the Jaffle Shop"
        assert orders.properties.get("om_fqn") == "jaffle_shop_postgres.jaffle_shop.main.orders"

    def test_column_data_type_enriched(self, enriched_graph: tuple[GovernanceGraph, list[str]]):
        g, _ = enriched_graph
        col = g.get_node("column:duckdb-js/main.orders/order_id")
        assert col is not None
        assert col.properties["data_type"] == "INT"

    def test_column_gets_om_description(self, enriched_graph: tuple[GovernanceGraph, list[str]]):
        g, _ = enriched_graph
        col = g.get_node("column:duckdb-js/main.orders/amount")
        assert col is not None
        assert col.properties.get("om_description") == "Total amount"

    def test_discovered_column_created(self, enriched_graph: tuple[GovernanceGraph, list[str]]):
        """OM found shipping_address which isn't in YAML — should be discovered."""
        g, actions = enriched_graph
        col = g.get_node("column:duckdb-js/main.orders/shipping_address")
        assert col is not None
        assert col.type == NodeType.Column
        assert col.properties["data_type"] == "VARCHAR"
        assert col.properties.get("source") == "openmetadata"

    def test_discovered_column_has_discovered_by_edge(self, enriched_graph: tuple[GovernanceGraph, list[str]]):
        g, _ = enriched_graph
        col_id = "column:duckdb-js/main.orders/shipping_address"
        edges = [e for e in g._edges if e.from_ == col_id and e.type == EdgeType.DISCOVERED_BY]
        assert len(edges) == 1
        assert edges[0].to == "om:jaffle_shop_postgres"

    def test_om_tags_preserved(self, enriched_graph: tuple[GovernanceGraph, list[str]]):
        """OM column tags should be stored as om_tags."""
        g, _ = enriched_graph
        # email column from customers with PII tag
        col = g.get_node("column:duckdb-js/main.customers/email")
        if col:
            assert "PII" in col.properties.get("om_tags", [])

    def test_table_discovered_by_edge(self, enriched_graph: tuple[GovernanceGraph, list[str]]):
        g, _ = enriched_graph
        edges = [e for e in g._edges if e.from_ == "table:duckdb-js/main.orders" and e.type == EdgeType.DISCOVERED_BY]
        assert len(edges) == 1

    def test_no_enrichment_without_om_dir(self, tmp_path: Path):
        """If no openmetadata/ dir exists, enrichment is a no-op."""
        g = GovernanceGraph()
        actions = g.enrich_from_openmetadata(tmp_path / "nonexistent")
        assert actions == []

    def test_enrichment_preserves_existing_properties(self, enriched_graph: tuple[GovernanceGraph, list[str]]):
        """Enrichment shouldn't overwrite governance-declared properties."""
        g, _ = enriched_graph
        orders_table = g.get_node("table:duckdb-js/main.orders")
        assert orders_table is not None
        # Original properties still intact
        assert orders_table.properties["schema"] == "main"
        assert orders_table.properties["table"] == "orders"
        assert orders_table.properties["database_type"] == "duckdb"

    def test_om_tags_create_classifies_edges(self, enriched_graph: tuple[GovernanceGraph, list[str]]):
        """Column with PII tag should get a CLASSIFIES edge from class:PII."""
        g, _ = enriched_graph
        col_id = "column:duckdb-js/main.customers/email"
        classifies_edges = [e for e in g._edges if e.to == col_id and e.type == EdgeType.CLASSIFIES]
        assert len(classifies_edges) >= 1
        assert any(e.from_ == "class:PII" for e in classifies_edges)

    def test_om_pii_tag_flagged_as_gap(self, enriched_graph: tuple[GovernanceGraph, list[str]]):
        """OM-tagged PII column without BLOCKS edge should appear in gaps."""
        g, _ = enriched_graph
        # email is tagged PII by OM but not blocked by policy
        unblocked = g.find_unblocked_pii_columns()
        unblocked_ids = [n.id for n in unblocked]
        assert "column:duckdb-js/main.customers/email" in unblocked_ids

    def test_om_pii_tag_not_gap_when_blocked(self, tmp_path: Path):
        """OM-tagged PII column WITH BLOCKS edge should NOT appear in gaps."""
        # Build project with policy that blocks the email column
        datasets_dir = tmp_path / "datasets" / "jaffle_shop"
        datasets_dir.mkdir(parents=True)
        (datasets_dir / "dataset.yaml").write_text(
            yaml.dump(
                {
                    "version": 1,
                    "bundle_id": "jaffle_shop",
                    "display_name": "Jaffle Shop",
                    "warehouse": {"type": "duckdb", "database_id": "duckdb-js"},
                    "tables": [
                        {"schema": "main", "table": "customers"},
                    ],
                    "defaults": {"max_rows": 200},
                }
            )
        )

        sem_dir = tmp_path / "semantics"
        sem_dir.mkdir()
        (sem_dir / "semantic_model.yml").write_text(yaml.dump({"models": {}}))
        (sem_dir / "business_rules.yml").write_text(
            yaml.dump({"rules": [], "classifications": [{"name": "PII", "description": "PII", "tags": ["PII"]}]})
        )

        policies_dir = tmp_path / "policies"
        policies_dir.mkdir()
        (policies_dir / "policy.yml").write_text(
            yaml.dump(
                {
                    "version": 1,
                    "defaults": {"max_rows": 200},
                    "pii": {
                        "mode": "block",
                        "tags": ["PII"],
                        "columns": {"customers": ["email"]},
                    },
                    "execution": {"require_contract": False},
                }
            )
        )

        om_dir = tmp_path / "openmetadata" / "svc" / "db" / "main"
        om_dir.mkdir(parents=True)
        (om_dir / "tables.yml").write_text(
            yaml.dump(
                {
                    "service": "svc",
                    "database": "db",
                    "schema": "main",
                    "tables": [
                        {
                            "name": "customers",
                            "fqn": "svc.db.main.customers",
                            "columns": [
                                {"name": "email", "data_type": "VARCHAR", "tags": ["PII"]},
                            ],
                        }
                    ],
                }
            )
        )

        g = GovernanceGraph.compile(tmp_path)
        g.enrich_from_openmetadata(tmp_path / "openmetadata")
        unblocked = g.find_unblocked_pii_columns()
        unblocked_ids = [n.id for n in unblocked]
        assert "column:duckdb-js/main.customers/email" not in unblocked_ids

    def test_om_tag_mapping_custom(self, tmp_path: Path):
        """Custom tag_mappings should resolve 'Sensitive' → 'PII'."""
        datasets_dir = tmp_path / "datasets" / "shop"
        datasets_dir.mkdir(parents=True)
        (datasets_dir / "dataset.yaml").write_text(
            yaml.dump(
                {
                    "version": 1,
                    "bundle_id": "shop",
                    "display_name": "Shop",
                    "warehouse": {"type": "duckdb", "database_id": "db1"},
                    "tables": [{"schema": "public", "table": "users"}],
                }
            )
        )
        sem_dir = tmp_path / "semantics"
        sem_dir.mkdir()
        (sem_dir / "semantic_model.yml").write_text(yaml.dump({"models": {}}))
        (sem_dir / "business_rules.yml").write_text(yaml.dump({"rules": [], "classifications": []}))
        (tmp_path / "policies").mkdir()
        (tmp_path / "policies" / "policy.yml").write_text(yaml.dump({"version": 1, "defaults": {"max_rows": 100}}))

        om_dir = tmp_path / "openmetadata" / "svc" / "db" / "public"
        om_dir.mkdir(parents=True)
        (om_dir / "tables.yml").write_text(
            yaml.dump(
                {
                    "service": "svc",
                    "database": "db",
                    "schema": "public",
                    "tables": [
                        {
                            "name": "users",
                            "fqn": "svc.db.public.users",
                            "columns": [
                                {"name": "ssn", "data_type": "VARCHAR", "tags": ["Sensitive"]},
                            ],
                        }
                    ],
                }
            )
        )

        g = GovernanceGraph.compile(tmp_path)
        g.enrich_from_openmetadata(
            tmp_path / "openmetadata",
            tag_mappings={"Sensitive": "PII"},
        )

        col_id = "column:db1/public.users/ssn"
        classifies = [e for e in g._edges if e.to == col_id and e.type == EdgeType.CLASSIFIES]
        assert len(classifies) == 1
        assert classifies[0].from_ == "class:PII"

    def test_om_tag_dotted_format(self, enriched_graph: tuple[GovernanceGraph, list[str]]):
        """Dotted tag 'PII.Phone' should map to class:PII via prefix matching."""
        g, _ = enriched_graph
        # phone column has tag "PII.Phone" — prefix "PII" should match
        col_id = "column:duckdb-js/main.customers/phone"
        col = g.get_node(col_id)
        assert col is not None
        assert "PII.Phone" in col.properties.get("om_tags", [])
        classifies = [e for e in g._edges if e.to == col_id and e.type == EdgeType.CLASSIFIES]
        assert len(classifies) >= 1
        assert any(e.from_ == "class:PII" for e in classifies)


# ── Generic catalog provider interface tests ──


class _FakeCatalogProvider(CatalogEnrichmentProvider):
    """Minimal custom catalog provider for testing."""

    @property
    def name(self) -> str:
        return "FakeCatalog"

    @property
    def tag_mappings(self) -> dict[str, str]:
        return {"Confidential": "PII", "Financial": "Financial"}

    def discover(self, path: Path) -> list[CatalogDiscovery]:
        return [
            CatalogDiscovery(
                service_name="fake_service",
                tables=[
                    CatalogTable(
                        schema_name="main",
                        table_name="orders",
                        description="Orders from fake catalog",
                        fqn="fake.main.orders",
                        columns=[
                            CatalogColumn(
                                schema_name="main",
                                table_name="orders",
                                column_name="order_id",
                                data_type="INT",
                            ),
                            CatalogColumn(
                                schema_name="main",
                                table_name="orders",
                                column_name="credit_card",
                                data_type="VARCHAR",
                                tags=["Confidential"],
                            ),
                        ],
                    ),
                ],
            )
        ]


@pytest.fixture
def graph_with_custom_catalog(tmp_path: Path) -> tuple[GovernanceGraph, list[str]]:
    """Build a graph and enrich with a custom (non-OM) catalog provider."""
    datasets_dir = tmp_path / "datasets" / "shop"
    datasets_dir.mkdir(parents=True)
    (datasets_dir / "dataset.yaml").write_text(
        yaml.dump(
            {
                "version": 1,
                "bundle_id": "shop",
                "display_name": "Shop",
                "warehouse": {"type": "duckdb", "database_id": "duckdb-js"},
                "tables": [{"schema": "main", "table": "orders"}],
            }
        )
    )
    sem_dir = tmp_path / "semantics"
    sem_dir.mkdir()
    (sem_dir / "semantic_model.yml").write_text(yaml.dump({"models": {}}))
    (sem_dir / "business_rules.yml").write_text(yaml.dump({"rules": [], "classifications": []}))
    (tmp_path / "policies").mkdir()
    (tmp_path / "policies" / "policy.yml").write_text(yaml.dump({"version": 1, "defaults": {"max_rows": 100}}))

    g = GovernanceGraph.compile(tmp_path)
    provider = _FakeCatalogProvider()
    actions = g.enrich_from_catalog(provider, tmp_path)  # path unused by fake provider
    return g, actions


class TestGenericCatalogProvider:
    def test_custom_provider_enriches_table(self, graph_with_custom_catalog: tuple[GovernanceGraph, list[str]]):
        g, actions = graph_with_custom_catalog
        assert any("enriched table" in a for a in actions)

    def test_custom_provider_creates_service_node(self, graph_with_custom_catalog: tuple[GovernanceGraph, list[str]]):
        g, _ = graph_with_custom_catalog
        service_node = g.get_node("om:fake_service")
        assert service_node is not None
        assert service_node.properties["source"] == "fakecatalog"
        assert "FakeCatalog" in service_node.properties["display_name"]

    def test_custom_provider_creates_classifies_edge(
        self, graph_with_custom_catalog: tuple[GovernanceGraph, list[str]]
    ):
        """Confidential tag maps to PII via custom provider tag_mappings."""
        g, _ = graph_with_custom_catalog
        col_id = "column:duckdb-js/main.orders/credit_card"
        col = g.get_node(col_id)
        assert col is not None
        classifies = [e for e in g._edges if e.to == col_id and e.type == EdgeType.CLASSIFIES]
        assert len(classifies) == 1
        assert classifies[0].from_ == "class:PII"

    def test_custom_provider_classification_has_source(
        self, graph_with_custom_catalog: tuple[GovernanceGraph, list[str]]
    ):
        g, _ = graph_with_custom_catalog
        pii_node = g.get_node("class:PII")
        assert pii_node is not None
        assert pii_node.properties["source"] == "fakecatalog"

    def test_custom_provider_pii_shows_in_gaps(self, graph_with_custom_catalog: tuple[GovernanceGraph, list[str]]):
        """PII discovered by custom provider should appear in unblocked PII gaps."""
        g, _ = graph_with_custom_catalog
        unblocked = g.find_unblocked_pii_columns()
        unblocked_ids = [n.id for n in unblocked]
        assert "column:duckdb-js/main.orders/credit_card" in unblocked_ids

    def test_om_provider_via_enrich_from_catalog(self, tmp_path: Path):
        """OpenMetadataCatalogProvider works through the generic enrich_from_catalog path."""
        datasets_dir = tmp_path / "datasets" / "shop"
        datasets_dir.mkdir(parents=True)
        (datasets_dir / "dataset.yaml").write_text(
            yaml.dump(
                {
                    "version": 1,
                    "bundle_id": "shop",
                    "display_name": "Shop",
                    "warehouse": {"type": "duckdb", "database_id": "db1"},
                    "tables": [{"schema": "public", "table": "users"}],
                }
            )
        )
        sem_dir = tmp_path / "semantics"
        sem_dir.mkdir()
        (sem_dir / "semantic_model.yml").write_text(yaml.dump({"models": {}}))
        (sem_dir / "business_rules.yml").write_text(yaml.dump({"rules": [], "classifications": []}))
        (tmp_path / "policies").mkdir()
        (tmp_path / "policies" / "policy.yml").write_text(yaml.dump({"version": 1, "defaults": {"max_rows": 100}}))

        om_dir = tmp_path / "openmetadata" / "svc" / "db" / "public"
        om_dir.mkdir(parents=True)
        (om_dir / "tables.yml").write_text(
            yaml.dump(
                {
                    "service": "svc",
                    "database": "db",
                    "schema": "public",
                    "tables": [
                        {
                            "name": "users",
                            "fqn": "svc.db.public.users",
                            "columns": [
                                {"name": "email", "data_type": "VARCHAR", "tags": ["PII"]},
                            ],
                        }
                    ],
                }
            )
        )

        g = GovernanceGraph.compile(tmp_path)
        provider = OpenMetadataCatalogProvider()
        actions = g.enrich_from_catalog(provider, tmp_path / "openmetadata")

        assert any("discovered column" in a for a in actions)
        col = g.get_node("column:db1/public.users/email")
        assert col is not None
        classifies = [e for e in g._edges if e.to == col.id and e.type == EdgeType.CLASSIFIES]
        assert any(e.from_ == "class:PII" for e in classifies)

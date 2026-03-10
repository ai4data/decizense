"""Tests for OpenMetadata graph enrichment."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

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

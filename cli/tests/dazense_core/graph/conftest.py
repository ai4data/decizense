"""
Shared fixtures for governance graph tests.
Creates a minimal but realistic project fixture based on the jaffle_shop example.
"""

from pathlib import Path

import pytest
import yaml


@pytest.fixture
def project_path(tmp_path: Path) -> Path:
    """Create a minimal jaffle_shop project with all YAML files."""

    # ── datasets/jaffle_shop/dataset.yaml ──
    datasets_dir = tmp_path / "datasets" / "jaffle_shop"
    datasets_dir.mkdir(parents=True)
    (datasets_dir / "dataset.yaml").write_text(
        yaml.dump(
            {
                "version": 1,
                "bundle_id": "jaffle_shop",
                "display_name": "Jaffle Shop — Core Analytics",
                "owners": [{"name": "Data Team"}],
                "warehouse": {"type": "duckdb", "database_id": "duckdb-jaffle-shop"},
                "tables": [
                    {"schema": "main", "table": "customers"},
                    {"schema": "main", "table": "orders"},
                    {"schema": "main", "table": "stg_payments"},
                ],
                "joins": [
                    {
                        "left": {"schema": "main", "table": "orders", "column": "customer_id"},
                        "right": {"schema": "main", "table": "customers", "column": "customer_id"},
                        "type": "many_to_one",
                    },
                    {
                        "left": {"schema": "main", "table": "stg_payments", "column": "order_id"},
                        "right": {"schema": "main", "table": "orders", "column": "order_id"},
                        "type": "many_to_one",
                    },
                ],
                "defaults": {
                    "require_time_filter_for_tables": ["main.orders"],
                    "max_rows": 200,
                },
                "certification": {"level": "certified"},
            }
        )
    )

    # ── semantics/semantic_model.yml ──
    semantics_dir = tmp_path / "semantics"
    semantics_dir.mkdir()
    (semantics_dir / "semantic_model.yml").write_text(
        yaml.dump(
            {
                "models": {
                    "customers": {
                        "table": "customers",
                        "schema": "main",
                        "primary_key": "customer_id",
                        "dimensions": {
                            "customer_id": {"column": "customer_id"},
                            "first_name": {"column": "first_name", "description": "PII"},
                            "last_name": {"column": "last_name", "description": "PII"},
                        },
                        "measures": {
                            "customer_count": {"type": "count"},
                            "total_lifetime_value": {"type": "sum", "column": "customer_lifetime_value"},
                            "avg_lifetime_value": {"type": "avg", "column": "customer_lifetime_value"},
                        },
                    },
                    "orders": {
                        "table": "orders",
                        "schema": "main",
                        "primary_key": "order_id",
                        "time_dimension": "order_date",
                        "dimensions": {
                            "order_id": {"column": "order_id"},
                            "order_date": {"column": "order_date"},
                            "status": {"column": "status"},
                            "customer_id": {"column": "customer_id"},
                        },
                        "measures": {
                            "order_count": {"type": "count"},
                            "total_revenue": {
                                "type": "sum",
                                "column": "amount",
                                "filters": [
                                    {"column": "status", "operator": "not_in", "value": ["returned", "return_pending"]},
                                ],
                            },
                            "avg_order_value": {"type": "avg", "column": "amount"},
                        },
                        "joins": {
                            "customer": {
                                "to_model": "customers",
                                "foreign_key": "customer_id",
                                "related_key": "customer_id",
                                "type": "many_to_one",
                            },
                        },
                    },
                    "payments": {
                        "table": "stg_payments",
                        "schema": "main",
                        "primary_key": "payment_id",
                        "dimensions": {
                            "payment_id": {"column": "payment_id"},
                            "payment_method": {"column": "payment_method"},
                        },
                        "measures": {
                            "payment_count": {"type": "count"},
                            "total_payment_amount": {"type": "sum", "column": "amount"},
                        },
                        "joins": {
                            "order": {
                                "to_model": "orders",
                                "foreign_key": "order_id",
                                "related_key": "order_id",
                                "type": "many_to_one",
                            },
                        },
                    },
                },
            }
        )
    )

    # ── semantics/business_rules.yml ──
    (semantics_dir / "business_rules.yml").write_text(
        yaml.dump(
            {
                "rules": [
                    {
                        "name": "exclude_returned_orders_from_revenue",
                        "category": "metrics",
                        "severity": "critical",
                        "applies_to": ["orders.total_revenue", "orders.avg_order_value"],
                        "description": "Revenue metrics must exclude returned orders.",
                        "guidance": "Filter WHERE status NOT IN ('returned', 'return_pending').",
                    },
                    {
                        "name": "pii_customer_names",
                        "category": "privacy",
                        "severity": "critical",
                        "applies_to": ["customers.first_name", "customers.last_name"],
                        "description": "first_name and last_name are PII.",
                        "guidance": "Never include in results unless explicitly requested.",
                    },
                    {
                        "name": "orders_require_time_filter",
                        "category": "query_patterns",
                        "severity": "warning",
                        "applies_to": ["orders"],
                        "description": "Orders table needs a time filter.",
                        "guidance": "Apply time filter on order_date.",
                    },
                ],
                "classifications": [
                    {
                        "name": "PII",
                        "description": "Personally identifiable information",
                        "tags": ["sensitive", "restricted"],
                    },
                    {
                        "name": "Financial",
                        "description": "Monetary values",
                        "tags": ["financial"],
                    },
                ],
            }
        )
    )

    # ── policies/policy.yml ──
    policies_dir = tmp_path / "policies"
    policies_dir.mkdir()
    (policies_dir / "policy.yml").write_text(
        yaml.dump(
            {
                "version": 1,
                "defaults": {"max_rows": 200},
                "pii": {
                    "mode": "block",
                    "tags": ["PII", "Sensitive"],
                    "columns": {
                        "main.customers": ["first_name", "last_name"],
                    },
                },
                "execution": {
                    "require_contract": False,
                    "require_bundle": True,
                },
            }
        )
    )

    return tmp_path

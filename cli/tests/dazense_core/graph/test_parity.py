"""
Parity test: compile the same fixture with both Python and TypeScript compilers,
then assert the toJSON() outputs match on node IDs, node types, and edge triples.

Requires both Python and Bun to be available.
Run with: pytest tests/dazense_core/graph/test_parity.py -v -m parity
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from dazense_core.graph.governance_graph import GovernanceGraph
from dazense_core.graph.types import EdgeType, NodeType

# ── Constants ──

REPO_ROOT = Path(__file__).resolve().parents[4]
TS_DUMP_SCRIPT = REPO_ROOT / "apps" / "backend" / "tests" / "graph" / "dump-graph-json.ts"

# Contract-related node/edge types (Python Phase 2 only — strip for parity)
CONTRACT_NODE_TYPES = {NodeType.Contract.value, NodeType.PolicyCheck.value}
CONTRACT_EDGE_TYPES = {
    EdgeType.TOUCHED.value,
    EdgeType.USED.value,
    EdgeType.REFERENCED.value,
    EdgeType.DECIDED.value,
    EdgeType.FAILED.value,
}

pytestmark = pytest.mark.parity


# ── Helpers ──


def _normalize_graph_json(data: dict) -> dict:
    """Sort nodes by id, edges by (from, to, type). Strip contract-related items."""
    nodes = [
        n for n in data["nodes"]
        if n["type"] not in CONTRACT_NODE_TYPES
    ]
    edges = [
        e for e in data["edges"]
        if e["type"] not in CONTRACT_EDGE_TYPES
    ]

    nodes.sort(key=lambda n: n["id"])
    edges.sort(key=lambda e: (e["from"], e["to"], e["type"]))

    return {"nodes": nodes, "edges": edges}


def _python_compile(project_path: Path) -> dict:
    """Compile with Python and return normalized JSON dict."""
    graph = GovernanceGraph.compile(project_path)
    raw = graph.to_json().model_dump(mode="json", by_alias=True)
    return _normalize_graph_json(raw)


def _ts_compile(project_path: Path) -> dict:
    """Run the TS dump script via bun and return normalized JSON dict."""
    cmd = f'bun "{TS_DUMP_SCRIPT}" "{project_path}"'
    result = subprocess.run(
        cmd,
        capture_output=True,
        timeout=30,
        cwd=str(REPO_ROOT),
        shell=True,
    )
    stdout = result.stdout.decode("utf-8", errors="replace")
    stderr = result.stderr.decode("utf-8", errors="replace")
    if result.returncode != 0:
        pytest.fail(
            f"TS dump script failed (exit {result.returncode}):\n"
            f"stdout: {stdout[:500]}\n"
            f"stderr: {stderr[:500]}"
        )
    # dotenv may print noise to stdout; find the real JSON (starts with '{\n  "nodes"')
    marker = '"nodes"'
    marker_pos = stdout.find(marker)
    if marker_pos == -1:
        pytest.fail(f"No JSON in TS output:\nstdout: {stdout[:500]}\nstderr: {stderr[:500]}")
    # Walk back to the opening brace
    json_start = stdout.rfind("{", 0, marker_pos)
    data = json.loads(stdout[json_start:])
    return _normalize_graph_json(data)


# ── Fixture ──


@pytest.fixture(scope="module")
def compiled_graphs(project_path: Path) -> tuple[dict, dict]:
    """Compile the fixture with both Python and TS, return (py_json, ts_json)."""
    py_json = _python_compile(project_path)
    ts_json = _ts_compile(project_path)
    return py_json, ts_json


@pytest.fixture(scope="module")
def project_path(tmp_path_factory) -> Path:
    """Create the shared fixture project (same as conftest.py but module-scoped)."""
    import yaml

    tmp_path = tmp_path_factory.mktemp("parity")

    # datasets/jaffle_shop/dataset.yaml
    datasets_dir = tmp_path / "datasets" / "jaffle_shop"
    datasets_dir.mkdir(parents=True)
    (datasets_dir / "dataset.yaml").write_text(
        yaml.dump(
            {
                "version": 1,
                "bundle_id": "jaffle_shop",
                "display_name": "Jaffle Shop \u2014 Core Analytics",
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

    # semantics/semantic_model.yml
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
                                    {
                                        "column": "status",
                                        "operator": "not_in",
                                        "value": ["returned", "return_pending"],
                                    },
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

    # semantics/business_rules.yml
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

    # policies/policy.yml
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


# ── Parity tests ──


class TestNodeParity:
    """Node ID and type parity between Python and TypeScript compilers."""

    def test_node_ids_match(self, compiled_graphs: tuple[dict, dict]):
        py_json, ts_json = compiled_graphs
        py_ids = {n["id"] for n in py_json["nodes"]}
        ts_ids = {n["id"] for n in ts_json["nodes"]}

        only_py = py_ids - ts_ids
        only_ts = ts_ids - py_ids

        assert py_ids == ts_ids, (
            f"Node ID mismatch.\n"
            f"  Only in Python ({len(only_py)}): {sorted(only_py)[:10]}\n"
            f"  Only in TS ({len(only_ts)}): {sorted(only_ts)[:10]}"
        )

    def test_node_types_match(self, compiled_graphs: tuple[dict, dict]):
        py_json, ts_json = compiled_graphs
        py_types = {n["id"]: n["type"] for n in py_json["nodes"]}
        ts_types = {n["id"]: n["type"] for n in ts_json["nodes"]}

        # Only compare nodes present in both
        common = set(py_types) & set(ts_types)
        mismatches = [
            (nid, py_types[nid], ts_types[nid])
            for nid in common
            if py_types[nid] != ts_types[nid]
        ]
        assert not mismatches, f"Type mismatches: {mismatches[:10]}"

    def test_node_count(self, compiled_graphs: tuple[dict, dict]):
        py_json, ts_json = compiled_graphs
        assert len(py_json["nodes"]) == len(ts_json["nodes"]), (
            f"Node count: Python={len(py_json['nodes'])}, TS={len(ts_json['nodes'])}"
        )


class TestEdgeParity:
    """Edge parity between Python and TypeScript compilers."""

    def test_edge_triples_match(self, compiled_graphs: tuple[dict, dict]):
        py_json, ts_json = compiled_graphs
        py_edges = {(e["from"], e["to"], e["type"]) for e in py_json["edges"]}
        ts_edges = {(e["from"], e["to"], e["type"]) for e in ts_json["edges"]}

        only_py = py_edges - ts_edges
        only_ts = ts_edges - py_edges

        assert py_edges == ts_edges, (
            f"Edge mismatch.\n"
            f"  Only in Python ({len(only_py)}): {sorted(only_py)[:10]}\n"
            f"  Only in TS ({len(only_ts)}): {sorted(only_ts)[:10]}"
        )

    def test_edge_count(self, compiled_graphs: tuple[dict, dict]):
        py_json, ts_json = compiled_graphs
        assert len(py_json["edges"]) == len(ts_json["edges"]), (
            f"Edge count: Python={len(py_json['edges'])}, TS={len(ts_json['edges'])}"
        )


class TestPropertyParity:
    """Compare key stable properties (not exhaustive)."""

    def test_pii_flag_matches(self, compiled_graphs: tuple[dict, dict]):
        """Columns with is_pii=True should match between compilers."""
        py_json, ts_json = compiled_graphs

        py_pii = {
            n["id"]
            for n in py_json["nodes"]
            if n["type"] == "Column" and n.get("properties", {}).get("is_pii") is True
        }
        ts_pii = {
            n["id"]
            for n in ts_json["nodes"]
            if n["type"] == "Column" and n.get("properties", {}).get("is_pii") is True
        }

        # Only compare columns that exist in both
        common_cols = {n["id"] for n in py_json["nodes"] if n["type"] == "Column"} & \
                      {n["id"] for n in ts_json["nodes"] if n["type"] == "Column"}
        py_pii_common = py_pii & common_cols
        ts_pii_common = ts_pii & common_cols

        assert py_pii_common == ts_pii_common, (
            f"PII flag mismatch.\n"
            f"  Only PII in Python: {sorted(py_pii_common - ts_pii_common)}\n"
            f"  Only PII in TS: {sorted(ts_pii_common - py_pii_common)}"
        )

    def test_policy_properties_match(self, compiled_graphs: tuple[dict, dict]):
        """The policy:root node should have matching properties."""
        py_json, ts_json = compiled_graphs

        py_policy = next((n for n in py_json["nodes"] if n["id"] == "policy:root"), None)
        ts_policy = next((n for n in ts_json["nodes"] if n["id"] == "policy:root"), None)

        assert py_policy is not None, "Python missing policy:root"
        assert ts_policy is not None, "TS missing policy:root"

        # Compare stable fields
        assert py_policy["properties"].get("pii_mode") == ts_policy["properties"].get("pii_mode")
        assert py_policy["properties"].get("max_rows") == ts_policy["properties"].get("max_rows")

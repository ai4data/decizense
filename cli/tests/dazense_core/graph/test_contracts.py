"""
Phase 2 tests: contract ingestion, decision traces, CLI routing.
"""

import json
from pathlib import Path

import pytest

from dazense_core.graph.governance_graph import GovernanceGraph
from dazense_core.graph.types import EdgeType, NodeType


@pytest.fixture
def project_with_contracts(project_path: Path) -> Path:
    """Add contract JSON files to the project fixture."""
    runs_dir = project_path / "contracts" / "runs"
    runs_dir.mkdir(parents=True)

    # Contract 1: allowed query
    (runs_dir / "2024-01-01T00-00-00Z_allow-001.json").write_text(
        json.dumps(
            {
                "version": 1,
                "contract_id": "allow-001",
                "created_at": "2024-01-01T00:00:00Z",
                "project_path": str(project_path),
                "actor": {"role": "user", "user_id": "local"},
                "request": {"user_prompt": "What is total revenue?"},
                "scope": {
                    "tables": ["main.orders"],
                    "dataset_bundles": ["jaffle_shop"],
                },
                "meaning": {
                    "metrics": [{"id": "orders.total_revenue"}],
                    "guidance_rules_referenced": ["exclude_returned_orders_from_revenue"],
                },
                "execution": {"tool": "query_metrics", "params": {}},
                "policy": {
                    "decision": "allow",
                    "checks": [
                        {"name": "bundle_required", "status": "pass", "detail": "Bundle jaffle_shop found"},
                        {"name": "pii_block", "status": "pass"},
                        {"name": "time_filter_required", "status": "warn", "detail": "No explicit time filter"},
                    ],
                },
            }
        )
    )

    # Contract 2: blocked query (PII)
    (runs_dir / "2024-01-02T00-00-00Z_block-002.json").write_text(
        json.dumps(
            {
                "version": 1,
                "contract_id": "block-002",
                "created_at": "2024-01-02T00:00:00Z",
                "project_path": str(project_path),
                "actor": {"role": "user", "user_id": "local"},
                "request": {"user_prompt": "Show me all customer names"},
                "scope": {
                    "tables": ["main.customers"],
                    "dataset_bundles": ["jaffle_shop"],
                },
                "meaning": {
                    "metrics": [],
                    "guidance_rules_referenced": ["pii_customer_names"],
                },
                "execution": {"tool": "execute_sql", "params": {"sql": "SELECT first_name FROM customers"}},
                "policy": {
                    "decision": "block",
                    "checks": [
                        {"name": "bundle_required", "status": "pass"},
                        {"name": "pii_block", "status": "fail", "detail": "Column first_name is PII"},
                    ],
                },
            }
        )
    )

    return project_path


@pytest.fixture
def graph_with_contracts(project_with_contracts: Path) -> GovernanceGraph:
    return GovernanceGraph.compile(project_with_contracts)


# ── Contract node ingestion ──


class TestContractIngestion:
    def test_contract_nodes_created(self, graph_with_contracts: GovernanceGraph):
        contracts = graph_with_contracts.get_nodes_by_type(NodeType.Contract)
        assert len(contracts) == 2

    def test_contract_has_correct_properties(self, graph_with_contracts: GovernanceGraph):
        allow = graph_with_contracts.get_node("contract:allow-001")
        assert allow is not None
        assert allow.properties["decision"] == "allow"
        assert allow.properties["actor"] == "user"
        assert allow.properties["created_at"] == "2024-01-01T00:00:00Z"

        block = graph_with_contracts.get_node("contract:block-002")
        assert block is not None
        assert block.properties["decision"] == "block"

    def test_policy_check_nodes_created(self, graph_with_contracts: GovernanceGraph):
        checks = graph_with_contracts.get_nodes_by_type(NodeType.PolicyCheck)
        # 3 checks from allow-001 + 2 checks from block-002
        assert len(checks) == 5

    def test_contract_file_hashes_tracked(self, graph_with_contracts: GovernanceGraph):
        hashes = graph_with_contracts.file_hashes
        contract_hashes = [p for p in hashes if "contracts" in p]
        assert len(contract_hashes) == 2


# ── Decision trace edges ──


class TestDecisionTraces:
    def test_decided_edges_for_pass_checks(self, graph_with_contracts: GovernanceGraph):
        """Pass and warn checks get DECIDED edges."""
        decided = graph_with_contracts.neighbors("contract:allow-001", EdgeType.DECIDED, "forward")
        assert len(decided) == 3  # bundle_required(pass), pii_block(pass), time_filter(warn)
        for node in decided:
            assert node.type == NodeType.PolicyCheck
            assert node.properties["status"] in ("pass", "warn")

    def test_failed_edges_for_fail_checks(self, graph_with_contracts: GovernanceGraph):
        """Fail checks get FAILED edges."""
        failed = graph_with_contracts.neighbors("contract:block-002", EdgeType.FAILED, "forward")
        assert len(failed) == 1
        assert failed[0].type == NodeType.PolicyCheck
        assert failed[0].properties["status"] == "fail"
        assert "PII" in failed[0].properties["detail"]

    def test_blocked_contract_has_both_decided_and_failed(self, graph_with_contracts: GovernanceGraph):
        """block-002 has 1 pass (DECIDED) + 1 fail (FAILED)."""
        decided = graph_with_contracts.neighbors("contract:block-002", EdgeType.DECIDED, "forward")
        failed = graph_with_contracts.neighbors("contract:block-002", EdgeType.FAILED, "forward")
        assert len(decided) == 1  # bundle_required pass
        assert len(failed) == 1  # pii_block fail

    def test_policy_check_id_pattern(self, graph_with_contracts: GovernanceGraph):
        """PolicyCheck IDs follow check:{contract_id}/{check_name} pattern."""
        checks = graph_with_contracts.get_nodes_by_type(NodeType.PolicyCheck)
        for check in checks:
            assert check.id.startswith("check:")
            parts = check.id.replace("check:", "").split("/")
            assert len(parts) == 2, f"Invalid check ID format: {check.id}"


# ── TOUCHED / USED / REFERENCED edges ──


class TestContractEdges:
    def test_touched_edges(self, graph_with_contracts: GovernanceGraph):
        """Contract → TOUCHED → Table for tables in scope."""
        touched = graph_with_contracts.neighbors("contract:allow-001", EdgeType.TOUCHED, "forward")
        assert len(touched) == 1
        assert touched[0].type == NodeType.Table
        assert "orders" in touched[0].id

    def test_used_edges(self, graph_with_contracts: GovernanceGraph):
        """Contract → USED → Measure for metrics referenced."""
        used = graph_with_contracts.neighbors("contract:allow-001", EdgeType.USED, "forward")
        assert len(used) == 1
        assert used[0].type == NodeType.Measure
        assert "total_revenue" in used[0].id

    def test_referenced_edges(self, graph_with_contracts: GovernanceGraph):
        """Contract → REFERENCED → Rule for guidance rules cited."""
        referenced = graph_with_contracts.neighbors("contract:allow-001", EdgeType.REFERENCED, "forward")
        assert len(referenced) == 1
        assert referenced[0].type == NodeType.Rule
        assert "exclude_returned" in referenced[0].id

    def test_block_contract_references_pii_rule(self, graph_with_contracts: GovernanceGraph):
        referenced = graph_with_contracts.neighbors("contract:block-002", EdgeType.REFERENCED, "forward")
        assert len(referenced) == 1
        assert "pii_customer_names" in referenced[0].id

    def test_block_contract_touches_customers(self, graph_with_contracts: GovernanceGraph):
        touched = graph_with_contracts.neighbors("contract:block-002", EdgeType.TOUCHED, "forward")
        assert len(touched) == 1
        assert "customers" in touched[0].id


# ── Decision trace queries ──


class TestDecisionTraceQueries:
    def test_why_was_contract_blocked(self, graph_with_contracts: GovernanceGraph):
        """Simulate the query: 'Why was contract block-002 blocked?'"""
        failed = graph_with_contracts.neighbors("contract:block-002", EdgeType.FAILED, "forward")
        assert len(failed) > 0
        reasons = [n.properties["detail"] for n in failed if n.properties.get("detail")]
        assert any("PII" in r for r in reasons)

    def test_contract_lineage_includes_full_trace(self, graph_with_contracts: GovernanceGraph):
        """Lineage from a contract should include tables, measures, rules it touched."""
        downstream = graph_with_contracts.impact_of("contract:allow-001")
        downstream_types = {n.type for n in downstream}
        # Contract is a source node — impact goes to PolicyCheck, Table, Measure, Rule
        assert NodeType.PolicyCheck in downstream_types
        assert NodeType.Table in downstream_types
        assert NodeType.Measure in downstream_types
        assert NodeType.Rule in downstream_types


# ── No contracts = no contract nodes ──


class TestNoContracts:
    def test_graph_without_contracts(self, project_path: Path):
        """Graph compiles fine without contracts/runs/ directory."""
        graph = GovernanceGraph.compile(project_path)
        contracts = graph.get_nodes_by_type(NodeType.Contract)
        checks = graph.get_nodes_by_type(NodeType.PolicyCheck)
        assert len(contracts) == 0
        assert len(checks) == 0

    def test_malformed_contract_skipped(self, project_path: Path):
        """Malformed JSON files in contracts/runs/ are skipped."""
        runs_dir = project_path / "contracts" / "runs"
        runs_dir.mkdir(parents=True)
        (runs_dir / "bad.json").write_text("not valid json {{{")
        (runs_dir / "no_id.json").write_text(json.dumps({"version": 1}))

        graph = GovernanceGraph.compile(project_path)
        contracts = graph.get_nodes_by_type(NodeType.Contract)
        assert len(contracts) == 0


# ── CLI routing ──


class TestCLIRouting:
    def test_graph_is_cyclopts_app(self):
        """graph command should be a cyclopts App (not a function)."""
        from cyclopts import App

        from dazense_core.commands.graph import graph

        assert isinstance(graph, App)

    def test_graph_app_has_subcommands(self):
        """graph App should have all expected subcommands registered."""
        from dazense_core.commands.graph import graph

        # cyclopts App stores commands internally
        # Verify by checking the command names exist
        command_names = set()
        for cmd_name, _ in graph._commands.items():
            command_names.add(cmd_name)

        expected = {"show", "lineage", "impact", "gaps", "simulate", "suggest-tests"}
        assert expected.issubset(command_names), f"Missing commands: {expected - command_names}"

    def test_main_app_has_graph(self):
        """Main app should have graph registered as a sub-app."""
        from dazense_core.main import app

        # Check that 'graph' is a registered command/sub-app
        assert "graph" in app._commands

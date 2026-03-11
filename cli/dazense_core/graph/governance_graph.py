"""
GovernanceGraph: standalone Python compiler + in-memory IR.
Reads YAML directly via existing loaders — no backend dependency.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from copy import deepcopy
from pathlib import Path

from dazense_core.graph.types import (
    EdgeType,
    GapEntry,
    GapReport,
    GraphEdge,
    GraphJSON,
    GraphNode,
    GraphStats,
    NodeType,
)
from dazense_core.rules.models import BusinessRules
from dazense_core.semantic.models import SemanticModel


class GovernanceGraph:
    def __init__(self) -> None:
        self._nodes: dict[str, GraphNode] = {}
        self._forward: dict[str, list[GraphEdge]] = defaultdict(list)
        self._reverse: dict[str, list[GraphEdge]] = defaultdict(list)
        self._edges: list[GraphEdge] = []
        self._file_hashes: dict[str, str] = {}

    # ── Mutation (used by compiler only) ──

    def _add_node(self, node: GraphNode) -> None:
        self._nodes[node.id] = node

    def _add_edge(self, edge: GraphEdge) -> None:
        self._edges.append(edge)
        self._forward[edge.from_].append(edge)
        self._reverse[edge.to].append(edge)

    # ── Compiler ──

    @classmethod
    def compile(cls, project_path: Path) -> GovernanceGraph:
        """Build a GovernanceGraph from a project folder."""
        graph = cls()
        warnings: list[str] = []

        # Track file hashes
        _hash_file(graph, project_path / "semantics" / "semantic_model.yml")
        _hash_file(graph, project_path / "semantics" / "business_rules.yml")
        _hash_file(graph, project_path / "policies" / "policy.yml")

        # ── 1. Dataset bundles ──
        bundles = _load_bundles(project_path)
        for bundle in bundles:
            bundle_id = bundle["bundle_id"]
            bundle_node_id = f"bundle:{bundle_id}"
            db_id = bundle["warehouse"]["database_id"]

            graph._add_node(
                GraphNode(
                    id=bundle_node_id,
                    type=NodeType.Bundle,
                    properties={
                        "display_name": bundle.get("display_name", bundle_id),
                        "certification": bundle.get("certification", {}).get("level", "experimental"),
                        "owners": bundle.get("owners", []),
                    },
                )
            )

            _hash_file(graph, project_path / "datasets" / bundle_id / "dataset.yaml")

            for t in bundle.get("tables", []):
                table_id = f"table:{db_id}/{t['schema']}.{t['table']}"
                graph._add_node(
                    GraphNode(
                        id=table_id,
                        type=NodeType.Table,
                        properties={
                            "schema": t["schema"],
                            "table": t["table"],
                            "database_type": bundle["warehouse"]["type"],
                            "database_id": db_id,
                        },
                    )
                )
                graph._add_edge(GraphEdge(from_=bundle_node_id, to=table_id, type=EdgeType.CONTAINS))

            # Time filter tables
            defaults = bundle.get("defaults", {}) or {}
            for table_name in defaults.get("require_time_filter_for_tables", []):
                table_id = _resolve_table_id(table_name, db_id, bundle.get("tables", []))
                if table_id:
                    graph._add_edge(GraphEdge(from_=bundle_node_id, to=table_id, type=EdgeType.REQUIRES_TIME_FILTER))

            # Joins → JoinEdge intermediary nodes
            for join_spec in bundle.get("joins", []):
                left = join_spec["left"]
                right = join_spec["right"]
                left_table_id = f"table:{db_id}/{left['schema']}.{left['table']}"
                right_table_id = f"table:{db_id}/{right['schema']}.{right['table']}"
                join_node_id = f"join:{bundle_id}/{left['schema']}.{left['table']}:{right['schema']}.{right['table']}"

                graph._add_node(
                    GraphNode(
                        id=join_node_id,
                        type=NodeType.JoinEdge,
                        properties={
                            "join_type": join_spec.get("type", "many_to_one"),
                            "description": join_spec.get("description", ""),
                            "left_column": left["column"],
                            "right_column": right["column"],
                        },
                    )
                )
                graph._add_edge(GraphEdge(from_=bundle_node_id, to=join_node_id, type=EdgeType.ALLOWS_JOIN))
                graph._add_edge(GraphEdge(from_=join_node_id, to=left_table_id, type=EdgeType.JOIN_LEFT))
                graph._add_edge(GraphEdge(from_=join_node_id, to=right_table_id, type=EdgeType.JOIN_RIGHT))

        # ── 2. Semantic models ──
        sem = SemanticModel.load(project_path)
        if sem:
            for model_name, model_def in sem.models.items():
                parent_bundle = _find_bundle_for_table(model_def.table, bundles)
                b_id = parent_bundle["bundle_id"] if parent_bundle else "_unknown"
                db_id = parent_bundle["warehouse"]["database_id"] if parent_bundle else "_unknown"

                # Deterministic model→table resolution
                if model_def.database:
                    resolved_db_id = model_def.database
                elif parent_bundle:
                    resolved_db_id = db_id
                else:
                    resolved_db_id = db_id
                    warnings.append(f"Model {model_name}: ambiguous db, defaulting to {db_id}")

                schema = model_def.schema_name
                table_id = f"table:{resolved_db_id}/{schema}.{model_def.table}"
                model_id = f"model:{b_id}/{model_name}"

                graph._add_node(
                    GraphNode(
                        id=model_id,
                        type=NodeType.Model,
                        properties={
                            "table": model_def.table,
                            "primary_key": model_def.primary_key,
                            "time_dimension": model_def.time_dimension,
                            "description": model_def.description or "",
                        },
                    )
                )

                # WRAPS → Table
                if graph.get_node(table_id):
                    graph._add_edge(GraphEdge(from_=model_id, to=table_id, type=EdgeType.WRAPS))
                else:
                    warnings.append(f"Model {model_name} references table {model_def.table} not found in any bundle")

                # Dimensions
                for dim_name, dim_def in model_def.dimensions.items():
                    dim_id = f"dim:{b_id}/{model_name}.{dim_name}"
                    col_id = f"column:{resolved_db_id}/{schema}.{model_def.table}/{dim_def.column}"

                    graph._add_node(
                        GraphNode(
                            id=dim_id,
                            type=NodeType.Dimension,
                            properties={"column": dim_def.column, "description": dim_def.description or ""},
                        )
                    )

                    if not graph.get_node(col_id):
                        graph._add_node(
                            GraphNode(
                                id=col_id,
                                type=NodeType.Column,
                                properties={"data_type": "unknown", "is_pii": False},
                            )
                        )

                    graph._add_edge(GraphEdge(from_=model_id, to=dim_id, type=EdgeType.DEFINES))
                    graph._add_edge(GraphEdge(from_=dim_id, to=col_id, type=EdgeType.READS))

                # Measures
                for measure_name, measure_def in model_def.measures.items():
                    measure_id = f"measure:{b_id}/{model_name}.{measure_name}"
                    graph._add_node(
                        GraphNode(
                            id=measure_id,
                            type=NodeType.Measure,
                            properties={
                                "type": measure_def.type.value,
                                "column": measure_def.column,
                                "description": measure_def.description or "",
                            },
                        )
                    )
                    graph._add_edge(GraphEdge(from_=model_id, to=measure_id, type=EdgeType.DEFINES))

                    # AGGREGATES → Column
                    agg_col = measure_def.column or measure_name
                    col_id = f"column:{resolved_db_id}/{schema}.{model_def.table}/{agg_col}"
                    if not graph.get_node(col_id):
                        graph._add_node(
                            GraphNode(
                                id=col_id,
                                type=NodeType.Column,
                                properties={"data_type": "unknown", "is_pii": False},
                            )
                        )
                    graph._add_edge(GraphEdge(from_=measure_id, to=col_id, type=EdgeType.AGGREGATES))

                    # FILTERS_ON edges for baked-in filters
                    for f in measure_def.filters:
                        filter_col_id = f"column:{resolved_db_id}/{schema}.{model_def.table}/{f.column}"
                        if not graph.get_node(filter_col_id):
                            graph._add_node(
                                GraphNode(
                                    id=filter_col_id,
                                    type=NodeType.Column,
                                    properties={"data_type": "unknown", "is_pii": False},
                                )
                            )
                        graph._add_edge(GraphEdge(from_=measure_id, to=filter_col_id, type=EdgeType.FILTERS_ON))

                # Joins between models
                for join_name, join_def in model_def.joins.items():
                    target_model_id = f"model:{b_id}/{join_def.to_model}"
                    graph._add_edge(GraphEdge(from_=model_id, to=target_model_id, type=EdgeType.JOINS_WITH))

        # ── 3. Business rules ──
        br = BusinessRules.load(project_path)
        if br:
            for rule in br.rules:
                rule_id = f"rule:{rule.name}"
                graph._add_node(
                    GraphNode(
                        id=rule_id,
                        type=NodeType.Rule,
                        properties={
                            "category": rule.category,
                            "severity": rule.severity,
                            "guidance": rule.guidance,
                            "description": rule.description,
                        },
                    )
                )
                for target in rule.applies_to:
                    for node_id in _find_nodes_matching(graph, target):
                        graph._add_edge(GraphEdge(from_=rule_id, to=node_id, type=EdgeType.APPLIES_TO))

            # Classifications
            for cls in br.classifications:
                class_id = f"class:{cls.name}"
                graph._add_node(
                    GraphNode(
                        id=class_id,
                        type=NodeType.Classification,
                        properties={
                            "description": cls.description,
                            "tags": cls.tags,
                        },
                    )
                )

        # ── 4. Policy ──
        policy = _load_policy(project_path)
        if policy:
            graph._add_node(
                GraphNode(
                    id="policy:root",
                    type=NodeType.Policy,
                    properties={
                        "pii_mode": policy.get("pii", {}).get("mode", "block"),
                        "max_rows": policy.get("defaults", {}).get("max_rows", 200),
                        "require_contract": policy.get("execution", {}).get("require_contract", False),
                    },
                )
            )

            pii_columns = policy.get("pii", {}).get("columns", {})
            pii_tags = policy.get("pii", {}).get("tags", ["PII", "Sensitive"])
            for table_key, columns in pii_columns.items():
                for col_name in columns:
                    col_ids = _find_column_ids(graph, table_key, col_name)
                    for col_id in col_ids:
                        node = graph.get_node(col_id)
                        if node:
                            node.properties["is_pii"] = True
                        graph._add_edge(GraphEdge(from_="policy:root", to=col_id, type=EdgeType.BLOCKS))
                        # CLASSIFIES from matching classification nodes
                        for tag in pii_tags:
                            if graph.get_node(f"class:{tag}"):
                                graph._add_edge(GraphEdge(from_=f"class:{tag}", to=col_id, type=EdgeType.CLASSIFIES))

        # ── 5. Contracts (decision traces) ──
        _ingest_contracts(graph, project_path)

        if warnings:
            import sys

            for w in warnings:
                print(f"[graph] warning: {w}", file=sys.stderr)

        return graph

    # ── Read API ──

    def get_node(self, node_id: str) -> GraphNode | None:
        return self._nodes.get(node_id)

    def get_nodes_by_type(self, node_type: NodeType) -> list[GraphNode]:
        return [n for n in self._nodes.values() if n.type == node_type]

    def neighbors(
        self,
        node_id: str,
        edge_type: EdgeType | None = None,
        direction: str = "both",
    ) -> list[GraphNode]:
        result: set[str] = set()

        if direction in ("forward", "both"):
            for edge in self._forward.get(node_id, []):
                if edge_type is None or edge.type == edge_type:
                    result.add(edge.to)

        if direction in ("reverse", "both"):
            for edge in self._reverse.get(node_id, []):
                if edge_type is None or edge.type == edge_type:
                    result.add(edge.from_)

        return [self._nodes[nid] for nid in result if nid in self._nodes]

    def lineage_of(self, node_id: str) -> list[GraphNode]:
        """Transitive upstream traversal (follow edges forward: consumer → source)."""
        return self._traverse(node_id, "forward")

    def impact_of(self, node_id: str) -> list[GraphNode]:
        """Transitive downstream traversal (follow edges backward: what points to me)."""
        return self._traverse(node_id, "reverse")

    def find_gaps(
        self,
        source_type: NodeType,
        required_edge: EdgeType,
        target_type: NodeType,
    ) -> list[GraphNode]:
        gaps: list[GraphNode] = []
        for node in self.get_nodes_by_type(source_type):
            inbound = self._reverse.get(node.id, [])
            has_required = any(
                e.type == required_edge
                and self._nodes.get(e.from_, GraphNode(id="", type=NodeType.Bundle)).type == target_type
                for e in inbound
            )
            if not has_required:
                gaps.append(node)
        return gaps

    def find_unblocked_pii_columns(self) -> list[GraphNode]:
        """PII columns with CLASSIFIES but no BLOCKS."""
        pii_cols: set[str] = set()
        for edge in self._edges:
            if edge.type == EdgeType.CLASSIFIES and edge.from_.startswith("class:"):
                cls_node = self._nodes.get(edge.from_)
                if cls_node:
                    tags = cls_node.properties.get("tags", [])
                    if "PII" in tags or edge.from_ == "class:PII":
                        pii_cols.add(edge.to)

        for edge in self._edges:
            if edge.type == EdgeType.BLOCKS and edge.from_.startswith("policy:"):
                pii_cols.discard(edge.to)

        return [self._nodes[cid] for cid in pii_cols if cid in self._nodes]

    def simulate(self, removals: list[str]) -> GapReport:
        """Non-destructive: deep-copy, remove nodes, report new gaps."""
        copy = deepcopy(self)
        for node_id in removals:
            copy._remove_node(node_id)

        new_gaps: list[GapEntry] = []

        # Check measures that lost rule governance
        for measure in copy.get_nodes_by_type(NodeType.Measure):
            inbound = copy._reverse.get(measure.id, [])
            has_rule = any(
                e.type == EdgeType.APPLIES_TO
                and copy._nodes.get(e.from_, GraphNode(id="", type=NodeType.Bundle)).type == NodeType.Rule
                for e in inbound
            )
            if not has_rule:
                orig_inbound = self._reverse.get(measure.id, [])
                was_governed = any(
                    e.type == EdgeType.APPLIES_TO
                    and self._nodes.get(e.from_, GraphNode(id="", type=NodeType.Bundle)).type == NodeType.Rule
                    for e in orig_inbound
                )
                if was_governed:
                    new_gaps.append(
                        GapEntry(
                            node_id=measure.id,
                            node_type=NodeType.Measure,
                            missing_edge=EdgeType.APPLIES_TO,
                            description=f"{measure.id} loses governance",
                        )
                    )

        # Check PII columns that lost BLOCKS
        orig_unblocked = {n.id for n in self.find_unblocked_pii_columns()}
        for col in copy.find_unblocked_pii_columns():
            if col.id not in orig_unblocked:
                new_gaps.append(
                    GapEntry(
                        node_id=col.id,
                        node_type=NodeType.Column,
                        missing_edge=EdgeType.BLOCKS,
                        description=f"{col.id} loses PII protection",
                    )
                )

        return GapReport(removed=removals, new_gaps=new_gaps)

    def stats(self) -> GraphStats:
        nodes_by_type: dict[str, int] = {}
        for node in self._nodes.values():
            nodes_by_type[node.type.value] = nodes_by_type.get(node.type.value, 0) + 1

        edges_by_type: dict[str, int] = {}
        for edge in self._edges:
            edges_by_type[edge.type.value] = edges_by_type.get(edge.type.value, 0) + 1

        return GraphStats(nodes_by_type=nodes_by_type, edges_by_type=edges_by_type)

    def enrich_from_openmetadata(self, om_dir: Path) -> list[str]:
        """Merge discovered metadata from OpenMetadata sync output into this graph.

        Reads openmetadata/<service>/<db>/<schema>/tables.yml files written by
        the OM sync provider. For each table/column found:
        - If a matching Table node exists, enriches its properties (description, om_fqn)
        - If a matching Column node exists, enriches data_type, description, tags
        - Creates new Column nodes for OM-discovered columns not yet in the graph
        - Adds DISCOVERED_BY edges from enriched nodes to a synthetic om:<service> node

        Returns list of enrichment actions taken.
        """
        import yaml

        if not om_dir.exists():
            return []

        actions: list[str] = []

        for tables_yml in sorted(om_dir.rglob("tables.yml")):
            try:
                data = yaml.safe_load(tables_yml.read_text())
            except Exception:
                continue

            if not data or "tables" not in data:
                continue

            service = data.get("service", "unknown")
            om_service_id = f"om:{service}"

            # Create OM service node if needed
            if not self.get_node(om_service_id):
                self._add_node(
                    GraphNode(
                        id=om_service_id,
                        type=NodeType.Bundle,
                        properties={
                            "display_name": f"OpenMetadata: {service}",
                            "source": "openmetadata",
                            "certification": "discovered",
                        },
                    )
                )

            schema_name = data.get("schema", "")

            for table_data in data["tables"]:
                table_name = table_data["name"]
                om_fqn = table_data.get("fqn", "")

                # Find matching table node by schema.table pattern
                matched_table_id = self._match_table(schema_name, table_name)

                if matched_table_id:
                    node = self.get_node(matched_table_id)
                    if node:
                        # Enrich existing table with OM metadata
                        if table_data.get("description"):
                            node.properties["om_description"] = table_data["description"]
                        node.properties["om_fqn"] = om_fqn
                        node.properties["om_table_type"] = table_data.get("table_type", "")
                        self._add_edge(GraphEdge(from_=matched_table_id, to=om_service_id, type=EdgeType.DISCOVERED_BY))
                        actions.append(f"enriched table {matched_table_id}")

                    # Enrich columns
                    for col_data in table_data.get("columns", []):
                        col_name = col_data["name"]
                        # Try to find existing column node
                        col_id = self._match_column(schema_name, table_name, col_name)

                        if col_id and self.get_node(col_id):
                            col_node = self.get_node(col_id)
                            if col_node:
                                if col_data.get("data_type") and col_node.properties.get("data_type") == "unknown":
                                    col_node.properties["data_type"] = col_data["data_type"]
                                if col_data.get("description"):
                                    col_node.properties["om_description"] = col_data["description"]
                                if col_data.get("tags"):
                                    col_node.properties["om_tags"] = col_data["tags"]
                                actions.append(f"enriched column {col_id}")
                        elif matched_table_id:
                            # OM discovered a column not in the governance YAML — add it
                            matched_node = self.get_node(matched_table_id)
                            db_id = matched_node.properties.get("database_id", "") if matched_node else ""
                            new_col_id = f"column:{db_id}/{schema_name}.{table_name}/{col_name}"
                            if not self.get_node(new_col_id):
                                self._add_node(
                                    GraphNode(
                                        id=new_col_id,
                                        type=NodeType.Column,
                                        properties={
                                            "data_type": col_data.get("data_type", "unknown"),
                                            "is_pii": False,
                                            "om_description": col_data.get("description", ""),
                                            "source": "openmetadata",
                                            **({"om_tags": col_data["tags"]} if col_data.get("tags") else {}),
                                        },
                                    )
                                )
                                self._add_edge(
                                    GraphEdge(from_=new_col_id, to=om_service_id, type=EdgeType.DISCOVERED_BY)
                                )
                                actions.append(f"discovered column {new_col_id}")

        return actions

    def _match_table(self, schema_name: str, table_name: str) -> str | None:
        """Find a table node matching schema.table across all database IDs."""
        for node in self.get_nodes_by_type(NodeType.Table):
            if node.properties.get("schema") == schema_name and node.properties.get("table") == table_name:
                return node.id
        return None

    def _match_column(self, schema_name: str, table_name: str, col_name: str) -> str | None:
        """Find a column node matching the given schema.table/column pattern."""
        suffix = f"/{schema_name}.{table_name}/{col_name}"
        for node in self.get_nodes_by_type(NodeType.Column):
            if node.id.endswith(suffix):
                return node.id
        return None

    def to_json(self) -> GraphJSON:
        return GraphJSON(
            nodes=list(self._nodes.values()),
            edges=list(self._edges),
        )

    @property
    def node_count(self) -> int:
        return len(self._nodes)

    @property
    def edge_count(self) -> int:
        return len(self._edges)

    @property
    def file_hashes(self) -> dict[str, str]:
        return dict(self._file_hashes)

    # ── Internal ──

    def _traverse(self, start_id: str, direction: str) -> list[GraphNode]:
        visited: set[str] = {start_id}
        queue = [start_id]
        result: list[GraphNode] = []

        while queue:
            current = queue.pop(0)
            edges = self._forward.get(current, []) if direction == "forward" else self._reverse.get(current, [])
            for edge in edges:
                neighbor_id = edge.to if direction == "forward" else edge.from_
                if neighbor_id not in visited and neighbor_id in self._nodes:
                    visited.add(neighbor_id)
                    result.append(self._nodes[neighbor_id])
                    queue.append(neighbor_id)

        return result

    def _remove_node(self, node_id: str) -> None:
        self._nodes.pop(node_id, None)
        # Clean forward edges
        for edge in self._forward.pop(node_id, []):
            rev = self._reverse.get(edge.to, [])
            self._reverse[edge.to] = [e for e in rev if e.from_ != node_id]
        # Clean reverse edges
        for edge in self._reverse.pop(node_id, []):
            fwd = self._forward.get(edge.from_, [])
            self._forward[edge.from_] = [e for e in fwd if e.to != node_id]
        self._edges = [e for e in self._edges if e.from_ != node_id and e.to != node_id]


# ── Loader helpers (standalone, no backend) ──


def _hash_file(graph: GovernanceGraph, path: Path) -> None:
    if not path.exists():
        return
    content = path.read_bytes()
    h = hashlib.sha256(content).hexdigest()
    graph._file_hashes[str(path)] = h


def _load_bundles(project_path: Path) -> list[dict]:
    """Load dataset bundles from datasets/*/dataset.yaml."""
    import yaml

    datasets_dir = project_path / "datasets"
    if not datasets_dir.exists():
        return []

    bundles = []
    for entry in sorted(datasets_dir.iterdir()):
        if not entry.is_dir():
            continue
        yaml_path = entry / "dataset.yaml"
        if not yaml_path.exists():
            continue
        data = yaml.safe_load(yaml_path.read_text())
        if data:
            bundles.append(data)
    return bundles


def _load_policy(project_path: Path) -> dict | None:
    """Load policy from policies/policy.yml."""
    import yaml

    policy_path = project_path / "policies" / "policy.yml"
    if not policy_path.exists():
        return None
    return yaml.safe_load(policy_path.read_text())


def _resolve_table_id(table_name: str, db_id: str, tables: list[dict]) -> str | None:
    if "." in table_name:
        return f"table:{db_id}/{table_name}"
    for t in tables:
        if t["table"] == table_name:
            return f"table:{db_id}/{t['schema']}.{t['table']}"
    return None


def _find_bundle_for_table(table_name: str, bundles: list[dict]) -> dict | None:
    for bundle in bundles:
        for t in bundle.get("tables", []):
            if t["table"] == table_name:
                return bundle
    return None


def _find_nodes_matching(graph: GovernanceGraph, target: str) -> list[str]:
    matches: list[str] = []

    if "." in target:
        for node in graph.get_nodes_by_type(NodeType.Measure):
            if node.id.endswith(f"/{target}") or node.id.endswith(f".{target}"):
                matches.append(node.id)

    for node in graph.get_nodes_by_type(NodeType.Model):
        if node.id.endswith(f"/{target}"):
            matches.append(node.id)

    if not matches:
        for node in graph.get_nodes_by_type(NodeType.Measure):
            short_name = node.id.split(".")[-1]
            if short_name == target:
                matches.append(node.id)

    return matches


def _ingest_contracts(graph: GovernanceGraph, project_path: Path) -> None:
    """Read contracts/runs/*.json and emit Contract + PolicyCheck nodes with decision-trace edges."""
    import json

    runs_dir = project_path / "contracts" / "runs"
    if not runs_dir.exists():
        return

    for json_file in sorted(runs_dir.glob("*.json")):
        try:
            contract = json.loads(json_file.read_text())
        except (json.JSONDecodeError, OSError):
            continue

        contract_id = contract.get("contract_id")
        if not contract_id:
            continue

        _hash_file(graph, json_file)

        node_id = f"contract:{contract_id}"
        graph._add_node(
            GraphNode(
                id=node_id,
                type=NodeType.Contract,
                properties={
                    "created_at": contract.get("created_at", ""),
                    "decision": contract.get("policy", {}).get("decision", ""),
                    "actor": contract.get("actor", {}).get("role", "user"),
                },
            )
        )

        # TOUCHED → tables used in scope
        scope = contract.get("scope", {})
        for table_ref in scope.get("tables", []):
            # table_ref is "schema.table" — find matching table nodes
            for table_node in graph.get_nodes_by_type(NodeType.Table):
                schema = table_node.properties.get("schema", "")
                table_name = table_node.properties.get("table", "")
                if f"{schema}.{table_name}" == table_ref or table_name == table_ref:
                    graph._add_edge(GraphEdge(from_=node_id, to=table_node.id, type=EdgeType.TOUCHED))

        # USED → measures referenced in meaning.metrics
        meaning = contract.get("meaning", {}) or {}
        for metric in meaning.get("metrics", []):
            metric_id = metric.get("id", "")
            # metric_id is "model.measure" — find matching measure nodes
            for measure_node in graph.get_nodes_by_type(NodeType.Measure):
                if measure_node.id.endswith(f"/{metric_id}") or measure_node.id.endswith(f".{metric_id}"):
                    graph._add_edge(GraphEdge(from_=node_id, to=measure_node.id, type=EdgeType.USED))

        # REFERENCED → rules cited in meaning.guidance_rules_referenced
        for rule_name in meaning.get("guidance_rules_referenced", []):
            rule_node_id = f"rule:{rule_name}"
            if graph.get_node(rule_node_id):
                graph._add_edge(GraphEdge(from_=node_id, to=rule_node_id, type=EdgeType.REFERENCED))

        # DECIDED / FAILED → PolicyCheck nodes
        policy = contract.get("policy", {})
        for check in policy.get("checks", []):
            check_name = check.get("name", "")
            check_node_id = f"check:{contract_id}/{check_name}"
            check_status = check.get("status", "pass")

            graph._add_node(
                GraphNode(
                    id=check_node_id,
                    type=NodeType.PolicyCheck,
                    properties={
                        "status": check_status,
                        "detail": check.get("detail", ""),
                    },
                )
            )

            if check_status == "fail":
                graph._add_edge(GraphEdge(from_=node_id, to=check_node_id, type=EdgeType.FAILED))
            else:
                graph._add_edge(GraphEdge(from_=node_id, to=check_node_id, type=EdgeType.DECIDED))


def _find_column_ids(graph: GovernanceGraph, table_key: str, col_name: str) -> list[str]:
    matches: list[str] = []
    for table in graph.get_nodes_by_type(NodeType.Table):
        schema = table.properties.get("schema", "")
        table_name = table.properties.get("table", "")
        if f"{schema}.{table_name}" == table_key or table_name == table_key:
            db_id = table.properties.get("database_id", "")
            col_id = f"column:{db_id}/{schema}.{table_name}/{col_name}"
            if not graph.get_node(col_id):
                graph._add_node(
                    GraphNode(
                        id=col_id,
                        type=NodeType.Column,
                        properties={"data_type": "unknown", "is_pii": True},
                    )
                )
            matches.append(col_id)
    return matches

from pathlib import Path
from typing import Annotated

from cyclopts import App, Parameter
from rich.table import Table
from rich.tree import Tree

from dazense_core.graph.governance_graph import GovernanceGraph
from dazense_core.graph.types import EdgeType, NodeType
from dazense_core.tracking import track_command
from dazense_core.ui import create_console

console = create_console()

graph = App(name="graph", help="Governance graph — lineage, impact, and gap analysis.")


def _compile(project_path: str | None) -> GovernanceGraph:
    base = Path(project_path) if project_path else Path.cwd()
    return GovernanceGraph.compile(base)


# ── dazense graph show ──


@graph.command
@track_command("graph.show")
def show(
    *,
    project_path: Annotated[str | None, Parameter(name=["-p", "--project-path"])] = None,
):
    """Show graph summary: node and edge counts by type."""
    console.print("\n[bold cyan]dazense graph show[/bold cyan]\n")
    g = _compile(project_path)
    stats = g.stats()

    console.print(f"[bold]Nodes:[/bold] {g.node_count} total")
    node_table = Table(show_header=True, header_style="bold")
    node_table.add_column("Type")
    node_table.add_column("Count", justify="right")
    for ntype, count in sorted(stats.nodes_by_type.items()):
        node_table.add_row(ntype, str(count))
    console.print(node_table)

    console.print(f"\n[bold]Edges:[/bold] {g.edge_count} total")
    edge_table = Table(show_header=True, header_style="bold")
    edge_table.add_column("Type")
    edge_table.add_column("Count", justify="right")
    for etype, count in sorted(stats.edges_by_type.items()):
        edge_table.add_row(etype, str(count))
    console.print(edge_table)
    console.print()


# ── dazense graph lineage <target> ──


@graph.command
@track_command("graph.lineage")
def lineage(
    target: str,
    *,
    project_path: Annotated[str | None, Parameter(name=["-p", "--project-path"])] = None,
):
    """Show upstream lineage for a measure, dimension, or model.

    Examples:
        dazense graph lineage orders.total_revenue
        dazense graph lineage "measure:jaffle_shop/orders.total_revenue"
    """
    console.print(f"\n[bold cyan]Lineage of[/bold cyan] [yellow]{target}[/yellow]\n")
    g = _compile(project_path)
    node_id = _resolve_target(g, target)

    if not node_id:
        console.print(f"[red]Node not found:[/red] {target}")
        console.print(
            "[dim]Hint: use full ID like 'measure:jaffle_shop/orders.total_revenue' or short name like 'orders.total_revenue'[/dim]\n"
        )
        return

    node = g.get_node(node_id)
    tree = Tree(f"[bold]{node_id}[/bold] ({node.type.value if node else '?'})")
    upstream = g.lineage_of(node_id)

    # Group by type for readability
    by_type: dict[str, list[str]] = {}
    for n in upstream:
        by_type.setdefault(n.type.value, []).append(n.id)

    for ntype, ids in sorted(by_type.items()):
        branch = tree.add(f"[bold cyan]{ntype}[/bold cyan] ({len(ids)})")
        for nid in sorted(ids):
            branch.add(nid)

    console.print(tree)
    console.print()


# ── dazense graph impact <target> ──


@graph.command
@track_command("graph.impact")
def impact(
    target: str,
    *,
    project_path: Annotated[str | None, Parameter(name=["-p", "--project-path"])] = None,
):
    """Show downstream impact for a column, table, or model.

    Examples:
        dazense graph impact main.orders.amount
        dazense graph impact "column:duckdb-jaffle-shop/main.orders/amount"
    """
    console.print(f"\n[bold cyan]Impact of[/bold cyan] [yellow]{target}[/yellow]\n")
    g = _compile(project_path)
    node_id = _resolve_target(g, target)

    if not node_id:
        console.print(f"[red]Node not found:[/red] {target}")
        return

    node = g.get_node(node_id)
    tree = Tree(f"[bold]{node_id}[/bold] ({node.type.value if node else '?'})")
    downstream = g.impact_of(node_id)

    by_type: dict[str, list[str]] = {}
    for n in downstream:
        by_type.setdefault(n.type.value, []).append(n.id)

    for ntype, ids in sorted(by_type.items()):
        branch = tree.add(f"[bold cyan]{ntype}[/bold cyan] ({len(ids)})")
        for nid in sorted(ids):
            branch.add(nid)

    if not downstream:
        tree.add("[dim]No downstream dependencies[/dim]")

    console.print(tree)
    console.print()


# ── dazense graph gaps ──


@graph.command
@track_command("graph.gaps")
def gaps(
    *,
    check: Annotated[str | None, Parameter(name=["--check"])] = None,
    project_path: Annotated[str | None, Parameter(name=["-p", "--project-path"])] = None,
):
    """Find coverage gaps in governance configuration.

    --check options: pii, models, rules, all (default: all)

    Examples:
        dazense graph gaps
        dazense graph gaps --check pii
        dazense graph gaps --check models
        dazense graph gaps --check rules
    """
    from dazense_core.graph.catalog import OpenMetadataCatalogProvider

    console.print("\n[bold cyan]dazense graph gaps[/bold cyan]\n")
    g = _compile(project_path)

    # Auto-enrich from catalogs so gap analysis includes catalog-discovered PII
    base = Path(project_path) if project_path else Path.cwd()
    snapshot_path = base / "catalog" / "snapshot.json"
    if snapshot_path.exists():
        g.enrich_from_snapshot(snapshot_path)
    else:
        om_dir = base / "catalog"
        if om_dir.exists():
            g.enrich_from_catalog(OpenMetadataCatalogProvider(), om_dir)

    check_type = check or "all"
    total_gaps = 0

    # PII: columns classified as PII but not blocked
    if check_type in ("all", "pii"):
        unblocked = g.find_unblocked_pii_columns()
        if unblocked:
            console.print(f"[bold red]PII gaps ({len(unblocked)}):[/bold red]")
            for col in unblocked:
                console.print(f"  [red]•[/red] {col.id} — classified as PII but no BLOCKS edge from policy")
            total_gaps += len(unblocked)
        elif check_type == "pii":
            console.print("[green]No PII gaps found[/green]")

    # Models: tables without semantic models (orphan tables)
    if check_type in ("all", "models"):
        orphans = g.find_gaps(NodeType.Table, EdgeType.WRAPS, NodeType.Model)
        if orphans:
            console.print(f"[bold yellow]Orphan tables ({len(orphans)}) — no semantic model:[/bold yellow]")
            for table in orphans:
                console.print(f"  [yellow]•[/yellow] {table.id}")
            total_gaps += len(orphans)
        elif check_type == "models":
            console.print("[green]All tables have semantic models[/green]")

    # Rules: measures without business rule governance
    if check_type in ("all", "rules"):
        ungoverned = g.find_gaps(NodeType.Measure, EdgeType.APPLIES_TO, NodeType.Rule)
        if ungoverned:
            console.print(f"[bold yellow]Ungoverned measures ({len(ungoverned)}) — no business rule:[/bold yellow]")
            for measure in ungoverned:
                console.print(f"  [yellow]•[/yellow] {measure.id}")
            total_gaps += len(ungoverned)
        elif check_type == "rules":
            console.print("[green]All measures have business rules[/green]")

    if check_type == "all":
        console.print()
        if total_gaps == 0:
            console.print("[bold green]No coverage gaps found[/bold green]")
        else:
            console.print(f"[bold yellow]{total_gaps} total gap(s) found[/bold yellow]")
    console.print()


# ── dazense graph simulate ──


@graph.command
@track_command("graph.simulate")
def simulate(
    *,
    remove: Annotated[list[str], Parameter(name=["--remove"])],
    project_path: Annotated[str | None, Parameter(name=["-p", "--project-path"])] = None,
):
    """Simulate removing nodes and show what breaks.

    Examples:
        dazense graph simulate --remove rule:exclude_returned_orders_from_revenue
        dazense graph simulate --remove "rule:pii_customer_names" --remove "rule:orders_require_time_filter"
    """
    console.print("\n[bold cyan]dazense graph simulate[/bold cyan]\n")
    g = _compile(project_path)

    # Validate all removal targets exist
    for node_id in remove:
        if not g.get_node(node_id):
            console.print(f"[red]Node not found:[/red] {node_id}")
            return

    report = g.simulate(remove)

    console.print(f"[bold]Removed:[/bold] {', '.join(report.removed)}")
    console.print()

    if report.new_gaps:
        table = Table(show_header=True, header_style="bold")
        table.add_column("Node")
        table.add_column("Type")
        table.add_column("Missing Edge")
        table.add_column("Description")
        for gap in report.new_gaps:
            table.add_row(gap.node_id, gap.node_type.value, gap.missing_edge.value, gap.description)
        console.print(table)
        console.print(f"\n[bold yellow]{len(report.new_gaps)} new gap(s) would be created[/bold yellow]")
    else:
        console.print("[bold green]No new gaps — safe to remove[/bold green]")
    console.print()


# ── dazense graph suggest-tests ──


@graph.command(name="suggest-tests")
@track_command("graph.suggest-tests")
def suggest_tests(
    *,
    project_path: Annotated[str | None, Parameter(name=["-p", "--project-path"])] = None,
):
    """Auto-generate eval test case suggestions from graph gaps.

    Suggests test cases for:
    - PII columns that should have block tests
    - Measures that should have accuracy tests
    - Time-filtered tables that should have enforcement tests
    """
    console.print("\n[bold cyan]dazense graph suggest-tests[/bold cyan]\n")
    g = _compile(project_path)
    suggestions: list[dict] = []

    # PII block tests
    pii_columns = [n for n in g.get_nodes_by_type(NodeType.Column) if n.properties.get("is_pii")]
    for col in pii_columns:
        col_name = col.id.split("/")[-1]
        suggestions.append(
            {
                "id": f"pii_block_{col_name}",
                "category": "pii_protection",
                "prompt": f"Show me all {col_name} values",
                "expected": {"outcome": "block", "check_failed": "pii_block"},
                "description": f"PII column {col.id} should be blocked",
            }
        )

    # Measure accuracy tests
    for measure in g.get_nodes_by_type(NodeType.Measure):
        short_name = measure.id.split(".")[-1]
        model_name = measure.id.split("/")[-1].split(".")[0]
        suggestions.append(
            {
                "id": f"metric_{short_name}",
                "category": "metric_accuracy",
                "prompt": f"What is the {short_name.replace('_', ' ')}?",
                "expected": {"tool": "query_metrics", "measure": short_name, "model_name": model_name},
                "description": f"Measure {measure.id} accuracy test",
            }
        )

    # Time filter enforcement tests
    bundles = g.get_nodes_by_type(NodeType.Bundle)
    for bundle in bundles:
        time_tables = g.neighbors(bundle.id, EdgeType.REQUIRES_TIME_FILTER, direction="forward")
        for table in time_tables:
            table_name = table.properties.get("table", "")
            suggestions.append(
                {
                    "id": f"time_filter_{table_name}",
                    "category": "time_filter",
                    "prompt": f"Show me all rows from {table_name}",
                    "expected": {"outcome": "allow", "check_passed": "time_filter_required"},
                    "description": f"Table {table.id} requires time filter",
                }
            )

    if suggestions:
        console.print(f"[bold]{len(suggestions)} test case suggestion(s):[/bold]\n")
        table = Table(show_header=True, header_style="bold")
        table.add_column("ID")
        table.add_column("Category")
        table.add_column("Description")
        for s in suggestions:
            table.add_row(s["id"], s["category"], s["description"])
        console.print(table)

        console.print("\n[dim]Add these to eval_test_cases in your dataset.yaml to enforce governance.[/dim]")
    else:
        console.print("[green]No test suggestions — governance coverage looks complete[/green]")
    console.print()


# ── dazense graph enrich ──


@graph.command
@track_command("graph.enrich")
def enrich(
    *,
    project_path: Annotated[str | None, Parameter(name=["-p", "--project-path"])] = None,
):
    """Enrich graph with metadata from external catalogs.

    Scans for catalog sync output directories (e.g. openmetadata/) and merges
    discovered columns, data types, descriptions, and tags into the governance graph.

    Supported catalogs: OpenMetadata (more coming).
    Run `dazense sync -p catalog` first to pull catalog metadata.
    """
    from dazense_core.graph.catalog import CatalogEnrichmentProvider, OpenMetadataCatalogProvider

    console.print("\n[bold cyan]dazense graph enrich[/bold cyan]\n")
    base = Path(project_path) if project_path else Path.cwd()
    g = _compile(project_path)

    total_actions: list[str] = []
    before_nodes = g.node_count
    before_edges = g.edge_count

    # Prefer snapshot.json (V2) over YAML-based enrichment
    snapshot_path = base / "catalog" / "snapshot.json"
    if snapshot_path.exists():
        actions = g.enrich_from_snapshot(snapshot_path)
        if actions:
            console.print(f"[bold green]Snapshot:[/bold green] {len(actions)} actions")
            total_actions.extend(actions)
    else:
        # Fallback to YAML-based catalog enrichment
        catalog_providers: list[tuple[CatalogEnrichmentProvider, Path]] = [
            (OpenMetadataCatalogProvider(), base / "catalog"),
        ]
        for provider, catalog_dir in catalog_providers:
            if not catalog_dir.exists():
                continue

            actions = g.enrich_from_catalog(provider, catalog_dir)
            if actions:
                console.print(f"[bold green]{provider.name}:[/bold green] {len(actions)} actions")
                total_actions.extend(actions)

    after_nodes = g.node_count
    after_edges = g.edge_count

    if total_actions:
        console.print("\n[bold green]Enrichment complete:[/bold green]")
        console.print(f"  Nodes: {before_nodes} → {after_nodes} (+{after_nodes - before_nodes})")
        console.print(f"  Edges: {before_edges} → {after_edges} (+{after_edges - before_edges})")
        console.print(f"  Actions: {len(total_actions)}")

        enriched = [a for a in total_actions if a.startswith("enriched")]
        discovered = [a for a in total_actions if a.startswith("discovered")]
        classified = [a for a in total_actions if a.startswith("created classification")]
        if enriched:
            console.print(f"\n  [cyan]Enriched:[/cyan] {len(enriched)} existing nodes")
        if discovered:
            console.print(f"  [green]Discovered:[/green] {len(discovered)} new nodes")
            for d in discovered[:10]:
                console.print(f"    [dim]+ {d.replace('discovered ', '')}[/dim]")
            if len(discovered) > 10:
                console.print(f"    [dim]... and {len(discovered) - 10} more[/dim]")
        if classified:
            console.print(f"  [magenta]Classifications:[/magenta] {len(classified)} from catalog tags")
    else:
        console.print("[dim]No catalog directories found or no metadata matched graph nodes.[/dim]")
        console.print("[dim]Run `dazense sync -p catalog` first to pull catalog metadata.[/dim]")
    console.print()


# ── Helpers ──


def _resolve_target(g: GovernanceGraph, target: str) -> str | None:
    """Resolve a user-supplied target to a graph node ID.

    Accepts:
    - Full canonical ID: "measure:jaffle_shop/orders.total_revenue"
    - Short name: "orders.total_revenue"
    - Table ref: "main.orders.amount" → column
    """
    # Exact match
    if g.get_node(target):
        return target

    # Try as measure short name: "model.measure"
    if "." in target:
        for node in g.get_nodes_by_type(NodeType.Measure):
            if node.id.endswith(f"/{target}"):
                return node.id

    # Try as dimension short name: "model.dimension"
    if "." in target:
        for node in g.get_nodes_by_type(NodeType.Dimension):
            if node.id.endswith(f"/{target}"):
                return node.id

    # Try as model short name
    for node in g.get_nodes_by_type(NodeType.Model):
        if node.id.endswith(f"/{target}"):
            return node.id

    # Try as "schema.table.column" → column node
    parts = target.split(".")
    if len(parts) == 3:
        schema, table, col = parts
        for node in g.get_nodes_by_type(NodeType.Column):
            if f"/{schema}.{table}/{col}" in node.id:
                return node.id

    # Try as table short name
    for node in g.get_nodes_by_type(NodeType.Table):
        if node.id.endswith(f"/{target}") or node.id.endswith(f".{target}"):
            return node.id

    return None

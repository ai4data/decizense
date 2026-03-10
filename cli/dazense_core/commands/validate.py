from pathlib import Path
from typing import Annotated

import yaml
from cyclopts import Parameter
from rich.table import Table

from dazense_core.config import DazenseConfig
from dazense_core.tracking import track_command
from dazense_core.ui import create_console

console = create_console()


@track_command("validate")
def validate(
    *,
    project_path: Annotated[str | None, Parameter(name=["-p", "--project-path"])] = None,
):
    """Validate consistency of dataset bundles, policies, and semantic models.

    Checks that bundle tables exist in configured databases, PII columns
    reference valid tables/columns, join allowlists are valid, and semantic
    model references align with bundles.
    """
    console.print("\n[bold cyan]dazense validate - Checking project consistency...[/bold cyan]\n")

    # Resolve project path
    base = Path(project_path) if project_path else Path.cwd()

    # Load config
    config = DazenseConfig.try_load(path=base, exit_on_error=True)
    assert config is not None
    console.print(f"[bold green]✓[/bold green] Loaded config: [cyan]{config.project_name}[/cyan]\n")

    db_names = {db.name for db in config.databases} if config.databases else set()
    errors: list[str] = []
    warnings: list[str] = []

    # ── Load bundles ──
    bundles_dir = base / "datasets"
    bundles: list[dict] = []
    bundle_tables: dict[str, set[str]] = {}  # bundle_id -> set of "schema.table"

    if bundles_dir.exists():
        for entry in sorted(bundles_dir.iterdir()):
            if not entry.is_dir():
                continue
            yaml_path = entry / "dataset.yaml"
            if not yaml_path.exists():
                warnings.append(f"datasets/{entry.name}/ has no dataset.yaml")
                continue

            try:
                with open(yaml_path) as f:
                    bundle = yaml.safe_load(f)
                bundles.append(bundle)

                bid = bundle.get("bundle_id", entry.name)
                tables = set()
                for t in bundle.get("tables", []):
                    tables.add(f"{t.get('schema', '')}.{t.get('table', '')}")
                bundle_tables[bid] = tables

                # Check warehouse database_id
                wh = bundle.get("warehouse", {})
                wh_db = wh.get("database_id")
                if wh_db and wh_db not in db_names:
                    errors.append(
                        f"datasets/{entry.name}/dataset.yaml: "
                        f"warehouse.database_id '{wh_db}' not found in dazense_config.yaml databases"
                    )

                # Check tables not empty
                if not bundle.get("tables"):
                    warnings.append(f"datasets/{entry.name}/dataset.yaml: no tables defined")

                # Validate join columns reference existing tables
                for j in bundle.get("joins", []):
                    for side in ("left", "right"):
                        ref = j.get(side, {})
                        ref_table = f"{ref.get('schema', '')}.{ref.get('table', '')}"
                        if ref_table not in tables:
                            errors.append(
                                f"datasets/{entry.name}/dataset.yaml: "
                                f"join {side} references '{ref_table}' which is not in the bundle's tables"
                            )

            except Exception as e:
                errors.append(f"datasets/{entry.name}/dataset.yaml: failed to parse — {e}")
    else:
        warnings.append("No datasets/ directory found")

    # ── Load policy ──
    policy_path = base / "policies" / "policy.yml"
    policy: dict | None = None

    if policy_path.exists():
        try:
            with open(policy_path) as f:
                policy = yaml.safe_load(f)

            # Check PII columns reference valid bundle tables
            pii = policy.get("pii", {})
            pii_columns = pii.get("columns", {})
            all_bundle_tables = set()
            for tables in bundle_tables.values():
                all_bundle_tables.update(tables)

            for table, cols in pii_columns.items():
                if all_bundle_tables and table not in all_bundle_tables:
                    warnings.append(f"policies/policy.yml: PII table '{table}' not found in any dataset bundle")
                if not cols:
                    warnings.append(f"policies/policy.yml: PII entry for '{table}' has no columns listed")

        except Exception as e:
            errors.append(f"policies/policy.yml: failed to parse — {e}")
    else:
        warnings.append("No policies/policy.yml found (safe defaults will be used)")

    # ── Load semantic model ──
    sem_path = base / "semantics" / "semantic_model.yml"
    if sem_path.exists():
        try:
            with open(sem_path) as f:
                sem = yaml.safe_load(f)

            models = sem.get("models", {})
            for model_name, model_def in models.items():
                model_table = model_def.get("table", "")
                model_schema = model_def.get("schema", "main")
                fqt = f"{model_schema}.{model_table}"

                # Check if model tables align with any bundle
                if bundle_tables:
                    found_in_bundle = any(fqt in tables for tables in bundle_tables.values())
                    if not found_in_bundle:
                        warnings.append(
                            f"semantics/semantic_model.yml: model '{model_name}' "
                            f"table '{fqt}' not found in any dataset bundle"
                        )

                # Check measures are well-formed
                measures = model_def.get("measures", {})
                if not measures:
                    warnings.append(f"semantics/semantic_model.yml: model '{model_name}' has no measures defined")
                for measure_name, measure_def in measures.items():
                    if not isinstance(measure_def, dict):
                        errors.append(
                            f"semantics/semantic_model.yml: model '{model_name}' "
                            f"measure '{measure_name}' is not a valid definition"
                        )
                        continue
                    agg_type = measure_def.get("type")
                    if agg_type not in ("count", "sum", "avg", "min", "max", "count_distinct"):
                        errors.append(
                            f"semantics/semantic_model.yml: model '{model_name}' "
                            f"measure '{measure_name}' has invalid type '{agg_type}'"
                        )
                    if agg_type != "count" and not measure_def.get("column"):
                        errors.append(
                            f"semantics/semantic_model.yml: model '{model_name}' "
                            f"measure '{measure_name}' (type={agg_type}) requires a 'column' field"
                        )

                # Check model joins reference existing models
                model_joins = model_def.get("joins", {})
                for join_name, join_def in model_joins.items():
                    if not isinstance(join_def, dict):
                        continue
                    to_model = join_def.get("to_model")
                    if to_model and to_model not in models:
                        errors.append(
                            f"semantics/semantic_model.yml: model '{model_name}' "
                            f"join '{join_name}' references model '{to_model}' which does not exist"
                        )

                # Cross-check: if PII columns are declared for this model's table,
                # verify the PII columns exist as dimensions in the model
                if policy:
                    pii_cols_for_table = policy.get("pii", {}).get("columns", {}).get(fqt, [])
                    model_dims = set(model_def.get("dimensions", {}).keys())
                    for pii_col in pii_cols_for_table:
                        if pii_col in model_dims:
                            warnings.append(
                                f"semantics/semantic_model.yml: model '{model_name}' "
                                f"exposes PII dimension '{pii_col}' (blocked in policy.yml)"
                            )

        except Exception as e:
            errors.append(f"semantics/semantic_model.yml: failed to parse — {e}")

    # ── Report results ──
    console.print()

    if bundles:
        console.print(f"[bold]Dataset Bundles:[/bold] {len(bundles)} found")
        for b in bundles:
            bid = b.get("bundle_id", "?")
            tcount = len(b.get("tables", []))
            jcount = len(b.get("joins", []))
            console.print(f"  [cyan]{bid}[/cyan] — {tcount} tables, {jcount} joins")
        console.print()

    if sem_path.exists():
        try:
            with open(sem_path) as f:
                sem_data = yaml.safe_load(f)
            sem_models = sem_data.get("models", {})
            console.print(f"[bold]Semantic Models:[/bold] {len(sem_models)} found")
            for mname, mdef in sem_models.items():
                mcount = len(mdef.get("measures", {}))
                dcount = len(mdef.get("dimensions", {}))
                jcount = len(mdef.get("joins", {}))
                console.print(f"  [cyan]{mname}[/cyan] — {mcount} measures, {dcount} dimensions, {jcount} joins")
            console.print()
        except Exception:
            pass  # errors already captured above

    if policy:
        console.print("[bold]Policy:[/bold] policies/policy.yml loaded")
        pii_mode = policy.get("pii", {}).get("mode", "block")
        pii_count = sum(len(v) for v in policy.get("pii", {}).get("columns", {}).values())
        require_contract = policy.get("execution", {}).get("require_contract", False)
        console.print(f"  PII mode: {pii_mode} ({pii_count} columns declared)")
        console.print(f"  Strict mode (require_contract): {require_contract}")
        console.print()

    # Results table
    result_table = Table(show_header=True, header_style="bold")
    result_table.add_column("Level")
    result_table.add_column("Message")

    for err in errors:
        result_table.add_row("[red]ERROR[/red]", err)
    for warn in warnings:
        result_table.add_row("[yellow]WARN[/yellow]", warn)

    if errors or warnings:
        console.print(result_table)
        console.print()

    if errors:
        console.print(
            f"[bold red]✗ Validation failed with {len(errors)} error(s) and {len(warnings)} warning(s)[/bold red]\n"
        )
    elif warnings:
        console.print(f"[bold yellow]⚠ Validation passed with {len(warnings)} warning(s)[/bold yellow]\n")
    else:
        console.print("[bold green]✓ All checks passed[/bold green]\n")

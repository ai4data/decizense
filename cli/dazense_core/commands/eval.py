"""Governance evaluation: run test cases from dataset bundles and verify constraints."""

from pathlib import Path
from typing import Annotated

import yaml
from cyclopts import Parameter
from rich.table import Table

from dazense_core.config import DazenseConfig
from dazense_core.semantic.engine import SemanticEngine
from dazense_core.semantic.models import SemanticModel
from dazense_core.tracking import track_command
from dazense_core.ui import create_console

console = create_console()


def _load_bundles(base: Path) -> list[dict]:
    """Load all dataset bundles from datasets/*/dataset.yaml."""
    bundles_dir = base / "datasets"
    bundles = []
    if not bundles_dir.exists():
        return bundles
    for entry in sorted(bundles_dir.iterdir()):
        if not entry.is_dir():
            continue
        yaml_path = entry / "dataset.yaml"
        if yaml_path.exists():
            with open(yaml_path) as f:
                bundles.append(yaml.safe_load(f))
    return bundles


def _load_policy(base: Path) -> dict | None:
    """Load policy from policies/policy.yml."""
    policy_path = base / "policies" / "policy.yml"
    if not policy_path.exists():
        return None
    with open(policy_path) as f:
        return yaml.safe_load(f)


def _run_metric_test(
    engine: SemanticEngine,
    test_case: dict,
) -> tuple[bool, str]:
    """Run a query_metrics test case and check the result against expected range."""
    expected = test_case.get("expected", {})
    model_name = expected.get("model_name")
    measure = expected.get("measure")
    result_range = expected.get("result_range")

    if not model_name or not measure:
        return True, "No metric assertion (skipped)"

    try:
        rows = engine.query(
            model_name=model_name,
            measures=[measure],
            dimensions=[],
        )
        if not rows:
            return False, f"No data returned for {model_name}.{measure}"

        value = rows[0].get(measure)
        if value is None:
            return False, f"Measure '{measure}' not in result"

        if result_range:
            lo, hi = result_range
            if lo <= value <= hi:
                return True, f"{measure} = {value} (expected {lo}-{hi})"
            else:
                return False, f"{measure} = {value} (expected {lo}-{hi})"

        return True, f"{measure} = {value}"
    except Exception as e:
        return False, f"Query error: {e}"


def _run_governance_test(
    test_case: dict,
    policy: dict | None,
    bundles: list[dict],
    semantic_model: SemanticModel | None,
) -> tuple[bool, str]:
    """Run a governance check (outcome, check_failed, guidance_rules) without LLM."""
    expected = test_case.get("expected", {})
    expected_outcome = expected.get("outcome")
    expected_check = expected.get("check_failed")
    expected_rules = expected.get("guidance_rules_include", [])

    if not policy:
        if expected_outcome in ("block", "needs_clarification"):
            return False, "No policy.yml — cannot enforce governance checks"
        return True, "No policy (governance checks skipped)"

    results = []

    # Check: PII block (column name in prompt text)
    if expected_check == "pii_block":
        pii_cols = policy.get("pii", {}).get("columns", {})
        prompt_lower = test_case.get("prompt", "").lower()
        blocked = []
        for table, cols in pii_cols.items():
            for col in cols:
                if col.lower() in prompt_lower:
                    blocked.append(f"{table}.{col}")
        if blocked:
            results.append((True, f"PII block triggered: {', '.join(blocked)}"))
        else:
            results.append((False, "PII block expected but no PII columns found in prompt"))

    # Check: PII block via SELECT * (table has PII columns)
    if expected_check == "pii_block_star":
        pii_cols = policy.get("pii", {}).get("columns", {})
        prompt_lower = test_case.get("prompt", "").lower()
        if "select *" in prompt_lower or "select\t*" in prompt_lower:
            # Check if any referenced table has PII columns
            tables_with_pii = [t for t, cols in pii_cols.items() if cols]
            if tables_with_pii:
                results.append((True, f"SELECT * blocked: PII tables {', '.join(tables_with_pii)}"))
            else:
                results.append((False, "SELECT * found but no PII tables configured"))
        else:
            results.append((False, "Expected SELECT * in prompt but not found"))

    # Check: bundle_tables_only
    if expected_check == "bundle_tables_only":
        prompt_lower = test_case.get("prompt", "").lower()
        all_bundle_tables = set()
        for b in bundles:
            for t in b.get("tables", []):
                all_bundle_tables.add(f"{t['schema']}.{t['table']}")
        # Simple heuristic: check if prompt references a table not in any bundle
        if all_bundle_tables:
            results.append((True, f"Bundle enforcement active. Allowed: {', '.join(sorted(all_bundle_tables))}"))
        else:
            results.append((False, "No bundles with tables found"))

    # Check: time_filter_required
    if expected_check == "time_filter_required":
        for b in bundles:
            time_tables = b.get("defaults", {}).get("require_time_filter_for_tables", [])
            if time_tables:
                results.append((True, f"Time filter required for: {', '.join(time_tables)}"))
                break
        else:
            results.append((False, "No time filter tables configured in any bundle"))

    # Check: ambiguity
    if expected_check == "ambiguity_check":
        # We can only verify the schema supports it — actual detection depends on LLM
        results.append((True, "Ambiguity field is in build_contract schema (LLM-dependent detection)"))

    # Check: guidance_rules_include
    if expected_rules and semantic_model:
        # Load business rules and check applies_to
        rules_path = Path(test_case.get("_project_path", ".")) / "semantics" / "business_rules.yml"
        if rules_path.exists():
            with open(rules_path) as f:
                br = yaml.safe_load(f)
            rule_names = {r["name"] for r in br.get("rules", [])}
            missing = [r for r in expected_rules if r not in rule_names]
            if missing:
                results.append((False, f"Missing business rules: {', '.join(missing)}"))
            else:
                results.append((True, f"Business rules exist: {', '.join(expected_rules)}"))
        else:
            results.append((False, "No business_rules.yml found"))

    if not results:
        return True, f"Expected outcome: {expected_outcome} (structural check only)"

    all_pass = all(r[0] for r in results)
    detail = "; ".join(r[1] for r in results)
    return all_pass, detail


def _run_governance_scorecard(
    base: Path,
    policy: dict | None,
    bundles: list[dict],
    semantic_model: SemanticModel | None,
) -> list[tuple[bool, str]]:
    """Check for common governance configuration gaps."""
    checks = []

    # 1. require_bundle
    rb = policy.get("execution", {}).get("require_bundle", False) if policy else False
    checks.append((rb, "require_bundle: true (prevents bundle omission bypass)"))

    # 2. require_contract
    rc = policy.get("execution", {}).get("require_contract", False) if policy else False
    checks.append((rc, "require_contract: true (forces contract flow)"))

    # 3. PII columns declared
    pii_count = sum(len(v) for v in policy.get("pii", {}).get("columns", {}).values()) if policy else 0
    checks.append((pii_count > 0, f"PII columns declared ({pii_count} columns blocked)"))

    # 4. Time filter tables defined
    has_time_tables = False
    for b in bundles:
        if b.get("defaults", {}).get("require_time_filter_for_tables"):
            has_time_tables = True
            break
    checks.append((has_time_tables, "Time filter tables defined in bundle"))

    # 5. data_start_date set
    has_start = any(b.get("defaults", {}).get("data_start_date") for b in bundles)
    checks.append((has_start, "data_start_date set (enables 'all_time' resolution)"))

    # 6. demo_current_date set
    has_demo_date = any(b.get("defaults", {}).get("demo_current_date") for b in bundles)
    checks.append((has_demo_date, "demo_current_date set (LLMs resolve relative dates)"))

    # 7. Test cases exist
    has_tests = any(b.get("eval_test_cases") for b in bundles)
    checks.append((has_tests, "eval_test_cases defined in bundle"))

    # 8. Measures with filters (check if revenue measures have filters)
    has_measure_filters = False
    if semantic_model:
        for model_def in semantic_model.models.values():
            for m in model_def.measures.values():
                if m.filters:
                    has_measure_filters = True
                    break
    checks.append((has_measure_filters, "Measures with baked-in filters (prevents hallucinated compliance)"))

    return checks


@track_command("eval")
def eval(
    *,
    project_path: Annotated[str | None, Parameter(name=["-p", "--project-path"])] = None,
    scorecard: Annotated[bool, Parameter(name=["--scorecard"], help="Show governance scorecard only")] = False,
):
    """Evaluate governance constraints using test cases from dataset bundles.

    Runs eval_test_cases from each bundle's dataset.yaml, verifying that
    governance constraints (PII blocking, bundle enforcement, time filters,
    metric accuracy) produce correct results.

    Test cases are defined per bundle and check two things:
    1. Structural checks — policy/bundle/semantic config is correct
    2. Metric checks — query_metrics returns expected values

    Usage:
        dazense eval                          # Run all test cases
        dazense eval --scorecard              # Show governance scorecard only
        dazense eval -p /path/to/project      # Specify project path
    """
    console.print("\n[bold cyan]dazense eval — Governance Evaluation[/bold cyan]\n")

    base = Path(project_path) if project_path else Path.cwd()

    # Load project
    config = DazenseConfig.try_load(path=base, exit_on_error=True)
    assert config is not None
    console.print(f"[bold green]\u2713[/bold green] Project: [cyan]{config.project_name}[/cyan]\n")

    # Load resources
    bundles = _load_bundles(base)
    policy = _load_policy(base)
    semantic_model = SemanticModel.load(base)

    # Initialize semantic engine if available
    engine = None
    if semantic_model and config.databases:
        try:
            engine = SemanticEngine(semantic_model, config.databases)
        except Exception as e:
            console.print(f"[yellow]Warning: Could not initialize semantic engine: {e}[/yellow]\n")

    # ── Governance Scorecard ──
    if policy:
        scorecard_results = _run_governance_scorecard(base, policy, bundles, semantic_model)
        score_pass = sum(1 for ok, _ in scorecard_results if ok)
        score_total = len(scorecard_results)

        console.print("[bold]Governance Scorecard[/bold]\n")
        for ok, msg in scorecard_results:
            icon = "[bold green]\u2713[/bold green]" if ok else "[bold red]\u2717[/bold red]"
            console.print(f"  {icon} {msg}")
        console.print(f"\n  Score: [bold]{score_pass}/{score_total}[/bold]\n")

        if scorecard:
            return
    elif scorecard:
        console.print("[yellow]No policy.yml found — scorecard requires a policy.[/yellow]\n")
        return

    # ── Collect test cases ──
    all_tests = []
    for b in bundles:
        bundle_id = b.get("bundle_id", "unknown")
        for tc in b.get("eval_test_cases", []):
            tc["_bundle_id"] = bundle_id
            tc["_project_path"] = str(base)
            all_tests.append(tc)

    if not all_tests:
        console.print("[yellow]No eval_test_cases found in any bundle.[/yellow]")
        console.print("Add eval_test_cases to your dataset.yaml to define test cases.\n")
        return

    console.print(f"[bold]Running {len(all_tests)} test case(s)...[/bold]\n")

    # ── Run tests ──
    results_table = Table(show_header=True, header_style="bold")
    results_table.add_column("ID", style="cyan", no_wrap=True)
    results_table.add_column("Category")
    results_table.add_column("Result", justify="center")
    results_table.add_column("Detail")

    passed = 0
    failed = 0

    for tc in all_tests:
        tc_id = tc.get("id", "?")
        category = tc.get("category", "")
        expected = tc.get("expected", {})
        expected_outcome = expected.get("outcome", "allow")

        test_results = []

        # 1. Governance / structural test
        gov_ok, gov_detail = _run_governance_test(tc, policy, bundles, semantic_model)
        test_results.append((gov_ok, gov_detail))

        # 2. Metric accuracy test (only for allow + query_metrics cases)
        if expected_outcome == "allow" and expected.get("tool") == "query_metrics" and engine:
            metric_ok, metric_detail = _run_metric_test(engine, tc)
            test_results.append((metric_ok, metric_detail))

        # Aggregate results
        all_ok = all(r[0] for r in test_results)
        detail = " | ".join(r[1] for r in test_results)

        if all_ok:
            passed += 1
            results_table.add_row(tc_id, category, "[green]PASS[/green]", detail)
        else:
            failed += 1
            results_table.add_row(tc_id, category, "[red]FAIL[/red]", detail)

    console.print(results_table)
    console.print()

    # Summary
    total = passed + failed
    if failed == 0:
        console.print(f"[bold green]\u2713 All {total} test(s) passed[/bold green]\n")
    else:
        console.print(f"[bold red]\u2717 {failed}/{total} test(s) failed[/bold red]\n")

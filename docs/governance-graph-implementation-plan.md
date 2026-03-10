# Implementation Plan: Governance Graph — Compiled IR from YAML Source

> **Status**: Design complete, not yet implemented. This is a future enhancement to the V1 Trusted Analytics Copilot.

## Context

The V1 governance infrastructure (datasets, semantics, policies, contracts) is implemented as flat YAML/JSON files with **implicit** string-based relationships. Every consumer (policy engine, validator, eval) re-reads files and correlates strings procedurally.

**The compiler metaphor**: YAML files are **source code**. The graph is a **compiled intermediate representation (IR)** — a read-only, typed, traversable artifact derived from source. Source stays authoritative; IR is ephemeral and rebuildable.

This gives us: impact analysis, lineage, gap detection, decision traces, change simulation, and auto-test generation — none of which flat files support without procedural re-implementation per feature.

---

## Design Principles

### 1. Canonical IDs, not names

Nodes use **stable IDs** so renames don't break lineage:

```
table:duckdb-jaffle-shop/main.orders       (warehouse_id/schema.table)
column:duckdb-jaffle-shop/main.orders/amount
model:jaffle_shop/orders                    (bundle_id/model_name)
measure:jaffle_shop/orders.total_revenue    (bundle_id/model.measure)
rule:exclude_returned_orders                (rule name — already unique)
bundle:jaffle_shop                          (bundle_id)
contract:gate-test-001                      (contract_id)
```

Renaming a display name doesn't change the ID. The YAML `bundle_id`, `database_id`, and composite keys form the stable identity.

### 2. Compiler architecture

```
YAML source files          Compiler (graph-builder)         Compiled IR (GovernanceGraph)
─────────────────    ──▶   ────────────────────────   ──▶   ─────────────────────────────
dataset.yaml                parse + validate                 Typed nodes + edges
semantic_model.yml          resolve cross-refs               Adjacency lists (fwd + rev)
business_rules.yml          detect errors/warnings           Ready for traversal queries
policy.yml                  emit IR
```

Compilation happens once at startup (or on file change). Consumers query the IR, never the raw YAML.

### 2.1 Incremental compile strategy

Avoid full recompilation for every file change:

1. Compute per-file content hash for:
    - `datasets/**/dataset.yaml`
    - `semantics/semantic_model.yml`
    - `semantics/business_rules.yml`
    - `policies/policy.yml`
2. Build a dependency map (file → affected node/edge sets).
3. Rebuild only affected subgraph partitions.
4. Re-run integrity checks (unique IDs, no dangling edges, schema-valid IR).

### 3. Typed edges with semantics

Every edge has a specific meaning — no generic "relates_to":

| Edge                   | From → To                 | Semantic                            |
| ---------------------- | ------------------------- | ----------------------------------- |
| `DEFINES`              | Model → Measure/Dimension | Model defines this metric/dimension |
| `APPLIES_TO`           | Rule → Model/Measure      | Rule governs this entity            |
| `BLOCKS`               | Policy → Column           | Policy blocks access to this column |
| `REQUIRES_TIME_FILTER` | Bundle → Table            | Temporal constraint                 |
| `JOINS_WITH`           | Model → Model             | Approved semantic join              |
| `CONTAINS`             | Bundle → Table            | Bundle scopes this table            |
| `READS`                | Dimension → Column        | Dimension reads physical column     |
| `AGGREGATES`           | Measure → Column          | Measure aggregates physical column  |
| `FILTERS_ON`           | Measure → Column          | Baked-in filter dependency          |
| `CLASSIFIES`           | Classification → Column   | Tag assignment (PII, Financial)     |
| `WRAPS`                | Model → Table             | Semantic model wraps physical table |
| `ALLOWS_JOIN`          | Bundle → JoinEdge         | Bundle authorizes this join edge    |
| `JOIN_LEFT`            | JoinEdge → Table          | Left table of approved join         |
| `JOIN_RIGHT`           | JoinEdge → Table          | Right table of approved join        |

Contract edges (Phase 2+):

| Edge         | From → To               | Semantic                                 |
| ------------ | ----------------------- | ---------------------------------------- |
| `TOUCHED`    | Contract → Table        | Query accessed this table                |
| `USED`       | Contract → Measure      | Query used this metric                   |
| `REFERENCED` | Contract → Rule         | Contract cited this rule                 |
| `DECIDED`    | Contract → PolicyCheck  | Decision trace edge                      |
| `FAILED`     | PolicyCheck → GraphNode | Check failed because of this node/entity |

---

## Node Types

| Node Type        | ID Pattern                                                           | Source                    | Properties                           |
| ---------------- | -------------------------------------------------------------------- | ------------------------- | ------------------------------------ |
| `Bundle`         | `bundle:{bundle_id}`                                                 | `datasets/*/dataset.yaml` | display_name, certification, owners  |
| `Table`          | `table:{db_id}/{schema}.{table}`                                     | bundle tables             | schema, database_type                |
| `Column`         | `column:{db_id}/{schema}.{table}/{col}`                              | semantic dims + PII decls | data_type, is_pii                    |
| `Model`          | `model:{bundle_id}/{model}`                                          | `semantic_model.yml`      | table, primary_key, time_dimension   |
| `Dimension`      | `dim:{bundle_id}/{model}.{dim}`                                      | semantic model            | column, description                  |
| `Measure`        | `measure:{bundle_id}/{model}.{measure}`                              | semantic model            | type, column, filters                |
| `Rule`           | `rule:{name}`                                                        | `business_rules.yml`      | category, severity, guidance         |
| `Classification` | `class:{name}`                                                       | business_rules.yml        | tags[]                               |
| `Policy`         | `policy:root`                                                        | `policy.yml`              | pii_mode, max_rows, require_contract |
| `JoinEdge`       | `join:{bundle_id}/{left_table}.{left_col}={right_table}.{right_col}` | bundle joins              | type, description                    |
| `PolicyCheck`    | `check:{contract_id}/{check_name}`                                   | contract trace            | status, detail                       |
| `Contract`       | `contract:{id}`                                                      | `contracts/runs/*.json`   | created_at, decision, actor          |

---

## What the Graph Enables

### Core queries (Phase 1)

1. **Lineage**: `lineageOf("measure:jaffle_shop/orders.total_revenue")`
   → column, table, bundle, filters, applicable rules — single traversal

2. **Impact**: `impactOf("column:duckdb-jaffle-shop/main.orders/amount")`
   → all measures, rules, and (later) contracts affected

3. **Coverage/completeness checks**:
    - Orphan tables (in bundle but no semantic model)
    - Ungoverned measures (no business rule `APPLIES_TO`)
    - Rules with no targets (`APPLIES_TO` edge count = 0)
    - PII columns (`CLASSIFIES` from `class:PII`) without `BLOCKS` edge from `policy:root`

4. **Change impact simulation**: "If I remove rule X, which measures lose governance?"
   → Delete rule node from copy of graph, re-run gap detection

### Decision-trace queries (Phase 2 — with contracts)

5. **Decision trace**: "Why was contract X blocked?"
   → `contract:X` → `DECIDED` → PolicyCheck nodes with pass/fail/detail

6. **Dead config detection**: Rules/policies never matched by any contract over N days
   → Rule nodes with zero inbound `REFERENCED` edges from recent contracts

7. **Auto-test generation**: Derive eval cases from graph gaps
   → Every PII column should have a block test; every measure should have an accuracy test
   → `dazense graph suggest-tests` generates `eval_test_cases` entries

### Future (Phase 3+)

8. **as_of versioning**: Graph snapshots per commit/release for audit ("what rules were active then?")

9. **OpenMetadata merge strategy**: Define precedence (manual override > OM > inferred) as edge metadata — when OM imports conflict with manual YAML, the graph resolves by precedence

---

## Implementation

### Phase 1: Compiler + In-Memory IR (TypeScript + Python)

**New files:**

| #   | File                                         | Purpose                                                                     |
| --- | -------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | `schemas/governance-graph.schema.json`       | Canonical IR schema (single source of truth for TS and Python)              |
| 2   | `apps/backend/src/graph/types.ts`            | TS graph types validated/generated from canonical schema                    |
| 3   | `apps/backend/src/graph/governance-graph.ts` | `GovernanceGraph` class — adjacency list, traversal, query methods          |
| 4   | `apps/backend/src/graph/graph-builder.ts`    | `buildFromProject(projectFolder)` — compiler using existing loaders         |
| 5   | `cli/dazense_core/graph/__init__.py`         | Module init                                                                 |
| 6   | `cli/dazense_core/graph/types.py`            | Python Pydantic types from canonical schema                                 |
| 7   | `cli/dazense_core/graph/governance_graph.py` | Python standalone compiler + graph (reads YAML directly, no backend needed) |

**Core API (both TS and Python):**

```
GovernanceGraph
  .compile(projectFolder) → GovernanceGraph    // the compiler
  .getNode(id) → GraphNode | null
  .neighbors(id, edgeType?, direction?) → GraphNode[]
  .impactOf(id) → GraphNode[]                  // transitive downstream
  .lineageOf(id) → GraphNode[]                 // transitive upstream
  .findGaps(sourceType, requiredEdge, targetType) → GraphNode[]
  .findUnblockedPiiColumns() → GraphNode[]     // class:PII without policy:root BLOCKS
  .simulate(removals: string[]) → GapReport    // change impact simulation
  .stats() → { nodes_by_type, edges_by_type }
  .toJSON() → { nodes[], edges[] }
```

**Reuses existing loaders** — no YAML parsing duplication:

- TS: `getDatasetBundles()`, `getSemanticModels()`, `getBusinessRules()`, `getPolicies()`, `getClassifications()` from `apps/backend/src/agents/user-rules.ts`
- Python: YAML loading from `cli/dazense_core/semantic/models.py` and `cli/dazense_core/rules/models.py`

### Phase 2: CLI Commands + Decision Traces

**New file:** `cli/dazense_core/commands/graph.py`

```
dazense graph show                              # summary: N nodes, M edges by type
dazense graph lineage orders.total_revenue      # upstream lineage tree
dazense graph impact main.orders.amount         # downstream impact tree
dazense graph gaps                              # all coverage checks
dazense graph gaps --check pii                  # PII columns without policy
dazense graph gaps --check models               # tables without semantic models
dazense graph gaps --check rules                # measures without business rules
dazense graph simulate --remove rule:X          # what breaks if rule X removed?
dazense graph suggest-tests                     # auto-generate eval_test_cases from gaps
```

**Modify:** `cli/dazense_core/main.py` — register `graph` command

**Integrate contracts as graph nodes**: Add a separate contract ingester that reads `contracts/runs/*.json` and augments graph edges. Keep `contract-writer.ts` storage-focused.

### Phase 3: Persistence + Versioning (future)

- **as_of versioning**: Graph snapshots per git commit. Requires git integration.
- **OpenMetadata merge**: Precedence rules for OM imports. Requires OM integration to exist first.
- **SQLite persistence**: For historical contract lineage queries at scale. Add `contract_graph_edges` table to existing `db.sqlite`.
- **Visualization**: D3.js/Cytoscape.js frontend component. Export via `toJSON()`.

### Architecture Decisions

- **Python builds standalone** from YAML (no backend dependency). CLI works offline.
- **YAML = source of truth**. Graph is ephemeral IR, rebuilt on every `compile()`.
- **Canonical IDs** use composite keys (`warehouse_id/schema.table`) not display names.
- **Model→Table ID resolution is deterministic**: resolve model table through bundle `warehouse.database_id`; if ambiguous across bundles/databases, fail compilation with explicit error.
- **Cross-language parity is mandatory**: TS and Python outputs must validate against the same schema and match under normalized snapshot tests.
- **No new storage for Phase 1**. In-memory only, rebuilt at startup (~ms for 100s of nodes).
- **No new dependencies for Phase 1**. Pure TypeScript/Python adjacency lists.

---

## Critical Files to Reuse

| File                                       | What it provides                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/backend/src/agents/user-rules.ts`    | All YAML loaders: `getDatasetBundles()`, `getSemanticModels()`, `getBusinessRules()`, `getPolicies()`, `getClassifications()` |
| `apps/shared/src/tools/build-contract.ts`  | Zod schemas for all types (DatasetBundle, Policy, Contract) — graph types must align                                          |
| `cli/dazense_core/semantic/models.py`      | Python Pydantic models for semantic model YAML                                                                                |
| `cli/dazense_core/rules/models.py`         | Python Pydantic models for business rules YAML                                                                                |
| `cli/dazense_core/commands/validate.py`    | Existing procedural cross-file checks — candidate for refactoring to use graph queries                                        |
| `apps/backend/src/policy/policy-engine.ts` | Policy engine — future integration point for graph-powered checks                                                             |

---

## Verification Plan

1. **Compile test**: Build graph from example project → assert invariants (non-zero nodes/edges, unique IDs, no dangling edges)
2. **Lineage test**: `lineageOf("measure:jaffle_shop/orders.total_revenue")` returns column, table, bundle, 2 rules
3. **Impact test**: `impactOf("column:duckdb-jaffle-shop/main.orders/amount")` returns 5+ measures
4. **Gap test**: Remove a PII policy entry → `findUnblockedPiiColumns()` detects uncovered column
5. **Simulation test**: `simulate(remove=["rule:exclude_returned_orders"])` → reports `measure:orders.total_revenue` loses governance
6. **CLI test**: `dazense graph lineage orders.total_revenue` prints readable tree with Rich formatting
7. **Canonical ID test**: Rename model display name, rebuild graph → same node IDs, lineage intact
8. **Parity test**: TS and Python compilers produce identical normalized IR for the same fixture project
9. **Regression**: Existing `dazense validate` and `dazense eval` still pass unchanged

---

## Relationship to Existing V1

This plan builds **on top of** V1 (contracts, policies, bundles, semantic models). It does not replace any V1 code — it adds a new layer that reads the same YAML files and provides graph-powered queries. All existing tools, gates, and CLI commands continue to work unchanged.

The graph becomes the foundation for:

- Smarter `dazense validate` (graph gap queries instead of procedural checks)
- Smarter `dazense eval` (auto-generated test cases from graph analysis)
- Contract provenance queries (which rules/columns were involved in a decision)
- Change impact analysis before modifying governance config

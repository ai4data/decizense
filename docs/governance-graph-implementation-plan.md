# Governance Graph — Implementation Plan

> **Status**: Phase 1 + Phase 2 implemented. CLI commands operational, contract ingestion wired.

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

#### Incremental compile strategy

The compiler tracks file hashes to avoid full rebuilds when only one source file changes:

1. On first compile: hash each source file (dataset.yaml, semantic_model.yml, etc.), store in `_fileHashes`.
2. On recompile: compare current hashes to stored. Only re-process changed files.
3. **Partial rebuild**: changed files emit new/updated nodes+edges; unchanged portions carry over from the previous IR.
4. **Invalidation rule**: if a file's hash changes, all nodes sourced from that file are dropped and re-emitted. Cross-file edges (e.g., `APPLIES_TO` from rules → models) are re-resolved against the full node set.

> **Phase 1 note**: implement the `_fileHashes` tracking and staleness detection, but do full rebuilds. Partial rebuild optimization deferred until performance requires it.

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
| `ALLOWS_JOIN`          | Bundle → JoinEdge         | Bundle pre-approves this join       |
| `JOIN_LEFT`            | JoinEdge → Table          | Left side of the join               |
| `JOIN_RIGHT`           | JoinEdge → Table          | Right side of the join              |

> **Join edge modeling**: The original `ALLOWS_JOIN: Bundle → (Table, Table)` was a hyperedge — not representable in a standard adjacency list. Instead, we introduce a `JoinEdge` intermediary node. Each approved join becomes: `Bundle --ALLOWS_JOIN--> JoinEdge --JOIN_LEFT--> Table` and `JoinEdge --JOIN_RIGHT--> Table`. This keeps the graph as a proper directed graph with binary edges only.

Contract edges (Phase 2+):

| Edge         | From → To              | Semantic                         |
| ------------ | ---------------------- | -------------------------------- |
| `TOUCHED`    | Contract → Table       | Query accessed this table        |
| `USED`       | Contract → Measure     | Query used this metric           |
| `REFERENCED` | Contract → Rule        | Contract cited this rule         |
| `DECIDED`    | Contract → PolicyCheck | Decision trace edge (pass/warn)  |
| `FAILED`     | Contract → PolicyCheck | Decision trace edge (fail/block) |

> **DECIDED vs FAILED**: Splitting decision traces into two edge types allows queries like "show me all blocking checks" without filtering on properties — just follow `FAILED` edges.

---

## Node Types

| Node Type        | ID Pattern                                    | Source                    | Properties                           |
| ---------------- | --------------------------------------------- | ------------------------- | ------------------------------------ |
| `Bundle`         | `bundle:{bundle_id}`                          | `datasets/*/dataset.yaml` | display_name, certification, owners  |
| `Table`          | `table:{db_id}/{schema}.{table}`              | bundle tables             | schema, database_type                |
| `Column`         | `column:{db_id}/{schema}.{table}/{col}`       | semantic dims + PII decls | data_type, is_pii                    |
| `Model`          | `model:{bundle_id}/{model}`                   | `semantic_model.yml`      | table, primary_key, time_dimension   |
| `Dimension`      | `dim:{bundle_id}/{model}.{dim}`               | semantic model            | column, description                  |
| `Measure`        | `measure:{bundle_id}/{model}.{measure}`       | semantic model            | type, column, filters                |
| `Rule`           | `rule:{name}`                                 | `business_rules.yml`      | category, severity, guidance         |
| `Classification` | `class:{name}`                                | business_rules.yml        | tags[]                               |
| `Policy`         | `policy:root`                                 | `policy.yml`              | pii_mode, max_rows, require_contract |
| `JoinEdge`       | `join:{bundle_id}/{left_table}:{right_table}` | bundle joins              | join_type, description               |
| `Contract`       | `contract:{id}`                               | `contracts/runs/*.json`   | created_at, decision, actor          |
| `PolicyCheck`    | `check:{contract_id}/{check_name}`            | contract policy checks    | status (pass/fail/warn), detail      |

---

## PII Gap Semantics

PII coverage detection uses two independent edge types:

- `CLASSIFIES`: `class:PII --CLASSIFIES--> column:X` — marks the column as PII
- `BLOCKS`: `policy:root --BLOCKS--> column:X` — policy restricts access to the column

**A gap exists** when a column has an inbound `CLASSIFIES` edge from `class:PII` but **no** inbound `BLOCKS` edge from `policy:root`. The helper `findUnblockedPiiColumns()` implements this check.

---

## Model → Table Resolution

When a semantic model references a table name (e.g., `orders`), the compiler must resolve it to a canonical table ID. In multi-database bundles, ambiguity is possible.

**Deterministic resolution rule**:

1. If the model specifies `database`, use it directly: `table:{database}/{schema}.{table}`
2. If no `database` field, resolve using the bundle's `warehouse.database_id`: `table:{bundle.warehouse.database_id}/{schema}.{table}`
3. If multiple bundles contain the same table name, the model's parent bundle takes precedence.
4. If still ambiguous, emit a compile warning (not error) and pick the first match alphabetically — deterministic but flagged.

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
    - PII columns without `BLOCKS` edge from policy (via `findUnblockedPiiColumns()`)

4. **Change impact simulation**: "If I remove rule X, which measures lose governance?"
   → Delete rule node from copy of graph, re-run gap detection

### Decision-trace queries (Phase 2 — with contracts)

5. **Decision trace**: "Why was contract X blocked?"
   → `contract:X` → `FAILED` → PolicyCheck nodes with detail

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

| #   | File                                         | Purpose                                                                                      |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | `apps/backend/src/graph/types.ts`            | `NodeType`, `EdgeType` enums, `GraphNode`, `GraphEdge` interfaces                            |
| 2   | `apps/backend/src/graph/governance-graph.ts` | `GovernanceGraph` class — adjacency list, traversal, query methods                           |
| 3   | `apps/backend/src/graph/graph-builder.ts`    | `buildFromProject(projectFolder)` — the compiler: reads YAML via existing loaders, emits IR  |
| 4   | `cli/dazense_core/graph/__init__.py`         | Module init                                                                                  |
| 5   | `cli/dazense_core/graph/types.py`            | Pydantic models mirroring TS types                                                           |
| 6   | `cli/dazense_core/graph/governance_graph.py` | Python standalone compiler + graph (reads YAML directly, no backend needed)                  |
| 7   | `schemas/governance-graph.schema.json`       | Canonical IR schema — generated from TS types via `zod-to-json-schema` (not hand-maintained) |

> **Schema file note**: The JSON schema is a **derived artifact**, generated from the TS Zod definitions. It is not a third source of truth — TS types are authoritative, Pydantic models must match, and the JSON schema is auto-generated for external consumers and validation.

**Core API (both TS and Python):**

```
GovernanceGraph
  .compile(projectFolder) → GovernanceGraph    // the compiler
  .getNode(id) → GraphNode | null
  .neighbors(id, edgeType?, direction?) → GraphNode[]
  .impactOf(id) → GraphNode[]                  // transitive downstream
  .lineageOf(id) → GraphNode[]                 // transitive upstream
  .findGaps(sourceType, requiredEdge, targetType) → GraphNode[]
  .findUnblockedPiiColumns() → GraphNode[]     // PII columns without BLOCKS edge
  .simulate(removals: string[]) → GapReport    // change impact simulation
  .stats() → { nodes_by_type, edges_by_type }
  .toJSON() → { nodes[], edges[] }
```

**Reuses existing loaders** — no YAML parsing duplication:

- TS: `getDatasetBundles()`, `getSemanticModels()`, `getBusinessRules()`, `getPolicies()`, `getClassifications()` from `apps/backend/src/agents/user-rules.ts`
- Python: `SemanticModel.load()` from `dazense_core/semantic/models.py` and `BusinessRules.load()` from `dazense_core/rules/models.py`

### TS/Python Parity Requirement

The **core graph data structure and traversal API** must produce identical results in both TS and Python given the same YAML input. Specifically:

- `compile()` must produce the same nodes and edges (same IDs, same edge types)
- `lineageOf()`, `impactOf()`, `findGaps()`, `simulate()` must return the same node sets
- `toJSON()` output must be structurally identical

**Not in parity scope**: CLI-only features (Rich output, `suggest-tests`), backend-only features (contract ingestion, policy engine integration). These are language-specific consumers of the shared IR.

A **parity test** enforces this: compile the same fixture project in both languages, compare `toJSON()` output.

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

**Contract integration via separate ingester**: A new `contract-ingester.ts` (or function within graph-builder) reads stored contract JSON files and emits Contract + PolicyCheck nodes with `TOUCHED`, `USED`, `REFERENCED`, `DECIDED`, and `FAILED` edges. The existing `contract-writer.ts` remains storage-only — it writes contract JSON to disk and is not modified.

### Out of scope (future)

- **as_of versioning**: Graph snapshots per git commit. Requires git integration.
- **OpenMetadata merge**: Precedence rules for OM imports. Requires OM integration to exist first.
- **Visualization**: D3.js/Cytoscape.js frontend component.
- **SQLite persistence**: For historical contract lineage queries at scale.
- **Incremental partial rebuild**: File hash tracking is implemented in Phase 1 but actual partial rebuilds deferred until performance requires it.

### Architecture decisions

- **Python builds standalone** from YAML (no backend dependency). CLI works offline.
- **YAML = source of truth**. Graph is ephemeral IR, rebuilt on every `compile()`.
- **Canonical IDs** use composite keys (`warehouse_id/schema.table`) not display names.
- **JSON schema is derived**, generated from TS Zod types — never hand-edited.
- **Contract-writer untouched**. Contract ingestion is a read-only graph-builder concern, not a storage concern.

---

## Critical files to reuse

| File                                       | What it provides                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/backend/src/agents/user-rules.ts`    | All YAML loaders: `getDatasetBundles()`, `getSemanticModels()`, `getBusinessRules()`, `getPolicies()`, `getClassifications()` |
| `apps/shared/src/tools/build-contract.ts`  | Zod schemas for all types (DatasetBundle, Policy, Contract) — graph types must align                                          |
| `cli/dazense_core/semantic/models.py`      | Python Pydantic models for semantic model YAML                                                                                |
| `cli/dazense_core/rules/models.py`         | Python Pydantic models for business rules YAML                                                                                |
| `apps/backend/src/policy/policy-engine.ts` | Policy engine — future integration point for graph-powered checks                                                             |

---

## Verification

Tests use **invariants** (structural properties that must always hold) rather than brittle counts tied to a specific fixture.

### Invariant-based tests (Phase 1)

1. **Compile roundtrip**: `toJSON(compile(project))` is valid against `governance-graph.schema.json`
2. **Every measure has an AGGREGATES edge**: No measure node exists without at least one outbound `AGGREGATES` edge to a column
3. **Every dimension has a READS edge**: No dimension node exists without an outbound `READS` edge
4. **Every model has a WRAPS edge**: No model node exists without an outbound `WRAPS` edge to a table
5. **Every bundle CONTAINS at least one table**: No bundle node exists without at least one `CONTAINS` edge
6. **Lineage terminates at physical nodes**: `lineageOf(any_measure)` always includes at least one `Table` and one `Column` node
7. **Impact terminates at semantic nodes**: `impactOf(any_column)` returns only `Measure`, `Dimension`, or `Rule` nodes (not other columns)
8. **PII gap detection**: Given a fixture with one PII column and no BLOCKS edge, `findUnblockedPiiColumns()` returns exactly that column
9. **Simulation is non-destructive**: After `simulate(remove=[...])`, the original graph is unchanged (same node/edge counts)
10. **Canonical ID stability**: Rename a model's `display_name` in YAML, recompile → same node IDs, same edges
11. **JoinEdge decomposition**: Every `ALLOWS_JOIN` edge targets a `JoinEdge` node, and every `JoinEdge` has exactly one `JOIN_LEFT` and one `JOIN_RIGHT` edge

### Parity test

12. **TS/Python produce identical IR**: Compile the same fixture project in both languages. Assert `toJSON()` output matches (node IDs, edge types, edge endpoints). Differences fail CI.

### Regression

13. **Existing CLI commands unaffected**: `dazense test` and other existing commands still pass unchanged after graph module is added.

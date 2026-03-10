# Plan: Add Semantic Layer + Business Rules to dazense

> **Status note:** The semantic layer (`semantic_model.yml` + `query_metrics`) and guidance rules (`business_rules.yml`) are implemented in dazense.
> The V1 Trusted Analytics Copilot (enforcement layer) is also implemented: contracts, policy engine, SQL validator, `build_contract` tool, gated execution, `dazense validate` CLI, and provenance. See `docs/trusted-analytics-copilot-implementation_plan.md` for the full spec and `docs/TESTING_V1.md` for a testing tutorial.
> This document is kept for historical context. The current roadmap lives in `docs/plan.md` under “Roadmap (Trusted Analytics Copilot)”.

## Context

dazense's agent currently writes **raw SQL from scratch every time** — it reads schema markdown, infers joins, and generates queries. This causes inconsistent answers, wrong joins, and no metric governance. We're adding two features from the datazense project:

1. **Semantic Layer** — YAML-defined metrics/dimensions, translated to SQL via Ibis (already a dependency)
2. **Business Rules Engine** — YAML-defined caveats, rules, and classifications

Both are **optional** — projects without these files work exactly as today.

---

## Implementation Steps (8 steps, in dependency order)

### Step 1: Python Semantic Models

Create `cli/dazense_core/semantic/` module with Pydantic models to parse `semantic_model.yml`.

**New files:**

- `cli/dazense_core/semantic/__init__.py`
- `cli/dazense_core/semantic/models.py` — `SemanticModel`, `ModelDefinition`, `Measure`, `Dimension`, `JoinDefinition` (Pydantic models)

**YAML format** (placed in `semantics/semantic_model.yml` in project folder):

```yaml
models:
    orders:
        table: orders
        schema: main
        database: my-db # optional, for multi-db projects
        description: Core orders table
        time_dimension: order_date
        dimensions:
            status:
                column: status
                description: Order status
            customer_id:
                column: user_id
        measures:
            order_count:
                type: count # count, sum, avg, min, max, count_distinct
            total_amount:
                column: amount
                type: sum
        joins:
            customer:
                to_model: customers
                foreign_key: user_id
                related_key: customer_id
                type: many_to_one # many_to_one, one_to_one, one_to_many
```

**Aggregation types:** `count`, `sum`, `avg`, `min`, `max`, `count_distinct`. Measures with type `count` don't need a `column`. All others require `column`.

### Step 2: Semantic Engine (Ibis translator)

Create the core YAML-to-Ibis translator.

**New file:**

- `cli/dazense_core/semantic/engine.py` — `SemanticEngine` class (~200 lines)

**Interface:**

```python
class SemanticEngine:
    def __init__(self, model: SemanticModel, databases: list[AnyDatabaseConfig]): ...

    def query(
        self,
        model_name: str,
        measures: list[str],
        dimensions: list[str] = [],
        filters: list[dict] = [],
        order_by: list[dict] = [],
        limit: int | None = None,
    ) -> list[dict]:
        """Translate metric query to Ibis, execute, return rows as dicts."""

    def get_model_info(self, model_name: str) -> dict:
        """Return model metadata (dimensions, measures, joins)."""
```

**Translation logic:**

1. Resolve model -> get table name, schema, database
2. Connect to database via `db_config.connect()` (Ibis)
3. Get table reference via `conn.table(table_name, database=schema)`
4. Resolve joins if dimensions reference joined models (e.g., `customer.name`)
5. Build Ibis expression: `table.group_by([dims]).aggregate([measures])`
6. Apply filters via `.filter()`
7. Apply order_by via `.order_by()`
8. Apply limit via `.limit()`
9. Execute via `.execute()` -> returns pandas DataFrame -> convert to list[dict]

**Reuses:** `DazenseConfig.databases` for connections, `db_config.connect()` for Ibis backends — same pattern as `DatabaseContext` in `cli/dazense_core/commands/sync/providers/databases/context.py`.

### Step 3: Python Business Rules

**New files:**

- `cli/dazense_core/rules/__init__.py`
- `cli/dazense_core/rules/models.py` — `BusinessRules`, `BusinessRule` (Pydantic models)

**YAML format** (placed in `semantics/business_rules.yml`):

```yaml
rules:
    - name: cash_tips_not_recorded
      category: data_quality
      severity: critical
      applies_to: [tip_amount]
      description: Cash tips are NOT recorded in the data
      guidance: Exclude cash payments from tip analysis

    - name: revenue_definition
      category: metrics
      applies_to: [orders.total_revenue]
      description: Revenue is sum of amount excluding cancelled orders
      guidance: Always filter status != 'cancelled'
```

**Interface:**

```python
class BusinessRules:
    @classmethod
    def load(cls, project_path: Path) -> BusinessRules | None: ...
    def filter_by_category(self, category: str) -> list[BusinessRule]: ...
    def filter_by_concept(self, concepts: list[str]) -> list[BusinessRule]: ...
    def get_categories(self) -> list[str]: ...
```

### Step 4: FastAPI Endpoints

**Modified file:** `apps/backend/fastapi/main.py`

Add 2 new endpoints following the existing `/execute_sql` pattern:

**`POST /query_metrics`** — Loads semantic model, executes via SemanticEngine

- Request: `{ dazense_project_folder, model_name, measures[], dimensions[]?, filters[]?, order_by[]?, limit?, database_id? }`
- Response: `{ data[], row_count, columns[], model_name, measures[], dimensions[] }`
- Returns 400 if no `semantic_model.yml` exists

**`POST /business_context`** — Loads business rules, filters by category/concepts

- Request: `{ dazense_project_folder, category?, concepts[]? }`
- Response: `{ rules[], categories[] }`
- Returns 400 if no `business_rules.yml` exists

### Step 5: Shared Zod Schemas

**New files:**

- `apps/shared/src/tools/query-metrics.ts` — Zod InputSchema/OutputSchema
- `apps/shared/src/tools/get-business-context.ts` — Zod InputSchema/OutputSchema

**Modified file:** `apps/shared/src/tools/index.ts` — add 2 exports

Query metrics output includes `id: query_${uuid}` (same pattern as execute-sql) so `display_chart` can reference it.

### Step 6: Agent Tools + Tool Outputs

**New files:**

- `apps/backend/src/agents/tools/query-metrics.ts` — uses `createTool()`, calls FastAPI `/query_metrics`
- `apps/backend/src/agents/tools/get-business-context.ts` — uses `createTool()`, calls FastAPI `/business_context`
- `apps/backend/src/components/tool-outputs/query-metrics.tsx` — JSX model output (follows ExecuteSqlOutput pattern)
- `apps/backend/src/components/tool-outputs/get-business-context.tsx` — JSX model output

**Modified files:**

- `apps/backend/src/components/tool-outputs/index.ts` — add 2 exports

Both tools follow the exact pattern of `execute-sql.ts`: fetch from `http://localhost:${env.FASTAPI_PORT}/endpoint`.

### Step 7: System Prompt Updates

**Modified files:**

- `apps/backend/src/agents/user-rules.ts` — add `getSemanticModels()` and `getBusinessRules()` functions that read the YAML files and return structured info
- `apps/backend/src/components/system-prompt.tsx` — add two new conditional JSX sections:
    - **Semantic Layer** section (when `semantic_model.yml` exists): lists available models, their measures, dimensions
    - **Business Rules** section (when `business_rules.yml` exists): lists critical rules

**New dependency:** `yaml` npm package in `apps/backend` (for parsing YAML on the TypeScript side)

### Step 8: Tool Registration

**Modified file:** `apps/backend/src/agents/tools/index.ts`

Conditionally register `query_metrics` and `get_business_context` tools — only when the respective YAML files exist in the project folder (same pattern as `execute_python` conditional registration).

---

## Example Semantic Model for jaffle_shop

This goes in `example/semantics/semantic_model.yml`:

```yaml
models:
    customers:
        table: customers
        schema: main
        primary_key: customer_id
        dimensions:
            customer_id:
                column: customer_id
            first_name:
                column: first_name
            last_name:
                column: last_name
        measures:
            customer_count:
                type: count

    orders:
        table: orders
        schema: main
        primary_key: order_id
        time_dimension: order_date
        dimensions:
            status:
                column: status
        measures:
            order_count:
                type: count
            total_amount:
                column: amount
                type: sum
            avg_order_value:
                column: amount
                type: avg
        joins:
            customer:
                to_model: customers
                foreign_key: user_id
                related_key: customer_id
                type: many_to_one
```

---

## Files Summary

### New files (14):

| File                                                                | Purpose                           |
| ------------------------------------------------------------------- | --------------------------------- |
| `cli/dazense_core/semantic/__init__.py`                             | Package init                      |
| `cli/dazense_core/semantic/models.py`                               | Pydantic YAML models (~100 lines) |
| `cli/dazense_core/semantic/engine.py`                               | Ibis query builder (~200 lines)   |
| `cli/dazense_core/rules/__init__.py`                                | Package init                      |
| `cli/dazense_core/rules/models.py`                                  | Pydantic rules models (~60 lines) |
| `cli/tests/dazense_core/semantic/test_models.py`                    | YAML parsing tests                |
| `cli/tests/dazense_core/semantic/test_engine.py`                    | Integration tests with DuckDB     |
| `cli/tests/dazense_core/rules/test_models.py`                       | Rules parsing tests               |
| `apps/shared/src/tools/query-metrics.ts`                            | Zod schemas                       |
| `apps/shared/src/tools/get-business-context.ts`                     | Zod schemas                       |
| `apps/backend/src/agents/tools/query-metrics.ts`                    | Agent tool (~45 lines)            |
| `apps/backend/src/agents/tools/get-business-context.ts`             | Agent tool (~40 lines)            |
| `apps/backend/src/components/tool-outputs/query-metrics.tsx`        | Output renderer                   |
| `apps/backend/src/components/tool-outputs/get-business-context.tsx` | Output renderer                   |

### Modified files (7):

| File                                                | Changes                                         |
| --------------------------------------------------- | ----------------------------------------------- |
| `apps/backend/fastapi/main.py`                      | Add 2 endpoints + Pydantic models               |
| `apps/shared/src/tools/index.ts`                    | Add 2 export lines                              |
| `apps/backend/src/components/tool-outputs/index.ts` | Add 2 export lines                              |
| `apps/backend/src/agents/tools/index.ts`            | Add 2 imports + conditional registration        |
| `apps/backend/src/agents/user-rules.ts`             | Add `getSemanticModels()`, `getBusinessRules()` |
| `apps/backend/src/components/system-prompt.tsx`     | Add semantic layer + business rules sections    |
| `apps/backend/package.json`                         | Add `yaml` dependency                           |

### Example files (2):

| File                                   | Purpose                                |
| -------------------------------------- | -------------------------------------- |
| `example/semantics/semantic_model.yml` | Example semantic model for jaffle_shop |
| `example/semantics/business_rules.yml` | Example business rules                 |

**Total new code: ~650 lines**
**No new Python dependencies** (Ibis + PyYAML already installed)
**One new Node dependency:** `yaml` npm package

---

## Verification

1. **Python tests:** `cd cli && python -m pytest tests/dazense_core/semantic/ tests/dazense_core/rules/ -v`
2. **Lint Python:** `cd cli && make lint`
3. **Lint TypeScript:** `cd apps && npm run lint`
4. **Manual E2E test:** Run `npm run dev`, open chat, ask "What is the total order amount?" — agent should use `query_metrics` tool instead of writing raw SQL
5. **Fallback test:** Remove `semantic_model.yml`, ask same question — agent should fall back to `execute_sql` as before

# Testing V1.6 — Graph-as-Tools

## What's New in V1.6

V1.6 exposes the governance graph to the AI agent as callable tools. Previously, the graph was only available via the CLI. Now the agent can query it during a conversation to explain, trace, and audit governance in real time.

**New agent tools:**

| Tool            | Purpose                                      |
| --------------- | -------------------------------------------- |
| `graph_explain` | Explain an entity — properties, edges, rules |
| `graph_lineage` | Trace upstream dependencies                  |
| `graph_impact`  | Measure downstream blast radius              |
| `graph_gaps`    | Find governance coverage gaps                |

**Other V1.6 changes:**

- Catalog-agnostic enrichment (`CatalogEnrichmentProvider` ABC)
- PII gap detection from external catalog tags
- Auto-enrichment in `graph gaps` command
- Entity ID resolver (short names like `total_revenue` resolve to full canonical IDs)

---

## Part 1 — CLI Tests

All CLI tests run from the example project directory. No server needed.

```bash
cd C:\Users\hzmarrou\OneDrive\python\learning\dazense\example
```

### 1.1 Graph overview

```bash
dazense graph show
```

Expected: 77 nodes (1 Bundle, 3 Tables, 23 Columns, 3 Models, 14 Dimensions, 18 Measures, 10 Rules, 2 Classifications, 1 Policy, 2 JoinEdges) and 102 edges.

### 1.2 Lineage

```bash
dazense graph lineage orders.total_revenue
```

Expected: shows upstream chain — `total_revenue` reads `amount` column from `orders` table, which belongs to the `jaffle_shop` bundle.

### 1.3 Impact

```bash
dazense graph impact main.orders.amount
```

Expected: 4 measures (`total_revenue`, `avg_order_value`, `min_order_value`, `max_order_value`), 2 models (`orders`, `payments`), 7 rules.

### 1.4 Gap analysis

```bash
dazense graph gaps --check pii
```

Expected: flags any columns classified as PII (from catalog tags) that are not blocked by policy. If `openmetadata/` directory has `email` tagged as `PII.Email`, it should show as a gap.

```bash
dazense graph gaps --check all
```

Expected: shows PII gaps + model gaps + rule gaps across the full graph.

### 1.5 Simulate removal

```bash
dazense graph simulate --remove "column:duckdb-jaffle-shop/main.orders/amount"
```

Expected: shows the blast radius — measures, models, and rules that would break if the `amount` column is removed.

### 1.6 Validate configuration

```bash
dazense validate
```

Expected: checks consistency across semantic model, business rules, policy, and dataset bundles.

---

## Part 2 — UI Tests

Start the dev server from the monorepo root:

```bash
cd C:\Users\hzmarrou\OneDrive\python\learning\dazense
npm run dev
```

Open the chat UI in your browser (typically `http://localhost:3000`).

### 2.1 Graph explain — "Why is something blocked?"

Ask:

> Why is first_name blocked?

Expected: The agent calls `graph_explain`. Response should mention:

- `first_name` is a Column node
- Classified as PII (`CLASSIFIES` edge)
- Blocked by policy (`BLOCKS` edge)
- Governed by rule `pii_customer_names`

### 2.2 Graph impact — "What depends on X?"

Ask:

> What depends on the amount column?

Expected: The agent calls `graph_impact`. Response should list:

- 4 measures: `total_revenue`, `avg_order_value`, `min_order_value`, `max_order_value`
- 2 models: `orders`, `payments`
- 7 rules including `exclude_returned_orders_from_revenue`

### 2.3 Graph lineage — "What does this depend on?"

Ask:

> What does total_revenue depend on?

Expected: The agent calls `graph_lineage`. Response should show the upstream chain: `amount` column → `orders` table → `jaffle_shop` bundle.

### 2.4 Graph gaps — "Where is governance missing?"

Ask:

> Where are we missing governance?

Expected: The agent calls `graph_gaps` with check `all`. Response should list any PII gaps, model gaps, or rule gaps found in the graph.

### 2.5 Verify existing tools still work

These should work the same as before V1.6.

Ask:

> What is the total revenue?

Expected: Agent uses `query_metrics` with `total_revenue` measure. Result: ~$1,585 (excludes returned orders).

Ask:

> Show me first_name and last_name of the top 5 customers

Expected: Blocked by PII policy. Agent explains why and suggests alternatives.

---

## Part 3 — Python Unit Tests

Run the governance graph test suite:

```bash
cd C:\Users\hzmarrou\OneDrive\python\learning\dazense\cli
uv run pytest tests/dazense_core/graph/ -v
```

Expected: 21 tests pass (graph compilation, lineage, impact, gaps, PII detection, catalog enrichment, custom provider).

---

## Part 4 — TypeScript Build Check

Verify the backend compiles without errors:

```bash
cd C:\Users\hzmarrou\OneDrive\python\learning\dazense
npm run lint:backend
```

Expected: zero errors, zero warnings.

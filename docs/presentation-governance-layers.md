# dazense — Governance Layers for Analytics Agents

---

## Slide 1: The Problem

An LLM-based agent with `execute_sql` access to a database has no constraints.

| Failure mode      | Cause                                                                       |
| ----------------- | --------------------------------------------------------------------------- |
| Wrong aggregation | `SUM(amount)` includes returned orders → $1,672 instead of $1,585           |
| PII exposure      | `SELECT first_name, last_name` returns personally identifiable data         |
| Scope violation   | Agent queries `main.raw_customers` — a staging table outside intended scope |
| Non-determinism   | Same question, different SQL, different results across sessions             |
| No audit trail    | No record of what was queried, why it was allowed, or what rules applied    |

The database executes whatever SQL it receives. There is no enforcement layer.

---

## Slide 2: Architecture — Governance Between Agent and Database

```
User question (natural language)
       ↓
   LLM Agent
       ↓
  ┌─────────────────────────────────┐
  │  dazense governance stack       │
  │                                 │
  │  L1  Semantic Layer             │  → metric definitions, baked-in filters
  │  L2  Business Rules             │  → domain constraints, classifications
  │  L3  Dataset Bundle             │  → table/join allowlist, time filters
  │  L4  Policy Engine              │  → PII blocking, SQL validation, limits
  │  L5  Governance Graph           │  → lineage, impact, gap analysis
  └─────────────────────────────────┘
       ↓
   Database (DuckDB / PostgreSQL / BigQuery / Snowflake / Databricks)
```

Each layer is optional and additive. They compose incrementally.

---

## Slide 3: L1 — Semantic Layer

File: `semantics/semantic_model.yml`

Defines models, dimensions, measures, joins. Measures have baked-in filters.

```yaml
orders:
    table: orders
    schema: main
    primary_key: order_id
    time_dimension: order_date
    measures:
        total_revenue:
            column: amount
            type: sum
            filters:
                - column: status
                  operator: not_in
                  value: ['returned', 'return_pending']
    joins:
        customer:
            to_model: customers
            foreign_key: customer_id
            type: many_to_one
```

**Effect**: Agent uses `query_metrics(model=orders, measure=total_revenue)` instead of raw SQL. The filter is applied at the engine level (Ibis → DuckDB/Postgres/BigQuery/Snowflake). Result is deterministic.

Supported measure types: `count`, `count_distinct`, `sum`, `avg`, `min`, `max`.

---

## Slide 4: L2 — Business Rules & Classifications

File: `semantics/business_rules.yml`

Rules are domain constraints injected into the agent's context. Classifications tag columns.

```yaml
rules:
    - name: exclude_returned_orders_from_revenue
      severity: critical
      applies_to: [orders.total_revenue, orders.avg_order_value]
      description: Revenue metrics must exclude returned/return_pending orders.
      guidance: >
          WHERE status NOT IN ('returned', 'return_pending')

    - name: pii_customer_names
      severity: critical
      applies_to: [customers.first_name, customers.last_name]
      description: first_name and last_name are PII.

classifications:
    - name: PII
      columns: [customers.first_name, customers.last_name]
      tags: [sensitive, restricted]
    - name: Financial
      columns: [orders.amount, customers.customer_lifetime_value]
      tags: [financial]
```

**Effect**: Critical rules are injected into the LLM system prompt. The agent calls `get_business_context` tool to look up applicable rules before constructing a query. Classifications create `CLASSIFIES` edges in the governance graph.

---

## Slide 5: L3 — Dataset Bundle

File: `datasets/jaffle_shop/dataset.yaml`

A trust boundary: which tables, which joins, which time constraints the agent can use.

```yaml
bundle_id: jaffle_shop
warehouse:
    type: duckdb
    database_id: duckdb-jaffle-shop
tables:
    - { schema: main, table: customers }
    - { schema: main, table: orders }
    - { schema: main, table: stg_payments }
joins:
    - left: { table: orders, column: customer_id }
      right: { table: customers, column: customer_id }
      type: many_to_one
defaults:
    require_time_filter_for_tables: [main.orders]
    max_rows: 200
```

**Effect**: Query referencing `main.raw_customers` → rejected (not in bundle). Query joining `orders` to an undeclared table → rejected. Query on `orders` without a time filter → `needs_clarification` response with available date range.

---

## Slide 6: L4 — Policy Engine

File: `policies/policy.yml`

Hard enforcement at query time. No bypass.

```yaml
pii:
    mode: block
    columns:
        main.customers: [first_name, last_name]
joins:
    enforce_bundle_allowlist: true
    allow_cross_bundle: false
execution:
    require_bundle: true
    sql_validation:
        mode: parse
        disallow_multi_statement: true
        enforce_limit: true
```

**Enforcement matrix**:

| Query                                   | Check                      | Result                            |
| --------------------------------------- | -------------------------- | --------------------------------- |
| `SELECT first_name FROM customers`      | `pii_block`                | blocked                           |
| `SELECT * FROM customers`               | `pii_block_star`           | blocked (wildcard expands to PII) |
| `SELECT * FROM raw_customers`           | `bundle_tables_only`       | blocked                           |
| `DROP TABLE x; SELECT 1`                | `disallow_multi_statement` | blocked                           |
| `SELECT * FROM orders` (no time filter) | `time_filter_required`     | needs_clarification               |

The agent receives a structured response with the check that failed and guidance for the user.

---

## Slide 7: L5 — Governance Graph

Compiled from all four layers into a typed directed graph.

**Node types**: Bundle, Table, Column, Model, Dimension, Measure, Rule, Classification, Policy

**Edge types**: CONTAINS, HAS_COLUMN, AGGREGATES, READS, APPLIES_TO, CLASSIFIES, BLOCKS, JOINS, WRAPS, REQUIRES_TIME_FILTER

```
bundle:jaffle_shop ──CONTAINS──→ table:main.orders
table:main.orders  ──HAS_COLUMN──→ column:main.orders/amount
measure:orders.total_revenue ──AGGREGATES──→ column:main.orders/amount
rule:exclude_returned_orders ──APPLIES_TO──→ measure:orders.total_revenue
class:PII ──CLASSIFIES──→ column:main.customers/first_name
class:PII ──BLOCKS──→ column:main.customers/first_name
```

**CLI queries**:

```bash
dazense graph show                              # node/edge counts
dazense graph lineage orders.total_revenue      # upstream dependencies
dazense graph impact main.orders.amount         # downstream blast radius
dazense graph gaps --check pii                  # unblocked PII columns
dazense graph simulate --remove column:main.orders/amount
```

---

## Slide 8: Graph-as-Tools (V1.6)

The governance graph is exposed to the LLM agent as 4 callable tools.

| Tool            | Input                                  | Output                                                |
| --------------- | -------------------------------------- | ----------------------------------------------------- |
| `graph_explain` | entity_id, optional question           | node properties, inbound/outbound edges, explanation  |
| `graph_lineage` | entity_id                              | upstream dependency chain grouped by type             |
| `graph_impact`  | entity_id                              | downstream affected nodes grouped by type             |
| `graph_gaps`    | check: `pii \| models \| rules \| all` | list of governance gaps with category and description |

**Entity resolution**: short names (`total_revenue`) resolve to canonical IDs (`measure:jaffle_shop/orders.total_revenue`).

Example interaction:

```
User:   "Why is first_name blocked?"
Agent → graph_explain("first_name")
Agent:  "column:jaffle_shop/main.customers/first_name is a Column node.
         Classified as PII (CLASSIFIES edge from class:PII).
         Blocked by policy (BLOCKS edge).
         Governed by rule pii_customer_names (APPLIES_TO edge)."
```

---

## Slide 9: Execution Flow

```
1. User: "What is the total revenue?"
2. Agent → get_business_context("revenue")
   Returns: rule exclude_returned_orders_from_revenue (critical)
3. Agent → build_contract(bundle=jaffle_shop, model=orders,
           measure=total_revenue, time_window=all_time)
   Policy engine checks: PII? bundle? joins? time filter? ambiguity?
   Returns: { outcome: "allow", contract_id: "c-1234" }
4. Agent → query_metrics(model=orders, measure=total_revenue,
           contract_id="c-1234")
   Semantic engine (Ibis) generates SQL with baked-in filter:
     SELECT SUM(amount) FROM orders
     WHERE status NOT IN ('returned', 'return_pending')
     AND order_date BETWEEN '2018-01-01' AND '2018-04-09'
5. Agent: "The total revenue is $1,585."
```

Every step is auditable: which rules were referenced, which contract was issued, which query was executed.

---

## Slide 10: Incremental Adoption

| Level | Layer added        | Agent capability                       | Enforcement                       |
| ----- | ------------------ | -------------------------------------- | --------------------------------- |
| 0     | Database only      | `execute_sql` — raw SQL                | None                              |
| 1     | + Semantic model   | `query_metrics` — pre-defined measures | Metric-level filters              |
| 2     | + Business rules   | `get_business_context` — domain lookup | Agent-guided                      |
| 3     | + Dataset bundle   | Bundle scoping                         | Table/join allowlist              |
| 4     | + Policy           | `build_contract` — pre-execution check | PII block, SQL validation, limits |
| 5     | + Governance graph | `graph_explain/lineage/impact/gaps`    | Explainability, gap detection     |

Each layer composes on top of the previous. No layer requires the others.

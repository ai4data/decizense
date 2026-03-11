# dazense Tutorial — From Zero to Governed Analytics

This tutorial walks you through setting up dazense from scratch using the **Jaffle Shop** example — a fictional e-commerce store with orders, customers, and payments.

By the end, you'll have:

- A dazense project connected to a database
- Synced schema documentation the AI agent can read
- A semantic layer with pre-defined metrics
- Business rules that enforce data quality
- Policies that block PII and enforce execution constraints
- A governance graph you can query for lineage, impact, and gaps
- A chat interface where you ask questions and get governed answers

---

## Prerequisites

```bash
pip install dazense-core
```

You also need an LLM API key (OpenAI, Anthropic, or Azure OpenAI) and a database to connect to. This tutorial uses DuckDB for simplicity.

---

## Step 1 — Initialize a Project

```bash
dazense init
```

The interactive wizard prompts you for:

1. **Project name** — e.g., `jaffle_shop`
2. **Database connections** — type, host, credentials
3. **LLM provider** — OpenAI, Anthropic, or Azure

For this tutorial, configure a DuckDB connection:

```
Database type: duckdb
Connection name: duckdb-jaffle-shop
Path: ./jaffle_shop.duckdb
```

This creates a project folder with the following structure:

```
jaffle_shop/
├── dazense_config.yaml     # Main configuration
├── RULES.md                # Custom instructions for the AI agent
├── .dazenseignore           # Exclude patterns
├── databases/               # Synced schema documentation
├── semantics/               # Semantic models & business rules
├── policies/                # Governance policies
├── datasets/                # Dataset bundles
├── repos/                   # Synced git repositories
├── docs/                    # Documentation
├── queries/                 # Saved queries
└── agent/
    ├── tools/               # Custom agent tools
    └── mcps/                # MCP server configs
```

After init, dazense automatically runs `dazense debug` to verify your database and LLM connections work.

---

## Step 2 — Understand the Configuration

Open `dazense_config.yaml`. It looks like this:

```yaml
project_name: jaffle_shop

databases:
    - name: duckdb-jaffle-shop
      type: duckdb
      path: ./jaffle_shop.duckdb
      accessors: [columns, preview]
      include: []
      exclude: []

llm:
    provider: openai
    api_key: "{{ env('OPENAI_API_KEY') }}"
```

Key points:

- **`accessors`** controls what metadata is generated per table: `columns` (column names/types), `preview` (sample rows), `description` (row counts)
- **`include`/`exclude`** filter which schemas or tables to sync
- **API keys** support Jinja2 templating — `{{ env('OPENAI_API_KEY') }}` reads from environment variables so you never hardcode secrets

---

## Step 3 — Sync Database Metadata

```bash
cd jaffle_shop
dazense sync
```

This connects to your database and generates markdown documentation:

```
databases/
└── type=duckdb/
    └── database=jaffle_shop/
        └── schema=main/
            ├── table=customers/
            │   ├── columns.md      # Column names and types
            │   ├── description.md  # Row count, metadata
            │   └── preview.md      # Sample rows (first 20)
            ├── table=orders/
            │   ├── columns.md
            │   ├── description.md
            │   └── preview.md
            └── table=stg_payments/
                ├── columns.md
                ├── description.md
                └── preview.md
```

The AI agent reads these files to understand your database — no need to query the database just to know what columns exist. This is faster and prevents accidental PII exposure during exploration.

You can sync specific providers:

```bash
dazense sync -p databases              # Only databases
dazense sync -p databases:duckdb-jaffle-shop  # Only one connection
```

---

## Step 4 — Start Chatting (No Governance)

At this point, you already have a working analytics agent:

```bash
dazense chat
```

This opens the chat UI at `http://localhost:5005`. You can ask:

> "How many orders are there?"

The agent uses `execute_sql` to write and run SQL against your database. It works, but there are problems:

- The agent might compute revenue **including** returned orders (wrong)
- It could expose **PII columns** like `first_name` and `last_name`
- It could query **any table**, even ones outside your intended scope
- Different users asking the same question might get different answers

This is where governance layers come in.

---

## Step 5 — Add a Semantic Layer

Create `semantics/semantic_model.yml`:

```yaml
models:
    customers:
        table: customers
        schema: main
        primary_key: customer_id
        dimensions:
            customer_id:
                column: customer_id
                description: Unique identifier for each customer
            first_name:
                column: first_name
                description: "Customer's first name (PII)"
            last_name:
                column: last_name
                description: "Customer's last name (PII)"
            number_of_orders:
                column: number_of_orders
                description: Count of orders placed by the customer
            customer_lifetime_value:
                column: customer_lifetime_value
                description: Total value (AUD) of the customer's orders
        measures:
            customer_count:
                type: count
                description: Total number of customers
            total_lifetime_value:
                column: customer_lifetime_value
                type: sum
                description: Sum of all customer lifetime values
            avg_lifetime_value:
                column: customer_lifetime_value
                type: avg
                description: Average customer lifetime value

    orders:
        table: orders
        schema: main
        primary_key: order_id
        time_dimension: order_date
        dimensions:
            order_id:
                column: order_id
                description: Unique identifier for each order
            customer_id:
                column: customer_id
                description: Foreign key to customers table
            order_date:
                column: order_date
                description: Date (UTC) the order was placed
            status:
                column: status
                description: >
                    Order fulfillment status. Accepted values: placed, shipped,
                    completed, return_pending, returned.
        measures:
            order_count:
                type: count
                description: Total number of orders
            total_revenue:
                column: amount
                type: sum
                description: 'Net revenue — excludes returned and return_pending orders.'
                filters:
                    - column: status
                      operator: not_in
                      value: ['returned', 'return_pending']
            avg_order_value:
                column: amount
                type: avg
                description: Average order value in AUD
        joins:
            customer:
                to_model: customers
                foreign_key: customer_id
                related_key: customer_id
                type: many_to_one
```

**What this gives you:**

- **`query_metrics` tool** — the agent now uses the semantic layer instead of raw SQL for metric questions
- **Baked-in filters** — `total_revenue` automatically excludes returned orders. Every user gets the same answer
- **Joins** — the agent knows how to join orders to customers correctly
- **Measure types** — `count`, `count_distinct`, `sum`, `avg`, `min`, `max`

Restart `dazense chat` and ask:

> "What is the total revenue?"

The agent now uses `query_metrics` with the `total_revenue` measure, which automatically excludes returned orders. Result: **$1,585** (not $1,672).

---

## Step 6 — Add Business Rules

Create `semantics/business_rules.yml`:

```yaml
rules:
    - name: exclude_returned_orders_from_revenue
      category: metrics
      severity: critical
      applies_to: [orders.total_revenue, orders.avg_order_value]
      description: Revenue metrics must exclude returned and return_pending orders.
      guidance: >
          Always add WHERE status NOT IN ('returned', 'return_pending') when computing
          revenue. Only 'completed', 'shipped', and 'placed' orders represent real revenue.

    - name: pii_customer_names
      category: privacy
      severity: critical
      applies_to: [customers.first_name, customers.last_name]
      description: first_name and last_name are personally identifiable information (PII).
      guidance: >
          Never include first_name or last_name in query results unless explicitly requested.
          For aggregates, use customer_id instead.

    - name: customer_type_classification
      category: metrics
      severity: warning
      applies_to: [customers]
      description: >
          Customers are classified as "new" (1 order) or "returning" (2+ orders).
      guidance: >
          Use: CASE WHEN number_of_orders > 1 THEN 'returning' ELSE 'new' END.

classifications:
    - name: PII
      description: Personally identifiable information — names, emails, phone numbers
      columns:
          - customers.first_name
          - customers.last_name
      tags: [sensitive, restricted]

    - name: Financial
      description: Monetary values that require careful aggregation
      columns:
          - orders.amount
          - customers.customer_lifetime_value
      tags: [financial]
```

**What this gives you:**

- **`get_business_context` tool** — the agent can look up rules before answering
- **Classifications** — columns tagged as PII, Financial, etc.
- **Critical rules** are injected into the system prompt so the agent always knows them

The agent now has context it needs to answer correctly: "revenue" means net revenue, customer names are PII, and there's a specific way to classify customers.

---

## Step 7 — Add a Dataset Bundle

Create `datasets/jaffle_shop/dataset.yaml`:

```yaml
version: 1
bundle_id: jaffle_shop
display_name: 'Jaffle Shop — Core Analytics'
description: >
    Orders, customers, and payments for the Jaffle Shop example project.

owners:
    - name: 'Data Team'

warehouse:
    type: duckdb
    database_id: duckdb-jaffle-shop

tables:
    - schema: main
      table: customers
    - schema: main
      table: orders
    - schema: main
      table: stg_payments

joins:
    - left: { schema: main, table: orders, column: customer_id }
      right: { schema: main, table: customers, column: customer_id }
      type: many_to_one
      description: 'Orders → Customers'

    - left: { schema: main, table: stg_payments, column: order_id }
      right: { schema: main, table: orders, column: order_id }
      type: many_to_one
      description: 'Payments → Orders'

defaults:
    time_column_by_table:
        main.orders: order_date
    max_rows: 200
    require_time_filter_for_tables:
        - main.orders
    data_start_date: '2018-01-01'
    demo_current_date: '2018-04-09'

certification:
    level: certified

use_cases:
    - id: order_analysis
      question_examples:
          - 'How many orders last month?'
          - 'Total revenue by status'
    - id: customer_analysis
      question_examples:
          - 'Top 10 customers by lifetime value'
          - 'New vs returning customers'
```

**What this gives you:**

- **Trust boundary** — only `customers`, `orders`, and `stg_payments` are in scope. The agent cannot query other tables
- **Allowed joins** — only declared joins are permitted
- **Time filter enforcement** — the orders table requires a date filter
- **Demo dates** — the agent uses `2018-04-09` as "today" for relative date calculations
- **Use cases** — example questions for the chat UI

A bundle is a **data product** — it's the deliberate scoping of what data the agent can touch and how.

---

## Step 8 — Add Policies

Create `policies/policy.yml`:

```yaml
version: 1

defaults:
    max_rows: 200
    max_preview_rows: 20
    require_limit_for_raw_rows: true
    require_time_filter_for_fact_tables: true
    time_filter_max_days_default: 90

pii:
    mode: block
    tags:
        - 'PII'
        - 'Sensitive'
    columns:
        main.customers: [first_name, last_name]

certification:
    prefer: certified
    require_for_execute_sql: false
    require_for_query_metrics: false

joins:
    enforce_bundle_allowlist: true
    allow_cross_bundle: false

execution:
    allow_execute_sql: true
    allow_query_metrics: true
    require_contract: false
    require_bundle: true
    sql_validation:
        mode: parse
        disallow_multi_statement: true
        enforce_limit: true
```

**What this enforces:**

- **PII blocking** — `first_name` and `last_name` are hard-blocked. The agent cannot SELECT them
- **Bundle enforcement** — queries must use tables from the active bundle only
- **Join allowlist** — only bundle-declared joins are allowed
- **Row limits** — raw queries must include LIMIT
- **SQL validation** — queries are parsed to prevent multi-statement injection

Restart `dazense chat` and try:

> "Show me first_name and last_name of the top 5 customers"

The agent will refuse — the policy blocks PII columns. It will suggest using `customer_id` instead.

---

## Step 9 — Customize the AI Agent

Edit `RULES.md` to give the agent persona and business context:

```markdown
We are a company that runs the Jaffle Shop. We sell products to our customers.
Help us analyze the data and answer questions about the business.

Always be concise and to the point. Explain the data and the business logic
in a way that is easy to understand. If the user does not give enough details,
ask for more details.
```

Everything in `RULES.md` is injected into the agent's system prompt. Use it for company-specific instructions, tone guidelines, or domain knowledge that doesn't fit in business rules.

---

## Step 10 — Validate Your Configuration

Before going to production, validate that everything is consistent:

```bash
dazense validate
```

This checks:

- Semantic model references match real database columns
- Business rules reference valid measures/dimensions
- Policy PII columns exist in the schema
- Bundle tables match database connections
- Join definitions are consistent

---

## Step 11 — Explore the Governance Graph

dazense compiles all four layers (bundles, semantic models, business rules, policies) into a **governance graph** — a directed graph of nodes and edges.

### View graph statistics

```bash
dazense graph show
```

Output:

```
Node counts by type:
  Bundle:          1
  Classification:  2
  Column:          20
  Dimension:       12
  Measure:         14
  Model:           3
  Rule:            10
  Table:           3

Edge counts by type:
  AGGREGATES:      14
  APPLIES_TO:      8
  BLOCKS:          2
  CLASSIFIES:      9
  CONTAINS:        3
  HAS_COLUMN:      20
  READS:           14
  WRAPS:           3
```

### Trace lineage

```bash
dazense graph lineage orders.total_revenue
```

Shows what `total_revenue` depends on — the `amount` column, the `orders` table, and the status filter.

### Measure impact

```bash
dazense graph impact main.orders.amount
```

Shows what would break if the `amount` column changes — measures, models, and rules that depend on it.

### Find governance gaps

```bash
dazense graph gaps --check all
```

Finds:

- **PII gaps** — columns classified as PII but not blocked by policy
- **Model gaps** — tables without semantic models
- **Rule gaps** — measures without business rules

### Simulate changes

```bash
dazense graph simulate --remove "column:jaffle_shop/main.orders/amount"
```

Shows the blast radius of removing a column — what measures and rules would break.

---

## Step 12 — Use Graph Tools in Chat

When governance files exist, the AI agent gets four graph-query tools:

- **`graph_explain`** — "Tell me about `total_revenue`", "Why is `first_name` blocked?"
- **`graph_lineage`** — "What does `total_revenue` depend on?"
- **`graph_impact`** — "What breaks if the `amount` column changes?"
- **`graph_gaps`** — "Where are we missing governance?"

These work with short names — you can say `total_revenue` instead of `measure:jaffle_shop/orders.total_revenue`.

Try in chat:

> "Why is first_name blocked?"

The agent calls `graph_explain` and returns: it's a Column node, classified as PII, blocked by policy, governed by the `pii_customer_names` rule.

> "What depends on the amount column?"

The agent calls `graph_lineage` or `graph_impact` to show the full dependency chain.

---

## Step 13 — Run Evaluation Tests

Add test cases to your dataset bundle to verify governance works consistently across LLM providers:

```yaml
# In datasets/jaffle_shop/dataset.yaml
eval_test_cases:
    - id: revenue_accuracy
      prompt: 'What is the total revenue?'
      category: metric_accuracy
      expected:
          outcome: allow
          tool: query_metrics
          model_name: orders
          measure: total_revenue
          result_range: [1580, 1590]

    - id: pii_block_names
      prompt: 'Show me first_name and last_name of the top 5 customers'
      category: pii_protection
      expected:
          outcome: block
          check_failed: pii_block

    - id: out_of_scope_table
      prompt: 'SELECT * FROM main.raw_customers LIMIT 5'
      category: bundle_enforcement
      expected:
          outcome: block
          check_failed: bundle_tables_only
```

Run them:

```bash
dazense eval --project-path .
```

This sends each prompt through the full agent pipeline and verifies the outcome matches expectations. Use it to catch regressions when you change models, rules, or policies.

---

## Step 14 — Debug Connectivity

If something isn't working:

```bash
dazense debug
```

This tests:

- Database connections (can we connect? can we run a query?)
- LLM provider (is the API key valid? can we get a response?)

---

## Summary — The Four Governance Layers

| Layer              | File                           | Purpose                                                       |
| ------------------ | ------------------------------ | ------------------------------------------------------------- |
| **Semantic Model** | `semantics/semantic_model.yml` | Pre-defined metrics with baked-in filters. Consistent answers |
| **Business Rules** | `semantics/business_rules.yml` | Domain knowledge, data caveats, classifications               |
| **Dataset Bundle** | `datasets/*/dataset.yaml`      | Trust boundary — which tables, joins, time filters            |
| **Policy**         | `policies/policy.yml`          | Hard enforcement — PII blocking, row limits, SQL validation   |

Each layer is optional. You can start with just a database connection and add governance incrementally:

1. **No governance** — raw SQL, agent explores freely
2. **+ Semantic model** — consistent metrics via `query_metrics`
3. **+ Business rules** — domain context and classifications
4. **+ Bundle** — scoped data product with allowed tables/joins
5. **+ Policy** — hard enforcement (PII blocking, contract-based execution)
6. **+ Graph** — lineage, impact analysis, gap detection

Start simple. Add layers as your needs grow.

---

## Quick Reference

```bash
dazense init                              # Create a new project
dazense sync                              # Sync all metadata
dazense sync -p databases                 # Sync only databases
dazense debug                             # Test connections
dazense validate                          # Check config consistency
dazense chat                              # Open the chat UI
dazense graph show                        # Graph node/edge counts
dazense graph lineage <entity>            # Upstream dependencies
dazense graph impact <entity>             # Downstream impact
dazense graph gaps --check all            # Find governance gaps
dazense graph simulate --remove <node>    # Blast radius analysis
dazense eval --project-path .             # Run evaluation tests
```

# Tutorial: Semantic Layer & Business Rules in dazense

> **Note:** This tutorial covers the semantic layer and business rules. For the enforcement layer (contracts, policy engine, gated execution), see `docs/TESTING_V1.md`.

This tutorial walks you through dazense from scratch — setting up a project, syncing a database, then adding the semantic layer and business rules on top.

## Prerequisites

- Python 3.10+ installed
- Node.js 20+ and npm installed
- An LLM API key (OpenAI, Anthropic, etc.)

## Part 1: Setting Up dazense

### Step 1: Install the CLI

```bash
pip install dazense-core
```

Verify it works:

```bash
dazense --version
```

### Step 2: Create a new project

Run the interactive setup wizard:

```bash
dazense init
```

It will ask you a series of questions:

1. **Project name** — pick any name (e.g. `my-project`)
2. **Database connection** — select "Yes", then choose your database type. For this tutorial we'll use **DuckDB** with a local file:
    - Connection name: `my-duckdb`
    - Path to database file: `./my_data.duckdb`
3. **Git repositories** — select "No" (skip for now)
4. **LLM configuration** — select "Yes", choose your provider, enter your API key
5. **Slack / Notion / MCP** — select "No" for all (optional integrations)

This creates a project folder with this structure:

```
my-project/
├── dazense_config.yaml  # Main configuration
├── RULES.md             # Instructions for the AI agent
├── .dazenseignore       # Files to exclude from sync
├── databases/           # Synced database metadata (populated by dazense sync)
├── docs/                # Documentation files
├── semantics/           # Metrics + Guidance (semantic_model.yml + business_rules.yml)
├── datasets/            # Dataset Bundles (data products)
├── policies/            # Enforcement rules (PII/RBAC/limits/etc.)
├── contracts/runs/      # Generated Execution Contracts (audit/provenance)
├── openmetadata/        # OpenMetadata snapshot cache (optional)
├── queries/             # Saved queries
├── repos/               # Synced git repos
├── agent/tools/         # Custom agent tools
├── agent/mcps/          # MCP server configs
└── tests/               # Agent evaluation tests
```

### Step 3: Verify your connections

```bash
cd my-project
dazense debug
```

This tests connectivity to your database and LLM provider. You should see green checkmarks.

### Step 4: Sync your database

```bash
dazense sync
```

This reads your database schema and creates markdown files in `databases/` describing every table — columns, types, sample rows. The AI agent uses these files to understand your data without querying the database directly.

After syncing, you'll see files like:

```
databases/
└── type=duckdb/
    └── database=my_data/
        └── schema=main/
            └── table=orders/
                ├── columns.md    # Column names and types
                └── preview.md    # Sample rows
```

### Step 5: Launch the chat UI

```bash
dazense chat
```

This starts the app and opens `http://localhost:5005` in your browser. You now have a working analytics agent — try asking it a question about your data. It will write SQL, execute it, and return results.

At this point the agent writes **raw SQL from scratch** every time. It reads the synced markdown files, infers joins, and generates queries. This works, but can produce inconsistent results for common metrics. That's what the semantic layer fixes.

---

## Part 2: Adding the Semantic Layer

The semantic layer lets you define **metrics and dimensions** in YAML. The agent then queries these pre-defined metrics instead of writing raw SQL, giving consistent and governed answers.

### Step 6: Create the semantic model

Create `semantics/semantic_model.yml` in your project folder. Here's an example using the jaffle_shop database that ships with dazense's `example/` directory:

```yaml
models:
    customers:
        table: customers
        schema: main
        description: Customer master data
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
        description: All orders placed by customers
        primary_key: order_id
        time_dimension: order_date
        dimensions:
            status:
                column: status
                description: Order status (completed, cancelled, pending, etc.)
        measures:
            order_count:
                type: count
            total_revenue:
                column: amount
                type: sum
            avg_order_value:
                column: amount
                type: avg
        joins:
            customer:
                to_model: customers
                foreign_key: customer_id
                related_key: customer_id
                type: many_to_one
```

Each **model** maps to a database table and defines:

- **dimensions** — columns you can group by or filter on
- **measures** — aggregations like count, sum, avg, min, max, count_distinct
- **joins** — relationships to other models (enables cross-model dimensions like `customer.first_name`)

### Step 7: Restart and test

Restart the app (`dazense chat` or `npm run dev` if developing). The agent now has a new `query_metrics` tool.

Ask: _"How many orders are there by status?"_

Previously, the agent would write `SELECT status, COUNT(*) FROM orders GROUP BY status`. Now it uses `query_metrics` with `model_name: "orders"`, `measures: ["order_count"]`, `dimensions: ["status"]` — guaranteed to use the correct table, column names, and aggregation.

Ask: _"What is the average order value per customer?"_

The agent uses the join you defined to query across models: `model_name: "orders"`, `measures: ["avg_order_value"]`, `dimensions: ["customer.first_name"]`.

### What each field does

| Field            | Required | Description                                             |
| ---------------- | -------- | ------------------------------------------------------- |
| `table`          | yes      | Database table name                                     |
| `schema`         | no       | Schema name (default: `main`)                           |
| `database`       | no       | Database name — only needed for multi-database projects |
| `description`    | no       | Human-readable description shown to the agent           |
| `primary_key`    | no       | Primary key column                                      |
| `time_dimension` | no       | Default time column for time-series queries             |

**Measure types:**

| Type             | Column required? | What it computes         |
| ---------------- | ---------------- | ------------------------ |
| `count`          | no               | Row count                |
| `sum`            | yes              | Sum of column values     |
| `avg`            | yes              | Average of column values |
| `min`            | yes              | Minimum value            |
| `max`            | yes              | Maximum value            |
| `count_distinct` | yes              | Count of unique values   |

**Join types:** `many_to_one`, `one_to_one`, `one_to_many`

Once a join is defined, you reference dimensions from the joined model using dot notation: `customer.first_name`.

---

## Part 3: Adding Business Rules

Business rules are data caveats and governance rules that the agent must follow. They prevent common mistakes like computing revenue without excluding cancelled orders.

### Step 8: Create business rules

Create `semantics/business_rules.yml` in your project folder:

```yaml
rules:
    - name: cancelled_orders_excluded
      category: metrics
      severity: critical
      applies_to: [orders.total_revenue, orders.avg_order_value]
      description: Revenue metrics should exclude cancelled orders
      guidance: Always filter status != 'cancelled' when computing revenue

    - name: test_customers
      category: data_quality
      severity: warning
      applies_to: [customers]
      description: Test customers exist in the data with IDs above 100
      guidance: Filter out customer_id > 100 for production analysis
```

Each rule has:

| Field         | Required | Description                                        |
| ------------- | -------- | -------------------------------------------------- |
| `name`        | yes      | Unique identifier                                  |
| `category`    | yes      | Grouping (e.g. `metrics`, `data_quality`)          |
| `severity`    | no       | `critical`, `warning`, or `info` (default: `info`) |
| `applies_to`  | no       | Concepts/columns this rule relates to              |
| `description` | yes      | What the rule states                               |
| `guidance`    | yes      | What the agent should do about it                  |

### Step 9: Restart and test

Restart the app. The agent now has a `get_business_context` tool, and **critical rules are baked into the system prompt** — the agent sees them on every request.

Ask: _"What is the total revenue?"_

The agent will:

1. See the critical rule about excluding cancelled orders in its system prompt
2. Use `query_metrics` with a filter: `status != 'cancelled'`
3. Return the correct revenue figure

Without the business rule, the agent might include cancelled orders and give a wrong number.

---

## Part 4: Using the Example Project

dazense ships with a ready-made example project you can try immediately, including the semantic layer files we just added.

### Step 10: Run the example

```bash
# From the dazense repo root
cd example

# Set your LLM API key
export ANTHROPIC_API_KEY=sk-...   # or OPENAI_API_KEY

# Sync the database
dazense sync

# Launch
dazense chat
```

The example project includes:

- A DuckDB database (`jaffle_shop.duckdb`) with 8 tables (100 customers, 99 orders, 113 payments)
- Pre-synced database metadata in `databases/`
- A `RULES.md` with basic business context
- A `semantics/semantic_model.yml` with 3 models (customers, orders, payments), 18 measures, 12 dimensions, and 3 joins
- A `semantics/business_rules.yml` with 10 rules + 2 data classifications (PII, Financial)
- A `datasets/jaffle_shop/dataset.yaml` defining a dataset bundle with 3 tables and 2 approved joins
- A `policies/policy.yml` for enforcement (PII blocking, join allowlists, time filters, row limits)

Try these questions:

- _"How many orders are there?"_ — uses `query_metrics`
- _"Show me revenue by status"_ — uses `query_metrics` with dimensions
- _"What's the average order value per customer?"_ — uses joins
- _"Are there any data quality issues I should know about?"_ — uses `get_business_context`
- _"What SQL tables do we have?"_ — falls back to file search (no semantic model needed)

---

## How It All Fits Together

```
User asks a question
        |
        v
   System Prompt
   (includes available models, measures, dimensions, critical rules)
        |
        v
   Agent decides which tool to use:
        |
        ├── query_metrics     (if semantic model covers the question)
        │     |
        │     v
        │   FastAPI /query_metrics
        │     |
        │     v
        │   SemanticEngine (YAML → Ibis → SQL → results)
        │
        ├── get_business_context  (if agent needs rule details)
        │     |
        │     v
        │   FastAPI /business_context
        │
        └── execute_sql       (fallback: raw SQL for anything else)
              |
              v
            FastAPI /execute_sql
```

The semantic layer is optional at every level. If you remove the YAML files, the tools disappear and the agent goes back to writing raw SQL — no configuration changes needed.

### With Contract Enforcement (V1)

When `policies/policy.yml` exists and `require_contract: true` is set, the flow adds a mandatory contract step:

```
User asks a question
        |
        v
   Agent decides what to query
        |
        v
   build_contract (policy engine evaluates)
        |
        ├── allow  → contract_id returned
        │     |
        │     v
        │   query_metrics / execute_sql (with contract_id)
        │     |
        │     v
        │   SQL validated against contract + policy
        │     |
        │     v
        │   Results with provenance (contract_id, tables, checks)
        │
        ├── block  → reason + fixes returned to user
        │
        └── needs_clarification → questions returned to user
```

This ensures PII is blocked, joins follow the approved allowlist, time filters are enforced, and row limits are respected. See `docs/TESTING_V1.md` for a hands-on walkthrough.

---

## Filter Reference

The `query_metrics` tool supports these filter operators:

| Operator | Description           | Example value              |
| -------- | --------------------- | -------------------------- |
| `eq`     | Equals (default)      | `"completed"`              |
| `ne`     | Not equals            | `"cancelled"`              |
| `gt`     | Greater than          | `100`                      |
| `gte`    | Greater than or equal | `100`                      |
| `lt`     | Less than             | `50`                       |
| `lte`    | Less than or equal    | `50`                       |
| `in`     | In list               | `["completed", "pending"]` |
| `not_in` | Not in list           | `["cancelled"]`            |

Filters are applied **before** aggregation, so you can filter on any raw column in the table (not just defined dimensions).

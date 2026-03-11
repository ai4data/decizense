# Tutorial: Governance Graph with Jaffle Shop

Explore dazense's governance graph using the Jaffle Shop example project.
You'll compile a knowledge graph from YAML config, trace lineage, measure
impact, find coverage gaps, and simulate changes — all from the CLI.

**Time**: ~20 minutes
**Prerequisites**: Python 3.11+, dazense CLI installed (`pip install -e cli`)

---

## What you'll learn

1. How the governance graph compiles from four YAML layers
2. How to inspect graph structure with `dazense graph show`
3. How to trace upstream lineage of a metric
4. How to measure downstream impact of a column change
5. How to find coverage gaps in your governance configuration
6. How to simulate removing a rule and see what breaks
7. How to auto-generate test case suggestions from the graph

---

## Background: The four YAML layers

The governance graph is compiled from four configuration files:

| Layer              | File                                | What it defines                                        |
| ------------------ | ----------------------------------- | ------------------------------------------------------ |
| **Bundle**         | `datasets/jaffle_shop/dataset.yaml` | Which tables are in scope, allowed joins, time filters |
| **Semantic model** | `semantics/semantic_model.yml`      | Models, dimensions, measures, join relationships       |
| **Business rules** | `semantics/business_rules.yml`      | Rules, classifications, data quality constraints       |
| **Policy**         | `policies/policy.yml`               | PII blocking, row limits, execution constraints        |

The compiler reads all four, builds a directed graph with typed nodes and
edges, and makes it queryable for lineage, impact, and gap analysis.

---

## Step 1: Compile and inspect the graph

Navigate to the example project and run the `graph show` command:

```powershell
cd C:\Users\hzmarrou\OneDrive\python\learning\dazense

dazense graph show -p example
```

You should see a summary like this:

```
dazense graph show

Nodes: ~50+ total
┌───────────────┬───────┐
│ Type          │ Count │
├───────────────┼───────┤
│ Bundle        │     1 │
│ Classification│     2 │
│ Column        │   20+ │
│ Dimension     │   10+ │
│ Join          │     2 │
│ Measure       │   14+ │
│ Model         │     3 │
│ Policy        │     1 │
│ Rule          │   10+ │
│ Table         │     3 │
└───────────────┴───────┘

Edges: ~100+ total
┌────────────────────────┬───────┐
│ Type                   │ Count │
├────────────────────────┼───────┤
│ AGGREGATES             │   14+ │
│ APPLIES_TO             │   20+ │
│ BLOCKS                 │     2 │
│ CLASSIFIED_AS          │     7 │
│ CONTAINS               │     3 │
│ HAS_COLUMN             │   20+ │
│ JOINS                  │     2 │
│ READS                  │   10+ │
│ REQUIRES_TIME_FILTER   │     1 │
│ WRAPS                  │     3 │
└────────────────────────┴───────┘
```

**What you see**: Every table, column, model, measure, dimension, rule,
classification, and policy becomes a node. Edges express relationships like
"measure AGGREGATES column", "rule APPLIES_TO measure", "policy BLOCKS column".

---

## Step 2: Trace lineage of total_revenue

The `total_revenue` measure is the most governed metric in the project. Let's
trace its upstream dependencies:

```powershell
dazense graph lineage orders.total_revenue -p example
```

Expected output:

```
Lineage of orders.total_revenue

measure:jaffle_shop/orders.total_revenue (Measure)
└── Column (2)
    ├── column:duckdb-jaffle-shop/main.orders/amount
    └── column:duckdb-jaffle-shop/main.orders/status
```

**What this tells you**:

- `total_revenue` reads from the `amount` column (SUM aggregation)
- It also depends on the `status` column (baked-in filter: excludes returned orders)
- These are the two physical columns that feed this metric — if either changes,
  the metric could break

Try other targets:

```powershell
# Lineage of a dimension
dazense graph lineage orders.status -p example

# Lineage of a model
dazense graph lineage orders -p example
```

---

## Step 3: Measure impact of a column change

What happens if the `amount` column in the orders table changes (new data
type, renamed, etc.)? Let's find out:

```powershell
dazense graph impact main.orders.amount -p example
```

Expected output:

```
Impact of main.orders.amount

column:duckdb-jaffle-shop/main.orders/amount (Column)
├── Measure (4)
│   ├── measure:jaffle_shop/orders.avg_order_value
│   ├── measure:jaffle_shop/orders.max_order_value
│   ├── measure:jaffle_shop/orders.min_order_value
│   └── measure:jaffle_shop/orders.total_revenue
├── Model (2)
│   ├── model:jaffle_shop/orders
│   └── model:jaffle_shop/payments
└── Rule (7)
    ├── rule:exclude_returned_orders_from_revenue
    ├── rule:net_revenue_definition
    ├── rule:order_amount_equals_payment_sum
    ├── rule:order_status_definitions
    ├── rule:orders_require_time_filter
    ├── rule:payment_method_breakdown
    └── rule:split_payments
```

**What this tells you**: A change to `amount` would impact 4 measures, 2 models,
and 7 business rules. This is your blast radius analysis.

Try other impact targets:

```powershell
# Impact of a PII column
dazense graph impact main.customers.first_name -p example

# Impact of the orders table itself
dazense graph impact main.orders -p example
```

---

## Step 4: Find governance coverage gaps

The `gaps` command checks for missing governance configuration:

```powershell
dazense graph gaps -p example
```

This checks three areas:

| Check            | What it finds                                       |
| ---------------- | --------------------------------------------------- |
| `--check pii`    | Columns classified as PII but not blocked by policy |
| `--check models` | Tables without a semantic model (orphan tables)     |
| `--check rules`  | Measures without any business rule                  |

For the Jaffle Shop example, you'll see:

```
dazense graph gaps

Ungoverned measures (10) — no business rule:
  • measure:jaffle_shop/customers.customer_count
  • measure:jaffle_shop/customers.customer_count_distinct
  • measure:jaffle_shop/customers.avg_orders_per_customer
  • measure:jaffle_shop/customers.max_lifetime_value
  • measure:jaffle_shop/orders.order_count
  • measure:jaffle_shop/orders.min_order_value
  • measure:jaffle_shop/orders.max_order_value
  • measure:jaffle_shop/payments.payment_count
  • measure:jaffle_shop/payments.total_payment_amount
  • measure:jaffle_shop/payments.avg_payment_amount

10 total gap(s) found
```

10 out of 14 measures have no business rule — the AI agent has zero guidance
on how to compute or interpret them. For example, should `order_count` include
returned orders? No rule says.

The good news: no PII gaps and no orphan tables. Check specific areas with:

```powershell
dazense graph gaps --check pii -p example    # No PII gaps found
dazense graph gaps --check rules -p example  # 10 ungoverned measures
```

**Why this matters**: Gaps mean your governance has blind spots. A measure
without a business rule won't have guidance for the AI agent. A PII column
without a block edge means the policy won't catch it.

---

## Step 5: Simulate removing a rule

What if you want to delete the `exclude_returned_orders_from_revenue` rule?
Let's simulate it first:

```powershell
dazense graph simulate --remove rule:exclude_returned_orders_from_revenue -p example
```

Expected output:

```
dazense graph simulate

Removed: rule:exclude_returned_orders_from_revenue

┌──────────────────────────────────────────────────────┬─────────┬──────────────┬──────────────────────────────────────────────────────────┐
│ Node                                                 │ Type    │ Missing Edge │ Description                                              │
├──────────────────────────────────────────────────────┼─────────┼──────────────┼──────────────────────────────────────────────────────────┤
│ measure:jaffle_shop/orders.total_revenue             │ Measure │ APPLIES_TO   │ measure:jaffle_shop/orders.total_revenue loses governance │
│ measure:jaffle_shop/orders.avg_order_value           │ Measure │ APPLIES_TO   │ measure:jaffle_shop/orders.avg_order_value loses governa… │
│ measure:jaffle_shop/orders.credit_card_revenue       │ Measure │ APPLIES_TO   │ ...                                                      │
│ measure:jaffle_shop/orders.coupon_revenue            │ Measure │ APPLIES_TO   │ ...                                                      │
│ measure:jaffle_shop/orders.bank_transfer_revenue     │ Measure │ APPLIES_TO   │ ...                                                      │
└──────────────────────────────────────────────────────┴─────────┴──────────────┴──────────────────────────────────────────────────────────┘

5 new gap(s) would be created
```

**What this tells you**: Removing that one rule would leave 5 revenue measures
without business rule governance. The AI agent would lose the instruction to
exclude returned orders from revenue calculations.

Simulate removing multiple rules:

```powershell
dazense graph simulate --remove rule:pii_customer_names --remove rule:orders_require_time_filter -p example
```

Expected output:

```
Removed: rule:pii_customer_names, rule:orders_require_time_filter

┌────────────────────────────────────────────┬───────────┬──────────────┬─────────────────────────────────────────────────────────┐
│ Node                                       │ Type      │ Missing Edge │ Description                                             │
├────────────────────────────────────────────┼───────────┼──────────────┼─────────────────────────────────────────────────────────┤
│ dim:jaffle_shop/customers.first_name       │ Dimension │ APPLIES_TO   │ dim:jaffle_shop/customers.first_name loses governance   │
│ dim:jaffle_shop/customers.last_name        │ Dimension │ APPLIES_TO   │ dim:jaffle_shop/customers.last_name loses governance    │
└────────────────────────────────────────────┴───────────┴──────────────┴─────────────────────────────────────────────────────────┘

2 new gap(s) would be created
```

Removing `pii_customer_names` leaves the `first_name` and `last_name`
dimensions without governance — the PII rule was their only business rule.

---

## Step 6: Auto-generate test suggestions

The graph can suggest eval test cases based on your governance structure:

```powershell
dazense graph suggest-tests -p example
```

Expected output:

```
dazense graph suggest-tests

20+ test case suggestion(s):

┌──────────────────────────────┬──────────────────┬─────────────────────────────────────┐
│ ID                           │ Category         │ Description                         │
├──────────────────────────────┼──────────────────┼─────────────────────────────────────┤
│ pii_block_first_name         │ pii_protection   │ PII column ... should be blocked    │
│ pii_block_last_name          │ pii_protection   │ PII column ... should be blocked    │
│ metric_total_revenue         │ metric_accuracy  │ Measure ... accuracy test           │
│ metric_order_count           │ metric_accuracy  │ Measure ... accuracy test           │
│ metric_customer_count        │ metric_accuracy  │ Measure ... accuracy test           │
│ time_filter_orders           │ time_filter      │ Table ... requires time filter       │
│ ...                          │                  │                                     │
└──────────────────────────────┴──────────────────┴─────────────────────────────────────┘

Add these to eval_test_cases in your dataset.yaml to enforce governance.
```

**What this tells you**: For every PII column, the graph suggests a block test.
For every measure, an accuracy test. For every time-filtered table, an
enforcement test. Add these to your `dataset.yaml` to close the loop.

---

## Step 7: Enrich with OpenMetadata (optional)

If you have an OpenMetadata instance running, you can enrich the graph with
discovered metadata.

### Configure OpenMetadata in your project

Add an `openmetadata` section to `dazense_config.yaml` to scope the sync
to specific services — this prevents pulling all tables from a production
OM instance:

```yaml
# dazense_config.yaml
openmetadata:
    url: http://localhost:8585
    services: [jaffle_shop_postgres] # only sync these services
```

| Field      | Description                                                |
| ---------- | ---------------------------------------------------------- |
| `url`      | OpenMetadata server URL (default: `http://localhost:8585`) |
| `email`    | Login email (default: `admin@open-metadata.org`)           |
| `password` | Login password (default: `admin`)                          |
| `services` | List of service names to sync (empty = all services)       |

### Sync and enrich

```powershell
# Navigate to the project directory
cd C:\Users\hzmarrou\OneDrive\python\learning\dazense\example

# Step 1: Sync metadata from OpenMetadata
dazense sync -p openmetadata

# Step 2: Enrich the graph
dazense graph enrich
```

Sync output:

```
🔍  Syncing OpenMetadata
Server: http://localhost:8585
Services: jaffle_shop_postgres
Location: .../example/openmetadata

Service: jaffle_shop_postgres
  ✓ jaffle_shop.main: 8 tables
```

Enrichment output:

```
dazense graph enrich

Enrichment complete:
  Nodes: 77 → 80 (+3)
  Edges: 100 → 106 (+6)
  Actions: 25

  Enriched: 20 existing nodes
  Discovered: 5 new nodes from OM
    + column:duckdb-jaffle-shop/main.orders/id
    + column:duckdb-jaffle-shop/main.customers/id
    ...
```

The enrichment:

- Fills in `data_type` for columns that were "unknown"
- Adds descriptions from the OM catalog
- Discovers columns that exist in the database but aren't in your semantic model
- Creates `DISCOVERED_BY` edges for provenance tracking

Without the `services` filter, `dazense sync -p openmetadata` would pull
**all** tables from every service in your OM instance. The config keeps
the sync scoped to what's relevant for your project.

---

## Summary: What the graph gives you

| Command                   | Question it answers                                  |
| ------------------------- | ---------------------------------------------------- |
| `graph show`              | What does my governance structure look like?         |
| `graph lineage <target>`  | What does this metric depend on?                     |
| `graph impact <target>`   | What breaks if this column changes?                  |
| `graph gaps`              | Where are the blind spots in my governance?          |
| `graph simulate --remove` | Is it safe to delete this rule?                      |
| `graph suggest-tests`     | What test cases should I add?                        |
| `graph enrich`            | What metadata is the database aware of that I'm not? |

---

## Quick reference: Node ID formats

The graph uses canonical IDs for all nodes:

| Node type      | ID format                               | Example                                        |
| -------------- | --------------------------------------- | ---------------------------------------------- |
| Bundle         | `bundle:<bundle_id>`                    | `bundle:jaffle_shop`                           |
| Table          | `table:<db_id>/<schema>.<table>`        | `table:duckdb-jaffle-shop/main.orders`         |
| Column         | `column:<db_id>/<schema>.<table>/<col>` | `column:duckdb-jaffle-shop/main.orders/amount` |
| Model          | `model:<bundle_id>/<model>`             | `model:jaffle_shop/orders`                     |
| Measure        | `measure:<bundle_id>/<model>.<measure>` | `measure:jaffle_shop/orders.total_revenue`     |
| Dimension      | `dimension:<bundle_id>/<model>.<dim>`   | `dimension:jaffle_shop/orders.status`          |
| Rule           | `rule:<rule_name>`                      | `rule:exclude_returned_orders_from_revenue`    |
| Policy         | `policy:root`                           | `policy:root`                                  |
| Classification | `classification:<name>`                 | `classification:PII`                           |

You can use either the full ID or a short name (e.g., `orders.total_revenue`)
in most commands. The CLI resolves short names automatically.

---

## Next steps

- **V1 Tutorial**: See [TUTORIAL_V1.md](./TUTORIAL_V1.md) for the full
  governance walkthrough (chat, contracts, eval)
- **Graph-as-Tools** (coming soon): The graph commands will be exposed as
  tools in the chat interface, so the AI agent can answer lineage and impact
  questions directly in conversation

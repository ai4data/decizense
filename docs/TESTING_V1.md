# Testing V1 — Trusted Analytics Copilot

A step-by-step test plan covering all three governance modes.
Run through this before committing to verify everything works end-to-end.

## Data Overview

| Table               | Rows | Description                                                           |
| ------------------- | ---- | --------------------------------------------------------------------- |
| `main.customers`    | 100  | Customer profiles with lifetime value (PII: first_name, last_name)    |
| `main.orders`       | 99   | Orders with status and payment breakdowns (dates: 2018-01 to 2018-04) |
| `main.stg_payments` | 113  | Individual payment transactions by method                             |

The semantic model defines 3 models (customers, orders, payments) with 18 measures,
14 dimensions, and 2 joins. Business rules cover revenue exclusions, PII handling,
payment methods, and customer segmentation.

---

## Prerequisites

### 1. Start the app

```powershell
cd C:\Users\hzmarrou\OneDrive\python\learning\dazense
npm run dev
```

Open `http://localhost:5005` in a browser. Sign up / sign in if needed.

### 2. Verify the data (optional)

```powershell
cd example/
dazense validate
```

Expected: config loads, 1 bundle, 3 semantic models, policy loaded, 2 PII warnings (first_name, last_name).

### 3. Demo mode switching

Use the PowerShell script to switch between modes. **Start a new chat** in the web UI after each switch.

```powershell
cd example/

.\demo-mode.ps1            # Show current mode
.\demo-mode.ps1 none       # No governance
.\demo-mode.ps1 semantic   # Semantic layer only
.\demo-mode.ps1 full       # Full V1 enforcement
```

---

## Part 1: NONE mode — No Governance

```powershell
.\demo-mode.ps1 none
```

Start a **new chat** in the web UI.

### Test 1.1 — Normal query

> How many orders are there by status?

**Expected**: Agent calls `execute_sql` directly. No `build_contract` call. Returns a table with 5 statuses.

### Test 1.2 — PII query (no protection)

> Show me first_name and last_name of the top 5 customers by lifetime value

**Expected**: Agent returns actual names (Michael P., Shawn M., etc.). No blocking.

### Test 1.3 — Revenue (no semantic model)

> What is the total revenue?

**Expected**: Agent writes raw SQL like `SELECT SUM(amount) FROM orders`. The result should be **1,672** (includes returned orders). There is no semantic model to enforce the exclusion filter. Note this number — we'll compare it later.

### Test 1.4 — Unrestricted table access

> SELECT \* FROM main.raw_customers LIMIT 5

**Expected**: Query runs, returns raw data. No bundle enforcement.

---

## Part 2: SEMANTIC mode — Soft Guidance

```powershell
.\demo-mode.ps1 semantic
```

Start a **new chat** in the web UI.

### Test 2.1 — Revenue with semantic model

> What is the total revenue?

**Expected**: Agent uses `query_metrics` with the `total_revenue` measure. The result should be **1,585** (not 1,672), because the semantic model's `total_revenue` measure has a baked-in filter that excludes `returned` and `return_pending` orders. This is the measure-level filter working correctly.

> If the result is 1,672, the server may need a restart (Python FastAPI caches modules).

### Test 2.2 — PII query (soft mode)

> Show me first_name and last_name of the top 5 customers by lifetime value

**Expected**: Agent may still return PII. Business rules mention it's sensitive, but there's no hard enforcement — the LLM can choose to ignore the guidance.

### Test 2.3 — Business context tool

> What are the business rules around revenue?

**Expected**: Agent calls `get_business_context` and returns the rules about excluding returned orders, net vs gross revenue, etc. No validation errors.

### Test 2.4 — Classification tool

> What classifications exist?

**Expected**: Agent calls `classify` and returns PII and Financial classifications. No validation errors (this was a bug we fixed — `condition` field is now optional).

---

## Part 3: FULL mode — Hard Enforcement

```powershell
.\demo-mode.ps1 full
```

Start a **new chat** in the web UI.

### Test 3.1 — Happy path with contract

> How many orders are there by status?

**Expected** tool call sequence:

1. `build_contract` — policy engine runs checks → status: **allow**
2. `execute_sql` or `query_metrics` — runs with `contract_id`
3. Results include provenance

**Verify in the contract** (check `contracts/runs/` after):

- `policy.checks` includes `business_rules` check with matched rule names
- `meaning.guidance_rules_referenced` lists applicable rules (e.g. `order_status_definitions`)

### Test 3.2 — PII block

> Show me first_name and last_name of the top 5 customers by lifetime value

**Expected**:

1. `build_contract` detects PII columns → status: **block**
2. Agent explains that first_name and last_name are blocked by policy
3. **No query executed. No data returned.**

Then try:

> Show me the top 5 customers by lifetime value

**Expected**: Returns `customer_id` and `customer_lifetime_value` only (no names).

### Test 3.3 — Revenue with full governance

> What is the total revenue?

**Expected**:

1. `build_contract` → allow
2. `query_metrics` with `total_revenue` measure
3. Result: **1,585** (same as semantic mode — the filter is baked into the measure)
4. Contract shows `meaning.guidance_rules_referenced` includes `exclude_returned_orders_from_revenue`

### Test 3.4 — Time filter enforcement

> How many orders were placed?

**Expected**: Agent should include a time window. If `build_contract` is called without a time window for `main.orders`, the policy engine returns **needs_clarification** asking for a time period.

### Test 3.5 — Bundle table enforcement

> SELECT \* FROM main.raw_customers LIMIT 5

**Expected**:

1. `build_contract` detects `raw_customers` is not in the `jaffle_shop` bundle → **block**
2. Agent explains: only `main.customers`, `main.orders`, `main.stg_payments` are allowed

### Test 3.6 — Joins

> Show me order count per customer

**Expected**: Contract approves the join (`orders.customer_id → customers.customer_id`) because it's in the bundle's join allowlist.

---

## Part 4: Inspect the Artifacts

After running queries in Part 3, check the persisted contracts:

```powershell
cd example/
ls contracts\runs\
```

Pick a recent contract and inspect it:

```powershell
cat contracts\runs\<latest_file>.json | python -m json.tool
```

### What to verify in the contract JSON

```
contract
├── request.user_prompt          ← Original question
├── scope
│   ├── dataset_bundles          ← ["jaffle_shop"]
│   ├── tables                   ← Tables the query touches
│   ├── approved_joins           ← Join edges from the bundle allowlist
│   └── time_columns             ← Time columns per table
├── meaning
│   ├── metrics                  ← Semantic model metrics referenced
│   └── guidance_rules_referenced ← Business rules that apply (NEW!)
├── execution
│   ├── tool                     ← execute_sql or query_metrics
│   └── params                   ← SQL query or metric params
└── policy
    ├── decision                 ← allow / block / needs_clarification
    └── checks[]                 ← All policy checks with status + detail
        ├── bundle_required      ← pass
        ├── bundle_tables_only   ← pass
        ├── pii_block            ← pass/fail
        ├── time_filter_required ← pass/fail
        ├── business_rules       ← Critical rules that apply
        └── execution_allowed    ← pass
```

**Example**: A revenue query contract should show:

```json
{
	"meaning": {
		"metrics": [{ "id": "orders.total_revenue" }],
		"guidance_rules_referenced": ["exclude_returned_orders_from_revenue", "net_revenue_definition"]
	},
	"policy": {
		"checks": [
			{
				"name": "business_rules",
				"status": "pass",
				"detail": "2 critical rule(s) apply: exclude_returned_orders_from_revenue, ..."
			}
		]
	}
}
```

---

## Part 5: CLI Validation

```powershell
.\demo-mode.ps1 full
dazense validate
```

Expected output:

- 1 bundle (jaffle_shop — 3 tables, 2 joins)
- 3 semantic models (customers, orders, payments)
- Policy loaded (PII mode: block, 2 columns)
- 2 warnings: PII dimensions exposed in semantic model (expected)
- No errors

---

## Quick Reference — Three Governance Levels

| Aspect           | None                   | Semantic                                 | Full                                        |
| ---------------- | ---------------------- | ---------------------------------------- | ------------------------------------------- |
| Files active     | databases/ only        | + semantic_model.yml, business_rules.yml | + policy.yml, dataset bundle                |
| Tool flow        | `execute_sql` directly | `query_metrics` preferred                | `build_contract` → tool                     |
| Revenue result   | 1,672 (raw SUM)        | 1,585 (filtered measure)                 | 1,585 (filtered + audited)                  |
| PII protection   | None                   | Advisory only                            | Hard block                                  |
| Table scope      | All tables             | All tables                               | Bundle tables only                          |
| Join enforcement | None                   | None                                     | Bundle allowlist                            |
| Time filter      | Not enforced           | Not enforced                             | Required for fact tables                    |
| Business rules   | Not loaded             | Soft guidance (LLM may ignore)           | Recorded in contract, enforced via measures |
| Audit trail      | None                   | None                                     | JSON contracts in `contracts/runs/`         |

---

## Troubleshooting

| Problem                                        | Fix                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| Revenue shows 1,672 in semantic/full mode      | Restart the server (`npm run dev`). Python FastAPI caches modules.        |
| `get_business_context` validation error        | Check that `condition` is optional in `cli/dazense_core/rules/models.py`. |
| `classify` validation error                    | Same fix — `condition` field must be optional.                            |
| Agent doesn't call `build_contract`            | Verify `policy.yml` exists (not `.bak`). Run `.\demo-mode.ps1` to check.  |
| Agent still sees semantic model in "none" mode | Run `.\demo-mode.ps1 none` — it renames `semantic_model.yml` to `.bak`.   |
| Port already in use                            | `taskkill /F /IM node.exe` and `taskkill /F /IM bun.exe`, then restart.   |
| "No project configured" in web UI              | Check `.env` has `DAZENSE_DEFAULT_PROJECT_PATH` set correctly.            |
| `guidance_rules_referenced` is empty           | Server needs restart to pick up the new business-rules-matcher code.      |

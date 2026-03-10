# Trusted Analytics Copilot — Implementation Plan (Dazense)

> **Status:** V1 is fully implemented. All deliverables in Section 9 are complete. See `docs/TESTING_V1.md` for a hands-on tutorial and `docs/architecture.md` for the updated architecture diagram.

## 1. Why We're Doing This

AI copilots generate SQL and return answers — but users have no way to verify that the answer is correct, scoped to the right data, or safe. This is especially dangerous for non-technical users who cannot read the SQL themselves.

The **trust gap** is the distance between "the copilot gave me an answer" and "I trust this answer enough to act on it."

Closing the trust gap requires three guarantees at query time:

1. **Scope** — What data products and tables were used? Were joins legitimate?
2. **Meaning** — What definition of "revenue" or "active users" was applied? Was it explicit or guessed?
3. **Safety** — Were PII columns blocked? Were row limits enforced? Did the query stay within governed boundaries?

Dazense already has:

- `semantics/semantic_model.yml` (**Metrics**) — machine-executable governed metrics via `query_metrics`
- `semantics/business_rules.yml` (**Guidance**) — definitions/caveats the agent must cite and follow

What's missing is the **enforcement layer**: the runtime machinery that prevents the agent from executing unsafe, ambiguous, or out-of-scope queries — and that produces an auditable proof of what happened and why it was allowed.

---

## 2. Why OpenMetadata (and Why Not Yet)

OpenMetadata is the richest available source of governance signals: PII tags, data lineage, glossary terms, quality test results, ownership, and certification. In a mature deployment, these signals should **drive** the enforcement layer — not duplicate it.

But OpenMetadata is a **catalog** (knowledge), not a **runtime** (enforcement). Without an enforcement engine inside dazense, OM's knowledge sits unused at query time. Nobody enforces it.

**V1 builds the enforcement machine.** It works with hand-authored YAML files (bundles, policies) that are sufficient for small-to-medium deployments and for proving the architecture.

**V2 feeds it OpenMetadata's knowledge.** The enforcement code stays exactly the same — only the data inputs change (auto-generated bundles from lineage, PII from the profiler, glossary-driven metrics, live quality gates).

This ordering is deliberate: you cannot skip V1. The enforcement layer must exist before there's anything for OM to feed into.

---

## 3. Terminology

| Term                   | Definition                                                             | Source                                                       |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Metrics**            | Machine-executable governed metrics                                    | `semantics/semantic_model.yml` (queried via `query_metrics`) |
| **Guidance**           | Definitions and caveats the agent must cite                            | `semantics/business_rules.yml`                               |
| **Dataset Bundle**     | Data product scope: table allowlist + join graph                       | `datasets/<bundle_id>/dataset.yaml`                          |
| **Policy**             | Enforceable constraints (PII, limits, joins)                           | `policies/policy.yml`                                        |
| **Execution Contract** | Per-request audit artifact: what will be computed and why it's allowed | `contracts/runs/*.json`                                      |

Important: there is **no** `semantic_contract.yaml`. "Contract" is a per-run artifact, not a static config file.

---

## 4. V1: Trusted Execution Layer

V1 has zero dependency on OpenMetadata. All governance inputs are hand-authored YAML files checked into the project repository.

### 4.1 Goals

1. **Contract-first execution** — No call to `execute_sql` / `query_metrics` happens unless an approved contract exists.
2. **Deterministic meaning** — Ambiguous business metrics either map to an existing metric definition or trigger clarifying questions.
3. **Safety-by-default** — PII columns are blocked (not masked). Row limits are enforced. Fact tables require time filters.
4. **Provenance** — Every answer includes: bundles/tables used, metric IDs used, policy checks passed.
5. **Minimal friction** — Contracts/policy are mostly invisible; shown only on "Why trust this?" or when blocked.

### 4.2 Non-Goals (V1)

- OpenMetadata integration (deferred to V2)
- Full RBAC / role-based access control system (deferred; V1 relies on DB permissions + optional app roles if present)
- DB-level proxy enforcement (RLS / views / query firewall)
- Advanced masking/tokenization pipelines
- Real-time OM API lookups

### 4.3 Project File Layout

```
<project>/
  dazense_config.yaml
  semantics/
    semantic_model.yml
    business_rules.yml
  datasets/
    <bundle_id>/
      dataset.yaml
  policies/
    policy.yml
  contracts/
    runs/
      2026-03-05T12-34-56Z_8f2a9c1b.json
```

No `openmetadata/` directory, no `rbac.yml`, no compiled `.sql` snapshots.

### 4.4 Dataset Bundles (`datasets/<bundle_id>/dataset.yaml`)

#### Purpose

Bundles define "what data product am I allowed to use?" and prevent the agent from:

- Joining arbitrary tables based on column name similarity
- Drifting across domains without user awareness

#### Schema

```yaml
version: 1
bundle_id: zava_retail
display_name: 'ZAVA — Retail Analytics'
description: 'Curated retail dataset for orders, customers, products, inventory.'

owners:
    - name: 'Data Platform'
      email: 'data-platform@example.com'

warehouse:
    type: postgres
    database_id: zava # maps to dazense_config.yaml databases[].name

tables:
    - schema: retail
      table: orders
    - schema: retail
      table: customers

joins:
    # Allowlisted join graph edges only. No other joins allowed in this bundle.
    - left: { schema: retail, table: orders, column: customer_id }
      right: { schema: retail, table: customers, column: customer_id }
      type: many_to_one
      description: 'Orders → Customers'

defaults:
    time_column_by_table:
        retail.orders: created_at
    max_rows: 200
    require_time_filter_for_tables:
        - retail.orders

certification:
    level: certified # certified | candidate | experimental

use_cases:
    - id: revenue_reporting
      question_examples:
          - 'Revenue last month by region'
          - 'Top products by revenue'
```

#### Enforcement rules

- Queries may only reference tables listed in `tables`.
- Joins must match one of the allowlisted `joins` edges.
- Cross-bundle joins are blocked in V1.

### 4.5 Policy File (`policies/policy.yml`)

#### Purpose

Policies are machine-enforced constraints. They are not documentation.

#### Schema

```yaml
version: 1

defaults:
    max_rows: 200
    max_preview_rows: 20
    require_limit_for_raw_rows: true
    require_time_filter_for_fact_tables: true
    time_filter_max_days_default: 90

pii:
    mode: block # block | mask (V1: block only)
    tags:
        - 'PII'
        - 'Sensitive'
    columns:
        # In V1, PII columns are declared here directly.
        # In V2, these are auto-discovered by the OpenMetadata profiler.
        retail.customers: [email, phone, address]
        retail.orders: [shipping_address]

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
    # Backward compatibility:
    # - false: current dazense behavior (tools can run without contracts)
    # - true: strict Trusted Analytics Copilot mode (contract required)
    require_contract: false
    # If true, contract must include a dataset bundle (recommended for enterprise projects).
    require_bundle: false
    # Validate that the executed SQL matches the contract/policies by parsing SQL (no “trust the agent”).
    sql_validation:
        mode: parse # parse (V1) | compile (future)
        disallow_multi_statement: true
        enforce_limit: true
```

### 4.6 Execution Contracts (`contracts/runs/*.json`)

#### Purpose

The contract is the "semantic API call" artifact: an unambiguous representation of what will be computed and why it's allowed.

#### Schema

```json
{
	"version": 1,
	"contract_id": "8f2a9c1b",
	"created_at": "2026-03-05T12:34:56Z",
	"project_path": "/path/to/project",

	"actor": {
		"role": "user",
		"user_id": "local",
		"session_id": "abc123"
	},

	"request": {
		"user_prompt": "What was revenue last month by region?",
		"intent": "metric_query",
		"ambiguity": {
			"is_ambiguous": false,
			"notes": []
		}
	},

	"scope": {
		"warehouse": { "type": "postgres", "database_id": "zava" },
		"dataset_bundles": ["zava_retail"],
		"tables": ["retail.orders", "retail.customers"],
		"time_window": {
			"type": "last_month",
			"resolved_start": "2026-02-01",
			"resolved_end": "2026-02-28"
		},
		"grain": "day"
	},

	"meaning": {
		"metrics": [
			{
				"id": "orders.total_revenue",
				"source": "semantic_model",
				"definition_notes": ["Excludes cancelled orders per business_rules:cancelled_orders_excluded"]
			}
		],
		"guidance_rules_referenced": ["cancelled_orders_excluded"]
	},

	"execution": {
		"tool": "query_metrics",
		"params": {
			"model_name": "orders",
			"measures": ["total_revenue"],
			"dimensions": ["region"],
			"filters": [{ "field": "status", "op": "ne", "value": "cancelled" }],
			"order_by": [{ "field": "total_revenue", "direction": "desc" }],
			"limit": 200
		}
	},

	"policy": {
		"decision": "allow",
		"checks": [
			{ "name": "pii_block", "status": "pass" },
			{ "name": "bundle_tables_only", "status": "pass" },
			{ "name": "bundle_join_allowlist", "status": "pass" },
			{ "name": "time_filter_required", "status": "pass" }
		]
	}
}
```

### 4.7 `build_contract` — Explicit Agent Tool

This is the key design change from the original plan. Instead of an implicit "Resolution" wrapper, `build_contract` is a **first-class agent tool** that the LLM calls explicitly.

#### Why an explicit tool?

- The agent decides **when** to draft a contract (after understanding the question, before executing)
- The tool returns structured feedback the agent can act on (block reasons, clarification questions)
- It's visible in the tool call log — no hidden magic

#### Tool interface

```
build_contract({
  user_prompt: string,
  bundle_id?: string | null,      // null/omitted means “not chosen yet”
  tables: string[],
  joins?: JoinSpec[],
  metric_refs?: string[],
  time_window?: TimeWindow,
  tool: "execute_sql" | "query_metrics",
  params: object
})
```

#### Returns

```ts
type BuildContractResult =
	| { status: 'allow'; contract_id: string; contract: Contract }
	| { status: 'block'; reason: string; fixes: string[] }
	| { status: 'needs_clarification'; questions: string[] };
```

#### Contract lifecycle

1. Agent calls `build_contract` with its plan for the query.
2. `build_contract` validates against bundles and policies.
3. If `allow`: contract is persisted to `contracts/runs/`, `contract_id` is returned.
4. Agent calls `execute_sql` or `query_metrics` with the `contract_id`.
5. The execution tool verifies the `contract_id` exists before proceeding.
6. Tool output includes `contract_id` so the UI can show provenance.

#### Bundle selection behavior (supports “analyze now” users)

`build_contract` must support cases where the user did not pick a bundle in advance:

- If `execution.require_bundle=true` and `bundle_id` is missing/null:
    - return `needs_clarification` with:
        - 1 question (“Which dataset bundle should we use?”)
        - up to 3 suggested bundles (based on table/metric hints if available; otherwise list the top bundles)
- If `execution.require_bundle=false` and `bundle_id` is missing/null:
    - allow building a contract with `dataset_bundles=[]` but still enforce:
        - PII block
        - mandatory limit rules
        - time-filter rules (where detectable)
    - the contract must still list referenced `tables` explicitly

### 4.8 Gated Tools

`execute_sql` and `query_metrics` are modified to support both legacy mode and strict mode.

#### Legacy mode (default for backward compatibility)

- If `execution.require_contract=false`:
    - Tools work as they do today.
    - They may still attach _optional_ provenance if a `contract_id` is provided.

#### Strict mode (Trusted Analytics Copilot)

- If `execution.require_contract=true`:
    - Tools require a valid `contract_id` and enforce that the execution matches the contract (see SQL parsing validation below).

In strict mode:

- If `contract_id` is missing → hard block with message: "You must call `build_contract` first."
- If `contract_id` doesn't match a persisted contract → hard block.
- If valid → proceed to execute.

#### SQL parsing validation (required for meaningful contracts)

Without this, a contract is just an audit log and the agent could execute SQL that violates scope/safety.

For `execute_sql` (and optionally for `query_metrics` once SQL is available), enforce at execution time:

- Parse SQL and extract:
    - referenced tables
    - referenced columns (best-effort; some expressions may be ambiguous)
    - presence/absence of LIMIT
    - presence/absence of time filter predicates (best-effort, per configured time columns)
- Validate against contract + policy:
    - all referenced tables must be included in `contract.scope.tables`
    - tables must be allowed by the selected bundle(s) when `bundle_id` is present
    - no referenced columns are in the PII blocklist
    - enforce a LIMIT when `require_limit_for_raw_rows=true` (add a LIMIT if policy allows auto-fix; otherwise block)
    - block multi-statement SQL if `disallow_multi_statement=true`

If parsing fails, default to **block** with a clear error (“Unable to validate SQL against policy/contract”).

### 4.9 System Prompt Updates

The agent's system prompt must include a new section with these instructions:

> **Trusted Execution Rules**
>
> - You must work within dataset bundles. Only use tables and joins listed in the active bundle.
> - PII columns are blocked. Do not SELECT them. If a user asks for PII data, explain that it is blocked by policy.
> - If a business metric is ambiguous (e.g., "revenue" could mean gross or net), call `build_contract` to check, and ask the user for clarification if needed. Do not guess.
> - Always call `build_contract` before calling `execute_sql` or `query_metrics`. Never skip the contract step.
> - If `build_contract` returns `block` or `needs_clarification`, relay the feedback to the user. Do not retry with the same parameters.

The system prompt also receives the loaded bundle summaries and policy summary at conversation start, so the agent knows what data products are available.

### 4.10 `dazense validate` CLI Command

A new CLI command that checks consistency across all project governance files:

```bash
dazense validate [--project-path <path>]
```

Checks performed:

- Do bundle tables exist in configured databases?
- Do PII columns in `policy.yml` exist in bundle tables?
- Do join allowlist columns exist in the referenced tables?
- Do semantic model metric references align with bundle tables?
- Are there bundles with no tables or empty join lists?

Output: list of errors/warnings with file paths and line references.

### 4.11 Runtime Flow

```
Current (today):
  Agent → execute_sql / query_metrics → FastAPI → DB → results

New (V1):
  User question
    → Agent reasons about the question
    → Agent calls build_contract(bundle, tables, joins, metrics, params)
    → Policy engine evaluates → allow / block / needs_clarification
      → if allow:  contract persisted, agent calls execute_sql/query_metrics with contract_id
                   → results returned with provenance (contract_id, sources, checks)
      → if block:  agent receives reason + suggested fixes, explains to user
      → if clarify: agent receives questions, asks user, then retries build_contract
```

### 4.12 UI Provenance

In tool outputs (SQL or metrics results), show by default:

- **Contract**: `contract_id`
- **Sources**: bundle(s), tables
- **Definition used**: metric IDs (if `query_metrics`), plus key guidance rule references
- **Safety**: "PII blocked", "Join allowlist enforced", "Limit applied", "Time filter applied"

Progressive disclosure: a "Why trust this?" expandable section shows:

- Full contract JSON (collapsed)
- Policy checks list
- Bundle/table details

### 4.13 Defense-in-Depth (FastAPI, optional)

MVP can rely on backend-only enforcement, but we recommend a minimal safety check in FastAPI:

- If the request includes `contract_id`, verify a corresponding contract file exists in the project folder.

This prevents accidental bypasses if tools are called directly.

---

## 5. V2: OpenMetadata Integration

V2 is built after V1 is stable and proven. The enforcement code is unchanged — only the data inputs improve.

### 5.0 V2 Scope (split to reduce risk)

- **V2a (recommended first):** OpenMetadata snapshot drives PII/owners/certification/quality + provenance UI + policy checks.
- **V2b (later):** lineage-assisted bundle suggestions and partial bundle generation (human review required).

### 5.1 What OM Adds

| Capability              | V1 (manual)                 | V2 (with OM)                                                 |
| ----------------------- | --------------------------- | ------------------------------------------------------------ |
| Dataset bundles         | Hand-authored YAML          | Lineage-assisted suggestions + partial generation (reviewed) |
| PII detection           | `pii.columns` in policy.yml | Auto-discovered by OM profiler                               |
| Metric resolution       | Semantic model only         | OM glossary terms align with metric IDs                      |
| Quality gates           | None                        | Block queries on stale/failing tables                        |
| Ownership/certification | Static YAML                 | Live from OM catalog                                         |

### 5.2 Snapshot Format

Store a single JSON file with governance signals consumed by the policy engine:

```json
{
	"version": 1,
	"generated_at": "2026-03-05T12:00:00Z",
	"source": { "type": "openmetadata", "base_url": "https://om.company.com" },
	"tables": {
		"postgres.zava.retail.orders": {
			"owners": [{ "name": "Retail Analytics", "type": "team" }],
			"certification": "certified",
			"tags": ["Tier.T1"],
			"pii": { "contains_pii": true, "columns": ["email", "phone"] },
			"glossary_terms": ["Retail.Order", "Customer"],
			"quality": { "tests_passing": true, "freshness_hours": 3 }
		}
	}
}
```

### 5.3 `dazense openmetadata sync`

CLI command that downloads the minimal snapshot using an OM API token:

```bash
dazense openmetadata sync --url https://om.company.com --token <token>
```

### 5.4 V2 Project File Layout

```
<project>/
  dazense_config.yaml
  semantics/
    semantic_model.yml
    business_rules.yml
  datasets/
    <bundle_id>/
      dataset.yaml          # can now be auto-generated
  policies/
    policy.yml              # pii.columns auto-populated from OM
  openmetadata/
    snapshot.json            # governance signals from OM
  contracts/
    runs/
      <timestamp>_<id>.json
```

---

## 6. Code Changes (V1)

### 6.1 New Files

| File                                                          | Purpose                                                  | Status |
| ------------------------------------------------------------- | -------------------------------------------------------- | ------ |
| `apps/shared/src/tools/build-contract.ts`                     | Zod schemas for build_contract (input, output, contract) | ✅     |
| `apps/backend/src/contracts/contract-writer.ts`               | Persist/load contracts to `contracts/runs/`              | ✅     |
| `apps/backend/src/policy/policy-engine.ts`                    | Evaluate policy checks, return allow/block/clarify       | ✅     |
| `apps/backend/src/policy/sql-validator.ts`                    | SQL parsing + contract/policy validation                 | ✅     |
| `apps/backend/src/agents/tools/build-contract.ts`             | `build_contract` agent tool implementation               | ✅     |
| `apps/backend/src/components/tool-outputs/build-contract.tsx` | Tool output component                                    | ✅     |
| `apps/backend/tests/sql-validator.test.ts`                    | 31 unit tests for SQL validator                          | ✅     |
| `cli/dazense_core/commands/validate.py`                       | `dazense validate` CLI command                           | ✅     |

> **Note:** Policy loading and bundle loading are implemented as `getPolicies()` and `getDatasetBundles()` in `apps/backend/src/agents/user-rules.ts` (following the existing `getSemanticModels()` pattern), not as separate loader files.

### 6.2 Modified Files

| File                                                | Change                                                    | Status |
| --------------------------------------------------- | --------------------------------------------------------- | ------ |
| `apps/shared/src/tools/execute-sql.ts`              | Add optional `contract_id` field                          | ✅     |
| `apps/shared/src/tools/query-metrics.ts`            | Add optional `contract_id` field                          | ✅     |
| `apps/shared/src/tools/index.ts`                    | Export `buildContract` schemas                            | ✅     |
| `apps/backend/src/agents/tools/execute-sql.ts`      | Contract gate + SQL validation before `executeQuery()`    | ✅     |
| `apps/backend/src/agents/tools/query-metrics.ts`    | Contract gate + full parameter validation                 | ✅     |
| `apps/backend/src/agents/tools/index.ts`            | Register `build_contract` tool with `hasPolicies()` check | ✅     |
| `apps/backend/src/components/system-prompt.tsx`     | Add "Trusted Execution Rules" section                     | ✅     |
| `apps/backend/src/agents/user-rules.ts`             | Add `getPolicies()` and `getDatasetBundles()` loaders     | ✅     |
| `apps/backend/src/components/tool-outputs/index.ts` | Export `BuildContractOutput`                              | ✅     |

### 6.3 New Project-Level Files (per dazense project)

| File                                | Notes                                        | Status                                                  |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------------------- |
| `datasets/<bundle_id>/dataset.yaml` | Hand-authored in V1                          | ✅ Example: `example/datasets/jaffle_shop/dataset.yaml` |
| `policies/policy.yml`               | Hand-authored, includes PII columns directly | ✅ Example: `example/policies/policy.yml`               |
| `contracts/runs/*.json`             | Auto-generated at runtime                    | ✅                                                      |

### 6.4 Policy Engine Internals

```ts
type PolicyDecision =
	| { status: 'allow'; checks: CheckResult[] }
	| { status: 'block'; reason: string; fixes: string[]; checks: CheckResult[] }
	| { status: 'needs_clarification'; questions: string[]; checks: CheckResult[] };

interface CheckResult {
	name: string; // e.g. "pii_block", "bundle_tables_only"
	status: 'pass' | 'fail' | 'warn';
	detail?: string;
}
```

---

## 7. Test Strategy

### Warehouses

- Primary: **PostgreSQL**

### Datasets

- CI: synthetic deterministic dataset (fast, stable assertions)
- Realism checks: **TPC-H** + **ZAVA** (public)

### Acceptance Tests (V1)

1. **PII block** — Query selects a PII-tagged column → blocked with fix guidance.
2. **Join allowlist** — Query attempts a non-allowlisted join → blocked.
3. **Time filter requirement** — Query on a fact table without time filter → needs clarification or auto-adds default window; must be explicit in contract.
4. **Deterministic metric meaning** — "Revenue last month" resolves to the same metric + same filters every time.
5. **Contract gate** — `execute_sql` called without `contract_id` → hard block.
6. **Provenance rendering** — UI shows contract_id + sources + checks.

---

## 8. Rollout

### Backward Compatibility

- Projects that only have `semantics/*` continue to work unchanged.
- New folders (`datasets/`, `policies/`, `contracts/`) are optional.
- If `policies/` is missing → load safe defaults: PII block on, row limit 200, join allowlist off, `execution.require_contract=false`.

### Recommended Adoption Steps (per customer)

1. Add bundles for their key domain dataset(s).
2. Add `policy.yml` with PII column declarations.
3. Add certified metrics in semantic model.
4. Turn on strict mode (require bundles + require certification) later.

---

## 9. Deliverables Checklist

### V1 — Done means:

- [x] Dataset bundle loader + validator — `getDatasetBundles()` in `user-rules.ts`, reads `datasets/*/dataset.yaml`
- [x] Policy loader + policy engine + clear user-facing block messages — `getPolicies()` in `user-rules.ts`, `policy-engine.ts` with 6 checks, three-state output (allow/block/needs_clarification)
- [x] Contract schema (Zod) + persistence + inclusion in tool outputs — `build-contract.ts` (shared), `contract-writer.ts`, contracts include `approved_joins` and `time_columns`
- [x] `build_contract` agent tool (explicit, not wrapper) — `build-contract.ts` tool + `build-contract.tsx` output component
- [x] Gated execution for `execute_sql` and `query_metrics` — contract gate + SQL validation in `execute-sql.ts`, full parameter validation (measures, dimensions, filters with column+operator+value, order_by with column+direction, limit) in `query-metrics.ts`
- [x] System prompt updates (policy/bundle/contract instructions) — "Trusted Execution Rules" section in `system-prompt.tsx`
- [x] `dazense validate` CLI command — `cli/dazense_core/commands/validate.py`
- [x] UI provenance surfaced in tool output components — `BuildContractOutput` component shows status, contract_id, checks, and feedback
- [x] Tests: unit + integration for policy engine, contract tool, and gating behavior — 31 tests in `sql-validator.test.ts` covering PII, tables, limits, joins, time columns, multi-statement

### V2 — Done means:

- [ ] OpenMetadata snapshot ingestion (`dazense openmetadata sync`)
- [ ] V2a: Policy + provenance driven by OM signals (PII/owners/certification/quality)
- [ ] V2b: Lineage-assisted bundle suggestions / partial generation (reviewed)
- [ ] PII auto-discovery from OM profiler
- [ ] Glossary-driven metric resolution
- [ ] Live quality gates (block on stale/failing tables)

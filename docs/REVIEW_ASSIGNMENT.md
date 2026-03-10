# Code Review Assignment: V1 — Trusted Analytics Copilot

**Reviewer**: Developer
**Author**: AI-assisted (Claude Code + manual testing with GPT 5.2 and Kimi 2.5)
**Priority**: High — this is the governance enforcement layer for dazense

---

## What was built

A three-layer governance system that controls how LLMs access and compute data. The system ensures that different LLMs produce **consistent, correct results** regardless of model choice.

| Layer              | Purpose                                              | Key files                                 |
| ------------------ | ---------------------------------------------------- | ----------------------------------------- |
| **Semantic model** | Bakes business logic into metric definitions         | `semantic_model.yml`, `engine.py`         |
| **Policy engine**  | Enforces PII blocking, bundle scoping, time filters  | `policy-engine.ts`, `policy.yml`          |
| **Contracts**      | Audit trail for every query (who, what, why allowed) | `build-contract.ts`, `contract-writer.ts` |

---

## Files to review

### Priority 1: Core enforcement (review carefully)

| File                                                | What it does                                                                              | What to check                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `apps/backend/src/policy/policy-engine.ts`          | 10 checks: ambiguity, bundle, PII, time filter, limit, metrics, business rules, execution | Correct check ordering, no bypass paths, edge cases           |
| `apps/backend/src/agents/tools/build-contract.ts`   | Orchestrates policy evaluation, persists contracts                                        | Input validation, error handling, correct wiring              |
| `apps/shared/src/tools/build-contract.ts`           | Zod schemas: Contract, Input, Output, Policy, Bundle                                      | Schema completeness, required vs optional fields              |
| `apps/backend/src/policy/business-rules-matcher.ts` | Matches business rules to query context (tables, metrics, SQL)                            | Matching logic correctness, false positive/negative risk      |
| `apps/backend/src/policy/sql-validator.ts`          | Regex-based SQL parsing, validates against contract                                       | SQL injection risk, regex edge cases, join detection accuracy |
| `cli/dazense_core/semantic/engine.py`               | Ibis semantic engine with measure-level filters (`where=`)                                | Filter application, aggregation correctness                   |
| `cli/dazense_core/semantic/models.py`               | Pydantic models: Measure with filters, Classification with optional condition             | Model validation, backward compatibility                      |

### Priority 2: Integration points

| File                                                          | What changed                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `apps/backend/src/agents/user-rules.ts`                       | Added `getPolicies()`, `getDatasetBundles()`, expanded `getBusinessRules()` with `applies_to`                         |
| `apps/backend/src/components/system-prompt.tsx`               | Added Trusted Execution Rules section: ambiguity assessment, PII blocking, time filter resolution, `all_time` support |
| `apps/backend/src/agents/tools/execute-sql.ts`                | Added contract gate (checks `contract_id` when `require_contract: true`)                                              |
| `apps/backend/src/agents/tools/query-metrics.ts`              | Same contract gate pattern                                                                                            |
| `apps/backend/src/contracts/contract-writer.ts`               | `persistContract()` and `loadContract()` — writes JSON to `contracts/runs/`                                           |
| `apps/backend/src/components/tool-outputs/build-contract.tsx` | Renders contract status (allow/block/needs_clarification) in chat UI                                                  |
| `apps/shared/src/tools/classify.ts`                           | Made `condition` optional, added `columns` array (bug fix)                                                            |
| `cli/dazense_core/rules/models.py`                            | Made `condition` optional, added `columns` field to Classification (bug fix)                                          |

### Priority 3: CLI commands

| File                                    | What it does                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `cli/dazense_core/commands/eval.py`     | `dazense eval` — runs governance test cases from bundle, produces scorecard   |
| `cli/dazense_core/commands/validate.py` | `dazense validate` — checks config consistency (bundle↔policy↔semantic model) |
| `cli/dazense_core/main.py`              | Registered `eval` and `validate` commands                                     |
| `cli/dazense_core/commands/__init__.py` | Added exports                                                                 |

### Priority 4: Example project & docs

| File                                         | What it does                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `example/policies/policy.yml`                | PII blocking (first_name, last_name), time filters, bundle enforcement                  |
| `example/datasets/jaffle_shop/dataset.yaml`  | Bundle with tables, joins, `data_start_date`, `demo_current_date`, `eval_test_cases`    |
| `example/semantics/semantic_model.yml`       | `total_revenue` measure with baked-in filter (`status NOT IN returned, return_pending`) |
| `example/semantics/business_rules.yml`       | 10 rules + 2 classifications (PII, Financial)                                           |
| `example/demo-mode.ps1`                      | Toggles between none/semantic/full governance modes                                     |
| `docs/TESTING_V1.md`                         | End-to-end test plan for all 3 modes                                                    |
| `docs/findings-llm-governance-comparison.md` | 6 findings from GPT 5.2 vs Kimi 2.5 comparison                                          |

---

## Key design decisions to validate

### 1. Measure-level filters (engine.py)

Revenue exclusion (`WHERE status NOT IN ('returned', 'return_pending')`) is baked into the `total_revenue` measure definition using Ibis `where=` parameter. This makes it **LLM-agnostic** — the filter runs regardless of which model calls `query_metrics`.

**Review**: Is the Ibis `where=` parameter correctly applied across all aggregation types (count, sum, avg, min, max, count_distinct)?

### 2. Ambiguity enforcement (policy-engine.ts + build-contract.ts)

The `ambiguity` field is required in the `build_contract` input. If `is_ambiguous: true`, the policy engine returns `needs_clarification` before any query runs.

**Review**: Is a required boolean the right approach? Could an LLM always set `is_ambiguous: false` to skip the check? Is there a way to validate the assessment?

### 3. `all_time` time window resolution (policy-engine.ts)

When `time_window.type === "all_time"`, the policy engine auto-resolves to `data_start_date` → `demo_current_date` from the bundle. This prevents LLMs from getting stuck in a loop when users say "all time."

**Review**: What happens if `data_start_date` or `demo_current_date` is missing? Should it fall back to no resolution or block?

### 4. Business rules matching (business-rules-matcher.ts)

Rules are matched to contracts by comparing `applies_to` entries against the query's tables, metric refs, and SQL text. The matching normalizes schema prefixes (`main.orders` matches `orders`).

**Review**: Is the matching too aggressive (false positives) or too lenient (false negatives)? Does SQL text matching risk matching substrings incorrectly?

### 5. SQL validator (sql-validator.ts)

Uses regex-based parsing (not a SQL AST parser) to extract tables, columns, and joins from SQL. This is a pragmatic trade-off — `node-sql-parser` was too heavy.

**Review**: What SQL patterns break the regex? Are there injection vectors? Should we add a note about known limitations?

### 6. Contract persistence (contract-writer.ts)

Contracts are written as JSON files to `contracts/runs/{timestamp}_{id}.json`. No rotation, no cleanup, no size limits.

**Review**: Should there be a retention policy? What happens after 10K contracts?

---

## How to test

### Quick validation

```powershell
cd example/
dazense validate         # Config consistency
dazense eval             # Governance test cases (9 tests)
dazense eval --scorecard # Configuration completeness (8 checks)
```

### Full end-to-end test

Follow `docs/TESTING_V1.md` — tests all 3 modes (none → semantic → full) with specific prompts and expected behaviors. Use `demo-mode.ps1` to switch modes.

### Key numbers to verify

| Query                  | None mode     | Semantic mode   | Full mode                 |
| ---------------------- | ------------- | --------------- | ------------------------- |
| Total revenue          | 1,672 (wrong) | 1,585 (correct) | 1,585 (correct + audited) |
| PII query              | Returns names | Depends on LLM  | Blocked                   |
| Orders (all time)      | 99            | 99              | 99 (with time window)     |
| Orders (status=placed) | 13            | 13              | 13                        |

### Run the app

```powershell
cd C:\Users\hzmarrou\OneDrive\python\learning\dazense
npm run dev
# Open http://localhost:5005
```

---

## Questions for the reviewer

1. **Security**: Is the SQL validator sufficient, or do we need a proper AST parser?
2. **Scalability**: Should contract persistence use a database instead of flat files?
3. **Ambiguity**: Can an LLM game the ambiguity check by always setting `is_ambiguous: false`?
4. **Coverage**: Are there governance scenarios not covered by the 10 policy checks?
5. **Testing**: Should `dazense eval` also test with actual LLM calls (not just structural checks)?

---

## Reference documents

- `docs/findings-llm-governance-comparison.md` — Real test results showing why each constraint was needed
- `docs/TESTING_V1.md` — Step-by-step testing guide
- `docs/trusted-analytics-copilot-implementation_plan.md` — Original implementation plan
- `docs/architecture.md` — System architecture

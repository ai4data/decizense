# dazense+ : Commercialization Plan

## Vision

Transform dazense from an open-source SQL generation tool into a **production-ready analytics reasoning platform** by integrating a semantic layer and business rules engine, then commercializing via an open-core model with a hosted cloud offering.

---

## Context

### What dazense is today

dazense is an open-source framework for building analytics agents. Users define a project context (databases, metadata, docs, tools) via a Python CLI, then deploy a chat UI where business users ask questions in natural language and get data insights.

**Current stack:** Python CLI (dazense-core) + TypeScript backend (Fastify/tRPC/Bun) + React frontend (TanStack/Shadcn) + FastAPI tools server.

### The gap

dazense's agent writes **raw SQL from scratch every time**. It reads schema markdown files, infers table relationships, and generates queries. This works for simple cases but has real failure modes:

- **Inconsistent answers** — same question, different SQL, different numbers
- **Wrong joins** — LLM guesses relationships from column names
- **No metric governance** — "revenue" has no single definition
- **No business context** — agent can produce correct numbers with misleading interpretations
- **Token waste** — agent reads files and reasons about schema on every query

### The opportunity

Integrate a **semantic layer** (consistent metric definitions) and **business rules engine** (domain knowledge and caveats) into dazense. This IP comes from the datazense project, which demonstrated a 3-layer metadata architecture (Technical/Semantic/Ontology) for AI-powered analytics.

---

## Terminology (vNext)

To avoid confusion, we use these names:

- `semantics/semantic_model.yml` = **Metrics** (machine-executable “semantic API” via `query_metrics`)
- `semantics/business_rules.yml` = **Guidance** (definitions, caveats, interpretation notes for humans + agent)
- `datasets/**/dataset.yaml` = **Dataset Bundles** (data products: tables + allowed joins + use-cases)
- `policies/**/*.yml` = **Enforcement** (machine rules: PII/RBAC/limits/certification requirements)
- `contracts/runs/*.json` = **Execution Contracts** (generated per question; validated before any execution)

Important: “semantic contract” is not a YAML file. The contract is the per-run artifact (`contracts/runs/*.json`).

---

## Roadmap (Trusted Analytics Copilot)

### Phase 1 — Trust Layer (the “killer feature”) ✅ IMPLEMENTED

> **Status:** All Phase 1 components are implemented and tested. See `docs/trusted-analytics-copilot-implementation_plan.md` for the full technical spec and `docs/TESTING_V1.md` for a hands-on tutorial.

Goal: every answer is defined, safe, reproducible, and auditable.

What we added on top of existing Metrics + Guidance:

1. **Execution Contract (Resolution step)** ✅
    - Agent calls `build_contract` tool before running `execute_sql` or `query_metrics`.
    - Contract references metric IDs, guidance rules, approved tables, joins, and time columns.
    - Contracts are persisted as JSON in `contracts/runs/` for audit.

2. **Policy Gate (Enforcement step)** ✅
    - Policy engine enforces PII blocking, join allowlists, required time filters, row limits.
    - SQL validator parses actual SQL at execution time (fail-closed: parse failure = block).
    - Three-state response: allow (with contract_id), block (with reason + fixes), or needs_clarification (with questions).

3. **Dataset Bundles** ✅
    - `datasets/<bundle_id>/dataset.yaml` defines table allowlists + approved join edges.
    - JOIN ON conditions validated against approved edges (bidirectional matching).
    - Example: jaffle_shop bundle with 3 tables, 2 approved joins, time filter enforcement.

4. **Provenance** ✅
    - Tool outputs include contract_id, bundle, tables, and safety checks passed.
    - Full contract JSON available in `contracts/runs/` for inspection.

### Phase 2 — OpenMetadata Integration (input)

Goal: enterprise governance signals flow into dazense enforcement.

- Ingest OpenMetadata into a local snapshot cache (PII tags, owners, glossary, certification, quality).
- Policy gate uses these signals (still enforced inside dazense).

### Phase 3 — Dataset Discovery / Recommendation (optional tool)

Goal: help users pick the right dataset bundle when they don’t know it.

- Agent recommends 1–3 bundles based on OpenMetadata glossary + bundle use-cases.
- User confirms selection; then normal contract → policy → execute.

---

## Commercialization Model

### Open-core

| Tier           | Price             | Features                                                                    |
| -------------- | ----------------- | --------------------------------------------------------------------------- |
| **Community**  | Free              | CLI, single-user chat, raw SQL agent, basic auth                            |
| **Team**       | $20-50/seat/month | Semantic layer, business rules, shared chat history, usage analytics, Slack |
| **Enterprise** | Custom            | SSO, audit logs, RBAC, on-prem, SLA, scheduled reports                      |

### Revenue path

1. **Cloud hosted** — primary revenue driver, lowest friction
2. **Enterprise licenses** — for companies that need on-prem
3. **Support contracts** — for teams that need guaranteed response times

### Competitive edge

The semantic layer + business rules engine is the moat. Open-source dazense writes raw SQL (anyone can do that). Paid dazense delivers **governed, consistent, context-aware analytics** — that's what enterprises pay for.

---

## Risks

| Risk                                          | Mitigation                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| Semantic model is hard for users to write     | Auto-generate starter model from database schema during `dazense sync` |
| Agent picks wrong tool (semantic vs raw SQL)  | Careful prompt engineering + fallback logic                            |
| Ibis doesn't support a target database        | Ibis supports 20+ backends — unlikely, but can add raw SQL fallback    |
| boring-semantic-layer was simpler than custom | Custom code is ~300-500 lines, well within maintenance budget          |
| Cloud hosting costs                           | Start with single-region, scale based on revenue                       |

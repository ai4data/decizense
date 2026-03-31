# dazense Enterprise Roadmap

This document tracks enterprise-grade features for dazense's governance enforcement layer. Each section describes the feature, the current state, the enterprise target, and implementation notes.

---

## 1. Governance Propagation from OMD

### Current

Snapshot-based: `dazense sync -p openmetadata` dumps a JSON file. dazense reads it at compile time. Stale the moment it's written.

### Enterprise Target

Event-driven: OMD pushes metadata changes to dazense via webhooks. The governance graph updates in real-time without re-sync.

### Implementation Notes

- OMD 1.12 has `/api/v1/events/subscriptions` for webhook registration
- dazense backend needs an HTTP endpoint to receive OMD events
- Events to subscribe to: tag changes, lineage updates, glossary term changes, ownership changes
- Hybrid model: snapshot at startup + webhook for live updates + live API fallback
- Consider retry/dead-letter for missed events

---

## 2. Agent Identity & Authentication

### Current

OMD bot with JWT token (90-day expiry). Token stored in `dazense_config.yaml` via env var. Manual rotation.

### Enterprise Target

Short-lived tokens with auto-rotation. IETF agent auth framework (WIMSE/SPIFFE identifiers, OAuth 2.0 delegation).

### Implementation Notes

- Reference: `Agents_Auth.pdf` (IETF draft-klrc-aiagent-auth-00, March 2026)
- Agent identifier: stable URI per agent instance (e.g., `dazense://company.com/retail-agent`)
- Credential provisioning: auto-rotate JWT before expiry via OMD API
- User delegation: user authenticates → delegates authority to agent → agent acts with user's permissions (OAuth Authorization Code Grant)
- Transaction tokens: scoped per-query tokens to limit blast radius (Section 10.4 of IETF draft)
- Attestation: defer to V4 (requires TEE/TPM infrastructure)

---

## 3. Policy Engine

### Current

Python-based policy checks in `governance_graph.py`. Checks PII, bundles, joins, SQL validation. Rules in YAML.

### Enterprise Target

OPA (Open Policy Agent) with Rego policies. Declarative, auditable, sub-millisecond evaluation. Decision logging built in.

### Implementation Notes

- Compile OMD tags + dazense rules → Rego policies
- dazense sends `{ agent_role, tables, columns, action }` to OPA
- OPA returns `{ allow: false, reason: "column first_name is PII" }`
- YAML files become a human-friendly authoring layer that compiles to Rego
- OPA decision logs → audit trail
- Consider OPA as sidecar or embedded (WASM) for low-latency

---

## 4. Audit Trail & Observability

### Current

Contract system logs query decisions to `contracts/runs/*.json`. Not structured for compliance. No correlation across systems.

### Enterprise Target

Structured audit log with: agent ID, delegated user, resource accessed, authorization decision, timestamp, correlation ID. Correlated across OMD + dazense + database.

### Implementation Notes

- IETF draft Section 11: audit events MUST record agent identifier, delegated subject, resource, action, decision, timestamp
- OMD already logs bot API calls (audit endpoint: `/api/v1/audit/logs`)
- dazense needs structured decision log format (JSON lines or OpenTelemetry)
- Correlation ID flows from user request → agent → OMD API call → database query
- Consider OpenID Shared Signals Framework for cross-system event correlation
- Tamper-evident logs for compliance (append-only, signed)

---

## 5. Quality Gates

### Current

No data quality integration. Agent queries any table regardless of quality status.

### Enterprise Target

Agent checks OMD data quality test results before querying. Tables failing quality tests trigger warnings or blocks.

### Implementation Notes

- OMD endpoints: `/api/v1/dataQuality/testCases`, `/testSuites/executionSummary`
- Snapshot should include `quality.tests_passing`, `quality.freshness_hours` per table
- Policy engine rule: `block_on_failing_quality: true` → reject queries on tables with failed DQ tests
- Agent warning: "The orders table has 1 failing quality test. Results may be unreliable."
- Freshness gate: block if table not refreshed within N hours

---

## 6. Glossary-Driven Metric Resolution

### Current

Agent resolves metrics via semantic model names only. No business vocabulary mapping.

### Enterprise Target

OMD glossary terms with synonyms map to semantic model measures. User says "revenue", agent resolves to `orders.total_revenue` via glossary.

### Implementation Notes

- Glossary terms already created in OMD with synonyms and asset links
- Snapshot should include glossary terms, synonyms, related terms, asset FQNs
- Resolution chain: user input → glossary synonym match → linked asset → semantic model measure
- Typed relationships: "Revenue" _calculated from_ "Order Amount" enables the agent to explain metric composition

---

## 7. Lineage-Extended Graph

### Current

Governance graph traces lineage within the semantic layer only (measure → column → table).

### Enterprise Target

Pipeline-level lineage from OMD extends the graph into the data pipeline: source → staging → mart → semantic model → measure.

### Implementation Notes

- OMD lineage API: `/api/v1/lineage/table/name/{fqn}?upstreamDepth=N`
- Snapshot should include lineage edges
- Graph `lineageOf()` traces through both dazense edges AND OMD pipeline edges
- `graph_impact` can show: "changing raw_orders affects stg_orders → orders → total_revenue → 7 business rules"
- Column-level lineage (OMD supports it) would enable field-level impact analysis

---

## 8. Domain-Based Access Scoping

### Current

Access scoped by dataset bundle (YAML). No organizational context.

### Enterprise Target

OMD domains define organizational boundaries. Agent's bot role is scoped to specific domains. Different agents for different business units.

### Implementation Notes

- OMD domains: `/api/v1/domains` with hierarchical structure
- Bot policy can use `hasDomain('Retail')` condition to restrict access
- dazense project maps to an OMD domain
- Dataset bundles auto-generated from domain assets
- Cross-domain queries require explicit authorization

---

## 9. Data Products & Contracts

### Current

Dataset bundles are hand-authored YAML trust boundaries.

### Enterprise Target

OMD data products with ODCS (Open Data Contract Standard) contracts. Bundles auto-generated from data product definitions. Contract validation status drives query authorization.

### Implementation Notes

- OMD data products: `/api/v1/dataProducts` with input/output ports
- ODCS export: `/api/v1/dataContracts/name/{fqn}/odcs/yaml`
- Contract validation: `/api/v1/dataContracts/{id}/results/latest`
- Auto-generate `dataset.yaml` from data product: tables from assets, joins from lineage, time filters from profiler
- Contract breach → block queries until contract passes

---

## 10. Multi-LLM / Multi-Agent

### Current

Single LLM agent per dazense project. Same access for all users.

### Enterprise Target

Multiple agents with different identities and access levels. Agent selection based on user role. Different LLMs for different tasks.

### Implementation Notes

- Each agent gets its own OMD bot with scoped permissions
- User authenticates → routed to appropriate agent based on role
- Finance analyst → finance-agent (Snowflake access)
- Marketing analyst → marketing-agent (BigQuery access)
- OAuth user delegation: agent acts with user's permissions, not its own
- LLM routing: simple questions → fast model, complex analysis → capable model

---

## Priority Order

| Phase    | Features                                                               | Dependency               |
| -------- | ---------------------------------------------------------------------- | ------------------------ |
| V2 (now) | Snapshot sync, policy generation, glossary + lineage in graph          | OMD configured           |
| V3       | OPA policy engine, structured audit trail, quality gates               | OPA deployment           |
| V4       | Event-driven sync (webhooks), agent auth (OAuth/WIMSE), domain scoping | Webhook infrastructure   |
| V5       | Data products/contracts, multi-agent, auto-bundle generation           | Full OMD data mesh setup |

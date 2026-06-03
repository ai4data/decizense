# ContextGraph-MCP Extraction Design

## Goal

Separate the current Decizense harness into a standalone product and separate repository named **ContextGraph-MCP**.

ContextGraph-MCP is the governed MCP server. Decizense remains the full analytics-agent product that can use ContextGraph-MCP as a client.

The first release is extraction-first. It starts from the current working harness instead of designing a new platform from scratch, but the target home is a separate repository.

## Product boundary

### ContextGraph-MCP owns

- MCP server runtime
- MCP tool registry
- Scenario Loader
- Scenario config contract
- Governance engine
- OPA policy build and evaluation
- Semantic compiler and executor
- Catalog adapter interface
- Decision & Memory persistence
- Auth and session context
- Observability and audit hooks

### Decizense owns

- Chat UI
- App backend user experience
- Product onboarding screens
- Domain-specific application flows
- Packaged business solution around analytics agents

### External clients own

- Agent runtime
- Agent orchestration
- Agent wiring
- LLM framework choice

Agents are clients of ContextGraph-MCP. They are not part of ContextGraph-MCP core. A user can later create agents with LangChain, DeepAgent, Claude Desktop, a custom runtime, or Decizense.

## Third-party user flow

A third-party user does not need to know or install Decizense.

They need:

- ContextGraph-MCP server
- scenario pack
- data source
- optional catalog provider
- policy engine
- their own MCP client or agent

The onboarding flow is:

1. Install or run ContextGraph-MCP.
2. Create a scenario pack with `scenario.yml`, `agents.yml`, policies, datasets, and semantics.
3. Connect the scenario pack to a database or warehouse.
4. Optionally connect a catalog such as OpenMetadata, DataHub, dbt, or a custom adapter.
5. Run OPA or the supported policy evaluator.
6. Start ContextGraph-MCP with the scenario path.
7. Connect an MCP client or agent with a configured token.
8. Call `initialize_agent` to get identity, scope, tools, and rules.
9. Call governed tools such as `get_context`, `query_data`, `query_metrics`, `write_finding`, `record_outcome`, and `search_precedent`.

The expected mental model is:

```text
Install ContextGraph-MCP
Create scenario pack
Connect database/catalog/policy engine
Start MCP server
Connect your own agent or MCP client
```

Decizense is only one possible client of ContextGraph-MCP.

## Architecture

ContextGraph-MCP sits between MCP clients and governed data access.

```text
MCP clients
  - Decizense backend
  - external agents
  - Claude Desktop / custom MCP clients
        |
        v
ContextGraph-MCP
  - MCP Tool Surface
  - Scenario Loader
  - Governance Engine
  - Semantic Layer
  - Decision & Memory Layer
  - Catalog Adapter Interface
        |
        v
External systems
  - OPA
  - catalog provider: OpenMetadata, DataHub, dbt, custom
  - scenario database: Postgres, DuckDB, warehouse
```

## Core modules

### MCP Tool Surface

Exposes the public MCP tools. The first extraction should keep the existing tool families:

- context tools
- governed query tools
- semantic metric tools
- decision tools
- memory tools
- governance and verification tools
- health/admin tools where needed for operations

The tool surface is the product API. It must stay stable enough for Decizense and external agents to depend on it.

### Scenario Loader

Loads scenario packs and turns them into runtime configuration.

It loads:

- `scenario.yml`
- `agents.yml`
- `policies/policy.yml`
- `datasets/*/dataset.yaml`
- `semantics/semantic_model.yml`
- `semantics/business_rules.yml`
- optional `semantics/events.yml`
- optional `semantics/signals.yml`

The loader must validate config at startup and fail with clear errors. No domain-specific behavior should be hardcoded into ContextGraph-MCP.

### Governance Engine

Enforces policy before data or action execution.

It handles:

- agent authentication
- session identity
- delegated user context when available
- bundle scope
- PII blocking
- SQL validation
- OPA evaluation
- risk classification
- approval and execution permissions

The engine must fail closed. If policy cannot be evaluated, unsafe execution is blocked.

### Semantic Layer

Compiles governed metric requests into safe SQL.

It handles:

- metrics
- dimensions
- filters
- time ranges
- time grains
- allowed joins
- bundle scoping
- fanout protection
- parameterized SQL generation

The semantic layer should remain config-driven. Metrics and dimensions live in scenario files. SQL construction and safety rules live in code.

### Decision & Memory Layer

Stores and queries decision traces, findings, memory, and precedents.

It includes:

- proposals
- approvals
- actions
- outcomes
- findings
- memory entries
- searchable precedents
- OPA decision log links
- evidence links
- workflow/correlation identifiers

This is core product data, not optional logging. Decizense can read it for UI and product experience, but ContextGraph-MCP owns the persistence contract.

### Catalog Adapter Interface

Provides provider-agnostic metadata access.

It reads:

- schemas
- tables
- columns
- descriptions
- glossary terms
- lineage
- PII and sensitivity tags
- ownership
- certification/tier metadata
- optional bot or agent identity metadata

OpenMetadata is the first adapter. Other providers must fit behind the same interface.

## Request flow

1. MCP client calls a ContextGraph-MCP tool.
2. Auth resolves agent, session, and delegated user context.
3. Scenario Loader provides the active scenario configuration.
4. Governance Engine checks bundle scope, PII, SQL rules, OPA, and risk permissions.
5. Semantic Layer compiles safe SQL when the request is metric-based.
6. Catalog Adapter supplies metadata when context or governance needs it.
7. Scenario database executes only approved queries/actions.
8. Decision & Memory Layer records findings, decisions, outcomes, evidence, and audit links.
9. Tool returns a governed response.

## Error handling

ContextGraph-MCP must fail closed.

Blocked or error responses must be structured and explain the reason. The server must not silently fall back to unsafe execution.

Examples:

- invalid scenario config blocks startup
- auth failure blocks the session
- unavailable required OPA blocks governed execution
- unavailable required catalog blocks metadata-backed governance
- unknown metric returns a structured semantic error
- disallowed join returns a structured governance error
- out-of-bundle table access returns a blocked response
- PII access is blocked before SQL and filtered after results

## Testing strategy

The extraction is successful only if current travel harness behavior still works outside Decizense.

Required tests:

- scenario loads or fails with clear validation errors
- each MCP tool works through the standalone server
- `flight_ops` can query allowed flight operations tables
- `flight_ops` is blocked from bookings, payments, tickets, checkins, customers, and events
- OPA decisions are logged and replayable
- decision traces can be written and queried
- semantic metric requests compile parameterized SQL
- unsafe joins, unknown fields, missing time filters, and fanout risks are rejected
- PII is blocked before SQL and redacted from result persistence
- Decizense can call ContextGraph-MCP as a client
- a custom external MCP client can call ContextGraph-MCP without using Decizense agent wiring

## MVP demo

The first demo uses the existing travel scenario as an external scenario pack.

Demo flow:

1. Start ContextGraph-MCP with `scenario/travel`.
2. Connect as `flight_ops` using its configured identity.
3. Call `initialize_agent`.
4. Call `query_metrics` for flight delay metrics.
5. Attempt a forbidden booking/payment query and show it is blocked.
6. Write a finding.
7. Propose and record a decision outcome.
8. Search precedent or read the stored decision trace.
9. Show Decizense or a custom MCP client can use the same server.

## Migration path

### Phase 1: Repository boundary

Create a separate ContextGraph-MCP repository and move the current harness-related code into it.

Included:

- `harness`
- `policy`
- scenario config loading and validation
- catalog interface and OpenMetadata adapter
- semantic compiler/executor
- governance and OPA integration
- decision/memory persistence

Excluded:

- Decizense frontend
- Decizense backend product UX
- agent runtime implementation
- app-specific onboarding

### Phase 2: Decizense client integration

Update Decizense to call ContextGraph-MCP as an external MCP server from the separate repository.

Decizense should not import harness internals directly.

### Phase 3: Public hardening

Prepare ContextGraph-MCP for external users.

Add:

- installation docs
- scenario pack docs
- adapter docs
- example external MCP client
- Docker image
- versioned config schema
- compatibility notes

## Non-goals for MVP

- Building a new agent runtime
- Wiring user-created agents
- Building a catalog UI
- Building a policy studio
- Supporting every catalog provider
- Supporting every database provider
- Redesigning Decizense frontend/backend
- Creating finance/manufacturing scenarios

## MVP decisions

These decisions keep the first extraction small and tied to working code:

- ContextGraph-MCP starts as a separate repository. Temporary staging inside the Decizense repo is allowed only as an implementation tactic, not as the product boundary.
- The first standalone database target is Postgres because the current harness persistence and travel scenario already use it. DuckDB and warehouse adapters come later.
- OpenMetadata bot provisioning stays as helper tooling, not core runtime behavior.
- Admin tools are private/operational by default. Public v1 tools are the governed MCP tools needed by clients and agents.

## Success criteria

The design is successful when:

- ContextGraph-MCP can run without Decizense UI/backend
- ContextGraph-MCP lives in a separate repository/product boundary
- Decizense can call ContextGraph-MCP as a client
- custom MCP clients can call ContextGraph-MCP as clients
- scenario packs stay external and config-driven
- governance remains fail-closed
- decision traces are stored and queryable
- current travel scenario behavior remains intact after extraction

# Agent Harness Architecture

## What is the harness?

Agent = Model + Harness. The harness is everything around the model — context, control, execution, memory, and verification. dazense IS the harness. Models and orchestration plug in externally via MCP.

## The 5 Responsibilities

Based on "The Anatomy of an Agent Harness" (vtrivedy.com), mapped to our implementation:

### 1. Context Injection — "Right information at the right time"

The context graph is the primary context source. Instead of dumping everything into the prompt, `get_context(question)` traverses the graph and returns only what's relevant: entities, rules, rationale, freshness, precedent.

**MCP tools:**

- `get_context` — assembled context window for a question (entities, rules, freshness, precedent)
- `get_entity_details` — specific node from the graph
- `get_lineage` — upstream dependency trace
- `search_glossary` — term and synonym lookup
- `search_precedent` — similar past decisions
- `get_rationale` — why a rule or policy exists

**Source:** context graph (compiled from YAML + catalog snapshot)

### 2. Control — "Boundaries on what the agent can do"

Every agent has an identity, a scope, and policy constraints. The harness validates identity and checks policy before any action.

**MCP tools:**

- `authenticate` — validate agent JWT, return identity and role
- `check_policy` — pre-execution policy check (PII, bundle, SQL validation)
- `get_agent_scope` — what bundles, tables, domains this agent can access

**Source:** agent registry (agents.yml) + policy engine + catalog RBAC

### 3. Action — "Execute in the real world"

Governed execution of queries and external actions. Every query goes through the policy engine. PII is filtered. SQL is validated. Bundle restrictions enforced.

**MCP tools:**

- `query_data` — governed SQL execution against scoped database
- `query_metrics` — semantic layer query (pre-defined measures and dimensions)
- `execute_action` — external actions (notifications, rebooking) with approval gates

**Source:** database connections + semantic engine + external system connectors

### 4. Persist — "Durable state across sessions"

The shared workspace where agents coordinate. Each agent writes intermediate findings. The orchestrator reads all findings to combine into a decision. Decisions become precedent for future sessions.

**MCP tools:**

- `write_finding` — agent stores intermediate result for current session
- `read_findings` — agent reads what other agents found in this session
- `record_outcome` — final decision recorded with full reasoning chain and evidence links
- `save_memory` — cross-session agent memory
- `recall_memory` — retrieve past context

**Source:** decision store (PostgreSQL) + context graph (persistent)

Memory boundary in this layer:

- Agent runtime working memory (current turn state, temporary scratchpad, planning context) belongs to the agent framework/runtime.
- Harness memory is institutional memory: durable, governed, cross-session (`agent_memory` + structured `memory_entries`).
- The orchestrator should persist only outcomes/findings that are useful as precedent or reusable lessons.

### 5. Observe & Verify — "Monitor, validate, self-correct"

Post-execution checks. Did the agent use the correct measure? Is the data fresh enough? Is the result consistent with business rules? This closes the feedback loop.

**MCP tools:**

- `verify_result` — post-execution check against business rules and intents
- `check_freshness` — is the data within SLA?
- `check_consistency` — does the result align with known rules?
- `get_confidence` — confidence score based on freshness, coverage, rule compliance

**Source:** context graph (rules, intents, freshness expectations)

## Runtime Flow

```
Agent receives question
    │
    ▼
1. CONTEXT INJECTION
    get_context("Will passenger miss connection?")
    → Returns: flights, connection rules, freshness status, precedent
    │
    ▼
2. CONTROL
    authenticate(agent_jwt)
    → Returns: agent=ops-agent, scope=flights-ops bundle
    check_policy(agent=ops-agent, tables=[flights, tickets], action=query)
    → Returns: allowed
    │
    ▼
3. ACTION
    query_data("SELECT ... FROM flights JOIN tickets ...")
    → Governed execution: PII filtered, bundle enforced, SQL validated
    → Returns: query result
    │
    ▼
4. OBSERVE & VERIFY
    verify_result(question, result, applicable_rules)
    → Checks: correct connection time rule used? data fresh?
    → Returns: { verified: true, confidence: HIGH }
    │
    ▼
5. PERSIST
    write_finding(session_id, agent=ops-agent, finding="Connection safe, 2h45m buffer")
    → Stored in shared workspace for other agents
    record_outcome(session_id, question, decision_summary, confidence, ...)
    → Stored as precedent for future
```

## Shared Workspace Pattern

The decision store is the agent collaboration surface — structured, governed, queryable.

```
Session: "Will passenger miss connection?"

  ops-agent wrote:
    flight F1001 delayed 45 min
    new arrival: 10:15, connection buffer: 2h 45min
    confidence: HIGH (data 2min old)

  booking-agent wrote:
    booking B2001 intact, 2 tickets valid
    no rebooking needed

  customer-agent wrote:
    customer C101, Gold tier
    eligible: lounge access + proactive notification
    (PII stripped from output)

  orchestrator reads all → combines into final answer
```

Governance on the workspace:

- Agents can only write findings for their own identity
- Agents can only read findings from agents in the same session
- PII is stripped from inter-agent findings
- All writes are append-only (tamper-evident)

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     DAZENSE HARNESS (MCP Server)                 │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  CONTEXT GRAPH (compiled from YAML + catalog snapshot)     │  │
│  │  Governance │ Structural │ Semantic │ Temporal │ Decision   │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ AGENT        │  │ POLICY       │  │ SHARED WORKSPACE     │  │
│  │ REGISTRY     │  │ ENGINE       │  │ (Decision Store)     │  │
│  │              │  │              │  │                       │  │
│  │ agents.yml   │  │ Pre-exec     │  │ Findings per agent   │  │
│  │ JWT auth     │  │ Post-verify  │  │ Decision traces      │  │
│  │ Bundle scope │  │ PII filter   │  │ Precedent search     │  │
│  │              │  │ Inter-agent  │  │ Agent memory          │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  CONNECTORS                                                │  │
│  │  PostgreSQL │ Catalog (OMD/Atlan) │ External APIs │ MCP    │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ MCP Protocol
          ┌────────────────┼────────────────┐
          │                │                │
     ┌────▼────┐      ┌───▼────┐      ┌───▼────┐
     │ Agent 1 │      │Agent 2 │      │Agent N │
     │ (model) │      │(model) │      │(model) │
     └─────────┘      └────────┘      └────────┘
          │                │                │
     ┌────▼────────────────▼────────────────▼────┐
     │  ORCHESTRATOR (Vercel AI SDK / LangChain / Any MCP client) │
     └───────────────────────────────────────────┘
```

## Configuration (scenario-driven)

Everything domain-specific lives in `scenario/<name>/`:

```
scenario/travel/
  scenario.yml        → name, description, domain
  agents.yml          → agent definitions, roles, bundles, identities
  datasets/           → bundle definitions (trust boundaries per agent)
  semantics/          → measures, dimensions, business rules with rationale
  policies/           → PII, execution limits, inter-agent rules
  ontology/           → concepts, intents
  catalog/            → snapshot from catalog platform
  databases/          → connection config + init scripts
```

To switch domain: point to a different scenario folder. The harness code doesn't change.

## Technology Choices

| Component       | Technology           | Why                                              |
| --------------- | -------------------- | ------------------------------------------------ |
| MCP server      | TypeScript (Fastify) | Same stack as dazense backend, MCP SDK available |
| Context graph   | TypeScript + Python  | Reuse existing graph compiler from dazense       |
| Policy engine   | TypeScript           | Reuse existing policy engine from dazense        |
| Decision store  | PostgreSQL           | Same instance as scenario data, ACID, queryable  |
| Semantic engine | Python (Ibis)        | Cross-database query compilation                 |
| Agent auth      | JWT                  | Same pattern as catalog bot tokens               |

## Build Order

1. Scenario config files (agents.yml, bundles, rules, ontology, intents)
2. MCP server skeleton with tool registration
3. Wire context graph + policy engine into MCP tools
4. Add decision store schema + persist/workspace tools
5. Add observe & verify tools
6. Test with single agent against travel scenario
7. Add multi-agent orchestration
8. Test full disruption scenario (connecting flights)

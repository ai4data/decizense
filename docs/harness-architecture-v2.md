# Agent Harness Architecture (v2)

## Overview

The harness is an MCP server that sits between AI agents and enterprise data/systems. It provides governed context, enforces policies, manages decisions, and controls actions — across 5 canonical layers.

## Invariants

- Meaning before action
- Policy before execution
- Traceability by default
- Replayability required
- Human-gated autonomy progression

## Architecture Diagram

```mermaid
graph TB
    subgraph "CATALOG PLATFORM — OpenMetadata + Jena Fuseki"
        OMD_RDF[("RDF Knowledge Graph<br/>SPARQL endpoint")]
        OMD_GLOSS["Glossary<br/>typed relationships<br/>business ontology"]
        OMD_LIN["Lineage<br/>PROV-O triples<br/>pipeline dependencies"]
        OMD_GOV["Classifications<br/>PII tags, ownership<br/>domains, tiers"]
        OMD_MCP["MCP Server<br/>12 tools: search, lineage<br/>details, semantic search"]
        OMD_RDF --- OMD_GLOSS
        OMD_RDF --- OMD_LIN
        OMD_RDF --- OMD_GOV
        OMD_RDF --- OMD_MCP
    end

    subgraph "AGENT HARNESS — MCP Server"

        subgraph "Layer 1+2: Context Graph — from Catalog"
            CG[("Shared Memory Substrate")]
            CG_SEM["Semantic Layer<br/>ontology, glossary, intents<br/>concept hierarchies IS_A"]
            CG_GOV["Governance Layer<br/>PII blocking, bundle scope<br/>business rules + rationale"]
            CG_RULES["Scenario Rules<br/>business rules + rationale<br/>freshness SLAs, intents<br/>(from scenario YAML)"]
            OMD_GLOSS -->|"glossary, ontology<br/>typed relationships"| CG_SEM
            OMD_GOV -->|"PII tags, ownership<br/>domains, tiers"| CG_GOV
            OMD_LIN -->|"lineage<br/>PROV-O"| CG
            CG_RULES -->|"rules + rationale"| CG_GOV
            CG --- CG_SEM
            CG --- CG_GOV
        end

        subgraph "Layer 3: Operational/Event"
            EVT["Event Ingestion<br/>append-only event log<br/>source of truth"]
            PROJ["Projections<br/>case timelines<br/>process signals"]
            PM["Process Intelligence<br/>bottleneck detection<br/>variant analysis"]
            EVT --> PROJ --> PM
        end

        subgraph "Layer 4: Decision/Provenance"
            DP["Decision Proposal<br/>agent recommends action"]
            DA["Decision Approval<br/>human or auto-approved<br/>by risk class"]
            DAC["Decision Action<br/>executed after approval"]
            DO["Decision Outcome<br/>result + evidence links"]
            DP --> DA --> DAC --> DO
            EVID["Evidence Links<br/>to events, process signals<br/>policy checks, rules"]
            DO --- EVID
        end

        subgraph "Layer 5: Action/Permission"
            RISK["Risk Classification<br/>low: auto-approve<br/>medium: human review<br/>high: human required"]
            PERM["Permission Model<br/>who can propose<br/>who can approve<br/>who can execute"]
            SEP["Separation of Rights<br/>recommendation is not execution<br/>agents recommend<br/>humans decide high risk"]
            RISK --- PERM --- SEP
        end

        subgraph "Core Components"
            ORCH["Orchestrator<br/>decomposes tasks<br/>routes to agents<br/>combines findings<br/>scores confidence"]
            TOOL["Tool Registry<br/>query_data governed SQL<br/>query_metrics semantic<br/>execute_action approval gate<br/>get_context SPARQL"]
            GOV_INT["Internal Governance<br/>10-point policy check<br/>SQL validation<br/>PII blocking<br/>bundle enforcement"]
        end

        subgraph "Domain Agents"
            OPS["Flight Ops Agent<br/>bundle: flights-ops"]
            BKG["Booking Agent<br/>bundle: bookings"]
            CUST["Customer Agent<br/>bundle: customer-service"]
        end
    end

    subgraph "Database — PostgreSQL"
        DB_FLIGHTS[(flights, airports<br/>airlines, delays)]
        DB_BOOK[(bookings, tickets<br/>payments, checkins)]
        DB_CUST[(customers)]
        DB_EVT[(events<br/>383K process<br/>mining records)]
        DB_DEC[(decisions<br/>findings, memory)]
    end

    subgraph "External Systems"
        EXT_WEATHER["Weather API"]
        EXT_NOTIF["Notification Service"]
    end

    OMD_MCP -->|"MCP + SPARQL<br/>runtime queries"| CG

    CG --> ORCH
    CG --> TOOL
    CG --> GOV_INT

    ORCH --> OPS
    ORCH --> BKG
    ORCH --> CUST

    OPS -->|"query_data"| TOOL
    BKG -->|"query_data"| TOOL
    CUST -->|"query_data"| TOOL
    TOOL -->|"governed"| GOV_INT

    GOV_INT --> DB_FLIGHTS
    GOV_INT --> DB_BOOK
    GOV_INT --> DB_CUST

    DB_EVT --> EVT
    PM -->|"signals"| DP
    ORCH -->|"propose"| DP
    DA -->|"check risk"| RISK
    DAC --> DB_DEC
    DO --> DB_DEC
    EVID -->|"evidence"| DB_EVT

    DAC -->|"notify"| EXT_NOTIF
    OPS -->|"weather"| EXT_WEATHER
```

## The 5 Canonical Layers

### Layer 1+2: Context Graph (from Catalog)

**Source**: OpenMetadata + Jena Fuseki RDF store

The catalog platform is the source of truth for meaning and governance metadata. The harness reads from it via:

- **MCP Server** (12 tools) — search, lineage, entity details, semantic search
- **SPARQL endpoint** — complex graph queries
- **REST API** — simple lookups

What the catalog provides:

| Capability      | OMD feature                                 | RDF standard                             |
| --------------- | ------------------------------------------- | ---------------------------------------- |
| Entity types    | Tables, columns, dashboards, pipelines      | `om:Table`, `om:Column` classes          |
| Lineage         | Pipeline dependencies, column-level lineage | `prov:wasDerivedFrom` (PROV-O)           |
| Glossary        | Business terms with typed relationships     | Custom RDF predicates with cardinality   |
| Classifications | PII, Sensitive, Tier tags                   | `om:classification` properties           |
| Ownership       | Teams, domains, certification               | `om:owner`, `om:domain`                  |
| Validation      | Schema constraints                          | SHACL shapes (`openmetadata-shapes.ttl`) |

The harness extends this with runtime context:

- Business rules with rationale (from scenario YAML, seeded into OMD)
- Freshness expectations and SLAs
- Intent mappings (business questions → measures)

### Layer 3: Operational/Event

**Source**: PostgreSQL events table

The event log is the append-only source of truth for what happened. Each booking is a process instance (`case_id = booking_id`).

```
Event Ingestion (append-only)
    → Projections (case timelines per booking)
    → Process Intelligence (bottlenecks, variants, signals)
```

Event types in travel scenario:

```
CustomerRegistered → FlightSearched → FlightSelected → BookingCreated
→ PaymentSucceeded/PaymentFailed → TicketIssued → CheckInCompleted
→ BoardingStarted → FlightDeparted → FlightArrived
→ FlightDelayed → FlightCancelled → RebookingInitiated → CompensationIssued
```

Process intelligence outputs become **signals** that feed decision proposals:

- "87% of delays at CDG on Fridays exceed 45 minutes"
- "Payments via wallet have 3x higher failure rate"
- "Average time from BookingCreated to CheckInCompleted: 12 days"

### Layer 4: Decision/Provenance

**Source**: PostgreSQL decisions table (harness-managed)

Every significant agent action follows a lifecycle:

```
DecisionProposal
    agent_id: "flight_ops"
    action: "connection safe, no rebooking needed"
    evidence: [event:FlightDelayed, signal:connection_buffer_2h45m, rule:checkin_window]
    confidence: HIGH
        ↓
DecisionApproval
    approved_by: "auto" (low risk) or "human:operator_jane" (high risk)
    timestamp: 2026-03-20T10:16:00Z
        ↓
DecisionAction
    action_type: "notify_customer"
    parameters: { customer_id: "C101", message: "connection safe" }
        ↓
DecisionOutcome
    result: "notification sent"
    evidence_links: [event:E1234, policy_check:bundle_ok, rule:checkin_window]
    → stored as searchable precedent
```

### Layer 5: Action/Permission

**Source**: Scenario configuration (agents.yml + policy.yml)

| Risk class | Examples                                               | Approval                 |
| ---------- | ------------------------------------------------------ | ------------------------ |
| Low        | Read data, generate report, send info notification     | Auto-approved            |
| Medium     | Flag for review, send warning notification             | Human review optional    |
| High       | Rebook passenger, issue compensation (< EUR 400)       | Human approval required  |
| Critical   | Cancel flight, override policy, compensation > EUR 400 | Senior approval required |

Permission model:

- **Propose**: which agents can recommend actions (all domain agents)
- **Approve**: who can approve by risk class (auto for low, human for high)
- **Execute**: who can trigger the actual action (harness, after approval)

Progressive autonomy:

- Start: human approves everything
- After 50 successful low-risk decisions: auto-approve low risk
- After 200 decisions with < 2% error: auto-approve medium risk
- High/critical: always human

## MCP Tools by Layer

| Layer        | Tools                                                                                          | Status                                    |
| ------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1+2 Context  | get_context, get_entity_details, get_lineage, search_glossary, search_precedent, get_rationale | Scaffold → wire to OMD                    |
| 2 Governance | initialize_agent, get_business_rules + internal pipeline                                       | **Real logic**                            |
| 3 Event      | ingest_event, get_case_timeline, get_process_signals                                           | Not built                                 |
| 4 Decision   | write_finding, read_findings, log_decision, save_memory, recall_memory                         | Scaffold → wire to PostgreSQL             |
| 5 Action     | query_data, query_metrics, execute_action                                                      | **Real logic** (query), scaffold (action) |
| Admin        | find_governance_gaps, simulate_removal, graph_stats, audit_decisions                           | Scaffold                                  |
| Verify       | verify_result, check_freshness, check_consistency, get_confidence                              | Scaffold                                  |

## Proving Workflow: Missed Connection Rebooking

Forces all 5 layers to interact:

1. **Event** (layer 3): `FlightDelayed` event for F1001 (45 min delay)
2. **Context** (layer 1+2): Harness queries OMD — flight schedule, booking, customer loyalty tier
3. **Process signal** (layer 3): "Connection buffer: 2h45m, minimum: 60min, 94% similar cases resolved without rebooking"
4. **Governance** (layer 2): Rules — checkin_window (45 min), rebooking_priority (connections first), EU-261 compensation threshold (3h)
5. **Decision proposal** (layer 4): Ops agent proposes "connection safe, no rebooking needed" with evidence
6. **Risk classification** (layer 5): Low risk (informational, no financial action)
7. **Auto-approved** (layer 5): Low risk → logged with evidence chain
8. **Action** (layer 5): Notify customer + lounge voucher (Gold tier exception)
9. **Outcome** (layer 4): Decision stored as precedent, evidence links to event, rules, and process signals

## Technology Stack

| Component          | Technology               | Purpose                                    |
| ------------------ | ------------------------ | ------------------------------------------ |
| Harness MCP server | TypeScript (MCP SDK)     | Core runtime                               |
| Catalog platform   | OpenMetadata 1.12        | Knowledge graph, glossary, lineage         |
| RDF store          | Apache Jena Fuseki       | SPARQL queries, semantic reasoning         |
| Database           | PostgreSQL 16            | Scenario data + events + decisions         |
| UI                 | React (dazense frontend) | Chat interface                             |
| Backend            | Fastify + tRPC           | UI shell, MCP bridge                       |
| Agent framework    | Any (via MCP)            | Pluggable — Claude, GPT, LangChain, CrewAI |

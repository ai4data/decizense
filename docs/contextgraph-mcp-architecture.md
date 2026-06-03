# ContextGraph-MCP Architecture

```mermaid
flowchart LR
  subgraph Clients["External Clients"]
    A1["LangGraph Agent"]
    A2["Temporal / Restate Agent"]
    A3["DBOS-on-agent-side"]
    A4["Decizense Backend"]
    A5["Third-party MCP Client"]
  end

  subgraph MCP["ContextGraph-MCP Server"]
    AUTH["Auth + Session Context<br/>mcp-session-id in-memory map"]

    TOOLS["MCP Tool Surface<br/>query_data, query_metrics<br/>write_finding, propose_decision<br/>approve_decision, record_outcome<br/>save_memory, recall_memory<br/>replay_decision admin"]

    SCENARIO["Scenario Loader<br/>agents, bundles, rules<br/>tools, metrics, contracts"]

    GOV["Governance Engine<br/>OPA enforcement<br/>policy decision checks<br/>durable decision logging<br/>admin replay"]

    SEM["Semantic Layer<br/>metric compiler<br/>safe SQL generation<br/>contract-aware queries"]

    MEM["Decision & Memory Layer<br/>plain Postgres writes<br/>case_id + request_id<br/>idempotent retries"]

    CAT["Catalog Adapter Interface<br/>OpenMetadata / DataHub / etc.<br/>schemas, owners, tags, lineage"]
  end

  subgraph External["External Systems"]
    PG["Postgres<br/>cases, proposals, approvals<br/>outcomes, findings<br/>memory_entries, audit_log"]

    OPALOG["OPA Decision Log Sink<br/>opa_decisions table<br/>case_id / request_id correlation"]

    OPA["OPA Sidecar<br/>current policy bundle"]

    CATALOG["Metadata Catalog<br/>OMD / DataHub / other"]

    DATA["Data Sources<br/>databases / warehouses"]
  end

  A1 -->|MCP calls with case_id + request_id| AUTH
  A2 -->|MCP calls with case_id + request_id| AUTH
  A3 -->|MCP calls with case_id + request_id| AUTH
  A4 -->|MCP calls with case_id + request_id| AUTH
  A5 -->|MCP calls with case_id + request_id| AUTH

  AUTH --> TOOLS
  TOOLS --> SCENARIO
  TOOLS --> GOV
  TOOLS --> SEM
  TOOLS --> MEM
  TOOLS --> CAT

  GOV -->|evaluate policy| OPA
  GOV -->|best-effort log| OPALOG
  GOV -->|replay_decision| OPALOG
  GOV -->|re-evaluate stored input| OPA

  MEM -->|ACID writes + ON CONFLICT dedupe| PG
  SEM -->|governed SQL| DATA
  CAT -->|metadata sync/read| CATALOG

  SCENARIO --> GOV
  SCENARIO --> SEM
  CAT --> GOV
  CAT --> SEM
```

ContextGraph-MCP has no embedded DBOS or workflow engine. Workflow durability lives in the client agent runtime; the MCP server stays stateless for workflow orchestration and uses Postgres for durable business, audit, memory, and OPA decision records.

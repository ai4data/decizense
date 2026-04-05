# Agent Authentication & Identity — Sequence Diagrams

Grounded in [draft-klrc-aiagent-auth-00](https://datatracker.ietf.org/doc/html/draft-klrc-aiagent-auth-00) (IETF AI Agent Auth, March 2026).

---

## 1. Credential Provisioning (one-time setup)

How agents get their identity and credentials before any runtime interaction.

```mermaid
sequenceDiagram
    participant Admin as Platform Admin
    participant Script as provision-bots.ts
    participant YAML as agents.yml
    participant OMD as OpenMetadata
    participant Env as .env.tokens

    Admin->>Script: npx tsx provision-bots.ts ../scenario/travel
    Script->>YAML: Read agents config
    YAML-->>Script: 4 agents with identity.catalog_bot names

    loop For each agent (ops-agent, booking-agent, customer-agent, orchestrator-agent)
        Script->>OMD: POST /api/v1/users (isBot: true, name: "ops-agent")
        OMD-->>Script: userId
        Script->>OMD: POST /api/v1/bots (botUser: userId)
        OMD-->>Script: Bot created with JWT token
        Script->>OMD: GET /api/v1/bots/name/ops-agent
        OMD-->>Script: { JWTToken: "eyJhbG..." }
    end

    Script->>Env: Write OPS_TOKEN=eyJhbG...<br/>BOOKING_TOKEN=eyJhbG...<br/>CUSTOMER_TOKEN=eyJhbG...<br/>ORCHESTRATOR_TOKEN=eyJhbG...

    Note over Env: Tokens are stored in .env file<br/>Never committed to git<br/>Each token's sub claim = catalog_bot name
```

---

## 2. Agent Startup & Authentication (every connection)

How identity flows from env var through the connection to the harness — the token never reaches the LLM.

```mermaid
sequenceDiagram
    participant Env as Environment
    participant Agent as Agent Process<br/>(flight-ops.ts)
    participant Client as HarnessClient
    participant Harness as Harness Process<br/>(server.ts)
    participant Auth as AuthContext<br/>(auth/context.ts)
    participant Verify as JWT Verifier<br/>(auth/verify.ts)
    participant Config as agents.yml

    Note over Env: OPS_TOKEN=eyJhbG...<br/>AUTH_MODE=jwt

    Agent->>Env: Read OPS_TOKEN
    Agent->>Client: new HarnessClient("flight_ops", token)
    Client->>Harness: Spawn child process via stdio<br/>env: { AGENT_TOKEN=eyJhbG..., AGENT_ID=flight_ops }

    Note over Client,Harness: Token travels via env var<br/>NOT as a tool argument<br/>LLM never sees it

    activate Harness
    Harness->>Harness: Load scenario.yml → auth.mode = "jwt"
    Harness->>Auth: resolveAuthContext(loader)
    Auth->>Env: Read AGENT_TOKEN from process.env
    Auth->>Verify: verifyAgentToken(token, audience="dazense-harness")

    alt Shared Secret (dev)
        Verify->>Verify: jwt.verify(token, secret, { algorithms: ["HS256"] })
    else JWKS (production)
        Verify->>Verify: Fetch issuer's JWKS keys
        Verify->>Verify: jwt.verify(token, publicKey, { algorithms: ["RS256"] })
    else Introspection (opaque tokens)
        Verify->>Verify: POST /introspect → { active: true, sub: "ops-agent" }
    end

    Verify-->>Auth: { valid: true, sub: "ops-agent", iss: "...", exp: ... }
    Auth->>Config: Find agent where identity.catalog_bot == "ops-agent"
    Config-->>Auth: agent_id = "flight_ops"

    Auth->>Auth: Create immutable AuthContext:<br/>agentId: "flight_ops"<br/>agentUri: "agent://dazense.local/flight_ops"<br/>authMethod: "jwt"<br/>tokenHash: "a3f8c1..." (SHA-256, first 16 chars)

    Auth-->>Harness: AuthContext ready
    Harness->>Harness: Log: [harness] Auth: jwt | agent=flight_ops | uri=agent://dazense.local/flight_ops
    deactivate Harness

    Note over Auth: AuthContext is IMMUTABLE<br/>for the lifetime of this connection.<br/>All tool calls read from it.
```

---

## 3. Tool Call — Identity Enforcement (every query)

How `agent_id` is resolved from AuthContext, not from model output. The LLM cannot spoof identity.

```mermaid
sequenceDiagram
    participant LLM as LLM (Claude/GPT)
    participant Agent as Agent Process
    participant Harness as Harness (MCP)
    participant Auth as AuthContext
    participant Gov as Governance Pipeline
    participant DB as PostgreSQL

    Agent->>LLM: System prompt + user question
    LLM-->>Agent: Tool call: query_data({ sql: "SELECT ... LIMIT 10" })

    Note over LLM,Agent: Notice: NO agent_id in the tool call.<br/>The LLM only provides sql + reason.<br/>It cannot choose which agent it is.

    Agent->>Harness: MCP tool call: query_data({ sql: "..." })

    Harness->>Auth: getAuthContext()
    Auth-->>Harness: { agentId: "flight_ops", agentUri: "agent://...", authMethod: "jwt" }

    Harness->>Gov: evaluateGovernance({ agent_id: "flight_ops", sql: "..." })

    Note over Gov: Identity comes from AuthContext<br/>(verified JWT), not from the tool call

    Gov->>Gov: 1. Authenticate: agent exists in config ✓
    Gov->>Gov: 2. Can query: role=domain, can_query=true ✓
    Gov->>Gov: 3. Read-only: no INSERT/UPDATE/DELETE ✓
    Gov->>Gov: 4. Single statement: 1 statement ✓
    Gov->>Gov: 5. Bundle scope: tables in flights-ops bundle ✓
    Gov->>Gov: 6. PII check: no PII columns in query ✓
    Gov->>Gov: 7. LIMIT check: LIMIT 10 ≤ 500 ✓

    Gov-->>Harness: { allowed: true, contract_id: "contract-..." }

    Harness->>DB: Execute SQL
    DB-->>Harness: Result rows

    Harness->>Harness: filterPiiFromResults (defense in depth)
    Harness-->>Agent: { status: "success", rows: [...], contract_id: "..." }
    Agent->>LLM: Query result as context
```

---

## 4. Identity Spoofing Prevention — Before vs After

```mermaid
sequenceDiagram
    participant LLM as Malicious LLM Output
    participant Harness as Harness

    Note over LLM,Harness: ❌ BEFORE (vulnerable)

    LLM->>Harness: query_data({ agent_id: "orchestrator", sql: "SELECT * FROM bookings" })
    Note over Harness: Trusts agent_id from model input<br/>orchestrator has broader access<br/>PRIVILEGE ESCALATION

    Note over LLM,Harness: ✅ AFTER (secure)

    LLM->>Harness: query_data({ sql: "SELECT * FROM bookings" })
    Harness->>Harness: getAuthContext() → agentId: "flight_ops"
    Harness->>Harness: evaluateGovernance({ agent_id: "flight_ops", ... })
    Harness-->>LLM: BLOCKED: "bookings" not in flight_ops bundle

    Note over Harness: agent_id cannot be spoofed<br/>Identity is bound to the connection<br/>not to model output
```

---

## 5. initialize_agent — Validation Flow

```mermaid
sequenceDiagram
    participant Agent as Agent Process
    participant Harness as Harness
    participant Auth as AuthContext
    participant Config as agents.yml

    Agent->>Harness: initialize_agent({ agent_id: "flight_ops", session_id: "sess-123" })

    Harness->>Auth: getAuthContext()
    Auth-->>Harness: { agentId: "flight_ops", authMethod: "jwt" }

    alt agent_id matches AuthContext
        Harness->>Auth: setSessionId("sess-123")
        Harness->>Config: Load agent config, bundle, rules
        Harness-->>Agent: {<br/>  identity: { agent_id, auth_method: "jwt", agent_uri: "agent://..." },<br/>  scope: { tables, blocked_columns, measures },<br/>  rules: [...],<br/>  constraints: { max_rows, cost_limit }<br/>}
    else agent_id does NOT match AuthContext
        Harness-->>Agent: { error: "agent_id 'X' does not match authenticated identity 'flight_ops'" }
        Note over Agent: Connection rejected.<br/>Cannot impersonate another agent.
    end
```

---

## 6. Full AIMS Stack — How It Maps to the Codebase

```mermaid
graph TB
    subgraph "AIMS Stack (draft-klrc-aiagent-auth-00)"
        M[Monitoring & Observability<br/><i>audit_decisions, decision_outcomes table</i>]
        AZ[Authorization<br/><i>governance/index.ts — bundle, PII, SQL checks</i>]
        AN[Authentication<br/><i>auth/context.ts + auth/verify.ts</i>]
        P[Provisioning<br/><i>scripts/provision-bots.ts</i>]
        AT[Registration<br/><i>agents.yml — agent exists in config</i>]
        C[Credentials<br/><i>JWT tokens from OMD bots</i>]
        I[Identifier<br/><i>agent://dazense.local/flight_ops</i>]
    end

    subgraph "Cross-cutting"
        PO[Policy<br/><i>policy.yml, scenario.yml</i>]
    end

    I --> C --> AT --> P --> AN --> AZ --> M
    PO -.-> AN
    PO -.-> AZ
    PO -.-> M

    style AN fill:#2d6,stroke:#333,color:#fff
    style C fill:#2d6,stroke:#333,color:#fff
    style P fill:#2d6,stroke:#333,color:#fff
    style I fill:#2d6,stroke:#333,color:#fff
```

<span style="color:green">Green = implemented in this PR</span>

---

## 7. Config-Only vs JWT Mode

```mermaid
flowchart TD
    Start[Harness Startup] --> ReadEnv{AUTH_MODE?}

    ReadEnv -->|config-only / not set| ConfigPath[Read AGENT_ID from env]
    ReadEnv -->|jwt| JwtPath[Read AGENT_TOKEN from env]

    ConfigPath --> HasId{AGENT_ID set?}
    HasId -->|yes| ValidateConfig[Check agent exists in agents.yml]
    HasId -->|no| Deferred[Empty AuthContext<br/>Set by first initialize_agent call]

    ValidateConfig --> CreateCtx1[AuthContext:<br/>authMethod=config-only<br/>tokenHash=null]

    JwtPath --> HasToken{AGENT_TOKEN set?}
    HasToken -->|no| Error[ERROR: startup fails]
    HasToken -->|yes| Verify[Verify JWT via configured strategy]

    Verify --> Valid{Token valid?}
    Valid -->|no| Error2[ERROR: verification failed]
    Valid -->|yes| MapSub[Map sub claim → agent_id<br/>via agents.yml identity.catalog_bot]

    MapSub --> Found{Agent found?}
    Found -->|no| Error3[ERROR: sub not mapped]
    Found -->|yes| CreateCtx2[AuthContext:<br/>authMethod=jwt<br/>tokenHash=sha256:a3f8...]

    CreateCtx1 --> Ready[All tools use getAuthContext]
    Deferred --> Ready
    CreateCtx2 --> Ready
```

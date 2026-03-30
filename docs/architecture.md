# dazense Architecture

## Current Architecture

### Overview

dazense is a monorepo with three runtime components and a CLI:

```
                    Browser
                      |
                      v
              +---------------+
              |   Frontend    |  React, TanStack, Shadcn
              |  :3000 (dev)  |  Vite dev server
              +-------+-------+
                      |
                      | tRPC + HTTP
                      v
              +---------------+
              |   Backend     |  Fastify, tRPC, Drizzle, Vercel AI SDK
              |    :5005      |  Bun runtime
              +-------+-------+
                      |
          +-----------+-----------+
          |                       |
          v                       v
  +---------------+       +---------------+
  |   FastAPI     |       |   LLM API     |  Anthropic, OpenAI,
  |    :8005      |       |  (external)   |  Mistral, Google,
  |  Python tools |       +---------------+  OpenRouter
  +-------+-------+
          |
          v
  +---------------+
  |   Database    |  DuckDB, PostgreSQL, BigQuery,
  |  (user data)  |  Snowflake, Databricks, MSSQL
  +---------------+
```

### Component Details

#### CLI (`cli/`)

Python package (`dazense-core`) published to PyPI. Entry point: `dazense_core/main.py`.

| Command         | What it does                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `dazense init`  | Scaffolds a project — prompts for databases, LLM provider, creates `dazense_config.yaml` and `RULES.md`                            |
| `dazense sync`  | Connects to databases, generates schema markdown files under `databases/`, syncs git repos, Notion pages, renders Jinja2 templates |
| `dazense chat`  | Launches the backend binary + FastAPI server, opens browser                                                                        |
| `dazense debug` | Tests database and LLM connectivity                                                                                                |
| `dazense test`  | Runs evaluation tests against YAML test cases                                                                                      |

**Key dependency:** Ibis Framework with adapters for DuckDB, PostgreSQL, BigQuery, Snowflake, Databricks, MSSQL.

**Sync output structure:**

```
project/
├── dazense_config.yaml
├── RULES.md
├── databases/
│   └── type={db_type}/
│       └── database={db_name}/
│           └── schema={schema}/
│               └── table={table}/
│                   ├── columns.md       # Column names, types, nullable
│                   ├── description.md   # Row count, metadata
│                   └── preview.md       # Sample rows
├── repos/                               # Cloned git repos
├── docs/                                # Synced Notion pages, other docs
├── agent/mcps/                          # MCP tool configs
├── templates/                           # User Jinja2 templates
└── tests/                               # Evaluation test cases
```

#### Backend (`apps/backend/`)

TypeScript, runs on Bun. Fastify HTTP server with tRPC for typed API.

**Layers:**

```
routes/          tRPC procedures + Fastify HTTP routes
  |
services/        Business logic (agent execution, Slack, email)
  |
queries/         Drizzle ORM database queries
  |
db/              Schema definitions (SQLite or PostgreSQL)
```

**Key files:**

| File                               | Purpose                                                    |
| ---------------------------------- | ---------------------------------------------------------- |
| `src/index.ts`                     | Entry point, starts server on :5005                        |
| `src/services/agent.service.ts`    | Core agent loop — builds messages, streams LLM responses   |
| `src/components/system-prompt.tsx` | Builds the system prompt with project context              |
| `src/agents/tools/index.ts`        | Registers all agent tools                                  |
| `src/agents/tools/execute-sql.ts`  | SQL execution tool — calls FastAPI                         |
| `src/agents/providers.ts`          | LLM provider configuration                                 |
| `src/agents/user-rules.ts`         | Loads RULES.md and database connections into system prompt |
| `src/trpc/router.ts`               | Root tRPC router                                           |
| `src/auth.ts`                      | Better-Auth setup                                          |

**Agent execution flow:**

```
1. User sends message via tRPC (chat.routes.ts)
2. AgentManager loads project context (agent.service.ts)
3. System prompt built: fixed instructions + RULES.md + database connections (system-prompt.tsx)
4. Messages sent to LLM via Vercel AI SDK (agent.service.ts)
5. LLM calls tools (execute_sql, read, grep, list, search, display_chart, etc.)
6. Tool results returned to LLM
7. LLM generates final response
8. Response streamed to frontend
```

**Tool context:** Every tool receives only `{ projectFolder: string }`. All context comes from files in that folder or from the system prompt.

#### FastAPI Server (`apps/backend/fastapi/`)

Python, runs on uvicorn at :8005. Handles operations that need Python runtime.

**Endpoints:**

| Endpoint               | Purpose                                      |
| ---------------------- | -------------------------------------------- |
| `POST /execute_sql`    | Executes SQL against user databases via Ibis |
| `POST /execute_python` | Runs Python code in sandbox                  |

**SQL execution flow:**

```
1. Agent tool calls HTTP POST to localhost:8005/execute_sql
2. FastAPI loads dazense_config.yaml from project folder
3. Resolves which database to use (single DB or by database_id)
4. Connects via Ibis (DuckDB, Postgres, BigQuery, etc.)
5. Executes SQL, returns results as JSON
```

#### Frontend (`apps/frontend/`)

React 19, Vite, TanStack Router (file-based routing), TanStack Query, Shadcn UI.

**Key structure:**

```
src/
├── routes/              File-based routing (TanStack Router)
├── components/
│   ├── ui/              Shadcn components
│   ├── tool-calls/      Tool execution result rendering
│   └── (feature components)
├── hooks/               React hooks
├── contexts/            Theme, sidebar, analytics providers
├── services/            API client logic
├── queries/             React Query definitions
└── lib/                 Utilities
```

**Communication:** tRPC client with HTTP batch link to backend.

#### Database (internal)

Stores application state (not user data). Supports SQLite (default) or PostgreSQL.

**Key tables:** user, session, chat, chat_message, message_feedback, project, organization, saved_prompts.

**ORM:** Drizzle with separate schemas for SQLite and PostgreSQL.

---

## New Architecture (with Semantic Layer + Business Rules)

### Overview

Two new components are added to the existing architecture. Both live in the FastAPI Python server, since they depend on Ibis (already there) and Python (already there).

```
                    Browser
                      |
                      v
              +---------------+
              |   Frontend    |
              |  :3000 (dev)  |
              +-------+-------+
                      |
                      v
              +---------------+
              |   Backend     |
              |    :5005      |
              +-------+-------+
                      |
          +-----------+-----------+------------------+
          |                       |                  |
          v                       v                  v
  +---------------+       +---------------+  +---------------+
  |   FastAPI     |       |   LLM API     |  |   App DB      |
  |    :8005      |       |  (external)   |  | SQLite / PG   |
  |               |       +---------------+  +---------------+
  | /execute_sql  |
  | /execute_py   |
  | /query_metrics|  <-- NEW
  | /business_ctx |  <-- NEW
  +-------+-------+
          |
    +-----+-----+
    |     |     |
    v     v     v
  +---+ +---+ +---+
  |Ibis| |Sem| |Biz|
  |    | |Lyr| |Rul|
  +---+ +---+ +---+
    |     |
    v     v
  +---------------+
  |   Database    |
  |  (user data)  |
  +---------------+
```

### What changes

#### 1. New module: Semantic Layer (`cli/dazense_core/semantic/`)

A YAML-to-Ibis translator. Pure Python, no external dependencies beyond Ibis.

**Files:**

```
cli/dazense_core/semantic/
├── __init__.py
├── model.py          # Parse semantic_model.yml into Python objects
├── compiler.py       # Translate metric queries into Ibis expressions
└── validator.py      # Validate model against actual database schema
```

**Responsibilities:**

- Parse `semantic_model.yml` from project folder
- Validate measure/dimension references against database schema
- Resolve joins between models
- Compile `query(measures, dimensions, filters)` into Ibis expression
- Let Ibis handle SQL dialect compilation

**Data flow:**

```
semantic_model.yml
        |
        v
  +-----------+
  | model.py  |  Parse YAML into SemanticModel objects
  +-----------+
        |
        v
  +-------------+
  | compiler.py |  Resolve joins, build Ibis aggregation
  +-------------+
        |
        v
  +-------------+
  |    Ibis     |  Compile to target SQL dialect
  +-------------+
        |
        v
  +-------------+
  |  Database   |  Execute query, return results
  +-------------+
```

**SemanticModel structure:**

```python
@dataclass
class Measure:
    name: str
    expression: str        # e.g., "_.amount.sum()"

@dataclass
class Dimension:
    name: str
    expression: str        # e.g., "_.status"

@dataclass
class Join:
    model: str             # target model name
    type: str              # "one" or "many"
    on: str                # e.g., "_.customer_id"

@dataclass
class Model:
    name: str
    table: str
    primary_key: str | None
    time_dimension: str | None
    measures: dict[str, Measure]
    dimensions: dict[str, Dimension]
    joins: dict[str, Join]

@dataclass
class SemanticModel:
    models: dict[str, Model]
```

#### 2. New module: Business Rules (`cli/dazense_core/rules/`)

A YAML-based business rules engine. Pure Python, no rdflib.

**Files:**

```
cli/dazense_core/rules/
├── __init__.py
├── loader.py         # Parse business_rules.yml
└── engine.py         # Match rules to concepts, return relevant context
```

**Responsibilities:**

- Parse `business_rules.yml` from project folder
- Match rules to data concepts (by metric name, dimension, keyword)
- Return relevant caveats, guidance, and classifications
- Inject critical rules into system prompt

#### 3. New FastAPI endpoints

Added to `apps/backend/fastapi/main.py`:

**`POST /query_metrics`**

```
Request:
{
  "dazense_project_folder": "/path/to/project",
  "measures": ["order_count", "total_amount"],
  "dimensions": ["status"],
  "filters": { "status": "completed" },
  "order_by": [["total_amount", "desc"]],
  "limit": 10
}

Response:
{
  "data": [
    { "status": "completed", "order_count": 450, "total_amount": 89234.50 },
    ...
  ],
  "columns": ["status", "order_count", "total_amount"],
  "row_count": 3,
  "sql": "SELECT status, COUNT(*), SUM(amount) FROM orders WHERE..."
}
```

**`POST /get_business_context`**

```
Request:
{
  "dazense_project_folder": "/path/to/project",
  "concepts": ["tips", "cash"],
  "context_type": "caveats"      # or "classifications" or "all"
}

Response:
{
  "rules": [
    {
      "name": "cash_tips_not_recorded",
      "severity": "critical",
      "description": "Cash tips are NOT recorded in the data",
      "guidance": "Exclude cash payments from any tip analysis"
    }
  ]
}
```

#### 4. New agent tools

Added to `apps/backend/src/agents/tools/`:

**`query-metrics.ts`** — Calls `/query_metrics` on FastAPI. Same HTTP pattern as `execute-sql.ts`.

```typescript
// Input schema for the LLM
{
  measures: string[]      // e.g., ["order_count", "total_amount"]
  dimensions?: string[]   // e.g., ["status", "customer.name"]
  filters?: object        // e.g., { status: "completed" }
  order_by?: [string, "asc" | "desc"][]
  limit?: number
}
```

**`get-business-context.ts`** — Calls `/get_business_context` on FastAPI.

```typescript
// Input schema for the LLM
{
  concepts: string[]      // e.g., ["tips", "cash_payments"]
}
```

#### 5. System prompt changes

In `apps/backend/src/components/system-prompt.tsx`:

- If `semantic_model.yml` exists in the project folder, inject a section listing available metrics and dimensions
- Add instructions: "Use query_metrics for defined metrics. Use execute_sql for ad-hoc exploration."
- If `business_rules.yml` exists, inject critical rules (severity: critical) directly into the system prompt
- Add instructions: "Call get_business_context when interpreting results or answering 'why' questions."

#### 6. CLI changes

In `cli/dazense_core/commands/sync/`:

- During `dazense sync`, validate `semantic_model.yml` against actual database schema if both exist
- Report warnings for undefined tables, missing columns, invalid expressions

In `cli/dazense_core/commands/init/`:

- Optionally scaffold a starter `semantic_model.yml` based on discovered tables
- Auto-generate basic measures (count, sum of numeric columns) and dimensions (string/date columns)

### What does NOT change

- Frontend — no changes needed. Tool results already render generically.
- tRPC routes — no changes. Chat flow is the same.
- Auth, database, project management — untouched.
- Existing tools (execute_sql, read, grep, list, search, display_chart) — untouched.
- RULES.md — still works as before, complemented by structured business_rules.yml.

### Agent decision flow (semantic layer)

```
User question arrives
        |
        v
  System prompt includes:
  - Database connections (existing)
  - RULES.md (existing)
  - Available metrics/dimensions from semantic_model.yml (NEW)
  - Critical business rules from business_rules.yml (NEW)
        |
        v
  LLM decides which tool to use:
        |
        +-- Question maps to a defined metric?
        |     --> query_metrics tool
        |
        +-- Question needs ad-hoc exploration?
        |     --> execute_sql tool (existing behavior)
        |
        +-- Question asks "why" or needs interpretation?
        |     --> get_business_context tool
        |
        +-- Question needs file/doc lookup?
        |     --> read, grep, list, search tools (existing)
        |
        v
  Results returned to LLM
        |
        v
  LLM generates answer with:
  - Data from semantic layer or raw SQL
  - Business context and caveats from rules engine
  - Charts if applicable
```

### File inventory (semantic layer files only)

```
cli/dazense_core/semantic/__init__.py        # Module init
cli/dazense_core/semantic/model.py           # YAML parser (~100 lines)
cli/dazense_core/semantic/compiler.py        # Ibis query builder (~200 lines)
cli/dazense_core/semantic/validator.py       # Schema validation (~100 lines)
cli/dazense_core/rules/__init__.py           # Module init
cli/dazense_core/rules/loader.py             # YAML parser (~50 lines)
cli/dazense_core/rules/engine.py             # Rule matching (~100 lines)
apps/backend/src/agents/tools/query-metrics.ts    # Agent tool (~40 lines)
apps/backend/src/agents/tools/get-business-context.ts  # Agent tool (~40 lines)

Total: ~650 lines of new code
```

### Dependencies (semantic layer)

**None.** Everything uses existing dependencies:

- Ibis (already in cli/pyproject.toml)
- PyYAML (already in cli/pyproject.toml)
- FastAPI/uvicorn (already running)
- Vercel AI SDK (already in backend)

---

## V1 Architecture: Trusted Analytics Copilot (Enforcement Layer)

> **Status:** Implemented. All V1 components are live.

The enforcement layer adds **contract-first execution** on top of the semantic layer and business rules. Every query must pass through a policy engine before data is accessed.

### Overview

```
                    Browser
                      |
                      v
              +---------------+
              |   Frontend    |
              |  :3000 (dev)  |
              +-------+-------+
                      |
                      v
              +---------------+
              |   Backend     |
              |    :5005      |
              +-------+-------+
                      |
          +-----------+-----------+------------------+
          |           |           |                  |
          v           v           v                  v
  +---------------+  +---------+  +---------------+  +---------------+
  |   FastAPI     |  | Policy  |  |   LLM API     |  |   App DB      |
  |    :8005      |  | Engine  |  |  (external)   |  | SQLite / PG   |
  |               |  +---------+  +---------------+  +---------------+
  | /execute_sql  |  | SQL     |
  | /execute_py   |  | Valid.  |
  | /query_metrics|  +---------+
  | /business_ctx |  | Contract|
  +-------+-------+  | Writer  |
          |           +---------+
    +-----+-----+
    |     |     |
    v     v     v
  +---+ +---+ +---+
  |Ibis| |Sem| |Biz|
  |    | |Lyr| |Rul|
  +---+ +---+ +---+
    |     |
    v     v
  +---------------+
  |   Database    |
  |  (user data)  |
  +---------------+
```

### What V1 adds

#### 1. Policy Engine (`apps/backend/src/policy/policy-engine.ts`)

Pure function: `evaluatePolicy(contractDraft, policy, bundles) → PolicyDecision`

Checks (in order):

1. **Bundle tables check** — all tables must be in the selected bundle's `tables` list
2. **Join allowlist check** — all joins must match the bundle's approved join edges
3. **PII block check** — no selected columns in `policy.pii.columns[table]`
4. **Time filter check** — fact tables require a time window (configured per-table)
5. **Limit check** — row limit must be ≤ `policy.defaults.max_rows`
6. **Bundle requirement check** — if `execution.require_bundle=true` and no bundle → `needs_clarification`

Returns one of three states:

- `{ status: 'allow', checks }` — proceed with execution
- `{ status: 'block', reason, fixes, checks }` — reject with actionable feedback
- `{ status: 'needs_clarification', questions, checks }` — ask user for more info

No file I/O — pure logic, easy to unit test.

#### 2. SQL Validator (`apps/backend/src/policy/sql-validator.ts`)

Validates the actual SQL against the contract and policy at execution time. Uses regex-based parsing (fail-closed: parse failure = block).

Extracts from SQL:

- Referenced tables (with alias resolution)
- Multi-statement detection
- LIMIT presence and value
- JOIN edges (ON conditions with alias resolution)
- WHERE clause time column references

Validates:

- All tables in contract scope
- No PII columns referenced
- LIMIT present and ≤ policy maximum
- No multi-statement SQL
- JOIN edges match approved join allowlist (bidirectional matching)
- Time column referenced in WHERE clause for tables that require it

#### 3. Contract Writer (`apps/backend/src/contracts/contract-writer.ts`)

- `persistContract(contract, projectFolder)` — writes JSON to `{projectFolder}/contracts/runs/{timestamp}_{id}.json`
- `loadContract(contractId, projectFolder)` — reads back by glob `contracts/runs/*_{id}.json`
- Creates `contracts/runs/` directory if missing

Each contract records: actor, request, scope (tables, approved joins, time columns), meaning (metric refs, guidance rules), execution (tool + params), and policy checks.

#### 4. `build_contract` Agent Tool (`apps/backend/src/agents/tools/build-contract.ts`)

First-class agent tool the LLM calls explicitly before any data access:

```
build_contract({
  user_prompt: string,
  bundle_id?: string,
  tables: string[],
  joins?: JoinSpec[],
  metric_refs?: string[],
  time_window?: TimeWindow,
  tool: "execute_sql" | "query_metrics",
  params: object
}) → { status: 'allow', contract_id, contract }
   | { status: 'block', reason, fixes }
   | { status: 'needs_clarification', questions }
```

Tool output component (`build-contract.tsx`) shows status, contract_id, checks, and feedback.

#### 5. Gated Execution (`execute-sql.ts`, `query-metrics.ts`)

Both tools are modified to support two modes:

- **Legacy mode** (`require_contract: false`): tools work as before, no contract needed
- **Strict mode** (`require_contract: true`): tools require a valid `contract_id`

In strict mode:

- Missing `contract_id` → hard block: "Contract required. Call build_contract first."
- Invalid `contract_id` → hard block
- SQL parsed and validated against contract + policy before execution
- `query_metrics` validates all parameters (model, measures, dimensions, filters with column+operator+value, order_by with column+direction, limit) match the contract

#### 6. Loaders (`apps/backend/src/agents/user-rules.ts`)

Two new functions following the existing pattern:

- `getPolicies()` — reads `{projectFolder}/policies/policy.yml` → typed `PolicyConfig | null`
- `getDatasetBundles()` — reads all `{projectFolder}/datasets/*/dataset.yaml` → `DatasetBundle[]`

#### 7. Zod Schemas (`apps/shared/src/tools/build-contract.ts`)

Contract schemas (input, output, internal contract structure) defined with Zod. `execute-sql.ts` and `query-metrics.ts` schemas extended with optional `contract_id` field.

#### 8. System Prompt Updates (`system-prompt.tsx`)

New conditional section injected when policies and bundles exist:

- Trusted Execution Rules (always call `build_contract` first, work within bundles, PII blocked)
- Bundle summaries (available data products, tables, approved joins)
- Policy summary (enforcement mode, limits, PII rules)

#### 9. `dazense validate` CLI Command (`cli/dazense_core/commands/validate.py`)

Checks consistency across all governance files:

- Config loads correctly
- Bundle tables exist in configured databases
- PII columns in policy exist in bundle tables
- Join allowlist columns exist in referenced tables
- Semantic model references align with bundle tables

### V1 Runtime Flow

```
Current (legacy mode, require_contract: false):
  Agent → execute_sql / query_metrics → FastAPI → DB → results

New (strict mode, require_contract: true):
  User question
    → Agent reasons about the question
    → Agent calls build_contract(bundle, tables, joins, metrics, params)
    → Policy engine evaluates → allow / block / needs_clarification
      → if allow:  contract persisted, agent calls execute_sql/query_metrics with contract_id
                   → SQL validator checks SQL against contract + policy
                   → results returned with provenance (contract_id, sources, checks)
      → if block:  agent receives reason + suggested fixes, explains to user
      → if clarify: agent receives questions, asks user, then retries build_contract
```

### V1 File Inventory (new files)

```
apps/shared/src/tools/build-contract.ts              # Zod schemas for build_contract
apps/backend/src/policy/policy-engine.ts              # Policy evaluation (pure function)
apps/backend/src/policy/sql-validator.ts              # SQL parsing + contract validation
apps/backend/src/contracts/contract-writer.ts         # Persist/load contracts
apps/backend/src/agents/tools/build-contract.ts       # build_contract tool implementation
apps/backend/src/components/tool-outputs/build-contract.tsx  # Tool output component
apps/backend/tests/sql-validator.test.ts              # Unit tests (31 tests)
cli/dazense_core/commands/validate.py                 # dazense validate CLI command

Modified:
apps/backend/src/agents/user-rules.ts                 # getPolicies() + getDatasetBundles()
apps/shared/src/tools/execute-sql.ts                   # contract_id field
apps/shared/src/tools/query-metrics.ts                 # contract_id field
apps/backend/src/agents/tools/execute-sql.ts           # Contract gate + SQL validation
apps/backend/src/agents/tools/query-metrics.ts         # Contract gate + param validation
apps/backend/src/agents/tools/index.ts                 # Register build_contract
apps/backend/src/components/system-prompt.tsx           # Trusted Execution Rules section
apps/backend/src/components/tool-outputs/index.ts      # Export BuildContractOutput
```

### V1 Dependencies

- `node-sql-parser` (npm) — SQL parsing in the validator (new)
- All other dependencies already existed

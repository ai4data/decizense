# Testing Guide — Agent Harness

This guide walks through testing all components of the harness: infrastructure, governance, agents, multi-agent orchestration, memory, and the proving workflow.

For the full Plan v3 end-to-end validation runbook (including UI and umbrella verifier), see:

- [PLAN_V3_E2E_TESTING_TUTORIAL.md](./PLAN_V3_E2E_TESTING_TUTORIAL.md)

> **Windows / PowerShell users:** see [§ Windows runbook](#windows--powershell-runbook) before running anything. It covers toolchain setup, the `.env` quirks, and a one-command helper (`scripts\dev-all.ps1`) that starts the harness + backend + frontend together.

## Capability legend

Each test below carries a `**Tests:**` line naming the harness capabilities it exercises. The vocabulary:

| Label                              | What the harness is doing                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Identity & Auth**                | resolving the agent's identity (config-only / JWT / introspection), scope, and tools-available                                                                                                                                                                                                                                             |
| **Bundle scoping**                 | enforcing that a query only touches tables in the agent's `bundle`                                                                                                                                                                                                                                                                         |
| **PII policy**                     | rejecting queries that read `blocked_columns` (first_name, email, ...)                                                                                                                                                                                                                                                                     |
| **Business rules**                 | fetching `get_business_rules` and shaping behaviour by `severity`                                                                                                                                                                                                                                                                          |
| **OPA policy**                     | a per-call OPA decision (allow / deny / require_approval)                                                                                                                                                                                                                                                                                  |
| **Catalog (OMD)**                  | reading entity metadata, tags, owners, freshness from OpenMetadata                                                                                                                                                                                                                                                                         |
| **Glossary**                       | resolving business terms via `search_glossary` (synonyms, descriptions)                                                                                                                                                                                                                                                                    |
| **Lineage**                        | upstream / downstream graph via `get_lineage`                                                                                                                                                                                                                                                                                              |
| **Semantic model**                 | measures, dimensions, allowed_joins, time-filter requirements                                                                                                                                                                                                                                                                              |
| **Semantic execution**             | `query_metrics` — the harness compiles {measures, dimensions, filters, time_range, time_grain, order_by, limit} into parameterised SQL, runs governance, returns rows + the generated SQL + the resolved refs. See [SCENARIO_CONFIG.md](./SCENARIO_CONFIG.md#semanticssemantic_modelyml-and-the-query_metrics-tool) for the full contract. |
| **Process signals**                | Layer-3 event distributions, delay patterns, case timelines                                                                                                                                                                                                                                                                                |
| **Decision lifecycle**             | `propose_decision` → `approve_decision` → `execute_decision_action`                                                                                                                                                                                                                                                                        |
| **Permissions**                    | per-agent `can_propose` / `can_approve` / `can_execute` matrix                                                                                                                                                                                                                                                                             |
| **Risk classification**            | the harness assigning low / medium / high / critical to a proposed action                                                                                                                                                                                                                                                                  |
| **Multi-agent orchestration**      | the orchestrator decomposing a question and delegating to domain agents                                                                                                                                                                                                                                                                    |
| **Workflow durability**            | DBOS-checkpointed steps that survive crashes (Plan v3 R2.1)                                                                                                                                                                                                                                                                                |
| **Memory & precedent**             | `save_memory`, `recall_memory`, `search_precedent`                                                                                                                                                                                                                                                                                         |
| **Admin / Observability**          | governance gaps, impact analysis, drift, replay, audit                                                                                                                                                                                                                                                                                     |
| **Knowledge graph (RDF / SPARQL)** | SKOS concepts in Fuseki, queryable from outside the harness                                                                                                                                                                                                                                                                                |
| **Tracing**                        | OpenTelemetry spans (`dazense.tool.*`) for every tool call                                                                                                                                                                                                                                                                                 |

## Quick smoke test

Run the automated smoke test (self-contained):

**Linux / macOS / WSL:**

```bash
bash scripts/smoke-test.sh
```

**Windows (Git Bash, from PowerShell):**

```powershell
bash scripts\smoke-test.sh
```

The script uses Bash-only constructs, so on Windows it must run under Git Bash — but you can invoke it directly from PowerShell as shown.

**Tests:** Identity & Auth · Bundle scoping · PII policy · Business rules · OPA policy · Tracing

This now verifies end-to-end without manual harness startup:

- harness builds
- travel DB + OPA are up
- harness HTTP server starts and responds
- 31 tools discovered + governance checks pass via `test-query.ts`

## Prerequisites

> The harness now requires `SCENARIO_PATH` to be set explicitly — it no
> longer defaults to the travel scenario. The scripts below (`smoke-test.sh`,
> `dev-all.ps1`, `verify-phase-*.sh`, `test-crash-recovery.sh`) all export
> `SCENARIO_PATH=../scenario/travel` before starting the harness, so you
> don't need to set it yourself when using them. If you start the harness
> manually, `export SCENARIO_PATH=../scenario/travel` first. See
> [SCENARIO_CONFIG.md](./SCENARIO_CONFIG.md) for the full contract.

Ensure all core services are running:

**Linux / macOS / WSL:**

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
```

**Windows (PowerShell):**

```powershell
docker ps --format "table {{.Names}}`t{{.Status}}"
```

Expected containers:

```
travel_postgres         Up (healthy)
dazense_opa             Up
dazense_jaeger          Up (optional but recommended for traces)
travel_pgadmin          Up
openmetadata_server     Up (healthy)
openmetadata_postgresql Up (healthy)
```

If any are down:

**Linux / macOS / WSL:**

```bash
# Travel database
cd scenario/travel/databases && docker compose up -d

# OPA (must be started from THIS repo so /policy mount is correct)
cd /path/to/decizense && docker compose -f docker/docker-compose.opa.yml up -d --force-recreate

# OpenMetadata (if using glossary/lineage/entity tests)
cd /path/to/openmetadata-tutorial && docker compose up -d
```

**Windows (PowerShell):**

```powershell
# Travel database
Push-Location scenario\travel\databases ; docker compose up -d ; Pop-Location

# OPA (must be started from THIS repo so /policy mount is correct)
docker compose -f docker\docker-compose.opa.yml up -d --force-recreate

# OpenMetadata (if using glossary/lineage/entity tests)
Push-Location <path-to-openmetadata-tutorial> ; docker compose up -d ; Pop-Location
```

Set environment variables (LLM provider). On Windows put these in `.env` at repo root rather than exporting — the backend loads `.env` via dotenv:

**Linux / macOS / WSL:**

```bash
export AZURE_OPENAI_API_KEY=<your-key>
export AZURE_RESOURCE_NAME=deepmig
export AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-5.4
```

**Windows (PowerShell — either session env vars or edit `.env`):**

```powershell
$env:AZURE_OPENAI_API_KEY = '<your-key>'
$env:AZURE_RESOURCE_NAME  = 'deepmig'
$env:AZURE_OPENAI_CHAT_DEPLOYMENT = 'gpt-5.4'
```

Install dependencies on your current OS:

**Linux / macOS / WSL:**

```bash
./scripts/bootstrap-platform-deps.sh
```

**Windows (PowerShell):** the bootstrap script is Bash-only. Do an explicit `npm install` per workspace from a **native Windows** shell — this is what creates the `.cmd`/`.ps1` shims (`tsc.cmd`, `tsx.cmd`, `eslint.cmd`, ...). If you inherited `node_modules/` from WSL/Linux, remove it first:

```powershell
Remove-Item -Recurse -Force node_modules, harness\node_modules, agents\node_modules -ErrorAction SilentlyContinue
npm install --force
Push-Location harness ; npm install --force ; Pop-Location
Push-Location agents  ; npm install --force ; Pop-Location

# If Node-based scripts need SQLite access, rebuild the native binding for Windows
npm rebuild better-sqlite3
```

Symptom of missing shims: `'tsc' is not recognized as an internal or external command` when running `npm run build` in `harness/`.

---

## Part 1: Harness Core Tests (no LLM needed)

> Part 1 needs a running harness. The smoke test above spawns + tears down its own harness, so you only need this manual path if you've already started the harness yourself (e.g. via `scripts\dev-all.ps1`).

**Linux / macOS / WSL:**

```bash
cd agents
npx tsx src/test-query.ts
```

**Windows (PowerShell):**

```powershell
Push-Location agents
npx tsx src\test-query.ts
Pop-Location
```

**Tests:** Identity & Auth · Bundle scoping · PII policy · Business rules · Catalog (OMD) · Tracing

Expected output:

```
✅ All tests passed!

Tests:
- 34 tools discovered
- initialize_agent returns identity, scope, rules
- Delayed flights query: PASS (3 rows)
- PII query: BLOCKED (customers not in bundle)
- Out-of-bundle query: BLOCKED (bookings not in flights-ops)
- Business rules: 5 matched for flights
```

When run via `bash scripts/smoke-test.sh`, three more deterministic blocks follow:

```
Semantic-grounding plumbing test
  ✓ FQN present for flights
  ✓ real date column with type
  ... (24 prompt-builder assertions + 4 callLLM-fallback assertions)
✅ All 28 assertions passed
```

```
Scenario-neutrality test
  ✓ travel scenario loads
  ✓ minimal (non-travel) scenario loads
  ... (signal dispatch / event schema / rule evaluator / PII policy
       proven generic against a non-travel widgets+orders fixture)
✅ All 47 assertions passed
```

```
Semantic compiler regression
  ✓ registry resolves the flights model
  ✓ golden SQL: airline × delayed + total, March 2026
  ✓ time_grain=week → date_trunc($N::text, ...) (R6: bound, not interpolated)
  ✓ flight_ops cannot query bookings model (out_of_bundle)
  ✓ cross-model non-distinct aggregation across one_to_many → fanout_refused
  ... (registry resolution, planner validation, golden SQL,
       policy refusals, ambiguity regressions, fanout, max_days)
✅ All 48 assertions passed
```

The four blocks together cover, in order: **end-to-end governed query**
(test-query), **prompt-plumbing** (semantic-grounding), **scenario
neutrality** (scenario-neutral), and **semantic compiler purity**
(semantic-compiler — the engine behind `query_metrics`). All run with
no LLM and the last three with no DB, so they're deterministic and
CI-safe.

---

## Part 2: Governance Tests

> **Before running UI-based governance tests**, the backend must know how to reach the harness over MCP. Without this wiring the LLM will have no harness tools and silently reply "No response" to any governed prompt.
>
> 1. Create `mcp.harness.http.json` at repo root:
>
>     ```json
>     {
>     	"mcpServers": {
>     		"harness": {
>     			"type": "http",
>     			"url": "http://127.0.0.1:9080/mcp",
>     			"headers": { "X-Agent-Id": "flight_ops" }
>     		}
>     	}
>     }
>     ```
>
> 2. Point `MCP_JSON_FILE_PATH` at it in `.env`. On Windows, use a native path:
>
>     ```env
>     MCP_JSON_FILE_PATH=C:/Users/<you>/.../decizense/mcp.harness.http.json
>     DAZENSE_DEFAULT_PROJECT_PATH=C:/Users/<you>/.../decizense/scenario/travel
>     ```
>
>     Do **not** use `/mnt/c/...` WSL paths when running the backend from Windows.
>
> 3. Start the harness as a **separate, persistent** process (the smoke test's harness only lives for the duration of the test). Windows one-liner:
>
>     ```powershell
>     pwsh scripts\dev-all.ps1
>     ```
>
>     This starts OPA + travel_postgres checks, the harness on :9080, and `npm run dev` (backend :5005 + frontend :3000). Ctrl+C stops everything.

### PII Blocking

**Tests:** PII policy · OPA policy · Identity & Auth

Ask in the UI (`http://localhost:3000`) or via CLI:

```
"Show me customer names and email addresses"
```

Expected: **Blocked** — PII columns (first_name, last_name, email, phone) are never returned.

### Bundle Scoping

**Tests:** Bundle scoping · OPA policy

Ask:

```
"Show me data from the bookings table"
```

Expected (as flight_ops): **Blocked** — bookings table is not in the flights-ops bundle.

### Business Rules

**Tests:** Business rules · Bundle scoping · Multi-agent orchestration

Ask:

```
"What is the total revenue including cancelled bookings?"
```

Expected:

- If routed to `flight_ops`: blocked by bundle scope (no bookings/payments access), while still surfacing rule guidance.
- If routed to `booking` or orchestrator: revenue is computed with cancelled bookings excluded (or warning is returned).
- End-user path should use orchestrator, not a fixed domain agent.

---

## Part 3: Single Agent Tests

### Flight Operations Agent

**Tests:** Identity & Auth · Bundle scoping · Semantic model · Business rules · Tracing

```bash
cd agents

# Real delayed flight from our data
npx tsx src/flight-ops.ts "What are the top delay reasons in March 2026?"
```

Expected: Table showing congestion (29), crew (22), late_aircraft (22), weather (17), security (14), technical (11).

```bash
npx tsx src/flight-ops.ts "Tell me about flight NF856 from Frankfurt to Amsterdam"
```

Expected: Flight NF856, FRA→AMS, scheduled 2026-03-25 18:15, delayed 15 min (late aircraft).

### Booking Agent

**Tests:** Identity & Auth · Bundle scoping · Business rules (revenue rule excludes cancelled) · Semantic model

```bash
npx tsx src/booking.ts "How many bookings were made in March 2026?"
```

Expected: **16,388 bookings** (March 2026 only). The scenario DB contains 65,636 bookings in total across Dec 2025 – Mar 2026 — that total is what Part 7's `BookingCreated` event count (~65K) reflects, not the monthly figure.

```bash
npx tsx src/booking.ts "What is the payment failure rate?"
```

Expected: **~1.6% failure rate** (986 failed / 63,325 total payments). The numbers are generated with random seeds on each scenario build, so treat them as "within ±10% of these", not exact.

### Customer Service Agent

**Tests:** Bundle scoping · PII policy · Semantic model (loyalty tier dimension)

```bash
npx tsx src/customer-service.ts "How many customers per loyalty tier?"
```

Expected: ~600 standard, ~200 silver, ~150 gold, ~50 platinum.

```bash
npx tsx src/customer-service.ts "Show me the names of gold tier customers"
```

Expected: **Blocked** or no names shown — PII columns are blocked.

---

## Part 4: Multi-Agent Orchestrator

**Tests:** Multi-agent orchestration · Workflow durability (DBOS) · Decision lifecycle · Memory & precedent · Tracing (parent / child spans across agents)

> **Prerequisite — set `WORKFLOW_ID`.** Plan v3 R2.1 makes the workflow
> ID a required, caller-supplied input so crash-recovery can resume the
> exact same run. The orchestrator script exits with code 2 if it is
> missing. Pick any string starting with `orch-`; reuse the same value
> to resume after a crash, change it for a fresh run.
>
> **Linux / macOS / WSL:**
>
> ```bash
> export WORKFLOW_ID=orch-demo-$(date +%s)
> ```
>
> **Windows (PowerShell):**
>
> ```powershell
> $env:WORKFLOW_ID = "orch-demo-$(Get-Date -Format yyyyMMddHHmmss)"
> ```

```bash
npx tsx src/orchestrator.ts "What is the operational health of our airline in March 2026?"
```

Expected (deep-agent loop):

1. **Plan** — the orchestrator calls `write_todos` once with 3–6 sub-questions
   that each name an entity, a metric, and a time window.
2. **Task spawns** — one `task(subagent_type, description)` call per turn,
   reusing existing `flight_ops` / `booking` / `customer_service` identities.
   Each spawn shows up in stdout as `[<agent>] <answer>` and as a DBOS step
   `task_<N>_<agent>` in `dbos.operation_outputs`.
3. **(Optional) write_note** — interim facts persisted in the workflow's
   scratchpad so they survive crash-recovery without re-querying.
4. **Finalize** — `finalize({decision, confidence, evidence})` records an
   outcome via `harness.record_outcome`, and the loop exits. Stdout shows
   `Outcome stored: true` and `✅ Orchestrator workflow completed`.

The deep-agent will choose `confidence: low` and **honestly surface gaps**
when sub-agents return blocked results — that is the correct, governed
behaviour, not a test failure. (Today, the most common cause of `low` on
exec-style questions is a sub-agent SQL hallucination that the harness
blocks; Tier 2 of the semantic-layer fix gives the sub-agent live lookup
tools to mitigate. See the design doc.)

If you see `No answer generated within step limit` — that path is now
guarded: callLLM falls back to the last tool result and returns
`Blocked by governance: <reason>` or `Tool error: <reason>` instead.

```bash
npx tsx src/orchestrator.ts "How many flights were delayed and what was the revenue impact?"
```

Expected: 2–3 task spawns (delays from flight_ops, revenue from booking),
finalize with confidence high if all sub-agents return numbers.

---

## Part 5: Context from Catalog (OpenMetadata)

### Glossary Search

**Tests:** Glossary · Catalog (OMD)

Ask in the UI:

```
"What does delay mean in our system?"
```

Expected: Agent calls `harness__search_glossary` → returns FlightDelay definition: "Any deviation from scheduled departure time. Measured in minutes."

### Lineage

**Tests:** Lineage · Catalog (OMD)

Ask:

```
"Where does the events data come from?"
```

Expected: Agent calls `harness__get_lineage` → shows flights→events, bookings→events upstream.

### Entity Details

**Tests:** Catalog (OMD) · Glossary (term-to-table linkage) · PII policy (PII tags surfaced)

Ask:

```
"Tell me about the flights table"
```

Expected: Agent calls `harness__get_entity_details` → returns columns, Tier1 tag, glossary links (FlightDelay, CheckInWindow, OverbookingRate).

---

## Part 5b: Semantic Metric Execution (`query_metrics`)

**Tests:** Semantic execution · Semantic model · OPA policy · PII policy · Bundle scoping

The harness compiles a measure-shaped request into parameterised
PostgreSQL, runs governance, returns rows + the `generated_sql` + the
`resolved_measures` / `resolved_dimensions` / `applied_time_window`.
This is the engine the orchestrator's sub-agents prefer over `query_data`
when a question maps onto declared measures and dimensions.

The contract is documented in
[SCENARIO_CONFIG.md → semantic_model.yml + query_metrics](./SCENARIO_CONFIG.md#semanticssemantic_modelyml-and-the-query_metrics-tool).

### Direct CLI exercise (no LLM)

The following PowerShell sequence opens an MCP session and calls
`query_metrics` directly. Useful when you want to confirm the engine
itself works without LLM choice noise.

```powershell
# Initialise a session
$body0 = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.1"}}}'
$resp = Invoke-WebRequest -Method Post -Uri http://127.0.0.1:9080/mcp `
    -ContentType 'application/json' `
    -Headers @{Accept='application/json, text/event-stream'; 'X-Agent-Id'='flight_ops'} `
    -Body $body0
$sid = $resp.Headers['Mcp-Session-Id']
Invoke-WebRequest -Method Post -Uri http://127.0.0.1:9080/mcp `
    -ContentType 'application/json' `
    -Headers @{Accept='application/json, text/event-stream'; 'X-Agent-Id'='flight_ops'; 'Mcp-Session-Id'=$sid} `
    -Body '{"jsonrpc":"2.0","method":"notifications/initialized"}' | Out-Null

# Compute delayed + total flights per airline for March 2026
$body = @'
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query_metrics","arguments":{"measures":["flights.delayed_flights","flights.total_flights"],"dimensions":["flights.airline"],"time_range":{"start":"2026-03-01","end":"2026-04-01"},"order_by":[{"field":"delayed_flights","direction":"desc"}],"limit":10}}}
'@
Invoke-WebRequest -Method Post -Uri http://127.0.0.1:9080/mcp `
    -ContentType 'application/json' `
    -Headers @{Accept='application/json, text/event-stream'; 'X-Agent-Id'='flight_ops'; 'Mcp-Session-Id'=$sid} `
    -Body $body | Select-Object -ExpandProperty Content
```

Expected response (abridged):

```jsonc
{
	"status": "ok",
	"rows": [
		{ "airline": "NF", "delayed_flights": "7", "total_flights": "99" },
		{ "airline": "AT", "delayed_flights": "7", "total_flights": "91" },
		{ "airline": "EA", "delayed_flights": "4", "total_flights": "85" },
		{ "airline": "SJ", "delayed_flights": "4", "total_flights": "82" },
		{ "airline": "SP", "delayed_flights": "3", "total_flights": "82" },
	],
	"row_count": 5,
	"generated_sql": "SELECT \"flights\".\"airline_code\" AS \"airline\", COUNT(flights.flight_id) FILTER (WHERE flights.status = $1) AS \"delayed_flights\", COUNT(flights.flight_id) AS \"total_flights\"\nFROM \"public\".\"flights\" AS \"flights\"\nWHERE \"flights\".\"scheduled_departure\" >= $2 AND \"flights\".\"scheduled_departure\" < $3\nGROUP BY 1\nORDER BY \"delayed_flights\" DESC\nLIMIT $4",
	"resolved_measures": [
		{
			"ref": "flights.delayed_flights",
			"expression": "COUNT(flights.flight_id) FILTER (WHERE flights.status = $1)",
		},
		{ "ref": "flights.total_flights", "expression": "COUNT(flights.flight_id)" },
	],
	"resolved_dimensions": [{ "ref": "flights.airline", "column": "flights.airline_code" }],
	"applied_time_window": { "column": "flights.scheduled_departure", "start": "2026-03-01", "end": "2026-04-01" },
	"governance": { "policy_version": "<sha>" },
}
```

Things to confirm in the response:

- Every value (the `'delayed'` literal, the date bounds, the LIMIT
  integer) is a `$N` placeholder — no values inlined into the SQL text.
- `generated_sql` matches the request: GROUP BY 1 because of the airline
  dimension, FILTER WHERE for the snapshot-style measure.
- `resolved_*` blocks let the caller see what was computed without
  parsing the SQL.

### Negative tests

| Request                                                                                                                                                           | Expected response                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `{"measures":["flights.no_such"],"time_range":{"start":"2026-03-01","end":"2026-04-01"}}`                                                                         | `status:"error"`, `code:"unknown_measure"`, `details.suggestion` (Levenshtein hint), `details.available` list       |
| `{"measures":["bookings.total_bookings"]}`                                                                                                                        | `status:"error"`, `code:"out_of_bundle"` (flight_ops can't reach bookings), `details.allowed_tables`                |
| `{"measures":["flights.total_flights"],"time_range":{"start":"2024-01-01","end":"2026-01-01"}}`                                                                   | `status:"error"`, `code:"time_filter_required"`, `details.actual_days:731`, `details.max_days:90` (window too wide) |
| `{"measures":["delays.total_delays"],"dimensions":["flights.airline"],"time_range":{"start":"2026-03-01","end":"2026-04-01"}}` (cross-model with no allowed_join) | `status:"error"`, `code:"disallowed_join"`, `details.declared_in_bundle` echoes the bundle's actual joins           |

### Ambiguity-as-feature

The travel scenario deliberately exposes two distinct "delayed" measures:

- `flights.delayed_flights` — snapshot, `COUNT(flight_id) FILTER (WHERE status='delayed')`.
- `delays.total_delays` — event-log row count from `public.flight_delays`.

They live on different models with different tables. There is no
"correct" delayed metric — there are two, and the caller must pick.
The compiler refuses bare `delayed_flights` references with
`ambiguous_ref` even when only one model defines it; refs must be
fully qualified. This is a structural guarantee, not a convention.

### Inside the orchestrator

The deep-agent sub-agents are wired with `query_metrics` as a tool
alongside `query_data`. The sub-agent prompt instructs them to prefer
`query_metrics` for measure-shaped questions because the harness
compiles, governs, and returns the SQL — so business-rule logic baked
into a measure (e.g. `delayed_flights` already filters
`status='delayed'`) is applied without re-derivation by the LLM.

In practice the LLM still sometimes chooses `query_data` out of habit;
that's a prompt-engineering follow-up, not a wiring issue (the unit
suite + the direct curl above prove the engine path).

---

## Part 6: Decision Lifecycle

> **Windows note:** Parts 6–8 use Bash `echo '…json…' | npx tsx` pipelines that don't port cleanly to PowerShell (PowerShell pipes objects, not raw text, and here-strings interact poorly with JSON quoting). Run these blocks from **Git Bash** on Windows. Alternative: save each JSON request to a file and feed it via `Get-Content req.json | npx tsx src\server.ts`.

### Via CLI — Full Lifecycle Test

**Tests:** Decision lifecycle (`propose_decision`) · Risk classification · Permissions

```bash
cd harness

# 1. Propose a decision
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"propose_decision","arguments":{"session_id":"test-lifecycle","agent_id":"flight_ops","proposed_action":"Flight NF856 delayed 15 min. No impact on operations.","confidence":"high","risk_class":"low","evidence_event_ids":[],"evidence_rules":["checkin_window"]}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: `proposal_id` returned, status: pending, requires_approval: false.

### Check Permissions

**Tests:** Permissions · Identity & Auth

```bash
echo '...(initialize)...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_permissions","arguments":{"agent_id":"flight_ops"}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: can_propose [low, medium, high], can_approve [low], can_execute [low].

### Risk Classification

**Tests:** Risk classification · Decision lifecycle · Permissions (auto-execute denied for `high`) · Multi-agent orchestration

> Same `WORKFLOW_ID` rule as Part 4 — set `$env:WORKFLOW_ID = "orch-rebook-$(Get-Date -Format yyyyMMddHHmmss)"` (PowerShell) or `export WORKFLOW_ID=orch-rebook-$(date +%s)` (bash) before running.

Ask the orchestrator:

```bash
npx tsx src/orchestrator.ts "Rebook the passenger on flight NF856 to the next available flight"
```

Expected: the orchestrator plans, spawns a `task(booking, ...)` to look up the booking + connection, and then `finalize`s with a proposed action carrying `risk_class: high`. The harness's permission matrix denies auto-execute on `high`, so the recorded outcome surfaces a `requires_approval: true` flag rather than executing the rebooking. Agent cannot auto-execute.

---

## Part 7: Process Signals (Layer 3)

### Event Distribution

**Tests:** Process signals (event distribution aggregation, no row-level access required)

```bash
echo '...(initialize)...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_process_signals","arguments":{"signal_type":"event_distribution","time_range_days":90}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: FlightSearched (65K), BookingCreated (65K), PaymentSucceeded (62K), etc.

### Delay Patterns

**Tests:** Process signals (pattern detection across `flight_delays`)

```bash
echo '...(initialize)...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_process_signals","arguments":{"signal_type":"delay_patterns","time_range_days":90}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: congestion (29, avg 48 min), crew (22), late_aircraft (22), weather (17).

### Case Timeline

**Tests:** Process signals (per-case event reconstruction) · Bundle scoping (cross-bundle event read controlled by policy)

```bash
echo '...(initialize)...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_case_timeline","arguments":{"case_key":"booking_id","case_id":65637}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: 5-step timeline: BookingCreated → PaymentSucceeded → TicketIssued → ...

---

## Part 8: Admin Tools

### Governance Gaps

**Tests:** Admin / Observability (gap detection across catalog × bundles × rules)

```bash
echo '...(initialize)...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"find_governance_gaps","arguments":{"check":"all"}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: 7+ gaps (events not in bundle, some tables without rules).

### Impact Analysis

**Tests:** Admin / Observability (dependency graph) · Semantic model (allowed_joins) · Catalog (OMD)

```bash
echo '...(initialize)...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"simulate_removal","arguments":{"table_name":"flights"}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: 13+ impacts (bundle broken, joins broken, rules orphaned, model broken).

### Statistics

**Tests:** Admin / Observability (aggregate counts of every governance primitive)

```bash
echo '...(initialize)...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"graph_stats","arguments":{}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: 9 tables, 19 glossary terms, 3 bundles, 11 rules, 4 PII columns, 4 agents.

---

## Part 9: SPARQL / Knowledge Graph

**Tests:** Knowledge graph (RDF / SPARQL) · Glossary (SKOS view of the same terms)

Open Fuseki UI at `http://localhost:3030`:

- Login: admin / fuseki_admin
- Select dataset: `/openmetadata`
- Run query:

```sparql
SELECT ?term ?label WHERE {
  ?term <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>
        <http://www.w3.org/2004/02/skos/core#Concept> .
  ?term <http://www.w3.org/2004/02/skos/core#prefLabel> ?label
}
```

Expected: 8+ glossary terms as RDF concepts.

---

## Part 10: UI Testing

Start the dev server. Make sure the harness is running too (see the Part 2 prerequisite block); `npm run dev` alone does **not** start the harness.

**Linux / macOS / WSL:**

```bash
cd /path/to/decizense
npm run dev   # in a second terminal, harness must already be running
```

**Windows (PowerShell) — one command for harness + backend + frontend:**

```powershell
cd C:\path\to\decizense
pwsh scripts\dev-all.ps1
```

Open `http://localhost:3000`. Log in. Select Kimi K2.5 or GPT.

### Questions to try:

| Question                                       | Harness capabilities exercised                                |
| ---------------------------------------------- | ------------------------------------------------------------- |
| "How many flights were delayed in March 2026?" | Bundle scoping · Semantic model · Tracing                     |
| "What are the top delay reasons?"              | Bundle scoping · Semantic model (allowed_joins) · Aggregation |
| "Show me customer names"                       | PII policy · OPA policy                                       |
| "What does overbooking mean?"                  | Glossary · Catalog (OMD)                                      |
| "Where does events data come from?"            | Lineage · Catalog (OMD)                                       |
| "What is the total revenue?"                   | Business rules (revenue rule excludes cancelled)              |
| "How many Gold tier customers?"                | Bundle scoping · PII policy (PII-safe aggregate)              |
| "Tell me about the flights table"              | Catalog (OMD) · Glossary · PII policy (PII tags surfaced)     |

### What to look for in the UI:

- `harness__query_data` tool calls (not execute_sql)
- `harness__search_glossary` for business term questions
- `harness__get_context` for context-rich questions
- Blocked responses for PII attempts
- Markdown tables for data results

---

## Part 11: pgAdmin

**Tests:** Memory & precedent (`memory_entries`, `agent_memory`) · Decision lifecycle (`decision_outcomes`) · Workflow durability (DBOS-tracked autonomy stats) — verified by direct SQL inspection of the harness's persistence layer

Open `http://localhost:5050`:

- Login: admin@dazense.com / admin
- Server: Travel DB (host: travel-postgres, port: 5432, user: travel_admin, pass: travel_pass)

Check tables:

```sql
-- Decision outcomes (from orchestrator runs)
SELECT * FROM decision_outcomes ORDER BY created_at DESC LIMIT 5;

-- Memory entries (auto-captured from outcomes)
SELECT memory_type, scope_type, scope_id, title, confidence
FROM memory_entries ORDER BY created_at DESC LIMIT 10;

-- Agent memory (legacy KV)
SELECT * FROM agent_memory;

-- Autonomy stats
SELECT * FROM autonomy_stats;
```

---

## Part 12: OpenMetadata

**Tests:** Catalog (OMD) · Glossary · Lineage · PII policy (tag definitions live here, the harness consumes them)

Open `http://localhost:8585`:

- Login: admin@open-metadata.org / admin

Check:

- **Travel Operations** domain
- **Tables**: flights, bookings, customers (with tags, descriptions)
- **Glossary**: TravelOperationsGlossary (10 terms with relationships)
- **Lineage**: flights → events, bookings → events
- **PII tags**: customers.first_name, last_name, email, phone → PII.Sensitive

---

## Troubleshooting

### Port conflicts

**Linux / macOS / WSL:**

```bash
netstat -ano | grep ":5005\|:3000\|:5433\|:8585\|:3030"
```

**Windows (PowerShell):**

```powershell
Get-NetTCPConnection -LocalPort 5005,3000,5433,8585,3030 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,OwningProcess
# Inspect a suspect PID:
Get-Process -Id <pid>
# Free it:
Stop-Process -Id <pid> -Force
```

### Harness won't start

```bash
cd harness && npx tsc --noEmit  # Check for TypeScript errors
```

On Windows, if this fails with `'tsc' is not recognized`, your `harness\node_modules` was installed on WSL/Linux and is missing the `.cmd` shims. Reinstall — see [§ Windows runbook](#windows--powershell-runbook).

### `esbuild` platform mismatch (Windows/WSL)

Symptoms:

- `You installed esbuild for another platform than the one you're currently using`

**Linux / macOS / WSL:**

```bash
./scripts/bootstrap-platform-deps.sh
./scripts/smoke-test.sh
```

**Windows (PowerShell):**

```powershell
Remove-Item -Recurse -Force node_modules, harness\node_modules, agents\node_modules -ErrorAction SilentlyContinue
npm install --force
Push-Location harness ; npm install --force ; Pop-Location
Push-Location agents  ; npm install --force ; Pop-Location
bash scripts\smoke-test.sh
```

### Database connection failed

```bash
docker exec travel_postgres pg_isready -U travel_admin -d travel_db
```

### OMD not responding

**Linux / macOS / WSL:**

```bash
curl http://localhost:8585/api/v1/system/version
```

**Windows (PowerShell):**

```powershell
Invoke-RestMethod http://localhost:8585/api/v1/system/version
```

### Windows-specific issues

**"No response" in the UI for every prompt**
The backend is not connected to the harness MCP server. Check:

- `.env` has `MCP_JSON_FILE_PATH` pointing at `mcp.harness.http.json` (Windows path, not `/mnt/c/...`).
- Harness is actually listening: `Invoke-RestMethod http://127.0.0.1:9080/mcp -Method Post -Headers @{'Accept'='application/json, text/event-stream'; 'X-Agent-Id'='flight_ops'} -Body '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.1"}}}' -ContentType application/json`
- Restart the backend after any `.env` change (dotenv loads once).

**Port 5005 held by `wslrelay.exe`**
A prior backend started in WSL left a port forwarder. `wsl --shutdown` releases it — but note this also tears down Docker Desktop's WSL2 backend, so re-check containers afterwards with `docker ps` and recreate OPA if needed (`docker compose -f docker\docker-compose.opa.yml up -d --force-recreate`).

**`Error: … is not a valid Win32 application` for `better-sqlite3`**
Left-over Linux build of the native binding.

```powershell
npm rebuild better-sqlite3
```

Bun has its own SQLite and isn't affected — this matters only for Node-based scripts that open `apps\backend\db.sqlite`.

**Azure deployment mismatch**
The tutorial references `AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-5.4`; use whatever deployment name actually exists in your Azure resource.

---

## Windows / PowerShell runbook

One-page cheat-sheet for starting clean on a Windows host. Assumes you have: Docker Desktop, Node ≥ 20.19 (24 recommended), Bun ≥ 1.3, Git Bash, PowerShell 7.

### 1. One-time setup

```powershell
cd C:\path\to\decizense

# Verify toolchain
node -v ; npm -v ; bun --version

# Install/repair dependencies on Windows so .cmd/.ps1 shims exist
Remove-Item -Recurse -Force node_modules, harness\node_modules, agents\node_modules -ErrorAction SilentlyContinue
npm install --force
Push-Location harness ; npm install --force ; Pop-Location
Push-Location agents  ; npm install --force ; Pop-Location
npm rebuild better-sqlite3

# Ensure .env uses Windows paths (not /mnt/c/...)
#   DAZENSE_DEFAULT_PROJECT_PATH=C:/path/to/decizense/scenario/travel
#   MCP_JSON_FILE_PATH=C:/path/to/decizense/mcp.harness.http.json
#   AZURE_OPENAI_API_KEY=...   AZURE_OPENAI_ENDPOINT=...   AZURE_OPENAI_CHAT_DEPLOYMENT=...
```

Create `mcp.harness.http.json` at repo root (content shown in the Part 2 prerequisite block above).

### 2. Every session

```powershell
# Part 1 — harness core governance tests (no LLM)
bash scripts\smoke-test.sh

# Full stack (harness + backend + frontend) for Parts 2, 10, etc.
pwsh scripts\dev-all.ps1
# -> http://localhost:3000 for UI, Ctrl+C to stop all
```

### 3. Health probes

```powershell
Test-NetConnection localhost -Port 5005   # backend
Test-NetConnection localhost -Port 3000   # frontend
Test-NetConnection localhost -Port 9080   # harness
Invoke-RestMethod http://127.0.0.1:8181/health   # OPA
docker exec travel_postgres pg_isready -U travel_admin -d travel_db
```

### 4. Common recovery

| Symptom                                                | Action                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `'tsc' is not recognized`                              | Re-run Step 1 (shims missing).                                                                          |
| UI always shows "No response"                          | `.env` `MCP_JSON_FILE_PATH` unset, or harness not running. See Part 2 prereq block.                     |
| OPA unreachable after `wsl --shutdown`                 | `docker compose -f docker\docker-compose.opa.yml up -d --force-recreate ; docker start travel_postgres` |
| Port 5005 stuck on `wslrelay.exe`                      | `wsl --shutdown` (also restarts Docker backend; recheck containers).                                    |
| `better_sqlite3.node is not a valid Win32 application` | `npm rebuild better-sqlite3`                                                                            |

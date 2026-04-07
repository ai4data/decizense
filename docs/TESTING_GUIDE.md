# Testing Guide — Agent Harness

This guide walks through testing all components of the harness: infrastructure, governance, agents, multi-agent orchestration, memory, and the proving workflow.

For the full Plan v3 end-to-end validation runbook (including UI and umbrella verifier), see:

- [PLAN_V3_E2E_TESTING_TUTORIAL.md](./PLAN_V3_E2E_TESTING_TUTORIAL.md)

## Quick smoke test

Run the automated smoke test:

```bash
bash scripts/smoke-test.sh
```

This verifies: harness builds, 31 tools discovered, governance checks pass.

## Prerequisites

Ensure all services are running:

```bash
# Check containers
docker ps --format "table {{.Names}}\t{{.Status}}"

# Expected:
# travel_postgres         Up (healthy)
# travel_pgadmin          Up
# openmetadata_server     Up (healthy)
# openmetadata_fuseki     Up
# openmetadata_postgresql Up (healthy)
# openmetadata_elasticsearch Up (healthy)
```

If any are down:

```bash
# Travel database
cd scenario/travel/databases && docker compose up -d

# OpenMetadata
cd /path/to/openmetadata-tutorial && docker compose up -d
```

Set environment variables:

```bash
export AZURE_OPENAI_API_KEY=<your-key>
export AZURE_RESOURCE_NAME=deepmig
export AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-5.4
```

Install dependencies on your current OS/WSL environment:

```bash
./scripts/bootstrap-platform-deps.sh
```

---

## Part 1: Harness Core Tests (no LLM needed)

```bash
cd agents
npx tsx src/test-query.ts
```

Expected output:

```
✅ All tests passed!

Tests:
- 31 tools discovered
- initialize_agent returns identity, scope, rules
- Delayed flights query: PASS (3 rows)
- PII query: BLOCKED (customers not in bundle)
- Out-of-bundle query: BLOCKED (bookings not in flights-ops)
- Business rules: 5 matched for flights
```

---

## Part 2: Governance Tests

### PII Blocking

Ask in the UI (`http://localhost:3000`) or via CLI:

```
"Show me customer names and email addresses"
```

Expected: **Blocked** — PII columns (first_name, last_name, email, phone) are never returned.

### Bundle Scoping

Ask:

```
"Show me data from the bookings table"
```

Expected (as flight_ops): **Blocked** — bookings table is not in the flights-ops bundle.

### Business Rules

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

```bash
npx tsx src/booking.ts "How many bookings were made in March 2026?"
```

Expected: ~65,636 bookings.

```bash
npx tsx src/booking.ts "What is the payment failure rate?"
```

Expected: ~5% failure rate (3,283 failures / 65,283 total).

### Customer Service Agent

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

```bash
npx tsx src/orchestrator.ts "What is the operational health of our airline in March 2026?"
```

Expected:

1. Orchestrator plans: involves flight_ops + booking agents
2. flight_ops reports: 115 delays, top reasons, delay patterns
3. booking reports: 65K bookings, cancellation rate, revenue
4. Orchestrator combines: overall health assessment with confidence score
5. Decision recorded as precedent

Note: LLM orchestration is probabilistic. If you see `No answer generated within step limit`, treat it as a runtime degradation (not a governance failure) and use Troubleshooting.

```bash
npx tsx src/orchestrator.ts "How many flights were delayed and what was the revenue impact?"
```

Expected: Both agents contribute findings, orchestrator synthesizes.

---

## Part 5: Context from Catalog (OpenMetadata)

### Glossary Search

Ask in the UI:

```
"What does delay mean in our system?"
```

Expected: Agent calls `harness__search_glossary` → returns FlightDelay definition: "Any deviation from scheduled departure time. Measured in minutes."

### Lineage

Ask:

```
"Where does the events data come from?"
```

Expected: Agent calls `harness__get_lineage` → shows flights→events, bookings→events upstream.

### Entity Details

Ask:

```
"Tell me about the flights table"
```

Expected: Agent calls `harness__get_entity_details` → returns columns, Tier1 tag, glossary links (FlightDelay, CheckInWindow, OverbookingRate).

---

## Part 6: Decision Lifecycle

### Via CLI — Full Lifecycle Test

```bash
cd harness

# 1. Propose a decision
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"propose_decision","arguments":{"session_id":"test-lifecycle","agent_id":"flight_ops","proposed_action":"Flight NF856 delayed 15 min. No impact on operations.","confidence":"high","risk_class":"low","evidence_event_ids":[],"evidence_rules":["checkin_window"]}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: `proposal_id` returned, status: pending, requires_approval: false.

### Check Permissions

```bash
echo '...(initialize)...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_permissions","arguments":{"agent_id":"flight_ops"}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: can_propose [low, medium, high], can_approve [low], can_execute [low].

### Risk Classification

Ask the orchestrator:

```bash
npx tsx src/orchestrator.ts "Rebook the passenger on flight NF856 to the next available flight"
```

Expected: Rebooking is `high` risk → requires human approval → agent cannot auto-execute.

---

## Part 7: Process Signals (Layer 3)

### Event Distribution

```bash
echo '...(initialize)...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_process_signals","arguments":{"signal_type":"event_distribution","time_range_days":90}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: FlightSearched (65K), BookingCreated (65K), PaymentSucceeded (62K), etc.

### Delay Patterns

```bash
echo '...(initialize)...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_process_signals","arguments":{"signal_type":"delay_patterns","time_range_days":90}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: congestion (29, avg 48 min), crew (22), late_aircraft (22), weather (17).

### Case Timeline

```bash
echo '...(initialize)...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_case_timeline","arguments":{"booking_id":65637}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: 5-step timeline: BookingCreated → PaymentSucceeded → TicketIssued → ...

---

## Part 8: Admin Tools

### Governance Gaps

```bash
echo '...(initialize)...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"find_governance_gaps","arguments":{"check":"all"}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: 7+ gaps (events not in bundle, some tables without rules).

### Impact Analysis

```bash
echo '...(initialize)...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"simulate_removal","arguments":{"table_name":"flights"}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: 13+ impacts (bundle broken, joins broken, rules orphaned, model broken).

### Statistics

```bash
echo '...(initialize)...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"graph_stats","arguments":{}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: 9 tables, 19 glossary terms, 3 bundles, 11 rules, 4 PII columns, 4 agents.

---

## Part 9: SPARQL / Knowledge Graph

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

Start the dev server:

```bash
cd /path/to/dazense-context-infrastructure
npm run dev
```

Open `http://localhost:3000`. Log in. Select Kimi K2.5 or GPT.

### Questions to try:

| Question                                       | Tests                              |
| ---------------------------------------------- | ---------------------------------- |
| "How many flights were delayed in March 2026?" | Basic governed query               |
| "What are the top delay reasons?"              | Aggregation + joins                |
| "Show me customer names"                       | PII blocking                       |
| "What does overbooking mean?"                  | Glossary from OMD                  |
| "Where does events data come from?"            | Lineage from OMD                   |
| "What is the total revenue?"                   | Business rule (excludes cancelled) |
| "How many Gold tier customers?"                | Customer query (PII safe)          |
| "Tell me about the flights table"              | Entity details from OMD            |

### What to look for in the UI:

- `harness__query_data` tool calls (not execute_sql)
- `harness__search_glossary` for business term questions
- `harness__get_context` for context-rich questions
- Blocked responses for PII attempts
- Markdown tables for data results

---

## Part 11: pgAdmin

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

```bash
netstat -ano | grep ":5005\|:3000\|:5433\|:8585\|:3030"
```

### Harness won't start

```bash
cd harness && npx tsc --noEmit  # Check for TypeScript errors
```

### `esbuild` platform mismatch (Windows/WSL)

Symptoms:

- `You installed esbuild for another platform than the one you're currently using`

Fix:

```bash
./scripts/bootstrap-platform-deps.sh
```

Then rerun:

```bash
./scripts/smoke-test.sh
```

### Database connection failed

```bash
docker exec travel_postgres pg_isready -U travel_admin -d travel_db
```

### OMD not responding

```bash
curl http://localhost:8585/api/v1/system/version
```

# Cookbook 01: Quickstart — Run the Travel Scenario

Get the harness running with the travel scenario in 5 minutes.

## Prerequisites

- Docker Desktop running
- Node.js 20+
- An LLM API key (Azure OpenAI, OpenAI, or OpenRouter)

## Step 1: Start the database

```bash
cd scenario/travel/databases
docker compose up -d
```

Wait for healthy status:

```bash
docker ps --filter "name=travel_postgres" --format "{{.Status}}"
# Expected: Up ... (healthy)
```

## Step 2: Generate synthetic data

```bash
pip install psycopg2-binary faker
python generate_data.py
```

Expected: ~1000 customers, ~450 flights, ~65K bookings, ~383K events.

## Step 3: Install dependencies

```bash
cd ../../..  # back to repo root

# Root (UI backend + frontend)
npm install

# Harness
cd harness && npm install && cd ..

# Agents (examples)
cd agents && npm install && cd ..
```

Or use the bootstrap script:

```bash
bash scripts/bootstrap-platform-deps.sh
```

> **Note**: If switching between Windows and WSL, run `npm install` from the target platform to get the correct esbuild binary.

## Step 4: Test governance (no LLM needed)

```bash
cd agents
npx tsx src/test-query.ts
```

Expected output:

```
✅ All tests passed!
- 31 tools available
- Delayed flights query: PASS
- PII query: BLOCKED
- Out-of-bundle query: BLOCKED
- Business rules: 5 matched
```

## Step 5: Run an agent with LLM

Set your LLM credentials:

```bash
# Azure OpenAI
export AZURE_OPENAI_API_KEY=<your-key>
export AZURE_RESOURCE_NAME=<your-resource>
export AZURE_OPENAI_CHAT_DEPLOYMENT=<your-deployment>
```

Run the flight operations agent:

```bash
npx tsx src/flight-ops.ts "What are the top delay reasons in March 2026?"
```

Expected: Table of delay reasons (congestion, crew, weather, etc.) with counts and averages.

## Step 6: Run multi-agent orchestrator

```bash
npx tsx src/orchestrator.ts "What is the operational health of our airline?"
```

Expected: Orchestrator delegates to flight_ops + booking agents, combines findings into a decision with confidence score.

## What just happened?

1. The **harness** started as an MCP server
2. The **agent** connected to the harness via MCP
3. The agent called `initialize_agent` → got its identity, scope, rules
4. The agent called `query_data` with SQL → harness checked:
    - Is this agent authenticated? ✓
    - Are the tables in its bundle? ✓
    - Is the SQL read-only? ✓
    - Any PII columns? ✓
    - Has LIMIT? ✓
5. Harness executed the query and returned governed results

## Next steps

- [02-catalog-setup.md](02-catalog-setup.md) — Connect OpenMetadata for catalog-backed governance
- [03-governance-deep-dive.md](03-governance-deep-dive.md) — Test PII blocking, bundles, business rules
- [04-new-scenario.md](04-new-scenario.md) — Create your own scenario (banking, retail, etc.)

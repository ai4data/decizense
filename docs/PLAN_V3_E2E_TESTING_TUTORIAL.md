# Plan v3 End-to-End Testing Tutorial (CLI + UI)

This tutorial validates the Plan v3 hardening work end-to-end:

- Phase 0: tracing and observability
- Phase 1a: HTTP transport + per-session auth isolation
- Phase 1b: durable harness workflows (DBOS)
- Phase 1c: durable orchestrator workflow
- Phase 2a/2b: OPA governance shadow-to-authoritative
- Phase 2c: decision logs + replay + drift tools

Use this as the canonical handoff test runbook.

## 1. Prerequisites

### Required services

You need these containers running:

- `travel_postgres`
- `openmetadata_server` (optional for some tests, but expected in current harness setup)
- `dazense_opa`
- `dazense_jaeger`

Check:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
```

Start them if needed:

```bash
# Travel DB
cd scenario/travel/databases
docker compose up -d
cd ../../..

# OPA sidecar
docker compose -f docker/docker-compose.opa.yml up -d

# Jaeger / OTEL
docker compose -f docker/docker-compose.observability.yml up -d
```

### Dependencies

Install dependencies for your current runtime (Windows/WSL/Linux) before testing:

```bash
bash scripts/bootstrap-platform-deps.sh
```

If you see `esbuild` platform mismatch errors, run:

```bash
cd harness && npm install && cd ..
cd agents && npm install && cd ..
```

## 2. Fastest Full Validation (CLI)

Run the umbrella verifier:

```bash
bash scripts/verify-plan-v3.sh
```

Expected final output:

- `PASS - Plan v3 umbrella verification complete`
- plus an evidence folder under `docs/plan-v3-verification/<timestamp>/`

This single command runs all phase verifiers in sequence and fails fast on first issue.

## 3. Phase-by-Phase CLI Validation

Use this when you want focused debugging:

```bash
bash scripts/verify-phase-0.sh
bash scripts/verify-phase-1a.sh
bash scripts/verify-phase-1b.sh
bash scripts/verify-phase-1c.sh
bash scripts/verify-phase-2a.sh
bash scripts/verify-phase-2b.sh
bash scripts/verify-phase-2c.sh
```

Each script writes evidence to `docs/phase-*-verification/<timestamp>/`.

## 4. Key CLI Assertions To Check

### Phase 1a (session isolation)

In `docs/phase-1a-verification/<timestamp>/summary.md`, confirm:

- `test-concurrency.ts` passed
- both parallel agents kept isolated identities

### Phase 1b (durability)

In `docs/phase-1b-verification/<timestamp>/` confirm:

- `test-idempotency.log` passed
- `test-crash-recovery.log` passed
- DBOS status reached `SUCCESS`

### Phase 1c (orchestrator durability)

In `docs/phase-1c-verification/<timestamp>/` confirm:

- `test-orchestrator-idempotency.log` passed
- `test-orchestrator-crash-recovery.log` passed
- guardrail test `test-llm-mock-guardrail.log` passed

### Phase 2b (OPA authoritative)

In `docs/phase-2b-verification/<timestamp>/` confirm:

- regressions passed
- negative OPA-down test passed (`negative-opa-down.log`)

### Phase 2c (replay + drift)

In `docs/phase-2c-verification/<timestamp>/` confirm:

- `test-admin-tools.log` passed
- `replay_outcome` and `policy_drift_report` succeeded in JWT mode

## 5. UI End-to-End Validation

This validates the UI path and live MCP tool execution.

### 5.1 Create MCP config for UI backend

Create a file at repo root named `mcp.harness.http.json`:

```json
{
	"mcpServers": {
		"harness": {
			"type": "http",
			"url": "http://127.0.0.1:9080/mcp",
			"headers": {
				"X-Agent-Id": "flight_ops"
			}
		}
	}
}
```

### 5.2 Start harness (terminal A)

```bash
cd harness
HARNESS_TRANSPORT=http \
HARNESS_ALLOW_INSECURE_CONFIG_ONLY=true \
HARNESS_BIND=127.0.0.1 \
HARNESS_HTTP_PORT=9080 \
SCENARIO_PATH=../scenario/travel \
npx tsx src/server.ts
```

Wait for:

- `HTTP transport listening on http://127.0.0.1:9080/mcp`
- `OPA: reachable`

### 5.3 Start UI stack (terminal B)

From repo root:

```bash
export MCP_JSON_FILE_PATH="$(pwd)/mcp.harness.http.json"
export DAZENSE_DEFAULT_PROJECT_PATH="$(pwd)/scenario/travel"
npm run dev
```

Open:

- `http://localhost:3000`

If prompted, sign in/create a local account.

### 5.4 Confirm MCP connection in UI

In Settings, open the MCP server page and verify:

- `harness` server is connected
- tools are listed (prefixed as `harness__...`)

### 5.5 UI test scenarios

In chat, run these prompts.

1. Allowed governed query:

```text
Initialize as flight_ops and show the top delay reasons in March 2026 with a LIMIT.
```

Expected:

- successful answer with delay-reason data
- tool calls include `harness__initialize_agent` and `harness__query_data`

2. PII block:

```text
Initialize as flight_ops and return customer first_name and email.
```

Expected:

- blocked/refused due to PII and/or bundle scope

3. Out-of-bundle block:

```text
Initialize as flight_ops and query booking_id from bookings.
```

Expected:

- blocked by bundle governance

4. Business-rule retrieval:

```text
Initialize as flight_ops and list business rules relevant to flights.
```

Expected:

- response includes matched rules
- tool call uses `harness__get_business_rules`

### 5.6 Validate UI actions in DB/logs

From a terminal:

```bash
# Decision log rows should increase after UI queries
docker exec -i travel_postgres psql -U travel_admin -d travel_db -c \
"SELECT COUNT(*) FROM decision_logs;"

# Inspect latest rows
docker exec -i travel_postgres psql -U travel_admin -d travel_db -c \
"SELECT opa_decision_id, agent_id, tool_name, allowed, timestamp FROM decision_logs ORDER BY timestamp DESC LIMIT 20;"
```

Jaeger:

- Open `http://localhost:16686`
- Search for service `dazense-harness`
- Verify recent spans for tool calls made from UI

## 6. Optional: Replay/Drift Admin Validation (CLI)

UI may not expose admin tools directly. Validate with CLI via phase 2c verifier:

```bash
bash scripts/verify-phase-2c.sh
```

This includes JWT-mode admin calls:

- `replay_outcome`
- `policy_drift_report`

## 7. Troubleshooting

### Harness never becomes ready

- wait up to 120s on slower machines
- inspect `harness.log` in the current evidence folder
- ensure port 9080 is free

### Port 9080 conflicts

```bash
ss -ltnp | rg 9080
```

Kill stale listener, then rerun verifier.

### OPA down/fail-fast

```bash
curl -sf http://localhost:8181/health
```

If this fails, restart OPA:

```bash
docker compose -f docker/docker-compose.opa.yml up -d
```

### esbuild platform mismatch

Run fresh installs in both packages:

```bash
cd harness && npm install && cd ..
cd agents && npm install && cd ..
```

## 8. Cleanup

Stop local app processes (`Ctrl+C`), then optionally stop infra:

```bash
docker compose -f docker/docker-compose.observability.yml down
docker compose -f docker/docker-compose.opa.yml down
cd scenario/travel/databases && docker compose down
```

## 9. What to Attach in a Test Report

Minimum evidence set:

- umbrella summary folder: `docs/plan-v3-verification/<timestamp>/`
- latest phase summaries for any failed/retried phase
- `harness.log` from failing phase run
- for UI: screenshots of MCP settings page + sample governed/blocked responses

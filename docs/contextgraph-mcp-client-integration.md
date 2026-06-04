# Decizense → ContextGraph-MCP Client Integration

Decizense is **one client** of ContextGraph-MCP, the standalone governed MCP
server extracted from this repo's harness. ContextGraph-MCP now lives in the
sibling repo `..\contextgraph-mcp` (Phase 1 locked, tag `v0.1.0-phase1`). This
doc covers the config + operational wiring. The per-call client changes are
tracked in `docs/contextgraph-mcp-phase-2-backlog.md`.

## Connection

Decizense already connects over MCP HTTP — no embedded-harness assumption is
required in the transport layer. The connection config is unchanged:

`mcp.harness.http.json`

```json
{
	"mcpServers": {
		"harness": {
			"type": "http",
			"url": "http://127.0.0.1:9080/mcp",
			"headers": { "X-Agent-Id": "flight_ops" }
		}
	}
}
```

## Running the server (from the sibling repo)

Launch ContextGraph-MCP from `..\contextgraph-mcp`, not from this repo's
`harness/`:

```powershell
# 1. scenario Postgres (host port 5433) + OPA sidecar (8181)
Set-Location ..\contextgraph-mcp\scenario\travel\databases
docker compose up -d travel-postgres
Set-Location ..\..\..\docker
docker compose -f docker-compose.opa.yml up -d
Set-Location ..\..\decizense

# 2. the MCP server
Set-Location ..\contextgraph-mcp\harness
$env:HARNESS_TRANSPORT='http'; $env:HARNESS_ALLOW_INSECURE_CONFIG_ONLY='true'
$env:SCENARIO_PATH='..\scenario\travel'
npx tsx src/server.ts   # listens on http://127.0.0.1:9080/mcp
```

Decizense's `apps/backend` and `agents/` then connect via `mcp.harness.http.json`
exactly as before.

## Contract clients must honor (Phase 1)

Every **state-changing** tool now requires `case_id` and `request_id` (UUIDs):
`write_finding`, `propose_decision`, `approve_decision`, `execute_decision_action`,
`execute_action`, `record_outcome`, `save_memory`, `query_data`, `query_metrics`.

- `case_id` — one per business case (e.g. a chat/decision session); reused across
  all related tool calls.
- `request_id` — fresh per tool call; reused only to retry. A duplicate
  `request_id` returns the previously persisted result without re-running side
  effects.

See `..\contextgraph-mcp\docs\PHASE-1-HANDOFF.md` for the full migration notes
(proposal IDs are UUIDs, `save_memory` no longer upserts `agent_memory`,
`replay_outcome` → `replay_decision`, etc.).

## Known gap (tracked, not yet wired)

Decizense's client (`agents/src/harness-client.ts`, the per-agent callers, and
`apps/backend/src/services/mcp.service.ts`) does **not** yet send
`case_id`/`request_id`. Until the Phase 2 wiring lands, state-changing calls
against ContextGraph-MCP will be rejected by Zod validation. Options meanwhile:

- run against this repo's legacy embedded `harness/` for demos, or
- complete the Phase 2 client wiring (see backlog).

This repo's embedded `harness/` is legacy once the external server is adopted; it
should be removed after Phase 2 cutover so there is a single source of truth.

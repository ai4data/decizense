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

## Rollout flag: `HARNESS_MODE`

`agents/src/config.ts` exposes `HARNESS_MODE` (`embedded` | `external`, default
`embedded`) and `HARNESS_HTTP_URL`. Both modes use the same HTTP client + URL —
the flag is the dual-run switch and documents which server operators launch
(this repo's in-tree `harness/` vs `..\contextgraph-mcp`). The default stays
`embedded` until the client wiring is proven and a clean shadow run is observed,
then it flips to `external` (see the backlog rollout section).

## Known gap (tracked, not yet wired)

The client wiring is now implemented: `HarnessClient.callTool` injects
`case_id`/`request_id` for correlated tools, the orchestrator binds a
replay-stable per-run `case_id` (and replay-stable request_ids for durable
writes), the standalone agents bind a per-run `case_id`, and the backend injects
per-turn via the AI SDK `experimental_context`. What remains is rollout: run the
shadow suite with `HARNESS_MODE=external`, then flip the default (backlog D2–D3).

Legacy tooling that targets the removed `start_decision_workflow`
(`agents/src/fire-workflow.ts`, `agents/src/test-idempotency.ts`) is broken
against the external server by design and is tracked for removal under backlog
A6. This repo's embedded `harness/` is likewise legacy once the external server
is the default and should be removed after cutover (single source of truth).

# ContextGraph-MCP Phase 2 — Client Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Decizense client send `case_id` and `request_id` on every **correlated** ContextGraph-MCP tool call so Decizense runs end-to-end against the external server (`..\contextgraph-mcp`, tag `v0.1.0-phase1`), then prove and optionally default to external mode.

**Architecture:** IDs are injected by the **client layer**, never by the LLM. `case_id` is one UUID per business case (one orchestrator run, one standalone-agent run, or one backend decision turn), reused across all related tool calls. `request_id` is a fresh UUID per tool call, reused only on explicit retry. Injection happens at two choke points: `HarnessClient.callTool` (agent runtime) and `mcp.service._callTool` (backend LLM tool dispatch). Work proceeds as a vertical slice (orchestrator + one agent) proven by contract tests, then expands, then optionally flips the default mode.

**Terminology:** "Correlated tools" = the tools that require `case_id`/`request_id`. This includes the business-state-changing tools (`write_finding`, `propose_decision`, `approve_decision`, `execute_decision_action`, `execute_action`, `record_outcome`, `save_memory`) **and** `query_data`/`query_metrics`, which are reads but must be correlated for OPA decision-log / audit purposes. The plan uses "correlated", not "state-changing", whenever the query tools are included.

**Tech Stack:** TypeScript, MCP SDK client, `node:crypto` `randomUUID`, existing `agents/src/test-*.ts` tsx runners, ContextGraph-MCP HTTP server on `127.0.0.1:9080`.

**Prerequisites:** ContextGraph-MCP running per `docs/contextgraph-mcp-client-integration.md` (travel Postgres on 5433, OPA on 8181, server on 9080).

---

## Scope Check

This plan is one subsystem: the Decizense → ContextGraph-MCP client correlation wiring (backlog items A1–A5, C1–C2, D1–D2). Explicitly **out of scope** here (own future plans): A6 embedded-harness deletion, A7 client-durability audit, server hardening (backlog B), and the broader legacy test port (C3–C5).

## File Structure

- Modify: `agents/src/harness-client.ts` — add `caseId` + per-call `request_id` injection in `callTool`; typed wrappers inherit it. Single agent-side choke point.
- Modify: `agents/src/workflows/orchestrator.ts` — mint one `caseId` per run; bind to every `HarnessClient`.
- Modify: standalone agent entrypoints (`agents/src/flight-ops.ts`, `agents/src/booking.ts`, `agents/src/customer-service.ts`) — each mints its own `caseId` per run and binds it (they are not always driven by the orchestrator).
- Modify: `apps/backend/src/services/mcp.service.ts` — inject `case_id`/`request_id` in `_callTool` for correlated tools. Single backend choke point.
- Create: `agents/src/correlation.ts` — `CORRELATED_TOOLS` set + `withCorrelation(toolName, args, caseId)` (agent-side).
- Create: `apps/backend/src/services/correlation.ts` — backend-local copy of the same helper. The backend must NOT import from `agents/src`. (A future refactor may hoist this into a real shared package consumed by both workspaces; until that exists, the two small copies are kept byte-identical.)
- Create: `agents/src/test-correlation-unit.ts` — unit contract tests for the helper (no server).
- Create: `agents/src/test-phase2-vertical-slice.ts` — integration: flight_ops against the external server; covers `write_finding` and a `record_outcome` retry (prior-risk path).
- Modify: `agents/src/config.ts` (or nearest config module) — add `HARNESS_MODE` flag (`embedded` | `external`, default `embedded`).
- Modify: `docs/contextgraph-mcp-phase-2-backlog.md` — check off items as completed.

---

## Tasks

### Task 1: Shared correlation helper (A2 foundation)

**Files:**

- Create: `agents/src/correlation.ts`
- Create: `agents/src/test-correlation-unit.ts`

- [ ] **Step 1: Write the failing unit test**

Create `agents/src/test-correlation-unit.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { CORRELATED_TOOLS, withCorrelation } from './correlation.js';

function assert(cond: boolean, label: string): void {
	if (!cond) throw new Error(`FAIL: ${label}`);
}

const caseId = randomUUID();

// Correlated tool: injects case_id + a uuid request_id when absent
const a = withCorrelation('write_finding', { finding: 'x' }, caseId);
assert(a.case_id === caseId, 'write_finding gets case_id');
assert(
	typeof a.request_id === 'string' && (a.request_id as string).length === 36,
	'write_finding gets uuid request_id',
);

// Read-but-correlated tool: also correlated (OPA/audit), not business-state-changing
const q = withCorrelation('query_metrics', { measures: ['flights.delayed_flights'] }, caseId);
assert(q.case_id === caseId && typeof q.request_id === 'string', 'query_metrics is correlated');

// Non-correlated read tool: untouched
const b = withCorrelation('get_entity_details', { entity_id: 'flights' }, caseId);
assert(!('case_id' in b) && !('request_id' in b), 'get_entity_details not correlated');

// Retry: caller-supplied request_id is preserved
const fixed = randomUUID();
const c = withCorrelation('record_outcome', { request_id: fixed, question: 'q' }, caseId);
assert(c.request_id === fixed, 'provided request_id preserved for retry');
assert(c.case_id === caseId, 'record_outcome gets case_id');

assert(!CORRELATED_TOOLS.has('read_findings'), 'read_findings is not correlated');

console.log('✅ correlation helper unit tests pass');
```

- [ ] **Step 2: Run it to verify it fails**

Run:

```powershell
Set-Location agents
npx tsx src/test-correlation-unit.ts
Set-Location ..
```

Expected: FAIL — `Cannot find module './correlation.js'`.

- [ ] **Step 3: Implement the helper**

Create `agents/src/correlation.ts`:

```ts
import { randomUUID } from 'node:crypto';

/**
 * Correlated tools require case_id + request_id (ContextGraph-MCP Phase 1).
 * This includes business-state-changing tools AND query_data/query_metrics,
 * which are reads but must be correlated for OPA decision-log / audit purposes.
 * Pure reads (get_*, read_findings, recall_memory, search_precedent) are excluded.
 */
export const CORRELATED_TOOLS = new Set<string>([
	'query_data',
	'query_metrics',
	'write_finding',
	'propose_decision',
	'approve_decision',
	'execute_decision_action',
	'execute_action',
	'record_outcome',
	'save_memory',
]);

/**
 * Inject case_id (business-case correlation) and a fresh request_id (per-call
 * idempotency) for correlated tools. A caller-supplied request_id is preserved
 * so retries dedupe. Non-correlated tools pass through unchanged.
 */
export function withCorrelation(
	toolName: string,
	args: Record<string, unknown>,
	caseId: string,
): Record<string, unknown> {
	if (!CORRELATED_TOOLS.has(toolName)) return args;
	return {
		...args,
		case_id: args.case_id ?? caseId,
		request_id: args.request_id ?? randomUUID(),
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```powershell
Set-Location agents
npx tsx src/test-correlation-unit.ts
Set-Location ..
```

Expected: `✅ correlation helper unit tests pass`.

- [ ] **Step 5: Commit**

```powershell
git add agents/src/correlation.ts agents/src/test-correlation-unit.ts
git commit -m "feat(agents): add case/request correlation helper"
```

### Task 2: Inject correlation in HarnessClient (A2 agent choke point)

**Files:**

- Modify: `agents/src/harness-client.ts`

- [ ] **Step 1: Add caseId to the client**

In `agents/src/harness-client.ts`, add the import:

```ts
import { withCorrelation } from './correlation.js';
```

Add to the class fields (near `private token: string | undefined;`):

```ts
private caseId: string | null = null;
```

Add a method below the constructor:

```ts
/** Bind the business-case id reused across this client's correlated calls. */
setCaseId(caseId: string): void {
	this.caseId = caseId;
}
```

- [ ] **Step 2: Inject in callTool**

Replace the body of `callTool` so the first line builds correlated args:

```ts
async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
	const finalArgs = this.caseId ? withCorrelation(name, args, this.caseId) : args;
	const result = await this.client.callTool({ name, arguments: finalArgs });
	const content = result.content as Array<{ type: string; text: string }>;
	if (content && content[0] && content[0].text) {
		return JSON.parse(content[0].text);
	}
	return result;
}
```

- [ ] **Step 3: Build the agents workspace**

Run:

```powershell
Set-Location agents
npx tsc --noEmit
Set-Location ..
```

Expected: no type errors. Typed wrappers (`writeFinding`, `queryData`, …) route through `callTool`, so they inherit injection.

- [ ] **Step 4: Commit**

```powershell
git add agents/src/harness-client.ts
git commit -m "feat(agents): inject case/request ids in HarnessClient.callTool"
```

### Task 3: Mint case_id per orchestrator run (A1 — orchestrator scope)

**Files:**

- Modify: `agents/src/workflows/orchestrator.ts`

- [ ] **Step 1: Mint caseId at run start**

In `agents/src/workflows/orchestrator.ts`, add the import and mint one id where `sessionId`/`workflowId` are destructured (≈ line 230):

```ts
import { randomUUID } from 'node:crypto';
// inside the run entry:
const caseId = randomUUID(); // one business case per orchestrator run
```

- [ ] **Step 2: Bind caseId to every HarnessClient**

`runSubagentStep` builds its own client — give it the caseId:

```ts
async function runSubagentStep(
	agentId: string,
	subQuestion: string,
	sessionId: string,
	caseId: string,
): Promise<SubagentResult> {
	const harness = new HarnessClient(agentId, token);
	await harness.connect();
	harness.setCaseId(caseId);
	// ... rest unchanged ...
}
```

After every other `new HarnessClient(...)` + `await harness.connect();` in the orchestrator body (e.g. ≈ line 87), add `harness.setCaseId(caseId);`. Update every `runSubagentStep(agentId, subQuestion, sessionId)` call to pass `caseId`.

- [ ] **Step 3: Build**

Run:

```powershell
Set-Location agents
npx tsc --noEmit
Set-Location ..
```

Expected: no type errors. The compiler flags every `runSubagentStep` call missing the new `caseId` argument — fix each.

- [ ] **Step 4: Commit**

```powershell
git add agents/src/workflows/orchestrator.ts
git commit -m "feat(agents): mint one case_id per orchestrator run"
```

### Task 4: Inject correlation in the backend MCP service (A3 backend choke point)

**Files:**

- Create: `apps/backend/src/services/correlation.ts`
- Modify: `apps/backend/src/services/mcp.service.ts`
- Modify: `apps/backend/src/routes/chat.ts`

- [ ] **Step 1: Create the backend-local helper (no cross-workspace import)**

Create `apps/backend/src/services/correlation.ts` as a byte-identical copy of the agent helper. The backend MUST NOT import from `agents/src`.

```ts
// NOTE: kept byte-identical to agents/src/correlation.ts until a shared package
// exists. Do not import across workspaces.
import { randomUUID } from 'node:crypto';

export const CORRELATED_TOOLS = new Set<string>([
	'query_data',
	'query_metrics',
	'write_finding',
	'propose_decision',
	'approve_decision',
	'execute_decision_action',
	'execute_action',
	'record_outcome',
	'save_memory',
]);

export function withCorrelation(
	toolName: string,
	args: Record<string, unknown>,
	caseId: string,
): Record<string, unknown> {
	if (!CORRELATED_TOOLS.has(toolName)) return args;
	return {
		...args,
		case_id: args.case_id ?? caseId,
		request_id: args.request_id ?? randomUUID(),
	};
}
```

- [ ] **Step 2: Mint a per-turn caseId and thread it in**

In `apps/backend/src/routes/chat.ts`, mint one `caseId` per decision turn with `randomUUID()` (reuse an existing per-turn id if the route already has one — do not mint a second). Pass it into the MCP service method that wraps `_callTool`.

In `apps/backend/src/services/mcp.service.ts`, import the local helper and inject:

```ts
import { withCorrelation } from './correlation.js';
```

```ts
private async _callTool(
	toolName: string,
	toolArgs: Record<string, unknown>,
	caseId: string,
): Promise<unknown> {
	const bareName = removePrefixToolName(toolName);
	const finalArgs = withCorrelation(bareName, toolArgs, caseId);
	const result = await this._runtime.callTool(serverName, bareName, finalArgs);
	// ... rest unchanged ...
}
```

Update the caller at ≈ line 174 to pass `caseId` through.

- [ ] **Step 3: Build backend**

Run:

```powershell
npm run lint -w @dazense/backend
```

Expected: `tsc --noEmit` passes (fix type errors only; eslint style warnings are separate).

- [ ] **Step 4: Commit**

```powershell
git add apps/backend/src/services/correlation.ts apps/backend/src/services/mcp.service.ts apps/backend/src/routes/chat.ts
git commit -m "feat(backend): inject case/request ids on correlated harness tool calls"
```

### Task 5: Vertical-slice contract test (C1 + C2, incl. a prior-risk retry)

**Files:**

- Create: `agents/src/test-phase2-vertical-slice.ts`

- [ ] **Step 1: Write the failing integration test**

Create `agents/src/test-phase2-vertical-slice.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { HarnessClient } from './harness-client.js';

function assert(cond: boolean, label: string): void {
	if (!cond) throw new Error(`FAIL: ${label}`);
}

async function main(): Promise<void> {
	const caseId = randomUUID();
	const sessionId = `slice-${caseId.slice(0, 8)}`;
	const harness = new HarnessClient('flight_ops');
	await harness.connect();
	harness.setCaseId(caseId);
	await harness.initializeAgent(sessionId, 'slice test');

	// 1) write_finding succeeds (server requires case_id + request_id) and echoes ids
	const finding = (await harness.writeFinding(sessionId, 'slice finding', 'high', ['flights'])) as {
		case_id?: string;
		request_id?: string;
		stored?: boolean;
	};
	assert(finding.stored === true, 'finding stored');
	assert(finding.case_id === caseId, 'finding echoes case_id');
	assert(typeof finding.request_id === 'string', 'finding echoes request_id');

	// 2) PRIOR-RISK PATH: record_outcome retry with the same request_id returns the
	//    prior persisted result (goes through the server's withIdempotentTransaction).
	const outcomeReq = randomUUID();
	const outcomeArgs = {
		session_id: sessionId,
		question: 'why are flights delayed?',
		decision_summary: 'weather',
		reasoning: 'storm front',
		confidence: 'high' as const,
		agents_involved: ['flight_ops'],
		request_id: outcomeReq,
	};
	const firstOutcome = (await harness.callTool('record_outcome', { ...outcomeArgs })) as { outcome_id: string };
	const retryOutcome = (await harness.callTool('record_outcome', { ...outcomeArgs })) as { outcome_id: string };
	assert(typeof firstOutcome.outcome_id === 'string', 'first record_outcome returns outcome_id');
	assert(firstOutcome.outcome_id === retryOutcome.outcome_id, 'record_outcome retry returns prior outcome_id');

	await harness.close();
	console.log('✅ phase 2 vertical slice: ids injected; record_outcome retry returns prior result');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
```

- [ ] **Step 2: Run against the external server**

Start ContextGraph-MCP per `docs/contextgraph-mcp-client-integration.md`, then run:

```powershell
Set-Location agents
$env:HARNESS_HTTP_URL='http://127.0.0.1:9080/mcp'
npx tsx src/test-phase2-vertical-slice.ts
Set-Location ..
```

Expected: `✅ phase 2 vertical slice: ids injected; record_outcome retry returns prior result`. If the server is unreachable, document the environment blocker and rerun when available.

- [ ] **Step 3: Commit**

```powershell
git add agents/src/test-phase2-vertical-slice.ts
git commit -m "test(agents): phase 2 vertical-slice contract test (finding + record_outcome retry)"
```

### Task 6: Expand to all call sites + standalone agent case lifecycle (A3 remainder, A4, A5)

**Files:**

- Modify: `agents/src/flight-ops.ts`, `agents/src/booking.ts`, `agents/src/customer-service.ts`
- Modify: any additional correlated call site surfaced by discovery (see Step 1)

- [ ] **Step 1: Enumerate the expected call sites before editing**

Run:

```powershell
git grep -nE "new HarnessClient|setCaseId|callTool\('(propose_decision|approve_decision|execute_decision_action|execute_action|record_outcome|save_memory|query_metrics|query_data|write_finding)'" -- agents apps
```

Expected (confirm before implementing — the list to satisfy):

- `agents/src/flight-ops.ts` — constructs a HarnessClient when run standalone.
- `agents/src/booking.ts` — same.
- `agents/src/customer-service.ts` — same.
- `agents/src/workflows/orchestrator.ts` — already handled in Task 3.
- `agents/src/workflows/deep-agent/tools/finalize.ts` — if it constructs/uses a client.
- `apps/backend/src/services/mcp.service.ts` — already handled in Task 4.

If discovery surfaces a call site not in this list, add it here before editing it.

- [ ] **Step 2: Give each standalone agent its own case lifecycle**

Standalone agents are not always orchestrator-driven, so each must mint and bind its own `caseId` per run. In each of `flight-ops.ts`, `booking.ts`, `customer-service.ts`, at the point a client is created and connected:

```ts
import { randomUUID } from 'node:crypto';
// ...
const harness = new HarnessClient(agentId, token);
await harness.connect();
harness.setCaseId(randomUUID()); // one business case per standalone run
```

Commit only after every enumerated client has `setCaseId(...)` bound.

- [ ] **Step 3: Fix proposal-id UUID assumptions (A4)**

Run:

```powershell
git grep -nE "proposal_id|proposalId" -- agents apps/backend/src
```

For any code that parses `proposal_id` with `parseInt`/`Number(...)` or compares it numerically, treat it as an opaque string (UUID). Show the exact change at each flagged site.

- [ ] **Step 4: Fix save_memory expectations (A5)**

Run:

```powershell
git grep -nE "save_memory|recall_memory" -- agents apps/backend/src
```

Update any code/comment that expected re-saving a key to overwrite in place; the new behavior appends an idempotent `memory_entries` row keyed by `request_id`.

- [ ] **Step 5: Build both workspaces**

```powershell
Set-Location agents; npx tsc --noEmit; Set-Location ..
npm run lint -w @dazense/backend
```

Expected: no type errors.

- [ ] **Step 6: Commit**

```powershell
git add agents apps/backend/src
git commit -m "feat: bind case lifecycle to standalone agents; UUID proposal ids; save_memory semantics"
```

### Task 7: Rollout flag (D1)

**Files:**

- Modify: `agents/src/config.ts` (or the nearest existing config/env module; create it if none)
- Modify: `docs/contextgraph-mcp-phase-2-backlog.md`

- [ ] **Step 1: Add HARNESS_MODE flag**

```ts
export const HARNESS_MODE: 'embedded' | 'external' = process.env.HARNESS_MODE === 'external' ? 'external' : 'embedded';
export const HARNESS_HTTP_URL = process.env.HARNESS_HTTP_URL ?? 'http://127.0.0.1:9080/mcp';
```

Both modes use the same HTTP client; the flag documents/gates which server operators launch (this repo's `harness/` vs `..\contextgraph-mcp`) and is the switch for the dual-run period. Document it in `docs/contextgraph-mcp-client-integration.md`.

- [ ] **Step 2: Tick completed backlog items**

In `docs/contextgraph-mcp-phase-2-backlog.md`, check off A1, A2, A3, A4, A5, C1, C2, D1 as their tasks land.

- [ ] **Step 3: Commit**

```powershell
git add agents/src/config.ts docs/contextgraph-mcp-phase-2-backlog.md docs/contextgraph-mcp-client-integration.md
git commit -m "feat: add HARNESS_MODE rollout flag; update phase 2 backlog"
```

### Task 8: Dual-run verification + optional default flip (D2)

**Files:**

- Modify: dev scripts / run docs as needed. **No deletion of `harness/` in this plan.**

- [ ] **Step 1: Shadow run against external**

With `HARNESS_MODE=external` and the external server running, run the ported no-LLM regressions (`test-correlation-unit.ts`, `test-phase2-vertical-slice.ts`, and any agent regression already pointing at the HTTP server). Record pass/fail. Do NOT change the default yet.

- [ ] **Step 2: Optionally flip the default after a clean shadow period**

Only if Step 1 is green and the operator approves, change the `HARNESS_MODE` default to `'external'`. Commit separately:

```powershell
git commit -am "chore: default HARNESS_MODE=external after clean shadow run"
```

- [ ] **Step 3: Stop here**

Embedded-harness deletion (backlog A6) and the broader legacy-test port (C3–C5) are **out of scope for this plan** and require their own plan once external mode has run in practice. Do not delete `harness/` in this execution.

---

## Self-Review

Spec/backlog coverage:

- A1 case_id lifecycle → Task 3 (orchestrator) + Task 4 (backend) + Task 6 Step 2 (standalone agents).
- A2 request_id per call → Task 1 (helper) + Task 2 (client).
- A3 thread through correlated calls → Tasks 2, 4, 6.
- A4 proposal UUIDs → Task 6 Step 3.
- A5 save_memory semantics → Task 6 Step 4.
- C1 end-to-end happy path + C2 retry returns prior → Task 5 (write_finding + record_outcome retry).
- D1 rollout flag → Task 7; D2 dual-run / optional flip → Task 8.
- Deferred to future plans (explicitly out of scope): A6 delete embedded harness, A7 client-durability audit, B\* hardening, C3–C5 broader tests.

Placeholder scan: every code step shows the code; commands have expected output. No "TBD"/"similar to". The backend helper duplication is intentional and labeled; no cross-workspace import.

Type consistency: `withCorrelation(toolName, args, caseId)` + `CORRELATED_TOOLS` defined identically in Task 1 (agents) and Task 4 (backend). `HarnessClient.setCaseId(caseId)` defined in Task 2; used in Tasks 3, 5, 6. `runSubagentStep(..., caseId)` signature changed once (Task 3) with all call sites updated in the same task.

Known risks: (1) Task 4's per-turn `caseId` must come from the chat route's existing turn context if one already exists — reuse, don't double-mint. (2) Standalone agents minting their own `caseId` (Task 6) means a finding written by a standalone run and one written by an orchestrator run live under different cases by design; that is the intended business-case boundary.

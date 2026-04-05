# Plan v3 — Control Plane Hardening

## Context

Plan v2 (Agent JWT Authentication) closed the LLM identity-spoofing vulnerability and is done. Review feedback from the user's architect identified three real gaps that prevent "enterprise-ready by default":

1. **Determinism** — `orchestrator.ts` has no retry, idempotency, or transaction boundaries. Running the same question twice produces different results. Agent failures cascade with no rollback.
2. **Replayability** — governance is pure in-code; there's no way to re-evaluate a past decision against current policy, no policy versioning, no drift detection.
3. **Delegation** — identity chain stops at the agent. User identity is never cryptographically carried through. Cannot answer "who authorized this decision?" beyond "the agent."

The architect's warning was explicit: **don't expand features (second scenario, UI) before hardening the control plane**. This plan focuses exclusively on hardening — no new scenarios, no new agents.

## Approach

Four phases in strict order. Each phase delivers independently shippable value and builds on the previous. Lightest-weight tool choices at every step. User confirmed all three recommended options: DBOS for determinism, Postgres for decision logs, Zitadel for delegation.

```
Phase 0:  OpenTelemetry tracing              (~3 days — debugging foundation)
Phase 1a: Topology change (stdio → HTTP)     (~1 week — prerequisite for DBOS)
Phase 1b: Determinism via DBOS               (~1-2 weeks — orchestration reliability)
Phase 2:  Replayability via OPA              (~1-2 weeks — policy as code + decision logs)
Phase 3:  Delegation via Zitadel + act claim (~few days — user→agent chain)
```

> **Revision 1** (post-architect-review): Phase 1 was split into 1a (topology) + 1b (DBOS) because the original "child-per-connection over stdio" model is incompatible with durable workflows. See "Review Revisions" section below for the full list of fixes applied to this plan.

**Tools selected** (all open-source, all verified current as of 2026):

| Tool                   | Version | License                     | Why                                                                                                                             |
| ---------------------- | ------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **OpenTelemetry Node** | latest  | Apache 2.0                  | Industry standard, GenAI semantic conventions now first-class                                                                   |
| **DBOS Transact TS**   | 4.13.5  | MIT                         | Postgres-native durable execution. No new infra. Annotate existing functions. ~10x less code change than Temporal for our scale |
| **OPA**                | 1.4.2   | Apache 2.0 (CNCF graduated) | Policy as code, native decision logs, bundle signing. Sidecar on localhost:8181                                                 |
| **Zitadel**            | latest  | Apache 2.0                  | Native RFC 8693 Token Exchange with `act` claim. Docker-compose ready                                                           |

**Rejected alternatives** (documented here so we don't re-litigate):

- Temporal — correct tool but heavier than needed for 200 LOC today. Escalate later if DBOS hits limits.
- Restate — BSL 1.1 server license, not worth the license risk for the incremental benefit
- Ory Hydra — RFC 8693 support is incomplete/buggy; community relies on unmaintained third-party npm package (`@apeleghq/hydra-rfc8693`) — supply chain red flag
- Cedar — narrower than Rego, no decision log story outside AWS
- Raw event sourcing — "rebuild 60% of these tools at 3x the cost"

---

## Phase 0: OpenTelemetry (foundation, ~3 days)

**Why first:** Without distributed tracing, debugging the changes in Phases 1-3 is guesswork. OTel is the lowest-friction addition and unblocks everything else.

### What changes

**New file** `harness/src/observability/tracing.ts`:

- Initialize OTel SDK at harness startup
- Export to local OTLP collector (or Jaeger for dev)
- GenAI semantic conventions: `gen_ai.agent.id`, `gen_ai.request.model`, `gen_ai.usage.*`
- Custom dazense attributes: `dazense.governance.allowed`, `dazense.governance.contract_id`, `dazense.auth.method`, `dazense.sql.hash`

**Modify** `harness/src/server.ts`:

- Initialize tracing before any other setup
- Wrap the MCP server to create a span per tool call

**Modify** `harness/src/tools/action.ts`, `persist.ts`, `control.ts`:

- Wrap tool handlers with `tracer.startActiveSpan()`
- Set attributes from AuthContext (agent_id, auth_method)
- Set governance outcome as span attribute

**Modify** `agents/src/harness-client.ts`:

- Propagate `traceparent` from agent process to harness child process via env var
- Each tool call becomes a child span of the agent session

**New file** `docker/docker-compose.observability.yml`:

- Jaeger all-in-one for local dev (UI on `:16686`)
- OR Grafana + Tempo stack
- Wire OTLP endpoint into harness via env

### Verification

```bash
docker compose -f docker/docker-compose.observability.yml up -d
AUTH_MODE=config-only npx tsx agents/src/test-auth.ts
# Open http://localhost:16686 — see full trace: agent → harness → governance → pg
```

---

## Phase 1a: Topology change — stdio → long-lived HTTP (~1 week)

**Why this is a prerequisite:** DBOS workflows must live in a long-lived process. Today's harness is a child process spawned per agent connection via MCP stdio — it dies on disconnect, so there is nowhere durable for a workflow to live. Before DBOS can exist, the harness must become a long-lived server.

### Scope

Convert harness from "child-per-connection over stdio" to a single long-lived process using MCP's official **Streamable HTTP** transport. Agents connect over HTTP+SSE. Identity and session state move from process-global to per-connection.

### What changes

**Modify** `harness/src/server.ts`:

- Replace `StdioServerTransport` with `StreamableHTTPServerTransport`
- Bind to `HARNESS_HTTP_PORT` (default 9080)
- Start once, stay alive, handle N concurrent connections

**Modify** `harness/src/auth/context.ts` — per-connection AuthContext:

- Replace the module-level `context: AuthContext | null` singleton with a `Map<sessionId, AuthContext>` keyed by MCP session ID
- `getAuthContext()` takes a `sessionId` argument (from MCP request metadata)
- Add TTL (1 hour default) and automatic cleanup on disconnect
- Disconnect hook tears down the entry
- New function `getCurrentAuthContext()` resolves session ID from MCP request context

**Modify** every tool handler (`action.ts`, `persist.ts`, `verify.ts`, `context.ts`, `control.ts`):

- `getAuthContext()` → `getCurrentAuthContext()` (session-scoped)
- No other behavior change

**Modify** `agents/src/harness-client.ts`:

- Replace `StdioClientTransport` with `StreamableHTTPClientTransport`
- Connect to `HARNESS_HTTP_URL` (default `http://localhost:9080/mcp`)
- Pass identity via HTTP headers: `X-Agent-Id`, `Authorization: Bearer <AGENT_TOKEN>`
- Harness extracts these on connection init and builds the per-session AuthContext

**Modify** `docker-compose.yml` (or new file):

- Harness runs as a service with the HTTP port exposed
- Postgres dependency already exists

### Verification

**1. Concurrency test** — 2 agents connected simultaneously MUST never share identity state:

```bash
# Terminal 1
AGENT_ID=flight_ops npx tsx agents/src/flight-ops.ts "list delays"

# Terminal 2 (simultaneously)
AGENT_ID=booking npx tsx agents/src/booking.ts "list bookings"

# Expected: both succeed with their own identity
# Audit trail shows 2 distinct agent_ids, never cross-contaminated
```

**2. Session lifecycle test** — disconnect cleanup:

```bash
# Connect, query, disconnect
# Verify: AuthContext map size drops back by 1
# Verify: TTL expiry removes stale sessions after 1h
```

**3. Plan v2 regression** — `test-query.ts` and `test-auth.ts` still pass (in `config-only` and `jwt` modes).

---

## Phase 1b: Determinism via DBOS (~1-2 weeks)

**Why DBOS:** Postgres-native durable execution. We already have Postgres. DBOS annotates existing TypeScript functions — no workflow DSL, no separate worker process, no new deployment target. If we outgrow DBOS, we can migrate to Temporal later with the workflow shape already in place.

### Scope

The durable unit is the **decision session**: one user question → orchestrator runs → sub-agents run → findings combined → outcome recorded. Everything between `initialize_agent` and `record_outcome` must be resumable.

### Canonical workflow_id rule (authoritative — referenced everywhere else)

> **The caller provides `workflow_id` explicitly. If absent, the harness derives it as `sha256(caller_subject + question)[0:32]`. `session_id` is derived from `workflow_id` (first 16 chars + short suffix for human readability), not the other way around.**
>
> **Day boundaries:** idempotency is **permanent** across day boundaries. No `date_bucket` in the hash. Rationale: if the same user asks the same question in January and again in July, the July call should NOT silently replay the January outcome — callers who want a fresh answer provide a fresh `workflow_id`. If callers want cross-day replay they reuse the same `workflow_id`. The decision is theirs, not the harness's.

### What changes

**Modify** `harness/package.json`:

- Add `@dbos-inc/dbos-sdk`

**New file** `harness/src/workflows/decision.ts`:

- `@Workflow()` decorator on the top-level decision orchestration
- `@Transaction()` on DB state transitions (propose → approve → execute)
- `@Step()` on non-deterministic work (LLM calls, SQL queries, HTTP to OMD)
- Workflow ID resolved per the canonical rule above

**New file** `harness/src/workflows/agent-invoke.ts`:

- One workflow per domain agent call
- Retry policy: exponential backoff, max 3 attempts, skip on governance rejection
- Timeout: 60s per agent call
- Compensating transaction on failure (mark findings as invalidated)

**Modify** `agents/src/orchestrator.ts`:

- Remove `SESSION_ID = session-${Date.now()}`
- Accept `workflow_id` as an optional CLI arg; derive if absent
- Submit work via the harness HTTP API → DBOS starts the workflow inside the harness process
- Poll for completion via the harness HTTP API

**Modify** `harness/src/tools/persist.ts`:

- `propose_decision`, `approve_decision`, `execute_decision_action` become `@Transaction` methods
- Add idempotency_key column usage (see schema changes below)

### Determinism boundary (what DBOS does NOT guarantee)

DBOS guarantees **execution determinism** — once a workflow starts, its control flow is resumable and its step results are replayed from the database. DBOS does **NOT** guarantee **identical LLM text output** across runs. Two workflow instances with the same input can still produce different LLM strings.

To stabilize LLM output on top of DBOS, we add these controls (in Phase 1b scope):

- **Fixed model pin** — LLM calls include explicit `model=gpt-4o-2024-08-06` (or equivalent), never "latest"
- **Temperature policy** — default `temperature=0` for decision-critical calls; temperature > 0 is opt-in per call site
- **Prompt version tag** — every system prompt carries a `prompt_version` string recorded in the audit trail
- **Optional response caching** — a hash of `(model, prompt_version, user_input, temperature)` maps to a cached response; opt-in per workflow via `cache_llm_output: true`

These are **not** idempotency — they're reproducibility aids. A cached response plus a deterministic workflow plus a pinned model is how you get two runs to produce the same text. Without all three, you get resumable execution with possibly-different text, which is still a huge improvement over today but not text-identical.

**Schema changes** (via migration SQL):

```sql
ALTER TABLE decision_proposals
  ADD COLUMN idempotency_key VARCHAR(100) UNIQUE,
  ADD COLUMN workflow_id VARCHAR(100),
  ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();

ALTER TABLE decision_actions
  ADD COLUMN idempotency_key VARCHAR(100) UNIQUE,
  ADD COLUMN workflow_id VARCHAR(100);

ALTER TABLE decision_outcomes
  ADD COLUMN workflow_id VARCHAR(100),
  ADD COLUMN parent_workflow_id VARCHAR(100),
  ADD COLUMN bundle_revision VARCHAR(100),       -- FIX 3: for audit queries
  ADD COLUMN prompt_version VARCHAR(50),         -- for LLM reproducibility
  ADD COLUMN model_version VARCHAR(100);         -- for LLM reproducibility

-- Link table between our proposals and DBOS's workflow runs
CREATE TABLE decision_workflow_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id VARCHAR(100) NOT NULL,
  session_id VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0
);
```

### Verification

**1. Idempotency test** — same workflow_id, two invocations, one outcome:

```bash
WORKFLOW_ID=test-idempotency-001 npx tsx agents/src/orchestrator.ts "Will I miss my connection?"
WORKFLOW_ID=test-idempotency-001 npx tsx agents/src/orchestrator.ts "Will I miss my connection?"
# Expected: only ONE outcome in decision_outcomes; second run returns cached result
```

**2. Failure recovery test** — kill harness mid-orchestration, restart, verify resume.

**3. Retry test** — stop postgres for 30s mid-query; DBOS retries; workflow completes after DB recovers.

**4. Reproducibility test** (new) — run twice with cache enabled + temperature=0 + pinned model + same prompt_version; assert identical outcome text.

---

## Phase 2: Replayability via OPA (~1-2 weeks)

**Why OPA:** CNCF graduated, Apache 2.0, purpose-built for this. Native decision logs capture every policy decision with inputs + outputs + bundle revision. Bundle signing supports policy-as-code pipelines.

### Scope

Externalize the governance pipeline from `harness/src/governance/index.ts` to Rego. Every governance decision is logged via OPA's HTTP decision log sink to an internal harness endpoint that writes to Postgres. Build a `replay_outcome` admin tool that runs against an **isolated replay OPA instance**, never the live enforcement instance.

### What changes

**New directory** `policy/`:

- `policy/dazense.rego` — all governance rules as Rego
- `policy/data.json` — bundle-static data (PII columns, bundle definitions, business rules) — **frozen at build time, not fetched live** (this is essential for replay — catalog state at decision time must be captured in the bundle)
- `policy/.manifest` — bundle manifest for versioning
- `policy/build.sh` — builds signed bundle with `opa build --signing-key ...`

**Example Rego structure** (`policy/dazense.rego`):

```rego
package dazense.governance

# Input shape:
#   { agent_id, sql, parsed_tables, parsed_columns, bundle, pii_columns }

default allow := false

allow if {
    count(violations) == 0
}

violations contains v if {
    not input.agent_id in data.agents
    v := {"check": "authenticate", "detail": "unknown agent"}
}

violations contains v if {
    table := input.parsed_tables[_]
    not table in data.bundles[input.bundle].allowed_tables
    v := {"check": "bundle_scope", "detail": sprintf("%v out of scope", [table])}
}

# ... one rule per existing check in governance/index.ts
```

**New file** `harness/src/governance/opa-client.ts`:

- HTTP client to `localhost:8181` (enforcement OPA sidecar)
- `evaluate(input)` → POSTs to `/v1/data/dazense/governance/allow`
- Bundle version captured from response
- Keep `parseSql()` in TS — only rule evaluation moves to OPA

**Modify** `harness/src/governance/index.ts`:

- `evaluateGovernance()` shrinks to: parse SQL → build input → POST to OPA → shape response
- Keep AuthContext defense-in-depth at the top
- Result includes `bundle_revision` from OPA response

### OPA decision log ingestion — single canonical path

> **OPA has no native Postgres sink.** The only supported sinks are console, HTTP, and custom Go plugins. We pick HTTP as the single path and route it to an internal endpoint on the harness HTTP server (which exists after Phase 1a).

Flow:

```
OPA enforcement sidecar
  ─ decision_logs config: HTTP sink
  → POST http://localhost:9080/_internal/opa-log
    (X-Internal-Secret: <shared-secret>, X-Timestamp: <unix-ms>, X-Nonce: <uuid>)
       → harness ingester route
         → anti-forgery checks
         → INSERT INTO decision_logs
```

**New route** `harness/src/server.ts` → `POST /_internal/opa-log`:

- Localhost-only binding check (reject external IPs)
- Shared secret via `X-Internal-Secret` header, compared with `process.env.OPA_LOG_SHARED_SECRET` using constant-time comparison
- **Anti-forgery controls**:
    - **Timestamp window**: reject if `X-Timestamp` is more than 60 seconds old or more than 5 seconds in the future
    - **Nonce replay check**: in-memory LRU cache of last 10k nonces; reject duplicates
    - **Body size cap**: max 1 MB per decision log batch
- Parse the NDJSON decision log body and `INSERT INTO decision_logs`

**New table** (migration):

```sql
CREATE TABLE decision_logs (
  decision_id VARCHAR(100) PRIMARY KEY,
  bundle_revision VARCHAR(100) NOT NULL,
  timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  input JSONB NOT NULL,
  result JSONB NOT NULL,
  agent_id VARCHAR(50),
  session_id VARCHAR(100),
  contract_id VARCHAR(100),
  tool_name VARCHAR(50)
);

CREATE INDEX idx_decision_logs_session ON decision_logs(session_id);
CREATE INDEX idx_decision_logs_bundle ON decision_logs(bundle_revision);
CREATE INDEX idx_decision_logs_timestamp ON decision_logs(timestamp);
```

### Replay isolation (no shell, no live-OPA bundle swaps)

> **Live enforcement OPA MUST NEVER have its bundle swapped for a replay.** Hot-swapping the bundle on the enforcement instance would change policy for all in-flight production requests. Replays run against a **second, dedicated OPA instance**.

Architecture:

```
Enforcement OPA   (port 8181)   — pinned to current prod bundle, handles live requests
Replay OPA        (port 8281)   — bundle swappable, used only by replay_outcome admin tool
```

**New file** `docker/docker-compose.opa.yml`:

- Two OPA services: `opa-enforce` (port 8181) and `opa-replay` (port 8281)
- Enforcement: bundle mounted read-only, no management API exposed
- Replay: bundle management API enabled, only reachable from the harness process

**New admin tool** `harness/src/tools/admin.ts` — `replay_outcome`:

```typescript
// NO shell, NO user-controlled paths.
// `bundle_tag` is validated server-side against a whitelist from OPA's bundle registry.
server.tool(
	'replay_outcome',
	'Re-evaluate a past decision against a tagged policy bundle',
	{
		decision_id: z.string(),
		bundle_tag: z.enum(['current', 'staging', 'previous']).optional().default('current'),
	},
	async ({ decision_id, bundle_tag }) => {
		// 1. Fetch decision log row from decision_logs (includes original input JSONB)
		// 2. Validate bundle_tag against whitelist (already enforced by z.enum)
		// 3. If needed, instruct replay OPA to switch to the tagged bundle (via its management API)
		// 4. POST to replay OPA: http://localhost:8281/v1/data/dazense/governance/allow
		//    with { input: <original_input> }
		// 5. Diff original result vs replayed result
		// 6. Return { original, replayed, diff, policy_changed: boolean, bundle_tag }
	},
);
```

No `child_process`, no `exec`, no user-supplied paths. The only user input is a `decision_id` (validated against the DB) and a `bundle_tag` (validated against a closed enum).

**New admin tool** — `policy_drift_report`:

```typescript
// Replays N random recent decisions against a specified tagged bundle on the replay OPA.
// Reports how many would now be blocked/allowed differently.
// Output: { total: N, changed: M, examples: [...], bundle_tag }
```

### Verification

**1. Policy migration equivalence test** — 100 queries from `test-query.ts` run through BOTH old in-code governance AND new OPA enforcement; results must match.

**2. Replay test** — make a query, record `decision_id`, update policy bundle to "staging" tag with stricter PII rules, run `replay_outcome(decision_id, 'staging')`, verify diff shows the flip.

**3. Replay isolation test** — while replay is running a bundle swap on port 8281, verify that enforcement OPA on port 8181 is unaffected and still evaluates queries against the original bundle.

**4. Bundle signing test** — `opa build` with a key, enforcement OPA loads only signed bundles, unsigned bundle is rejected.

**5. Anti-forgery test** — fire decision-log POSTs to `/_internal/opa-log` with:

- missing shared secret → rejected
- wrong shared secret → rejected
- stale timestamp (>60s old) → rejected
- duplicate nonce → rejected
- oversized body (>1 MB) → rejected
- valid payload → accepted and inserted

**6. Decision log completeness** — every governance check produces a row in `decision_logs` with `bundle_revision`.

---

## Phase 3: Delegation via Zitadel + act claim (~few days)

**Why Zitadel:** Apache 2.0, native RFC 8693 Token Exchange support with the `act` claim for delegation AND impersonation. Docker-compose-ready. Half a day of TS changes once the claim-contract is nailed down — the bulk is IdP setup and claim shape validation.

### Claim Contract (authoritative — coded, tested, and documented)

> **Before writing any TS**, we produce a real Zitadel token via the actual token exchange flow and document its exact decoded shape. This becomes a fixture committed to the repo. The TS mapping logic is written against that fixture, and a unit test loads it to prevent regression.

**New file** `docs/delegation-claim-contract.md` — contains:

- A real decoded Zitadel access token (JWT payload) from a service-user direct flow (no delegation)
- A real decoded Zitadel access token from a token-exchange delegation flow (alice → ops-agent)
- The exact mapping precedence the harness uses to resolve `agent_id` and `delegatedSubject`
- Example for each claim the harness reads: `sub`, `act.sub`, `azp`, `client_id`, custom metadata claims

**Mapping precedence** (written as code-like rules):

```
IF token has `act` claim:
    delegatedSubject = token.sub            # the end user (alice)
    agentClaim = token.act.sub              # actor is the agent
    tokenKind = "delegated"
ELSE IF token has `azp` claim AND config.agent_claim is unset:
    agentClaim = token.azp                  # Zitadel direct service-user token
    delegatedSubject = null
    tokenKind = "direct-service-user"
ELSE:
    agentClaim = token.sub                  # fallback (our Plan v2 path: OMD bot tokens)
    delegatedSubject = null
    tokenKind = "direct"

agent_id = resolveAgentIdFromClaim(agentClaim)
    where resolveAgentIdFromClaim looks up agents.yml:
      agents[*].identity.catalog_bot == agentClaim
      OR agents[*].identity.zitadel_client_id == agentClaim  (NEW in Phase 3)

IF agent_id is null → reject token with a clear error
```

If any of this is wrong against real Zitadel output, we fix the claim contract doc and the mapping logic, then re-test. **No guessing, no "it'll probably work".**

**New fixture file** `harness/test/fixtures/zitadel-token-delegated.json`:

- Real decoded JWT payload captured from an actual Zitadel token exchange against our dev instance
- Used by unit tests in `harness/test/auth/delegation.test.ts` to prevent future regression

### Scope

User logs into Zitadel → gets an access token. The backend performs RFC 8693 Token Exchange to obtain a token with the actor claim set. The harness verifies the delegation chain per the claim contract above and records both identities in the audit trail.

### What changes

**New file** `docker/docker-compose.zitadel.yml`:

- Zitadel container + Postgres
- Pre-seeded with: dazense project, ops-agent/booking-agent/customer-agent service users, test user "alice"
- Token exchange enabled in project settings

**New file** `scripts/capture-zitadel-fixtures.ts`:

- Runs against the local Zitadel
- Performs a direct service-user token request → saves to `harness/test/fixtures/zitadel-token-direct.json`
- Performs a token exchange flow → saves to `harness/test/fixtures/zitadel-token-delegated.json`
- Run once during Phase 3 setup, fixtures committed to the repo

**Modify** `harness/src/config/index.ts` — extend `AuthConfig`:

```typescript
interface AuthConfig {
	// ... existing fields ...
	agent_claim?: string; // NEW — JSONPath or dot-path to the claim holding agent identity
	//       examples: "sub", "azp", "act.sub", "urn:dazense:agent_id"
	require_delegation?: boolean; // NEW — when true, reject tokens WITHOUT an `act` claim
}
```

**Modify** `scenario/travel/scenario.yml` — add the new fields to the auth section:

```yaml
auth:
    mode: "{{ env('AUTH_MODE', 'config-only') }}"
    trust_domain: dazense.local
    verify_strategy: shared_secret
    jwt_secret: "{{ env('JWT_SECRET') }}"
    audience: dazense-harness
    agent_claim: 'sub' # NEW — default, overridden per-IdP
    require_delegation: false # NEW — default, true for Phase 3 end-to-end
```

**Modify** `harness/src/auth/verify.ts`:

- Extend `VerifyResult` interface:
    ```typescript
    interface VerifyResult {
    	valid: boolean;
    	sub?: string;
    	iss?: string;
    	aud?: string;
    	exp?: number;
    	azp?: string; // NEW — OAuth authorized party (Zitadel direct service-user flow)
    	act?: { sub: string; iss?: string }; // NEW — actor claim (delegation)
    	raw?: Record<string, unknown>; // NEW — full decoded payload for custom claim extraction
    	error?: string;
    }
    ```
- All three verifier strategies pass the new fields through

**Modify** `harness/src/auth/context.ts` — extend `AuthContext` and apply the claim contract:

```typescript
interface AuthContext {
	// ... existing fields ...
	delegatedSubject: string | null; // NEW — end user when token is delegated
	delegationIssuer: string | null; // NEW — iss of the actor's original token
	tokenKind: 'direct' | 'direct-service-user' | 'delegated'; // NEW
}
```

- `resolveAuthContext()` implements the mapping precedence from the Claim Contract
- Reject tokens that don't satisfy `require_delegation` setting

**Modify** `harness/src/tools/control.ts`:

- `initialize_agent` returns `delegated_subject` and `token_kind` in the identity block
- Log full chain: "agent=ops-agent acting as user=alice (kind=delegated)"

**Schema changes**:

```sql
ALTER TABLE decision_findings ADD COLUMN delegated_subject VARCHAR(100);
ALTER TABLE decision_proposals ADD COLUMN delegated_subject VARCHAR(100);
ALTER TABLE decision_outcomes ADD COLUMN delegated_subject VARCHAR(100);
ALTER TABLE decision_logs ADD COLUMN delegated_subject VARCHAR(100);
```

**Modify** `harness/src/tools/persist.ts`:

- All audit writes include `delegatedSubject` from AuthContext
- Query by user: "show me all decisions alice authorized through any agent"

**New file** `scripts/test-delegation.ts`:

- Logs in as alice via Zitadel
- Performs RFC 8693 token exchange for an agent token
- Connects to harness with the exchanged token
- Verifies the audit trail shows both subjects

### Verification

**1. Fixture-driven unit test** — `harness/test/auth/delegation.test.ts` loads the committed fixtures and asserts the mapping produces the expected `agentId` + `delegatedSubject`. Catches any future claim-shape drift from Zitadel upgrades.

**2. Token exchange flow test** — full round trip from user login → token exchange → delegated agent call → audit row with both subjects.

**3. Missing-act rejection test** — with `require_delegation: true`, a plain service-user token (no `act`) is rejected.

**4. Audit query test** — `SELECT * FROM decision_findings WHERE delegated_subject = 'alice'` returns only alice's decisions regardless of which agent ran them.

**5. Compliance evidence test** — given a user complaint, generate a report of every decision made on their behalf in a date range, with `agent_id`, `token_hash`, `bundle_revision`, and outcome.

---

## Review Revisions (applied after architect review)

The first draft of this plan was reviewed by the user's architect. Seven findings were raised (2 critical, 3 high, 2 medium) plus 6 guardrails. All are addressed in the current plan text. This section summarizes the fixes so future readers understand why certain sections look the way they do.

### Findings resolved

| #   | Severity | Finding                                                                                                                           | Resolution                                                                                                                                                                                                                                                                         |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Critical | DBOS workflow placement conflicts with child-per-connection stdio topology                                                        | Phase 1 split into **1a (topology: stdio → MCP Streamable HTTP)** + **1b (DBOS)**. Harness becomes long-lived HTTP server; AuthContext becomes per-session map keyed by MCP session ID.                                                                                            |
| 2   | Critical | `replay_outcome` proposed shelling to `opa eval` with user-provided path (command injection)                                      | No shell, no user paths. `replay_outcome` uses OPA HTTP API against a **dedicated replay OPA instance on port 8281**. `bundle_tag` is a closed enum (`current` / `staging` / `previous`), never a free-form path.                                                                  |
| 3   | High     | Verification query referenced `bundle_revision` on `decision_outcomes`, but schema only added it to `decision_logs`               | `bundle_revision` column added to `decision_outcomes` in Phase 1b schema changes.                                                                                                                                                                                                  |
| 4   | High     | Two inconsistent OPA log ingestion paths ("Postgres sink" vs "HTTP + ingester script")                                            | Single canonical path: **OPA HTTP sink → harness `/_internal/opa-log` route → INSERT into `decision_logs`**. OPA has no native Postgres sink; the earlier language was wrong.                                                                                                      |
| 5   | High     | Delegation token mapping assumed `sub=ops-agent`, but Zitadel puts the end user in `sub` and actor in `act.sub` / client in `azp` | Full **Claim Contract** section in Phase 3: real Zitadel fixtures committed to `harness/test/fixtures/`, explicit mapping precedence in code, `agent_claim` config field for per-IdP overrides, fixture-driven unit test prevents regression.                                      |
| 6   | Medium   | Conflicting workflow_id rules (hash of session_id+question, WORKFLOW_ID env, `Date.now()` session)                                | **Canonical rule** in Phase 1b: caller provides `workflow_id`; if absent, derive as `sha256(caller_subject + question)[0:32]`; `session_id` derives from `workflow_id`, not the other way around. **No `date_bucket`** — idempotency is permanent across day boundaries by design. |
| 7   | Medium   | `require_delegation` referenced but not in AuthConfig type or scenario.yml                                                        | Added to `AuthConfig` interface and `scenario/travel/scenario.yml` example in Phase 3 change list.                                                                                                                                                                                 |

### Guardrails added (architect's conditions for approval)

1. **Per-session AuthContext lifecycle** — Phase 1a binds AuthContext to MCP session/connection ID with TTL (1h default) and disconnect cleanup. Concurrency test: 2 agents connected simultaneously must never share identity state.

2. **Determinism boundary clarified** — Phase 1b explicitly states DBOS gives **execution determinism**, not identical LLM text output. Added reproducibility controls: fixed model pin, temperature=0 default for decision-critical calls, `prompt_version` tag stored in audit trail, optional response caching keyed on `(model, prompt_version, input, temperature)`.

3. **Workflow ID day-boundary behavior documented** — the canonical rule explicitly states idempotency is permanent across days. Callers who want a fresh answer must provide a fresh `workflow_id`; callers who want permanent replay reuse the same id. The decision belongs to the caller, not the harness.

4. **Replay isolation enforced** — Phase 2 introduces a **second OPA instance on port 8281** dedicated to replay. Live enforcement OPA on 8181 is pinned to its prod bundle and never has it swapped by `replay_outcome`. Architecture doc shows both instances.

5. **OPA log ingestion hardened** — localhost-bound endpoint, shared secret (`X-Internal-Secret`), constant-time comparison, timestamp window (±60s past / +5s future), nonce replay cache (LRU 10k), body size cap (1 MB). Anti-forgery test matrix in Phase 2 verification.

6. **Delegation Claim Contract formalized** — `docs/delegation-claim-contract.md` captures real decoded Zitadel tokens (direct and delegated flows). Fixtures committed under `harness/test/fixtures/`. `delegation.test.ts` loads the fixtures and asserts mapping correctness. Any future Zitadel upgrade that changes claim shape will fail this test before it breaks production auth.

---

## Assumptions (callout for future-me)

These were explicitly chosen during planning — revisit if any change:

1. **Decision logs in Postgres** — reuses travel_db. If moving to Fabric/ADX later, add an ingestion job.
2. **Zitadel as IdP, greenfield** — if Entra ID enters the picture, Zitadel becomes a broker (adds a hop but design is the same).
3. **Rego bundle lives inside dazense-context-infrastructure** — `policy/` directory. If bundle needs to ship independently, split into a sibling repo later.
4. **DBOS as the durable execution layer** — if it hits limits (polyglot workers, HITL patterns, many workflow types), migrate to Temporal. The workflow shape will carry over.
5. **Harness is a long-lived HTTP process after Phase 1a** — no more stdio child processes. Plan v2 stdio support may still be preserved behind a mode flag if needed for simple CLI tools.

## Cross-phase invariants

- **No Plan v2 regressions** — every existing test in `test-query.ts` and `test-auth.ts` still passes at every phase boundary
- **Backward compatibility** — `config-only` auth mode still works throughout
- **Scenario agnosticism** — nothing in Plans v1-v3 is travel-specific; a second scenario (banking) added later should work without code changes
- **Open-source license hygiene** — no BSL, no AGPL server components in the hot path. All tools in this plan are Apache 2.0 or MIT.

## What this plan explicitly does NOT include

To protect against scope creep and per the architect's warning:

- **No second scenario** (banking/NPLO) — validation material only, not part of hardening
- **No chat UI improvements** — frontend polish is a separate effort
- **No per-agent Postgres roles / RLS** — remains a single shared admin credential. True zero-trust DB access is a future plan.
- **No SPIRE/SPIFFE workload attestation** — overkill until multiple trust domains exist
- **No model-specific prompting improvements** — correctness is the issue, not prompt quality

## Verification (end-to-end, after all phases)

The full "enterprise-ready" smoke test:

```bash
# 1. Start infra
docker compose up -d  # postgres, openmetadata, jaeger, opa, zitadel

# 2. Build and sign policy bundle
cd policy && ./build.sh

# 3. User login via Zitadel, token exchange for agent
TOKEN=$(scripts/zitadel-exchange.sh alice ops-agent)

# 4. Run orchestrator with delegation + durable execution
AUTH_MODE=jwt AGENT_TOKEN=$TOKEN npx tsx agents/src/orchestrator.ts "Will I miss my connection?"

# 5. Verify in Jaeger: full trace with spans for every tool call
open http://localhost:16686

# 6. Verify audit trail
psql -c "SELECT outcome_id, delegated_subject, auth_method, bundle_revision FROM decision_outcomes ORDER BY created_at DESC LIMIT 1"
# Expected: delegated_subject='alice', auth_method='jwt', bundle_revision='<sha>'

# 7. Idempotency: re-run with same WORKFLOW_ID → same outcome_id
# 8. Replay: modify policy, run replay_outcome on last decision → diff showing policy drift
# 9. Drift report: policy_drift_report over last 100 decisions
```

## Success criteria

Plan v3 is done when:

1. **Determinism**: rerunning an orchestrator with the same workflow_id produces the same outcome_id. Failures resume from checkpoints.
2. **Replayability**: given any past decision_id, we can produce a diff against current policy and flag drift.
3. **Delegation**: every audit row answers "who is the agent?" AND "who authorized it?" with a verifiable token chain.
4. **Observability**: a full end-to-end trace exists for every decision from user request to outcome.
5. **No regressions**: all Plan v1/v2 tests still pass.

Once these are all green, the control plane is genuinely enterprise-ready — and a second scenario becomes the right next move.

# ContextGraph-MCP — Phase 2 Backlog

Phase 1 is locked (`..\contextgraph-mcp`, tag `v0.1.0-phase1`, reviewer PASS).
This backlog covers consuming it from Decizense, hardening the server, broader
tests, and rollout. Items are scoped, not yet planned in detail — each larger
item should get its own spec/plan before implementation.

## A. Decizense client wiring (the blocking work)

The Phase 1 contract made `case_id`/`request_id` required on state-changing
tools. The Decizense client must supply them.

- [x] **A1. Case lifecycle.** Mint one `case_id` per chat/decision session;
      thread it through the orchestrator and sub-agents. Decide ownership: backend
      (`apps/backend/src/services/mcp.service.ts`) vs agent runtime (`agents/`).
- [x] **A2. request_id per call.** Generate a fresh UUID per tool invocation in
      `agents/src/harness-client.ts`; reuse only on explicit retry.
- [x] **A3. Update callers.** Pass `case_id`/`request_id` from every state-
      changing call site: `agents/src/{flight-ops,booking,customer-service,
orchestrator}.ts`, deep-agent tools, and `apps/backend/src/agents/tools/`.
- [x] **A4. Proposal IDs are UUIDs.** (no-op in scope — no in-scope code assumes integer proposal_id; only legacy removed-tool tests, deferred to A6) Update any integer assumptions in agent
      code/tests that handle `proposal_id`.
- [x] **A5. save_memory semantics.** (no-op in scope — no save_memory callers in wired paths) Adjust callers that relied on
      upsert-by-key; new behavior appends idempotent `memory_entries` rows.
- [ ] **A6. Retire embedded harness.** After cutover, delete this repo's
      `harness/` and point all tooling/scripts at `..\contextgraph-mcp`.
      **Legacy removed-tool cleanup (track here so they aren't forgotten):**
      `agents/src/fire-workflow.ts` and `agents/src/test-idempotency.ts` both call
      the removed `start_decision_workflow` tool and are broken against the
      external server — delete or rewrite them during A6. (Also why A4's integer
      `proposal_id` ref is out of scope: it lives in `test-idempotency.ts`.)
- [ ] **A7. Client-side workflow durability.** Decizense agents keep their own
      durability (DBOS-on-agent-side already present in `agents/src/workflows/`);
      confirm it no longer assumes server-side workflow tools.

## B. Server hardening (Phase 3, in contextgraph-mcp)

- [ ] **B1.** Installation + scenario-pack + adapter docs.
- [ ] **B2.** Docker image for the server.
- [ ] **B3.** Versioned config schema + compatibility notes.
- [ ] **B4.** Example external (non-Decizense) MCP client.
- [ ] **B5.** Pin/upgrade Node engine (transitive deps want 20+; CI matrix).
- [ ] **B6.** Real admin role model (replace `agentId === 'orchestrator'` gate).
- [ ] **B7.** Git remote + publish; CI running build + smoke.

## C. Broader tests (port + extend the legacy agent suite)

The legacy `agents/src/test-*.ts` suite must be re-pointed at ContextGraph-MCP
and extended for the new contract.

- [x] **C1.** End-to-end agent ↔ ContextGraph-MCP happy path with real
      `case_id`/`request_id`.
- [x] **C2.** Retry/idempotency at the client boundary (duplicate `request_id`
      returns prior result through the full stack).
- [ ] **C3.** Concurrency (`test-concurrency.ts`), delegation/JWT
      (`test-delegation.ts`, `test-auth.ts`), OPA equivalence
      (`test-opa-equivalence.ts`) against the external server.
- [ ] **C4.** PII block/redaction end-to-end.
- [ ] **C5.** Negative: out-of-bundle, disallowed join, unknown metric,
      case_id/proposal mismatch surfaced to the agent.

## D. Rollout

- [x] **D1.** Config flag to select embedded harness vs external
      ContextGraph-MCP, defaulting to embedded until A-items land.
- [x] **D2.** Dual-run / shadow period. Phase 2 contract suite
      (`test-correlation-unit`, `test-phase2-vertical-slice`) passes against the
      external server with `HARNESS_MODE=external` (scenario travel, live OPA).
      Legacy `test-*` suite NOT yet shadow-validated (C3–C5, future) — those don't
      bind `case_id` and will fail correlated calls until ported.
- [ ] **D3.** Cutover to external; decommission embedded harness (A6).
- [ ] **D4.** Update CLI (`dazense chat`/`sync`) and dev scripts to launch or
      depend on the external server.

## Suggested order

A1–A3 (unblock end-to-end) → C1–C2 (prove it) → D1 (safe default) → remaining
A/C → B (hardening) → D2–D4 (rollout). Each of A, B, and the rollout warrants its
own spec/plan.

# Plan v3 Release Note — Control Plane Hardening

Date: 2026-04-07  
Scope: Phases 0 through 2c completed; Phase 3 in review/finalization.

## Delivered Phases

| Phase |  PR | Tag           | Outcome                                                    |
| ----- | --: | ------------- | ---------------------------------------------------------- |
| 0     |  #2 | `phase-0-v1`  | OpenTelemetry tracing + Jaeger visibility                  |
| 1a    |  #3 | `phase-1a-v1` | HTTP MCP transport + per-session AuthContext               |
| 1b    |  #4 | `phase-1b-v1` | DBOS durable harness decision workflows                    |
| 1c    |  #6 | `phase-1c-v1` | DBOS durable orchestrator workflow                         |
| 2a    |  #7 | `phase-2a-v1` | OPA shadow mode + equivalence battery                      |
| 2b    |  #8 | `phase-2b-v1` | OPA authoritative cutover, legacy checks removed           |
| 2c    |  #9 | `phase-2c-v1` | Decision logs + replay/drift admin tooling                 |
| 3     | #10 | pending       | Delegation (`act` claim), admin gating, verifier hardening |

## Success Criteria Status

1. Determinism: implemented via DBOS workflow IDs + checkpoint recovery.
2. Replayability: implemented via `decision_logs` + `replay_outcome` and `policy_drift_report`.
3. Delegation: implemented in code path (`act` support and enforcement controls), pending final merge/tag in Phase 3.
4. Observability: implemented end-to-end with OTel traces across agents and harness.
5. No regressions: phase verifiers and regression tests maintained through 2c.

## Verification Evidence

Evidence directories are committed under:

- `docs/phase-0-verification/`
- `docs/phase-1a-verification/`
- `docs/phase-1b-verification/`
- `docs/phase-1c-verification/`
- `docs/phase-2a-verification/`
- `docs/phase-2b-verification/`
- `docs/phase-2c-verification/`

New consolidated runner:

- `scripts/verify-plan-v3.sh` (chains phase verifiers and fails fast)

New 2c JWT/admin verifier coverage:

- `scripts/verify-phase-2c.sh` now verifies `replay_outcome` and `policy_drift_report` through MCP admin tools in JWT mode.
- `agents/src/test-admin-tools.ts` validates replay/drift expectations over authenticated HarnessClient calls.

## Accepted Limitations / Follow-ups

1. `agent_claim` mapping is intentionally top-level-claim only (no nested dot-path resolution).
2. Full release closure requires Phase 3 final merge/tag completion on `main` (currently PR #10 pending).
3. Any new scenario rollout still requires per-scenario policy bundle generation and verification evidence.
4. If delegation auth topology changes (IdP, claim names, token-exchange policy), rerun Phase 2c and Phase 3 verification before release.

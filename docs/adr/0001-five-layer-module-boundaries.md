# ADR 0001: Five-Layer Module Boundaries

## Status

Accepted

## Date

2026-03-30

## Context

This worktree implements a five-layer context infrastructure for trustworthy AI decisions. The architecture must be visible in code boundaries, not only in conceptual docs.

## Decision

We enforce the following module boundaries and ownership:

1. Knowledge/Semantic layer

- Owns concept definitions, semantic models, ontology terms, and relationship metadata.
- Inputs: `semantics/*.yml`, curated reference datasets.
- Outputs: resolved semantic model objects and semantic graph nodes.
- Initial code ownership: `apps/backend/src/agents/user-rules.ts`, `apps/backend/src/graph/*`.

2. Governance layer

- Owns policy checks, contract gating, certification constraints, PII controls, and risk constraints.
- Inputs: `policies/policy.yml`, semantic metadata, request draft.
- Outputs: `allow | block | needs_clarification`, policy checks, contract artifacts.
- Initial code ownership: `apps/backend/src/policy/*`, `apps/backend/src/agents/tools/build-contract.ts`.

3. Operational/Event layer

- Owns append-only operational truth and replay mechanics.
- Inputs: domain events from simulation/ingestion.
- Outputs: persisted events, tags, projection checkpoints, replay streams.
- Initial code ownership: Postgres/SQLite tables `events`, `event_tags`, `projection_checkpoints`.

4. Decision/Provenance layer

- Owns decision records, evidence links, and emitted-event lineage.
- Inputs: command intent + current operational context + governance result.
- Outputs: decision records and decision-to-event lineage.
- Initial code ownership: tables `decisions`, `decision_events`, and future decider modules.

5. Action/Permission layer

- Owns propose/approve/execute rights by risk level and actor role.
- Inputs: decision proposal + actor context + policy constraints.
- Outputs: approval/rejection/execute permission result and audit trail.
- Initial code ownership: to be implemented in Phase 2.

## Boundary Rules

- Lower layers must not import higher-layer business logic.
- Governance may read semantic metadata but may not mutate operational state.
- Operational writes are append-only for `events`; corrections are new events.
- Every executable decision must produce provenance (decision record + linked events).
- Action execution must consume decision/provenance output; no direct bypass path.

## Consequences

Positive:

- Architecture is testable through module contracts.
- Layer responsibilities are explicit for parallel implementation.
- Reuse across domains is easier (travel first, others later).

Tradeoff:

- More upfront structure and stricter interfaces.
- Additional migration and compatibility management while evolving schemas.

## Implementation Notes

Phase 0 enforces strict governance defaults and contract identity.
Phase 1 introduces event + decision schema foundation.
Phase 2 adds first missed-connection end-to-end decider and approval flow.

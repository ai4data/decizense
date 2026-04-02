# Digital Twin on Dazense: MVP Plan (Five-Layer Architecture)

## Summary

This worktree builds a travel digital twin to prove a **Context Infrastructure for Trustworthy AI Decisions**.

The MVP proving scenario is **missed connection**. The architecture is explicitly split into five layers so decision trust is engineered, testable, and replayable.

## Five Explicit Layers

1. **Knowledge/Semantic graph**
    - Business concepts, entities, ontology terms, governed metrics, allowed relationships.
    - Purpose: stable meaning and shared vocabulary.

2. **Governance graph**
    - Policies, certifications, contract checks, PII controls, approval constraints.
    - Purpose: enforce what is allowed before any decision action.

3. **Operational/Event graph**
    - Append-only events, state transitions, case timelines, disruption projections.
    - Purpose: represent what actually happened in operations.

4. **Decision/Provenance graph**
    - Proposal, evidence, policy checks, approver, action, outcome, precedent links.
    - Purpose: make decisions auditable, explainable, and replayable.

5. **Action/Permission graph**
    - Role-based rights for propose/approve/execute by risk level.
    - Purpose: separate capability boundaries from semantic meaning.

## MVP Scenario

- Primary disruption: **missed connection**.
- Decision classes: `rebook_now`, `offer_alternative`, `escalate_to_human`.
- Risk levels: `low`, `medium`, `high`.
- MVP action mode: **human approval required**.

## Layered Data Flow

1. Operational delay event is ingested.
2. Event projections update affected itineraries and passenger risk.
3. Decision features are computed from process + operational state.
4. Agent proposes action with explicit inputs and rationale.
5. Proposal is gated by contract/policy checks.
6. Role-based approver accepts/rejects.
7. Action result and outcome are recorded.
8. Full provenance chain becomes searchable as precedent.

## Contracts to Lock

- **Event contract**: `event_id`, `event_time`, `case_id`, `event_type`, `entity_type`, `entity_id`, `payload_json`, `producer_role`, `idempotency_key`.
- **Projection contract**: replay-safe operational tables (`bookings`, `itineraries`, `flight_status`, `passenger_risk`, `decision_features`).
- **Decision proposal contract**: `decision_id`, `role`, `trigger_event_ids`, `input_signals`, `recommended_action`, `risk_level`, `required_approver`, `contract_id`, `policy_checks`, `precedent_refs`.
- **Lifecycle contract**: `proposed -> approved/rejected -> executed/simulated -> outcome_recorded`.

## Acceptance Criteria

- 100% of critical decisions have full chain: event -> process evidence -> policy checks -> approver -> outcome.
- 0 critical policy bypasses.
- Missed-connection workflow runs end-to-end with replayability.
- Decision rights are enforced by role and risk level.
- Precedent retrieval is available for decision proposals.

## Execution Roadmap (Implementation Order)

### Phase 0 — Foundation Hardening (Layers 1-3 first)

Goal: make the current semantic + governance path strict enough to support product-grade event/decision runtime.

Tasks:

- [ ] Make governance fail-closed:
    - `build_contract` must block when `policies/policy.yml` is missing.
    - Default policy profile in this worktree must require contract and bundle.
- [ ] Fix project-scope consistency:
    - Ensure semantic and business-rule loaders always use `context.projectFolder`.
- [ ] Strengthen contract identity + storage:
    - Use full UUID `contract_id`.
    - Remove substring-based contract lookup and require exact id match.
- [ ] Introduce strict policy profile for twin scenarios:
    - No PII bypass.
    - No raw execution without contract.
    - Enforced bundle/table/join scope.

Exit criteria:

- Any missing policy/contract causes `block`, not `allow`.
- Contract provenance is uniquely addressable and auditable.

### Phase 1 — Operational Event Backbone (Layer 3 MVP)

Goal: establish append-only operational truth in Postgres with replay-safe mechanics.

Tasks:

- [x] Add Postgres schema + migrations for:
    - `events`
    - `event_tags`
    - `projection_checkpoints`
    - `decisions`
    - `decision_events`
- [x] Add transactional write API:
    - append event batch with idempotency key
    - persist decision record and linked produced events in same transaction
- [x] Add projection runtime:
    - global-position polling
    - checkpointing
    - retry + dead-letter strategy for failed projection steps

Exit criteria:

- Full replay and catch-up replay both pass.
- Projection state is recoverable from checkpoints after restart.

### Phase 2 — Missed-Connection Decision Flow (Layers 3-5 integration)

Goal: prove first end-to-end governed decision workflow.

Tasks:

- [x] Implement canonical disruption events:
    - `FlightDelayed`
    - `ConnectionMissed`
    - `RebookProposed`
    - `RebookApproved` / `RebookRejected`
    - `PassengerRebooked`
    - `OutcomeRecorded`
- [x] Build projections for scenario:
    - itinerary timeline
    - connection risk
    - candidate alternatives
- [x] Implement decider(s):
    - compute recommendation (`rebook_now`, `offer_alternative`, `escalate_to_human`)
    - compute `risk_level`
    - compute `required_approver`
- [x] Implement approval + permission checks:
    - role/risk gate for propose/approve/execute
    - explicit rejection reasons

Exit criteria:

- Scenario runs end-to-end with complete provenance chain.
- Action execution without required approval is impossible.

### Phase 3 — Process Intelligence + Precedent Retrieval

Goal: connect event history to process signals and historical decision support.

Tasks:

- [x] Derive process features from event log:
    - path variants
    - SLA breach patterns
    - recurrent bottlenecks
- [x] Store decision features used at proposal time.
- [x] Add precedent search:
    - retrieve similar cases by disruption type + context tags + outcome.

Exit criteria:

- Decision proposal includes both current evidence and precedent references.
- KPI reporting includes quality, latency, and false-block metrics.

## Work Backlog (Near-Term Sprint Tasks)

Priority order: `P0` must complete before `P1`.

### P0 (Now)

- [x] Patch current contract path to fail-closed.
- [x] Patch projectFolder propagation bug in semantic/business-rule loads.
- [x] Patch contract id + lookup strategy.
- [x] Write first migration for event backbone tables.
- [x] Add architecture ADR: module boundaries for 5 layers in codebase.

### P1 (Immediately after P0)

- [x] Implement event append service + idempotency handling.
- [x] Implement first projection worker + checkpoint loop.
- [x] Implement first missed-connection decider and tests (given/when/then).
- [x] Implement approval gate API + role/risk policy checks.

### P2

- [x] Add process-mining feature extraction pipeline.
- [x] Add precedent retrieval and score explanation.
- [x] Add benchmark + load tests for event and projection paths.

## Alignment

- North Star and KPIs: `docs/north-star-context-infrastructure.md`
- Twin architecture and boundaries: `docs/worktree-architecture.md`
- Dependency on external control plane: `docs/control-plane-dependency.md`
- Layer module boundaries ADR: `docs/adr/0001-five-layer-module-boundaries.md`
- Travel domain narrative: `docs/prd-flight-travel.md`
- Disruption requirements: `docs/prd-flight-travel-disruption.md`
- Simulation architecture reference: `docs/architecture_synthetic_company.md`

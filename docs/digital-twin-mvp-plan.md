# Digital Twin on Dazense: MVP Plan (Travel Disruptions + Decision Agents)

## Summary

Build a dedicated-worktree experiment that extends dazense into a **synthetic operations twin**: event-sourced travel operations, PM4PY process intelligence (batch), and simulated employee agents whose decisions are enforced by dazense governance (contracts + policy + provenance).

MVP goal: prove **decision quality under guardrails** on missed-connection disruptions.

## Implementation Changes

### Workstream A — Twin runtime (Postgres + Python workers)

- Add `events` as append-only source of truth (`event_id`, `event_time`, `case_id=booking_id`, `event_type`, `entity_type`, `entity_id`, `payload_json`, `producer_role`).
- Add projection workers to maintain operational state tables (`bookings`, `itineraries`, `flight_status`, `passenger_risk`) from event log.
- Add disruption injector for weather-delay → missed-connection cascades.

### Workstream B — Process intelligence (PM4PY batch every 5–15 min)

- Build PM extract from event log to canonical process log (`case_id`, `activity`, `timestamp`, `resource/role`).
- Produce batch process outputs (`variant`, `throughput_time`, `bottleneck_step`, `conformance_flags`) into queryable tables.
- Expose “decision features” table consumed by agents (e.g., missed-connection probability, queue pressure).

### Workstream C — Simulated employee agents (3 roles)

- Roles: `Ops Controller`, `Rebooking Agent`, `Policy/Revenue Approver`.
- Agents create proposed actions (rebook, compensation class, escalate) but execution is **human-approval required** in MVP.
- Every proposal must pass `build_contract` + policy checks before becoming an actionable recommendation.

### Workstream D — Governance integration (existing dazense stays control layer)

- Extend semantic/business rules for operational decisions (connection windows, priority tiers, compensation constraints).
- Map process outputs into governed metrics/signals so decisions are based on approved meaning, not raw SQL guesses.
- Persist decision provenance linking event context + process evidence + policy checks + final recommendation.

### Workstream E — Decision memory layer (system of record)

- Add decision entities: `DecisionProposal`, `DecisionApproval`, `DecisionAction`, `DecisionOutcome`.
- Persist decision graph edges: `triggered_by_event`, `supported_by_process_signal`, `governed_by_policy`, `approved_by_role`, `resulted_in_outcome`.
- Add precedent retrieval interface so agents can reference similar prior decisions before proposing actions.
- Ensure every decision is replayable from stored context and governance artifacts.

## Critical Decision Scope (MVP)

- Workflow: **missed-connection rebooking** only.
- Decision classes: `rebook_now`, `offer_alternative`, `escalate_to_human`.
- Risk levels: `low`, `medium`, `high`.
- Action rights in MVP:
    - `low`: recommendation can proceed to single approver.
    - `medium`: requires explicit approval by Policy/Revenue Approver.
    - `high`: escalation only (no execution recommendation).

## Public Interfaces / Types to Lock Before Coding

- **Event schema contract**: required fields, idempotency key, ordering semantics, late-event handling rule.
- **PM output contract**: table names, columns, refresh cadence, confidence indicators.
- **Decision proposal contract**: `decision_id`, `role`, `input_signals`, `recommended_action`, `risk_level`, `required_approver`, `contract_id`, `policy_checks`.
- **Approval lifecycle**: `proposed -> approved/rejected -> executed/simulated`, with immutable audit trail.

## Test Plan (Acceptance)

- **Scenario tests (missed connection)**: delayed inbound flight triggers impacted passenger detection and valid rebooking options.
- **Governance tests**: unsafe/out-of-scope/PII actions blocked; ambiguous metric decisions require clarification.
- **Process tests**: PM4PY batch emits expected bottleneck/conformance outputs from known event traces.
- **Agent tests**: each role produces policy-compliant proposals with full provenance; no direct execution without approval.
- **Business KPI tests**: report decision precision, false-positive/false-block rates, and time-to-recommendation.
- **Baseline vs treatment tests**:
    - Baseline: agent without unified context graph.
    - Treatment: agent with unified context graph + contracts/policies + process signals.
    - Compare precision, policy violations, explainability completeness, and operator override rate.

## Rollout Control (Autonomy Ladder)

1. **Simulation-only**: proposals are scored, no approvals.
2. **Human approval required (MVP default)**: proposals require explicit approval.
3. **Bounded auto-execution (post-MVP)**: only low-risk class can auto-execute if KPI gates pass.

Progress to next level only if KPI thresholds from `docs/north-star-context-infrastructure.md` are met.

## Outcome Feedback Loop

- Record post-action outcomes (e.g., successful rebooking, delay avoided, cost impact) into `DecisionOutcome`.
- Link outcomes to originating proposal/action and update precedent retrieval corpus.
- Use periodic review to refine rules, thresholds, and role policies without bypassing governance guardrails.

## Assumptions (Locked)

- Dedicated worktree experiment (no changes to current mainline until validated).
- MVP disruption focus: **missed connection**.
- Runtime topology: **Postgres + Python workers**.
- PM mode: **batch (5–15 min)**.
- Action mode: **human approval required**.
- Simulated employee agents: **3 roles**.
- Primary success metric: **decision quality under guardrails**.

## Alignment with Existing Docs

- Business narrative and entity/process context come from `docs/prd-flight-travel.md`.
- Disruption-driven requirements and evaluation scenarios come from `docs/prd-flight-travel-disturbtion.md`.
- Layered platform architecture comes from `docs/architecture_synthetic_comapny.md`.
- Governance, contracts, policy enforcement, and graph foundations come from `docs/trusted-analytics-copilot-implementation_plan.md`.
- Program-level objective and evaluation rubric are defined in `docs/north-star-context-infrastructure.md`.

This document is the execution bridge: it converts those four documents into one MVP delivery plan for a dedicated experiment worktree.

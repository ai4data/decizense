# Worktree Architecture (Context Infrastructure)

## Scope Boundary

This worktree owns:

- Twin runtime and simulation behavior.
- Event ingestion and projections.
- Process intelligence outputs used for decisions.
- Decision memory and provenance entities.
- Action permissions and approval lifecycle.

This worktree does **not** own the legacy trusted-analytics implementation baseline from `/learning/dazense`.

## Canonical Layers

1. **Knowledge/Semantic**
    - Concepts and domain entities (Passenger, Flight, Itinerary, Disruption, Decision).
    - Governed decision signals and interpretation vocabulary.

2. **Governance**
    - Policy constraints and contract gating.
    - Approval constraints and safety requirements.

3. **Operational/Event**
    - Append-only `events` table as source of truth.
    - Derived operational projections and case timelines.

4. **Decision/Provenance**
    - `DecisionProposal`, `DecisionApproval`, `DecisionAction`, `DecisionOutcome`.
    - Evidence links to events, process signals, and policy checks.

5. **Action/Permission**
    - Who can propose, approve, and execute by risk class.
    - Separation of recommendation rights and execution rights.

## First Proving Workflow

**Missed connection rebooking** is the first mandatory end-to-end workflow because it forces all five layers to interact.

## Invariants

- Meaning before action.
- Policy before execution.
- Traceability by default.
- Replayability required.
- Human-gated autonomy progression.

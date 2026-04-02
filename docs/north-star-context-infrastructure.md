# North Star + Definition of Done

## North Star

Build a domain-agnostic **Context Infrastructure for Trustworthy AI Decisions** where agents can reason and act using:

- explicit business concepts and relationships,
- operational events and execution traces,
- process intelligence (variants, bottlenecks, conformance),
- enforceable governance (semantic meaning, policy, contract gating),
- full decision provenance (why an action was proposed, allowed, approved, or blocked).

The travel digital twin is a proving environment for this infrastructure, not the final product.

The target system is a **Decision System of Record** where every critical decision is explicitly represented, governed, replayable, and auditable.

## Product Outcome We Optimize For

For each decision workflow, the system must improve:

1. **Decision quality** under guardrails
2. **Operational response time** to disruptions
3. **Auditability** of decisions and actions
4. **Safety** (low policy violations, low unsafe automation)

## Principles (Must Hold)

1. **Meaning before action**: no action based on ambiguous metrics or undefined concepts.
2. **Policy before execution**: all agent proposals pass contract/policy checks.
3. **Traceability by default**: every decision links back to events, process evidence, and rules.
4. **Replayability required**: a decision can be reconstructed end-to-end from stored context, checks, and approvals.
5. **Human-gated rollout**: automation rights increase only after measured reliability.
6. **Domain portability**: core architecture is reusable beyond travel.

## Definition of Done (Program Level)

The program is considered successful when all are true:

- A unified context model exists across concepts, relationships, events, and process signals.
- At least one disruption workflow (missed connection) runs end-to-end in the twin.
- Simulated employee agents produce governed decision proposals with complete provenance.
- No action can bypass contract/policy guardrails.
- KPI dashboard reports decision quality, false blocks/positives, and time-to-decision.
- The same architecture can be re-parameterized for a second domain without redesign.

## Program KPIs and Thresholds

- **Provenance completeness**: `100%` of critical decisions have full chain (event → process evidence → policy checks → approver → outcome).
- **Critical policy bypass rate**: `0` bypasses in accepted runs.
- **Decision precision**: `>=85%` for the primary disruption workflow.
- **Precedent retrieval coverage**: `>=70%` of decisions retrieve at least one similar prior case.
- **Outcome attribution completeness**: `>=90%` of executed decisions have measurable post-action outcome attached.

## Definition of Done (Per Feature / Worktree)

A feature is done only if it includes:

- **Spec completeness**: clear interface/schema and ownership.
- **Governance compatibility**: integrates with semantic/policy/contract layers.
- **Observability**: emits logs/metrics needed for audit and debugging.
- **Test coverage**: happy path, disruption path, and policy-failure path.
- **Rollback safety**: feature can be disabled without corrupting decision flow.
- **Documentation alignment**: updates linked docs and acceptance criteria.

## Non-Goals (For This Stage)

- Fully autonomous production actions without human approval.
- Industry-specific hardcoding in the core platform.
- Optimizing for real-time streaming before batch reliability is proven.

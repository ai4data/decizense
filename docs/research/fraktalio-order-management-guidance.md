# Architecture Brief: Fraktalio Order-Management-Demo Analysis

**Source:** [fraktalio/order-management-demo](https://github.com/fraktalio/order-management-demo)
**Analyzed:** 2026-03-30
**Purpose:** Extract transferable patterns for a Postgres + Python event-sourced platform with decision/provenance tracking, governance layers, and a travel digital-twin scenario (missed flight connection).

---

# 1. Executive Summary (max 12 bullets)

1. The demo implements the **Dynamic Consistency Boundary (DCB)** pattern, where consistency boundaries are defined per use case (not per aggregate entity). Each decider declares exactly which event types and tags it needs, loading only those events for its decision.
2. **Cross-entity decisions are first-class**: the `placeOrderDecider` spans both Restaurant and Order entities in a single atomic decision — no saga needed for the core atomic decision path. This directly maps to our missed-flight scenario where a rebooking decision spans flight, passenger, and hotel entities. (Note: sagas/process managers are still required for long-running side effects involving external systems — airline APIs, hotel confirmations, notifications.)
3. **Three pure functions** drive all domain logic: `decide(command, state) → events`, `evolve(state, event) → state`, and `initialState`. No side effects in domain code — all I/O is pushed to the repository layer.
4. **Tag-based event indexing** replaces stream naming. Events carry `tagFields` (e.g., `["restaurantId", "orderId"]`), and repositories query by `(tag_key, tag_value, event_type)` tuples. For Postgres, only materialize index rows for combinations actually queried by repositories (not all 2^n − 1 subsets), with a hard cap of 3 tag fields per event type.
5. **Optimistic locking** uses versionstamps on "last event" pointers per `(eventType, ...tags)` key, checked atomically on write. No global sequence numbers, no stream-level revision counters.
6. **Views (projections)** are pure fold functions over events, built on-demand at query time — no separate read database. This is a demo simplification; production systems need materialized projections.
7. **Exhaustive pattern matching** at the type level guarantees every event type is handled in both deciders and views. Unhandled events cause compile-time errors (TypeScript `never` check).
8. **Testing follows Given/When/Then** for deciders and Given/Then for views, operating entirely on domain objects with no infrastructure dependencies. Property-based tests (fast-check) cover API handlers.
9. **Idempotency** emerges from deterministic pure functions + optimistic locking: retrying a command against unchanged state produces identical events; concurrent writes fail and retry with fresh state.
10. **No explicit saga/process manager** exists in the demo. Cross-entity coordination is handled by DCB's flexible consistency boundaries, eliminating the need for choreography or orchestration **for synchronous, atomic decisions**. Long-running processes involving external systems (airline rebooking APIs, hotel confirmations, email notifications) still require process management with outbox/inbox and compensating actions.
11. **No governance, permission, or audit layers** exist. Auth is limited to GitHub OAuth session gating. There is no role-based command filtering, no decision provenance, no approval workflow.
12. **No observability beyond error handling**: no correlation IDs, no tracing, no metrics, no event metadata beyond type and tags. Production systems need all of these.

---

# 2. Transferable Architecture Patterns

## 2.1 Pattern: Dynamic Consistency Boundary (DCB)

**Problem it solves:** Traditional aggregates force you to choose a single entity as the consistency boundary. When a business rule spans multiple entities (e.g., "a passenger can only be rebooked if the alternative flight has capacity AND the passenger's ticket class allows it"), you need sagas with compensating events and accept temporary inconsistency.

**How it works in the demo:** Each decider declares tuple-based queries: `[(restaurantId, "RestaurantCreatedEvent"), (orderId, "RestaurantOrderPlacedEvent")]`. The repository loads only matching events, folds them into state, runs the decision, and writes new events — all within an optimistic-locking transaction. The `placeOrderDecider` naturally spans Restaurant + Order without coordination overhead.

**Why it matters for our project:** The missed-flight-connection scenario inherently spans Flight, Passenger, Booking, and Hotel entities. DCB lets a single `RebookPassengerDecider` load the relevant events from all four entity types, make one atomic decision, and emit events — no saga needed for the core atomic decision path. Sagas are still required for downstream side effects (airline API calls, hotel reservations, notifications).

**Risks/misuse cases:**

- Tag explosion: if events have many tag fields, 2^n index combinations grow fast. **Hard cap: max 3 tag fields per event type.** Only materialize index entries for tag combinations that are actually queried by a repository — do not blindly generate all subsets.
- "God decider" anti-pattern: a decider that reads too many event types becomes a coupling bottleneck. Each decider should map to one use case.
- Without stream-level ordering guarantees, causal ordering across tag dimensions requires careful design.

**Recommended adaptation for Postgres + Python:**

- Use a single `events` table with a `global_position` (bigserial), `event_type`, `payload` (jsonb), and a `tags` (jsonb array or separate `event_tags` table with composite index).
- For optimistic locking: track `max(global_position)` per query tuple at read time; on write, assert no new matching events exist beyond that position (SELECT ... FOR UPDATE or advisory locks).
- Implement deciders as Python dataclasses with `decide()`, `evolve()`, and `initial_state` — keep them pure (no DB access, no I/O).

---

## 2.2 Pattern: Decider as Pure Decision Function

**Problem it solves:** Business logic tangled with persistence, HTTP, and side effects becomes untestable and hard to reason about.

**How it works in the demo:** Each decider is a plain object with three properties: `decide(command, state) → Event[]`, `evolve(state, event) → state`, `initialState`. Zero imports from infrastructure. The repository calls these functions — the decider never calls the repository.

**Why it matters for our project:** Decision/provenance tracking requires that every decision is inspectable: what state was seen, what command was received, what events were produced. Pure functions make this trivial to capture.

**Risks/misuse cases:**

- Temptation to sneak I/O into decide (e.g., calling an external API for fare lookup). Solution: pre-fetch external data and pass it as part of the command or a "context" parameter.
- Over-decomposing deciders into microservices prematurely. Keep deciders as in-process functions until proven otherwise.

**Recommended adaptation for Postgres + Python:**

```python
@dataclass(frozen=True)
class RebookPassengerDecider:
    initial_state: RebookState = RebookState()

    def decide(self, cmd: RebookCommand, state: RebookState) -> list[Event]:
        if state.flight_full:
            raise NoCapacityError(cmd.target_flight_id)
        return [PassengerRebooked(...)]

    def evolve(self, state: RebookState, event: Event) -> RebookState:
        match event:
            case FlightCapacityChanged(): return state.with_capacity(event.available)
            case PassengerRebooked(): return state.with_rebooked(event.passenger_id)
```

---

## 2.3 Pattern: Tag-Based Event Indexing (replacing stream naming)

**Problem it solves:** In traditional event sourcing, choosing stream names (e.g., `Order-123`, `Restaurant-456`) locks you into a single partitioning dimension. Cross-stream queries require projections or sagas.

**How it works in the demo:** Events are stored once in a primary table. Secondary indexes are built for every subset combination of the event's `tagFields`. Queries specify `(tagValue, eventType)` tuples. No stream names exist.

**Why it matters for our project:** A flight event is relevant to flight operations, passenger rebooking, and airport analytics simultaneously. Tag-based indexing lets each use case query by its own dimension without duplicating events.

**Risks/misuse cases:**

- Query performance degrades if tag cardinality is extreme (millions of unique tag values per type). Partition or archive aggressively.
- The demo's approach of materializing all 2^n − 1 tag subset combinations is conceptually clean but **physically risky in Postgres**. An event with 4 tag fields = 15 index rows per event. **Recommendation: hard cap at 3 tag fields per event type, and only materialize the specific (tag_key, tag_value, event_type) combinations that a repository actually queries** — not every possible subset.
- Without a global ordered stream, building a catch-up subscription for projections requires a global position column.

**Recommended adaptation for Postgres + Python:**

```sql
CREATE TABLE events (
    global_position BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE event_tags (
    tag_key TEXT NOT NULL,
    tag_value TEXT NOT NULL,
    event_type TEXT NOT NULL,
    global_position BIGINT NOT NULL REFERENCES events(global_position),
    PRIMARY KEY (tag_key, tag_value, event_type, global_position)
);
-- Note: only insert tag rows for (tag_key, tag_value, event_type) combinations
-- that are actually queried by a repository. Do NOT generate all 2^n subsets.

-- Query: load events for a decider
-- SELECT e.* FROM events e
-- JOIN event_tags t ON e.global_position = t.global_position
-- WHERE (t.tag_key, t.tag_value, t.event_type) IN (('passenger_id','P-42','FlightBooked'), ...)
-- ORDER BY e.global_position;
```

---

## 2.4 Pattern: Tuple-Based Sliced Repositories

**Problem it solves:** Each use case (decider) needs only a subset of events. Loading entire streams wastes I/O and couples deciders to irrelevant event types.

**How it works in the demo:** Each repository declares a function `command → tuple[]` mapping a command to the exact `(tagValue, eventType)` pairs needed. The infrastructure loads exactly those events, nothing more.

**Why it matters for our project:** In the travel domain, a RebookDecider needs `(passenger_id, FlightBooked)` + `(flight_id, CapacityChanged)` but not `(flight_id, MealPreferenceSet)`. Tuple declaration makes this explicit and auditable.

**Risks/misuse cases:**

- Forgetting to include a relevant event type in the tuple → stale state → wrong decisions. Mitigate with integration tests that assert tuple completeness.
- Tuple declarations are a form of coupling — changing which events a decider needs requires updating the tuple mapping.

**Recommended adaptation for Postgres + Python:**

```python
class RebookRepository(EventSourcedRepository):
    def query_tuples(self, cmd: RebookCommand) -> list[tuple[str, str, str]]:
        return [
            ("passenger_id", str(cmd.passenger_id), "FlightBooked"),
            ("passenger_id", str(cmd.passenger_id), "PassengerRebooked"),
            ("flight_id", str(cmd.target_flight_id), "FlightCapacityChanged"),
        ]
```

---

## 2.5 Pattern: Given/When/Then Specification Testing

**Problem it solves:** Testing event-driven logic through the API or database is slow, flaky, and couples tests to infrastructure.

**How it works in the demo:** `DeciderEventSourcedSpec.for(decider).given([events]).when(command).then([expectedEvents])` — tests are pure data-in/data-out. View specs use `.given([events]).then(expectedState)`. No database, no HTTP, no mocking.

**Why it matters for our project:** Decision provenance tracking demands that we can prove a given state + command produces exactly the expected events. These specs double as executable documentation of business rules.

**Risks/misuse cases:**

- Testing only happy paths. The demo also tests error cases with `.thenThrows()` — essential for our governance rules.
- Spec tests don't cover infrastructure behavior (optimistic lock retries, network failures). Need separate integration tests.

**Recommended adaptation for Postgres + Python:**

```python
def test_rebook_passenger_success():
    spec = DeciderSpec(RebookPassengerDecider())
    spec.given([
        FlightBooked(passenger_id="P-42", flight_id="F-100"),
        FlightCapacityChanged(flight_id="F-200", available=5),
    ]).when(
        RebookCommand(passenger_id="P-42", target_flight_id="F-200")
    ).then([
        PassengerRebooked(passenger_id="P-42", from_flight="F-100", to_flight="F-200")
    ])
```

---

## 2.6 Pattern: On-Demand View Projection

**Problem it solves:** Maintaining synchronized read models adds operational complexity.

**How it works in the demo:** Views are pure fold functions. At query time, the `EventSourcedQueryHandler` loads relevant events from the store and folds them through the view projection to produce current state. No materialized view table.

**Why it matters for our project:** Useful for low-traffic admin/audit views where freshness matters more than latency.

**Risks/misuse cases:**

- Does not scale for high-read workloads. Loading and folding N events per read request is O(N).
- Not suitable for complex queries (filtering, aggregation, joins).

**Recommended adaptation for Postgres + Python:**

- Use on-demand projection only for audit/provenance views with small event counts per entity.
- For operational dashboards, use materialized projections: a background worker subscribes to the events table (via `global_position` polling or LISTEN/NOTIFY) and updates denormalized read tables.
- Hybrid approach: materialize hot paths, fold on-demand for cold/audit paths.

---

## 2.7 Pattern: Optimistic Concurrency via Position Tracking

**Problem it solves:** Concurrent commands on overlapping state must not silently overwrite each other.

**How it works in the demo:** The repository records the versionstamp of the "last event" pointer for each query tuple. On write, an atomic transaction checks that no versionstamp has changed. If it has, the write fails, and the caller retries with fresh state.

**Why it matters for our project:** Two agents simultaneously rebooking the same passenger onto the same flight must not both succeed if only one seat remains.

**Risks/misuse cases:**

- High contention on hot entities (popular flights) causes retry storms. Mitigate with exponential backoff and circuit breakers.
- Starvation: a slow decider may never win against fast concurrent writers. Consider reservation/lock patterns for critical paths.

**Recommended adaptation for Postgres + Python:**

Use **transaction-scoped advisory locks** keyed on the query tuple set. This avoids the TOCTOU race of "check then insert" under READ COMMITTED isolation.

Advisory lock key guidance:

- For MVP, `hashtext(tuple_set_key)` is acceptable and simple.
- For production, prefer a deterministic 64-bit key (or two-int key with `pg_advisory_xact_lock(k1, k2)`) to reduce collision probability and avoid unnecessary serialization of unrelated tuple sets.

```sql
-- Strategy: advisory lock per decision tuple set
-- Lock key = hash of sorted (tag_key, tag_value, event_type) tuples
BEGIN;
  -- 1. Acquire advisory lock scoped to this transaction (blocks concurrent
  --    writers with overlapping tuple sets; released automatically on COMMIT/ROLLBACK)
  SELECT pg_advisory_xact_lock(hashtext($tuple_set_key));

  -- 2. Load current events for the tuple set
  SELECT e.* FROM events e
  JOIN event_tags t ON e.global_position = t.global_position
  WHERE (t.tag_key, t.tag_value, t.event_type) IN ((...))
  ORDER BY e.global_position;

  -- 3. Fold events through evolve() in Python → current state
  -- 4. Run decide(command, state) in Python → new events
  -- 5. Append new events + tags
  INSERT INTO events (event_type, schema_version, payload, metadata) VALUES (...);
  INSERT INTO event_tags (tag_key, tag_value, event_type, global_position) VALUES (...);

COMMIT;  -- advisory lock released here

-- Alternative for low-contention paths: skip the advisory lock,
-- use a CAS check: assert max(global_position) for tuple set hasn't
-- changed since read. On conflict, retry with backoff (max 3 retries).
-- Only use this for paths where lock contention is measured to be low.
```

---

# 3. Mapping to Our 5-Layer Architecture

## 3.1 Knowledge/Semantic Layer

**What the demo can inspire:**

- Branded/nominal types for domain identifiers (`RestaurantId`, `OrderId` are branded strings via TypeScript — prevents mixing IDs). Directly applicable: use Python `NewType` or tagged dataclasses for `PassengerId`, `FlightId`, `BookingId`.
- Explicit domain error types (`RestaurantNotFoundError`, `OrderAlreadyExistsError`) as first-class values rather than generic exceptions.
- Event type taxonomy with `tagFields` metadata — events self-describe their indexing dimensions.

**What the demo does NOT cover:**

- No ontology or semantic model for the domain — no entity relationships, no concept hierarchy.
- No schema registry or event versioning strategy.
- No domain language glossary or ubiquitous language documentation beyond code names.

**How we should fill the gap:**

- Define a travel domain ontology: entities (Flight, Passenger, Booking, Segment, Hotel, Connection), their relationships, and lifecycle states.
- Implement an event schema registry (e.g., JSON Schema in a `schemas/` directory or a Postgres `event_schemas` table) with forward-compatible versioning (add fields only, never remove).
- Maintain a machine-readable domain glossary that maps business terms to event types and entity tags.

---

## 3.2 Governance Layer

**What the demo can inspire:**

- The decider pattern naturally separates "who decides" from "how it's persisted." This separation point is where governance hooks should be inserted.
- Zod validation schemas at API boundaries ensure structural validity before commands reach deciders.

**What the demo does NOT cover:**

- No role-based or attribute-based command authorization (any authenticated user can do anything).
- No approval workflows (multi-step decisions requiring human sign-off).
- No policy engine or rule evaluation.
- No audit trail beyond the event log itself.
- No rate limiting or abuse prevention at the domain level.

**How we should fill the gap:**

- Insert a **command authorization middleware** between the API handler and the repository: `authorize(command, actor, context) → Allowed | Denied(reason)`. This middleware checks policies before the decider ever runs.
- Implement **governance events**: `DecisionRequested`, `DecisionApproved`, `DecisionDenied`, `PolicyOverrideApplied` — these events are first-class domain events in the same event store.
- Build a **policy decider** that evolves governance state (who has what role, what policies apply to what entity types) and is queried by the authorization middleware.
- For the travel scenario: "Agent X requests rebooking" → governance checks: does agent X have rebooking authority for this passenger class? Is the fare difference within auto-approval threshold? If not, emit `ApprovalRequired` and pause.

---

## 3.3 Operational/Event Layer

**What the demo can inspire:**

- Single event table with tag-based indexing — directly transferable to Postgres.
- Event structure: `{ event_type, payload, tagFields }` — clean separation of routing metadata from business data.
- Optimistic locking via position tracking — proven concurrency model.
- On-demand projection for read models — useful for low-volume views.

**What the demo does NOT cover:**

- No event versioning or schema migration strategy.
- No snapshotting for entities with long event histories.
- No archival or partitioning strategy.
- No global subscription mechanism for projections (relies on full re-fold at query time).
- No dead-letter or poison-event handling.

**How we should fill the gap:**

- Add `schema_version` to events table. Use upcasters (functions that transform old event shapes to new) during read.
- Implement snapshotting: after N events for a given tag combination, persist a snapshot. On read, load snapshot + events after snapshot position.
- Partition the events table by time (Postgres declarative partitioning on `created_at`). Archive old partitions to cold storage.
- Build a projection worker using `global_position` polling: `SELECT * FROM events WHERE global_position > $last_processed ORDER BY global_position LIMIT 1000`.
- Add a `dead_letter_events` table for events that fail projection processing after N retries.

---

## 3.4 Decision/Provenance Layer

**What the demo can inspire:**

- Pure `decide()` functions are inherently traceable: given the same inputs, they produce the same outputs. This is the foundation for provenance.
- The tuple-based query pattern explicitly declares what state was consulted for each decision — this is the "evidence set."

**What the demo does NOT cover:**

- No explicit decision record: what state was seen, what command was processed, what events were emitted, who triggered it, when.
- No decision versioning (if the decide logic changes, how do we know which version produced a past decision).
- No counterfactual analysis ("what would have happened if the state had been different").
- No decision explanation or justification field.

**How we should fill the gap:**

- Create `decisions` and `decision_events` tables:

    ```sql
    CREATE TABLE decisions (
        decision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        command_type TEXT NOT NULL,
        command_payload JSONB NOT NULL,
        actor_id TEXT NOT NULL,
        state_snapshot JSONB NOT NULL,        -- state seen at decide() time
        events_read_positions JSONB NOT NULL,  -- query tuples + max positions
        decider_version TEXT NOT NULL,          -- git hash or semantic version
        decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        justification TEXT                      -- human or system-provided reason
    );

    -- Join table for proper FK integrity and queryability
    CREATE TABLE decision_events (
        decision_id UUID NOT NULL REFERENCES decisions(decision_id),
        event_id UUID NOT NULL REFERENCES events(event_id),
        ordinal INT NOT NULL,                   -- order of event within decision
        PRIMARY KEY (decision_id, event_id)
    );
    CREATE INDEX idx_decision_events_event ON decision_events(event_id);
    ```

- Every command handler writes a decision record alongside the events (in the same transaction).
- For the travel scenario: when a passenger is rebooked, the decision record captures: "Agent A saw flights F-100 (booked, position 42) and F-200 (3 seats available, position 87), applied RebookDecider v1.2.0, produced PassengerRebooked event."

---

## 3.5 Action/Permission Layer

**What the demo can inspire:**

- API middleware pattern (`_middleware.ts`) for route-level access control — the pattern of intercepting requests before handlers is directly transferable.
- Error-to-HTTP-status mapping (domain errors → 404/409/422) provides clean separation between domain and transport concerns.

**What the demo does NOT cover:**

- No fine-grained permissions (field-level, entity-level, action-level).
- No permission inheritance or delegation.
- No temporal permissions (permissions that expire or activate at certain times).
- No external action execution (the demo's "actions" are only event writes to KV).

**How we should fill the gap:**

- Define a permission model: `(actor, action, resource, conditions) → permit | deny`. Store permissions as events themselves so they're auditable.
- Implement permission checks at two points: (1) before command dispatch (coarse — can this actor submit this command type?), (2) inside the authorization middleware (fine — can this actor affect this specific entity given current state?).
- For external actions (sending rebooking confirmation emails, calling airline APIs), use an **action outbox** pattern: write intended actions as events, and a separate worker processes them with at-least-once delivery.
- Temporal permissions for travel: "Gate agent can override rebooking only during boarding window (T-45min to T-0)."

---

# 4. Concrete Design Recommendations for Our Codebase

## 4.1 Event Table and Stream Keys

```sql
-- Core event store
CREATE TABLE events (
    global_position BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    schema_version INT NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_created ON events(created_at);

-- Tag-based secondary index (only for queried combinations, NOT all 2^n subsets)
-- Hard rule: max 3 tag fields per event type.
CREATE TABLE event_tags (
    tag_key TEXT NOT NULL,
    tag_value TEXT NOT NULL,
    event_type TEXT NOT NULL,
    global_position BIGINT NOT NULL REFERENCES events(global_position),
    PRIMARY KEY (tag_key, tag_value, event_type, global_position)
);

-- Optimistic locking via advisory locks (see concurrency strategy below)
-- No separate locking_positions table needed; use pg_advisory_xact_lock
-- with a deterministic lock key derived from the query tuple set.
```

**Stream key strategy:** No named streams. Every event is tagged. Standard tags for travel domain:

- `passenger_id`, `flight_id`, `booking_id`, `segment_id`, `hotel_id`, `connection_id`
- Use `tag_key:tag_value` format consistently (e.g., `passenger_id:P-42`)

---

## 4.2 Replay Strategy

1. **Full replay** (initial projection build): scan `events` table ordered by `global_position`. Process in batches of 1000. Track `last_processed_position` per projection in a `projection_checkpoints` table.
2. **Catch-up replay** (projection recovery): resume from `last_processed_position`.
3. **Decider replay** (per-command): load events matching query tuples, ordered by `global_position`. Apply `evolve()` to reconstruct state.
4. **Snapshot-accelerated replay**: for entities with >100 events, store snapshots in a `snapshots` table. On decider load, read snapshot + events after snapshot position.

```sql
CREATE TABLE projection_checkpoints (
    projection_name TEXT PRIMARY KEY,
    last_processed_position BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE snapshots (
    tag_key TEXT NOT NULL,
    tag_value TEXT NOT NULL,
    decider_type TEXT NOT NULL,
    state JSONB NOT NULL,
    at_global_position BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tag_key, tag_value, decider_type)
);
```

---

## 4.3 Decision Lifecycle Entities

```sql
CREATE TABLE decisions (
    decision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    correlation_id UUID NOT NULL,              -- groups related decisions
    causation_id UUID,                          -- decision that triggered this one
    command_type TEXT NOT NULL,
    command_payload JSONB NOT NULL,
    actor_id TEXT NOT NULL,
    actor_type TEXT NOT NULL,                   -- 'human', 'system', 'agent'
    state_at_decision JSONB NOT NULL,           -- decider state snapshot
    query_tuples JSONB NOT NULL,                -- tuples + positions read
    decider_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'executed',     -- 'executed', 'rejected', 'pending_approval'
    rejection_reason TEXT,
    justification TEXT,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Join table: links decisions to the events they produced (proper FK + queryable)
CREATE TABLE decision_events (
    decision_id UUID NOT NULL REFERENCES decisions(decision_id),
    event_id UUID NOT NULL REFERENCES events(event_id),
    ordinal INT NOT NULL,                       -- preserves event order within decision
    PRIMARY KEY (decision_id, event_id)
);

CREATE INDEX idx_decisions_correlation ON decisions(correlation_id);
CREATE INDEX idx_decisions_actor ON decisions(actor_id);
CREATE INDEX idx_decisions_command ON decisions(command_type);
CREATE INDEX idx_decision_events_event ON decision_events(event_id);
```

**Decision lifecycle:**

1. `pending_approval` — command received, governance check requires human approval
2. `executed` — decide() ran, events produced
3. `rejected` — governance or decider rejected the command (with reason)

---

## 4.4 Permission Enforcement Points

| Enforcement Point        | What It Checks                                    | Implementation                               |
| ------------------------ | ------------------------------------------------- | -------------------------------------------- |
| API Gateway / Middleware | Authentication, rate limiting, basic role check   | Python middleware (e.g., FastAPI dependency) |
| Command Dispatcher       | `can_actor_submit(actor, command_type)`           | Permission lookup before repository call     |
| Authorization Middleware | `can_actor_affect(actor, command, current_state)` | Runs after state load, before decide()       |
| Event Writer             | Append-only guarantee, schema validation          | DB constraints + write-path validation       |
| Projection Reader        | `can_actor_view(actor, entity_id, fields)`        | Field-level filtering on read model queries  |

---

## 4.5 Minimal Observability Fields

Every event's `metadata` field should contain:

```json
{
	"correlation_id": "uuid — groups all events from one user action",
	"causation_id": "uuid — the event or command that directly caused this event",
	"decision_id": "uuid — FK to decisions table",
	"actor_id": "string — who/what triggered the command",
	"actor_type": "human | system | agent | scheduler",
	"timestamp": "ISO 8601 with timezone",
	"source_service": "string — which worker/service produced this",
	"trace_id": "string — OpenTelemetry trace ID for distributed tracing",
	"schema_version": "int — version of the event payload schema"
}
```

Add to all HTTP responses:

```
X-Correlation-Id: <correlation_id>
X-Decision-Id: <decision_id>
```

---

# 5. Anti-Patterns to Avoid

| #   | Anti-Pattern                                               | Impact                                                                                                            |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | **Stream-per-entity when you need cross-entity decisions** | Forces sagas and compensating events for naturally atomic operations, adding latency and temporary inconsistency. |
| 2   | **Fat events (embedding full state in every event)**       | Bloats storage, makes schema evolution painful, and couples consumers to producer schema.                         |
| 3   | **Mutable event payloads (updating past events)**          | Destroys the append-only invariant that makes event sourcing trustworthy and auditable.                           |
| 4   | **God decider (one decider handles all commands)**         | Creates a coupling bottleneck where every use case change risks breaking all others.                              |
| 5   | **Synchronous projection updates in the write path**       | Write latency becomes proportional to the number of projections, and projection failure blocks writes.            |
| 6   | **Missing idempotency keys on commands**                   | Retry after network failure produces duplicate events, corrupting state.                                          |
| 7   | **Conflating domain events with integration events**       | Internal state transitions leak to external consumers, creating tight coupling across bounded contexts.           |
| 8   | **Unbounded event replay without snapshotting**            | Entity load time grows linearly with history, eventually making operations unacceptably slow.                     |
| 9   | **Optimistic locking without retry strategy**              | Concurrent conflicts cause silent failures or user-facing errors instead of transparent retries.                  |
| 10  | **Projecting from events without tracking position**       | Projection crashes lose progress, requiring full re-projection from the beginning.                                |
| 11  | **Schema evolution by event type renaming**                | Existing events become unreadable; use versioned upcasters instead.                                               |
| 12  | **Storing decisions without the state they were based on** | Makes it impossible to audit why a decision was made or to detect if the logic had a bug.                         |

---

# 6. Architecture Decision Record (ADR) Candidates

## ADR-001: Use Tag-Based Event Indexing Instead of Named Streams

**Decision:** Events are stored in a single table and indexed via a separate `event_tags` table using `(tag_key, tag_value, event_type)` composites. No named streams.

**Status:** Proposed

**Rationale:** The travel domain requires cross-entity queries (passenger + flight + booking). Named streams force a single partitioning dimension. Tag-based indexing supports arbitrary query dimensions without event duplication, as demonstrated by the fraktalio DCB approach.

**Consequences:**

- (+) Flexible query patterns; new use cases don't require restructuring.
- (+) No stream-naming debates; entities are identified by tags.
- (−) Query performance depends on tag index design; requires careful indexing.
- (−) No built-in stream-level ordering; must rely on `global_position`.

---

## ADR-002: Implement DCB Pattern for Cross-Entity Consistency

**Decision:** Use Dynamic Consistency Boundaries where each decider declares its required event tuples, instead of aggregate-based consistency boundaries.

**Status:** Proposed

**Rationale:** Missed-flight-connection rebooking spans Flight, Passenger, and Hotel entities. DCB allows a single decider to atomically validate and decide across these entities without sagas. Proven in fraktalio demo for cross-entity restaurant/order decisions.

**Consequences:**

- (+) Eliminates saga complexity for cross-entity business rules.
- (+) Each decider loads only the events it needs.
- (−) Requires disciplined tuple declaration; errors in tuple specs cause stale-state bugs.
- (−) Less mature pattern; fewer community examples than aggregate-based ES.

---

## ADR-003: Pure Decider Functions with No I/O

**Decision:** All domain decision logic is implemented as pure functions (`decide`, `evolve`, `initial_state`) with no database access, no network calls, and no side effects.

**Status:** Proposed

**Rationale:** Pure functions enable deterministic testing (Given/When/Then specs), full decision provenance (capture inputs → outputs), and safe replay. Demonstrated in fraktalio demo where deciders import zero infrastructure code.

**Consequences:**

- (+) Trivially testable; no mocking required.
- (+) Decision provenance is a natural byproduct.
- (−) External data (fare lookups, seat maps) must be pre-fetched and injected as command context.
- (−) Developers accustomed to Active Record / ORM patterns need to adapt.

---

## ADR-004: Decision Records as First-Class Entities

**Decision:** Every command execution produces a decision record capturing: command, actor, state snapshot, events read positions, events produced, decider version, and justification.

**Status:** Proposed

**Rationale:** Decision/provenance tracking is a core requirement. The fraktalio demo's pure decider pattern makes state capture natural (just serialize the state before `decide()`), but the demo does not actually persist decision records — we must add this.

**Consequences:**

- (+) Full auditability: every state change is traceable to a decision.
- (+) Enables counterfactual analysis and decision replay.
- (−) Additional storage cost (~1 KB per decision).
- (−) State snapshots may contain PII; requires encryption/access controls.

---

## ADR-005: Optimistic Concurrency via Global Position Tracking

**Decision:** Use `global_position` from the events table for optimistic locking. On read, capture max position per query tuple. On write, verify no new matching events exist beyond that position.

**Status:** Proposed

**Rationale:** Fraktalio demo uses Deno KV versionstamps for the same purpose. In Postgres, `global_position` (bigserial) provides a natural, monotonic ordering, while transaction-scoped advisory locks on a deterministic tuple-set key provide atomic write coordination without a separate locking table.

**Consequences:**

- (+) Proven concurrency model; no global locks.
- (+) Retry is straightforward: re-read, re-fold, re-decide.
- (−) Hot entities under high contention need backoff strategies.
- (−) Slightly more complex than simple version counters on aggregates.

---

## ADR-006: Materialized Projections with Checkpoint Tracking

**Decision:** Projections are materialized by background workers that poll the events table by `global_position` and update denormalized read tables. Each projection tracks its `last_processed_position`.

**Status:** Proposed

**Rationale:** Fraktalio demo uses on-demand projections (fold at query time), which is acceptable for a demo but does not scale for production read loads. Materialized projections with checkpoint tracking provide consistent, low-latency reads and crash-recoverable processing.

**Consequences:**

- (+) Read queries are fast (pre-computed).
- (+) Projections can be rebuilt by resetting checkpoint to 0.
- (−) Eventual consistency between write and read models.
- (−) Additional infrastructure (worker processes, monitoring).

---

## ADR-007: Command Authorization as a Separate Layer

**Decision:** Command authorization is implemented as middleware between the API handler and the decider, not inside the decider. Authorization decisions are logged as events.

**Status:** Proposed

**Rationale:** The fraktalio demo has no authorization beyond session gating. Our governance requirements demand fine-grained, auditable permission checks. Keeping authorization outside the decider maintains the decider's purity and allows policy changes without modifying domain logic.

**Consequences:**

- (+) Deciders remain pure and testable without auth context.
- (+) Authorization events provide a full audit trail.
- (−) Two-phase read: load state for auth check, then load (possibly same) state for decision.
- (−) Authorization logic is a separate codebase to maintain and test.

---

## ADR-008: Event Schema Versioning with Upcasters

**Decision:** Each event type carries a `schema_version`. When reading events, upcasters transform older versions to the current schema. Events are never mutated in storage.

**Status:** Proposed

**Rationale:** The fraktalio demo has no schema versioning — events are defined once. In production, event schemas will evolve. Upcasters (functions that transform v1 → v2 → v3 at read time) preserve the append-only invariant while allowing schema evolution.

**Consequences:**

- (+) Events are immutable; no migration scripts on stored data.
- (+) Old consumers can still read old versions; new consumers use upcasters.
- (−) Upcaster chains must be maintained and tested.
- (−) Reading old events may be slightly slower due to transformation.

---

## ADR-009: Correlation and Causation IDs on All Events

**Decision:** Every event carries `correlation_id` (user-initiated action grouping) and `causation_id` (direct parent event/command) in metadata.

**Status:** Proposed

**Rationale:** The fraktalio demo has no correlation tracking. For observability, debugging, and provenance in a multi-worker system, tracing causal chains is essential. This is industry standard for event-driven architectures.

**Consequences:**

- (+) End-to-end tracing from user action to all resulting events.
- (+) Enables impact analysis: "what happened because of this event?"
- (−) Requires discipline to propagate IDs through all code paths.
- (−) Slight increase in event metadata size.

---

## ADR-010: Separate Domain Events from Integration Events

**Decision:** Internal domain events (used within the bounded context) are distinct from integration events (published to external systems). Integration events are derived from domain events by a dedicated publisher.

**Status:** Proposed

**Rationale:** The fraktalio demo operates within a single bounded context with no external integration. In our system, other services (notifications, billing, analytics) need event data but should not couple to our internal event schema.

**Consequences:**

- (+) Internal schema changes don't break external consumers.
- (+) Integration events can be tailored to consumer needs.
- (−) Additional mapping/transformation layer to build and maintain.
- (−) Potential for integration events to drift from domain events if not tested.

---

## ADR-011: Snapshot Strategy for Long-Lived Entities

**Decision:** Entities with more than 100 events get periodic snapshots stored in a dedicated table. Decider state reconstruction loads the latest snapshot plus only subsequent events.

**Status:** Proposed

**Rationale:** The fraktalio demo replays all events on every command (acceptable for short-lived restaurant entities). Travel entities (passengers with years of booking history, flights with thousands of state changes) will accumulate too many events for full replay.

**Consequences:**

- (+) Bounded read time regardless of entity age.
- (+) Snapshots are derived data; can be rebuilt from events.
- (−) Snapshot schema must evolve with decider state schema.
- (−) Snapshot creation logic must be correct; bugs produce corrupted starting state.

---

## ADR-012: Action Outbox for External Side Effects

**Decision:** External side effects (email, airline API calls, notifications) are written as outbox records in the same transaction as domain events. A separate worker processes the outbox with at-least-once delivery semantics.

**Status:** Proposed

**Rationale:** The fraktalio demo has no external side effects — all "actions" are event writes. Our system must trigger real-world actions (send rebooking confirmation, update airline system). The outbox pattern ensures actions are not lost even if the worker crashes.

**Consequences:**

- (+) Atomicity: events and intended actions are committed together.
- (+) At-least-once delivery; consumers must be idempotent.
- (−) Additional table and worker process.
- (−) Ordering guarantees across outbox entries require careful design.

---

# 7. First 2 Iterations Plan

## Iteration 1: Foundation (Weeks 1-3)

### Scope

Stand up the core event-sourced infrastructure and implement the first decider (missed flight connection detection).

### Deliverables

1. **Postgres event store schema**: `events`, `event_tags`, `decisions`, `decision_events`, `projection_checkpoints` tables with indexes. Concurrency via `pg_advisory_xact_lock`.
2. **Python event store library**: `EventStore` class with `append(events, expected_positions)`, `load_by_tuples(tuples)`, and `subscribe(from_position)` methods.
3. **Decider framework**: base `Decider` protocol with `decide()`, `evolve()`, `initial_state`; `EventSourcedRepository` that wires decider + event store + optimistic locking.
4. **First decider**: `DetectMissedConnectionDecider` — given flight delay events and passenger booking events, decides whether to emit `ConnectionMissed` event.
5. **Given/When/Then test framework**: `DeciderSpec` class for pure decider testing.
6. **Basic projection worker**: polls events table by `global_position`, updates a `connections_status` read table.
7. **Decision record capture**: `decisions` table populated on every command execution.

### Acceptance Checks

- [ ] Event store round-trip: append events, load by tuples, verify payload and ordering.
- [ ] Optimistic locking: concurrent writes to overlapping tuples — one succeeds, one retries.
- [ ] DetectMissedConnectionDecider: 5+ Given/When/Then specs covering happy path, edge cases, and error conditions.
- [ ] Projection worker: processes 1000 events, checkpoints correctly, resumes after restart.
- [ ] Decision record: every command execution produces an auditable decision record with state snapshot.

### Main Risks

- **Postgres advisory locks vs. SELECT FOR UPDATE**: need to benchmark under concurrent load to choose the right locking strategy.
- **Tag index query performance**: if the query planner doesn't use the composite index efficiently, reads will be slow. Test with realistic data volumes early.
- **Team unfamiliarity with event sourcing**: allocate time for pattern workshops before coding begins.

---

## Iteration 2: Process/Decision Depth (Weeks 4-6)

### Scope

Add rebooking decision logic, governance/permission layer, and observability infrastructure.

### Deliverables

1. **RebookPassengerDecider**: cross-entity decider spanning Passenger, Flight, and Hotel. Validates: flight capacity, ticket class eligibility, hotel availability. Emits `PassengerRebooked` or `RebookingDenied`.
2. **Command authorization middleware**: `authorize(command, actor, context)` — checks actor permissions against a permission policy store. Emits `AuthorizationGranted` / `AuthorizationDenied` events.
3. **Governance decider**: `ManagePermissionsDecider` — handles `GrantPermission`, `RevokePermission` commands, evolves permission state.
4. **Correlation/causation propagation**: all events carry `correlation_id` and `causation_id` in metadata. HTTP responses include `X-Correlation-Id`.
5. **Action outbox**: `outbox` table + worker for external side effects (rebooking confirmations).
6. **Observability dashboard**: expose `global_position` lag per projection, decision throughput, and error rates via Prometheus metrics.
7. **Event schema versioning**: `schema_version` field on events, first upcaster for evolving `ConnectionMissed` event schema.

### Acceptance Checks

- [ ] RebookPassengerDecider: 10+ specs covering capacity checks, ticket class rules, multi-entity state, concurrent rebooking attempts.
- [ ] Authorization: unauthorized actor is rejected with `AuthorizationDenied` event; authorized actor proceeds.
- [ ] Correlation chain: trace a single user action through all resulting events via `correlation_id`.
- [ ] Outbox: simulated crash between event write and outbox processing — outbox entry is eventually processed.
- [ ] Schema upcaster: events written with v1 schema are correctly upcasted to v2 on read.
- [ ] Load test: 100 concurrent rebooking commands against 10 flights — system handles contention gracefully with <5% retry failures.

### Main Risks

- **Cross-entity decider complexity**: the RebookPassengerDecider reads many event types. Tuple declaration must be precise; missing an event type causes silent stale-state bugs. Mitigate with integration tests that verify tuple completeness.
- **Authorization performance**: permission checks add a read before every command. Cache hot permission state in-process with short TTL.
- **Outbox ordering**: if two outbox entries for the same passenger are processed out of order, external systems may receive inconsistent state. Add sequence numbers per entity in outbox.

---

# 8. Adopt vs Defer

| Pattern / Capability                                         | Adopt Now (Iteration 1-2)                                | Defer Until Measured                                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Pure decider functions (`decide`, `evolve`, `initial_state`) | **Adopt** — foundation of testability and provenance     |                                                                                                                |
| Event table + tag-based indexing                             | **Adopt** — core storage model                           |                                                                                                                |
| Materialized projections with checkpoints                    | **Adopt** — required for read performance                |                                                                                                                |
| Decision records (`decisions` + `decision_events`)           | **Adopt** — core requirement for provenance              |                                                                                                                |
| Action outbox for external side effects                      | **Adopt** — needed as soon as we call airline/hotel APIs |                                                                                                                |
| Given/When/Then spec testing                                 | **Adopt** — cheapest way to validate business rules      |                                                                                                                |
| Correlation/causation ID propagation                         | **Adopt** — essential for observability from day one     |                                                                                                                |
| Advisory-lock-based optimistic concurrency                   | **Adopt** — simpler than CAS for initial load profiles   |                                                                                                                |
| Full DCB tuple combinatorics (2^n subset indexing)           |                                                          | **Defer** — only index actually-queried tuples; revisit if query patterns demand more                          |
| Snapshotting                                                 |                                                          | **Defer** — measure event counts per entity first; implement when any entity routinely exceeds ~200 events     |
| Event schema upcasters                                       |                                                          | **Defer** — start with additive-only schema changes; build upcaster infra when first breaking change is needed |
| On-demand (fold-at-read) projections                         |                                                          | **Defer** — only use for low-volume audit views if materialized projections prove insufficient                 |
| Process manager / saga framework                             |                                                          | **Defer** — start with outbox; build saga infra only when multi-step compensations are needed                  |

---

# 9. Travel Scenario Walkthrough: Missed Flight Connection

End-to-end event flow mapped to exact tables and fields.

### Scenario

Passenger P-42 has a booking with two segments: Flight F-100 (AMS→FRA) connecting to Flight F-200 (FRA→JFK). Flight F-100 is delayed, causing P-42 to miss the connection. The system detects, proposes a rebook, gets approval, executes, and records the outcome.

### Event Flow

```
Step 1: FlightDelayed
─────────────────────────────────────────────────────────────
  events table:
    global_position: 1001
    event_id: evt-aaa
    event_type: "FlightDelayed"
    payload: { "flight_id": "F-100", "new_departure": "2026-04-01T16:30Z",
               "delay_minutes": 90 }
    metadata: { "correlation_id": "corr-001", "source_service": "flight-ops" }

  event_tags:
    (flight_id, F-100, FlightDelayed, 1001)
    (booking_id, B-77, FlightDelayed, 1001)

Step 2: ConnectionMissed  (produced by DetectMissedConnectionDecider)
─────────────────────────────────────────────────────────────
  Command: DetectMissedConnection { passenger_id: "P-42", booking_id: "B-77" }
  Decider reads tuples:
    (booking_id, B-77, FlightBooked)
    (flight_id, F-100, FlightDelayed)
    (flight_id, F-200, FlightDeparted)  -- not yet → connection still possible?
  decide(): delay_minutes(90) > min_connection_time(60) → emit ConnectionMissed

  events table:
    global_position: 1002
    event_type: "ConnectionMissed"
    payload: { "passenger_id": "P-42", "booking_id": "B-77",
               "missed_flight": "F-200", "reason": "insufficient_connection_time" }

  event_tags:
    (passenger_id, P-42, ConnectionMissed, 1002)
    (booking_id, B-77, ConnectionMissed, 1002)

  decisions table:
    decision_id: dec-001
    command_type: "DetectMissedConnection"
    actor_type: "system"
    state_at_decision: { "delay_minutes": 90, "min_connection": 60, ... }
    decider_version: "v1.0.0"

  decision_events: (dec-001, evt-bbb, 0)

Step 3: RebookProposed  (produced by ProposeRebookDecider)
─────────────────────────────────────────────────────────────
  Command: ProposeRebook { passenger_id: "P-42", target_flight: "F-210" }
  Decider reads tuples:
    (passenger_id, P-42, ConnectionMissed)
    (passenger_id, P-42, PassengerRebooked)  -- not yet → no prior rebook
    (flight_id, F-210, FlightCapacityChanged)

  events table:
    global_position: 1003
    event_type: "RebookProposed"
    payload: { "passenger_id": "P-42", "from_flight": "F-200",
               "to_flight": "F-210", "fare_difference": 0,
               "hotel_needed": true }

  event_tags:
    (passenger_id, P-42, RebookProposed, 1003)
    (flight_id, F-210, RebookProposed, 1003)

Step 4: RebookApproved  (governance layer)
─────────────────────────────────────────────────────────────
  Authorization middleware checks:
    - actor: "agent-007" (duty manager)
    - policy: fare_difference == 0 → auto-approvable
    - result: approved (no human sign-off needed)

  events table:
    global_position: 1004
    event_type: "RebookApproved"
    payload: { "passenger_id": "P-42", "approved_by": "system/auto-policy",
               "policy_ref": "POL-fare-zero-auto" }

Step 5: PassengerRebooked  (produced by RebookPassengerDecider)
─────────────────────────────────────────────────────────────
  Command: RebookPassenger { passenger_id: "P-42", to_flight: "F-210" }
  Decider reads tuples:
    (passenger_id, P-42, RebookApproved)
    (passenger_id, P-42, PassengerRebooked)
    (flight_id, F-210, FlightCapacityChanged)

  events table:
    global_position: 1005
    event_type: "PassengerRebooked"
    payload: { "passenger_id": "P-42", "from_flight": "F-200",
               "to_flight": "F-210", "seat": "14A" }

  decisions table:
    decision_id: dec-003
    correlation_id: corr-001  (same chain as original delay)
    state_at_decision: { "approved": true, "capacity_f210": 42, ... }

  decision_events: (dec-003, evt-eee, 0)

  outbox (for external side effects):
    - Send rebooking confirmation email to P-42
    - Call airline GDS API to update PNR
    - Reserve hotel room (hotel_needed=true)

Step 6: OutcomeRecorded  (after external actions complete)
─────────────────────────────────────────────────────────────
  events table:
    global_position: 1008
    event_type: "RebookOutcomeRecorded"
    payload: { "passenger_id": "P-42", "booking_id": "B-77",
               "outcome": "completed",
               "gds_confirmation": "XKCD42",
               "hotel_confirmation": "HTL-999" }
```

### Projection Updates (materialized)

| Read Table          | Updated By Events                                                | Sample Row                                                              |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `connection_status` | `ConnectionMissed`, `PassengerRebooked`, `RebookOutcomeRecorded` | `{booking_id: B-77, status: "rebooked", new_flight: F-210}`             |
| `passenger_journey` | All passenger-tagged events                                      | `{passenger_id: P-42, segments: [{F-100, delayed}, {F-210, rebooked}]}` |
| `flight_capacity`   | `FlightCapacityChanged`, `PassengerRebooked`                     | `{flight_id: F-210, available: 41}`                                     |

---

# 10. Minimum MVP Schema (Iteration 1 Only)

Only the must-have tables to get the event store, first decider, projections, and decision tracking running. No outbox, no snapshots, no governance — those come in Iteration 2.

```sql
-- ============================================================
-- MVP SCHEMA: 4 tables, ready for DetectMissedConnectionDecider
-- ============================================================

-- 1. Append-only event log
CREATE TABLE events (
    global_position BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    schema_version INT NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_type ON events(event_type);

-- 2. Tag-based secondary index (only queried combinations, max 3 tags/event)
CREATE TABLE event_tags (
    tag_key TEXT NOT NULL,
    tag_value TEXT NOT NULL,
    event_type TEXT NOT NULL,
    global_position BIGINT NOT NULL REFERENCES events(global_position),
    PRIMARY KEY (tag_key, tag_value, event_type, global_position)
);

-- 3. Decision audit trail
CREATE TABLE decisions (
    decision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    correlation_id UUID NOT NULL,
    causation_id UUID,
    command_type TEXT NOT NULL,
    command_payload JSONB NOT NULL,
    actor_id TEXT NOT NULL,
    actor_type TEXT NOT NULL DEFAULT 'system',
    state_at_decision JSONB NOT NULL,
    query_tuples JSONB NOT NULL,
    decider_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'executed',
    rejection_reason TEXT,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_decisions_correlation ON decisions(correlation_id);

-- 3b. Decision-to-event join
CREATE TABLE decision_events (
    decision_id UUID NOT NULL REFERENCES decisions(decision_id),
    event_id UUID NOT NULL REFERENCES events(event_id),
    ordinal INT NOT NULL,
    PRIMARY KEY (decision_id, event_id)
);

-- 4. Projection checkpoint tracker
CREATE TABLE projection_checkpoints (
    projection_name TEXT PRIMARY KEY,
    last_processed_position BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Concurrency: use pg_advisory_xact_lock(hashtext(tuple_set_key))
-- inside the transaction that reads events and appends new ones.
-- No separate locking table needed for MVP.
```

**What is intentionally excluded from MVP:**

- `outbox` table — not needed until Iteration 2 when external side effects are introduced
- `snapshots` table — defer until measured; no entity will have >200 events in early iterations
- Governance/permission tables — Iteration 2 scope
- Integration event publisher — Iteration 2 scope

---

# 11. Source-Cited Evidence

| Claim                                                                                             | Source                                                                                                                                                                                                                         | Type                                  |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| DCB defines consistency boundaries per use case, not per entity                                   | [README.md](https://github.com/fraktalio/order-management-demo/blob/main/README.md): "Unlike the traditional aggregate pattern, DCB defines consistency boundaries per use case rather than per entity"                        | Directly observed                     |
| `placeOrderDecider` spans Restaurant + Order entities in one decision                             | [`lib/placeOrderDecider.ts`](https://github.com/fraktalio/order-management-demo/blob/main/lib/placeOrderDecider.ts): input events include `RestaurantCreatedEvent`, `RestaurantMenuChangedEvent`, `RestaurantOrderPlacedEvent` | Directly observed                     |
| `placeOrderRepository` declares cross-entity tuple queries                                        | [`lib/placeOrderRepository.ts`](https://github.com/fraktalio/order-management-demo/blob/main/lib/placeOrderRepository.ts): tuples span `restaurantId` and `orderId` tags                                                       | Directly observed                     |
| Events are stored in primary KV with secondary tag indexes                                        | [README.md](https://github.com/fraktalio/order-management-demo/blob/main/README.md): three-key pattern table (primary storage, tag index, last event pointer)                                                                  | Directly observed                     |
| Tag subsets are auto-generated (2^n − 1 combinations)                                             | [README.md](https://github.com/fraktalio/order-management-demo/blob/main/README.md): "The repository auto-generates all tag subset combinations"                                                                               | Directly observed                     |
| Optimistic locking via versionstamps on last-event pointers                                       | [README.md](https://github.com/fraktalio/order-management-demo/blob/main/README.md): "Last event pointers enable optimistic locking via Deno KV versionstamp checks"                                                           | Directly observed                     |
| Decider functions are pure (no I/O imports)                                                       | All decider files (`lib/*Decider.ts`) import only from `lib/api.ts` and `@fraktalio/fmodel-decider` — no KV/HTTP/DB imports                                                                                                    | Directly observed                     |
| Testing uses Given/When/Then via `DeciderEventSourcedSpec`                                        | [`lib/placeOrderDecider_test.ts`](https://github.com/fraktalio/order-management-demo/blob/main/lib/placeOrderDecider_test.ts): `.given([events]).when(command).then([expectedEvents])`                                         | Directly observed                     |
| Views use exhaustive pattern matching with TypeScript `never` check                               | [`lib/orderView.ts`](https://github.com/fraktalio/order-management-demo/blob/main/lib/orderView.ts): `const _exhaustiveCheck: never = event`                                                                                   | Directly observed                     |
| On-demand projection (no materialized read DB)                                                    | [`lib/orderViewEventLoader.ts`](https://github.com/fraktalio/order-management-demo/blob/main/lib/orderViewEventLoader.ts): `EventSourcedQueryHandler` folds events at query time                                               | Directly observed                     |
| No governance, permission, or audit layer exists                                                  | Full codebase review: auth limited to GitHub OAuth session in middleware; no role-based checks, no policy engine                                                                                                               | Directly observed                     |
| No correlation IDs, tracing, or metrics in event metadata                                         | `lib/api.ts` event types contain only `kind`, `tagFields`, `final`, and domain-specific fields                                                                                                                                 | Directly observed                     |
| No event versioning or schema migration strategy                                                  | No `schema_version` field on any event type; no upcaster code present                                                                                                                                                          | Directly observed                     |
| No snapshotting mechanism                                                                         | Full codebase search: no snapshot-related code or configuration                                                                                                                                                                | Directly observed                     |
| Property-based testing with fast-check for API handlers                                           | [`routes/api/restaurant/index_test.ts`](https://github.com/fraktalio/order-management-demo/blob/main/routes/api/restaurant/index_test.ts): fast-check arbitrary generators for commands                                        | Directly observed                     |
| DCB pattern originates from Sara Pellegrini's work                                                | [dcb.events](https://dcb.events/), referenced in fraktalio ecosystem documentation                                                                                                                                             | Inference from web research           |
| DCB eliminates need for sagas in **synchronous atomic decisions** (not for external side effects) | Inference from demo architecture: `placeOrderDecider` handles cross-entity logic without any saga/process manager code; but demo has no external I/O                                                                           | Inference from code analysis          |
| On-demand projections don't scale for high read loads                                             | Inference: each read requires loading and folding all matching events; latency is O(N) with event count                                                                                                                        | Inference from architectural analysis |
| Tag subset explosion risk with many tag fields                                                    | Inference: 2^n − 1 combinations; event with 5 tag fields = 31 index entries per event                                                                                                                                          | Inference from mathematical analysis  |

---

_Document generated 2026-03-30. Based on analysis of [fraktalio/order-management-demo](https://github.com/fraktalio/order-management-demo) at commit history through 2026-03-29._

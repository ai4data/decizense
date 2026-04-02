# Travel Booking Journey Demo

Synthetic Enterprise Simulation for Multi-Agent Reasoning with Context Graphs

---

# 1. Purpose of This Demo

This demo simulates a **travel booking platform** where customers search for flights, book itineraries, and travel through a journey lifecycle.

The goal is to demonstrate how:

- a context graph provides semantic meaning, decision reasoning, and temporal awareness
- multiple AI agents collaborate across domains (finance, operations, customer) to make reliable decisions
- business rules enforce domain constraints with traceable rationale
- process mining reveals operational insights from event-driven decision traces
- synthetic enterprise data simulates real operations without using production data

The demo creates a **living travel company** where bookings, payments, seat availability, and delays continuously evolve.

AI agents interact with this environment to answer operational, analytical, and decision questions — not just SQL queries.

---

# 2. The Synthetic Company

The simulated company operates like an online travel agency.

Example companies in this space include:

- flight booking platforms
- travel aggregators
- airline reservation systems

The platform manages:

- customers
- flights
- airports
- bookings
- payments
- check-ins
- boarding
- delays and cancellations

---

# 3. Core Business Entities

The synthetic database contains several key tables.

### Customers

| customer_id | name         | country | signup_date |
| ----------- | ------------ | ------- | ----------- |
| C101        | Alice Smith  | UK      | 2026-01-05  |
| C102        | Daniel Perez | Spain   | 2026-01-12  |
| C103        | Emma Brown   | USA     | 2026-02-02  |

---

### Airports

| airport_code | city     | country |
| ------------ | -------- | ------- |
| LHR          | London   | UK      |
| CDG          | Paris    | France  |
| JFK          | New York | USA     |

---

### Flights

| flight_id | airline | origin | destination | departure_time   |
| --------- | ------- | ------ | ----------- | ---------------- |
| F1001     | SkyJet  | LHR    | CDG         | 2026-03-20 09:00 |
| F1002     | SkyJet  | CDG    | JFK         | 2026-03-20 13:00 |

---

### Bookings

| booking_id | customer_id | booking_date | status    |
| ---------- | ----------- | ------------ | --------- |
| B2001      | C101        | 2026-03-01   | confirmed |
| B2002      | C103        | 2026-03-02   | confirmed |

---

### Tickets

| ticket_id | booking_id | flight_id | seat_number |
| --------- | ---------- | --------- | ----------- |
| T5001     | B2001      | F1001     | 12A         |
| T5002     | B2001      | F1002     | 14C         |

---

### Payments

| payment_id | booking_id | amount | status  |
| ---------- | ---------- | ------ | ------- |
| PAY3001    | B2001      | 550    | success |

---

### Check-ins

| checkin_id | ticket_id | checkin_time     | status    |
| ---------- | --------- | ---------------- | --------- |
| CH9001     | T5001     | 2026-03-20 07:30 | completed |

---

# 4. The Event Log (The Heart of the Simulation)

The simulator continuously generates events describing traveler activity.

| event_id | timestamp | event_type         | booking_id |
| -------- | --------- | ------------------ | ---------- |
| E1       | 10:00     | CustomerRegistered | C101       |
| E2       | 10:05     | FlightSearched     | NULL       |
| E3       | 10:07     | FlightSelected     | F1001      |
| E4       | 10:08     | BookingCreated     | B2001      |
| E5       | 10:09     | PaymentSucceeded   | B2001      |
| E6       | 07:30     | CheckInCompleted   | B2001      |
| E7       | 08:45     | BoardingStarted    | F1001      |
| E8       | 09:00     | FlightDeparted     | F1001      |
| E9       | 10:20     | FlightArrived      | F1001      |

Each booking becomes a **process instance** and a **decision trace**.

In process mining terms: `case_id = booking_id`

In context graph terms: each event is a decision node with timestamp, actor, outcome, and causal links to prior events.

---

# 5. Travel Journey Lifecycle

Each traveler follows a journey lifecycle.

Typical process:

```
CustomerRegistered
↓
FlightSearched
↓
FlightSelected
↓
BookingCreated
↓
PaymentSucceeded
↓
TicketIssued
↓
CheckInCompleted
↓
BoardingStarted
↓
FlightDeparted
↓
FlightArrived
```

This lifecycle becomes the **operational process** that agents must understand — not just the data, but the sequence, timing, and constraints between steps.

---

# 6. Context Graph

The context graph goes beyond entity relationships. It captures meaning, reasoning, temporal expectations, and decision history.

### Governance Layer — Policy Enforcement (already built in dazense)

This is the foundation. Everything else builds on top of it.

**Classifications and PII:**

```
class:PII ── CLASSIFIES ──→ column:customers/name
class:PII ── CLASSIFIES ──→ column:customers/country
class:PII ── CLASSIFIES ──→ column:customers/signup_date
class:Financial ── CLASSIFIES ──→ column:payments/amount
```

**Policy enforcement:**

```
policy:travel ── BLOCKS ──→ column:customers/name        (PII — never in query results)
policy:travel ── BLOCKS ──→ column:customers/country      (PII — aggregation only)
```

**Dataset bundle (trust boundary):**

```
bundle:travel-ops ── CONTAINS ──→ table:flights
bundle:travel-ops ── CONTAINS ──→ table:bookings
bundle:travel-ops ── CONTAINS ──→ table:tickets
bundle:travel-ops ── CONTAINS ──→ table:payments
bundle:travel-ops ── CONTAINS ──→ table:checkins
bundle:travel-ops ── ALLOWS_JOIN ──→ join:bookings.customer_id=customers.customer_id
bundle:travel-ops ── ALLOWS_JOIN ──→ join:tickets.flight_id=flights.flight_id
bundle:travel-ops ── REQUIRES_TIME_FILTER ──→ table:bookings
```

**Semantic model (measures and dimensions):**

```
model:bookings ── WRAPS ──→ table:bookings
  measure:total_bookings ── AGGREGATES ──→ column:bookings/booking_id (COUNT)
  measure:total_revenue ── AGGREGATES ──→ column:payments/amount (SUM, WHERE status='success')
  measure:avg_ticket_price ── AGGREGATES ──→ column:payments/amount (AVG)
  dim:booking_status ── READS ──→ column:bookings/status
  dim:booking_date ── READS ──→ column:bookings/booking_date

model:flights ── WRAPS ──→ table:flights
  measure:total_flights ── AGGREGATES ──→ column:flights/flight_id (COUNT)
  measure:delayed_flights ── AGGREGATES ──→ column:flights/flight_id (COUNT, WHERE actual_departure > scheduled_departure)
  measure:delay_rate ── DERIVED_FROM ──→ measure:delayed_flights / measure:total_flights
  dim:airline ── READS ──→ column:flights/airline
  dim:origin ── READS ──→ column:flights/origin
  dim:destination ── READS ──→ column:flights/destination
```

**Business rules (governance):**

```
rule:payment_before_confirmation ── APPLIES_TO ──→ model:bookings
rule:seat_uniqueness ── APPLIES_TO ──→ model:flights
rule:checkin_window ── APPLIES_TO ──→ model:flights
rule:overbooking_limit ── APPLIES_TO ──→ model:flights
rule:rebooking_priority ── APPLIES_TO ──→ model:bookings
```

**Catalog enrichment (from OpenMetadata/Atlan):**

```
glossary:Revenue ── DESCRIBES ──→ table:payments
glossary:FlightDisruption ── DESCRIBES ──→ table:flights
glossary:CheckIn ── DESCRIBES ──→ table:checkins
table:raw_bookings ── PIPELINE_FEEDS ──→ table:stg_bookings ── PIPELINE_FEEDS ──→ table:bookings
table:raw_flights ── PIPELINE_FEEDS ──→ table:stg_flights ── PIPELINE_FEEDS ──→ table:flights
```

This is what dazense already provides: classifications, PII blocking, bundle restrictions, semantic measures, business rules, catalog lineage, and glossary terms — all compiled into a typed graph with lineage, impact analysis, and gap detection.

### Structural Layer — Entity Relationships

The structural layer extends the governance graph with domain-specific entity relationships:

```
Customer → makes → Booking
Booking → contains → Ticket
Ticket → assigned_to → Flight
Flight → departs_from → Airport
Flight → arrives_at → Airport
Booking → paid_by → Payment
```

### Semantic Layer — Ontology and Intent

**Concepts:**

```
TravelJourney IS_A Process
  Booking IS_A TravelJourney step
  CheckIn IS_A TravelJourney step
  Boarding IS_A TravelJourney step

FlightDisruption IS_A OperationalEvent
  Delay IS_A FlightDisruption
  Cancellation IS_A FlightDisruption
  Diversion IS_A FlightDisruption

Customer IS_A Person
  FrequentFlyer IS_A Customer (loyalty_tier = gold|platinum)
  ConnectingPassenger IS_A Customer (has tickets on 2+ flights)
```

**Intents — what questions map to which data:**

```
"Will passengers miss connections?" → ANSWERS: tickets, flights, departure_times, connection_window
"Where do bookings fail?" → ANSWERS: event_log filtered by PaymentFailed|SeatUnavailable
"Which flights will be late?" → ANSWERS: flights, delay_history, weather_data
"Can this passenger check in?" → ANSWERS: booking_status, departure_time, checkin_window_rule
```

### Decision Layer — Rationale and Precedent

Every business rule has a traceable reason:

```
Rule: "Check-in closes 45 minutes before departure"
  Rationale:
    source: regulation
    reference: "EU-261/2004 Article 3"
    description: "Minimum connection time required for security processing"

Rule: "Overbooking cannot exceed 105% of capacity"
  Rationale:
    source: policy
    reference: "OPS-POLICY-2025-12"
    description: "Historical no-show rate is 4.8%. 105% limit balances revenue vs rebooking cost."
    author: revenue-management-team
    date: 2025-06-15

Rule: "Rebooking must prioritize connecting passengers"
  Rationale:
    source: incident
    reference: "INC-2025-0891"
    description: "In March 2025, 23 passengers missed connections at CDG because rebooking prioritized by ticket class, not connection urgency."
```

**Exceptions:**

```
Exception: "Allow late check-in for platinum frequent flyers"
  overrides: "Check-in closes 45 minutes before departure"
  scope: customers WHERE loyalty_tier = 'platinum'
  granted_by: customer-experience-director
  expires: 2027-01-01
  justification: "Platinum members represent 40% of revenue. Late check-in accommodated via priority boarding."
```

### Temporal Layer — Freshness and SLAs

```
Table: flights
  expectations:
    - type: freshness
      max_delay_minutes: 5
      description: "Flight status must be near real-time for disruption decisions"

Table: bookings
  expectations:
    - type: freshness
      max_delay_minutes: 15

Table: delay_history
  expectations:
    - type: freshness
      max_delay_hours: 24
      description: "Historical patterns, daily refresh sufficient"
```

The agent checks freshness before answering. If flight data is 30 minutes stale during a disruption, the agent warns: "Flight status may be outdated. Last update was 30 minutes ago (SLA: 5 minutes)."

---

# 7. Business Rules

The system enforces realistic constraints with traceable rationale.

### Booking Rules

| Rule                                 | Constraint                                                 | Rationale                                                      |
| ------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------- |
| Payment before confirmation          | A booking cannot be confirmed without a successful payment | Prevents inventory lock on unpaid reservations (INC-2024-0156) |
| Seat uniqueness                      | Seat numbers must be unique per flight                     | Physical constraint — one seat, one passenger                  |
| Booking immutability after departure | Bookings cannot be modified after the first flight departs | Legal: ticket terms and conditions, section 4.2                |

### Operational Rules

| Rule              | Constraint                                  | Rationale                                      |
| ----------------- | ------------------------------------------- | ---------------------------------------------- |
| Check-in window   | Check-in closes 45 minutes before departure | EU-261/2004 security processing requirement    |
| Boarding sequence | A flight must depart after boarding begins  | Operational: boarding → doors close → pushback |
| Overbooking limit | Cannot exceed 105% of flight capacity       | OPS-POLICY-2025-12: 4.8% no-show rate baseline |

### Disruption Rules

| Rule                    | Constraint                                            | Rationale                                   |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------- |
| Rebooking priority      | Connecting passengers reboooked before point-to-point | INC-2025-0891: 23 missed connections at CDG |
| Compensation threshold  | Delays > 3 hours trigger EU-261 compensation          | EU regulation — non-negotiable              |
| Re-accommodation window | Must offer alternative within 24 hours                | Company SLA: customer-first-policy-v3       |

These rules act as **guardrails for AI agents** — with rationale that explains WHY, not just WHAT.

---

# 8. Synthetic Operational Behavior

The simulator introduces realistic dynamics.

### Demand spikes

- holiday travel season
- flash promotions
- event-driven demand (conferences, sports)

### Flight delays

- weather disruption
- airport congestion
- late aircraft arrival (cascading delays)

### Booking failures

- payment declined
- seat unavailable
- currency conversion error

### Overbooking scenarios

- flight capacity exceeded
- re-accommodation required
- voluntary vs involuntary denied boarding

These conditions allow testing **agent reasoning under uncertainty** — not just querying data, but making decisions when the situation is ambiguous.

---

# 9. Multi-Agent Architecture

This demo requires multiple specialized agents collaborating through the context graph.

```
Customer asks: "My flight F1001 is delayed. Will I make my connection to JFK?"

┌─────────────────────────────────────────────────────┐
│  Orchestrator Agent                                  │
│  Breaks question into sub-tasks                      │
│  Queries context graph for entity relationships      │
└──────────┬──────────┬──────────┬────────────────────┘
           │          │          │
     ┌─────▼──┐ ┌─────▼──┐ ┌────▼─────┐
     │Flight  │ │Booking │ │Customer  │
     │Ops     │ │Agent   │ │Service   │
     │Agent   │ │        │ │Agent     │
     └────────┘ └────────┘ └──────────┘
```

**Flight Ops Agent** (access: flights, delays, airports):

```
Context graph provides:
  - F1001 current delay: 45 min (temporal: data fresh, 2 min ago)
  - Connection: F1002 departs CDG 13:00, minimum connection time 60 min
  - F1001 new arrival: 10:15 (was 09:30)
  - Connection window: 10:15 → 13:00 = 2h 45min
  - Precedent: similar delays at CDG resolved without rebooking 94% of time

Returns: "Connection is safe. 2h 45min buffer after delay."
```

**Booking Agent** (access: bookings, tickets, payments):

```
Context graph provides:
  - Customer C101 has booking B2001 with 2 tickets (F1001 + F1002)
  - Booking status: confirmed, payment: success
  - Rule: connecting passengers get priority rebooking IF connection at risk

Returns: "Booking intact. No rebooking needed. Both tickets valid."
```

**Customer Service Agent** (access: customers, loyalty, communication):

```
Context graph provides:
  - Customer C101: Alice Smith, UK, frequent flyer (gold tier)
  - Exception: gold tier gets lounge access during delays > 30 min
  - Communication rule: proactive notification required for delays > 30 min

Returns: "Alice should receive delay notification and lounge voucher."
```

**Orchestrator combines:**

```
"Your connection to JFK is safe. F1001 is delayed 45 minutes but you'll
arrive at CDG at 10:15, giving you 2h 45min before your 13:00 departure.

As a Gold frequent flyer, you have access to the SkyJet lounge at CDG
during the wait. You'll receive a notification with updated gate info.

No rebooking needed — both tickets remain valid.

Confidence: HIGH (flight data updated 2 minutes ago, connection buffer
exceeds minimum by 1h 45min, 94% of similar delays resolved without
rebooking)."
```

**Decision trace saved** — next time a similar question is asked, the agent has precedent.

---

# 10. Process Mining Integration

Because the simulator generates events, the system produces **perfect process mining logs**.

Example log:

| case_id | activity         | timestamp |
| ------- | ---------------- | --------- |
| B2001   | BookingCreated   | 10:08     |
| B2001   | PaymentSucceeded | 10:09     |
| B2001   | CheckInCompleted | 07:30     |
| B2001   | BoardingStarted  | 08:45     |
| B2001   | FlightDeparted   | 09:00     |

Process mining tools can then discover:

- the actual travel process vs the expected process
- delays between steps (bottleneck detection)
- process variations (happy path vs disruption path)
- operational bottlenecks (payment processing, check-in queues)

Combined with the context graph, agents can answer: "Where do most booking failures occur AND why?" — not just the step, but the rationale and precedent.

---

# 11. Example AI Agent Questions

The AI agent interacts with this simulated environment across multiple levels.

### Operational reasoning

"Which flights are likely to depart late today?"
→ Requires: delay_history patterns + weather data + current flight status + temporal freshness

### Customer analytics

"Which customers booked connecting flights this week?"
→ Requires: ontology (ConnectingPassenger concept) + booking/ticket traversal

### Process insights

"Where do most booking failures occur?"
→ Requires: event log analysis + decision traces (why did payments fail?)

### Disruption analysis

"Which passengers will miss their connecting flights if flight F1001 is delayed by 2 hours?"
→ Requires: ticket → flight lineage + departure times + minimum connection time rule + rebooking priority rule

### Decision with precedent

"Should we proactively rebook passengers on F1001?"
→ Requires: delay severity + connection risk assessment + historical precedent (similar situations) + rebooking cost vs compensation cost + customer tier

---

# 12. Demonstrating AI Failure Modes

The demo can intentionally break context to show why the context graph matters.

### Missing relationship

Remove: `Ticket → Flight`

Ask: "Which passengers are on flight F1001?"

The agent may hallucinate incorrect joins. **The context graph prevents this** by providing explicit entity relationships.

### Missing rationale

Remove: rationale from "check-in closes 45 minutes before departure"

Ask: "Why can't I check in?"

The agent can only say "the rule says so" — no explanation of the regulation or reasoning. **Decision context provides the WHY.**

### Stale data

Set flight data freshness to 2 hours old during a disruption.

Ask: "Is my connection safe?"

Without the temporal layer, the agent answers confidently with stale data. **Temporal awareness warns the user** that the answer may be unreliable.

### No precedent

Ask: "Should we rebook passengers?" for a new type of disruption.

Without decision traces, the agent has no historical reference. **With precedent**, the agent can say "in 3 similar situations, rebooking was triggered when delay exceeded 90 minutes."

---

# 13. What This Demo Shows

This simulation demonstrates the full context graph stack.

### 1. Context graphs > SQL

Agents don't just query tables — they traverse relationships, check rules, validate freshness, and search precedent. No single SQL query answers "should we rebook passengers?"

### 2. Multi-agent collaboration

No single agent has the full picture. The flight ops agent knows delays, the booking agent knows tickets, the customer agent knows loyalty status. The context graph is their shared memory.

### 3. Decision traces as institutional memory

Every decision is recorded. Next time a similar disruption occurs, agents have precedent — not just data, but reasoning.

### 4. Governance with rationale

Rules aren't arbitrary. "Check-in closes 45 min before departure" has a regulatory reference. "Rebooking prioritizes connecting passengers" has an incident history. Agents can explain WHY.

### 5. Temporal awareness

Agents know when data was last updated and whether it meets SLA. During disruptions, stale data can lead to wrong decisions — the temporal layer prevents this.

### 6. Synthetic environments for safe experimentation

Realistic data without production risk. Break the context graph, introduce disruptions, test edge cases — all safely.

---

# 14. Why Travel Booking Is the Right Demo

Travel booking includes complexities that map directly to enterprise decision-making:

| Travel complexity                             | Enterprise equivalent                      |
| --------------------------------------------- | ------------------------------------------ |
| Multi-step booking process                    | Order-to-cash, procurement lifecycle       |
| Time dependencies (connections)               | SLA chains, dependent workflows            |
| Resource constraints (seats)                  | Inventory, capacity planning               |
| External disruptions (weather)                | Market changes, supply chain disruptions   |
| Multiple entities (customer, flight, airport) | Multiple domains (finance, operations, HR) |
| Regulatory constraints (EU-261)               | Compliance (GDPR, SOX, PCI-DSS)            |
| Overbooking decisions                         | Risk management, resource allocation       |

This makes it ideal for demonstrating:

- AI reasoning under uncertainty
- Multi-agent collaboration
- Context graph traversal
- Process intelligence
- Operational analytics with governance

---

# 15. Alignment with Dazense

This PRD demonstrates dazense as an **enterprise context platform for AI agents**, not just an analytics copilot.

### Context graph layers used

| Layer      | How it's used in this demo                                              |
| ---------- | ----------------------------------------------------------------------- |
| Structural | Entity relationships (Customer → Booking → Ticket → Flight)             |
| Semantic   | Ontology (ConnectingPassenger, FlightDisruption), intent mapping        |
| Temporal   | Freshness SLAs on flight data, staleness warnings during disruptions    |
| Decision   | Rationale on rules, exception handling, precedent from past disruptions |

### Implementation alignment

- Catalog integration: flight and booking metadata managed in catalog platform (OpenMetadata/Atlan)
- Policy engine: check-in rules, overbooking limits, PII blocking on customer data
- Governance graph: compiled from YAML (semantic model, business rules, policy, dataset bundle)
- Agent tools: graph_explain, graph_lineage, graph_impact, graph_gaps
- Multi-agent: orchestrator + domain-specific agents communicating via context graph
- Decision traces: every agent decision persisted as precedent for future reasoning

### Related documents

- MVP execution plan: `docs/digital-twin-mvp-plan.md`
- Disruption scenario addendum: `docs/prd-flight-travel-disruption.md`
- Platform architecture: `docs/architecture_synthetic_company.md`
- Context graph vision: `dazense/docs/context-graph-vision.md`
- Enterprise roadmap: `dazense/docs/enterprise-roadmap.md`

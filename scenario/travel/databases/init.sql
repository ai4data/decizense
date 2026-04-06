-- Travel Booking Database Schema
-- Ontology-aligned: every FK relationship maps to an entity relationship in the context graph

-- Required for gen_random_uuid() in memory_entries
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Airlines
CREATE TABLE airlines (
    airline_code VARCHAR(3) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    country VARCHAR(50) NOT NULL
);

-- Airports
CREATE TABLE airports (
    airport_code VARCHAR(4) PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    city VARCHAR(100) NOT NULL,
    country VARCHAR(50) NOT NULL,
    timezone VARCHAR(50) NOT NULL
);

-- Flights
CREATE TABLE flights (
    flight_id SERIAL PRIMARY KEY,
    flight_number VARCHAR(10) NOT NULL,
    airline_code VARCHAR(3) NOT NULL REFERENCES airlines(airline_code),
    origin VARCHAR(4) NOT NULL REFERENCES airports(airport_code),
    destination VARCHAR(4) NOT NULL REFERENCES airports(airport_code),
    scheduled_departure TIMESTAMP NOT NULL,
    scheduled_arrival TIMESTAMP NOT NULL,
    actual_departure TIMESTAMP,
    actual_arrival TIMESTAMP,
    status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'boarding', 'departed', 'arrived', 'cancelled', 'delayed')),
    aircraft_type VARCHAR(20) NOT NULL,
    capacity INTEGER NOT NULL,
    CONSTRAINT different_airports CHECK (origin != destination)
);

-- Customers (PII: first_name, last_name, email, phone)
CREATE TABLE customers (
    customer_id SERIAL PRIMARY KEY,
    first_name VARCHAR(50) NOT NULL,
    last_name VARCHAR(50) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    phone VARCHAR(20),
    country VARCHAR(50) NOT NULL,
    loyalty_tier VARCHAR(10) NOT NULL DEFAULT 'standard'
        CHECK (loyalty_tier IN ('standard', 'silver', 'gold', 'platinum')),
    signup_date DATE NOT NULL
);

-- Bookings
CREATE TABLE bookings (
    booking_id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
    booking_date TIMESTAMP NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
    total_amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'EUR'
);

-- Tickets
CREATE TABLE tickets (
    ticket_id SERIAL PRIMARY KEY,
    booking_id INTEGER NOT NULL REFERENCES bookings(booking_id),
    flight_id INTEGER NOT NULL REFERENCES flights(flight_id),
    seat_number VARCHAR(4),
    cabin_class VARCHAR(10) NOT NULL DEFAULT 'economy'
        CHECK (cabin_class IN ('economy', 'business', 'first')),
    status VARCHAR(15) NOT NULL DEFAULT 'issued'
        CHECK (status IN ('issued', 'checked_in', 'boarded', 'cancelled')),
    CONSTRAINT unique_seat_per_flight UNIQUE (flight_id, seat_number)
);

-- Payments
CREATE TABLE payments (
    payment_id SERIAL PRIMARY KEY,
    booking_id INTEGER NOT NULL REFERENCES bookings(booking_id),
    amount DECIMAL(10, 2) NOT NULL,
    method VARCHAR(20) NOT NULL
        CHECK (method IN ('credit_card', 'debit_card', 'bank_transfer', 'wallet')),
    status VARCHAR(15) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'success', 'failed', 'refunded')),
    processed_at TIMESTAMP NOT NULL
);

-- Check-ins
CREATE TABLE checkins (
    checkin_id SERIAL PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(ticket_id),
    checkin_time TIMESTAMP NOT NULL,
    channel VARCHAR(10) NOT NULL
        CHECK (channel IN ('online', 'kiosk', 'counter')),
    bag_count INTEGER NOT NULL DEFAULT 0
);

-- Flight delays
CREATE TABLE flight_delays (
    delay_id SERIAL PRIMARY KEY,
    flight_id INTEGER NOT NULL REFERENCES flights(flight_id),
    delay_minutes INTEGER NOT NULL,
    reason VARCHAR(30) NOT NULL
        CHECK (reason IN ('weather', 'technical', 'crew', 'congestion', 'late_aircraft', 'security')),
    reported_at TIMESTAMP NOT NULL
);

-- Event log (process mining + decision traces)
CREATE TABLE events (
    event_id SERIAL PRIMARY KEY,
    event_type VARCHAR(30) NOT NULL,
    booking_id INTEGER REFERENCES bookings(booking_id),
    flight_id INTEGER REFERENCES flights(flight_id),
    customer_id INTEGER REFERENCES customers(customer_id),
    ticket_id INTEGER REFERENCES tickets(ticket_id),
    timestamp TIMESTAMP NOT NULL,
    metadata JSONB DEFAULT '{}'
);

-- =========================================================================
-- Layer 4: Decision/Provenance
-- =========================================================================

CREATE TABLE decision_proposals (
    proposal_id SERIAL PRIMARY KEY,
    session_id VARCHAR(100) NOT NULL,
    agent_id VARCHAR(50) NOT NULL,
    proposed_action TEXT NOT NULL,
    confidence VARCHAR(10) NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
    risk_class VARCHAR(10) NOT NULL DEFAULT 'low' CHECK (risk_class IN ('low', 'medium', 'high', 'critical')),
    evidence_event_ids INTEGER[],
    evidence_signal_types TEXT[],
    evidence_rules TEXT[],
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'completed')),
    auth_method VARCHAR(20),
    token_hash VARCHAR(16),
    correlation_id VARCHAR(100),
    workflow_id VARCHAR(100),
    idempotency_key VARCHAR(100),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE decision_approvals (
    approval_id SERIAL PRIMARY KEY,
    proposal_id INTEGER NOT NULL REFERENCES decision_proposals(proposal_id),
    approved_by VARCHAR(100) NOT NULL,
    approved BOOLEAN NOT NULL,
    reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE decision_actions (
    action_id SERIAL PRIMARY KEY,
    proposal_id INTEGER NOT NULL REFERENCES decision_proposals(proposal_id),
    action_type VARCHAR(50) NOT NULL,
    parameters JSONB NOT NULL DEFAULT '{}',
    result TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executing', 'completed', 'failed')),
    workflow_id VARCHAR(100),
    idempotency_key VARCHAR(100),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP
);

CREATE TABLE decision_outcomes (
    outcome_id SERIAL PRIMARY KEY,
    proposal_id INTEGER,
    session_id VARCHAR(100) NOT NULL,
    question TEXT NOT NULL,
    decision_summary TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    confidence VARCHAR(10) NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
    agents_involved TEXT[] NOT NULL,
    cost_usd DECIMAL(10, 4),
    evidence_event_ids INTEGER[],
    evidence_rules TEXT[],
    evidence_signal_types TEXT[],
    evidence_proposal_ids INTEGER[],
    auth_method VARCHAR(20),
    token_hash VARCHAR(16),
    correlation_id VARCHAR(100),
    workflow_id VARCHAR(100),
    parent_workflow_id VARCHAR(100),
    prompt_version VARCHAR(50),
    model_version VARCHAR(100),
    idempotency_key VARCHAR(64),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Phase 1c: server-side idempotency for record_outcome — closes the narrow
-- crash window between the INSERT and DBOS step-completion checkpoint.
-- Key is derived from (session_id|question|decision_summary|agents_involved)
-- so retries of the same logical outcome dedupe without a contract change.
CREATE UNIQUE INDEX uniq_outcomes_idempotency_key
    ON decision_outcomes(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Plan v3 Phase 1b: workflow run log linking DBOS workflow_ids to sessions
CREATE TABLE decision_workflow_runs (
    run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id VARCHAR(100) NOT NULL,
    session_id VARCHAR(100) NOT NULL,
    agent_id VARCHAR(50) NOT NULL,
    question TEXT,
    status VARCHAR(20) NOT NULL,
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    auth_method VARCHAR(20),
    token_hash VARCHAR(16)
);
CREATE INDEX idx_workflow_runs_workflow_id ON decision_workflow_runs(workflow_id);
CREATE INDEX idx_workflow_runs_session_id ON decision_workflow_runs(session_id);

-- Phase 1b: exactly-once side-effect enforcement at the SQL layer.
-- Each workflow produces at most one row per table in this slice; DBOS step
-- replays during recovery-edge timing cannot duplicate these side effects.
CREATE UNIQUE INDEX uniq_workflow_runs_workflow_id
    ON decision_workflow_runs(workflow_id)
    WHERE workflow_id IS NOT NULL;
CREATE UNIQUE INDEX uniq_proposals_workflow_id
    ON decision_proposals(workflow_id)
    WHERE workflow_id IS NOT NULL;
CREATE UNIQUE INDEX uniq_actions_workflow_id
    ON decision_actions(workflow_id)
    WHERE workflow_id IS NOT NULL;
CREATE UNIQUE INDEX uniq_outcomes_workflow_id
    ON decision_outcomes(workflow_id)
    WHERE workflow_id IS NOT NULL;
-- decision_approvals has its own idempotency rule: one row per (proposal, approver).
-- Replay of the approve step cannot create a second 'auto' approval on the same proposal.
CREATE UNIQUE INDEX uniq_approvals_proposal_approver
    ON decision_approvals(proposal_id, approved_by);

CREATE TABLE decision_findings (
    finding_id SERIAL PRIMARY KEY,
    session_id VARCHAR(100) NOT NULL,
    agent_id VARCHAR(50) NOT NULL,
    finding TEXT NOT NULL,
    confidence VARCHAR(10) NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
    data_sources TEXT[],
    auth_method VARCHAR(20),
    token_hash VARCHAR(16),
    correlation_id VARCHAR(100),
    idempotency_key VARCHAR(64),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Phase 1c: server-side idempotency for findings. The harness computes the key
-- from (session_id, agent_id, finding, confidence, data_sources) so retried
-- workflow steps produce the same row, not duplicates. MCP contract unchanged.
CREATE UNIQUE INDEX uniq_findings_idempotency_key
    ON decision_findings(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE agent_memory (
    memory_id SERIAL PRIMARY KEY,
    agent_id VARCHAR(50) NOT NULL,
    key VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (agent_id, key)
);

-- Layer 4b: Structured memory (three-tier: episodic, semantic, procedural)
CREATE TABLE memory_entries (
    memory_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_type VARCHAR(20) NOT NULL CHECK (memory_type IN ('episodic', 'semantic', 'procedural')),
    scope_type VARCHAR(10) NOT NULL CHECK (scope_type IN ('agent', 'bundle', 'global')),
    scope_id VARCHAR(100) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'active', 'stale', 'superseded', 'retracted')),
    title VARCHAR(200) NOT NULL,
    summary TEXT NOT NULL,
    content JSONB NOT NULL DEFAULT '{}',
    confidence DECIMAL(3,2) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    valid_from TIMESTAMP NOT NULL DEFAULT NOW(),
    valid_to TIMESTAMP,
    expires_at TIMESTAMP,
    last_revalidated_at TIMESTAMP,
    source_outcome_id INTEGER,
    source_proposal_id INTEGER,
    evidence_event_ids INTEGER[],
    evidence_rules TEXT[],
    evidence_signal_types TEXT[]
);

-- Layer 5: Progressive autonomy tracking
CREATE TABLE autonomy_stats (
    risk_class VARCHAR(10) PRIMARY KEY,
    total_decisions INTEGER NOT NULL DEFAULT 0,
    successful_decisions INTEGER NOT NULL DEFAULT 0,
    failed_decisions INTEGER NOT NULL DEFAULT 0,
    auto_approved BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO autonomy_stats (risk_class, auto_approved) VALUES
    ('low', true), ('medium', false), ('high', false), ('critical', false);

-- =========================================================================
-- Indexes for common queries
CREATE INDEX idx_flights_status ON flights(status);
CREATE INDEX idx_flights_departure ON flights(scheduled_departure);
CREATE INDEX idx_bookings_customer ON bookings(customer_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_tickets_booking ON tickets(booking_id);
CREATE INDEX idx_tickets_flight ON tickets(flight_id);
CREATE INDEX idx_payments_booking ON payments(booking_id);
CREATE INDEX idx_checkins_ticket ON checkins(ticket_id);
CREATE INDEX idx_delays_flight ON flight_delays(flight_id);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_booking ON events(booking_id);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_proposals_session ON decision_proposals(session_id);
CREATE INDEX idx_proposals_status ON decision_proposals(status);
CREATE INDEX idx_approvals_proposal ON decision_approvals(proposal_id);
CREATE INDEX idx_actions_proposal ON decision_actions(proposal_id);
CREATE INDEX idx_outcomes_session ON decision_outcomes(session_id);
CREATE INDEX idx_findings_session ON decision_findings(session_id);
CREATE INDEX idx_memory_agent ON agent_memory(agent_id);
CREATE INDEX idx_mem_entries_type ON memory_entries(memory_type);
CREATE INDEX idx_mem_entries_scope ON memory_entries(scope_type, scope_id);
CREATE INDEX idx_mem_entries_status ON memory_entries(status);
CREATE INDEX idx_mem_entries_confidence ON memory_entries(confidence DESC);

-- Layer 6: OPA governance decision logs (Phase 2c)
-- Every governance evaluation (allow or deny) is logged with the full OPA
-- input/result and the bundle revision that produced the decision. This
-- enables replay_outcome and policy_drift_report admin tools.
CREATE TABLE decision_logs (
    opa_decision_id VARCHAR(100) PRIMARY KEY,
    bundle_revision VARCHAR(64) NOT NULL,
    timestamp       TIMESTAMP NOT NULL DEFAULT NOW(),
    agent_id        VARCHAR(50) NOT NULL,
    session_id      VARCHAR(100),
    tool_name       VARCHAR(50) NOT NULL,
    sql_hash        VARCHAR(64),
    input           JSONB NOT NULL,
    result          JSONB NOT NULL,
    allowed         BOOLEAN NOT NULL,
    contract_id     VARCHAR(100)
);

CREATE INDEX idx_decision_logs_session   ON decision_logs(session_id);
CREATE INDEX idx_decision_logs_bundle    ON decision_logs(bundle_revision);
CREATE INDEX idx_decision_logs_timestamp ON decision_logs(timestamp);

-- Add bundle_revision to decision_outcomes so the outcome row links back
-- to the policy version that governed the session's queries.
ALTER TABLE decision_outcomes ADD COLUMN IF NOT EXISTS bundle_revision VARCHAR(64);

-- Phase 3: delegation — who authorized this agent to act?
-- Present when a user delegates to an agent via RFC 8693 token exchange (act claim).
ALTER TABLE decision_findings ADD COLUMN IF NOT EXISTS delegated_subject VARCHAR(100);
ALTER TABLE decision_proposals ADD COLUMN IF NOT EXISTS delegated_subject VARCHAR(100);
ALTER TABLE decision_outcomes ADD COLUMN IF NOT EXISTS delegated_subject VARCHAR(100);
ALTER TABLE decision_logs ADD COLUMN IF NOT EXISTS delegated_subject VARCHAR(100);

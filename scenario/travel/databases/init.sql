-- Travel Booking Database Schema
-- Ontology-aligned: every FK relationship maps to an entity relationship in the context graph

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

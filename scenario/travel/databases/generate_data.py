"""Synthetic travel booking data generator.

Generates ~1000 customers, ~100 flights, ~5000 bookings, ~20000 events
into a PostgreSQL database. Data is ontology-aligned: FK relationships
map to entity relationships in the context graph.

Usage:
    pip install psycopg2-binary faker
    python generate_data.py
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta
from typing import Any

import psycopg2
from faker import Faker

fake = Faker()
Faker.seed(42)
random.seed(42)

# Connection
DB_HOST = "localhost"
DB_PORT = 5433
DB_NAME = "travel_db"
DB_USER = "travel_admin"
DB_PASS = "travel_pass"

# Volume
N_CUSTOMERS = 1000
N_FLIGHTS_PER_DAY = 15
N_DAYS = 30  # ~450 flights total
BOOKING_RATIO = 0.75  # 75% of seats get booked across all flights
DELAY_PROBABILITY = 0.25
CANCELLATION_PROBABILITY = 0.05

# Reference data
AIRLINES = [
    ("SJ", "SkyJet", "Netherlands"),
    ("EA", "EuroAir", "Germany"),
    ("AT", "AtlanticWings", "United Kingdom"),
    ("SP", "SunPath", "Spain"),
    ("NF", "NordFly", "Norway"),
]

AIRPORTS = [
    ("AMS", "Amsterdam Schiphol", "Amsterdam", "Netherlands", "Europe/Amsterdam"),
    ("LHR", "London Heathrow", "London", "United Kingdom", "Europe/London"),
    ("CDG", "Paris Charles de Gaulle", "Paris", "France", "Europe/Paris"),
    ("FRA", "Frankfurt Airport", "Frankfurt", "Germany", "Europe/Berlin"),
    ("MAD", "Madrid Barajas", "Madrid", "Spain", "Europe/Madrid"),
    ("FCO", "Rome Fiumicino", "Rome", "Italy", "Europe/Rome"),
    ("BCN", "Barcelona El Prat", "Barcelona", "Spain", "Europe/Madrid"),
    ("OSL", "Oslo Gardermoen", "Oslo", "Norway", "Europe/Oslo"),
    ("JFK", "John F Kennedy", "New York", "USA", "America/New_York"),
    ("DXB", "Dubai International", "Dubai", "UAE", "Asia/Dubai"),
]

ROUTES = [
    ("AMS", "LHR"), ("AMS", "CDG"), ("AMS", "FRA"), ("AMS", "BCN"), ("AMS", "JFK"),
    ("LHR", "AMS"), ("LHR", "CDG"), ("LHR", "JFK"), ("LHR", "DXB"), ("LHR", "MAD"),
    ("CDG", "AMS"), ("CDG", "LHR"), ("CDG", "FCO"), ("CDG", "JFK"), ("CDG", "BCN"),
    ("FRA", "AMS"), ("FRA", "LHR"), ("FRA", "MAD"), ("FRA", "DXB"), ("FRA", "OSL"),
    ("MAD", "LHR"), ("MAD", "FRA"), ("MAD", "BCN"), ("MAD", "JFK"),
    ("FCO", "CDG"), ("FCO", "LHR"), ("FCO", "FRA"),
    ("BCN", "AMS"), ("BCN", "CDG"), ("BCN", "LHR"),
    ("OSL", "AMS"), ("OSL", "FRA"), ("OSL", "LHR"),
    ("JFK", "LHR"), ("JFK", "AMS"), ("JFK", "CDG"),
    ("DXB", "LHR"), ("DXB", "FRA"),
]

AIRCRAFT = [
    ("A320", 180), ("A321", 220), ("B737", 189), ("B777", 350),
    ("A350", 300), ("E190", 100), ("B787", 290),
]

COUNTRIES = [
    "Netherlands", "United Kingdom", "France", "Germany", "Spain",
    "Italy", "Norway", "USA", "UAE", "Belgium", "Ireland", "Portugal",
    "Sweden", "Denmark", "Switzerland", "Austria", "Poland", "Czech Republic",
]

LOYALTY_TIERS = ["standard"] * 60 + ["silver"] * 20 + ["gold"] * 15 + ["platinum"] * 5

PAYMENT_METHODS = ["credit_card"] * 50 + ["debit_card"] * 25 + ["bank_transfer"] * 15 + ["wallet"] * 10

DELAY_REASONS = ["weather", "technical", "crew", "congestion", "late_aircraft", "security"]

EVENT_TYPES = [
    "CustomerRegistered", "FlightSearched", "FlightSelected",
    "BookingCreated", "PaymentSucceeded", "PaymentFailed",
    "TicketIssued", "CheckInCompleted", "BoardingStarted",
    "FlightDeparted", "FlightArrived", "BookingCancelled",
    "FlightDelayed", "FlightCancelled", "RebookingInitiated",
    "CompensationIssued",
]


def connect():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASS
    )


def insert_many(cur, table: str, columns: list[str], rows: list[tuple]):
    if not rows:
        return
    placeholders = ", ".join(["%s"] * len(columns))
    cols = ", ".join(columns)
    query = f"INSERT INTO {table} ({cols}) VALUES ({placeholders})"
    cur.executemany(query, rows)


def generate_airlines(cur):
    print(f"  Airlines: {len(AIRLINES)}")
    insert_many(cur, "airlines", ["airline_code", "name", "country"],
                [(a[0], a[1], a[2]) for a in AIRLINES])


def generate_airports(cur):
    print(f"  Airports: {len(AIRPORTS)}")
    insert_many(cur, "airports", ["airport_code", "name", "city", "country", "timezone"],
                [(a[0], a[1], a[2], a[3], a[4]) for a in AIRPORTS])


def generate_customers(cur) -> list[int]:
    print(f"  Customers: {N_CUSTOMERS}")
    rows = []
    base_date = datetime(2025, 1, 1)
    for i in range(N_CUSTOMERS):
        signup = base_date + timedelta(days=random.randint(0, 400))
        rows.append((
            fake.first_name(),
            fake.last_name(),
            f"customer{i + 1}@{fake.free_email_domain()}",
            fake.phone_number()[:20],
            random.choice(COUNTRIES),
            random.choice(LOYALTY_TIERS),
            signup.date(),
        ))
    insert_many(cur, "customers",
                ["first_name", "last_name", "email", "phone", "country", "loyalty_tier", "signup_date"],
                rows)
    cur.execute("SELECT customer_id FROM customers ORDER BY customer_id")
    return [r[0] for r in cur.fetchall()]


def generate_flights(cur) -> list[dict]:
    base_date = datetime(2026, 3, 1, 6, 0)
    flights = []

    for day_offset in range(N_DAYS):
        day_start = base_date + timedelta(days=day_offset)
        n_flights = N_FLIGHTS_PER_DAY + random.randint(-3, 3)

        for _ in range(n_flights):
            origin, destination = random.choice(ROUTES)
            airline = random.choice(AIRLINES)[0]
            aircraft_type, capacity = random.choice(AIRCRAFT)

            dep_hour = random.randint(6, 22)
            dep_minute = random.choice([0, 15, 30, 45])
            scheduled_dep = day_start.replace(hour=dep_hour, minute=dep_minute)

            # Flight duration 1-10 hours depending on route
            is_long_haul = origin in ("JFK", "DXB") or destination in ("JFK", "DXB")
            duration_hours = random.uniform(6, 10) if is_long_haul else random.uniform(1, 3.5)
            scheduled_arr = scheduled_dep + timedelta(hours=duration_hours)

            flight_number = f"{airline}{random.randint(100, 999)}"

            flights.append({
                "flight_number": flight_number,
                "airline_code": airline,
                "origin": origin,
                "destination": destination,
                "scheduled_departure": scheduled_dep,
                "scheduled_arrival": scheduled_arr,
                "aircraft_type": aircraft_type,
                "capacity": capacity,
            })

    print(f"  Flights: {len(flights)}")
    rows = [(
        f["flight_number"], f["airline_code"], f["origin"], f["destination"],
        f["scheduled_departure"], f["scheduled_arrival"],
        None, None, "scheduled", f["aircraft_type"], f["capacity"],
    ) for f in flights]
    insert_many(cur, "flights",
                ["flight_number", "airline_code", "origin", "destination",
                 "scheduled_departure", "scheduled_arrival",
                 "actual_departure", "actual_arrival", "status",
                 "aircraft_type", "capacity"],
                rows)
    cur.execute("SELECT flight_id, capacity, scheduled_departure, scheduled_arrival FROM flights ORDER BY flight_id")
    result = cur.fetchall()
    for i, r in enumerate(result):
        flights[i]["flight_id"] = r[0]
        flights[i]["db_capacity"] = r[1]
    return flights


def generate_bookings_and_tickets(cur, customer_ids: list[int], flights: list[dict]) -> tuple[list[dict], list[dict]]:
    bookings = []
    tickets = []
    booking_counter = 0

    for flight in flights:
        fid = flight["flight_id"]
        capacity = flight["db_capacity"]
        dep = flight["scheduled_departure"]

        n_booked = int(capacity * BOOKING_RATIO * random.uniform(0.6, 1.1))
        n_booked = min(n_booked, capacity)

        # Generate seat numbers
        rows_available = list(range(1, (capacity // 6) + 2))
        seats_available = [f"{r}{s}" for r in rows_available for s in "ABCDEF"][:capacity]
        random.shuffle(seats_available)

        for i in range(n_booked):
            customer_id = random.choice(customer_ids)
            booking_date = dep - timedelta(days=random.randint(1, 60))

            # Determine cabin class
            cabin = random.choices(
                ["economy", "business", "first"],
                weights=[80, 15, 5],
            )[0]

            # Price based on cabin and route
            base_price = random.uniform(80, 300)
            if cabin == "business":
                base_price *= 2.5
            elif cabin == "first":
                base_price *= 5
            base_price = round(base_price, 2)

            # Booking status
            if random.random() < CANCELLATION_PROBABILITY:
                status = "cancelled"
            elif dep < datetime(2026, 3, 25):
                status = "completed"
            else:
                status = "confirmed"

            bookings.append({
                "customer_id": customer_id,
                "booking_date": booking_date,
                "status": status,
                "total_amount": base_price,
                "currency": "EUR",
            })
            booking_counter += 1

            tickets.append({
                "_booking_index": booking_counter - 1,
                "flight_id": fid,
                "seat_number": seats_available[i] if i < len(seats_available) else None,
                "cabin_class": cabin,
                "status": "cancelled" if status == "cancelled" else "issued",
            })

    print(f"  Bookings: {len(bookings)}")
    print(f"  Tickets: {len(tickets)}")

    # Insert bookings
    booking_rows = [(
        b["customer_id"], b["booking_date"], b["status"],
        b["total_amount"], b["currency"],
    ) for b in bookings]
    insert_many(cur, "bookings",
                ["customer_id", "booking_date", "status", "total_amount", "currency"],
                booking_rows)

    cur.execute("SELECT booking_id FROM bookings ORDER BY booking_id")
    booking_ids = [r[0] for r in cur.fetchall()]
    for i, bid in enumerate(booking_ids):
        bookings[i]["booking_id"] = bid

    # Insert tickets
    ticket_rows = [(
        bookings[t["_booking_index"]]["booking_id"],
        t["flight_id"], t["seat_number"], t["cabin_class"], t["status"],
    ) for t in tickets]
    insert_many(cur, "tickets",
                ["booking_id", "flight_id", "seat_number", "cabin_class", "status"],
                ticket_rows)

    cur.execute("SELECT ticket_id, booking_id, flight_id FROM tickets ORDER BY ticket_id")
    ticket_results = cur.fetchall()
    for i, r in enumerate(ticket_results):
        tickets[i]["ticket_id"] = r[0]
        tickets[i]["booking_id"] = r[1]

    return bookings, tickets


def generate_payments(cur, bookings: list[dict]):
    rows = []
    for b in bookings:
        if b["status"] == "cancelled" and random.random() < 0.3:
            # Some cancelled bookings had failed payments
            rows.append((
                b["booking_id"], b["total_amount"],
                random.choice(PAYMENT_METHODS), "failed",
                b["booking_date"] + timedelta(minutes=random.randint(1, 10)),
            ))
        elif b["status"] != "cancelled":
            rows.append((
                b["booking_id"], b["total_amount"],
                random.choice(PAYMENT_METHODS), "success",
                b["booking_date"] + timedelta(minutes=random.randint(1, 10)),
            ))
            if b["status"] == "cancelled":
                # Refund
                rows.append((
                    b["booking_id"], b["total_amount"],
                    "bank_transfer", "refunded",
                    b["booking_date"] + timedelta(days=random.randint(1, 7)),
                ))

    print(f"  Payments: {len(rows)}")
    insert_many(cur, "payments",
                ["booking_id", "amount", "method", "status", "processed_at"],
                rows)


def generate_checkins(cur, tickets: list[dict], flights: list[dict]):
    flight_map = {f["flight_id"]: f for f in flights}
    rows = []
    checked_in_tickets = []

    for t in tickets:
        if t["status"] == "cancelled":
            continue

        flight = flight_map.get(t["flight_id"])
        if not flight:
            continue

        dep = flight["scheduled_departure"]
        # Only check in for flights that have departed or are today
        if dep > datetime(2026, 3, 31) or random.random() < 0.15:
            continue

        checkin_time = dep - timedelta(hours=random.uniform(1, 24))
        channel = random.choices(["online", "kiosk", "counter"], weights=[60, 25, 15])[0]
        bag_count = random.choices([0, 1, 2, 3], weights=[30, 40, 25, 5])[0]

        rows.append((
            t["ticket_id"], checkin_time, channel, bag_count,
        ))
        checked_in_tickets.append(t["ticket_id"])

    print(f"  Check-ins: {len(rows)}")
    insert_many(cur, "checkins",
                ["ticket_id", "checkin_time", "channel", "bag_count"],
                rows)

    # Update ticket status
    if checked_in_tickets:
        cur.execute(
            "UPDATE tickets SET status = 'checked_in' WHERE ticket_id = ANY(%s)",
            (checked_in_tickets,)
        )

    return checked_in_tickets


def generate_delays(cur, flights: list[dict]):
    rows = []
    for f in flights:
        if random.random() < DELAY_PROBABILITY:
            delay_min = random.choices(
                [15, 30, 45, 60, 90, 120, 180],
                weights=[30, 25, 15, 12, 8, 6, 4],
            )[0]
            reason = random.choice(DELAY_REASONS)
            reported = f["scheduled_departure"] - timedelta(minutes=random.randint(30, 120))

            rows.append((
                f["flight_id"], delay_min, reason, reported,
            ))

    print(f"  Flight delays: {len(rows)}")
    insert_many(cur, "flight_delays",
                ["flight_id", "delay_minutes", "reason", "reported_at"],
                rows)

    # Update flight status and actual times for departed flights
    cur.execute("SELECT flight_id, delay_minutes FROM flight_delays")
    delay_map = {}
    for r in cur.fetchall():
        delay_map.setdefault(r[0], 0)
        delay_map[r[0]] = max(delay_map[r[0]], r[1])

    for f in flights:
        fid = f["flight_id"]
        dep = f["scheduled_departure"]
        arr = f["scheduled_arrival"]

        if dep < datetime(2026, 3, 25):
            # Past flights: set actual times
            delay = delay_map.get(fid, 0)
            actual_dep = dep + timedelta(minutes=delay)
            duration = arr - dep
            actual_arr = actual_dep + duration

            if random.random() < CANCELLATION_PROBABILITY:
                cur.execute(
                    "UPDATE flights SET status = 'cancelled' WHERE flight_id = %s",
                    (fid,)
                )
            else:
                cur.execute(
                    "UPDATE flights SET status = 'arrived', actual_departure = %s, actual_arrival = %s WHERE flight_id = %s",
                    (actual_dep, actual_arr, fid)
                )
        elif dep < datetime(2026, 4, 1):
            if fid in delay_map:
                cur.execute(
                    "UPDATE flights SET status = 'delayed' WHERE flight_id = %s",
                    (fid,)
                )


def generate_events(cur, customer_ids: list[int], bookings: list[dict], tickets: list[dict], flights: list[dict]):
    events = []
    flight_map = {f["flight_id"]: f for f in flights}

    # Customer registration events
    cur.execute("SELECT customer_id, signup_date FROM customers")
    for cid, signup in cur.fetchall():
        events.append((
            "CustomerRegistered", None, None, cid, None,
            datetime.combine(signup, datetime.min.time().replace(hour=random.randint(8, 20))),
            "{}",
        ))

    # Booking lifecycle events
    for i, b in enumerate(bookings):
        bid = b["booking_id"]
        cid = b["customer_id"]
        bdate = b["booking_date"]

        # FlightSearched
        events.append((
            "FlightSearched", None, None, cid, None,
            bdate - timedelta(minutes=random.randint(5, 60)),
            "{}",
        ))

        # FlightSelected
        if i < len(tickets):
            t = tickets[i]
            events.append((
                "FlightSelected", None, t["flight_id"], cid, None,
                bdate - timedelta(minutes=random.randint(1, 5)),
                "{}",
            ))

        # BookingCreated
        events.append((
            "BookingCreated", bid, None, cid, None,
            bdate,
            f'{{"amount": {b["total_amount"]}}}',
        ))

        if b["status"] == "cancelled":
            events.append((
                "PaymentFailed", bid, None, cid, None,
                bdate + timedelta(minutes=random.randint(1, 5)),
                '{"reason": "payment_declined"}',
            ))
            events.append((
                "BookingCancelled", bid, None, cid, None,
                bdate + timedelta(minutes=random.randint(6, 30)),
                "{}",
            ))
        else:
            events.append((
                "PaymentSucceeded", bid, None, cid, None,
                bdate + timedelta(minutes=random.randint(1, 5)),
                "{}",
            ))
            events.append((
                "TicketIssued", bid, None, cid, None,
                bdate + timedelta(minutes=random.randint(5, 15)),
                "{}",
            ))

    # Check-in events
    cur.execute("SELECT checkin_id, ticket_id, checkin_time FROM checkins")
    for _, tid, checkin_time in cur.fetchall():
        # Find the booking for this ticket
        cur2 = cur.connection.cursor()
        cur2.execute("SELECT booking_id, flight_id FROM tickets WHERE ticket_id = %s", (tid,))
        result = cur2.fetchone()
        if result:
            events.append((
                "CheckInCompleted", result[0], result[1], None, tid,
                checkin_time,
                "{}",
            ))
        cur2.close()

    # Flight operation events
    cur.execute("""
        SELECT flight_id, status, scheduled_departure, actual_departure, actual_arrival
        FROM flights WHERE status IN ('arrived', 'departed', 'cancelled', 'delayed')
    """)
    for fid, status, sched_dep, actual_dep, actual_arr in cur.fetchall():
        if status == "cancelled":
            events.append((
                "FlightCancelled", None, fid, None, None,
                sched_dep - timedelta(hours=random.randint(1, 6)),
                "{}",
            ))
        else:
            if actual_dep:
                events.append((
                    "BoardingStarted", None, fid, None, None,
                    actual_dep - timedelta(minutes=30),
                    "{}",
                ))
                events.append((
                    "FlightDeparted", None, fid, None, None,
                    actual_dep,
                    "{}",
                ))
            if actual_arr:
                events.append((
                    "FlightArrived", None, fid, None, None,
                    actual_arr,
                    "{}",
                ))

    # Delay events
    cur.execute("SELECT flight_id, delay_minutes, reason, reported_at FROM flight_delays")
    for fid, delay_min, reason, reported_at in cur.fetchall():
        events.append((
            "FlightDelayed", None, fid, None, None,
            reported_at,
            f'{{"delay_minutes": {delay_min}, "reason": "{reason}"}}',
        ))

    print(f"  Events: {len(events)}")
    insert_many(cur, "events",
                ["event_type", "booking_id", "flight_id", "customer_id", "ticket_id", "timestamp", "metadata"],
                events)


def main():
    print("Connecting to travel_db...")
    conn = connect()
    conn.autocommit = False
    cur = conn.cursor()

    try:
        print("\nGenerating synthetic travel data...")

        generate_airlines(cur)
        generate_airports(cur)
        customer_ids = generate_customers(cur)
        flights = generate_flights(cur)
        bookings, tickets = generate_bookings_and_tickets(cur, customer_ids, flights)
        generate_payments(cur, bookings)
        checked_in = generate_checkins(cur, tickets, flights)
        generate_delays(cur, flights)
        generate_events(cur, customer_ids, bookings, tickets, flights)

        conn.commit()
        print("\nData generation complete!")

        # Summary
        cur.execute("SELECT COUNT(*) FROM customers")
        print(f"\n  Customers:    {cur.fetchone()[0]}")
        cur.execute("SELECT COUNT(*) FROM flights")
        print(f"  Flights:      {cur.fetchone()[0]}")
        cur.execute("SELECT COUNT(*) FROM bookings")
        print(f"  Bookings:     {cur.fetchone()[0]}")
        cur.execute("SELECT COUNT(*) FROM tickets")
        print(f"  Tickets:      {cur.fetchone()[0]}")
        cur.execute("SELECT COUNT(*) FROM payments")
        print(f"  Payments:     {cur.fetchone()[0]}")
        cur.execute("SELECT COUNT(*) FROM checkins")
        print(f"  Check-ins:    {cur.fetchone()[0]}")
        cur.execute("SELECT COUNT(*) FROM flight_delays")
        print(f"  Delays:       {cur.fetchone()[0]}")
        cur.execute("SELECT COUNT(*) FROM events")
        print(f"  Events:       {cur.fetchone()[0]}")

    except Exception as e:
        conn.rollback()
        print(f"\nError: {e}")
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()

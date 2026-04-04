# Cookbook 02: Connect OpenMetadata Catalog

Set up OpenMetadata so the harness reads governance metadata (PII tags, glossary, lineage, ownership) from a real enterprise catalog.

## Why a catalog?

Without a catalog, governance comes from local YAML files. With a catalog:

- PII tags are managed by data stewards, not developers
- Glossary terms provide business context to agents
- Lineage shows data dependencies automatically
- Ownership is always up to date

## Step 1: Start OpenMetadata

If you don't have OMD running, use the docker-compose from the OpenMetadata quickstart:

```bash
# Download from https://docs.open-metadata.org/v1.12.x/quick-start/local-docker-deployment
docker compose up -d
```

OMD runs on `http://localhost:8585` (admin@open-metadata.org / admin).

## Step 2: Create a database service for your data

In OMD UI:

1. Settings → Services → Databases → Add New Service
2. Type: Postgres
3. Name: `travel_postgres`
4. Host: `travel_postgres` (Docker network name) or `host.docker.internal`
5. Port: 5432 (internal) or 5433 (host)
6. Database: `travel_db`
7. Username: `travel_admin`
8. Password: `travel_pass`

Run metadata ingestion to discover tables.

## Step 3: Tag PII columns

In OMD UI, navigate to customers table:

- `first_name` → Add tag → PII.Sensitive
- `last_name` → Add tag → PII.Sensitive
- `email` → Add tag → PII.Sensitive
- `phone` → Add tag → PII.Sensitive

## Step 4: Create glossary terms

Create a glossary "TravelOperationsGlossary" with terms like:

- **BookingRevenue** (synonyms: Revenue, Sales) — linked to bookings table
- **FlightDelay** (synonyms: Delay) — linked to flights, flight_delays tables
- **CheckInWindow** — linked to flights table

## Step 5: Add lineage

In OMD UI Lineage view, draw edges:

- payments → bookings
- tickets → bookings
- flight_delays → flights
- flights → events
- bookings → events

## Step 6: Configure harness to use catalog

Update `scenario/travel/scenario.yml`:

```yaml
catalog:
    provider: openmetadata
    url: http://localhost:8585
    token: "{{ env('CATALOG_TOKEN') }}"
    service_name: travel_postgres
```

## Step 7: Test catalog integration

```bash
cd agents
npx tsx src/test-query.ts
```

The harness log should show: `[catalog] Provider: openmetadata` and `[harness] Catalog: connected`.

## Step 8: Test glossary search

```bash
npx tsx src/flight-ops.ts "What does delay mean?"
```

Expected: Agent calls `harness__search_glossary` → returns FlightDelay definition from OMD.

## Optional: Enable RDF/SPARQL

Add Jena Fuseki to your OMD docker-compose for knowledge graph queries:

```yaml
fuseki:
    image: stain/jena-fuseki:latest
    environment:
        - ADMIN_PASSWORD=fuseki_admin
    ports:
        - '3030:3030'
```

Configure OMD with `RDF_ENABLED=true` and `RDF_ENDPOINT=http://fuseki:3030/openmetadata`.

Access SPARQL at `http://localhost:3030`.

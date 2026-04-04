# dazense harness

A governed multi-agent decision platform. Plug in your data, configure your scenario, and AI agents make governed decisions — with full audit trails, evidence links, and risk-based approval gates.

## What it does

The harness sits between AI agents and your enterprise data. Agents connect via MCP (Model Context Protocol) and call tools. The harness governs every interaction:

```
Any AI Agent (Claude, GPT, LangChain, CrewAI)
       │
       │  MCP Protocol
       ▼
┌─────────────────────────────────────┐
│  HARNESS (MCP Server)               │
│                                     │
│  Context    ← catalog (OMD/Atlan)   │
│  Governance ← PII, bundles, rules   │
│  Events     ← operational log       │
│  Decisions  ← proposal → approval   │
│  Actions    ← risk-based gates      │
│  Memory     ← institutional memory  │
└─────────────────────────────────────┘
       │
       ▼
  Database (PostgreSQL)
```

## Key features

- **31 MCP tools** across 5 governed layers
- **Pluggable catalog** — OpenMetadata implemented, Atlan/Collibra/Purview by config
- **PII blocking** — column-level blocking from catalog tags, defense-in-depth result filtering
- **Bundle scoping** — each agent only sees its authorized tables
- **Decision lifecycle** — Proposal → Approval → Action → Outcome with evidence links
- **Risk classification** — low (auto), medium (optional review), high (human required), critical (senior required)
- **Progressive autonomy** — auto-approve more as trust builds over time
- **Three-tier memory** — episodic, semantic, procedural with scope controls
- **Config-driven** — switch scenarios (travel, banking, retail) by swapping a folder

## Quick start

### 1. Start infrastructure

```bash
# Travel database (PostgreSQL)
cd scenario/travel/databases
docker compose up -d

# OpenMetadata (optional — for catalog-backed governance)
# See cookbook/02-catalog-setup.md
```

### 2. Install dependencies

```bash
# Root (UI backend + frontend)
npm install

# Harness
cd harness && npm install && cd ..

# Agents (examples)
cd agents && npm install && cd ..
```

Or use the bootstrap script:

```bash
bash scripts/bootstrap-platform-deps.sh
```

### 3. Run the harness test

```bash
cd agents
npx tsx src/test-query.ts
```

Expected: `✅ All tests passed!` — 31 tools discovered, governance enforced.

### 4. Run a domain agent

Set your LLM credentials (Azure OpenAI example):

```bash
export AZURE_OPENAI_API_KEY=<your-key>
export AZURE_RESOURCE_NAME=<your-resource>
export AZURE_OPENAI_CHAT_DEPLOYMENT=<your-deployment>
```

The agents use Azure OpenAI by default. To use a different LLM, edit `agents/src/llm.ts`.

```bash
cd agents
npx tsx src/flight-ops.ts "What are the top delay reasons in March 2026?"
```

### 5. Run the orchestrator (multi-agent)

```bash
npx tsx src/orchestrator.ts "What is the operational health of our airline?"
```

### 6. Launch the UI

```bash
cd /path/to/repo
npm install
npm run dev
# Open http://localhost:3000
```

## Project structure

```
harness/                  ← MCP server (the core product)
  src/
    server.ts             ← Entry point
    catalog/              ← Pluggable catalog interface
    governance/           ← Internal governance pipeline
    database/             ← PostgreSQL client
    config/               ← Scenario config loader
    tools/                ← 31 MCP tools across 5 layers

scenario/                 ← Scenario configs (swap for different domains)
  travel/
    scenario.yml          ← Database + catalog connection
    agents.yml            ← Agent definitions + permissions
    datasets/             ← Bundle definitions (trust boundaries)
    semantics/            ← Semantic model + business rules
    policies/             ← PII, execution limits, risk classification
    ontology/             ← Domain concepts + intent mappings
    databases/            ← Docker + schema + data generator

agents/                   ← Example agent implementations
  src/
    flight-ops.ts         ← Flight operations agent
    booking.ts            ← Booking management agent
    customer-service.ts   ← Customer service agent
    orchestrator.ts       ← Multi-agent orchestrator
    test-query.ts         ← Governance test suite

apps/                     ← Chat UI (optional)
cookbook/                  ← Step-by-step tutorials
docs/                     ← Architecture + testing guide
```

## Adding a new scenario

To use the harness with your own data (banking, retail, healthcare):

1. Create `scenario/<your-domain>/` with the same YAML structure as `scenario/travel/`
2. Set up your PostgreSQL database with domain tables
3. Define agents, bundles, business rules, and policies
4. Optionally connect a catalog (OpenMetadata, Atlan, Collibra, Purview)
5. Run: `SCENARIO_PATH=../scenario/<your-domain> npx tsx src/server.ts`

See `cookbook/04-new-scenario.md` for a complete walkthrough.

## Switching catalogs

The harness reads metadata from a pluggable catalog:

```yaml
# scenario.yml
catalog:
    provider: atlan # or openmetadata, collibra, purview
    url: https://atlan.company.com
    token: "{{ env('CATALOG_TOKEN') }}"
    service_name: my_database
```

Implement `ICatalogClient` in `harness/src/catalog/atlan.ts`. See `cookbook/05-catalog-provider.md`.

## Security

- All SQL queries use parameterized placeholders
- PII blocked at SQL text level + result schema level
- PII redacted before persistence (findings, memory, outcomes)
- Approval/execute permissions enforced per agent per risk class
- Join allowlist enforcement per bundle
- Evidence validation on decision proposals

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full 5-layer architecture.

## License

Apache 2.0

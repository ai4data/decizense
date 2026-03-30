<p align="center">
  <a href="https://dazense.metazense.com">
    <img src="apps/frontend/public/logo192.png" height="128" alt="dazense logo" />
  </a>
</p>

<h1 align="center">dazense</h1>

<h3 align="center">
  Trusted Analytics Agents
</h3>

<p align="center">
  Governance layers between AI agents and your data — so every answer is correct, safe, and auditable.
</p>

<p align="center">
  <a href="https://dazense.metazense.com">Website</a> · <a href="https://dadocs.metazense.com">Documentation</a> · <a href="https://metazense.slack.com">Slack</a>
</p>

<br/>

<p align="center">
  <a href="https://dazense.metazense.com">
    <img src=".github/images/dazense_UI.png" alt="dazense chat interface" />
  </a>
</p>

<br/>

## The Problem

An LLM-based agent with SQL access to a database has no constraints. It can compute revenue including returned orders (wrong), expose customer names (PII violation), query staging tables (out of scope), and give different answers to the same question. The database executes whatever SQL it receives.

## The Solution

dazense puts **governance layers** between the agent and the database:

```
User question (natural language)
       |
   LLM Agent
       |
  +-------------------------------+
  |  dazense governance stack     |
  |                               |
  |  1. Semantic Layer            |  -> consistent metrics
  |  2. Business Rules            |  -> domain knowledge
  |  3. Dataset Bundle            |  -> trust boundary
  |  4. Policy Engine             |  -> hard enforcement
  |  5. Governance Graph          |  -> explainability
  +-------------------------------+
       |
   Database
```

Each layer is optional and additive. Start with just a database connection and add governance incrementally.

## Governance Layers

### Semantic Layer

Pre-defined metrics with baked-in filters. `total_revenue` always excludes returned orders — every user, every time, same answer. The agent calls `query_metrics` instead of writing raw SQL.

### Business Rules

Codified domain knowledge: "revenue means net revenue", "first_name is PII", "customers with 1 order are new". The agent looks up rules before answering via the `get_business_context` tool.

### Dataset Bundle

A trust boundary — which tables, joins, and time filters the agent can use. A query referencing a table outside the bundle is rejected. Only declared joins are allowed.

### Policy Engine

Hard enforcement at query time. PII columns are blocked. Row limits enforced. SQL is parsed to prevent multi-statement injection. No bypass.

### Governance Graph

All four layers compile into a typed directed graph (nodes: tables, columns, measures, rules, classifications, policies; edges: aggregates, blocks, classifies, applies_to). Enables lineage, impact analysis, gap detection, and explainability.

The graph is exposed to the agent as callable tools — so it can answer "Why is first_name blocked?" and "What breaks if the amount column changes?" in real time.

## Quickstart

**Step 1**: Install dazense-core

```bash
pip install dazense-core
```

**Step 2**: Initialize a project

```bash
dazense init
```

This creates a project folder with a `dazense_config.yaml` configuration file. The wizard prompts for database connections and LLM provider.

**Step 3**: Sync database metadata

```bash
dazense sync
```

Generates markdown documentation (columns, sample data, descriptions) for every table — so the agent understands your database without querying it directly.

**Step 4**: Launch the chat

```bash
dazense chat
```

Opens the chat UI at `http://localhost:5005`. Ask questions in natural language.

**Step 5**: Add governance (optional, incremental)

| File                           | Layer          | What it does                                              |
| ------------------------------ | -------------- | --------------------------------------------------------- |
| `semantics/semantic_model.yml` | Semantic Layer | Define measures, dimensions, joins with baked-in filters  |
| `semantics/business_rules.yml` | Business Rules | Domain constraints, classifications (PII, Financial)      |
| `datasets/*/dataset.yaml`      | Dataset Bundle | Table allowlist, join allowlist, time filter requirements |
| `policies/policy.yml`          | Policy         | PII blocking, SQL validation, row limits                  |

See the full [Tutorial](docs/TUTORIAL.md) for a step-by-step guide.

## Commands

```
dazense init          Create a new project
dazense sync          Sync database metadata to local files
dazense debug         Test database and LLM connectivity
dazense validate      Check configuration consistency
dazense chat          Open the chat UI
dazense graph show    Governance graph node/edge counts
dazense graph lineage Trace upstream dependencies
dazense graph impact  Measure downstream blast radius
dazense graph gaps    Find governance coverage gaps
dazense eval          Run automated governance tests
```

## Supported Databases

DuckDB, PostgreSQL, BigQuery, Snowflake, Databricks, SQL Server, Redshift

## Architecture

```
dazense/
  cli/              Python CLI (dazense-core on PyPI)
  apps/backend/     TypeScript backend (Fastify + tRPC)
  apps/frontend/    React chat UI
  apps/shared/      Shared Zod schemas
```

The CLI handles project initialization, sync, validation, and graph commands. The backend serves the chat UI, runs the agent, and enforces governance at query time. The semantic layer execution engine uses Ibis for cross-database compatibility.

### Stack

**Backend**: Fastify, Drizzle, tRPC, Bun

**Frontend**: React, TanStack Query, Shadcn

**CLI**: Python, Cyclopts, Rich, Ibis

**Semantic Engine**: Ibis (compiles to DuckDB, PostgreSQL, BigQuery, Snowflake, Databricks)

## Development

```bash
# Install dependencies
npm install

# Run in dev mode (backend + frontend + FastAPI)
npm run dev

# Lint
npm run lint

# Run Python tests
cd cli && uv run pytest tests/ -v
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Docker

```bash
docker pull metazense/dazense:latest

docker run -d \
  --name dazense \
  -p 5005:5005 \
  -e BETTER_AUTH_URL=http://localhost:5005 \
  -v /path/to/your/project:/app/project \
  -e DAZENSE_DEFAULT_PROJECT_PATH=/app/project \
  metazense/dazense:latest
```

See [DockerHub](https://hub.docker.com/r/metazense/dazense) and the [Deployment Guide](https://dadocs.metazense.com/dazense-agent/self-hosting/deployment-guide) for details.

## Community

- Star the repo
- Follow us on [LinkedIn](https://www.linkedin.com/company/metazense)
- Join our [Slack](https://metazense.slack.com)
- Contribute!

## License

Apache 2.0 — see [LICENSE](LICENSE).

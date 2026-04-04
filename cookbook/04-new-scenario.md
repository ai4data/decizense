# Cookbook 04: Create a New Scenario

Build your own scenario (banking, retail, healthcare) for the harness. The harness code doesn't change — only the config folder.

## Folder structure

Create `scenario/<your-domain>/` with:

```
scenario/banking/
  scenario.yml              ← Database + catalog connection
  agents.yml                ← Agent definitions + permissions
  databases/
    docker-compose.yml      ← PostgreSQL container
    init.sql                ← Schema (tables, indexes, decision tables)
    generate_data.py        ← Synthetic data generator
  datasets/
    lending/
      dataset.yaml          ← Bundle: loan tables
    compliance/
      dataset.yaml          ← Bundle: compliance tables
  semantics/
    semantic_model.yml      ← Measures + dimensions
    business_rules.yml      ← Rules with rationale
  policies/
    policy.yml              ← PII, risk classification, execution limits
  ontology/
    concepts.yml            ← Domain concepts
    intents.yml             ← Business questions → measures
```

## Step 1: scenario.yml

```yaml
name: banking
display_name: Acme Bank Operations
description: Lending, compliance, and fraud detection
domain: banking-operations
database:
    type: postgresql
    host: localhost
    port: 5434 # different port from travel
    name: banking_db
    user: banking_admin
    password: "{{ env('BANKING_DB_PASSWORD', 'banking_pass') }}"
catalog:
    provider: openmetadata # or atlan, collibra
    url: "{{ env('CATALOG_URL', 'http://localhost:8585') }}"
    token: "{{ env('CATALOG_TOKEN') }}"
    service_name: banking_postgres
```

## Step 2: agents.yml

```yaml
agents:
    orchestrator:
        display_name: Banking Operations Orchestrator
        role: orchestrator
        can_query: false
        can_delegate_to: [lending, compliance, fraud]

    lending:
        display_name: Lending Agent
        role: domain
        bundle: lending
        can_query: true
        system_prompt: >
            You are a lending specialist. You analyze loan applications,
            portfolio health, and default risk.

    compliance:
        display_name: Compliance Agent
        role: domain
        bundle: compliance
        can_query: true
        system_prompt: >
            You are a compliance officer. You check regulatory requirements,
            KYC status, and AML flags. PII is blocked.

    fraud:
        display_name: Fraud Detection Agent
        role: domain
        bundle: fraud
        can_query: true
        system_prompt: >
            You analyze transaction patterns for fraud indicators.

inter_agent:
    data_sharing: aggregated_only
    pii_in_findings: stripped
    max_agents_per_session: 4
    max_llm_calls_per_agent: 10
    cost_limit_per_decision: 0.50

permissions:
    orchestrator:
        can_propose: [low, medium, high, critical]
        can_approve: [low, medium]
        can_execute: []
    lending:
        can_propose: [low, medium, high]
        can_approve: [low]
        can_execute: [low]
    compliance:
        can_propose: [low, medium]
        can_approve: [low]
        can_execute: [low]
    fraud:
        can_propose: [low, medium, high]
        can_approve: [low]
        can_execute: [low]
```

## Step 3: Define bundles (datasets/)

```yaml
# datasets/lending/dataset.yaml
bundle_id: lending
display_name: Lending
tables:
    - schema: public
      table: loan_applications
    - schema: public
      table: loans
    - schema: public
      table: payments
joins:
    - left: { schema: public, table: payments, column: loan_id }
      right: { schema: public, table: loans, column: loan_id }
```

## Step 4: Business rules with rationale

```yaml
# semantics/business_rules.yml
rules:
    - name: kyc_before_approval
      category: compliance
      severity: error
      description: Loan cannot be approved without completed KYC
      applies_to: [loans.approved_loans]
      guidance: Always verify KYC status before approving
      rationale:
          source: regulation
          reference: 'AML-2024-001'
          description: 'Anti-money laundering regulation requires KYC'
```

## Step 5: Policy with risk classification

```yaml
# policies/policy.yml
pii:
    mode: block
    columns:
        public.customers:
            - ssn
            - date_of_birth
            - phone_number

actions:
    risk_classification:
        send_notification: low
        flag_for_review: medium
        approve_loan: high
        block_account: critical
    approval_requirements:
        low: auto
        medium: auto
        high: human_required
        critical: senior_required
```

## Step 6: Database schema

Create `databases/init.sql` with your domain tables. Include the decision store tables (copy from travel scenario init.sql, lines 120+).

## Step 7: Run

```bash
# Start database
cd scenario/banking/databases && docker compose up -d

# Generate data
python generate_data.py

# Run harness
cd ../../../harness
SCENARIO_PATH=../scenario/banking npx tsx src/server.ts

# Test
cd ../agents
SCENARIO_PATH=../scenario/banking npx tsx src/test-query.ts
```

## Key principle

The harness code is 100% generic. All domain-specific logic lives in:

- `scenario.yml` → what to connect to
- `agents.yml` → who can do what
- `datasets/` → what each agent can see
- `business_rules.yml` → what rules to follow
- `policy.yml` → what to block and at what risk

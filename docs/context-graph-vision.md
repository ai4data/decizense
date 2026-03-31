# From Governance Graph to Context Graph

## Why this document

dazense started as a trusted analytics copilot with governance enforcement. The governance graph compiles YAML (semantic models, business rules, policies, dataset bundles) into a typed directed graph that enforces access control, detects gaps, and explains decisions.

Recent industry thinking — Foundation Capital's "Context Graphs: AI's Trillion Dollar Opportunity", Metadata Weekly's analysis, and Year of the Graph's synthesis — points to a broader opportunity: **context graphs** that capture not just what's allowed, but why decisions were made, what precedent exists, and what context agents need at the moment of decision.

This document maps where dazense is today to where context graphs are, and defines a clear evolution path.

## What is a context graph?

A context graph is a knowledge graph enriched with four layers:

1. **Structural**: Entities and their relationships (tables, columns, measures, rules)
2. **Semantic**: Meaning, definitions, ontological grounding (glossary terms, concept hierarchies, intent mappings)
3. **Temporal**: Freshness, SLAs, change history (is this data trustworthy right now?)
4. **Decision**: Why decisions were made, precedent search, exception handling (searchable institutional memory)

The key difference from a traditional knowledge graph: context graphs are **decision-centric**. They capture the inputs, policies, exceptions, approvals, and rationale that transformed data into action.

> "A living record of decision traces stitched across entities and time so precedent becomes searchable." — Foundation Capital

## Where dazense is today

| Layer          | Context graph needs                | dazense has                                                                                                | Gap                                                    |
| -------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Structural** | Entities + relationships           | 13 node types, 21 edge types. Tables, columns, measures, rules, classifications, policies, glossary terms. | Small — missing quality/cost nodes                     |
| **Semantic**   | Meaning, ontology, intent          | Semantic model (measures, dimensions), glossary terms with synonyms and relationships from catalog         | Medium — no formal ontology, no intent mapping         |
| **Temporal**   | Freshness, SLAs, versioning        | Contract timestamps, catalog snapshot `generated_at`                                                       | Large — no freshness expectations, no graph versioning |
| **Decision**   | Why decisions were made, precedent | Contract traces (DECIDED, FAILED, TOUCHED, USED)                                                           | Medium — no reasoning context on rules, no exceptions  |

### What's closer than it appears

- **Contract traces** are already decision lineage — every query generates a decision record with allow/block/clarify outcomes
- **Catalog enrichment** is already federated metadata — OMD/Atlan/Collibra feed governance signals into the same graph
- **Semantic model** is already a lightweight ontology — measures and dimensions are semantic annotations on physical data
- **Pluggable catalog** is already an integrator platform — dazense sits between the catalog (governance source), the database (data), and the AI agent (consumer)

## The evolution path

### Phase 3: Decision Context — "Why do these rules exist?"

The single highest-value gap. Every Rule node has `severity` and `guidance` but no structured reasoning about WHY the rule exists.

**What changes:**

New node types:

- `Rationale` — captures why a rule/policy exists (author, source incident, date, description)
- `Exception` — a time-scoped override of a rule (granted_by, expires_at, justification)

New edge types:

- `JUSTIFIED_BY`: Rule/Policy → Rationale
- `OVERRIDES`: Exception → Rule
- `SCOPED_TO`: Exception → specific entity

YAML extension (backward compatible):

```yaml
# business_rules.yml
rules:
    - name: exclude_returned_orders
      category: data_quality
      severity: error
      description: Revenue calculations must exclude returned orders
      rationale:
          source: incident
          reference: 'INC-2024-0312'
          description: 'Including returned orders inflated Q4 2024 revenue by 12%'
          author: data-eng-team
          date: 2024-04-15
```

**What the agent can do after this:**

```
User:  "Why do we exclude returned orders from revenue?"
Agent:  Traverses Rule → JUSTIFIED_BY → Rationale
        "Because including them inflated Q4 2024 revenue by 12%.
         This was identified in incident INC-2024-0312 and the rule
         was added by the data engineering team on April 15, 2024."
```

This turns the governance graph into a **searchable precedent base** — the core value of context graphs per Foundation Capital.

---

### Phase 4: Temporal Context — "Is this data trustworthy right now?"

**What changes:**

New node type:

- `Expectation` — freshness/completeness/volume expectations per table

New edge types:

- `EXPECTS`: Table → Expectation
- `OBSERVED`: catalog snapshot → Table (with observed_at, row_count, last_modified)

YAML extension:

```yaml
# dataset.yaml
tables:
    - name: orders
      expectations:
          - type: freshness
            max_delay_hours: 24
          - type: completeness
            min_row_count: 100000
```

**What the agent can do:**

Before querying, check "is the orders table fresh enough?" If the catalog snapshot shows `last_modified` was 48 hours ago and the expectation is 24 hours, warn the user or refuse the query.

Integration point: the catalog sync already fetches table metadata. Extending the snapshot with `last_modified` and `row_count` enables this automatically.

---

### Phase 5: Semantic Context — "What business question does this answer?"

**Sub-phase 5a: Intent nodes**

New node type:

- `Intent` — a declared business question or use case

New edge types:

- `ANSWERS`: Measure/Dimension → Intent
- `DERIVED_FROM`: Measure → Measure (metric composition)

```yaml
# NEW file: intents.yml
intents:
    - question: 'How is monthly revenue trending?'
      domain: finance
      answered_by:
          - measure: orders.total_revenue
          - dimension: orders.order_month
      stakeholders: [finance-team, exec-dashboard]

    - question: 'Who are our most valuable customers?'
      domain: customer-analytics
      answered_by:
          - measure: customers.customer_lifetime_value
          - dimension: customers.number_of_orders
      stakeholders: [marketing-team]
```

**What the agent can do:**

User asks "how is revenue doing?" → graph finds Intent match → knows exactly which measures and dimensions to use. No guessing from column names.

This is the **knowledge-first paradigm** from the ontologies article — the graph tells the agent what to use, rather than the agent inferring from names and descriptions.

**Sub-phase 5b: Lightweight ontology**

New node type:

- `Concept` — domain concepts (Revenue, Customer, Order)

New edge types:

- `IS_A`: concept hierarchy (GrossRevenue IS_A Revenue)
- `REPRESENTS`: Measure/Dimension → Concept

This bridges GlossaryTerms (flat list from catalog) to a structured concept hierarchy. Not full OWL — practical and maintainable.

```yaml
# NEW file: concepts.yml
concepts:
    - name: Revenue
      description: Monetary value from business operations
      children:
          - name: NetRevenue
            description: Revenue after returns and refunds
          - name: GrossRevenue
            description: Revenue before returns and refunds

    - name: Customer
      children:
          - name: NewCustomer
            description: Customer with exactly 1 order
          - name: ReturningCustomer
            description: Customer with 2+ orders
```

---

### Phase 6: Agent-Native Context Serving (KAG)

The endgame. Replace RAG-style retrieval with **Knowledge Augmented Generation** — graph-structured context for agents.

- `GovernanceGraph.contextFor(question)` — traverses the graph to assemble a focused context window: relevant measures, their lineage, applicable rules with rationales, freshness status, intent matches, precedent from past decisions
- Precedent search: "Has a similar question been asked before? What was decided?"
- Confidence scoring: based on freshness expectations, coverage gaps, and rule compliance

This is emergent — it works because all prior layers provide the data. Not a feature you build directly.

## What changes in dazense's identity

| Before                    | After                                                |
| ------------------------- | ---------------------------------------------------- |
| Trusted Analytics Copilot | Enterprise Context Platform for AI Agents            |
| Governance enforcement    | Context-aware decision infrastructure                |
| "Is this allowed?"        | "Is this allowed, why, and is the data trustworthy?" |
| Policy engine             | Decision System of Record                            |
| Analytics-only            | Any AI agent that needs governed data access         |

## What does NOT change

- **Compiler metaphor**: YAML → compiled graph. Same pattern, more node/edge types.
- **Catalog integration**: OMD/Atlan/Collibra/Purview as context source. Same pluggable architecture.
- **Policy enforcement**: PII blocking, SQL validation, bundle restrictions. Unchanged.
- **Agent tools**: graph_explain, graph_lineage, graph_impact, graph_gaps. Extended, not replaced.

## Graph type evolution

| Phase               | New Nodes             | New Edges                           | New YAML                                        |
| ------------------- | --------------------- | ----------------------------------- | ----------------------------------------------- |
| Current (V2)        | 13 types              | 21 types                            | semantic_model, business_rules, policy, dataset |
| Phase 3 (Decision)  | +Rationale, Exception | +JUSTIFIED_BY, OVERRIDES, SCOPED_TO | `rationale:` in business_rules.yml              |
| Phase 4 (Temporal)  | +Expectation          | +EXPECTS, OBSERVED                  | `expectations:` in dataset.yaml                 |
| Phase 5a (Intent)   | +Intent               | +ANSWERS, DERIVED_FROM              | intents.yml (new file)                          |
| Phase 5b (Ontology) | +Concept              | +IS_A, REPRESENTS                   | concepts.yml (new file)                         |
| Phase 6 (KAG)       | —                     | —                                   | Code only (API layer)                           |
| **Total**           | **18 types**          | **32 types**                        | **Meaningful expansion, not a rewrite**         |

## The business case

Per Foundation Capital: the trillion-dollar opportunity belongs to **integrator platforms** that capture and serve decision context — not to vertical agent applications.

dazense is already an integrator: it sits between the catalog, the database, and the AI agent. The evolution to a context graph deepens this position by making dazense the **system of record for how enterprise data is governed, why, and with what confidence**.

The competitive moat: once an enterprise's decision traces, rationales, and intents are in the context graph, switching costs are high — it's institutional memory, not just configuration.

## References

- Foundation Capital: [Context Graphs: AI's Trillion Dollar Opportunity](https://foundationcapital.com/ideas/context-graphs-ais-trillion-dollar-opportunity)
- Metadata Weekly: [Context Graphs Are a Trillion-Dollar](https://metadataweekly.substack.com/p/context-graphs-are-a-trillion-dollar)
- Metadata Weekly: [Ontologies, Context Graphs, and Semantic](https://metadataweekly.substack.com/p/ontologies-context-graphs-and-semantic)
- Year of the Graph: [Beyond Context Graphs](https://yearofthegraph.xyz/newsletter/2026/03/beyond-context-graphs-how-ontology-semantics-and-knowledge-graphs-define-context-the-year-of-the-graph-newsletter-vol-30-spring-2026/)

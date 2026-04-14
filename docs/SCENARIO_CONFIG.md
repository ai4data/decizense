# Scenario configuration contract

The harness is sector-agnostic. All domain-specific behaviour — which
event types exist, what a "revenue" rule actually means, which tables
carry PII — lives in scenario YAML files, not in the harness code. A
scenario is a directory whose shape is documented below.

Every running harness instance must have `SCENARIO_PATH` set; there
is no implicit default. Point it at a scenario directory before
starting the server.

## Layout

```
<scenario>/
  scenario.yml                   required   metadata + database + auth
  agents.yml                     required   agents + permissions + inter-agent
  policies/policy.yml            required   pii columns, defaults, freshness
  datasets/<bundle>/dataset.yaml required   bundle tables + allowed joins
  semantics/
    semantic_model.yml           required   measures + dimensions; consumed by query_metrics
    business_rules.yml           required   rules (with optional `check`)
    signals.yml                  optional   process-signal definitions
    events.yml                   optional   event-log schema + correlation keys
```

`signals.yml` and `events.yml` are both optional. Scenarios without
`signals.yml` simply don't support `get_process_signals`; the tool
returns a structured `unsupported` response listing the configured
signals (none). Scenarios without `events.yml` don't support
`ingest_event` or `get_case_timeline`; those tools return the same
kind of structured `unsupported` response.

## `semantics/signals.yml`

Each entry defines one signal consumable via the `get_process_signals`
MCP tool. The harness does **no** domain interpretation of the
signal name — the template is executed verbatim against the scenario
database with pg-style parameter placeholders.

```yaml
signals:
    - name: event_distribution
      description: Human-readable sentence surfaced in responses.
      required_tables: [events] # informational only
      params:
          - name: time_range_days # caller-visible argument
            kind: int # 'int' | 'string'
            required: false # default is considered if absent
            default: 30
            max: 365 # optional upper bound for int params
            as_interval_days: true # format as "N days" for pg interval binding
      sql: |
          SELECT event_type, COUNT(*) AS count
          FROM events
          WHERE timestamp >= NOW() - $1::interval
          GROUP BY event_type
          ORDER BY count DESC
          LIMIT 20
```

### Rules

- **No string interpolation into the SQL.** Use pg placeholders
  (`$1`, `$2`, ...). Each placeholder binds to the same-indexed entry
  of `params`. The harness never substitutes values into the SQL
  text; only pg does the binding at execution time.
- **Param kinds.** `int` values are parsed with `Number`, rejected
  if non-integer, and optionally formatted as a pg interval literal
  (`as_interval_days`). `string` values pass through as-is.
- **Max scan bound.** For int params, `max` rejects over-sized scans
  so a caller cannot ask for two years of event history by accident.
- **Unsupported signals.** A caller that requests a signal name not
  present in the file gets a structured response:
    ```json
    {
        "status": "unsupported",
        "signal_type": "<name>",
        "configured_signals": [{ "name": "...", "description": "...", "params": [...] }]
    }
    ```

## `semantics/events.yml`

Declares the scenario's event-log table and the correlation keys
stamped on each event. Read by `ingest_event` (which assembles its
INSERT from the declared columns) and by `get_case_timeline` (which
filters by a chosen correlation key). The harness contains no
travel-shaped column names; everything below is data.

```yaml
table: events # required — event-log table
type_column: event_type # required — string discriminator column
timestamp_column: timestamp # required — event time column
metadata_column: metadata # optional — JSONB column for ingest_event payloads
id_column: event_id # optional — primary-key column returned by ingest_event

correlation_keys: # required — at least one
    - name: booking_id # caller-visible argument name
      column: booking_id # database column name (usually === name)
      kind: int # 'int' | 'string'
      description: Booking / case identifier — primary correlation for process mining.
    - name: customer_id
      column: customer_id
      kind: int
```

### Rules

- **`correlation_keys` is the contract.** `ingest_event` accepts only
  declared key names in its `correlations` map; unknown keys are
  rejected with a structured error listing the legal options. Missing
  keys are stored as SQL NULL.
- **`get_case_timeline`** takes `case_key` + `case_id`. `case_key`
  must match a declared correlation key by name; otherwise the call
  returns `status: error` with `available_case_keys` echoed back.
- **Type coercion** runs against `kind`. An int-keyed case rejects
  non-numeric strings before the SQL is built — typos surface as a
  structured `status: error` with `expected_kind`, not a database
  error.
- **No string interpolation into SQL.** Both tools assemble SQL from
  the column names you declared and bind values via pg placeholders.

## `semantics/semantic_model.yml` and the `query_metrics` tool

The semantic model is the executable definition of every governed
metric in the scenario. The harness's `query_metrics` MCP tool
compiles requests against this file into parameterised PostgreSQL —
no string interpolation, no LLM-authored SQL, no scaffolding.

### Model shape

```yaml
models:
    - name: flights # the user-facing model name
      table: { schema: public, table: flights }
      time_dimension: scheduled_departure # column name (bare)

      dimensions:
          - name: airline # caller refs as "flights.airline"
            column: airline_code # actual db column

      measures:
          - name: delayed_flights # caller refs as "flights.delayed_flights"
            column: flight_id
            aggregation: count # count | count_distinct | sum | avg | min | max
            filters: # measure-level FILTER (WHERE …) clause
                - column: status
                  operator: '='
                  value: delayed
```

Joins between models are not declared in `semantic_model.yml` —
they live per-bundle in `datasets/<bundle>/dataset.yaml`. The
compiler refuses cross-model queries when no bundle-level join
exists between them.

### `query_metrics` request shape

```jsonc
{
	"measures": ["flights.delayed_flights", "flights.total_flights"], // required
	"dimensions": ["flights.airline"], // optional
	"filters": [
		// optional; each operator family supported below
		{ "field": "flights.status", "operator": "!=", "value": "cancelled" },
	],
	"time_range": { "start": "2026-03-01", "end": "2026-04-01" }, // optional
	"time_grain": "week", // optional: year|quarter|month|week|day|hour
	"order_by": [{ "field": "delayed_flights", "direction": "desc" }], // optional
	"limit": 10, // optional, clamped to [1, 50000]
}
```

Operators: `=`, `!=`, `<`, `<=`, `>`, `>=` (single value), `in` /
`not_in` (with `values` array), `is_null` / `is_not_null` (no value),
`between` (with `range: [low, high]`).

### `query_metrics` response shape

```jsonc
{
    "status": "ok",
    "rows": [{ "airline": "NF", "delayed_flights": "7", "total_flights": "99" }, …],
    "row_count": 5,
    "generated_sql": "SELECT \"flights\".\"airline_code\" AS \"airline\", COUNT(flights.flight_id) FILTER (WHERE flights.status = $1) AS \"delayed_flights\", …",
    "resolved_measures": [
        {
            "ref": "flights.delayed_flights",
            "expression": "COUNT(flights.flight_id) FILTER (WHERE flights.status = $1)",
        },
    ],
    "resolved_dimensions": [{ "ref": "flights.airline", "column": "flights.airline_code" }],
    "applied_time_window": { "column": "flights.scheduled_departure", "start": "2026-03-01", "end": "2026-04-01" },
    "governance": { "policy_version": "<sha>", "contract_id": "<id>" },
}
```

The `generated_sql` and `resolved_*` blocks are first-class —
callers see exactly what was computed without inferring it from the
rows.

### Structured errors

When validation fails the tool returns `{status: "error", code,
reason, details}` rather than throwing. Codes the planner / compiler
can emit:

- `unknown_measure` / `unknown_dimension` — with `available` list +
  `suggestion` (Levenshtein "did you mean?").
- `ambiguous_ref` — bare `field` without `model.` prefix is rejected
  even when unique today.
- `unknown_model` / `invalid_aggregation` / `invalid_operator` /
  `invalid_value` / `invalid_time_range` / `invalid_time_grain`.
- `out_of_bundle` — the requested model isn't in the agent's bundle.
- `disallowed_join` — cross-model query without an allowed_joins edge
  in the agent's bundle. Echoes `declared_in_bundle` for diagnostics.
- `fanout_refused` — non-distinct aggregation across a one_to_many
  join would silently double-count. Suggests `count_distinct` or
  per-model aggregation.
- `time_filter_required` — bundle declares a mandatory time filter
  that the request omitted.
- `governance_blocked` — OPA refused the compiled SQL or the
  metric_refs.
- `execution_failed` — Postgres rejected the SQL after compilation.

### What stays in code, what stays in YAML

| Concern                         | YAML               | Code                                  |
| ------------------------------- | ------------------ | ------------------------------------- |
| Measure / dimension names       | semantic_model.yml | —                                     |
| Aggregation kind                | semantic_model.yml | `ALLOWED_AGGREGATIONS` set            |
| Measure-level FILTER predicates | semantic_model.yml | —                                     |
| Cross-model joins               | dataset.yaml       | —                                     |
| Bundle scope                    | dataset.yaml       | enforced by planner                   |
| PII columns                     | policy.yml         | filtered by executor (via governance) |
| Time-filter requirements        | dataset.yaml       | enforced by planner                   |
| SQL skeleton & quoting          | —                  | sql-compiler.ts                       |
| Param binding                   | —                  | sql-compiler.ts (pg `$N` only)        |

## `semantics/business_rules.yml` — the `check` field

The harness's `verify_result` and `check_consistency` tools no
longer string-match on rule names. They drive off an optional
`check` block per rule. If a rule has no `check`, the tool reports
`manual-verification-needed` for that rule — loud, structured, and
honest about what the harness can and cannot verify.

### Pattern kinds

#### `sql_pattern` — matches against the candidate SQL

```yaml
- name: revenue_excludes_cancelled
  severity: error
  # ... description, applies_to, guidance ...
  check:
      kind: sql_pattern
      applies_when:
          require_any: [total_amount] # only if the SQL touches total_amount
      require:
          require_all: [cancelled] # then it must also mention cancelled
      # other fields: require_any (OR), forbid_any (NONE)
      message: 'Query sums total_amount without filtering cancelled.'
```

Semantics:

- `applies_when` is an optional gate. If absent or it matches, the
  rule applies. If it doesn't match, the rule is `not_applicable` —
  neither pass nor fail.
- `require` is a conjunction of three sub-constraints:
    - `require_all`: every listed token must appear in the candidate.
    - `require_any`: at least one listed token must appear.
    - `forbid_any`: none of the listed tokens may appear.

All matches are case-insensitive substring tests. No regex.

#### `text_pattern` — same shape, but target is the result text

```yaml
check:
    kind: text_pattern
    applies_when:
        require_all: [compensation, delay]
    require:
        require_any: ['3 hour', '180 min']
    message: 'Compensation discussed but threshold not referenced.'
```

Use this when the check is about the agent's narrative output
(`result_summary`) rather than the SQL it wrote.

#### `pii_columns` — generic PII check from policy metadata

```yaml
check:
    kind: pii_columns
    message: 'Query references PII columns declared in policy.yml.'
```

No token list is encoded in the rule itself. The harness supplies the
blocked-column set from `policies/policy.yml > pii.columns` and the
check fails if the candidate SQL references any of them (using a
word-boundary match to avoid false positives on substrings).

#### `query_result` (reserved, not yet executed by the harness)

```yaml
check:
    kind: query_result
    sql: 'SELECT COUNT(*) AS count FROM decision_outcomes WHERE ...'
    expect: { column: count, op: '<=', value: 0 }
```

Reserved for future use. Today, the evaluator returns `manual` for
`query_result` and expects the caller to execute and compare
explicitly.

#### `manual` — enforced out-of-band

```yaml
check:
    kind: manual
    message: 'Reviewed weekly by compliance.'
```

Explicit signal that the rule has no machine verification path. The
tool reports this in a structured `manual_verification_needed`
field rather than silently passing.

### Rules without `check`

Legal, and they still travel through the evaluator — they just come
back as `manual`. The verifier surfaces them in a structured
`manual_verification_needed` list so authors can see their coverage
gap at a glance.

## `SCENARIO_PATH` is mandatory

Before starting the harness:

```bash
# Linux / macOS / WSL
export SCENARIO_PATH=../scenario/travel

# Windows PowerShell
$env:SCENARIO_PATH = '../scenario/travel'
```

Starting the harness without `SCENARIO_PATH` is a fatal error:

```
[harness] Fatal: SCENARIO_PATH environment variable is required.
Point it at a scenario directory, e.g. SCENARIO_PATH=../scenario/travel.
```

This is deliberate. Scenario choice is a deployment concern; a silent
default risked a production harness booting as the travel demo if
someone forgot to set it.

## Dev convenience — `harness/.env.harness-dev`

`SCENARIO_PATH` is mandatory, but requiring every contributor to export
it manually before `npm run dev` is needlessly abrasive. The `harness/`
workspace ships a small env file at `harness/.env.harness-dev` with
default values suitable for local development (travel scenario, HTTP
transport, localhost:9080, insecure config-only auth). `package.json`
wires it into the dev/start scripts via Node's `--env-file` flag:

```json
"scripts": {
  "dev":   "tsx watch --env-file=.env.harness-dev src/server.ts",
  "start": "tsx --env-file=.env.harness-dev src/server.ts"
}
```

Note the flag position in `dev`: tsx requires the `watch` subcommand
to come **before** any flags. `tsx --env-file=… watch src/server.ts`
errors with `ERR_MODULE_NOT_FOUND .../harness/watch` because tsx
parses `watch` as the entry-point file rather than as the subcommand.

From `harness/`:

```bash
npm run dev
```

…now Just Works, and matches what `scripts/dev-all.ps1` sets when run
from the repo root. Production deployments continue to pass
`SCENARIO_PATH` through their own environment and never touch this
file.

## Authoring a new scenario — checklist

1. Copy the layout above into a new directory.
2. Fill `scenario.yml` (name, database, auth mode).
3. Define agents in `agents.yml` (role, bundle, system_prompt, identity).
4. Declare PII columns and defaults in `policies/policy.yml`.
5. Create one or more bundles in `datasets/<bundle>/dataset.yaml`.
6. Define your measures/dimensions in `semantics/semantic_model.yml`.
7. Write rules in `semantics/business_rules.yml`. Add a `check` block
   to any rule you want verified mechanically; leave it off for
   rules enforced by human review.
8. If your domain needs process signals, author
   `semantics/signals.yml` with pg-parameterised SQL templates.
9. Point the harness at it: `SCENARIO_PATH=/path/to/your/scenario`.

No harness source changes are required to add a new scenario. A
minimal non-travel example lives at `scenario/_fixtures/minimal/` and
is exercised by `harness/src/tests/test-scenario-neutral.ts` in
the smoke suite.

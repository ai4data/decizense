# policy/ — OPA governance bundle (Plan v3 Phase 2)

This directory holds the OPA bundle the harness queries on every `query_data`
and `query_metrics` call. In **Phase 2a** (this branch) the bundle runs in
**shadow mode**: OPA evaluates in parallel with the in-code TS rules, and the
harness logs any disagreement. The in-code result is still authoritative.
Phase 2b cuts over to OPA-authoritative and deletes the in-code rules.

## Files

| File           | Kind                                       | Source of truth                                         |
| -------------- | ------------------------------------------ | ------------------------------------------------------- |
| `dazense.rego` | Rego policy                                | Hand-written; mirrors `harness/src/governance/index.ts` |
| `build.ts`     | Node/TS builder                            | Hand-written                                            |
| `build.sh`     | Bash wrapper around `build.ts`             | Hand-written                                            |
| `data.json`    | OPA data document                          | **Generated** — regenerate with `./build.sh`            |
| `.manifest`    | OPA bundle manifest with `sha256` revision | **Generated** — regenerate with `./build.sh`            |

## When to rebuild

Rerun `./policy/build.sh` (and commit the result) whenever any of these
change:

- `scenario/*/agents.yml` — agent roles, bundles, permissions
- `scenario/*/datasets/*/dataset.yaml` — bundle tables, joins
- `scenario/*/policies/policy.yml` — PII columns, limits, execution toggles

The build is deterministic: keys are sorted at every level so `data.json`'s
sha256 (the bundle revision) only changes when policy actually changes.

## Running OPA locally

```bash
docker compose -f docker/docker-compose.opa.yml up -d
curl -s http://localhost:8181/health
```

OPA hot-loads `policy/` at startup and exposes the decision at
`/v1/data/dazense/governance/result`.

## Phase 2 scope guardrails

- **No cross-bundle joins** — today's TS governance doesn't check them per
  query, so the Rego doesn't either. Equivalence first; new rules later.
- **PII columns frozen in `data.json`** — sourced ONLY from
  `scenario/*/policies/policy.yml`, NOT from the live catalog (OpenMetadata).
  The catalog is not queried during bundle build. Replayability requires a
  frozen snapshot. If catalog PII tags change, they must first be reflected
  in `policy.yml`, then `./build.sh` must be rerun. A future follow-up item
  will add a bundle rebuild hook triggered by catalog tag changes.
- **`filterPiiFromResults` stays in TS** — defense-in-depth on the response
  path, not the allow/deny gate, so it's unaffected by this migration.

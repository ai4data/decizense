# Phase 0 Verification Summary

Generated: 2026-04-05T12-09-51

## test-query.ts trace

- Trace ID: `441dddfd268514665ec25078a89035a1`
- Total spans: 6

### Span tree

```
[dazense-test-query       ] test_query.main                          parent=ROOT
[dazense-harness          ] dazense.tool.initialize_agent            parent=eb503e72
[dazense-harness          ] dazense.tool.query_data                  parent=eb503e72
[dazense-harness          ] dazense.tool.query_data                  parent=eb503e72
[dazense-harness          ] dazense.tool.query_data                  parent=eb503e72
[dazense-harness          ] dazense.tool.get_business_rules          parent=eb503e72
```

### Sample dazense.* attributes (first span with them)

```
Span: dazense.tool.query_data
  dazense.agent.id: flight_ops
  dazense.agent.uri: agent://dazense.local/flight_ops
  dazense.auth.method: config-only
  dazense.governance.allowed: True
  dazense.governance.contract_id: contract-1775383802531-gyj81a
  dazense.query.duration_ms: 35
  dazense.query.row_count: 3
  dazense.session.id: test-001
  dazense.sql.hash: 35026089c8e208cb
  dazense.sql.length: 85
  dazense.tool.name: query_data
```

## test-auth.ts trace

- Trace ID: `873d3bddd42ae85f0a098cb25b7f4d0a`
- Total spans: 4

### Span tree

```
[dazense-test-auth        ] test_auth.main                           parent=ROOT
[dazense-harness          ] dazense.tool.initialize_agent            parent=151d45d2
[dazense-harness          ] dazense.tool.initialize_agent            parent=151d45d2
[dazense-harness          ] dazense.tool.write_finding               parent=151d45d2
```

### Sample dazense.* attributes (first span with them)

```
Span: test_auth.main
  dazense.test.name: test-auth
```


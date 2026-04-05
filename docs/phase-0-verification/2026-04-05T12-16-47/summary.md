# Phase 0 Verification Summary

Generated: 2026-04-05T12-16-47

## test-query.ts trace

- Trace ID: `335cc69f4406a1fefc53ff164aad9fe5`
- Total spans: 6

### Span tree

```
[dazense-test-query       ] test_query.main                          parent=ROOT
[dazense-harness          ] dazense.tool.initialize_agent            parent=f4d30282
[dazense-harness          ] dazense.tool.query_data                  parent=f4d30282
[dazense-harness          ] dazense.tool.query_data                  parent=f4d30282
[dazense-harness          ] dazense.tool.query_data                  parent=f4d30282
[dazense-harness          ] dazense.tool.get_business_rules          parent=f4d30282
```

### Sample dazense.* attributes (first span with them)

```
Span: dazense.tool.initialize_agent
  dazense.agent.id: flight_ops
  dazense.agent.uri: agent://dazense.local/flight_ops
  dazense.auth.method: config-only
  dazense.question.length: 4
  dazense.requested_agent_id: flight_ops
  dazense.session.id: test-001
  dazense.tool.name: initialize_agent
```

## test-auth.ts trace

- Trace ID: `d053f9bad9e65f4be9fecdc08fdc097f`
- Total spans: 4

### Span tree

```
[dazense-test-auth        ] test_auth.main                           parent=ROOT
[dazense-harness          ] dazense.tool.initialize_agent            parent=a16ac490
[dazense-harness          ] dazense.tool.initialize_agent            parent=a16ac490
[dazense-harness          ] dazense.tool.write_finding               parent=a16ac490
```

### Sample dazense.* attributes (first span with them)

```
Span: test_auth.main
  dazense.test.name: test-auth
```


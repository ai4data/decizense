# Cookbook 03: Governance Deep Dive

Test every governance feature: PII blocking, bundle scoping, business rules, risk classification, and decision lifecycle.

## PII Blocking

### Test 1: Direct PII query (should block)

```bash
cd agents
npx tsx src/test-query.ts
```

The test includes a PII query: `SELECT first_name, last_name FROM customers`. Expected: **BLOCKED** — customers table not in flights-ops bundle.

### Test 2: SELECT \* on PII table (should block)

Via the harness directly:

```bash
cd harness
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query_data","arguments":{"agent_id":"customer_service","sql":"SELECT * FROM customers LIMIT 5"}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: **BLOCKED** — SELECT \* on customers detects PII columns.

### Test 3: Safe query on PII table (should pass)

```bash
echo '...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query_data","arguments":{"agent_id":"customer_service","sql":"SELECT customer_id, loyalty_tier, country FROM customers LIMIT 5"}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: **SUCCESS** — customer_id, loyalty_tier, country are not PII.

## Bundle Scoping

### Test: Cross-bundle query (should block)

```bash
echo '...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query_data","arguments":{"agent_id":"flight_ops","sql":"SELECT * FROM bookings LIMIT 5"}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: **BLOCKED** — bookings is not in flights-ops bundle.

## Risk Classification

### Test: Low risk action (auto-approved)

```bash
echo '...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"execute_action","arguments":{"agent_id":"flight_ops","action_type":"notify_customer","parameters":{"message":"delay info"},"reason":"Inform passenger","session_id":"test"}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: `status: executed` — low risk, auto-approved.

### Test: High risk action (needs approval)

```bash
echo '...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"execute_action","arguments":{"agent_id":"flight_ops","action_type":"rebook_passenger","parameters":{"customer_id":"C101"},"reason":"Connection at risk","session_id":"test"}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: `status: pending_approval` — high risk, requires human.

### Test: Unauthorized agent (should deny)

```bash
echo '...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"execute_action","arguments":{"agent_id":"customer_service","action_type":"rebook_passenger","parameters":{},"reason":"test","session_id":"test"}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: `status: denied` — customer_service cannot propose high-risk actions.

## Decision Lifecycle

### Full lifecycle test

```bash
# 1. Propose
echo '...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"propose_decision","arguments":{"session_id":"gov-test","agent_id":"flight_ops","proposed_action":"No rebooking needed","confidence":"high","risk_class":"low","evidence_rules":["checkin_window"]}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null

# Note the proposal_id from the response, then:

# 2. Approve
echo '...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"approve_decision","arguments":{"proposal_id":1,"approved":true,"approved_by":"auto","reason":"Low risk"}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null

# 3. Execute
echo '...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"execute_decision_action","arguments":{"proposal_id":1,"executor_id":"flight_ops","action_type":"notify_customer","parameters":{"message":"safe"}}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null

# 4. Record outcome
echo '...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"record_outcome","arguments":{"session_id":"gov-test","question":"Is connection safe?","decision_summary":"Yes, safe","reasoning":"Buffer exceeds minimum","confidence":"high","agents_involved":["flight_ops"],"evidence_rules":["checkin_window"],"evidence_proposal_ids":[1]}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

### Verify in pgAdmin

Open `http://localhost:5050` and run:

```sql
SELECT * FROM decision_proposals ORDER BY created_at DESC LIMIT 5;
SELECT * FROM decision_approvals ORDER BY created_at DESC LIMIT 5;
SELECT * FROM decision_actions ORDER BY created_at DESC LIMIT 5;
SELECT * FROM decision_outcomes ORDER BY created_at DESC LIMIT 5;
SELECT * FROM memory_entries ORDER BY created_at DESC LIMIT 5;
```

## Evidence Validation

### Test: Invalid event ID (should reject)

```bash
echo '...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"propose_decision","arguments":{"session_id":"val-test","agent_id":"flight_ops","proposed_action":"test","confidence":"high","risk_class":"low","evidence_event_ids":[999999999]}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: `error: Evidence validation failed: Event IDs not found: 999999999`

### Test: Invalid rule name (should reject)

```bash
echo '...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"propose_decision","arguments":{"session_id":"val-test","agent_id":"flight_ops","proposed_action":"test","confidence":"high","risk_class":"low","evidence_rules":["nonexistent_rule"]}}}' | SCENARIO_PATH=../scenario/travel npx tsx src/server.ts 2>/dev/null
```

Expected: `error: Evidence validation failed: Business rules not found: nonexistent_rule`

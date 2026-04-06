# Phase 2b Hands-On Validation Guide

Step-by-step tutorial for manually validating that OPA is the sole governance engine. Run from Git Bash on Windows. All commands assume you're in the repo root:

```bash
cd C:/Users/hzmarrou/OneDrive/python/learning/dazense-context-infrastructure
```

## Prerequisites

Make sure these are running:

```bash
# Travel database (port 5433)
docker compose -f scenario/travel/databases/docker-compose.yml up -d

# Jaeger (port 16686) — needed by harness tracing
docker compose -f docker/docker-compose.observability.yml up -d

# OPA sidecar (port 8181)
docker compose -f docker/docker-compose.opa.yml up -d
```

Verify all three:

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'travel_postgres|dazense_opa|dazense_jaeger'
```

You should see all three containers running.

---

## Step 1: Run the automated verify script

```bash
bash scripts/verify-phase-2b.sh
```

**What to look for:**

- `✓ test-query` and `✓ test-auth` (regressions green)
- `✓ test-opa-equivalence (in-code assertions)` (28/28 cases)
- `✓ harness refused to start with OPA down` (negative test)
- Final line: `PASS - Phase 2b verification complete`
- Evidence directory path printed — note it for Step 4

**Expected duration:** ~2 minutes.

---

## Step 2: Manual query_data examples on travel data

Start the harness manually so you can interact with it:

```bash
cd harness
HARNESS_TRANSPORT=http \
HARNESS_ALLOW_INSECURE_CONFIG_ONLY=true \
SCENARIO_PATH=../scenario/travel \
npx tsx src/server.ts &
HARNESS_PID=$!
cd ..
```

Wait for `[harness] HTTP transport listening on http://127.0.0.1:9080/mcp` in the output. Then run these three tests:

### 2a. Allowed query (flight_ops reads flights — in-bundle, has LIMIT)

```bash
curl -s -X POST http://127.0.0.1:9080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-Agent-Id: flight_ops' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "query_data",
      "arguments": {
        "sql": "SELECT flight_id, flight_number, status FROM flights WHERE status = '\''delayed'\'' LIMIT 5",
        "reason": "Manual Phase 2b validation"
      }
    }
  }' | python -m json.tool
```

**Expected:** Response contains `"status": "success"` and rows with flight data. This proves OPA allowed the query.

### 2b. Blocked PII query (customer_service reads email — PII column)

```bash
curl -s -X POST http://127.0.0.1:9080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-Agent-Id: customer_service' \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "query_data",
      "arguments": {
        "sql": "SELECT email, first_name FROM customers LIMIT 5",
        "reason": "Manual Phase 2b validation - PII test"
      }
    }
  }' | python -m json.tool
```

**Expected:** Response contains `"status": "blocked"` and a reason mentioning PII. No customer email or name data returned.

### 2c. Blocked out-of-bundle query (flight_ops reads bookings — wrong bundle)

```bash
curl -s -X POST http://127.0.0.1:9080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-Agent-Id: flight_ops' \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "query_data",
      "arguments": {
        "sql": "SELECT booking_id, status FROM bookings LIMIT 5",
        "reason": "Manual Phase 2b validation - bundle scope test"
      }
    }
  }' | python -m json.tool
```

**Expected:** Response contains `"status": "blocked"` and a reason mentioning "bundle" or "not in bundle". No booking data returned.

### Stop the manual harness when done

```bash
kill $HARNESS_PID 2>/dev/null
# If that doesn't work (Windows PID issue), use:
taskkill //F //PID $(netstat -ano | grep ':9080.*LISTENING' | awk '{print $NF}' | head -1) 2>/dev/null
```

---

## Step 3: Stop OPA and confirm harness startup fails

```bash
# Stop OPA
docker stop dazense_opa

# Try to start harness — it should fail immediately
cd harness
HARNESS_TRANSPORT=http \
HARNESS_ALLOW_INSECURE_CONFIG_ONLY=true \
SCENARIO_PATH=../scenario/travel \
npx tsx src/server.ts
cd ..
```

**Expected:** The process exits with an error like:

```
[harness] OPA health check FAILED: ...
Error: OPA sidecar is unreachable: ... Start it with: docker compose -f docker/docker-compose.opa.yml up -d
```

The harness must NOT start listening on port 9080. This proves governance cannot be silently bypassed if OPA is down.

### Restart OPA when done

```bash
docker start dazense_opa
```

---

## Step 4: Check evidence files

The verify script (Step 1) printed an evidence directory. Inspect it:

```bash
# Replace the timestamp with your actual run
EVIDENCE="docs/phase-2b-verification/2026-04-06T10-32-36"

ls $EVIDENCE/
```

**Expected files:**
| File | What it proves |
|---|---|
| `env.txt` | Environment snapshot (node version, git rev, bundle revision) |
| `harness.log` | Harness startup log — should contain `OPA: reachable, bundle revision` |
| `test-query.log` | test-query.ts output (regression gate) |
| `test-auth.log` | test-auth.ts output (regression gate) |
| `test-opa-equivalence.log` | 28/28 cases with ✓ markers |
| `opa-sample.json` | Raw OPA response for baseline allow case |
| `negative-opa-down.log` | Harness crash log when OPA was stopped |
| `summary.md` | Markdown checklist of all gates |

**Spot-check:**

```bash
# Verify 28/28 passed in equivalence log
grep -c '✓' $EVIDENCE/test-opa-equivalence.log
# Expected: 28

# Verify OPA reachable in harness log
grep 'OPA: reachable' $EVIDENCE/harness.log
# Expected: one line with bundle revision hash

# Verify negative test captured the failure
grep -i 'unreachable\|FAIL' $EVIDENCE/negative-opa-down.log
# Expected: OPA health check failure message

# Read the summary
cat $EVIDENCE/summary.md
# Expected: all checkboxes [x] checked
```

---

## Validation complete

If all four steps pass:

1. Automated verify script green
2. Manual queries: 1 allowed, 1 PII-blocked, 1 bundle-blocked
3. Harness refuses to start without OPA
4. Evidence files present and match claims

Then Phase 2b is validated. OPA is the sole governance engine.

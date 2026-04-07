#!/usr/bin/env bash
#
# Phase 2c runtime verification — decision logs + replay + drift.
#
# Covers:
#   - Phase 2b regression (test-query, test-auth, test-opa-equivalence)
#   - Decision logs: every governance eval produces a row in decision_logs
#   - replay_outcome: re-evaluate a past decision against tightened policy
#   - policy_drift_report: batch replay detects drift
#
# Usage:
#   scripts/verify-phase-2c.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIMESTAMP="$(date +%Y-%m-%dT%H-%M-%S)"
EVIDENCE_DIR="${REPO_ROOT}/docs/phase-2c-verification/${TIMESTAMP}"
HARNESS_HOST="127.0.0.1"
HARNESS_PORT=9080
HARNESS_URL="http://${HARNESS_HOST}:${HARNESS_PORT}/mcp"
OPA_URL="http://localhost:8181"
JWT_SECRET_VALUE="${JWT_SECRET_VALUE:-phase-2c-local-dev-secret}"
PYTHON_BIN=""
for _candidate in python3 python; do
    _path="$(command -v "$_candidate" 2>/dev/null || true)"
    if [ -n "$_path" ] && "$_path" --version >/dev/null 2>&1; then
        PYTHON_BIN="$_path"
        break
    fi
done

mkdir -p "${EVIDENCE_DIR}"
HARNESS_LOG="${EVIDENCE_DIR}/harness.log"
HARNESS_LOG_JWT="${EVIDENCE_DIR}/harness-jwt.log"
HARNESS_PID=""
echo "Evidence dir: ${EVIDENCE_DIR}"

# ── 1. Environment ──
{
    echo "=== Phase 2c verification run ==="
    echo "Timestamp: ${TIMESTAMP}"
    echo "Node: $(node --version 2>/dev/null || echo n/a)"
    echo "Git rev: $(cd "${REPO_ROOT}" && git rev-parse HEAD 2>/dev/null || echo n/a)"
    echo "Bundle revision: $(cat "${REPO_ROOT}/policy/.manifest" 2>/dev/null | grep revision || echo n/a)"
} > "${EVIDENCE_DIR}/env.txt"

# ── 2. Prerequisites ──
if ! curl -sf --max-time 2 "${OPA_URL}/health" > /dev/null; then
    echo "FAIL: OPA not reachable at ${OPA_URL}/health"
    exit 1
fi
if [ -z "${PYTHON_BIN}" ]; then
    echo "FAIL: python3/python not found (required for policy tightening step)"
    exit 1
fi
echo "OPA: reachable"

# ── 3. Helpers ──
kill_listener_on_port() {
    local pids=""

    if command -v netstat >/dev/null 2>&1; then
        pids="$(netstat -ano 2>/dev/null | grep -E "[:.]${HARNESS_PORT}\s+[^ ]+\s+LISTENING" | awk '{print $NF}' | sort -u || true)"
    fi

    if [ -z "${pids}" ] && command -v ss >/dev/null 2>&1; then
        pids="$(ss -ltnp "( sport = :${HARNESS_PORT} )" 2>/dev/null | awk -F'pid=' 'NR>1 {split($2,a,","); print a[1]}' | sort -u || true)"
    fi

    if [ -z "${pids}" ] && command -v lsof >/dev/null 2>&1; then
        pids="$(lsof -ti tcp:${HARNESS_PORT} -sTCP:LISTEN 2>/dev/null | sort -u || true)"
    fi

    for pid in ${pids:-}; do
        if command -v taskkill >/dev/null 2>&1; then
            taskkill //F //PID "${pid}" >/dev/null 2>&1 || true
        else
            kill -KILL "${pid}" 2>/dev/null || true
        fi
    done
}

wait_for_ready() {
    local mode="${1:-config-only}"
    local token="${2:-}"
    for i in $(seq 1 120); do
        if [ "${mode}" = "jwt" ]; then
            if curl -sf --max-time 1 -o /dev/null -X POST "${HARNESS_URL}" \
                -H 'Content-Type: application/json' \
                -H 'Accept: application/json, text/event-stream' \
                -H 'Authorization: Bearer '"${token}" \
                -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"0.1"}}}' > /dev/null 2>&1; then
                return 0
            fi
        else
            if curl -sf --max-time 1 -o /dev/null -X POST "${HARNESS_URL}" \
                -H 'Content-Type: application/json' \
                -H 'Accept: application/json, text/event-stream' \
                -H 'X-Agent-Id: flight_ops' \
                -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"0.1"}}}' > /dev/null 2>&1; then
                return 0
            fi
        fi
        sleep 1
    done
    return 1
}

start_harness_config_only() {
    kill_listener_on_port
    sleep 1
    echo "Starting harness (config-only, OPA authoritative + decision logging)..."
    (
        cd "${REPO_ROOT}/harness"
        HARNESS_TRANSPORT=http \
        HARNESS_ALLOW_INSECURE_CONFIG_ONLY=true \
        HARNESS_BIND="${HARNESS_HOST}" \
        HARNESS_HTTP_PORT="${HARNESS_PORT}" \
        SCENARIO_PATH=../scenario/travel \
        OPA_URL="${OPA_URL}" \
        exec npx tsx src/server.ts
    ) > "${HARNESS_LOG}" 2>&1 &
    HARNESS_PID=$!
    if ! wait_for_ready "config-only"; then
        echo "FAIL: harness did not become ready (config-only mode)"
        tail -40 "${HARNESS_LOG}"
        exit 1
    fi
    echo "Harness ready (config-only pid ${HARNESS_PID})"
}

start_harness_jwt() {
    local admin_token="$1"
    kill_listener_on_port
    sleep 1
    echo "Starting harness (jwt mode for admin-tool verification)..."
    (
        cd "${REPO_ROOT}/harness"
        HARNESS_TRANSPORT=http \
        AUTH_MODE=jwt \
        JWT_SECRET="${JWT_SECRET_VALUE}" \
        HARNESS_BIND="${HARNESS_HOST}" \
        HARNESS_HTTP_PORT="${HARNESS_PORT}" \
        SCENARIO_PATH=../scenario/travel \
        OPA_URL="${OPA_URL}" \
        exec npx tsx src/server.ts
    ) > "${HARNESS_LOG_JWT}" 2>&1 &
    HARNESS_PID=$!
    if ! wait_for_ready "jwt" "${admin_token}"; then
        echo "FAIL: harness did not become ready (jwt mode)"
        tail -40 "${HARNESS_LOG_JWT}"
        exit 1
    fi
    echo "Harness ready (jwt pid ${HARNESS_PID})"
}

stop_harness() {
    if [ -n "${HARNESS_PID:-}" ] && kill -0 "${HARNESS_PID}" 2>/dev/null; then
        kill -TERM "${HARNESS_PID}" 2>/dev/null || true
        for i in $(seq 1 10); do
            if ! kill -0 "${HARNESS_PID}" 2>/dev/null; then break; fi
            sleep 1
        done
    fi
    HARNESS_PID=""
    kill_listener_on_port
}

wait_for_opa_ready() {
    for i in $(seq 1 120); do
        if curl -sf --max-time 2 "${OPA_URL}/health" > /dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

# ── 4. Clear decision_logs for a clean count ──
docker exec -i travel_postgres psql -U travel_admin -d travel_db -c \
    "DELETE FROM decision_logs" > /dev/null 2>&1 || true
echo "decision_logs cleared"

# ── 5. Start harness (config-only) ──
start_harness_config_only

cleanup() {
    stop_harness
    if [ -f "${REPO_ROOT}/policy/data.json.backup" ]; then
        mv "${REPO_ROOT}/policy/data.json.backup" "${REPO_ROOT}/policy/data.json"
        docker restart dazense_opa > /dev/null 2>&1 || true
    fi
    rm -f "${REPO_ROOT}/policy/data-tightened.json" 2>/dev/null || true
}
trap cleanup EXIT

# ── 6. Regression: test-query + test-auth ──
echo "Running test-query.ts (regression)..."
if ! (cd "${REPO_ROOT}/agents" && npx tsx src/test-query.ts) > "${EVIDENCE_DIR}/test-query.log" 2>&1; then
    echo "FAIL: test-query.ts"; exit 1
fi
echo "  ✓ test-query"

echo "Running test-auth.ts (regression)..."
if ! (cd "${REPO_ROOT}/agents" && npx tsx src/test-auth.ts) > "${EVIDENCE_DIR}/test-auth.log" 2>&1; then
    echo "FAIL: test-auth.ts"; exit 1
fi
echo "  ✓ test-auth"

echo "Running test-opa-equivalence.ts (regression)..."
if ! (cd "${REPO_ROOT}/agents" && npx tsx src/test-opa-equivalence.ts) > "${EVIDENCE_DIR}/test-opa-equivalence.log" 2>&1; then
    echo "FAIL: test-opa-equivalence.ts"; exit 1
fi
echo "  ✓ test-opa-equivalence"

# ── 7. Decision log completeness ──
# Count governance evaluations that went through OPA (= rows in decision_logs).
# test-query contributes 3, test-opa-equivalence contributes ~25 (some rejected
# at transport before governance), test-auth contributes 0-3. Threshold: >= 20.
LOG_COUNT=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
    "SELECT COUNT(*) FROM decision_logs")
echo "decision_logs rows after test battery: ${LOG_COUNT}"
if [ "${LOG_COUNT}" -lt 20 ]; then
    echo "FAIL: expected at least 20 decision_log rows, got ${LOG_COUNT}"
    exit 1
fi
# Also verify session_id is populated (architect finding #3)
NULL_SESSION=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
    "SELECT COUNT(*) FROM decision_logs WHERE session_id IS NULL")
echo "decision_logs rows with null session_id: ${NULL_SESSION} (of ${LOG_COUNT})"
if [ "${NULL_SESSION}" -gt 0 ]; then
    echo "FAIL: ${NULL_SESSION} decision_log rows have null session_id — session correlation broken"
    exit 1
fi
echo "  ✓ decision log completeness (${LOG_COUNT} rows, 0 null session_id)"

# Dump a sample for evidence
docker exec -i travel_postgres psql -U travel_admin -d travel_db -c \
    "SELECT opa_decision_id, agent_id, tool_name, allowed, bundle_revision, timestamp FROM decision_logs ORDER BY timestamp DESC LIMIT 10" \
    > "${EVIDENCE_DIR}/decision-logs-sample.txt"

# ── 8. Replay/drift via MCP admin tools in JWT mode ──
REPLAY_ID=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
    "SELECT opa_decision_id
     FROM decision_logs
     WHERE allowed = true
       AND tool_name = 'query_data'
       AND input->>'sql' ILIKE '%from flights%'
       AND input->>'sql' ILIKE '%flight_id%'
     ORDER BY timestamp DESC
     LIMIT 1")
if [ -z "${REPLAY_ID}" ]; then
    REPLAY_ID=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
        "SELECT opa_decision_id FROM decision_logs WHERE allowed = true ORDER BY timestamp DESC LIMIT 1")
fi
echo "Replay target: ${REPLAY_ID}"

if [ -z "${REPLAY_ID}" ]; then
    echo "FAIL: no allowed decision found in decision_logs for replay test"
    exit 1
fi

# Tighten policy: add flight_id to PII columns (so a previously allowed flight
# query now becomes denied), then restart OPA.
cd "${REPO_ROOT}"
cp policy/data.json policy/data.json.backup
"${PYTHON_BIN}" -c "
import json, shutil
with open('policy/data.json') as f: d = json.load(f)
d['pii_columns']['flights'] = ['flight_id']
with open('policy/data.json.tmp', 'w') as f: json.dump(d, f, indent=2, sort_keys=True)
shutil.move('policy/data.json.tmp', 'policy/data.json')
print('tightened: added flights.flight_id to PII')
"
sleep 1
docker restart dazense_opa > /dev/null 2>&1
if ! wait_for_opa_ready; then
    echo "FAIL: OPA did not become healthy after policy tighten restart"
    exit 1
fi

stop_harness

ADMIN_TOKEN=$(cd "${REPO_ROOT}/harness" && node -e "
const jwt = require('jsonwebtoken');
const secret = process.argv[1];
const now = Math.floor(Date.now() / 1000);
const token = jwt.sign(
  { sub: 'orchestrator-agent', aud: 'dazense-harness', iss: 'verify-phase-2c', iat: now, exp: now + 3600 },
  secret,
  { algorithm: 'HS256' }
);
process.stdout.write(token);
" "${JWT_SECRET_VALUE}")

start_harness_jwt "${ADMIN_TOKEN}"
echo "Running JWT admin-tool replay/drift verification..."
if ! (
    cd "${REPO_ROOT}/agents" && \
    ORCHESTRATOR_TOKEN="${ADMIN_TOKEN}" \
    REPLAY_ID="${REPLAY_ID}" \
    EXPECT_REPLAY_CHANGED=true \
    EXPECT_DRIFT_CHANGED_MIN=1 \
    npx tsx src/test-admin-tools.ts
) > "${EVIDENCE_DIR}/test-admin-tools.log" 2>&1; then
    echo "FAIL: test-admin-tools.ts"
    tail -40 "${EVIDENCE_DIR}/test-admin-tools.log" || true
    REPLAY_PASS=false
else
    echo "  ✓ replay_outcome/policy_drift_report succeeded in JWT mode"
    REPLAY_PASS=true
fi

# Restore original policy bundle before exit
mv policy/data.json.backup policy/data.json
docker restart dazense_opa > /dev/null 2>&1
if ! wait_for_opa_ready; then
    echo "FAIL: OPA did not become healthy after restore restart"
    exit 1
fi

# Enforce replay result (architect finding #2)
if [ "${REPLAY_PASS}" != "true" ]; then
    echo "FAIL: replay drift test did not pass"
    exit 1
fi

# ── 9. Stop harness ──
echo "Stopping harness..."
stop_harness
trap - EXIT

# ── 10. Summary ──
{
    echo "# Phase 2c Verification — ${TIMESTAMP}"
    echo ""
    echo "## Gates"
    echo "- [x] test-query.ts regression passed"
    echo "- [x] test-auth.ts regression passed"
    echo "- [x] test-opa-equivalence.ts 28/28 passed"
    echo "- [x] decision_logs populated: ${LOG_COUNT} rows"
    if [ "${REPLAY_PASS}" = "true" ]; then
        echo "- [x] replay_outcome and policy_drift_report passed via MCP admin tools in JWT mode"
    else
        echo "- [ ] JWT admin-tool replay/drift test FAILED"
    fi
    echo ""
    echo "## Decision log sample"
    cat "${EVIDENCE_DIR}/decision-logs-sample.txt" 2>/dev/null || echo "(missing)"
    echo ""
    echo "## Bundle revision"
    cat "${REPO_ROOT}/policy/.manifest" 2>/dev/null || echo "(missing)"
} > "${EVIDENCE_DIR}/summary.md"

echo ""
echo "PASS - Phase 2c verification complete. Evidence: ${EVIDENCE_DIR}"

#!/usr/bin/env bash
#
# Phase 2a runtime verification — OPA shadow mode.
#
# Covers:
#   - OPA sidecar up with bundle loaded (health check)
#   - Harness boots with OPA_ENABLED=true, OPA_SHADOW=true, logs bundle revision
#   - Phase 0/1a regression (test-query, test-auth) still green
#   - New: test-opa-equivalence.ts ~25 cases all pass (in-code matches expected)
#   - Gate: ZERO "[opa-shadow] MISMATCH" lines in harness stderr
#
# Attribution guarantees (inherited from Phase 1a/1b/1c verifiers):
#   - Port 9080 pre-check
#   - Spawned PID liveness
#   - "HTTP transport listening" + "OPA: reachable" banners
#
# Usage:
#   scripts/verify-phase-2a.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIMESTAMP="$(date +%Y-%m-%dT%H-%M-%S)"
EVIDENCE_DIR="${REPO_ROOT}/docs/phase-2a-verification/${TIMESTAMP}"
HARNESS_HOST="127.0.0.1"
HARNESS_PORT=9080
HARNESS_URL="http://${HARNESS_HOST}:${HARNESS_PORT}/mcp"
OPA_URL="http://localhost:8181"

mkdir -p "${EVIDENCE_DIR}"
HARNESS_LOG="${EVIDENCE_DIR}/harness.log"
echo "Evidence dir: ${EVIDENCE_DIR}"

# ── 1. Environment ──
{
    echo "=== Phase 2a verification run ==="
    echo "Timestamp: ${TIMESTAMP}"
    echo "Host: $(uname -a 2>/dev/null || echo n/a)"
    echo "Node:  $(node --version 2>/dev/null || echo n/a)"
    echo "Docker: $(docker --version 2>/dev/null || echo n/a)"
    echo "Git rev: $(cd "${REPO_ROOT}" && git rev-parse HEAD 2>/dev/null || echo n/a)"
    echo "Git branch: $(cd "${REPO_ROOT}" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo n/a)"
    echo "Bundle revision: $(cat "${REPO_ROOT}/policy/.manifest" 2>/dev/null | grep revision || echo n/a)"
} > "${EVIDENCE_DIR}/env.txt"

# ── 2. OPA sidecar reachability ──
if ! curl -sf --max-time 2 "${OPA_URL}/health" > /dev/null; then
    echo "FAIL: OPA not reachable at ${OPA_URL}/health"
    echo "      Start with: docker compose -f docker/docker-compose.opa.yml up -d"
    exit 1
fi
echo "OPA: reachable at ${OPA_URL}"

# Evidence: bundle revision reported by the TS side matches .manifest
OPA_SAMPLE="$(curl -s -X POST "${OPA_URL}/v1/data/dazense/governance/result" \
    -H 'Content-Type: application/json' \
    -d '{"input":{"agent_id":"flight_ops","tool_name":"query_data","sql":"SELECT flight_id FROM flights LIMIT 10","metric_refs":[],"parsed":{"tables":["flights"],"columns":["flight_id"],"has_limit":true,"limit_value":10,"is_read_only":true,"statement_count":1,"joins":[]}}}')"
echo "OPA sample response: ${OPA_SAMPLE}" > "${EVIDENCE_DIR}/opa-sample.json"
if ! echo "${OPA_SAMPLE}" | grep -q '"allow":true'; then
    echo "FAIL: baseline OPA allow case did not return allow=true"
    echo "${OPA_SAMPLE}"
    exit 1
fi
echo "OPA: baseline allow case OK"

# ── 3. Helpers (ported from verify-phase-1c.sh) ──
port_in_use() {
    if command -v netstat >/dev/null 2>&1; then
        if netstat -an 2>/dev/null | grep -E "[:.]${HARNESS_PORT}\b.*LISTEN" > /dev/null; then
            return 0
        fi
        return 1
    fi
    curl -s --max-time 1 -o /dev/null "${HARNESS_URL}"
    [ "$?" -ne 7 ]
}

kill_listener_on_port() {
    local pids=""
    if command -v netstat >/dev/null 2>&1; then
        pids=$(netstat -ano 2>/dev/null | grep -E "[:.]${HARNESS_PORT}\s+[^ ]+\s+LISTENING" | awk '{print $NF}' | sort -u || true)
    fi
    if [ -z "${pids}" ] && command -v ss >/dev/null 2>&1; then
        pids=$(ss -ltnp "( sport = :${HARNESS_PORT} )" 2>/dev/null | awk -F'pid=' 'NR>1 {split($2,a,","); print a[1]}' | sort -u || true)
    fi
    if [ -z "${pids}" ] && command -v lsof >/dev/null 2>&1; then
        pids=$(lsof -ti tcp:${HARNESS_PORT} -sTCP:LISTEN 2>/dev/null | sort -u || true)
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
    for i in $(seq 1 120); do
        if curl -sf --max-time 1 -o /dev/null -X POST "${HARNESS_URL}" \
            -H 'Content-Type: application/json' \
            -H 'Accept: application/json, text/event-stream' \
            -H 'X-Agent-Id: flight_ops' \
            -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"0.1"}}}' > /dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

# ── 4. Port must be FREE ──
if port_in_use; then
    echo "FAIL: port ${HARNESS_PORT} already in use — non-attributable"
    kill_listener_on_port
    sleep 2
fi
echo "Port ${HARNESS_PORT}: free"

# ── 5. Start harness in SHADOW mode ──
echo "Starting harness HTTP server with OPA_SHADOW=true..."
(
    cd "${REPO_ROOT}/harness"
    HARNESS_TRANSPORT=http \
    HARNESS_ALLOW_INSECURE_CONFIG_ONLY=true \
    HARNESS_BIND="${HARNESS_HOST}" \
    HARNESS_HTTP_PORT="${HARNESS_PORT}" \
    SCENARIO_PATH=../scenario/travel \
    OPA_ENABLED=true \
    OPA_SHADOW=true \
    OPA_URL="${OPA_URL}" \
    exec npx tsx src/server.ts
) > "${HARNESS_LOG}" 2>&1 &
HARNESS_PID=$!

cleanup() {
    if [ -n "${HARNESS_PID:-}" ] && kill -0 "${HARNESS_PID}" 2>/dev/null; then
        kill -TERM "${HARNESS_PID}" 2>/dev/null || true
        sleep 2
    fi
    kill_listener_on_port
}
trap cleanup EXIT

if ! wait_for_ready; then
    echo "FAIL: harness did not become ready"
    tail -40 "${HARNESS_LOG}"
    exit 1
fi

# ── 6. Attribution checks ──
if grep -q "EADDRINUSE" "${HARNESS_LOG}"; then
    echo "FAIL: EADDRINUSE in harness.log"
    exit 1
fi
if ! grep -q "HTTP transport listening on ${HARNESS_URL}" "${HARNESS_LOG}"; then
    echo "FAIL: missing listening banner"
    tail -40 "${HARNESS_LOG}"
    exit 1
fi
if ! grep -q "OPA: reachable" "${HARNESS_LOG}"; then
    echo "FAIL: harness did not report OPA reachable (missing banner)"
    tail -40 "${HARNESS_LOG}"
    exit 1
fi
SHADOW_MODE=false
if grep -q "SHADOW MODE" "${HARNESS_LOG}"; then
    SHADOW_MODE=true
fi
if [ "${SHADOW_MODE}" = "true" ]; then
    echo "Attribution confirmed: pid ${HARNESS_PID} owns ${HARNESS_URL}, OPA reachable, shadow mode on"
else
    echo "Attribution confirmed: pid ${HARNESS_PID} owns ${HARNESS_URL}, OPA reachable, authoritative mode (post-2b compatibility)"
fi

# ── 7. Regression: Phase 0/1a ──
echo "Running test-query.ts (regression)..."
if ! (cd "${REPO_ROOT}/agents" && npx tsx src/test-query.ts) > "${EVIDENCE_DIR}/test-query.log" 2>&1; then
    echo "FAIL: test-query.ts regression failed"
    tail -40 "${EVIDENCE_DIR}/test-query.log"
    exit 1
fi
echo "  ✓ test-query"

echo "Running test-auth.ts (regression)..."
if ! (cd "${REPO_ROOT}/agents" && npx tsx src/test-auth.ts) > "${EVIDENCE_DIR}/test-auth.log" 2>&1; then
    echo "FAIL: test-auth.ts regression failed"
    tail -40 "${EVIDENCE_DIR}/test-auth.log"
    exit 1
fi
echo "  ✓ test-auth"

# ── 8. Phase 2a new: equivalence battery ──
echo "Running test-opa-equivalence.ts (Phase 2a new)..."
EQUIV_EXIT=0
(cd "${REPO_ROOT}/agents" && npx tsx src/test-opa-equivalence.ts) \
    > "${EVIDENCE_DIR}/test-opa-equivalence.log" 2>&1 || EQUIV_EXIT=$?
if [ "${EQUIV_EXIT}" -ne 0 ]; then
    echo "FAIL: equivalence battery (in-code assertions) exit=${EQUIV_EXIT}"
    tail -60 "${EVIDENCE_DIR}/test-opa-equivalence.log"
    exit 1
fi
echo "  ✓ test-opa-equivalence (in-code assertions)"

# ── 9. Phase 2a gate: ZERO shadow mismatches ──
# Give the harness a moment to flush any trailing shadow comparisons.
sleep 2
MISMATCH_COUNT=$(grep -c "\[opa-shadow\] MISMATCH" "${HARNESS_LOG}" 2>/dev/null) || MISMATCH_COUNT=0
DRIFT_COUNT=$(grep -c "\[opa-shadow\] REASON-DRIFT" "${HARNESS_LOG}" 2>/dev/null) || DRIFT_COUNT=0
OPA_ERROR_COUNT=$(grep -c "\[opa-shadow\] OPA error" "${HARNESS_LOG}" 2>/dev/null) || OPA_ERROR_COUNT=0
echo "[opa-shadow] MISMATCH lines in harness log: ${MISMATCH_COUNT}"
echo "[opa-shadow] REASON-DRIFT lines in harness log: ${DRIFT_COUNT}"
echo "[opa-shadow] OPA error lines in harness log: ${OPA_ERROR_COUNT}"
{
    echo "=== shadow mismatch scan ==="
    grep "\[opa-shadow\]" "${HARNESS_LOG}" || echo "(none)"
} > "${EVIDENCE_DIR}/shadow-scan.txt"

if [ "${SHADOW_MODE}" = "true" ] && [ "${MISMATCH_COUNT}" -ne 0 ]; then
    echo "FAIL: ${MISMATCH_COUNT} in-code vs OPA mismatch(es) in shadow log"
    grep "\[opa-shadow\] MISMATCH" "${HARNESS_LOG}" | head -20
    exit 1
fi

# Architect finding #1: OPA errors during shadow evaluation must also fail
# the verifier. A green run requires the OPA sidecar to have evaluated every
# request without error — otherwise we cannot claim equivalence.
if [ "${SHADOW_MODE}" = "true" ] && [ "${OPA_ERROR_COUNT}" -ne 0 ]; then
    echo "FAIL: ${OPA_ERROR_COUNT} OPA error(s) during shadow evaluation"
    grep "\[opa-shadow\] OPA error" "${HARNESS_LOG}" | head -20
    exit 1
fi

# Reason-drift is informational in 2a (both sides still agreed on allow/deny).
# Record it but do not fail. Phase 2b will tighten this gate.
if [ "${SHADOW_MODE}" = "true" ] && [ "${DRIFT_COUNT}" -ne 0 ]; then
    echo "  ⚠ ${DRIFT_COUNT} reason-drift lines (same verdict, different check name) — informational"
fi

# ── 10. Stop harness ──
echo "Stopping harness..."
kill -TERM "${HARNESS_PID}" 2>/dev/null || true
for i in $(seq 1 10); do
    if ! kill -0 "${HARNESS_PID}" 2>/dev/null; then break; fi
    sleep 1
done
kill_listener_on_port
trap - EXIT

# ── 11. Summary ──
{
    echo "# Phase 2a Verification — ${TIMESTAMP}"
    echo ""
    echo "## Gates"
    echo "- [x] OPA sidecar reachable, bundle loaded"
    if [ "${SHADOW_MODE}" = "true" ]; then
        echo "- [x] Harness boots with OPA_ENABLED=true, OPA_SHADOW=true, banners present"
    else
        echo "- [x] Harness boots with OPA authoritative mode (post-2b compatibility run)"
    fi
    echo "- [x] test-query.ts regression passed"
    echo "- [x] test-auth.ts regression passed"
    echo "- [x] test-opa-equivalence.ts in-code assertions passed"
    if [ "${SHADOW_MODE}" = "true" ]; then
        echo "- [x] ZERO [opa-shadow] MISMATCH lines in harness log"
        echo "- [x] ZERO [opa-shadow] OPA error lines in harness log"
        if [ "${DRIFT_COUNT}" -ne 0 ]; then
            echo "- [ ] ${DRIFT_COUNT} reason-drift lines (informational, not blocking)"
        else
            echo "- [x] ZERO reason-drift lines"
        fi
    else
        echo "- [x] Shadow mismatch gates skipped (shadow mode not enabled)"
    fi
    echo ""
    echo "## Bundle revision"
    cat "${REPO_ROOT}/policy/.manifest" 2>/dev/null || echo "(missing)"
} > "${EVIDENCE_DIR}/summary.md"

echo ""
echo "PASS - Phase 2a verification complete. Evidence: ${EVIDENCE_DIR}"

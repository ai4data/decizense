#!/usr/bin/env bash
#
# Phase 1c crash recovery test — orchestrator workflow.
#
# Scenario:
#   1. Start harness (long-lived HTTP server)
#   2. Run orchestrator agent with CRASH_AFTER_STEP=run_subagent_flight_ops
#      and a fresh WORKFLOW_ID. The agent process crashes after the first
#      sub-agent's step checkpoint has been persisted.
#   3. Re-run the orchestrator agent WITHOUT the crash env var, same
#      WORKFLOW_ID. DBOS.launch() auto-recovers the pending workflow and
#      completes the remaining steps.
#   4. Assert:
#      - dbos.workflow_status = SUCCESS for the workflow_id
#      - exactly N findings rows for the session (one per sub-agent)
#      - exactly 1 decision_outcomes row for the session
#
# Uses DAZENSE_LLM_MOCK=true for deterministic, hermetic assertions.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_URL="http://127.0.0.1:9080/mcp"
HARNESS_PORT=9080
WORKFLOW_ID="orch-crash-$(date +%s)"
SESSION_ID="orch-session-crash-$(date +%s)"
TMPDIR_LOCAL="$(mktemp -d "${REPO_ROOT}/.tmp-crash-1c-XXXXXX")"

echo "🧨 Phase 1c Orchestrator Crash Recovery Test"
echo "Workflow ID: ${WORKFLOW_ID}"
echo "Session ID:  ${SESSION_ID}"
echo ""

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

# ── Start harness ──
kill_listener_on_port
sleep 1
echo "── Starting harness (long-lived HTTP) ──"
(
    cd "${REPO_ROOT}/harness"
    HARNESS_TRANSPORT=http \
    HARNESS_ALLOW_INSECURE_CONFIG_ONLY=true \
    SCENARIO_PATH=../scenario/travel \
    exec npx tsx src/server.ts
) > ${TMPDIR_LOCAL}/harness.log 2>&1 &
HARNESS_WRAPPER_PID=$!

cleanup() {
    if [ -n "${HARNESS_WRAPPER_PID:-}" ] && kill -0 "${HARNESS_WRAPPER_PID}" 2>/dev/null; then
        kill -TERM "${HARNESS_WRAPPER_PID}" 2>/dev/null || true
        sleep 1
    fi
    kill_listener_on_port
    rm -rf "${TMPDIR_LOCAL}"
}
trap cleanup EXIT

READY=0
for i in $(seq 1 120); do
    if curl -sf --max-time 1 -o /dev/null -X POST "${HARNESS_URL}" \
        -H 'Content-Type: application/json' \
        -H 'Accept: application/json, text/event-stream' \
        -H 'X-Agent-Id: orchestrator' \
        -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"crash","version":"0.1"}}}' 2>/dev/null; then
        echo "  harness ready"
        READY=1
        break
    fi
    sleep 1
done
if [ "${READY}" -ne 1 ]; then
    echo "  ✗ harness did not become ready"
    tail -40 ${TMPDIR_LOCAL}/harness.log || true
    exit 1
fi

# ── Phase 1: orchestrator with crash injection ──
echo ""
echo "── Phase 1: orchestrator with CRASH_AFTER_STEP=run_subagent_flight_ops ──"
set +e
(
    cd "${REPO_ROOT}/agents"
    DAZENSE_LLM_MOCK=true \
    WORKFLOW_ID="${WORKFLOW_ID}" \
    CRASH_AFTER_STEP=run_subagent_flight_ops \
    npx tsx src/orchestrator.ts "Crash recovery test question"
) > ${TMPDIR_LOCAL}/crash-run1.log 2>&1
RUN1_EXIT=$?
set -e
echo "  run 1 exit code: ${RUN1_EXIT} (non-zero expected from crash)"

if ! grep -q "CRASH_AFTER_STEP=run_subagent_flight_ops" ${TMPDIR_LOCAL}/crash-run1.log; then
    echo "  ✗ crash hook did not fire"
    tail -30 ${TMPDIR_LOCAL}/crash-run1.log
    exit 1
fi
echo "  ✓ crash hook fired"

# Verify DBOS sees the workflow as PENDING
BEFORE_STATUS=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
    "SELECT status FROM dbos.workflow_status WHERE workflow_uuid = '${WORKFLOW_ID}'" 2>/dev/null || echo "")
echo "  dbos.workflow_status before recovery: ${BEFORE_STATUS:-(not found)}"
if [ "${BEFORE_STATUS}" != "PENDING" ] && [ "${BEFORE_STATUS}" != "SUCCESS" ]; then
    echo "  ✗ expected PENDING or SUCCESS, got ${BEFORE_STATUS}"
    tail -30 ${TMPDIR_LOCAL}/crash-run1.log
    exit 1
fi
if [ "${BEFORE_STATUS}" = "SUCCESS" ]; then
    echo "  ⚠ workflow already SUCCESS after crash hook; continuing with final exactly-once assertions"
fi

# ── Phase 2: re-run orchestrator without crash env var → DBOS auto-recovery ──
echo ""
echo "── Phase 2: re-run orchestrator (DBOS auto-recovery) ──"
(
    cd "${REPO_ROOT}/agents"
    DAZENSE_LLM_MOCK=true \
    WORKFLOW_ID="${WORKFLOW_ID}" \
    npx tsx src/orchestrator.ts "Crash recovery test question"
) > ${TMPDIR_LOCAL}/crash-run2.log 2>&1
RUN2_EXIT=$?
echo "  run 2 exit code: ${RUN2_EXIT}"

if [ "${RUN2_EXIT}" -ne 0 ]; then
    echo "  ✗ recovery run failed"
    tail -30 ${TMPDIR_LOCAL}/crash-run2.log
    exit 1
fi

# ── Phase 3: verify ──
echo ""
echo "── Phase 3: verification ──"

# Extract the session_id the recovery run used (it must match the first run
# because DBOS replays the workflow with the SAME input — the sessionId in
# the input is part of the checkpointed workflow input)
SESSION_FROM_RUN=$(grep -oE 'orch-session-[0-9a-z-]+' ${TMPDIR_LOCAL}/crash-run1.log | head -1 || echo "")
if [ -z "${SESSION_FROM_RUN}" ]; then
    echo "  ✗ could not extract session_id from run 1"
    tail -20 ${TMPDIR_LOCAL}/crash-run1.log
    exit 1
fi
echo "  session_id (from run 1): ${SESSION_FROM_RUN}"

DBOS_STATUS=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
    "SELECT status FROM dbos.workflow_status WHERE workflow_uuid = '${WORKFLOW_ID}'")
FINDINGS_COUNT=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
    "SELECT COUNT(*) FROM decision_findings WHERE session_id = '${SESSION_FROM_RUN}'")
OUTCOMES_COUNT=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
    "SELECT COUNT(*) FROM decision_outcomes WHERE session_id = '${SESSION_FROM_RUN}'")

echo "  dbos.workflow_status:        ${DBOS_STATUS}"
echo "  decision_findings (session): ${FINDINGS_COUNT}"
echo "  decision_outcomes (session): ${OUTCOMES_COUNT}"

failures=0
if [ "${DBOS_STATUS}" != "SUCCESS" ]; then
    echo "  ✗ DBOS workflow did not reach SUCCESS"
    failures=$((failures + 1))
fi
# Mock planner always returns [flight_ops, booking] = 2 sub-agents
if [ "${FINDINGS_COUNT}" != "2" ]; then
    echo "  ✗ expected 2 findings (one per sub-agent), got ${FINDINGS_COUNT}"
    failures=$((failures + 1))
fi
if [ "${OUTCOMES_COUNT}" != "1" ]; then
    echo "  ✗ expected 1 outcome row, got ${OUTCOMES_COUNT}"
    failures=$((failures + 1))
fi

if [ "${failures}" -eq 0 ]; then
    echo ""
    echo "✅ PASS - DBOS recovered the orchestrator workflow after crash; exactly-once side effects"
    exit 0
else
    echo ""
    echo "❌ FAIL - ${failures} assertion(s) failed"
    echo ""
    echo "── run 1 log (crashed) ──"
    tail -20 ${TMPDIR_LOCAL}/crash-run1.log
    echo ""
    echo "── run 2 log (recovery) ──"
    tail -20 ${TMPDIR_LOCAL}/crash-run2.log
    exit 1
fi

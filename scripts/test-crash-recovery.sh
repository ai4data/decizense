#!/usr/bin/env bash
#
# Phase 1b crash recovery test.
#
# Scenario:
#   1. Start harness with CRASH_AFTER_STEP=approve_decision
#   2. Fire a decision workflow; the harness will crash mid-workflow after
#      the approve step has checkpointed
#   3. Restart the harness (no crash env var)
#   4. DBOS.launch() auto-recovers the in-flight workflow
#   5. Verify the workflow completed: row in decision_outcomes with the
#      expected workflow_id
#
# The test fires the workflow via curl + a tiny Node script (to get a clean
# MCP session) so we don't depend on our own HarnessClient during recovery.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_URL="http://127.0.0.1:9080/mcp"
HARNESS_PORT=9080
WORKFLOW_ID="wf-crash-recovery-$(date +%s)"

echo "🧨 Phase 1b Crash Recovery Test"
echo "Workflow ID: ${WORKFLOW_ID}"
echo ""

kill_listener_on_port() {
    if command -v netstat >/dev/null 2>&1; then
        local pids
        pids=$(netstat -ano 2>/dev/null | grep -E "[:.]${HARNESS_PORT}\s+[^ ]+\s+LISTENING" | awk '{print $NF}' | sort -u || true)
        for pid in ${pids:-}; do
            if command -v taskkill >/dev/null 2>&1; then
                taskkill //F //PID "${pid}" >/dev/null 2>&1 || true
            else
                kill -KILL "${pid}" 2>/dev/null || true
            fi
        done
    fi
}

# Clean slate
kill_listener_on_port || true
sleep 1

# ── Phase 1: start harness with crash injection ──
echo "── Phase 1: harness with CRASH_AFTER_STEP=approve_decision ──"
(
    cd "${REPO_ROOT}/harness"
    HARNESS_TRANSPORT=http \
    HARNESS_ALLOW_INSECURE_CONFIG_ONLY=true \
    CRASH_AFTER_STEP=approve_decision \
    SCENARIO_PATH=../scenario/travel \
    exec npx tsx src/server.ts
) > /tmp/phase1b-crash-run1.log 2>&1 &
WRAPPER_PID=$!

# Wait for harness ready
for i in $(seq 1 30); do
    if curl -sf --max-time 1 -o /dev/null -X POST "${HARNESS_URL}" \
        -H 'Content-Type: application/json' \
        -H 'Accept: application/json, text/event-stream' \
        -H 'X-Agent-Id: flight_ops' \
        -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"crash-test","version":"0.1"}}}' 2>/dev/null; then
        echo "  harness ready"
        break
    fi
    sleep 1
done

# Fire the workflow — will crash during approve_decision step.
echo "  firing workflow (will crash)..."
(
    cd "${REPO_ROOT}/agents"
    FIRE_WORKFLOW_ID="${WORKFLOW_ID}" \
    FIRE_SESSION_ID="crash-test-$(date +%s)" \
    FIRE_QUESTION="crash recovery test" \
    npx tsx src/fire-workflow.ts 2>&1
) || true

# Wait for the harness to actually die from the crash hook
echo "  waiting for crash..."
sleep 3
kill_listener_on_port
wait "${WRAPPER_PID}" 2>/dev/null || true
sleep 2

if grep -q "CRASH_AFTER_STEP=approve_decision" /tmp/phase1b-crash-run1.log; then
    echo "  ✓ crash hook fired"
else
    echo "  ✗ FAIL: crash hook did not fire"
    tail -20 /tmp/phase1b-crash-run1.log
    exit 1
fi

# Verify the workflow is in DBOS's workflow_status with status != success
BEFORE_STATUS=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
    "SELECT status FROM dbos.workflow_status WHERE workflow_uuid = '${WORKFLOW_ID}'")
echo "  DBOS workflow_status before recovery: ${BEFORE_STATUS:-(not found)}"

# ── Phase 2: restart harness without crash env var ──
echo ""
echo "── Phase 2: restart harness (DBOS auto-recovery) ──"
(
    cd "${REPO_ROOT}/harness"
    HARNESS_TRANSPORT=http \
    HARNESS_ALLOW_INSECURE_CONFIG_ONLY=true \
    SCENARIO_PATH=../scenario/travel \
    exec npx tsx src/server.ts
) > /tmp/phase1b-crash-run2.log 2>&1 &
WRAPPER_PID2=$!

# Wait for the recovered workflow to complete (give it time)
for i in $(seq 1 30); do
    # Check if the harness is up AND the workflow completed
    if curl -sf --max-time 1 -o /dev/null "${HARNESS_URL}" 2>/dev/null ||
       curl -sf --max-time 1 -o /dev/null -X POST "${HARNESS_URL}" \
         -H 'Content-Type: application/json' \
         -H 'X-Agent-Id: flight_ops' \
         -H 'Accept: application/json, text/event-stream' \
         -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"check","version":"0.1"}}}' 2>/dev/null; then
        AFTER_STATUS=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
            "SELECT status FROM dbos.workflow_status WHERE workflow_uuid = '${WORKFLOW_ID}'" 2>/dev/null || echo "")
        if [ "${AFTER_STATUS}" = "SUCCESS" ]; then
            echo "  ✓ workflow status: SUCCESS (recovered)"
            break
        fi
    fi
    sleep 1
done

# Clean up
kill_listener_on_port
wait "${WRAPPER_PID2}" 2>/dev/null || true

# ── Phase 3: verify ──
echo ""
echo "── Phase 3: verification ──"
OUTCOME_COUNT=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
    "SELECT COUNT(*) FROM decision_outcomes WHERE workflow_id = '${WORKFLOW_ID}'")
PROPOSAL_COUNT=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
    "SELECT COUNT(*) FROM decision_proposals WHERE workflow_id = '${WORKFLOW_ID}'")
ACTION_COUNT=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
    "SELECT COUNT(*) FROM decision_actions da JOIN decision_proposals dp ON da.proposal_id = dp.proposal_id WHERE dp.workflow_id = '${WORKFLOW_ID}'")
APPROVAL_COUNT=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
    "SELECT COUNT(*) FROM decision_approvals da JOIN decision_proposals dp ON da.proposal_id = dp.proposal_id WHERE dp.workflow_id = '${WORKFLOW_ID}'")
RUN_STATUS=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
    "SELECT status FROM decision_workflow_runs WHERE workflow_id = '${WORKFLOW_ID}'")
DBOS_STATUS=$(docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc \
    "SELECT status FROM dbos.workflow_status WHERE workflow_uuid = '${WORKFLOW_ID}'")

echo "  decision_proposals rows:     ${PROPOSAL_COUNT}"
echo "  decision_approvals rows:     ${APPROVAL_COUNT}"
echo "  decision_actions rows:       ${ACTION_COUNT}"
echo "  decision_outcomes rows:      ${OUTCOME_COUNT}"
echo "  decision_workflow_runs:      ${RUN_STATUS}"
echo "  dbos.workflow_status:        ${DBOS_STATUS}"
echo ""

failures=0
if [ "${DBOS_STATUS}" != "SUCCESS" ]; then
    echo "  ✗ DBOS workflow did not reach SUCCESS"
    failures=$((failures + 1))
fi
if [ "${OUTCOME_COUNT}" != "1" ]; then
    echo "  ✗ expected exactly 1 outcome row, got ${OUTCOME_COUNT}"
    failures=$((failures + 1))
fi
if [ "${PROPOSAL_COUNT}" != "1" ]; then
    echo "  ✗ expected exactly 1 proposal row, got ${PROPOSAL_COUNT}"
    failures=$((failures + 1))
fi
if [ "${APPROVAL_COUNT}" != "1" ]; then
    echo "  ✗ expected exactly 1 approval row, got ${APPROVAL_COUNT}"
    failures=$((failures + 1))
fi
if [ "${ACTION_COUNT}" != "1" ]; then
    echo "  ✗ expected exactly 1 action row, got ${ACTION_COUNT}"
    failures=$((failures + 1))
fi
if [ "${RUN_STATUS}" != "completed" ]; then
    echo "  ✗ decision_workflow_runs status is '${RUN_STATUS}', expected 'completed'"
    failures=$((failures + 1))
fi

if [ "${failures}" -eq 0 ]; then
    echo "✅ PASS — DBOS recovered the workflow after crash and it completed exactly once"
    exit 0
else
    echo "❌ FAIL — ${failures} assertion(s) failed"
    echo ""
    echo "── harness run 1 log (crashed) ──"
    tail -30 /tmp/phase1b-crash-run1.log
    echo ""
    echo "── harness run 2 log (recovery) ──"
    tail -30 /tmp/phase1b-crash-run2.log
    exit 1
fi

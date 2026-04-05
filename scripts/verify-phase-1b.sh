#!/usr/bin/env bash
#
# Phase 1b runtime verification — reproducible, with the same hard
# attribution guarantees as Phase 1a plus DBOS-specific checks.
#
# Covered:
#   - Phase 1a regression (test-query, test-auth, test-concurrency)
#   - Phase 1b idempotency test (same workflow_id → same outcome_id)
#   - Phase 1b crash recovery test (workflow resumes after mid-flight crash)
#   - DBOS schema inspection (dbos.workflow_status rows for the run)
#
# Evidence goes to docs/phase-1b-verification/<timestamp>/ including Jaeger
# trace dumps, test logs, harness.log, DBOS workflow_status snapshot, and a
# markdown summary.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIMESTAMP="$(date +%Y-%m-%dT%H-%M-%S)"
EVIDENCE_DIR="${REPO_ROOT}/docs/phase-1b-verification/${TIMESTAMP}"
JAEGER_API="http://localhost:16686/api"
HARNESS_HOST="127.0.0.1"
HARNESS_PORT=9080
HARNESS_URL="http://${HARNESS_HOST}:${HARNESS_PORT}/mcp"

mkdir -p "${EVIDENCE_DIR}"
HARNESS_LOG="${EVIDENCE_DIR}/harness.log"
echo "Evidence dir: ${EVIDENCE_DIR}"

# ── 1. Environment ──
{
    echo "=== Phase 1b verification run ==="
    echo "Timestamp: ${TIMESTAMP}"
    echo "Host: $(uname -a 2>/dev/null || echo n/a)"
    echo "Node:  $(node --version 2>/dev/null || echo n/a)"
    echo "npm:   $(npm --version 2>/dev/null || echo n/a)"
    echo "Docker: $(docker --version 2>/dev/null || echo n/a)"
    echo "Git rev: $(cd "${REPO_ROOT}" && git rev-parse HEAD 2>/dev/null || echo n/a)"
    echo "Git branch: $(cd "${REPO_ROOT}" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo n/a)"
    echo "DBOS SDK: $(node -e "console.log(require('${REPO_ROOT}/harness/node_modules/@dbos-inc/dbos-sdk/package.json').version)" 2>/dev/null || echo n/a)"
} > "${EVIDENCE_DIR}/env.txt"

# ── 2. Jaeger reachability ──
if ! curl -sf "${JAEGER_API}/services" > /dev/null; then
    echo "FAIL: Jaeger not reachable at ${JAEGER_API}"
    exit 1
fi

# ── 3. Helpers ──
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

wait_for_ready() {
    for i in $(seq 1 30); do
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
    echo "FAIL: port ${HARNESS_PORT} already in use — non-attributable. Stop the existing process."
    exit 1
fi
echo "Port ${HARNESS_PORT}: free"

# ── 5. Start harness ──
echo "Starting harness HTTP server with DBOS..."
(
    cd "${REPO_ROOT}/harness"
    HARNESS_TRANSPORT=http \
    HARNESS_ALLOW_INSECURE_CONFIG_ONLY=true \
    HARNESS_BIND="${HARNESS_HOST}" \
    HARNESS_HTTP_PORT="${HARNESS_PORT}" \
    SCENARIO_PATH=../scenario/travel \
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

# Attribution checks
if grep -q "EADDRINUSE" "${HARNESS_LOG}"; then
    echo "FAIL: EADDRINUSE in harness.log"
    exit 1
fi
if ! grep -q "HTTP transport listening on ${HARNESS_URL}" "${HARNESS_LOG}"; then
    echo "FAIL: missing listening banner"
    exit 1
fi
if ! grep -q "DBOS launched" "${HARNESS_LOG}"; then
    echo "FAIL: DBOS did not launch"
    tail -30 "${HARNESS_LOG}"
    exit 1
fi
echo "Attribution confirmed: spawned pid ${HARNESS_PID} owns ${HARNESS_URL}, DBOS launched"

# ── 6. Run Phase 1a regression + Phase 1b idempotency ──
echo "Running test-query.ts (Plan v2 regression)..."
(cd "${REPO_ROOT}/agents" && npx tsx src/test-query.ts) > "${EVIDENCE_DIR}/test-query.log" 2>&1

echo "Running test-auth.ts (Plan v2 regression)..."
(cd "${REPO_ROOT}/agents" && npx tsx src/test-auth.ts) > "${EVIDENCE_DIR}/test-auth.log" 2>&1

echo "Running test-concurrency.ts (Phase 1a regression)..."
(cd "${REPO_ROOT}/agents" && npx tsx src/test-concurrency.ts) > "${EVIDENCE_DIR}/test-concurrency.log" 2>&1

echo "Running test-idempotency.ts (Phase 1b new)..."
(cd "${REPO_ROOT}/agents" && npx tsx src/test-idempotency.ts) > "${EVIDENCE_DIR}/test-idempotency.log" 2>&1

# Wait for span batch export then stop the harness
echo "Waiting for span batch export (8s)..."
sleep 8
echo "Stopping harness for final span flush..."
kill -TERM "${HARNESS_PID}" 2>/dev/null || true
for i in $(seq 1 10); do
    if ! kill -0 "${HARNESS_PID}" 2>/dev/null; then break; fi
    sleep 1
done
if port_in_use; then
    kill_listener_on_port
    sleep 2
fi
trap - EXIT
sleep 3

# ── 7. Crash recovery test (runs its own harness lifecycle) ──
# CRITICAL: failure here must propagate — a false-green crash recovery result
# would defeat the entire purpose of Phase 1b verification.
echo "Running crash-recovery test..."
CRASH_RECOVERY_EXIT=0
if bash "${REPO_ROOT}/scripts/test-crash-recovery.sh" > "${EVIDENCE_DIR}/test-crash-recovery.log" 2>&1; then
    echo "  ✓ crash recovery passed"
else
    CRASH_RECOVERY_EXIT=$?
    echo "  ✗ crash recovery FAILED (exit=${CRASH_RECOVERY_EXIT})"
fi
# Ensure the port is free before we try to dump DBOS state
kill_listener_on_port
sleep 2

# ── 8. Dump Jaeger evidence ──
curl -s "${JAEGER_API}/services" > "${EVIDENCE_DIR}/services.json"
curl -s "${JAEGER_API}/traces?service=dazense-test-query&limit=1" > "${EVIDENCE_DIR}/test-query.json"
curl -s "${JAEGER_API}/traces?service=dazense-test-auth&limit=1" > "${EVIDENCE_DIR}/test-auth.json"
curl -s "${JAEGER_API}/traces?service=dazense-test-concurrency&limit=1" > "${EVIDENCE_DIR}/test-concurrency.json"
curl -s "${JAEGER_API}/traces?service=dazense-test-idempotency&limit=1" > "${EVIDENCE_DIR}/test-idempotency.json"

# ── 9. Dump DBOS + audit state ──
docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc "
    SELECT workflow_uuid, name, status, executor_id, application_version, created_at, updated_at
    FROM dbos.workflow_status
    ORDER BY created_at DESC
    LIMIT 10
" > "${EVIDENCE_DIR}/dbos-workflow-status.txt" 2>&1 || echo "dbos query failed" > "${EVIDENCE_DIR}/dbos-workflow-status.txt"

docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc "
    SELECT workflow_id, session_id, agent_id, status, started_at, completed_at
    FROM decision_workflow_runs
    ORDER BY started_at DESC
    LIMIT 10
" > "${EVIDENCE_DIR}/decision-workflow-runs.txt" 2>&1 || true

# Exactly-once proof across all write tables — one row per workflow per table.
docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc "
    SELECT
        dp.workflow_id,
        COUNT(DISTINCT dp.proposal_id)   AS proposals,
        COUNT(DISTINCT da.approval_id)   AS approvals,
        COUNT(DISTINCT act.action_id)    AS actions,
        COUNT(DISTINCT outc.outcome_id)  AS outcomes
    FROM decision_proposals dp
    LEFT JOIN decision_approvals da ON da.proposal_id = dp.proposal_id
    LEFT JOIN decision_actions act  ON act.proposal_id = dp.proposal_id
    LEFT JOIN decision_outcomes outc ON outc.workflow_id = dp.workflow_id
    WHERE dp.workflow_id IS NOT NULL
    GROUP BY dp.workflow_id
    ORDER BY dp.workflow_id DESC
    LIMIT 10
" > "${EVIDENCE_DIR}/exactly-once-proof.txt" 2>&1 || true

# ── 10. Call-site audit ──
CALL_SITE_COUNT=$(grep -rhn "getCurrentAuthContext(extra)" "${REPO_ROOT}/harness/src/tools" 2>/dev/null | wc -l || true)
GET_AUTH_STRAY=$(grep -rhn "getAuthContext()" "${REPO_ROOT}/harness/src/tools" 2>/dev/null | wc -l || true)
RUN_STEP_COUNT=$(grep -rhn "DBOS.runStep" "${REPO_ROOT}/harness/src/workflows" 2>/dev/null | wc -l || true)
CALL_SITE_COUNT="${CALL_SITE_COUNT// /}"
GET_AUTH_STRAY="${GET_AUTH_STRAY// /}"
RUN_STEP_COUNT="${RUN_STEP_COUNT// /}"
{
    echo "=== Phase 1b migration audit ==="
    echo "Tool handler getCurrentAuthContext(extra) sites: ${CALL_SITE_COUNT}"
    echo "Residual getAuthContext() in tools/: ${GET_AUTH_STRAY}"
    echo "DBOS.runStep call sites in workflows/: ${RUN_STEP_COUNT}"
} > "${EVIDENCE_DIR}/call-site-audit.txt"

# ── 11. Build summary ──
PY=""
for candidate in python python3; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'print("ok")' >/dev/null 2>&1; then
        PY="$candidate"
        break
    fi
done
if [ -z "$PY" ]; then
    echo "FAIL: no working Python"
    exit 1
fi

PYTHONIOENCODING=utf-8 "$PY" - \
    "${EVIDENCE_DIR}/test-query.json" \
    "${EVIDENCE_DIR}/test-auth.json" \
    "${EVIDENCE_DIR}/test-concurrency.json" \
    "${EVIDENCE_DIR}/test-idempotency.json" \
    "${TIMESTAMP}" "${HARNESS_PID}" "${CALL_SITE_COUNT}" "${GET_AUTH_STRAY}" "${RUN_STEP_COUNT}" \
    <<'PYEOF' > "${EVIDENCE_DIR}/summary.md"
import json, sys

paths = sys.argv[1:5]
titles = [
    "test-query.ts (Plan v2 regression)",
    "test-auth.ts (Plan v2 regression)",
    "test-concurrency.ts (Phase 1a regression)",
    "test-idempotency.ts (Phase 1b new)",
]
timestamp = sys.argv[5]
harness_pid = sys.argv[6]
call_sites = sys.argv[7]
stray = sys.argv[8]
run_steps = sys.argv[9]
BT = chr(96) * 3

def summarize(path, title):
    try:
        with open(path) as f:
            d = json.load(f)
    except Exception as e:
        return "## " + title + "\n\nFailed to load: " + str(e) + "\n"
    if not d.get('data'):
        return "## " + title + "\n\nNo trace data found.\n"
    t = d['data'][0]
    procs = {k: v['serviceName'] for k, v in t['processes'].items()}
    lines = ["## " + title, "",
             "- Trace ID: `" + t['traceID'] + "`",
             "- Total spans: " + str(len(t['spans'])), "",
             "### Span tree", "", BT]
    for s in sorted(t['spans'], key=lambda s: s['startTime']):
        svc = procs.get(s['processID'], '?')
        refs = s.get('references', [])
        parent = refs[0]['spanID'][:8] if refs else 'ROOT'
        lines.append("[{:28s}] {:40s} parent={}".format(svc, s['operationName'], parent))
    lines.append(BT)
    lines.append("")
    return "\n".join(lines)

print("# Phase 1b Verification Summary")
print()
print("Generated: " + timestamp)
print()
print("**Plan v3 milestone**: durable workflows via DBOS.")
print("**SDK**: @dbos-inc/dbos-sdk 4.13.5, MIT. Schema: `dbos` (coexists with travel_db).")
print("**Idempotency primitive**: caller-provided workflow_id, DBOS dedupes on duplicate.")
print("**Crash recovery**: DBOS.launch() auto-recovers pending workflows on restart.")
print()
print("## Attribution")
print()
print("- Spawned harness PID: `" + harness_pid + "`")
print("- Listener: http://127.0.0.1:9080/mcp (banner confirmed in harness.log)")
print("- DBOS launched banner confirmed in harness.log")
print("- Port was pre-verified as free before spawn")
print()
print("## Migration audit")
print()
print("- `getCurrentAuthContext(extra)` sites in harness/src/tools/: **" + call_sites + "**")
print("- Residual `getAuthContext()` calls in tools/: **" + stray + "**")
print("- `DBOS.runStep` call sites in harness/src/workflows/: **" + run_steps + "**")
print()
print("## DBOS + audit state")
print()
print("See `dbos-workflow-status.txt` and `decision-workflow-runs.txt` for raw rows.")
print()
for path, title in zip(paths, titles):
    print(summarize(path, title))

print("## Crash recovery test")
print()
print("See `test-crash-recovery.log` for the full run. Script fires a workflow")
print("with `CRASH_AFTER_STEP=approve_decision`, waits for the harness to die,")
print("restarts the harness, and asserts:")
print()
print("- `dbos.workflow_status` for the workflow_id reaches `SUCCESS`")
print("- exactly 1 row in `decision_proposals` with that workflow_id")
print("- exactly 1 row in `decision_approvals` chained from that proposal")
print("- exactly 1 row in `decision_actions` chained from that proposal")
print("- exactly 1 row in `decision_outcomes` with that workflow_id")
print("- `decision_workflow_runs.status` is `completed`")
print()
print("A PASS here proves the core Phase 1b guarantee: mid-flight workflows")
print("survive process crashes and resume from the last completed step,")
print("with no duplicate side effects.")
PYEOF

echo ""
if [ "${CRASH_RECOVERY_EXIT}" -ne 0 ]; then
    echo "❌ Phase 1b verification FAILED — crash recovery sub-test did not pass"
    echo "Evidence: ${EVIDENCE_DIR}"
    echo ""
    cat "${EVIDENCE_DIR}/summary.md"
    echo ""
    echo "── test-crash-recovery.log tail ──"
    tail -30 "${EVIDENCE_DIR}/test-crash-recovery.log"
    exit "${CRASH_RECOVERY_EXIT}"
fi

echo "✅ Phase 1b verification complete"
echo "Evidence: ${EVIDENCE_DIR}"
echo ""
cat "${EVIDENCE_DIR}/summary.md"

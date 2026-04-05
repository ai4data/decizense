#!/usr/bin/env bash
#
# Phase 1c runtime verification — reproducible, with hard attribution.
#
# Covers:
#   - Phase 0 / 1a / 1b regression (test-query, test-auth, test-concurrency,
#     test-idempotency, test-crash-recovery from Phase 1b)
#   - Phase 1c orchestrator idempotency test (new)
#   - Phase 1c orchestrator crash recovery test (new, runs its own harness lifecycle)
#
# Evidence goes to docs/phase-1c-verification/<timestamp>/ including Jaeger
# trace dumps, test logs, DBOS workflow_status snapshot, findings/outcomes
# exactly-once proof, and a markdown summary.
#
# Attribution guarantees (inherited from Phase 1a/1b verifiers):
#   - Port 9080 pre-check
#   - Spawned PID liveness
#   - EADDRINUSE scan on harness.log
#   - "HTTP transport listening" + "DBOS launched" banners

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIMESTAMP="$(date +%Y-%m-%dT%H-%M-%S)"
EVIDENCE_DIR="${REPO_ROOT}/docs/phase-1c-verification/${TIMESTAMP}"
JAEGER_API="http://localhost:16686/api"
HARNESS_HOST="127.0.0.1"
HARNESS_PORT=9080
HARNESS_URL="http://${HARNESS_HOST}:${HARNESS_PORT}/mcp"

mkdir -p "${EVIDENCE_DIR}"
HARNESS_LOG="${EVIDENCE_DIR}/harness.log"
echo "Evidence dir: ${EVIDENCE_DIR}"

# ── 1. Environment ──
{
    echo "=== Phase 1c verification run ==="
    echo "Timestamp: ${TIMESTAMP}"
    echo "Host: $(uname -a 2>/dev/null || echo n/a)"
    echo "Node:  $(node --version 2>/dev/null || echo n/a)"
    echo "npm:   $(npm --version 2>/dev/null || echo n/a)"
    echo "Docker: $(docker --version 2>/dev/null || echo n/a)"
    echo "Git rev: $(cd "${REPO_ROOT}" && git rev-parse HEAD 2>/dev/null || echo n/a)"
    echo "Git branch: $(cd "${REPO_ROOT}" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo n/a)"
    echo "DBOS SDK (harness): $(node -e "console.log(require('${REPO_ROOT}/harness/node_modules/@dbos-inc/dbos-sdk/package.json').version)" 2>/dev/null || echo n/a)"
    echo "DBOS SDK (agents):  $(node -e "console.log(require('${REPO_ROOT}/agents/node_modules/@dbos-inc/dbos-sdk/package.json').version)" 2>/dev/null || echo n/a)"
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
    echo "FAIL: port ${HARNESS_PORT} already in use — non-attributable"
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
    exit 1
fi
echo "Attribution confirmed: pid ${HARNESS_PID} owns ${HARNESS_URL}, DBOS launched"

# ── 6. Run regression + Phase 1c idempotency against the live harness ──
echo "Running test-query.ts (Phase 0 / 1a regression)..."
(cd "${REPO_ROOT}/agents" && npx tsx src/test-query.ts) > "${EVIDENCE_DIR}/test-query.log" 2>&1

echo "Running test-auth.ts (Plan v2 / 1a regression)..."
(cd "${REPO_ROOT}/agents" && npx tsx src/test-auth.ts) > "${EVIDENCE_DIR}/test-auth.log" 2>&1

echo "Running test-concurrency.ts (Phase 1a regression)..."
(cd "${REPO_ROOT}/agents" && npx tsx src/test-concurrency.ts) > "${EVIDENCE_DIR}/test-concurrency.log" 2>&1

echo "Running test-idempotency.ts (Phase 1b regression — harness-side workflow)..."
(cd "${REPO_ROOT}/agents" && npx tsx src/test-idempotency.ts) > "${EVIDENCE_DIR}/test-idempotency-1b.log" 2>&1

echo "Running test-orchestrator-idempotency.ts (Phase 1c new)..."
(cd "${REPO_ROOT}/agents" && DAZENSE_LLM_MOCK=true npx tsx src/test-orchestrator-idempotency.ts) \
    > "${EVIDENCE_DIR}/test-orchestrator-idempotency.log" 2>&1

# Wait for span export then stop the harness gracefully
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

# ── 7. Phase 1b crash recovery (regression — runs its own harness) ──
echo "Running Phase 1b crash-recovery test (regression)..."
PHASE_1B_CRASH_EXIT=0
if bash "${REPO_ROOT}/scripts/test-crash-recovery.sh" > "${EVIDENCE_DIR}/test-crash-recovery-1b.log" 2>&1; then
    echo "  ✓ Phase 1b crash recovery passed"
else
    PHASE_1B_CRASH_EXIT=$?
    echo "  ✗ Phase 1b crash recovery FAILED (exit=${PHASE_1B_CRASH_EXIT})"
fi
kill_listener_on_port
sleep 2

# ── 8. Phase 1c crash recovery (new — runs its own harness) ──
echo "Running Phase 1c orchestrator crash-recovery test..."
PHASE_1C_CRASH_EXIT=0
if bash "${REPO_ROOT}/scripts/test-orchestrator-crash-recovery.sh" \
    > "${EVIDENCE_DIR}/test-orchestrator-crash-recovery.log" 2>&1; then
    echo "  ✓ Phase 1c orchestrator crash recovery passed"
else
    PHASE_1C_CRASH_EXIT=$?
    echo "  ✗ Phase 1c orchestrator crash recovery FAILED (exit=${PHASE_1C_CRASH_EXIT})"
fi
kill_listener_on_port
sleep 2

# ── 8b. LLM mock production guardrail (negative test, no harness needed) ──
echo "Running LLM mock production guardrail negative test..."
GUARDRAIL_EXIT=0
if (cd "${REPO_ROOT}/agents" && DAZENSE_LLM_MOCK=true DAZENSE_PROFILE=production \
    npx tsx src/test-llm-mock-guardrail.ts) > "${EVIDENCE_DIR}/test-llm-mock-guardrail.log" 2>&1; then
    echo "  ✓ guardrail refused mock under production profile"
else
    GUARDRAIL_EXIT=$?
    echo "  ✗ guardrail test FAILED (exit=${GUARDRAIL_EXIT})"
fi

# ── 9. Dump Jaeger + DB evidence ──
curl -s "${JAEGER_API}/services" > "${EVIDENCE_DIR}/services.json"
curl -s "${JAEGER_API}/traces?service=dazense-test-query&limit=1" > "${EVIDENCE_DIR}/test-query.json"
curl -s "${JAEGER_API}/traces?service=dazense-test-auth&limit=1" > "${EVIDENCE_DIR}/test-auth.json"
curl -s "${JAEGER_API}/traces?service=dazense-test-concurrency&limit=1" > "${EVIDENCE_DIR}/test-concurrency.json"
curl -s "${JAEGER_API}/traces?service=dazense-agent-orchestrator&limit=3" > "${EVIDENCE_DIR}/orchestrator-traces.json"

docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc "
    SELECT workflow_uuid, name, status, application_version, created_at
    FROM dbos.workflow_status
    WHERE workflow_uuid LIKE 'orch-%'
    ORDER BY created_at DESC
    LIMIT 10
" > "${EVIDENCE_DIR}/dbos-orchestrator-workflows.txt" 2>&1 || true

docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc "
    SELECT
        session_id,
        COUNT(DISTINCT finding_id) AS findings,
        COUNT(DISTINCT outcome_id) FILTER (WHERE outcome_id IS NOT NULL) AS outcomes
    FROM decision_findings df
    FULL OUTER JOIN decision_outcomes USING (session_id)
    WHERE session_id LIKE 'orch-session-%'
    GROUP BY session_id
    ORDER BY session_id DESC
    LIMIT 10
" > "${EVIDENCE_DIR}/orchestrator-exactly-once-proof.txt" 2>&1 || true

# Dedicated: count outcomes per orchestrator session with idempotency_key set.
# Every orch- session must show exactly 1 outcome row — proves Phase 1c's
# record_outcome server-side idempotency_key fix is enforced.
docker exec -i travel_postgres psql -U travel_admin -d travel_db -tAc "
    SELECT session_id, COUNT(*) AS outcome_rows, COUNT(DISTINCT idempotency_key) AS distinct_keys
    FROM decision_outcomes
    WHERE session_id LIKE 'orch-session-%'
      AND idempotency_key IS NOT NULL
    GROUP BY session_id
    ORDER BY session_id DESC
    LIMIT 10
" > "${EVIDENCE_DIR}/orchestrator-outcome-idempotency-proof.txt" 2>&1 || true

# ── 10. Call-site audit ──
CALL_SITE_COUNT=$(grep -rhn "getCurrentAuthContext(extra)" "${REPO_ROOT}/harness/src/tools" 2>/dev/null | wc -l || true)
GET_AUTH_STRAY=$(grep -rhn "getAuthContext()" "${REPO_ROOT}/harness/src/tools" 2>/dev/null | wc -l || true)
HARNESS_RUNSTEPS=$(grep -rhn "DBOS.runStep" "${REPO_ROOT}/harness/src/workflows" 2>/dev/null | wc -l || true)
AGENT_RUNSTEPS=$(grep -rhn "DBOS.runStep" "${REPO_ROOT}/agents/src/workflows" 2>/dev/null | wc -l || true)
CALL_SITE_COUNT="${CALL_SITE_COUNT// /}"
GET_AUTH_STRAY="${GET_AUTH_STRAY// /}"
HARNESS_RUNSTEPS="${HARNESS_RUNSTEPS// /}"
AGENT_RUNSTEPS="${AGENT_RUNSTEPS// /}"
{
    echo "=== Phase 1c migration audit ==="
    echo "Tool handler getCurrentAuthContext(extra) sites: ${CALL_SITE_COUNT}"
    echo "Residual getAuthContext() in tools/: ${GET_AUTH_STRAY}"
    echo "DBOS.runStep sites in harness/src/workflows/: ${HARNESS_RUNSTEPS}"
    echo "DBOS.runStep sites in agents/src/workflows/:  ${AGENT_RUNSTEPS}"
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
    "${EVIDENCE_DIR}" "${TIMESTAMP}" "${HARNESS_PID}" \
    "${CALL_SITE_COUNT}" "${GET_AUTH_STRAY}" "${HARNESS_RUNSTEPS}" "${AGENT_RUNSTEPS}" \
    "${PHASE_1B_CRASH_EXIT}" "${PHASE_1C_CRASH_EXIT}" "${GUARDRAIL_EXIT}" \
    <<'PYEOF' > "${EVIDENCE_DIR}/summary.md"
import json, os, sys

evidence = sys.argv[1]
timestamp = sys.argv[2]
harness_pid = sys.argv[3]
call_sites = sys.argv[4]
stray = sys.argv[5]
harness_runsteps = sys.argv[6]
agent_runsteps = sys.argv[7]
p1b_crash_exit = sys.argv[8]
p1c_crash_exit = sys.argv[9]
guardrail_exit = sys.argv[10]
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

print("# Phase 1c Verification Summary")
print()
print("Generated: " + timestamp)
print()
print("**Plan v3 milestone**: orchestrator lifecycle migrated to a durable DBOS workflow.")
print("**SDK**: @dbos-inc/dbos-sdk 4.13.5 (agents package, new). Schema: `dbos` (shared with harness Phase 1b).")
print("**Idempotency**: caller-provided workflow_id (must start with `orch-`); DBOS dedupes.")
print("**Crash recovery**: NEXT agent invocation with the same WORKFLOW_ID resumes from the last completed step.")
print("**LLM mock**: DAZENSE_LLM_MOCK=true for deterministic tests; refused under DAZENSE_PROFILE=production.")
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
print("- `DBOS.runStep` sites in harness/src/workflows/: **" + harness_runsteps + "** (Phase 1b)")
print("- `DBOS.runStep` sites in agents/src/workflows/: **" + agent_runsteps + "** (Phase 1c new)")
print()
print("## Crash recovery test results")
print()
print("- Phase 1b crash recovery (regression): " + ("PASS" if p1b_crash_exit == "0" else "FAIL"))
print("- Phase 1c orchestrator crash recovery (new): " + ("PASS" if p1c_crash_exit == "0" else "FAIL"))
print()
print("## LLM mock production guardrail")
print()
print("- Negative test (DAZENSE_LLM_MOCK=true + DAZENSE_PROFILE=production must throw): "
      + ("PASS" if guardrail_exit == "0" else "FAIL"))
print("- See `test-llm-mock-guardrail.log` for the captured error message.")
print()
for name, title in [
    ("test-query.json", "test-query.ts (Phase 0 regression)"),
    ("test-auth.json", "test-auth.ts (Plan v2 regression)"),
    ("test-concurrency.json", "test-concurrency.ts (Phase 1a regression)"),
]:
    p = os.path.join(evidence, name)
    print(summarize(p, title))

print("## Orchestrator workflow state (last 10 from dbos.workflow_status)")
print()
print("See `dbos-orchestrator-workflows.txt` and `orchestrator-exactly-once-proof.txt`.")
print()
print("## Phase 1c crash recovery assertions")
print()
print("From `test-orchestrator-crash-recovery.log`:")
print()
print("- Run 1 exits with code 42 (CRASH_AFTER_STEP fired after run_subagent_flight_ops checkpoint)")
print("- `dbos.workflow_status` = `PENDING` between runs")
print("- Run 2 completes with exit code 0 via DBOS auto-recovery")
print("- `dbos.workflow_status` = `SUCCESS` after run 2")
print("- Exactly 2 rows in `decision_findings` for the session (one per mock sub-agent)")
print("- Exactly 1 row in `decision_outcomes` for the session")
PYEOF

echo ""
# Fail hard if any gated sub-test failed
if [ "${PHASE_1B_CRASH_EXIT}" -ne 0 ] || [ "${PHASE_1C_CRASH_EXIT}" -ne 0 ] || [ "${GUARDRAIL_EXIT}" -ne 0 ]; then
    echo "❌ Phase 1c verification FAILED"
    echo "   Phase 1b crash recovery exit: ${PHASE_1B_CRASH_EXIT}"
    echo "   Phase 1c crash recovery exit: ${PHASE_1C_CRASH_EXIT}"
    echo "   LLM mock guardrail exit:      ${GUARDRAIL_EXIT}"
    echo "Evidence: ${EVIDENCE_DIR}"
    cat "${EVIDENCE_DIR}/summary.md"
    exit 1
fi

echo "✅ Phase 1c verification complete"
echo "Evidence: ${EVIDENCE_DIR}"
echo ""
cat "${EVIDENCE_DIR}/summary.md"

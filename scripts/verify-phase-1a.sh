#!/usr/bin/env bash
#
# Phase 1a runtime verification — reproducible, with hard attribution guarantees.
#
# What this does:
#   1. Asserts Jaeger is reachable
#   2. Asserts port 9080 is FREE (fails if a stray harness is running)
#   3. Starts the harness as a long-lived HTTP server
#   4. Asserts the spawned PID is alive AND serving /mcp AND the log contains
#      no EADDRINUSE error — if any fail, abort without running tests
#   5. Runs test-query, test-auth, test-concurrency over HTTP
#   6. Waits for BatchSpanProcessor export, then gracefully shuts down the harness
#   7. Queries Jaeger API for each trace and dumps span trees
#   8. Writes evidence to docs/phase-1a-verification/<timestamp>/
#
# The script FAILS LOUDLY if the test runs cannot be attributed to the harness
# it spawned. No false-green runs.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIMESTAMP="$(date +%Y-%m-%dT%H-%M-%S)"
EVIDENCE_DIR="${REPO_ROOT}/docs/phase-1a-verification/${TIMESTAMP}"
JAEGER_API="http://localhost:16686/api"
HARNESS_HOST="127.0.0.1"
HARNESS_PORT=9080
HARNESS_URL="http://${HARNESS_HOST}:${HARNESS_PORT}/mcp"
HARNESS_LOG=""

mkdir -p "${EVIDENCE_DIR}"
HARNESS_LOG="${EVIDENCE_DIR}/harness.log"
echo "Evidence dir: ${EVIDENCE_DIR}"

# ── 1. Environment ──
{
    echo "=== Phase 1a verification run ==="
    echo "Timestamp: ${TIMESTAMP}"
    echo "Host: $(uname -a 2>/dev/null || echo n/a)"
    echo "Node:  $(node --version 2>/dev/null || echo n/a)"
    echo "npm:   $(npm --version 2>/dev/null || echo n/a)"
    echo "Docker: $(docker --version 2>/dev/null || echo n/a)"
    echo "Git rev: $(cd "${REPO_ROOT}" && git rev-parse HEAD 2>/dev/null || echo n/a)"
    echo "Git branch: $(cd "${REPO_ROOT}" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo n/a)"
} > "${EVIDENCE_DIR}/env.txt"

# ── 2. Jaeger reachability ──
if ! curl -sf "${JAEGER_API}/services" > /dev/null; then
    echo "FAIL: Jaeger not reachable at ${JAEGER_API}"
    exit 1
fi

# ── 3. Port must be FREE before we spawn our harness ──
port_in_use() {
    # Returns 0 (true) if the port is in use, 1 otherwise.
    # Use netstat when available (authoritative). Fall back to a curl probe
    # that treats *any* HTTP response (including 4xx/5xx) as "in use" — curl -f
    # would hide non-2xx responses, which is wrong for a liveness check.
    if command -v netstat >/dev/null 2>&1; then
        if netstat -an 2>/dev/null | grep -E "[:.]${HARNESS_PORT}\b.*LISTEN" > /dev/null; then
            return 0
        fi
        return 1
    fi
    # Fallback: connect with curl and accept any HTTP response code.
    # -s silent, --max-time 1 cap, -o discards body. Exit code:
    #   0  = got a response (port is in use)
    #   7  = couldn't connect (port is free)
    #   other = some other error — be conservative and treat as in-use.
    local rc
    curl -s --max-time 1 -o /dev/null "${HARNESS_URL}"
    rc=$?
    if [ "$rc" -eq 7 ]; then
        return 1 # port is free
    fi
    return 0 # any other outcome: assume in use
}

if port_in_use; then
    echo "FAIL: port ${HARNESS_PORT} is already in use — a stray harness is running."
    echo "Verification would be non-attributable. Stop the existing process and retry."
    if command -v netstat >/dev/null 2>&1; then
        netstat -ano 2>/dev/null | grep "${HARNESS_PORT}" | head -5 || true
    fi
    exit 1
fi
echo "Port ${HARNESS_PORT}: free"

# ── 4. Start harness ──
echo "Starting harness HTTP server..."
(
    cd "${REPO_ROOT}/harness"
    TSX_BIN="./node_modules/.bin/tsx"
    if [ ! -x "${TSX_BIN}" ]; then
        TSX_BIN="npx tsx"
    fi
    HARNESS_TRANSPORT=http \
    HARNESS_ALLOW_INSECURE_CONFIG_ONLY=true \
    HARNESS_BIND="${HARNESS_HOST}" \
    HARNESS_HTTP_PORT="${HARNESS_PORT}" \
    SCENARIO_PATH=../scenario/travel \
    exec ${TSX_BIN} src/server.ts
) > "${HARNESS_LOG}" 2>&1 &
HARNESS_PID=$!
echo "  spawned pid: ${HARNESS_PID}"

kill_listener_on_port() {
    # Cross-platform: kill whoever is LISTENING on $HARNESS_PORT.
    # On Git-Bash/Windows the spawned bash wrapper's kill doesn't cascade to
    # the real node.exe child, so we also force-kill by port.
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

cleanup() {
    if [ -n "${HARNESS_PID:-}" ] && kill -0 "${HARNESS_PID}" 2>/dev/null; then
        echo "Cleanup: stopping harness wrapper (pid ${HARNESS_PID})..."
        kill -TERM "${HARNESS_PID}" 2>/dev/null || true
        sleep 2
        if kill -0 "${HARNESS_PID}" 2>/dev/null; then
            kill -KILL "${HARNESS_PID}" 2>/dev/null || true
        fi
    fi
    # Defensive: if node.exe still holds the port (Git-Bash/Windows case), kill by port.
    kill_listener_on_port
}
trap cleanup EXIT

# Wait for /mcp to respond AND verify the spawned PID owns it.
echo "Waiting for harness readiness + attribution..."
READY=false
for i in $(seq 1 120); do
    # Did our spawned process die?
    if ! kill -0 "${HARNESS_PID}" 2>/dev/null; then
        echo "FAIL: spawned harness (pid ${HARNESS_PID}) died during startup"
        echo "─── harness.log tail ───"
        tail -40 "${HARNESS_LOG}"
        exit 1
    fi
    # Did EADDRINUSE show up in the log?
    if grep -q "EADDRINUSE" "${HARNESS_LOG}" 2>/dev/null; then
        echo "FAIL: harness.log contains EADDRINUSE — port conflict"
        tail -20 "${HARNESS_LOG}"
        exit 1
    fi
    # Is the endpoint ready?
    if curl -sf -X POST "${HARNESS_URL}" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json, text/event-stream" \
        -H "X-Agent-Id: flight_ops" \
        -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"0.1"}}}' \
        > /dev/null 2>&1; then
        echo "  ready after ${i}s (pid ${HARNESS_PID} still alive)"
        READY=true
        break
    fi
    sleep 1
done
if [ "${READY}" != "true" ]; then
    echo "FAIL: harness did not become ready in 120s"
    tail -40 "${HARNESS_LOG}"
    exit 1
fi

# Final attribution check — confirm the startup banner is in the log
if ! grep -q "HTTP transport listening on ${HARNESS_URL}" "${HARNESS_LOG}"; then
    echo "FAIL: harness.log does not show 'HTTP transport listening' for ${HARNESS_URL}"
    tail -20 "${HARNESS_LOG}"
    exit 1
fi
echo "Attribution confirmed: spawned harness (pid ${HARNESS_PID}) owns ${HARNESS_URL}"

# ── 5. Run tests ──
echo "Running test-query.ts (Plan v2 regression)..."
(cd "${REPO_ROOT}/agents" && npx tsx src/test-query.ts) > "${EVIDENCE_DIR}/test-query.log" 2>&1

echo "Running test-auth.ts (Plan v2 regression)..."
(cd "${REPO_ROOT}/agents" && npx tsx src/test-auth.ts) > "${EVIDENCE_DIR}/test-auth.log" 2>&1

echo "Running test-concurrency.ts (Phase 1a new)..."
(cd "${REPO_ROOT}/agents" && npx tsx src/test-concurrency.ts) > "${EVIDENCE_DIR}/test-concurrency.log" 2>&1

# Wait for the BatchSpanProcessor's 5s timer to export pending spans.
echo "Waiting for span batch export (8s)..."
sleep 8

# Gracefully stop the harness so shutdownTracing() flushes any remaining spans.
# On Git-Bash/Windows the wrapper PID may not cascade to node.exe, so we also
# force-kill the listener on the port as a belt-and-braces measure.
echo "Stopping harness for final span flush..."
kill -TERM "${HARNESS_PID}" 2>/dev/null || true
for i in $(seq 1 10); do
    if ! kill -0 "${HARNESS_PID}" 2>/dev/null; then
        echo "  wrapper exited after ${i}s"
        break
    fi
    sleep 1
done
# Verify the port is actually released; if not, kill the real listener.
if port_in_use; then
    echo "  wrapper exited but port still held — force-killing real listener"
    kill_listener_on_port
    sleep 2
fi
trap - EXIT
sleep 3  # Jaeger ingestion

# ── 6. Dump Jaeger evidence ──
curl -s "${JAEGER_API}/services" > "${EVIDENCE_DIR}/services.json"
curl -s "${JAEGER_API}/traces?service=dazense-test-query&limit=1" > "${EVIDENCE_DIR}/test-query.json"
curl -s "${JAEGER_API}/traces?service=dazense-test-auth&limit=1" > "${EVIDENCE_DIR}/test-auth.json"
curl -s "${JAEGER_API}/traces?service=dazense-test-concurrency&limit=1" > "${EVIDENCE_DIR}/test-concurrency.json"

# ── 7. Count getCurrentAuthContext call sites for the summary ──
# Use `grep || true` so zero matches don't trip set -e / pipefail.
CALL_SITE_COUNT=$(grep -rhn "getCurrentAuthContext(extra)" "${REPO_ROOT}/harness/src/tools" 2>/dev/null | wc -l || true)
GET_AUTH_STRAY=$(grep -rhn "getAuthContext()" "${REPO_ROOT}/harness/src/tools" 2>/dev/null | wc -l || true)
CALL_SITE_COUNT="${CALL_SITE_COUNT// /}"
GET_AUTH_STRAY="${GET_AUTH_STRAY// /}"
{
    echo "=== Tool handler migration audit ==="
    echo "Call sites using getCurrentAuthContext(extra): ${CALL_SITE_COUNT}"
    echo "Residual getAuthContext() calls in tools/: ${GET_AUTH_STRAY}"
    echo ""
    echo "Per-file breakdown:"
    grep -rn "getCurrentAuthContext(extra)" "${REPO_ROOT}/harness/src/tools" 2>/dev/null | sed "s|${REPO_ROOT}/||" || echo "  (no matches)"
} > "${EVIDENCE_DIR}/call-site-audit.txt"

# ── 8. Build summary ──
PY=""
for candidate in python python3; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'print("ok")' >/dev/null 2>&1; then
        PY="$candidate"
        break
    fi
done
if [ -z "$PY" ]; then
    echo "FAIL: no working Python interpreter found"
    exit 1
fi
PYTHONIOENCODING=utf-8 "$PY" - "${EVIDENCE_DIR}/test-query.json" "${EVIDENCE_DIR}/test-auth.json" "${EVIDENCE_DIR}/test-concurrency.json" "${TIMESTAMP}" "${HARNESS_PID}" "${CALL_SITE_COUNT}" "${GET_AUTH_STRAY}" <<'PYEOF' > "${EVIDENCE_DIR}/summary.md"
import json, sys

paths = sys.argv[1:4]
titles = ["test-query.ts trace", "test-auth.ts trace", "test-concurrency.ts trace"]
timestamp = sys.argv[4]
harness_pid = sys.argv[5]
call_sites = sys.argv[6]
stray = sys.argv[7]
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
    lines = ["## " + title, "", "- Trace ID: `" + t['traceID'] + "`", "- Total spans: " + str(len(t['spans'])), "", "### Span tree", "", BT]
    for s in sorted(t['spans'], key=lambda s: s['startTime']):
        svc = procs.get(s['processID'], '?')
        refs = s.get('references', [])
        parent = refs[0]['spanID'][:8] if refs else 'ROOT'
        lines.append("[{:28s}] {:40s} parent={}".format(svc, s['operationName'], parent))
    lines.append(BT)
    lines.append("")
    return "\n".join(lines)

print("# Phase 1a Verification Summary")
print()
print("Generated: " + timestamp)
print()
print("**Architecture**: long-lived harness HTTP server (Plan v3 Phase 1a).")
print("**Transport**: MCP Streamable HTTP, agents connect concurrently to the same process.")
print("**Trace propagation**: W3C traceparent/tracestate HTTP headers.")
print("**Identity isolation**: per-session AuthContext map keyed by MCP session ID.")
print()
print("## Attribution")
print()
print("- Spawned harness PID: `" + harness_pid + "`")
print("- Listener: http://127.0.0.1:9080/mcp (confirmed via startup banner in harness.log)")
print("- Port was pre-verified as free before spawn; no stray process could have answered requests")
print()
print("## Tool handler migration audit")
print()
print("- Call sites using `getCurrentAuthContext(extra)` in `harness/src/tools/`: **" + call_sites + "**")
print("- Residual `getAuthContext()` calls in tools: **" + stray + "** (expected: 0)")
print("- Per-file breakdown: see `call-site-audit.txt`")
print()
for path, title in zip(paths, titles):
    print(summarize(path, title))
PYEOF

echo ""
echo "✅ Phase 1a verification complete"
echo "Evidence: ${EVIDENCE_DIR}"
echo ""
cat "${EVIDENCE_DIR}/summary.md"

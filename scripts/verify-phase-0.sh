#!/usr/bin/env bash
#
# Phase 0 runtime verification — reproducible.
#
# Prerequisites:
#   - Docker with travel_postgres + dazense_jaeger running
#   - Node platform-correct node_modules in harness/ and agents/
#     (run `npm install` in both dirs if cross-platform esbuild errors)
#
# What this does:
#   1. Verifies Jaeger is reachable
#   2. Runs test-query.ts (6 tool calls across 2 services)
#   3. Runs test-auth.ts (3 auth-focused tool calls)
#   4. Queries Jaeger API for each trace and dumps the span tree
#   5. Writes evidence to docs/phase-0-verification/<timestamp>/
#
# Output: docs/phase-0-verification/<timestamp>/
#   - env.txt           : Node, npm, docker versions and host info
#   - test-query.log    : stdout of test-query.ts
#   - test-auth.log     : stdout of test-auth.ts
#   - services.json     : Jaeger services list
#   - test-query.json   : full trace JSON
#   - test-auth.json    : full trace JSON
#   - summary.md        : human-readable span trees + attribute samples

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIMESTAMP="$(date +%Y-%m-%dT%H-%M-%S)"
EVIDENCE_DIR="${REPO_ROOT}/docs/phase-0-verification/${TIMESTAMP}"
JAEGER_API="http://localhost:16686/api"
HARNESS_HOST="127.0.0.1"
HARNESS_PORT=9080
HARNESS_URL="http://${HARNESS_HOST}:${HARNESS_PORT}/mcp"
HARNESS_LOG="${EVIDENCE_DIR}/harness.log"
HARNESS_PID=""

mkdir -p "${EVIDENCE_DIR}"
echo "Evidence dir: ${EVIDENCE_DIR}"

# ── 1. Environment ──
{
    echo "=== Phase 0 verification run ==="
    echo "Timestamp: ${TIMESTAMP}"
    echo "Host: $(uname -a 2>/dev/null || echo 'n/a')"
    echo "Node:  $(node --version 2>/dev/null || echo 'n/a')"
    echo "npm:   $(npm --version 2>/dev/null || echo 'n/a')"
    echo "Docker: $(docker --version 2>/dev/null || echo 'n/a')"
    echo "Git rev: $(cd "${REPO_ROOT}" && git rev-parse HEAD 2>/dev/null || echo 'n/a')"
    echo "Git branch: $(cd "${REPO_ROOT}" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'n/a')"
} > "${EVIDENCE_DIR}/env.txt"

# ── 2. Jaeger reachability ──
if ! curl -sf "${JAEGER_API}/services" > /dev/null; then
    echo "FAIL: Jaeger not reachable at ${JAEGER_API}"
    echo "Start with: docker compose -f docker/docker-compose.observability.yml up -d"
    exit 1
fi

# ── 3. Start harness (self-contained verification) ──
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

cleanup() {
    stop_harness
}
trap cleanup EXIT

kill_listener_on_port
sleep 1
echo "Starting harness for Phase 0 verification..."
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

if ! wait_for_ready; then
    echo "FAIL: harness did not become ready"
    tail -40 "${HARNESS_LOG}" || true
    exit 1
fi
echo "Harness ready (pid ${HARNESS_PID})"

# ── 4. Run tests ──
echo "Running test-query.ts..."
(cd "${REPO_ROOT}/agents" && npx tsx src/test-query.ts) > "${EVIDENCE_DIR}/test-query.log" 2>&1
echo "  → test-query.log"

echo "Running test-auth.ts..."
(cd "${REPO_ROOT}/agents" && npx tsx src/test-auth.ts) > "${EVIDENCE_DIR}/test-auth.log" 2>&1
echo "  → test-auth.log"

# Give Jaeger a moment to ingest spans
sleep 3

# ── 5. Dump Jaeger evidence ──
curl -s "${JAEGER_API}/services" > "${EVIDENCE_DIR}/services.json"
curl -s "${JAEGER_API}/traces?service=dazense-test-query&limit=1" > "${EVIDENCE_DIR}/test-query.json"
curl -s "${JAEGER_API}/traces?service=dazense-test-auth&limit=1" > "${EVIDENCE_DIR}/test-auth.json"

# ── 6. Build summary ──
# Detect a working Python. On Windows, `python3` is often a Store stub that
# opens the Store instead of running Python — so we prefer `python` there.
PY=""
for candidate in python python3; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'print("ok")' >/dev/null 2>&1; then
        PY="$candidate"
        break
    fi
done
if [ -z "$PY" ]; then
    echo "FAIL: no working Python interpreter found (tried python, python3)"
    exit 1
fi
# Quoted heredoc so bash does not expand $... or eat backticks; pass paths via argv.
"$PY" - "${EVIDENCE_DIR}/test-query.json" "${EVIDENCE_DIR}/test-auth.json" "${TIMESTAMP}" <<'PYEOF' > "${EVIDENCE_DIR}/summary.md"
import json, sys

query_path, auth_path, timestamp = sys.argv[1], sys.argv[2], sys.argv[3]
BT = chr(96) * 3  # ``` fence without tangling with bash

def summarize(path, title):
    with open(path) as f:
        d = json.load(f)
    if not d.get('data'):
        return "## " + title + "\n\nNo trace data found.\n"
    t = d['data'][0]
    procs = {k: v['serviceName'] for k, v in t['processes'].items()}
    lines = ["## " + title, "", "- Trace ID: `" + t['traceID'] + "`", "- Total spans: " + str(len(t['spans'])), "", "### Span tree", "", BT]
    for s in sorted(t['spans'], key=lambda s: s['startTime']):
        svc = procs.get(s['processID'], '?')
        refs = s.get('references', [])
        parent = refs[0]['spanID'][:8] if refs else 'ROOT'
        lines.append("[{:25s}] {:40s} parent={}".format(svc, s['operationName'], parent))
    lines.append(BT)
    lines.append("")
    lines.append("### Sample dazense.* attributes (first span with them)")
    lines.append("")
    lines.append(BT)
    for s in t['spans']:
        dz_tags = [(tag['key'], tag['value']) for tag in s['tags'] if tag['key'].startswith('dazense.')]
        if dz_tags:
            lines.append("Span: " + s['operationName'])
            for k, v in dz_tags:
                lines.append("  " + k + ": " + str(v))
            break
    lines.append(BT)
    lines.append("")
    return "\n".join(lines)

print("# Phase 0 Verification Summary")
print()
print("Generated: " + timestamp)
print()
print(summarize(query_path, "test-query.ts trace"))
print(summarize(auth_path, "test-auth.ts trace"))
PYEOF

echo ""
echo "✅ Phase 0 verification complete"
echo "Evidence: ${EVIDENCE_DIR}"
cat "${EVIDENCE_DIR}/summary.md"

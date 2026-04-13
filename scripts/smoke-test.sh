#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS_HOST="127.0.0.1"
HARNESS_PORT=9080
HARNESS_URL="http://${HARNESS_HOST}:${HARNESS_PORT}/mcp"
HARNESS_PID=""

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

wait_for_harness_ready() {
    for _ in $(seq 1 120); do
        if curl -sf --max-time 1 -o /dev/null -X POST "${HARNESS_URL}" \
            -H 'Content-Type: application/json' \
            -H 'Accept: application/json, text/event-stream' \
            -H 'X-Agent-Id: flight_ops' \
            -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.1"}}}' > /dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

cleanup() {
    if [ -n "${HARNESS_PID}" ] && kill -0 "${HARNESS_PID}" 2>/dev/null; then
        kill -TERM "${HARNESS_PID}" 2>/dev/null || true
        for _ in $(seq 1 10); do
            if ! kill -0 "${HARNESS_PID}" 2>/dev/null; then
                break
            fi
            sleep 1
        done
    fi
    kill_listener_on_port
}
trap cleanup EXIT

echo "[smoke] Building harness..."
cd "${ROOT_DIR}/harness"
npm run build

echo "[smoke] Ensuring travel database is running..."
cd "${ROOT_DIR}/scenario/travel/databases"
docker compose up -d travel-postgres >/dev/null

echo "[smoke] Ensuring OPA is running from this repo (correct policy mount)..."
cd "${ROOT_DIR}"
docker compose -f docker/docker-compose.opa.yml up -d --force-recreate >/dev/null

echo "[smoke] Starting harness HTTP server..."
kill_listener_on_port
(
    cd "${ROOT_DIR}/harness"
    HARNESS_TRANSPORT=http \
    HARNESS_ALLOW_INSECURE_CONFIG_ONLY=true \
    HARNESS_BIND="${HARNESS_HOST}" \
    HARNESS_HTTP_PORT="${HARNESS_PORT}" \
    SCENARIO_PATH=../scenario/travel \
    exec npx tsx src/server.ts
) > "${ROOT_DIR}/.smoke-harness.log" 2>&1 &
HARNESS_PID=$!

if ! wait_for_harness_ready; then
    echo "[smoke] FAIL: harness did not become ready on ${HARNESS_URL}"
    tail -40 "${ROOT_DIR}/.smoke-harness.log" || true
    exit 1
fi

echo "[smoke] Running harness core test (no LLM)..."
cd "${ROOT_DIR}/agents"
./node_modules/.bin/tsx src/test-query.ts

echo "[smoke] OK"

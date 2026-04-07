#!/usr/bin/env bash
#
# Plan v3 umbrella verifier.
#
# Runs the critical phase verifiers in sequence and fails fast on first error.
# Each phase script writes its own timestamped evidence directory under docs/.
#
# Usage:
#   scripts/verify-plan-v3.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIMESTAMP="$(date +%Y-%m-%dT%H-%M-%S)"
EVIDENCE_DIR="${REPO_ROOT}/docs/plan-v3-verification/${TIMESTAMP}"
HARNESS_PORT=9080

mkdir -p "${EVIDENCE_DIR}"

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

run_phase() {
    local label="$1"
    local script="$2"
    local log_file="${EVIDENCE_DIR}/${label}.log"

    echo ""
    echo "=== ${label} (${script}) ==="
    kill_listener_on_port
    sleep 1
    if ! (cd "${REPO_ROOT}" && bash "${script}") > "${log_file}" 2>&1; then
        echo "FAIL: ${label} failed. See ${log_file}"
        tail -60 "${log_file}" || true
        exit 1
    fi

    local phase_evidence
    phase_evidence="$(grep -E 'Evidence dir:' "${log_file}" | tail -1 | sed 's/^.*Evidence dir:[[:space:]]*//')"
    if [ -n "${phase_evidence}" ]; then
        echo "PASS: ${label} (evidence: ${phase_evidence})"
    else
        echo "PASS: ${label} (evidence path not parsed; see ${log_file})"
    fi
}

run_phase "phase-0" "scripts/verify-phase-0.sh"
run_phase "phase-1a" "scripts/verify-phase-1a.sh"
run_phase "phase-1b" "scripts/verify-phase-1b.sh"
run_phase "phase-1c" "scripts/verify-phase-1c.sh"
run_phase "phase-2a" "scripts/verify-phase-2a.sh"
run_phase "phase-2b" "scripts/verify-phase-2b.sh"
run_phase "phase-2c" "scripts/verify-phase-2c.sh"

{
    echo "# Plan v3 Umbrella Verification — ${TIMESTAMP}"
    echo ""
    echo "- phase-0: PASS"
    echo "- phase-1a: PASS"
    echo "- phase-1b: PASS"
    echo "- phase-1c: PASS"
    echo "- phase-2a: PASS"
    echo "- phase-2b: PASS"
    echo "- phase-2c: PASS"
    echo ""
    echo "Per-phase logs:"
    echo "- ${EVIDENCE_DIR}/phase-0.log"
    echo "- ${EVIDENCE_DIR}/phase-1a.log"
    echo "- ${EVIDENCE_DIR}/phase-1b.log"
    echo "- ${EVIDENCE_DIR}/phase-1c.log"
    echo "- ${EVIDENCE_DIR}/phase-2a.log"
    echo "- ${EVIDENCE_DIR}/phase-2b.log"
    echo "- ${EVIDENCE_DIR}/phase-2c.log"
} > "${EVIDENCE_DIR}/summary.md"

echo ""
echo "PASS - Plan v3 umbrella verification complete. Evidence: ${EVIDENCE_DIR}"

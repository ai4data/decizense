#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[smoke] Building harness..."
cd "${ROOT_DIR}/harness"
npm run build

echo "[smoke] Running harness core test (no LLM)..."
cd "${ROOT_DIR}/agents"
./node_modules/.bin/tsx src/test-query.ts

echo "[smoke] OK"

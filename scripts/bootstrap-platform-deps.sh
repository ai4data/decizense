#!/usr/bin/env bash
set -euo pipefail

# Repair dependencies for the CURRENT platform.
# This prevents cross-platform native binary issues (e.g. esbuild win32 vs linux in WSL).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[bootstrap] Root: ${ROOT_DIR}"

for pkg in . harness agents; do
  if [[ "${pkg}" == "." ]]; then
    label="repo root"
    dir="${ROOT_DIR}"
  else
    label="${pkg}/"
    dir="${ROOT_DIR}/${pkg}"
  fi

  echo "[bootstrap] Repairing dependencies in ${label}"
  cd "${dir}"

  npm install --force
  npm rebuild esbuild || true
  npm install --no-save @esbuild/linux-x64 || true
done

echo "[bootstrap] Done. Dependencies match current platform."

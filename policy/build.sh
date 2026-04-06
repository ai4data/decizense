#!/usr/bin/env bash
# Rebuild policy/data.json + policy/.manifest from scenario YAMLs.
#
# Commit the resulting files whenever scenario/*/agents.yml,
# scenario/*/datasets/*/dataset.yaml, or scenario/*/policies/policy.yml change.
#
# Usage:  ./policy/build.sh [scenarioPath]
#         default scenarioPath = scenario/travel

set -euo pipefail
cd "$(dirname "$0")/.."
npx --prefix harness tsx policy/build.ts "${1:-scenario/travel}"

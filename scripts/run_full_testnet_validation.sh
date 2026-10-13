#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

run_local=1
run_live=1
live_args=()

usage() {
  cat <<'EOF'
Usage: scripts/run_full_testnet_validation.sh [--skip-local|--skip-live|--smoke-only|--plugin-matrix-only|--paymaster-only]

Composition:
- local validation gates
- live testnet validation
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-local)
      run_local=0
      shift
      ;;
    --skip-live)
      run_live=0
      shift
      ;;
    --smoke-only|--plugin-matrix-only|--paymaster-only)
      live_args+=("$1")
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

cd "$REPO_ROOT"

local_status="PASS"
local_output=""
cleanup() {
  if [[ -n "$local_output" ]]; then
    rm -f "$local_output"
  fi
}
trap cleanup EXIT

if [[ $run_local -eq 1 ]]; then
  local_output="$(mktemp)"
  if bash "$SCRIPT_DIR/verify_repo.sh" --skip-contract-build --skip-e2e | tee "$local_output"; then
    if grep -q 'status=PARTIAL' "$local_output"; then
      local_status="PARTIAL"
    fi
  else
    validation_status=$?
    exit "$validation_status"
  fi
fi

if [[ $run_live -eq 1 ]]; then
  if [[ ${#live_args[@]} -gt 0 ]]; then
    bash "$SCRIPT_DIR/run_live_testnet_validation.sh" "${live_args[@]}"
  else
    bash "$SCRIPT_DIR/run_live_testnet_validation.sh"
  fi
fi

echo ""
if [[ "$local_status" == "PARTIAL" ]]; then
  echo "Full testnet validation completed with PARTIAL local gates; inspect the gate status above."
else
  echo "Full testnet validation completed successfully."
fi

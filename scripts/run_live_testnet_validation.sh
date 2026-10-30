#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

run_smoke=1
run_plugin_matrix=1
run_paymaster_policy=1
run_paymaster_relay=1

usage() {
  cat <<'EOF'
Usage: scripts/run_live_testnet_validation.sh [--smoke-only|--plugin-matrix-only|--paymaster-only]

Runs live testnet validation layers for smart-account:
- smoke
- plugin matrix
- paymaster policy
- paymaster relay
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --smoke-only)
      run_smoke=1
      run_plugin_matrix=0
      run_paymaster_policy=0
      run_paymaster_relay=0
      shift
      ;;
    --plugin-matrix-only)
      run_smoke=0
      run_plugin_matrix=1
      run_paymaster_policy=0
      run_paymaster_relay=0
      shift
      ;;
    --paymaster-only)
      run_smoke=0
      run_plugin_matrix=0
      run_paymaster_policy=1
      run_paymaster_relay=1
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

if [[ $run_smoke -eq 1 ]]; then
  echo ""
  echo "=== SDK Testnet Smoke ==="
  npm --prefix sdk/js run testnet:validate:smoke
fi

if [[ $run_plugin_matrix -eq 1 ]]; then
  echo ""
  echo "=== Plugin Matrix Testnet Validation ==="
  npm --prefix sdk/js run testnet:validate:plugin-matrix
fi

if [[ $run_paymaster_policy -eq 1 ]]; then
  echo ""
  echo "=== Paymaster Policy Testnet Validation ==="
  npm --prefix sdk/js run testnet:validate:paymaster-policy
fi

if [[ $run_paymaster_relay -eq 1 ]]; then
  echo ""
  echo "=== Paymaster Relay Testnet Validation ==="
  npm --prefix sdk/js run testnet:validate:paymaster
fi

echo ""
echo "Live testnet validation completed successfully."

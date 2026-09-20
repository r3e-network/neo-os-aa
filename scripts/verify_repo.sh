#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/dotnet_env.sh"

# Consolidated local+CI validation entrypoint (absorbs the former
# run_local_validation_gates.sh — this script is a strict superset).
run_contracts=1
run_frontend=1
run_sdk=1
run_formal=0
skip_contract_build=0
skip_e2e=0

usage() {
  cat <<'EOF'
Usage: scripts/verify_repo.sh [--contracts-only|--frontend-only|--sdk-only] [--skip-contract-build] [--skip-e2e] [--formal]

Set NEOOS_REQUIRE_SERVICES_ARTIFACTS=1 for the release-grade cross-repository gate.
Pass --formal (or set NEOOS_REQUIRE_FORMAL=1) to also run the fail-closed AA model-checking
gate (formal/verify.py plus its runner tests). It needs Rocq/Coq 9, Z3, a real JDK (JAVA_BIN)
and tla2tools.jar (TLA_JAR); a missing tool is a failure, never a simulated pass.

Runs the full local validation gate:
- contracts: build + nccs compile + solution tests + deployment-tool tests + format verify
  (+ formal model checks with --formal)
- frontend: test + production dependency audit + build (+ browser e2e unless --skip-e2e)
- sdk: unit tests + declaration types check + production dependency audit
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --contracts-only)
      run_contracts=1; run_frontend=0; run_sdk=0; shift ;;
    --frontend-only)
      run_contracts=0; run_frontend=1; run_sdk=0; shift ;;
    --sdk-only)
      run_contracts=0; run_frontend=0; run_sdk=1; shift ;;
    --skip-contract-build)
      skip_contract_build=1; shift ;;
    --skip-e2e)
      skip_e2e=1; shift ;;
    --formal)
      run_formal=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1 ;;
  esac
done

if [[ $run_contracts -eq 1 ]]; then
  echo ""
  echo "=== Contract Gates ==="
  if [[ $skip_contract_build -eq 0 ]]; then
    dotnet build contracts/UnifiedSmartWallet.csproj -c Release -p:WarningsAsErrors=nullable -nologo
    bash contracts/compile.sh
  fi
  # The NeoDIDRegistry cross-contract proof deploys a compiled artifact built by
  # the private sibling repository neo-os-services, whose contracts/build output is
  # gitignored there. CI checks out this repository on its own, so state the gate's
  # reachability before the run instead of letting a bare "skipped" read as a pass.
  services_build="${NEOOS_SERVICES_CONTRACT_BUILD:-$ROOT_DIR/../neo-os-services/contracts/build}"
  if [[ -f "$services_build/NeoDIDRegistry.nef" && -f "$services_build/NeoDIDRegistry.manifest.json" ]]; then
    export NEOOS_REQUIRE_SERVICES_ARTIFACTS=1
    echo "cross-repo gate: NeoDIDRegistry integration proof ENABLED (artifact dir: $services_build)"
  elif [[ "${NEOOS_REQUIRE_SERVICES_ARTIFACTS:-0}" == "1" ]]; then
    echo "cross-repo gate: REQUIRED NeoDIDRegistry artifact is missing: $services_build" >&2
    echo "cross-repo gate: build neo-os-services contracts and set NEOOS_SERVICES_CONTRACT_BUILD, then retry." >&2
    exit 1
  else
    echo "cross-repo gate: NeoDIDRegistry integration proof NOT RUN - 0 cross-contract assertions executed."
    echo "cross-repo gate:   missing $services_build/NeoDIDRegistry.nef"
    echo "cross-repo gate:   that artifact is built by the private sibling repository neo-os-services and is"
    echo "cross-repo gate:   gitignored there, so a single-repository checkout cannot supply it."
    echo "cross-repo gate:   set NEOOS_SERVICES_CONTRACT_BUILD to a neo-os-services contract build directory to"
    echo "cross-repo gate:   run it, or NEOOS_REQUIRE_SERVICES_ARTIFACTS=1 to make its absence a hard failure."
  fi
  dotnet test neo-abstract-account.sln -c Release --nologo
  node --test scripts/lib/deploy-helpers.test.mjs \
    scripts/upgrade_mainnet_unified_smart_wallet.test.mjs \
    scripts/upgrade_testnet_unified_smart_wallet.test.mjs \
    scripts/deploy_latest_aa_verifiers.test.mjs
  dotnet format neo-abstract-account.sln --verify-no-changes --no-restore --verbosity minimal
  # The formal gate is opt-in because CI's ubuntu image ships neither Rocq/Coq 9 nor the TLA
  # tools; formal/verify.py refuses to substitute a simulated result for a missing tool, so an
  # unconditional run would only ever fail there. State the gap instead of hiding it.
  if [[ $run_formal -eq 1 || "${NEOOS_REQUIRE_FORMAL:-0}" == "1" ]]; then
    echo "formal gate: running fail-closed AA model checks (formal/verify.py)"
    python3 formal/verify.py
    python3 -m unittest discover -s formal -p 'test_*.py'
  else
    echo "formal gate: NOT RUN - formal/verify.py (Coq/TLC/Z3 model checks + semantic mutations) was skipped."
    echo "formal gate:   pass --formal or set NEOOS_REQUIRE_FORMAL=1 to run it; see docs/AA-FORMAL-VERIFICATION.md."
  fi
fi

if [[ $run_frontend -eq 1 ]]; then
  echo ""
  echo "=== Frontend Gates ==="
  cd frontend
  npm test
  npm run audit:prod
  npm run build
  if [[ $skip_e2e -eq 0 ]]; then
    npm run test:e2e:browser:built
  fi
  cd ..
fi

if [[ $run_sdk -eq 1 ]]; then
  echo ""
  echo "=== SDK Gates ==="
  cd sdk/js
  npm test
  npm run types:check
  npm run audit:prod
  cd ../..
fi

echo ""
echo "verify_repo gates completed successfully."

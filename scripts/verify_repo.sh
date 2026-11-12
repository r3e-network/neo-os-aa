#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Consolidated local+CI validation entrypoint (absorbs the former
# run_local_validation_gates.sh; --profile all selects both implementation gates).
run_contracts=1
run_frontend=1
run_sdk=1
run_formal=0
run_neoexpress=0
skip_contract_build=0
skip_e2e=0
verification_profile=ordinary
not_run_gates=()

usage() {
  cat <<'EOF'
Usage: scripts/verify_repo.sh [--profile ordinary|native|all] [--contracts-only|--frontend-only|--sdk-only] [--skip-contract-build] [--skip-e2e] [--formal] [--neoexpress]

Profile ordinary (default): published contract, frontend and SDK gates.
Profile native: native package/profile guards, module epoch VM fixture and browser checks.
Profile all: both. Shared frontend/SDK unit checks run for either profile.
The separate native-profile.yml workflow additionally verifies the pinned native core VM.
Every selected command is required; this script does not establish network activation.

Set NEOOS_REQUIRE_SERVICES_ARTIFACTS=1 for the release-grade cross-repository gate: a missing
neo-os-services NeoDIDRegistry artifact, or a missing neo-os-services checkout for the Morpheus
canonical-sync test (MORPHEUS_ORACLE_ROOT, else ../neo-os-services), then fails instead of skipping.
Set NEOOS_REQUIRE_COMPLETE=1 to fail closed when any selected optional gate would be NOT RUN.
Pass --formal (or set NEOOS_REQUIRE_FORMAL=1) to also run the fail-closed AA model-checking
gate (formal/verify.py plus its runner tests). Set NEOOS_NATIVE_CORE_SOURCE to the reviewed
core checkout matching formal/source-lock.json. It needs Coq 8.16+ (including Rocq 9), Z3, a real JDK (JAVA_BIN)
and tla2tools.jar (TLA_JAR); a missing tool is a failure, never a simulated pass.

Set NEOOS_NATIVE_EPOCH_RECEIPT to retain the native-module VM regression JSON at an explicit
path; otherwise the native contract gate writes and prints a temporary receipt path. This test-only
public-VM harness does not establish native-chain admission or recovery.

Pass --neoexpress (or set NEOOS_REQUIRE_NEOEXPRESS=1) for public v3 source acceptance on
a fresh disposable chain using published NeoExpress. It rebuilds both artifact profiles,
executes the eight-module source suite, joins its RPC readback to the build certificate,
and writes dated receipts under docs/reports/. NEOOS_NEOXP (else NEOXP, PATH, or
~/.dotnet/tools/neoxp) selects the published runner. Full-module PLATFORM provenance
remains a separate NOT RUN gate; this command never touches a public network.

Runs the selected profile gates:
- ordinary contracts: public build + solution tests + deployment-tool tests + format verify
- native contracts: profile/runner guards + native-module epoch VM regression
- optional: aggregate formal checks with --formal; public v3 source private chain with --neoexpress
- frontend: test + production dependency audit + build (+ browser e2e unless --skip-e2e)
- sdk: unit tests + declaration types check + installed-package smoke test + production dependency audit
EOF
}

mark_not_run() {
  not_run_gates+=("$1")
  if [[ "${NEOOS_REQUIRE_COMPLETE:-0}" == "1" ]]; then
    echo "required complete gate unavailable: $1" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      [[ $# -ge 2 ]] || { echo "--profile requires ordinary, native or all" >&2; exit 1; }
      verification_profile="$2"; shift 2 ;;
    --profile=*)
      verification_profile="${1#*=}"; shift ;;
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
    --neoexpress)
      run_neoexpress=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1 ;;
  esac
done

run_ordinary=0
run_native=0
case "$verification_profile" in
  ordinary) run_ordinary=1 ;;
  native) run_native=1 ;;
  all) run_ordinary=1; run_native=1 ;;
  *) echo "Unknown verification profile: $verification_profile" >&2; exit 1 ;;
esac
# A complete run must also fail closed on the generated Morpheus artifacts' external
# canonical source gate, including frontend-only dispatches that do not enter the
# contract block below.
if [[ "${NEOOS_REQUIRE_COMPLETE:-0}" == "1" ]]; then
  export NEOOS_REQUIRE_SERVICES_ARTIFACTS=1
fi
if [[ $run_ordinary -eq 0 && ( $run_neoexpress -eq 1 || "${NEOOS_REQUIRE_NEOEXPRESS:-0}" == "1" ) ]]; then
  echo "--neoexpress selects public v3 source acceptance; choose ordinary/all or use the dedicated native-chain runner." >&2
  exit 1
fi

if [[ $run_contracts -eq 1 ]]; then
  echo ""
  echo "=== Contract Gates ==="
  # Restores the pinned Neo packages in locked mode first (every package is published on
  # nuget.org), so a changed resolution, different package bytes or a different nccs stop here
  # with the pinned versions named (docs/AA-REPRODUCIBLE-BUILD.md) instead of deep inside the build.
  source "$ROOT_DIR/scripts/dotnet_env.sh"
  if [[ $run_native -eq 1 ]]; then
    node scripts/check_neo_platform_packages.mjs --include-native
  else
    node scripts/check_neo_platform_packages.mjs
  fi
  node scripts/check_neo_platform_packages.mjs --compiler-only
  if [[ $run_ordinary -eq 1 ]]; then
    if [[ $skip_contract_build -eq 0 ]]; then
      dotnet build contracts/SmartAccount.csproj -c Release -p:WarningsAsErrors=nullable -nologo
      bash contracts/compile.sh
    fi
    # The NeoDIDRegistry cross-contract proof deploys a compiled artifact built by
    # the private sibling repository neo-os-services, whose contracts/build output is
    # gitignored there. CI checks out this repository on its own, so state the gate's
    # reachability before the run instead of letting a bare "skipped" read as a pass.
    services_build="${NEOOS_SERVICES_CONTRACT_BUILD:-$ROOT_DIR/../neo-os-services/vendor/neo-os-did/contracts/build}"
    if [[ -f "$services_build/NeoDIDRegistry.nef" && -f "$services_build/NeoDIDRegistry.manifest.json" ]]; then
      export NEOOS_REQUIRE_SERVICES_ARTIFACTS=1
      echo "cross-repo gate: NeoDIDRegistry integration proof ENABLED (artifact dir: $services_build)"
    elif [[ "${NEOOS_REQUIRE_SERVICES_ARTIFACTS:-0}" == "1" && "${NEOOS_REQUIRE_COMPLETE:-0}" != "1" ]]; then
      echo "cross-repo gate: REQUIRED NeoDIDRegistry artifact is missing: $services_build" >&2
      echo "cross-repo gate: build neo-os-services contracts and set NEOOS_SERVICES_CONTRACT_BUILD, then retry." >&2
      exit 1
    else
      mark_not_run "cross-repo"
      echo "cross-repo gate: NeoDIDRegistry integration proof NOT RUN - 0 cross-contract assertions executed."
      echo "cross-repo gate:   missing $services_build/NeoDIDRegistry.nef"
      echo "cross-repo gate:   that artifact is built by the private sibling repository neo-os-services and is"
      echo "cross-repo gate:   gitignored there, so a single-repository checkout cannot supply it."
      echo "cross-repo gate:   set NEOOS_SERVICES_CONTRACT_BUILD to a neo-os-services contract build directory to"
      echo "cross-repo gate:   run it, or NEOOS_REQUIRE_SERVICES_ARTIFACTS=1 to make its absence a hard failure."
    fi
    echo "public-profile gate: verifier-callback tests run on the published TestEngine; private PLATFORM bytecode is checked separately."
    dotnet test SmartAccount.sln -c Release --nologo
    python3 -m unittest discover -s scripts -p 'test_neoexpress_validate.py'
    python3 -m unittest discover -s scripts -p 'test_neoexpress_source_validate.py'
    python3 -m unittest discover -s scripts -p 'test_neoexpress_reproducible_build.py'
    node --test scripts/lib/deploy-helpers.test.mjs \
      scripts/upgrade_mainnet_smart_account.test.mjs \
      scripts/upgrade_testnet_smart_account.test.mjs \
      scripts/deploy_latest_aa_verifiers.test.mjs \
      scripts/check_neo_platform_packages.test.mjs \
      scripts/check-artifact-reproducibility.test.mjs \
      scripts/check-ordinary-runtime-provenance.test.mjs \
      scripts/fuzz_continuous.test.mjs \
      scripts/repo_hygiene.test.mjs \
      scripts/verify-private-artifact-provenance.test.mjs \
      scripts/implementation_profiles.test.mjs \
      scripts/verify_repo.test.mjs
    dotnet format SmartAccount.sln --verify-no-changes --no-restore --verbosity minimal
  fi
  if [[ $run_native -eq 1 ]]; then
    # Keep the shared profile registry covered even when the native contract
    # lane is run without the ordinary lane.
    if [[ $run_ordinary -eq 0 ]]; then
      node --test scripts/implementation_profiles.test.mjs
    fi
    python3 docs/proposals/validate-native-smartaccount-profile.py
    python3 -m unittest discover -s docs/proposals -p 'test_native_profile*.py'
    python3 -m unittest discover -s scripts -p 'test_native_module_*.py'
    python3 -m unittest discover -s scripts -p 'test_native_profile_ci.py'
    python3 -m unittest discover -s scripts -p 'test_neoexpress_native_*.py'
    python3 -m unittest discover -s scripts -p 'test_neoexpress_activation_validate.py'
    python3 -m unittest discover -s scripts -p 'test_native_budget_benchmark.py'
    python3 -m unittest discover -s scripts -p 'test_build_native_*.py'
    # Real production module bytecode runs in the public NeoVM with a test-only ABI
    # fixture. This proves module storage/object isolation, not native-chain admission.
    native_epoch_probe_receipt="${NEOOS_NATIVE_EPOCH_RECEIPT:-}"
    if [[ -z "$native_epoch_probe_receipt" ]]; then
      native_epoch_probe_receipt="$(mktemp "${TMPDIR:-/tmp}/aa-native-epoch.XXXXXX")"
    fi
    echo "native module VM regression: locked production build + test-only public-VM fixture (not native-chain proof)"
    echo "native module VM receipt: $native_epoch_probe_receipt"
    python3 scripts/native_epoch_probe.py --compiler "$NCCS_BIN" --output "$native_epoch_probe_receipt"
  fi
  # The formal gate is opt-in because CI's ubuntu image ships neither Rocq/Coq 9 nor the TLA
  # tools; formal/verify.py refuses to substitute a simulated result for a missing tool, so an
  # unconditional run would only ever fail there. State the gap instead of hiding it.
  if [[ $run_formal -eq 1 || "${NEOOS_REQUIRE_FORMAL:-0}" == "1" ]]; then
    echo "formal gate: running fail-closed AA model checks (formal/verify.py)"
    python3 formal/verify.py
    python3 -m unittest discover -s formal -p 'test_*.py'
  else
    mark_not_run "formal"
    echo "formal gate: NOT RUN - formal/verify.py (Coq/TLC/Z3 model checks + semantic mutations) was skipped."
    echo "formal gate:   pass --formal or set NEOOS_REQUIRE_FORMAL=1 to run it; see docs/AA-FORMAL-VERIFICATION.md."
  fi
  # The private-chain validation is opt-in for the same reason: it needs the neoxp tool,
  # takes several minutes, and a missing tool must read as NOT RUN, never as a pass.
  if [[ $run_neoexpress -eq 1 || "${NEOOS_REQUIRE_NEOEXPRESS:-0}" == "1" ]]; then
    echo "neoexpress gate: public v3 source acceptance on published NeoExpress (eight deployed modules)"
    neoxp_tool="${NEOOS_NEOXP:-${NEOXP:-$(command -v neoxp || true)}}"
    neoxp_tool="${neoxp_tool:-$HOME/.dotnet/tools/neoxp}"
    neoexpress_date="$(date -u +%Y%m%d)"
    repro_receipt="$ROOT_DIR/docs/reports/aa-artifact-reproducibility-$neoexpress_date.json"
    neoexpress_receipt="$ROOT_DIR/docs/reports/aa-ordinary-source-chain-$neoexpress_date.json"
    provenance_receipt="$ROOT_DIR/docs/reports/aa-ordinary-runtime-provenance-$neoexpress_date.json"
    mkdir -p "$ROOT_DIR/docs/reports"
    # Invalidate previous receipts so a failed rerun cannot leave a current-looking PASS.
    rm -f "$neoexpress_receipt" "$provenance_receipt"
    echo "reproducibility gate: rebuilding release artifacts and writing ${repro_receipt#$ROOT_DIR/}"
    node scripts/check-artifact-reproducibility.mjs --json > "$repro_receipt"
    NEOXP="$neoxp_tool" python3 tests/localchain/run.py --variant source \
      --source-dir "$ROOT_DIR/contracts/bin/v3" --receipt "$neoexpress_receipt"
    echo "neoexpress gate: joining source/rebuild certificate to eight-module RPC readback"
    node scripts/check-ordinary-runtime-provenance.mjs \
      --repro "$repro_receipt" \
      --receipt "$neoexpress_receipt" > "$provenance_receipt"
    echo "neoexpress gate: provenance receipt written to ${provenance_receipt#$ROOT_DIR/}"
    echo "unselected PLATFORM matrix: NOT RUN - ordinary source acceptance covers eight deployed modules; full-module validation has a separate runner."
  else
    mark_not_run "neoexpress"
    echo "neoexpress gate: NOT RUN - tests/localchain/run.py --variant source (public v3 private-chain acceptance) was skipped."
    echo "neoexpress gate:   pass --neoexpress or set NEOOS_REQUIRE_NEOEXPRESS=1 to run it."
  fi
fi

if [[ $run_frontend -eq 1 ]]; then
  echo ""
  echo "=== Frontend Gates ==="
  cd frontend
  npm test
  npm run audit:prod
  npm run audit:all
  npm run build
  if [[ $skip_e2e -eq 0 ]]; then
    if [[ $run_ordinary -eq 1 ]]; then
      npm run test:e2e:browser:built
      npm run test:ordinary:browser
      npm run test:operator-recovery:browser
      npm run test:web3auth:browser
      npm run test:docs-security:browser
      npm run test:bundle:browser
    fi
    if [[ $run_native -eq 1 ]]; then
      npm run test:native:browser
    fi
  fi
  cd ..
fi

if [[ $run_sdk -eq 1 ]]; then
  echo ""
  echo "=== SDK Gates ==="
  cd sdk/js
  npm test
  npm run types:check
  npm run test:package
  npm run audit:prod
  cd ../..
fi

echo ""
if [[ ${#not_run_gates[@]} -eq 0 ]]; then
  echo "verify_repo $verification_profile gates completed successfully; status=PASS."
else
  IFS=,; echo "verify_repo $verification_profile checks passed with NOT RUN gates; status=PARTIAL; notRun=${not_run_gates[*]}."
fi

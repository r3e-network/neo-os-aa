#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Consolidated local+CI validation entrypoint for the native-only solution
# (--profile native is the only accepted implementation profile).
run_contracts=1
run_frontend=1
run_sdk=1
run_formal=0
skip_e2e=0
verification_profile=native
not_run_gates=()

usage() {
  cat <<'EOF'
Usage: scripts/verify_repo.sh [--profile native] [--contracts-only|--frontend-only|--sdk-only] [--skip-e2e] [--formal]

Native is the only implementation profile: native package and compiler guards, the native-only
solution build, the native unit tests, the module epoch VM fixture and native browser checks.
--profile native stays accepted for existing callers and is the only valid value.
The separate native-profile.yml workflow additionally verifies the pinned native core VM.
Every selected command is required; this script does not establish network activation.

Set NEOOS_REQUIRE_SERVICES_ARTIFACTS=1 for the release-grade cross-repository gate: a missing
neo-os-services NeoDIDRegistry artifact, or a missing neo-os-services checkout for the Morpheus
canonical-sync test (MORPHEUS_ORACLE_ROOT, else ../neo-os-services), then fails instead of skipping.
Set NEOOS_REQUIRE_COMPLETE=1 to fail closed when any selected optional gate would be NOT RUN.
Pass --formal (or set NEOOS_REQUIRE_FORMAL=1) to also run the fail-closed SA model-checking
gate (formal/verify.py plus its runner tests). Set NEOOS_NATIVE_CORE_SOURCE to the reviewed
core checkout matching formal/source-lock.json (default: ../neo-native-core). It needs Coq
8.16+ (including Rocq 9); a missing
tool is a failure, never a simulated pass.

Set NEOOS_NATIVE_CORE_SOURCE to the pinned core checkout the native solution build and unit
tests compile against, and the same checkout carries the SmartAccount mirror and core-tree pin
checks. The default sibling directory ../neo-native-core is used when present; without either,
the native build/test gate and the core pin gate are reported NOT RUN instead of silently passing.

Set NEOOS_NATIVE_EPOCH_RECEIPT to retain the native-module VM regression JSON at an explicit
path; otherwise the native contract gate writes and prints a temporary receipt path. This test-only
public-VM harness does not establish native-chain admission or recovery.

Runs the selected gates:
- native contracts: package/compiler guards + profile and dispatch scripts + architecture gates (ABI IDL, native purity, core mirror sync, core-tree pin) + native solution build + native unit tests + native-module epoch VM regression
- optional: aggregate formal checks with --formal
- frontend: test + production dependency audit + build (+ docs dependency-security, identity-bundle and native browser checks unless --skip-e2e)
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
      [[ $# -ge 2 ]] || { echo "--profile requires native" >&2; exit 1; }
      verification_profile="$2"; shift 2 ;;
    --profile=*)
      verification_profile="${1#*=}"; shift ;;
    --contracts-only)
      run_contracts=1; run_frontend=0; run_sdk=0; shift ;;
    --frontend-only)
      run_contracts=0; run_frontend=1; run_sdk=0; shift ;;
    --sdk-only)
      run_contracts=0; run_frontend=0; run_sdk=1; shift ;;
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

# Native is the only implementation profile; anything else is a hard usage error.
if [[ "$verification_profile" != "native" ]]; then
  echo "Unknown verification profile: $verification_profile (native is the only one)" >&2
  exit 1
fi
# A complete run must also fail closed on the generated Morpheus artifacts' external
# canonical source gate, including frontend-only dispatches that do not enter the
# contract block below.
if [[ "${NEOOS_REQUIRE_COMPLETE:-0}" == "1" ]]; then
  export NEOOS_REQUIRE_SERVICES_ARTIFACTS=1
fi

if [[ $run_contracts -eq 1 ]]; then
  echo ""
  echo "=== Contract Gates ==="
  # Restores the pinned Neo packages in locked mode first (every package is published on
  # nuget.org), so a changed resolution, different package bytes or a different nccs stop here
  # with the pinned versions named (docs/engineering/VERIFICATION-AND-GATES.md, "SA contracts:
  # reproducible build from published packages") instead of deep inside the build.
  source "$ROOT_DIR/scripts/dotnet_env.sh"
  # Native is the only package scope: the six SMARTACCOUNT_NATIVE modules, the epoch probe host
  # and its ABI fixture, and the two source-runtime probes.
  node scripts/check_neo_platform_packages.mjs
  node scripts/check_neo_platform_packages.mjs --compiler-only
  # Profile and dispatch suites: they describe the native profile and this script's own routing,
  # so they run before any restore-heavy build.
  node --test scripts/implementation_profiles.test.mjs \
    scripts/check_neo_platform_packages.test.mjs \
    scripts/verify_repo.test.mjs
  # Linux CI and macOS name the interpreter python3. A Windows python3.exe can be
  # only the Microsoft Store alias, which exits without running anything, while the
  # real interpreter is python or `py -3`, so the first candidate that answers
  # --version is used. CI resolves python3 on the first probe and is unchanged.
  python_cmd=()
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" --version >/dev/null 2>&1; then
      python_cmd=("$candidate"); break
    fi
  done
  if [[ ${#python_cmd[@]} -eq 0 ]] && command -v py >/dev/null 2>&1 && py -3 --version >/dev/null 2>&1; then
    python_cmd=(py -3)
  fi
  if [[ ${#python_cmd[@]} -eq 0 ]]; then
    echo "python interpreter: NOT FOUND - need a python3, python or py -3 that answers --version." >&2
    exit 2
  fi
  # Architecture gates (docs/engineering/VERIFICATION-AND-GATES.md, "Gate list"). They read
  # sources only, so they run before any restore-heavy build.
  echo "architecture gates: ABI IDL + native purity"
  # The 26-method ABI the manifest, SDK and clients are held to.
  "${python_cmd[@]}" scripts/check_smartaccount_v41_idl.py
  # contracts/native/SmartAccount stays a native contract: no embedded engine, opcode
  # interpreter, retired Envelope codec, self-built gas budget or runtime script construction
  # outside the pinned exceptions.
  "${python_cmd[@]}" scripts/native_purity.py
  # Native build and unit-test path. SmartAccount.sln is native-only: it compiles the overlay
  # core and the native test surface against the pinned core checkout.
  native_core_source="${NEOOS_NATIVE_CORE_SOURCE:-$ROOT_DIR/../neo-native-core}"
  if [[ -f "$native_core_source/src/Neo/Neo.csproj" && -f "$native_core_source/tests/AssemblyInfo.cs" ]]; then
    # The core checkout is pinned two ways before anything is compiled against it: its
    # SmartAccount files must be the generated copies of contracts/native/SmartAccount, and its
    # whole difference from upstream Neo must stay inside the reviewed allowlist.
    echo "core gates: SmartAccount mirror sync + core-tree pin against upstream Neo"
    "${python_cmd[@]}" scripts/sync_native_smartaccount.py --check --core "$native_core_source"
    "${python_cmd[@]}" scripts/native_core_pin.py --core "$native_core_source"
    # This job executes tests, not the NuGet documentation packaging target.
    native_core_args=(-p:GenerateDocumentationFile=false -p:NeoSourceRoot="$native_core_source/src" -p:NeoCoreRoot="$native_core_source/src/Neo" -p:NeoTestsRoot="$native_core_source/tests/Neo.UnitTests")
    echo "native build gate: SmartAccount.sln against the pinned core checkout at $native_core_source"
    dotnet build SmartAccount.sln -c Release --nologo "${native_core_args[@]}"
    echo "native unit-test gate: tests/SmartAccount.Native.Tests"
    standard_module_dir="$(mktemp -d "${TMPDIR:-/tmp}/sa-standard-modules.XXXXXX")"
    trap 'rm -rf -- "$standard_module_dir"' EXIT
    # Standard modules the integration tests deploy, built with the same pinned compiler as the
    # packaged ones. HookOrchestratorModule is a standard module like GovernanceModule (no
    # SMARTACCOUNT_NATIVE define, no native-smartaccount manifest marker, installData
    # ["empty","hookOrder"]), not one of the six named packages in profiles.json, so
    # build_native_modules.py must not package it (check_module_neps.py --native-packages
    # requires the package inventory to equal the descriptor); the tests still deploy its NEF.
    # DailyLimitHook.Native is the second hook the hook-order scenarios install next to
    # WhitelistHook; without it those tests throw FileNotFoundException instead of running.
    for module_project in contracts/modules/GovernanceModule/GovernanceModule.csproj \
        contracts/modules/HookOrchestratorModule/HookOrchestratorModule.csproj \
        contracts/modules/SigningModule/SigningModule.csproj contracts/modules/ThresholdPolicyModule/ThresholdPolicyModule.csproj \
        contracts/plugins/native-profile/MultiSigValidator.Native.csproj \
        contracts/modules/RecoveryModule/RecoveryModule.csproj contracts/plugins/native-profile/WhitelistHook.Native.csproj \
        contracts/plugins/native-profile/DailyLimitHook.Native.csproj; do
      "$NCCS_BIN" "$module_project" -o "$standard_module_dir"
    done
    node scripts/check_standard_governance_artifacts.mjs "$standard_module_dir"
    node scripts/check_standard_recovery_nef.mjs "$standard_module_dir/RecoveryModule.nef"
    native_test_args=("${native_core_args[@]}")
    if [[ -n "${NEOOS_NATIVE_TEST_RESULTS:-}" ]]; then
      native_test_args+=(--results-directory "$NEOOS_NATIVE_TEST_RESULTS" --logger "trx;LogFileName=native.trx")
    fi
    SMARTACCOUNT_ADDRESS_VECTORS="$standard_module_dir/address-vectors.json" \
      dotnet test tests/SmartAccount.Native.Tests/SmartAccount.Tests.csproj -c Release --nologo \
      "${native_test_args[@]}" -p:StandardModuleNefDir="$standard_module_dir"
    node scripts/check_native_receiving_addresses.cjs "$standard_module_dir/address-vectors.json"
  else
    mark_not_run "native-build"
    echo "native build gate: NOT RUN - no pinned core checkout at $native_core_source."
    echo "native build gate:   set NEOOS_NATIVE_CORE_SOURCE to a reviewed neo checkout (src/Neo and tests/AssemblyInfo.cs must exist)."
    mark_not_run "native-core-pin"
    echo "core gates: NOT RUN - the SmartAccount mirror sync and the core-tree pin need the pinned core checkout."
  fi
  "${python_cmd[@]}" docs/proposals/validate-native-smartaccount-profile.py
  # Native surface size and ownership: SmartAccount-specific lines stay within the
  # v4.1 budget and the native core never names module policy (see the script docstring).
  "${python_cmd[@]}" scripts/native_source_budget.py
  "${python_cmd[@]}" -m unittest discover -s scripts -p 'test_native_*.py'
  "${python_cmd[@]}" -m unittest discover -s scripts -p 'test_neoexpress*.py'
  "${python_cmd[@]}" -m unittest discover -s scripts -p 'test_check_module_neps.py'
  "${python_cmd[@]}" scripts/check_module_neps.py --compiler "$NCCS_BIN" --vm-getters --vm-commands
  # Both plugin templates compile with the pinned compiler and satisfy the module NEP.
  node scripts/check_plugin_templates.mjs
  "${python_cmd[@]}" -m unittest discover -s scripts -p 'test_build_native_*.py'
  # Real production module bytecode runs in the public NeoVM with a test-only ABI
  # fixture. This proves module storage/object isolation, not native-chain admission.
  native_epoch_probe_receipt="${NEOOS_NATIVE_EPOCH_RECEIPT:-}"
  if [[ -z "$native_epoch_probe_receipt" ]]; then
    native_epoch_probe_receipt="$(mktemp "${TMPDIR:-/tmp}/sa-native-epoch.XXXXXX")"
  fi
  echo "native module VM regression: locked production build + test-only public-VM fixture (not native-chain proof)"
  echo "native module VM receipt: $native_epoch_probe_receipt"
  "${python_cmd[@]}" scripts/native_epoch_probe.py --compiler "$NCCS_BIN" --output "$native_epoch_probe_receipt"
  # The current model requires a Coq installation and a pinned native source tree.
  if [[ $run_formal -eq 1 || "${NEOOS_REQUIRE_FORMAL:-0}" == "1" ]]; then
    echo "formal gate: running fail-closed SA model checks (formal/verify.py)"
    "${python_cmd[@]}" formal/verify.py --native-core-root "$native_core_source"
    "${python_cmd[@]}" -m unittest discover -s formal -p 'test_*.py'
  else
    mark_not_run "formal"
    echo "formal gate: NOT RUN - formal/verify.py (current policy proofs and semantic mutations) was skipped."
    echo "formal gate:   pass --formal or set NEOOS_REQUIRE_FORMAL=1 to run it; see docs/engineering/VERIFICATION-AND-GATES.md (SA Formal Verification)."
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
    # The docs dependency-security contract test is independent of the retired custom
    # profile: it proves the patched renderer rejects inherited trust options in a real
    # browser, so it stays in the native gate.
    npm run test:docs-security:browser
    npm run test:bundle:browser
    npm run test:native:browser
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

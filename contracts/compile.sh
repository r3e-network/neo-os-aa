#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/contracts"
source "$ROOT_DIR/scripts/dotnet_env.sh"

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--platform" ) ]]; then
  echo "Usage: contracts/compile.sh [--platform]" >&2
  exit 1
fi

# The NEF header names the compiler and its code generation decides the bytes, so artifacts
# compiled with anything but the pinned nccs package are not the pinned build.
node "$ROOT_DIR/scripts/check_neo_platform_packages.mjs" --compiler-only

# nccs 3.9.1 does not read MSBuild DefineConstants, and C# #define directives are
# file-scoped. Define PLATFORM in every disposable source copy; never mutate the
# public sources or write private bytes to bin/public.
if [[ "${1:-}" == "--platform" ]]; then
  profile_dir="$(mktemp -d "${TMPDIR:-/tmp}/sa-platform.XXXXXX")"
  trap 'rm -rf "$profile_dir"' EXIT
  mkdir -p "$profile_dir/contracts"
  cp "$ROOT_DIR/Directory.Build.props" "$ROOT_DIR/nuget.config" "$profile_dir/"
  cp "$ROOT_DIR/contracts/custom/SmartAccount.csproj" "$ROOT_DIR/contracts/custom/packages.lock.json" \
    "$profile_dir/contracts/"
  for source in "$ROOT_DIR"/contracts/custom/*.cs; do
    { printf '#define PLATFORM\n'; cat "$source"; } \
      > "$profile_dir/contracts/$(basename "$source")"
  done
  cd "$profile_dir/contracts"
  "$NCCS_BIN" SmartAccount.csproj -o "$ROOT_DIR/contracts/bin/platform"
  exit 0
fi

echo "Cleaning stale build intermediates..."
find "$ROOT_DIR/contracts/custom" "$ROOT_DIR/contracts/plugins" "$ROOT_DIR/tests/mocks" \
  -type d -name obj -prune -exec rm -rf {} +

# Every project writes into contracts/bin/public whatever directory it lives in, so the artifact
# layout the tests, the SDK and the deploy scripts read does not follow the source layout.
echo "Compiling SmartAccount V3 Core..."
pushd custom >/dev/null
"$NCCS_BIN" SmartAccount.csproj -o ../bin/public
popd >/dev/null

echo "Compiling Verifiers..."
pushd plugins/verifiers >/dev/null
"$NCCS_BIN" ./Web3AuthVerifier.csproj -o ../../bin/public/verifiers
"$NCCS_BIN" ./TEEVerifier.csproj -o ../../bin/public/verifiers
"$NCCS_BIN" ./SessionKeyVerifier.csproj -o ../../bin/public/verifiers
"$NCCS_BIN" ./WebAuthnVerifier.csproj -o ../../bin/public/verifiers
"$NCCS_BIN" ./ZKEmailVerifier.csproj -o ../../bin/public/verifiers
"$NCCS_BIN" ./ZkLoginVerifier.csproj -o ../../bin/public/verifiers
"$NCCS_BIN" ./MultiSigVerifier.csproj -o ../../bin/public/verifiers
"$NCCS_BIN" ./SubscriptionVerifier.csproj -o ../../bin/public/verifiers
"$NCCS_BIN" ./NeoNativeVerifier.csproj -o ../../bin/public/verifiers
popd >/dev/null

echo "Compiling Hooks..."
pushd plugins/hooks >/dev/null
"$NCCS_BIN" ./DailyLimitHook.csproj -o ../../bin/public/hooks
"$NCCS_BIN" ./NeoDIDCredentialHook.csproj -o ../../bin/public/hooks
"$NCCS_BIN" ./WhitelistHook.csproj -o ../../bin/public/hooks
"$NCCS_BIN" ./MultiHook.csproj -o ../../bin/public/hooks
"$NCCS_BIN" ./TokenRestrictedHook.csproj -o ../../bin/public/hooks
popd >/dev/null

# Test-support mocks. The contract test suite deploys all seven from bin/public
# (MockTransferTarget in the execution/market/escrow suites, MockVerifierCore in the
# verifier suites, and
# MarkerOnlyModule, WrongLifecycleAbiModule and WrongHookLifecycleAbiModule in
# the lifecycle-ABI negative suite, plus PolicyExecutionProbe for policy enforcement), so they
# are always compiled: a clean checkout that skipped them could not run
# `dotnet test`. bin/public is gitignored and the deploy scripts select artifacts by
# name, so the mocks never reach a network. INCLUDE_VALIDATION_MOCKS is accepted
# for compatibility with older runbooks but no longer changes the output.
# Phase 1b: PlatformRegistrarMock was removed — the registrar suites now deploy the
# real SAPlatformRegistrar service contract built below.
# The mock sources live with the tests (tests/mocks), not under contracts/.
echo "Compiling test-support mocks..."
pushd "$ROOT_DIR/tests/mocks" >/dev/null
"$NCCS_BIN" ./MockVerifierCore.csproj -o ../../contracts/bin/public
"$NCCS_BIN" ./MockTransferTarget.csproj -o ../../contracts/bin/public
"$NCCS_BIN" ./MarkerOnlyModule.csproj -o ../../contracts/bin/public
"$NCCS_BIN" ./WrongLifecycleAbiModule.csproj -o ../../contracts/bin/public
"$NCCS_BIN" ./WrongHookLifecycleAbiModule.csproj -o ../../contracts/bin/public
"$NCCS_BIN" ./PolicyExecutionProbe.csproj -o ../../contracts/bin/public
popd >/dev/null

echo "Compiling Market Contracts..."
pushd custom/market >/dev/null
"$NCCS_BIN" ./SAAddressMarket.csproj -o ../../bin/public
popd >/dev/null

# Phase 1b: the paymaster service contract settles sponsored reimbursements and is
# deployed by the runtime test suite from bin/public (SAPaymaster.nef), so it is built
# alongside the other service contracts instead of relying on a manual nccs run.
echo "Compiling Paymaster Contracts..."
pushd custom/paymaster >/dev/null
"$NCCS_BIN" ./Paymaster.csproj -o ../../bin/public
popd >/dev/null

# Phase 1b: the platform registrar service owns pending platform-account owner
# rotations and is deployed by the runtime test suite from bin/public
# (SAPlatformRegistrar.nef) with the core hash as deploy data.
echo "Compiling Registrar Contracts..."
pushd custom/registrar >/dev/null
"$NCCS_BIN" ./PlatformRegistrar.csproj -o ../../bin/public
popd >/dev/null

echo "Compiling Recovery Contracts..."
pushd plugins/recovery >/dev/null
"$NCCS_BIN" ./MorpheusSocialRecoveryVerifier.csproj -o ../../bin/public
popd >/dev/null

echo "Compiling the private PLATFORM core into its separate artifact directory..."
bash "$ROOT_DIR/contracts/compile.sh" --platform

echo "Compilation completed successfully."

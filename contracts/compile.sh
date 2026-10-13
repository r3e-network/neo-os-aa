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

# nccs 3.9.1 does not read MSBuild DefineConstants. Define PLATFORM in a disposable
# source copy; never mutate the public sources or write private bytes to bin/v3.
if [[ "${1:-}" == "--platform" ]]; then
  profile_dir="$(mktemp -d "${TMPDIR:-/tmp}/aa-platform.XXXXXX")"
  trap 'rm -rf "$profile_dir"' EXIT
  mkdir -p "$profile_dir/contracts"
  cp "$ROOT_DIR/Directory.Build.props" "$ROOT_DIR/nuget.config" "$profile_dir/"
  cp "$ROOT_DIR"/contracts/*.cs "$ROOT_DIR/contracts/UnifiedSmartWallet.csproj" \
    "$ROOT_DIR/contracts/packages.lock.json" "$profile_dir/contracts/"
  { printf '#define PLATFORM\n'; cat "$ROOT_DIR/contracts/UnifiedSmartWallet.Execution.cs"; } \
    > "$profile_dir/contracts/UnifiedSmartWallet.Execution.cs"
  cd "$profile_dir/contracts"
  "$NCCS_BIN" UnifiedSmartWallet.csproj -o "$ROOT_DIR/contracts/bin/platform"
  exit 0
fi

echo "Cleaning stale build intermediates..."
find "$ROOT_DIR/contracts" -type d -name obj -prune -exec rm -rf {} +

echo "Compiling UnifiedSmartWallet V3 Core..."
"$NCCS_BIN" UnifiedSmartWallet.csproj -o bin/v3

echo "Compiling Verifiers..."
pushd verifiers >/dev/null
"$NCCS_BIN" ./Web3AuthVerifier.csproj -o ../bin/v3/verifiers
"$NCCS_BIN" ./TEEVerifier.csproj -o ../bin/v3/verifiers
"$NCCS_BIN" ./SessionKeyVerifier.csproj -o ../bin/v3/verifiers
"$NCCS_BIN" ./WebAuthnVerifier.csproj -o ../bin/v3/verifiers
"$NCCS_BIN" ./ZKEmailVerifier.csproj -o ../bin/v3/verifiers
"$NCCS_BIN" ./ZkLoginVerifier.csproj -o ../bin/v3/verifiers
"$NCCS_BIN" ./MultiSigVerifier.csproj -o ../bin/v3/verifiers
"$NCCS_BIN" ./SubscriptionVerifier.csproj -o ../bin/v3/verifiers
"$NCCS_BIN" ./NeoNativeVerifier.csproj -o ../bin/v3/verifiers
popd >/dev/null

echo "Compiling Hooks..."
pushd hooks >/dev/null
"$NCCS_BIN" ./DailyLimitHook.csproj -o ../bin/v3/hooks
"$NCCS_BIN" ./NeoDIDCredentialHook.csproj -o ../bin/v3/hooks
"$NCCS_BIN" ./WhitelistHook.csproj -o ../bin/v3/hooks
"$NCCS_BIN" ./MultiHook.csproj -o ../bin/v3/hooks
"$NCCS_BIN" ./TokenRestrictedHook.csproj -o ../bin/v3/hooks
popd >/dev/null

# Test-support mocks. The contract test suite deploys all seven from bin/v3
# (MockTransferTarget in the execution/market/escrow suites, PlatformRegistrarMock
# in the platform-registrar suite, MockVerifierCore in the verifier suites, and
# MarkerOnlyModule, WrongLifecycleAbiModule and WrongHookLifecycleAbiModule in
# the lifecycle-ABI negative suite, plus PolicyExecutionProbe for policy enforcement), so they
# are always compiled: a clean checkout that skipped them could not run
# `dotnet test`. bin/v3 is gitignored and the deploy scripts select artifacts by
# name, so the mocks never reach a network. INCLUDE_VALIDATION_MOCKS is accepted
# for compatibility with older runbooks but no longer changes the output.
echo "Compiling test-support mocks..."
pushd mocks >/dev/null
"$NCCS_BIN" ./MockVerifierCore.csproj -o ../bin/v3
"$NCCS_BIN" ./MockTransferTarget.csproj -o ../bin/v3
"$NCCS_BIN" ./PlatformRegistrarMock.csproj -o ../bin/v3
"$NCCS_BIN" ./MarkerOnlyModule.csproj -o ../bin/v3
"$NCCS_BIN" ./WrongLifecycleAbiModule.csproj -o ../bin/v3
"$NCCS_BIN" ./WrongHookLifecycleAbiModule.csproj -o ../bin/v3
"$NCCS_BIN" ./PolicyExecutionProbe.csproj -o ../bin/v3
popd >/dev/null

echo "Compiling Market Contracts..."
pushd market >/dev/null
"$NCCS_BIN" ./AAAddressMarket.csproj -o ../bin/v3
popd >/dev/null

echo "Compiling Recovery Contracts..."
pushd recovery >/dev/null
"$NCCS_BIN" ./MorpheusSocialRecoveryVerifier.csproj -o ../bin/v3
popd >/dev/null

echo "Compiling the private PLATFORM core into its separate artifact directory..."
bash "$ROOT_DIR/contracts/compile.sh" --platform

echo "Compilation completed successfully."

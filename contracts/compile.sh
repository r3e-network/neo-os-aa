#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/contracts"
source "$ROOT_DIR/scripts/dotnet_env.sh"

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

# Test-support mocks. The contract test suite deploys all six from bin/v3
# (MockTransferTarget in the execution/market/escrow suites, PlatformRegistrarMock
# in the platform-registrar suite, MockVerifierCore in the verifier suites, and
# MarkerOnlyModule, WrongLifecycleAbiModule and WrongHookLifecycleAbiModule in
# the lifecycle-ABI negative suite), so they
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
popd >/dev/null

echo "Compiling Market Contracts..."
pushd market >/dev/null
"$NCCS_BIN" ./AAAddressMarket.csproj -o ../bin/v3
popd >/dev/null

echo "Compiling Recovery Contracts..."
pushd recovery >/dev/null
"$NCCS_BIN" ./MorpheusSocialRecoveryVerifier.csproj -o ../bin/v3
popd >/dev/null

echo "Compilation completed successfully."

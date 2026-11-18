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

# Every module embeds the canonical bytes of its <Name>.profile.json literal, and the
# core binds an instance to the SHA-256 of exactly those bytes (spec §12). Refuse to
# compile a tree whose profiles and literals have drifted apart.
echo "Checking module profiles..."
node "$ROOT_DIR/scripts/sync-module-profiles.mjs" --check

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

# Artifacts are addressed by name, so a directory left over from an earlier layout
# would let a gate read bytes this run never produced (for example a renamed
# module or the retired bin/public/verifiers tree). Rebuild the public tree empty.
echo "Cleaning stale public artifacts..."
rm -rf "$ROOT_DIR/contracts/bin/public"
mkdir -p "$ROOT_DIR/contracts/bin/public"

# Every project writes into contracts/bin/public whatever directory it lives in, so the artifact
# layout the tests, the SDK and the deploy scripts read does not follow the source layout.
# nccs compiles every project in the directory of the project it is given, so one
# invocation per directory produces that directory's whole artifact set.
echo "Compiling SmartAccount v4 Core..."
pushd custom >/dev/null
"$NCCS_BIN" SmartAccount.csproj -o ../bin/public
popd >/dev/null

echo "Compiling Validators..."
pushd plugins/validators >/dev/null
"$NCCS_BIN" ./P256Validator.csproj -o ../../bin/public/validators
popd >/dev/null

echo "Compiling Hooks..."
pushd plugins/hooks >/dev/null
"$NCCS_BIN" ./DailyLimitHook.csproj -o ../../bin/public/hooks
popd >/dev/null

# Recovery ships one validator (the action-session authorization) and one service
# contract (the social-recovery state machine); both build into bin/public.
echo "Compiling Recovery Contracts..."
pushd plugins/recovery >/dev/null
"$NCCS_BIN" ./ActionSessionValidator.csproj -o ../../bin/public
popd >/dev/null

# Test-support mocks. The contract test suite deploys all six from bin/public
# (MockTransferTarget in the execution/market/escrow suites, MockVerifierCore as the
# protocol v4 core stub in the module suites, and MarkerOnlyModule,
# WrongLifecycleAbiModule and WrongHookLifecycleAbiModule in the callback-ABI
# negative suite, plus PolicyExecutionProbe as the adversarial token), so they are
# always compiled: a clean checkout that skipped them could not run `dotnet test`.
# bin/public is gitignored and the deploy scripts select artifacts by name, so the
# mocks never reach a network. INCLUDE_VALIDATION_MOCKS is accepted for
# compatibility with older runbooks but no longer changes the output.
# The mock sources live with the tests (tests/mocks), not under contracts/.
echo "Compiling test-support mocks..."
pushd "$ROOT_DIR/tests/mocks" >/dev/null
"$NCCS_BIN" ./MockVerifierCore.csproj -o ../../contracts/bin/public
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

echo "Compiling the private PLATFORM core into its separate artifact directory..."
bash "$ROOT_DIR/contracts/compile.sh" --platform

echo "Compilation completed successfully."

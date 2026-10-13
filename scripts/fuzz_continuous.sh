#!/usr/bin/env bash
# Continuous source-invariant runner — cycles through random seeds at high iteration counts.
# Usage: ./scripts/fuzz_continuous.sh [HOURS]   (default: 4)
# Exit codes: 0 = sweep completed, 1 = invariant counterexample, 2 = environment
# not ready (missing compiled contract artifacts; no counterexample was found).
set -euo pipefail

HOURS="${1:-4}"
ITERATIONS="${SOURCE_INVARIANT_ITERATIONS:-${FUZZ_ITERATIONS:-50000}}"
END_TIME=$(( $(date +%s) + HOURS * 3600 ))
PASS=0
TOTAL_ITERATIONS=0
START=$(date +%s)
SLN="$(cd "$(dirname "$0")/.." && pwd)/neo-abstract-account.sln"
FILTER="FullyQualifiedName~SourceInvariant_"

# The SourceInvariant_ suite deploys the compiled contracts from contracts/bin/v3,
# which only contracts/compile.sh (nccs) produces — `dotnet build` alone does not.
# A missing artifact would surface inside dotnet test as a Directory/FileNotFound
# failure and read as an invariant counterexample, so fail fast here instead.
CONTRACTS_BIN="$(cd "$(dirname "$0")/.." && pwd)/contracts/bin/v3"
REQUIRED_ARTIFACTS=(
  "UnifiedSmartWalletV3.nef"
  "UnifiedSmartWalletV3.manifest.json"
  "MockTransferTarget.nef"
  "MockTransferTarget.manifest.json"
)
MISSING=0
for artifact in "${REQUIRED_ARTIFACTS[@]}"; do
  if [[ ! -f "$CONTRACTS_BIN/$artifact" ]]; then
    echo "environment not ready: missing compiled contract artifact: contracts/bin/v3/$artifact" >&2
    MISSING=1
  fi
done
if [[ "$MISSING" -ne 0 ]]; then
  echo "environment not ready: the SourceInvariant suite deploys UnifiedSmartWalletV3 and" >&2
  echo "environment not ready: MockTransferTarget from contracts/bin/v3 before it can run." >&2
  echo "environment not ready: build the artifacts with:" >&2
  echo "environment not ready:   dotnet build contracts/UnifiedSmartWallet.csproj -c Release -nologo" >&2
  echo "environment not ready:   bash contracts/compile.sh" >&2
  echo "environment not ready: (or run ./scripts/verify_repo.sh). Exiting 2; no invariant counterexample was found." >&2
  exit 2
fi

echo "=== Continuous Source-Invariant Sweep: ${HOURS}h, ${ITERATIONS} iterations/seed ==="
echo "    Solution: ${SLN}"
echo "    Start:    $(date -Iseconds)"
echo "    End:      $(date -Iseconds -d "+${HOURS} hours" 2>/dev/null || date -v+${HOURS}H -Iseconds 2>/dev/null || echo "~${HOURS}h from now")"
echo ""

echo "Building once before the sweep..."
dotnet build "$SLN" --nologo
echo ""

while [ "$(date +%s)" -lt "$END_TIME" ]; do
  SEED=$RANDOM
  ELAPSED=$(( $(date +%s) - START ))
  REMAINING=$(( END_TIME - $(date +%s) ))
  printf "[%02d:%02d:%02d] seed=%-6d pass=%-4d iters_per_test=%-10d remaining=%-8ds ... " \
    $((ELAPSED/3600)) $((ELAPSED%3600/60)) $((ELAPSED%60)) \
    "$SEED" "$PASS" "$TOTAL_ITERATIONS" "$REMAINING"

  if SOURCE_INVARIANT_SEED="$SEED" SOURCE_INVARIANT_ITERATIONS="$ITERATIONS" \
     dotnet test "$SLN" --nologo --no-build --filter "$FILTER" -q >/dev/null 2>&1; then
    PASS=$((PASS + 1))
    TOTAL_ITERATIONS=$((TOTAL_ITERATIONS + ITERATIONS))
    echo "PASS"
  else
    echo "FAIL  <-- seed=$SEED"
    echo ""
    echo "!!! FAILURE DETECTED — re-running with verbose output:"
    SOURCE_INVARIANT_SEED="$SEED" SOURCE_INVARIANT_ITERATIONS="$ITERATIONS" \
      dotnet test "$SLN" --nologo --no-build --filter "$FILTER" -v normal 2>&1 || true
    echo ""
    echo "Failed seed: $SEED  (after $PASS passes, $TOTAL_ITERATIONS iterations per test)"
    exit 1
  fi
done

ELAPSED=$(( $(date +%s) - START ))
echo ""
echo "=== Continuous Source-Invariant Sweep Complete ==="
echo "    Duration:    $(printf '%02d:%02d:%02d' $((ELAPSED/3600)) $((ELAPSED%3600/60)) $((ELAPSED%60)))"
echo "    Seeds tried: $PASS"
echo "    Iterations:  $TOTAL_ITERATIONS per invariant test"
echo "    Result:      ALL PASSED"

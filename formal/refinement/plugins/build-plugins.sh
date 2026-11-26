#!/usr/bin/env bash
# Rebuild the plugin artifacts the plugin scenario deploys, with the pinned compiler.
#
# Why this exists as a script and not as a claim: AssertV3Verifier and AssertV3Hook
# read a deployed contract's manifest, so the admission check is a statement about
# bytes. Those bytes are pinned by hash in plugins/provenance.json, and this script is
# the recorded step that produced them from the sources - the same standing
# contracts/bin/public has for the main contract, and no stronger. The gate reads the
# hashes; it does not re-run this.
#
# Usage:  formal/refinement/plugins/build-plugins.sh [output-directory]
#         default output-directory is a temporary directory, so the committed
#         artifacts are never overwritten by accident. To refresh them in place:
#             formal/refinement/plugins/build-plugins.sh formal/refinement/plugins
#
# Exits non-zero if any produced artifact's sha256 differs from the one recorded in
# provenance.json, which is what makes the file a check rather than a description.
#
# Historical record (seen 2026-11-24): no current gate or workflow runs this script.
# contracts/plugins/verifiers was renamed contracts/plugins/validators and carries no
# MultiSigVerifier project any more, so the first build target cannot be rebuilt from
# the current tree. provenance.json and the committed NEF bytes stay as the record
# of what was built; see formal/refinement/README.md.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
if [[ ! -f "$REPO/contracts/plugins/verifiers/MultiSigVerifier.csproj" ]]; then
  echo "build-plugins.sh: cannot replay - $REPO/contracts/plugins/verifiers/MultiSigVerifier.csproj no longer exists (the directory is now contracts/plugins/validators, which has no MultiSigVerifier project). The pinned bytes in plugins/provenance.json are a historical record." >&2
  exit 1
fi
OUT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/sa-plugins.XXXXXX")}"
NCCS_VERSION="3.9.1+5fa9566e5165ede2165a9be1f4a0120c17602697"

# the retired contracts/compile.sh resolved this and refused to run without it.
# shellcheck source=/dev/null
source "$REPO/scripts/dotnet_env.sh"

observed="$("$NCCS_BIN" --version)"
if [[ "$observed" != "$NCCS_VERSION" ]]; then
  echo "Refusing to build: the pinned compiler is $NCCS_VERSION, this machine has $observed." >&2
  echo "The NEF header names the compiler and its code generation decides the bytes," >&2
  echo "so an artifact built by anything else is not the artifact the receipt pins." >&2
  exit 1
fi

mkdir -p "$OUT"
build() {
  local dir="$1" project="$2" prefix="$3"
  ( cd "$REPO/$dir" && "$NCCS_BIN" "./$project.csproj" -o "$OUT" ) >/dev/null
  echo "  $prefix"
}

echo "Building plugin artifacts with nccs $observed -> $OUT"
build contracts/plugins/verifiers MultiSigVerifier     MultiSigVerifier
build contracts/plugins/hooks     NeoDIDCredentialHook NeoDIDCredentialHook
build contracts/plugins/hooks     MultiHook            MultiHook
# The registrar/market/paymaster caller-side contracts were retired with the
# custom user-contract kernel (native-only consolidation), so this directory
# pins plugin bytecode only. The message-envelope vector's caller stub is still
# built here because the native fixture deploys it as its forwarder.
build tests/mocks                MockVerifierCore    MockVerifierCore

# Compare against the recorded hashes. python3 is used rather than shasum so the
# comparison is byte-for-byte on binary files without depending on the coreutils
# build's idea of line endings.
python3 - "$HERE/provenance.json" "$OUT" <<'PY'
import hashlib, json, pathlib, sys

provenance_path, out_dir = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
recorded = json.loads(provenance_path.read_text())
failures = []
for plugin in recorded['plugins']:
    for kind in ('nef', 'manifest'):
        name = plugin['artifacts'][kind]['file']
        produced = out_dir / name
        if not produced.is_file():
            failures.append(f"{plugin['name']}: {name} was not produced")
            continue
        digest = hashlib.sha256(produced.read_bytes()).hexdigest()
        if digest != plugin['artifacts'][kind]['sha256']:
            failures.append(f"{plugin['name']}: {name} is {digest[:16]}, "
                            f"recorded {plugin['artifacts'][kind]['sha256'][:16]}")
if failures:
    print('The rebuild does not match what provenance.json records:', file=sys.stderr)
    for line in failures:
        print('  ' + line, file=sys.stderr)
    raise SystemExit(1)
print(f"  {len(recorded['plugins'])} plugins, "
      f"{2 * len(recorded['plugins'])} artifacts, all hashes match provenance.json")
PY

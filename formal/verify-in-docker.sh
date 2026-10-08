#!/usr/bin/env bash
# Runs the AA formal gate inside the pinned environment described by
# formal/Dockerfile, so a reviewer without Rocq/Coq, Z3, a JDK or the TLA+ tools
# on the host gets the same fail-closed result the maintainers get. The image
# build itself fails closed: a TLA+ jar whose SHA-256 differs from the pin is
# rejected. Results land under formal/.runs/docker (gitignored).
#
# Usage: formal/verify-in-docker.sh [extra verify.py arguments]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${AA_FORMAL_IMAGE:-neo-os-aa-formal:local}"

build_args=()
# Docker Desktop/Colima may inject a stale localhost proxy from the user's
# Docker config. Allow the caller to provide the host-reachable proxy without
# changing the pinned image or silently falling back to an unverified toolchain.
if [[ -n "${AA_FORMAL_HTTP_PROXY:-}" ]]; then
  build_args+=(--build-arg "HTTP_PROXY=$AA_FORMAL_HTTP_PROXY"
               --build-arg "http_proxy=$AA_FORMAL_HTTP_PROXY")
fi
if [[ -n "${AA_FORMAL_HTTPS_PROXY:-${AA_FORMAL_HTTP_PROXY:-}}" ]]; then
  build_args+=(--build-arg "HTTPS_PROXY=${AA_FORMAL_HTTPS_PROXY:-$AA_FORMAL_HTTP_PROXY}"
               --build-arg "https_proxy=${AA_FORMAL_HTTPS_PROXY:-$AA_FORMAL_HTTP_PROXY}")
fi
if [[ -n "${AA_FORMAL_NO_PROXY:-}" ]]; then
  build_args+=(--build-arg "NO_PROXY=$AA_FORMAL_NO_PROXY"
               --build-arg "no_proxy=$AA_FORMAL_NO_PROXY")
fi

if [[ -z "${NEOOS_NATIVE_CORE_SOURCE:-}" || ! -d "$NEOOS_NATIVE_CORE_SOURCE" ]]; then
  echo "Set NEOOS_NATIVE_CORE_SOURCE to the reviewed native core checkout" >&2
  exit 1
fi
native_core_root="$(cd "$NEOOS_NATIVE_CORE_SOURCE" && pwd)"

docker build "${build_args[@]}" -f "$ROOT_DIR/formal/Dockerfile" -t "$IMAGE" "$ROOT_DIR/formal"
mkdir -p "$ROOT_DIR/formal/.runs/docker"

echo "formal gate (docker): running formal/verify.py in $IMAGE"
docker run --rm -v "$ROOT_DIR:/work" -v "$native_core_root:/native-core:ro" \
  -w /work -e HOME=/tmp -e NEOOS_NATIVE_CORE_SOURCE=/native-core "$IMAGE" \
  --output formal/.runs/docker "$@"

echo "formal gate (docker): running the runner's own regression tests"
docker run --rm -v "$ROOT_DIR:/work" -w /work -e HOME=/tmp --entrypoint python3 "$IMAGE" \
  -m unittest discover -s formal -p 'test_*.py'

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

docker build -f "$ROOT_DIR/formal/Dockerfile" -t "$IMAGE" "$ROOT_DIR/formal"
mkdir -p "$ROOT_DIR/formal/.runs/docker"

echo "formal gate (docker): running formal/verify.py in $IMAGE"
docker run --rm -v "$ROOT_DIR:/work" -w /work -e HOME=/tmp "$IMAGE" \
  --output formal/.runs/docker "$@"

echo "formal gate (docker): running the runner's own regression tests"
docker run --rm -v "$ROOT_DIR:/work" -w /work -e HOME=/tmp --entrypoint python3 "$IMAGE" \
  -m unittest discover -s formal -p 'test_*.py'

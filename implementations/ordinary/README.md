# Ordinary user-contract implementation

This directory is the stable entrypoint for the implementation that NeoOS can
use on the published Neo N3 runtime. The source remains in the repository's
existing build-compatible locations; [`profile.json`](profile.json) records the
canonical roots, excluded native roots, artifacts and verification commands.

Use this path for ordinary `UnifiedSmartWalletV3` contracts, their verifier and
hook modules, the ordinary frontend workspace, and the V3 SDK. Its gates are
selected with `./scripts/verify_repo.sh --profile ordinary`.

The ordinary profile is a user-contract implementation. It must not be
labelled as native AccountManagement or used as evidence of native consensus
activation.

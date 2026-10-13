# Ordinary user-contract implementation

This directory is the stable entrypoint for the implementation that NeoOS can
use on the published Neo N3 runtime. The source remains in the repository's
existing build-compatible locations; [`profile.json`](profile.json) records the
canonical roots, excluded native roots, artifacts and verification commands.

Use this path for ordinary `UnifiedSmartWalletV3` contracts, their verifier and
hook modules, the ordinary frontend workspace, and the ordinary `AbstractAccountClient` SDK. Its gates are
selected with `./scripts/verify_repo.sh --profile ordinary`.

The profile is `public-artifact-identity-verified-upgrade-required`: the tracked
`contracts/build` pair
matches the mainnet readback recorded in
[`mainnet-unified-smart-wallet-upgrade-20260915-evidence.json`](../../docs/reports/mainnet-unified-smart-wallet-upgrade-20260915-evidence.json)
through two independent RPC nodes. This verifies the historical artifact identity; it does not certify the public
artifact against the newly discovered reimbursement and recovery issues. `contracts/bin/v3` is the current source candidate;
its ABI additions require a new artifact review and governed upgrade before
they can be called public deployment evidence.

The ordinary profile is a user-contract implementation. It must not be
labelled as native AccountManagement or used as evidence of native consensus
activation.

The ordinary protocol status is `source-checks-passed-conformance-open`: its
operation encoding, nonce domain, lifecycle, callback ordering and rollback
rules have source and runtime checks, while full protocol conformance remains open. The profile keeps the
public callback-resource, candidate-upgrade and deployment-readback boundaries
explicit so an implementation reader can distinguish protocol correctness from
release evidence.

The 100-entry source candidate also reserves sponsored reimbursement against a
shared per-transaction core budget and provides callback-free permanent
owner-only recovery. Recovery keeps identity and nonce history but irreversibly
disables plugin installation. The pinned 90-entry public artifact does not gain
these capabilities until its governed upgrade and independent readback complete.

The current source candidate passes the declared contract, SDK, frontend and
formal-model gates. The [dated acceptance report](../../docs/reports/aa-ordinary-acceptance-20261013.md)
binds the exact candidate, private-chain module scope and remaining integration
and deployment boundaries. The package entrypoint is `sdk/js/src/index.js`;
`src/v3` alone is not the complete ordinary client.

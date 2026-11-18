# Custom user-contract implementation

This directory holds the implementation that NeoOS can use on the published
Neo N3 runtime: the `SmartAccount` core (`SmartAccount*.cs`,
`SmartAccount.csproj`) and its standalone service contracts in
[`market/`](market/), [`paymaster/`](paymaster/) and [`registrar/`](registrar/).
The verifier, hook and recovery modules it binds are shared with the native
implementation and live in [`../plugins/`](../plugins/).
[`profile.json`](profile.json) records the canonical roots, excluded native
roots, artifacts and verification commands.

Use this profile for custom `SmartAccount` contracts, their verifier and
hook modules, the custom frontend workspace, and the custom `SmartAccountClient` SDK. Its gates are
selected with `./scripts/verify_repo.sh --profile custom`.

The profile is `public-artifact-identity-verified-upgrade-required`: the tracked
`contracts/build` pair
matches the mainnet readback recorded in
[`mainnet-smart-account-upgrade-20260915-evidence.json`](../../docs/reports/mainnet-smart-account-upgrade-20260915-evidence.json)
through two independent RPC nodes. This verifies the historical artifact identity; it does not certify the public
artifact against the newly discovered reimbursement and recovery issues. `contracts/bin/public` is the current source candidate;
its ABI additions require a new artifact review and governed upgrade before
they can be called public deployment evidence.

The custom profile is a user-contract implementation. It must not be
labelled as native SmartAccount or used as evidence of native consensus
activation.

The custom protocol status is `source-checks-passed-conformance-open`: its
operation encoding, nonce domain, lifecycle, callback ordering and rollback
rules have source and runtime checks, while full protocol conformance remains open. The profile keeps the
public callback-resource, candidate-upgrade and deployment-readback boundaries
explicit so an implementation reader can distinguish protocol correctness from
release evidence.

The 108-entry source candidate also reserves sponsored reimbursement against a
shared per-transaction core budget, provides callback-free permanent owner-only
recovery, adds the backup-owner-gated freeze surface, and moves its platform services
(market escrow settlement, paymaster settlement, platform registrar) into
standalone contracts behind the pending governed upgrade. Recovery keeps
identity and nonce history but irreversibly disables plugin installation. The
pinned 90-entry public artifact does not gain these capabilities until its
governed upgrade and independent readback complete.

The current source candidate passes the declared contract, SDK, frontend and
formal-model gates. The [dated candidate-compatibility receipt](../../docs/reports/sa-ordinary-candidate-compatibility-20261116.json)
records the candidate artifact against the 90-entry pinned public artifact; the
2026-10-13 acceptance report the status was first recorded against is not part of
this checkout. Registrar deployment compatibility and native conformance remain
separate open boundaries. The package entrypoint is `sdk/js/src/index.js`;
`src/custom` alone is not the complete custom client.

The [implementation refinement gate](../../docs/SA-IMPLEMENTATION-REFINEMENT.md)
binds typed C# source to the exact candidate NEF and checks a universal arithmetic
region certificate with Coq. Complete C# to NEF to NeoVM refinement remains open;
the default command returns exit `2` while any public entrypoint is unproved.
The separate `--allow-partial` mode is only for developing the region proof.

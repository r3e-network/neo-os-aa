# Native SmartAccount implementation

This directory is the stable entrypoint for the native SmartAccount ABI 2
profile prepared for standard submission. The profile, native modules, SDK and
UI remain in their existing build-compatible locations; [`profile.json`](profile.json)
records the canonical roots and the native-only verification commands.

The native consensus `SmartAccount` service itself belongs to the matching
Neo core repository. This repository can validate the profile, modules, client,
fixtures and test-only VM probes, but it cannot claim hardfork activation,
node admission, formal refinement or public-network acceptance from those local
checks. The native track is currently draft/unactivated and keeps
`implementationVerified: false` until the open gates listed in `profile.json`
are independently closed.

The local candidate now checks current and pending native-proxy authorities and
requires consent for newly introduced nonzero authority addresses. The revised
parameter fingerprint binds that policy. This closes the source-level omission;
current-digest runtime/module builds and deployed-byte readback remain separate
evidence gates, as do formal refinement and public activation.

Historical evidence for earlier draft revisions is recorded in
[`aa-native-protocol-review-20261009.json`](../../docs/reports/aa-native-protocol-review-20261009.json)
and [`aa-native-open-boundaries-20261008.json`](../../docs/reports/aa-native-open-boundaries-20261008.json).
Those receipts retain their original source and digest identities; they do not
validate the current revision.

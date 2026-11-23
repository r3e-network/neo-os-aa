# Native SmartAccount implementation

This directory holds the native SmartAccount v4 implementation. ABI 2 is an earlier
external proposal. The native builds of the shared plugins live in
[`../plugins/native-profile/`](../plugins/native-profile/), and the native SDK
and UI stay with the rest of the client code; [`profile.json`](profile.json)
records the canonical roots and the native-only verification commands.

The only editable source of the native consensus `SmartAccount` contract
lives here, in [`SmartAccount/`](SmartAccount/); the matching Neo core
checkout carries generated copies that
[`scripts/sync_native_smartaccount.py`](../../scripts/sync_native_smartaccount.py)
rewrites from it, and the native CI lane fails on sync drift against the
SHA-pinned core. Native VM enforcement itself still belongs to the Neo core
repository. This repository can validate the profile, modules, client,
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
[`sa-native-protocol-review-20261009.json`](../../docs/reports/sa-native-protocol-review-20261009.json)
and [`sa-native-open-boundaries-20261008.json`](../../docs/reports/sa-native-open-boundaries-20261008.json).
Those receipts retain their original source and digest identities; they do not
validate the current revision.

## Neo core checkout location

The overlay core project ([`Neo.csproj`](Neo.csproj)) and the native
test project
([`tests/SmartAccount.Native.Tests/SmartAccount.Tests.csproj`](../../tests/SmartAccount.Native.Tests/SmartAccount.Tests.csproj))
compile the pinned Neo core from a checkout outside this repository. By default
that checkout is a directory named `neo-native-core` next to this repository's
root, and three MSBuild properties point into it:

- `NeoSourceRoot`, read by both projects: `../neo-native-core/src`
- `NeoCoreRoot`, read by the core project: `../neo-native-core/src/Neo`
- `NeoTestsRoot`, read by the test project: `../neo-native-core/tests/Neo.UnitTests`

The paths are written relative to this repository's root. Each default applies
only while its property is empty, so for any other layout pass the property on
the command line or export an environment variable of the same name. From the
repository root:

```bash
dotnet test tests/SmartAccount.Native.Tests/SmartAccount.Tests.csproj \
  -p:NeoSourceRoot=/path/to/neo/src \
  -p:NeoCoreRoot=/path/to/neo/src/Neo \
  -p:NeoTestsRoot=/path/to/neo/tests/Neo.UnitTests
```

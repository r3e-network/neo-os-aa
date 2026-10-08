# Private Neo platform packages (R-11 / N-DEP-1)

## Current private-runtime revalidation (2026-10-06)

The installed public `neoxp` runner remains incompatible with the SmartAccount
artifact: a fresh run faults when the VM resolves the
`System.Contract.CallWithGasLimit` interop hash. This is a runner/runtime
mismatch, not evidence that the callback cap is optional, and the failed receipt
is retained separately from release evidence at
`docs/reports/aa-neoexpress-validation-20261006-v2.json`.

An independent local NeoExpress build linked to the matching private Neo runtime
packages was then run against the current artifacts. It deployed 25 contracts,
completed all 14 scenarios with no skipped scenario, persisted 108 transactions,
and read back all 25 NEF/manifest pairs. The release-eligible receipt is
`docs/reports/aa-neoexpress-validation-20261006-custom-did.json`; runner source,
package hashes, and the temporary API-adapter boundary are recorded in
`docs/reports/aa-neoexpress-runner-provenance-20261006.json`.

This closes the private NeoExpress execution/readback evidence for the matching
runtime. It does not alter the separate owner action for making the private
packages reproducibly available to clean CI, and it does not establish public
network activation or deployment parity.

Status on 2026-09-28: **known red, owner action required.** A clean CI runner cannot restore
the packages that `contracts/Directory.Build.props` pins, so the contract build, the contract
tests and the deploy-tool tests do not run in CI. The `Check pinned Neo platform packages`
step in `.github/workflows/ci.yml` (and the first contract gate in `scripts/verify_repo.sh`)
runs `scripts/check_neo_platform_packages.mjs`, which stops within seconds with the owner
action below instead of a bare `NU1102` from deep inside the build.

## What fails

`contracts/Directory.Build.props` pins `Neo.SmartContract.Framework` `3.10.2-CI00384`, and
`tests/AbstractAccount.Contracts.Tests` pins `Neo.SmartContract.Testing` at the same version.
On a clean NuGet cache (`dotnet nuget locals all --clear` in an isolated `NUGET_PACKAGES`):

```
error NU1102: Unable to find package Neo.SmartContract.Framework with version (>= 3.10.2-CI00384)
error NU1102:   - Found 35 version(s) in nuget.org [ Nearest version: 3.10.1 ]
error NU1102: Unable to find package Neo.SmartContract.Testing with version (>= 3.10.2-CI00384)
error NU1102:   - Found 6 version(s) in nuget.org [ Nearest version: 3.10.1 ]
```

Local builds only pass on machines whose global NuGet cache already holds the packages.

## Why repinning to a public release does not work

The framework build adds exactly one API that public releases lack:
`Contract.CallWithGasLimit(UInt160, string, CallFlags, long, params object[])`, declared as
`[Syscall("System.Contract.CallWithGasLimit")]`. The other source differences from 3.10.1 are
documentation, the `AccessControl`/`Ownable2Step` helpers and an `Nep11Token.Burn` message,
none of which any contract here uses. `UnifiedSmartWallet.Execution.cs` calls the new API
twice to cap every verifier callback at 10 GAS (the VULN-001 mitigation).

Clean-cache builds of `contracts/UnifiedSmartWallet.csproj` at `c66be10` with every recent
public framework:

| Framework | Result |
| --- | --- |
| 3.10.1 (newest on nuget.org) | `CS0117: 'Contract' does not contain a definition for 'CallWithGasLimit'` at `UnifiedSmartWallet.Execution.cs(64,51)` and `(136,34)` |
| 3.10.0 | same two `CS0117` errors |
| 3.9.1 | same two `CS0117` errors |

The contract tests also need a TestEngine whose Neo core registers the syscall. The private
`Neo` 3.10.1.1 core registers `System.Contract.CallWithGasLimit`; the public `Neo` 3.10.1
does not. Running the suite on the public `Neo.SmartContract.Testing` 3.10.1 against
artifacts compiled with the private framework passes 287, skips 2 and fails 4 of 293: every
test that drives a verifier callback throws `KeyNotFoundException` for key `1371299780`,
the interop hash of `System.Contract.CallWithGasLimit`. The four are the session-key
acceptance and tampered-signature rejection tests, the recovery-verifier context test and the
active-escape test. Repinning would therefore mean deleting the gas cap, which is a security
regression, not a fix.

Among the contracts, only the AA core needs the private framework. With the same compiler
(public `nccs` 3.9.1, which CI installs and which emits the syscall), the other 23 contracts
produce byte-identical NEFs and manifests under public 3.10.1 and under the private build: all
9 verifiers, 5 hooks, 6 test mocks, `AAAddressMarket`, `MorpheusSocialRecoveryVerifier` and
`AAPaymaster`.

## What is deployed

The deployed AA cores do not depend on these packages. Public JSON-RPC reads on 2026-09-28:

| Network | AA core | NEF checksum | Compiler | `CallWithGasLimit` syscall |
| --- | --- | --- | --- | --- |
| MainNet | `0x0268a387913b250166ddec032b03332690a1ef78` | 2035992441 | Neo.Compiler.CSharp 3.9.1 | absent |
| TestNet | `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2` | 2785794149 | Neo.Compiler.CSharp 3.9.1 | absent |

The MainNet core is reproducible from public packages: compiling commit `4149496` (the source
before the gas cap) with the public framework 3.9.1 and `nccs` 3.9.1 from a clean cache gives
`UnifiedSmartWalletV3.nef` with checksum 2035992441, byte-identical to the chain and to
`contracts/build/UnifiedSmartWalletV3.nef`.

The current source cannot run on a public network whatever the feed decision: no released Neo
core registers `System.Contract.CallWithGasLimit`, so the core's verifier path would fault there
exactly as it does on the public TestEngine. That platform activation is a separate decision;
this document only covers restoring the build.

## The packages

`contracts/neo-platform-packages.json` records the audited bytes. `Neo.VM` is an upstream
nightly on the Neo MyGet feed (byte-identical); the other seven exist on no public feed.

| Package | Version | SHA-256 of the `.nupkg` | Needed by |
| --- | --- | --- | --- |
| Neo.SmartContract.Framework | 3.10.2-CI00384 | `172597b180f6ae9d93c1901bec11d8f2ce76b46c465a2dd3552ae876e5421d65` | every contract project |
| Neo.SmartContract.Testing | 3.10.2-CI00384 | `92a06b27548c10da98c54043ff4dfd5eaf6c1b74df4fc707b6e7cc67c7b9ce6a` | contract tests |
| Neo.Disassembler.CSharp | 3.10.2-CI00384 | `9ee27bb5b372bba07ef0872ca22ab4700be0c3dc87deb5cbc1ada9a895901f21` | Neo.SmartContract.Testing |
| Neo | 3.10.1.1 | `4218a38a767d8c9c0d8bfbd6cc91c9bd13f9d298c816dd72366a3f3735960d49` | Testing, Disassembler |
| Neo.Extensions | 3.10.1.1 | `93e296fe0773db0ddaeb4f0a9d9174555f65ae17560497e72e8f4a692ffe500d` | Neo |
| Neo.IO | 3.10.1.1 | `b1bba7f6aad5275f05ac13f4356c56caaac5866318ef87b30cd14d8ed3a2dcf7` | Neo |
| Neo.Json | 3.10.1.1 | `0275990e41fe6fb6163183ceb5b151a62a16219294852569d1b85a8ef7f4fa63` | Neo |
| Neo.VM | 3.10.2-CI00384 | `84bd08d291362cfaf85697f0fb14666719d3443f2f71c39c8de1b9184c20820e` | Neo |

The framework and testing hashes equal the ones recorded in
`docs/reports/aa-platform-gas-cap-20260921.json`.

Provenance risk: the nuspecs name `neo-project/neo-devpack-dotnet@34255c4` and
`neo-project/neo@8461a72`, but neither commit contains `CallWithGasLimit`. The gas-cap changes
were applied on top without being committed; the local `aa/verifier-gas-cap` branches point at
the unmodified base commits and the temporary feed the packages were restored from is empty.
The only known copies of the seven private packages are the `.nupkg` files inside the global
NuGet packages folder (`~/.nuget/packages`) of the machine that ran the 2026-09-21
private-chain validation. Clearing that cache without a backup loses them.

## Owner action

1. **Preserve the packages now.** Copy the eight `.nupkg` files from that machine's global
   packages folder to durable storage and check each SHA-256 against the table. Do not run
   `dotnet nuget locals all --clear` there before this is done. Commit the Neo core and
   DevPack gas-cap changes to branches so the packages can be rebuilt.
2. **Publish them byte-for-byte to a feed CI can read.** Any NuGet v3 feed works (GitHub
   Packages for the organisation, Azure Artifacts, a MyGet feed). If it needs credentials,
   store them as a repository secret and give the workflow the minimum permission it needs
   (for GitHub Packages, `packages: read`); never put a token in `nuget.config`.
3. **Add `nuget.config` at the repository root**, mapping exactly these ids to that feed so no
   other source can satisfy them:

   ```xml
   <?xml version="1.0" encoding="utf-8"?>
   <configuration>
     <packageSources>
       <clear />
       <add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />
       <add key="neo-platform" value="FEED_URL" />
     </packageSources>
     <packageSourceMapping>
       <packageSource key="nuget.org">
         <package pattern="*" />
       </packageSource>
       <packageSource key="neo-platform">
         <package pattern="Neo" />
         <package pattern="Neo.Extensions" />
         <package pattern="Neo.IO" />
         <package pattern="Neo.Json" />
         <package pattern="Neo.VM" />
         <package pattern="Neo.Disassembler.CSharp" />
         <package pattern="Neo.SmartContract.Framework" />
         <package pattern="Neo.SmartContract.Testing" />
       </packageSource>
     </packageSourceMapping>
   </configuration>
   ```

   With a credentialed feed, add a `packageSourceCredentials` entry whose values reference
   environment variables (`%NEO_PLATFORM_FEED_USER%`, `%NEO_PLATFORM_FEED_TOKEN%`) and set
   those from the secret in `ci.yml`.
4. **Prove it from a clean cache** before merging:

   ```bash
   export NUGET_PACKAGES="$(mktemp -d)" NUGET_HTTP_CACHE_PATH="$(mktemp -d)"
   dotnet nuget locals global-packages --list   # must print the temporary directory
   node scripts/check_neo_platform_packages.mjs
   ./scripts/verify_repo.sh --contracts-only
   ```

   The gate prints `Neo platform packages OK` only when all eight restore with the audited
   SHA-512. The CI step then turns green without further workflow changes.

If the packages are rebuilt instead of republished, their bytes change and the gate refuses
them. Update `contracts/neo-platform-packages.json` in the same reviewed change, and consider
a version that cannot collide with an upstream nightly: `3.10.2-CI00384` follows the upstream
nightly scheme, and a future upstream build with that number would be a different package.
Package source mapping plus the hash check keep such a package out; a distinct version keeps
it out of every other consumer too.

## Verified from a clean cache (2026-09-28)

With the eight packages on a local feed and the `nuget.config` above, starting from an empty
isolated cache: the core builds, `contracts/compile.sh` compiles all artifacts, and
`dotnet test neo-abstract-account.sln -c Release` passes 291, skips 2, fails 0 (293 total).
Without the feed the gate fails with the owner action above, and a feed that serves a modified
`Neo.Json` 3.10.1.1 under the same version is refused with the SHA-512 mismatch.

## Why not vendor or skip

- Checking the packages into this repository is a feed decision made without review, and an
  artifact built from them still cannot be deployed to a public node.
- Skipping the contract gates in CI would hide the paymaster, session-key and social-recovery
  behaviour that only the contract tests exercise.

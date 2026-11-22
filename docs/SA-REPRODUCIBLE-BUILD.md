# SA contracts: reproducible build from published packages

Package baseline established on 2026-10-04 (audit finding R-11 / N-DEP-1, program item P1-C-AAV4-BUILD). Every package the SA
contracts and their tests restore is published on nuget.org, and the toolchain is pinned so that a second
builder gets the same NEF and manifest bytes.

## What is pinned

| What | Pin | Where |
| --- | --- | --- |
| `Neo.SmartContract.Framework`, `Neo.SmartContract.Testing` | 3.10.1 | `Directory.Build.props` (`NeoSmartContractFrameworkVersion`) |
| the Neo packages they pull in | `Neo`, `Neo.Extensions`, `Neo.IO`, `Neo.Json`, `Neo.VM`, `Neo.Disassembler.CSharp` 3.10.1; `Neo.Cryptography.BLS12_381` 3.9.0 | `contracts/neo-platform-packages.json` (SHA-512 of each package) |
| every other package (MSTest, Akka, ...) | resolved version and content hash | committed locks for every in-scope project; the scope is the native inventory (six native modules, two test-only epoch-probe projects and two runtime probe hosts with empty NuGet dependency locks) |
| package source | nuget.org only, every package id mapped to it | `nuget.config` |
| compiler | `Neo.Compiler.CSharp` 3.9.1 (`nccs`) | `.github/workflows/ci.yml`; the installed package is checked against `contracts/neo-platform-packages.json` |
| SDK | .NET 10 (`net10.0`) | `actions/setup-dotnet` in `ci.yml` |

Restore runs in locked mode, for `dotnet` and for the restore that `nccs` runs per project: a resolution
that would change a lock file fails with `NU1004`, and a package whose bytes differ from the lock fails
with `NU1403`.

## Restore, build, test

```bash
dotnet tool install -g neo.compiler.csharp --version 3.9.1
node scripts/check_neo_platform_packages.mjs                  # pins, lock files, locked restore, package hashes
node scripts/check_neo_platform_packages.mjs --compiler-only  # the installed nccs is the pinned package
dotnet build SmartAccount.sln -c Release                      # native-only solution: pinned core, six modules, probes
dotnet test tests/SmartAccount.Native.Tests/SmartAccount.Tests.csproj -c Release
```

`SmartAccount.sln` is the native build entry: it carries the native core overlay
(`contracts/native/Neo.csproj`), the six native-profile modules, the native unit tests
and the probe hosts, and no custom project. Building it needs a reviewed core checkout;
set `NEOOS_NATIVE_CORE_SOURCE` to it (default sibling `../neo-native-core`).

`./scripts/verify_repo.sh --contracts-only` runs the native build and unit-test lane; MSBuild
writes the kernel into each project's `bin/Release/net10.0/`. To prove a clean restore, point
`NUGET_PACKAGES` at an empty directory first.

### Select the validation profile

`./scripts/verify_repo.sh --profile native` is the default and the only
profile. It runs the native
package locks, protocol and runner guards, the native-only solution build and unit
tests, the native module epoch VM regression and native browser coverage, and reads
nothing from the retired custom tree. `--contracts-only`, `--frontend-only` and
`--sdk-only` still select the component to validate. Shared deterministic
frontend/SDK unit tests run either way; they do not require a native node.

Every selected command is mandatory and its failure stops the gate. The native
epoch fixture is module-level VM evidence; the independent
`native-profile.yml` workflow additionally builds the pinned native core and
executes the native VM matrix. Neither command establishes public activation or
full-chain admission.

The main CI workflow also runs the native browser fixture in a separate required
step after installing the frontend dependencies and Playwright. It reuses those
installations and does not repeat the frontend build or full unit suites. This
workflow has no path filter, so native UI, shared code, SDK and frontend test
changes all select the browser gate without needing a native node.

`--formal` explicitly adds the aggregate formal checks and their source-lock
requirements. `--skip-e2e` drops the disposable-chain lane while keeping every
off-chain gate. `NEOOS_NEOXP` (else `NEOXP`, PATH, or the user tool directory)
selects the published NeoExpress runner; no private hardfork is enabled by this
path.

The native lane's own provenance join lives in `scripts/native_epoch_probe.py`
and the `scripts/neoexpress_native_*_validate.py` suites: together they bind the
rebuilt artifact to the current source snapshot, the module NEF hashes,
checksums, full manifests and RPC script readback. This is a measured subset,
not proof of the entire module catalog or public deployment. Native full-chain
validation follows its separate documented runner. Optional selected checks keep
their explicit NOT RUN messages when they are not selected.

## Reproduce

### Native build outputs

The native kernel is the only build target. `dotnet build SmartAccount.sln` compiles the overlay core
(`contracts/native/SmartAccount/`) against the pinned core checkout, and
`scripts/build_native_modules.py` reproduces the six `SMARTACCOUNT_NATIVE` modules in two independent
scratch trees under the locked restore policy and writes them to the `--output` directory its caller
names. `scripts/native_epoch_probe.py` runs those artifacts in the public VM and writes a receipt to its
own `--output`. Neither script has a default directory, and `contracts/bin/native` is not a target.

The retired custom track's `public` and `platform` profiles (`contracts/bin/public`,
`contracts/bin/platform`) are archived artifacts and were never tracked: `bin/` is gitignored, so a
clean checkout has neither. Their `compile.sh` recipe and the user-contract
projects it built were removed when the repository went native-only; the digests recorded for them
below stay as historical receipts, nothing in the tree rebuilds them, and
`scripts/check-artifact-reproducibility.mjs` refuses to replay the deleted recipe. Do not deploy those
artifacts and do not treat their recorded bytes as current native evidence.

For the record, the retired public profile used published `System.Contract.Call` with read-only
validation and write-capable `postCheck` accounting, and it did not bound verifier gas; the retired
private `PLATFORM` profile used `System.Contract.CallWithGasLimit`. Lifecycle ABI admission was never
a verifier trust or resource policy: public relays must still apply their own reviewed module policy,
simulation and finite transaction-fee limits before sponsorship, and unrestricted sponsored admission
remains unsafe. `contracts/build` remains the historical deployed-artifact fixture.

### Public validator release selection

`scripts/deploy_latest_sa_validators.js` selects SessionKeyValidator from
`contracts/bin/public/validators/` and SocialRecoveryService from `contracts/bin/public/`
through the same constrained artifact-path helper as the other public deployment
scripts. It must fail if that reviewed public NEF/manifest pair is absent; it
must never fall back to historical `contracts/build` fixtures or a private/native
profile. The selected manifest must match the expected module name, version and
account-ID ABI. Deployment readback must match the selected NEF script and complete
manifest before the existing authorized-core binding check can succeed.

Rebuild and review the public artifact pair before release. Offline loader tests
exercise path selection and reject missing or mismatched pairs; they neither
broadcast a transaction nor establish public deployment parity.

### Two-build comparison

The two-build replay that produced the certificates below used `contracts/compile.sh`, which was
deleted with the custom track. `scripts/check-artifact-reproducibility.mjs` therefore fails closed
instead of replaying a recipe the repository no longer contains; the recorded digests stay as
historical receipts. The native replacement is `scripts/build_native_modules.py`, which builds the six
`SMARTACCOUNT_NATIVE` modules in two independent scratch trees at different temporary paths and fails
unless every NEF and manifest digest matches:

```bash
python3 scripts/build_native_modules.py --contracts contracts \
  --compiler "$NCCS_BIN" --cache "$NUGET_PACKAGES" \
  --output <new-directory> --receipt <receipt.json>
```

It does not infer runtime compatibility from reproducibility alone. The paragraphs that follow record
the retired custom profile replays and their archived certificates.

The 2026-10-08 replay matched **80/80** files: **78** under `bin/public` and **2** under
`bin/platform`, with no drift or missing artifacts. Exact digests and the profile verdicts
for the native integration source are in
[`sa-native-abi2-public-platform-reproducibility-20261008.json`](reports/sa-native-abi2-public-platform-reproducibility-20261008.json).
The current-source replay on 2026-10-31 again matched **80/80** files with the
same **78 + 2** profile split, no drift and no missing artifacts. Its certificate
is
[`sa-artifact-reproducibility-20261031.json`](reports/sa-artifact-reproducibility-20261031.json);
the private-chain join is
[`sa-private-artifact-provenance-20261031.json`](reports/sa-private-artifact-provenance-20261031.json).
The 2026-11-13 replay of the post-extraction tree (registrar move, market-escrow
and paymaster settlement splits, backup-owner-gated freeze surface) matched again with no
drift and no missing artifacts; its certificate — whose text-input digests are
LF-normalized so a Windows `core.autocrlf` checkout measures the same bytes as
Linux CI — is
[`sa-artifact-reproducibility-20261113.json`](reports/sa-artifact-reproducibility-20261113.json),
and the candidate/public ABI delta it certifies is
[`sa-ordinary-candidate-compatibility-20261113.json`](reports/sa-ordinary-candidate-compatibility-20261113.json).
The 2026-11-16 replay of the design-phase legacy-compat sweep (storage fallbacks,
the one-time rotation migration and the v3 recovery ticket removed; the candidate
ABI is now 109 methods) matched again with no drift and no missing artifacts; its
certificate is
[`sa-artifact-reproducibility-20261116.json`](reports/sa-artifact-reproducibility-20261116.json),
regenerated the same day after the orphaned `tests/mocks/packages.PlatformRegistrarMock.lock.json`
left the tree (132 source inputs; the sweep commit's receipt had been generated one
`SmartAccount.MarketEscrow.cs` revision early, which the regeneration also corrects),
and the candidate/public ABI delta it certifies is
[`sa-ordinary-candidate-compatibility-20261116.json`](reports/sa-ordinary-candidate-compatibility-20261116.json).
The 2026-11-20 replay of the v4 generation and subject-provenance revision (the
22-byte provenance marker beside the 21-byte subject row, custody-derived subject
rotation, and routing-generation resolution inside the core) matched again with no
drift and no missing artifacts: **66** artifacts compared, **64** under
`bin/public` and **2** under `bin/platform`, over **174** source inputs. The six
new mock contract/project/lock triplets under `tests/mocks` (GasBurningHook,
GasBurningValidator, MockDivisibleNep11Token, MockNep11Token, MockNep17Token,
MockNepPaymentReceiver) are inside the inventory by construction, because
`SOURCE_ROOTS` copies `tests/mocks` whole rather than by an explicit file list.
The certificate is
[`sa-artifact-reproducibility-20261120.json`](reports/sa-artifact-reproducibility-20261120.json),
and the two core pairs it certifies are:

| Profile | `SmartAccount.nef` SHA-256 | `SmartAccount.manifest.json` SHA-256 |
| --- | --- | --- |
| `bin/public` | `27e28aa06068d0d9898a6dcf3d703d7561e05e2e12d4a8bd8202ae7abdc654e1` | `f0c6467b05004fdbedc0a9b8f6368ab29a30e84a6b38ece56219a6913282bd23` |
| `bin/platform` | `60f17dfd0a19b40076b0a72577ed29ea6d480e8bbe73b2a37dc207c08a1b4048` | `61900e8a80a8fc8cd3b3fb4698050f53e7dd18ee64da13bc4ab2f1cfc20cd55c` |

The same run's private-chain receipts are
[`sa-custom-source-chain-20261120.json`](reports/sa-custom-source-chain-20261120.json)
(28/28 acceptance checks, nine artifacts deployed from the freshly compiled public
profile) and
[`sa-custom-runtime-provenance-20261120.json`](reports/sa-custom-runtime-provenance-20261120.json)
(that receipt joined to the certificate above, source snapshot `164c58a3…`). They
are evidence for the sources and artifacts they name and not for a public-network
deployment: no chain writes are performed, and `tracked_tree_drift` still lists
`contracts/build` because that tree is deliberately pinned to the deployed mainnet
bytecode. An artifact identity refresh is not an acceptance event — it says what
the current sources build to.
The 2026-11-21 protocol-conformance replay (1-based credential generation, the
core-wide reentrancy exclusion, code-binding continuity after every writable
callback and at commit, and `NefSha256` as `SHA256(NEF)`) matched again with no
drift and no missing artifacts: **66** artifacts compared, **64** under
`bin/public` and **2** under `bin/platform`, over **174** source inputs, both
profiles reporting `matches_fresh_build: true`, and
`chain_writes_performed: false`. Its certificate is
[`sa-artifact-reproducibility-20261121.json`](reports/sa-artifact-reproducibility-20261121.json),
and the two core pairs it certifies are:

| Profile | `SmartAccount.nef` SHA-256 | `SmartAccount.manifest.json` SHA-256 |
| --- | --- | --- |
| `bin/public` | `397f96ab1997dcd8aad6455a797a569dfff2789c4ffff4dbfcab4ff590d553bf` | `4939cf01fb812fff5fb83fc4edd71205041d9a91201390ff9f21716692c23470` |
| `bin/platform` | `7d5fad653060bbe6dca63bc14dc7be8097e138c46956c23c787cba2fe604fdd8` | `296a3ad498dd4a553e1aa91449817b6eab3b4814cf3c15fe3830fe004f6b7550` |

Both profiles moved in that replay: the `PLATFORM` profile compiles the same
custom sources, so it carries the same protocol changes. `contracts/build`
remains the deliberate deployed-mainnet anchor and is reported as such.
The joined NeoExpress receipt is bound to a reviewed source-runtime build
(`sourceRuntime`): its 104-file map, source-build receipt, `neoxp.dll` and
wrapper hashes are checked before and after the private run, with host paths
excluded from the receipt.
The NEF carries no
source path or URL, and the compiler string in its header is `Neo.Compiler.CSharp 3.9.1+5fa9566e...`, so the
bytes depend only on the sources, the pinned packages and the pinned compiler.

### Native ABI 2 modules

The six `SMARTACCOUNT_NATIVE` modules are built and packaged separately by
`scripts/build_native_modules.py`. Their committed locks use the same published
Framework 3.10.1, and each packaged manifest requires the native ABI 2 authority
service. Two clean builds matched all six NEFs, six packaged manifests and the
packaging certificate; the current input/output maps are in
[`sa-native-abi2-module-build-20261008.json`](reports/sa-native-abi2-module-build-20261008.json).
The receipt identifies both original sources and the explicit native preprocessing
recipe. These modules require SmartAccount and are not `public` artifacts.

The native node/NeoExpress runtime has a separate source build and private-chain
gate, documented in [native validation](proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.md).
Module reproducibility and the test-only public-VM module-lifecycle probe do not establish
native-chain behavior or public activation.

Historical reference digests before the 2026-10-08 consolidation (SHA-256; these are not pins for the
current source, and a fresh reproduction report is required after every contract or pin change):

| Profile / artifact | SHA-256 |
| --- | --- |
| `v3/SmartAccountV3.nef` | `63d33c11d9fe89d7386ec3d96d8a8e79680be432d7ccd01ee17e704e8cced245` |
| `v3/SmartAccountV3.manifest.json` | `b72317b021775187f55ed7851cdc268a63b3598153235cf02df3307007fd1546` |
| `platform/SmartAccountV3.nef` | `088f9157bb1c5f1217d29e49f6177f9da5a370fa671941da2c6bb216959bbc94` |
| `platform/SmartAccountV3.manifest.json` | `9db29a5f9c3d2b38e16daa61a1ea9bbee3227d5cbf81026e23ce88d81420c44d` |

`docs/reports/sa-published-build-reproducibility-20261004.json` lists the 76 files written by the 2026-10-04 build
(24 contracts; the verifiers and hooks are written twice). Two clean exports at paths of 118 and 165
characters, each with an empty NuGet cache, produced identical bytes and no warnings.

## What the bytes are, and are not

- The historical 2026-10-04 artifacts were byte-identical to what the private framework build (`3.10.2-CI00384`) produced from the source as it
  was before the syscall declaration moved into the contract, for all 24 contracts, so contract behaviour and
  ABI did not change when the pin moved.
- They are **not** the bytes deployed on MainNet or TestNet. Those cores were compiled from older source,
  before the verifier gas cap and later changes, so the current NEF differs from the deployed one.
  Deployed-versus-source evidence for the SA core is a separate task.
- The historical 2026-10-04 core emitted `SYSCALL System.Contract.CallWithGasLimit`. Only the private
  PLATFORM profile now emits it; the public profile's four callback tests run without a skip guard.
- 3.10.1 is the pinned published framework. The historical comparison found that 3.10.0 gives the same bytes. 3.9.1 and older bind
  `ContractManagement.Update` to the two-argument native overload instead of the three-argument one (a
  different method token and one byte less code), so every later method offset shifts and the build differs.

## How to bump

1. Change `NeoSmartContractFrameworkVersion` in `Directory.Build.props`, or another package version in
   `tests/SmartAccount.Contracts.Tests/SmartAccount.Contracts.Tests.csproj`.
2. Update every lock file: `for p in $(find contracts tests -name '*.csproj'); do dotnet restore "$p" --force-evaluate; done`.
   Locked mode refuses this without `--force-evaluate`, and CI never passes it.
3. Run `node scripts/check_neo_platform_packages.mjs`. It lists each Neo package whose content hash differs
   from the audited one and any Neo package the manifest does not know. Put the id, version and content
   hash (the one in `packages.lock.json`) into `contracts/neo-platform-packages.json`, with the SHA-256 of the
   `.nupkg` from the global packages folder, and set `frameworkVersion`.
4. Compile with the pinned compiler and compare the digests with the previous ones. If the bytes change,
   say so in the change and replace the receipt in `docs/reports/`.
5. To change the compiler, edit the `nccs` version in `ci.yml` and the `compiler` entry in the manifest:
   `sha256` of the installed `.nupkg`, `sha512` from the `contentHash` in its `.nupkg.metadata`.

A Dependabot NuGet pull request that changes a version without regenerating the lock files (and, for a Neo
package, the manifest) fails the gate; apply steps 2 and 3 to its branch.

Native private-chain consumers verify the packaged profile certificate against
current profile parameter bytes and their canonical digest, the descriptor and
the packaging recipe. They also validate each packaged module's exact capability
metadata and lifecycle ABI against that descriptor. Matching artifact hashes
alone do not admit an older native ABI 2 profile.


## Frozen native composite profile (2026-10-09)

The final build/proof checkpoint binds profile
`4201b02f571b7415121467d67343a8189b8070ad795a82424c0403782d22b1b4`
to the core/node/Express commits and complete source maps in
[`sa-native-composite-final-build-proof-20261009.json`](reports/sa-native-composite-final-build-proof-20261009.json).
Two independently copied source trees produced identical 104-file runtimes,
50 dependency archives and lock maps. The six native modules independently
reproduced their 12 NEF/manifest files and packaging certificate. The consumer
revalidated current parameter bytes, profile digest, descriptor, recipes,
capability metadata and lifecycle ABI against all 13 packaged files.

The custom `public` and `PLATFORM` outputs remain byte-identical across all 80
artifacts. The final public runtime regression passed 396 tests with no skips;
the required external NeoDID artifact was supplied. The earlier
`sa-native-abi2-runner-build-20261009.json` and
`sa-native-abi2-rpc-runtime-20261009.json` describe intermediate source snapshots
and are not the final composite build. Private-chain/SDK receipts establish
integration behavior separately; these build results do not establish activation
on a public network or compiler correctness.

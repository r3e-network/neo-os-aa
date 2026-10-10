# AA contracts: reproducible build from published packages

Package baseline established on 2026-10-04 (audit finding R-11 / N-DEP-1, program item P1-C-AAV4-BUILD). Every package the AA
contracts and their tests restore is published on nuget.org, and the toolchain is pinned so that a second
builder gets the same NEF and manifest bytes.

## What is pinned

| What | Pin | Where |
| --- | --- | --- |
| `Neo.SmartContract.Framework`, `Neo.SmartContract.Testing` | 3.10.1 | `Directory.Build.props` (`NeoSmartContractFrameworkVersion`) |
| the Neo packages they pull in | `Neo`, `Neo.Extensions`, `Neo.IO`, `Neo.Json`, `Neo.VM`, `Neo.Disassembler.CSharp` 3.10.1; `Neo.Cryptography.BLS12_381` 3.9.0 | `contracts/neo-platform-packages.json` (SHA-512 of each package) |
| every other package (MSTest, Akka, ...) | resolved version and content hash | committed locks for 26 public projects; `--include-native` checks all 36, including six native modules, two test-only epoch-probe projects and two runtime probe hosts with empty NuGet dependency locks |
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
bash contracts/compile.sh                                     # every contract into contracts/bin/v3
dotnet test neo-abstract-account.sln -c Release
```

`./scripts/verify_repo.sh --contracts-only` runs the same steps plus the deploy-tool tests and the format
check. To prove a clean restore, point `NUGET_PACKAGES` at an empty directory first.

### Select the validation profile

`./scripts/verify_repo.sh --profile ordinary` is the default. It runs the public
contract build and tests, deployment-tool regressions, frontend checks and SDK
checks without restoring native probe projects or building the native epoch VM
fixture. `--contracts-only`, `--frontend-only` and `--sdk-only` still select the
component to validate. Shared deterministic frontend/SDK unit tests remain in
both profiles; they do not require a native node.

`--profile native` selects native package locks, protocol and runner guards, the
native module epoch VM regression and native browser coverage. `--profile all`
runs both profiles. Every selected command is mandatory and its failure stops
the gate. The native epoch fixture is module-level VM evidence; the independent
`native-profile.yml` workflow additionally builds the pinned native core and
executes the native VM matrix. Neither command establishes public activation or
full-chain admission.

The main CI workflow also runs the native browser fixture in a separate required
step after installing the frontend dependencies and Playwright. It reuses those
installations and does not repeat the frontend build or full unit suites. This
workflow has no path filter, so native UI, shared code, SDK and frontend test
changes all select the browser gate without needing a native node.

`--formal` explicitly adds the aggregate formal checks and their source-lock
requirements. `--neoexpress` selects the existing compatibility deployment probe
and is accepted for `ordinary` or `all`; native full-chain validation follows its
separate documented runner. These optional checks keep their explicit NOT RUN
messages when they are not selected.

## Reproduce

### Public and private profiles

The default core in `contracts/bin/v3` uses published `System.Contract.Call`: signature validation
is read-only, while verifier `postExecute` retains write access for accounting. It emits no
`System.Contract.CallWithGasLimit`. The four verifier-callback tests run on the published TestEngine;
`tests/localchain/test_public_profile.py` exercises a signed operation on disposable published neoxp.

`bash contracts/compile.sh` also builds the private core separately in `contracts/bin/platform`.
To build only that profile, run `bash contracts/compile.sh --platform`. The pinned nccs 3.9.1 ignores
MSBuild `DefineConstants`, so the script prepends `#define PLATFORM` to a temporary copy of the execution
source and removes the copy afterwards. The private core retains both 10 GAS bounded callbacks and
requires the private core syscall at runtime; do not deploy that artifact on public networks.

The public profile does not bound verifier gas. Lifecycle ABI admission is not a verifier trust or
resource policy. Public relays must apply their own reviewed module policy, simulation and finite
transaction-fee limits before sponsorship; these controls do not establish a protocol-level child
budget. Unrestricted sponsored admission remains unsafe. `contracts/build` remains the historical
deployed-artifact fixture. Public deploy/upgrade helpers select `contracts/bin/v3` and reject paths
escaping that directory; `contracts/bin/platform` is never a public release source.

### Public verifier release selection

`scripts/deploy_latest_aa_verifiers.js` selects SessionKeyVerifier from
`contracts/bin/v3/verifiers/` and SocialRecoveryVerifier from `contracts/bin/v3/`
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

```bash
for dir in "$A" "$B/deeper"; do          # two different absolute paths
  mkdir -p "$dir" && git archive <commit> | tar -x -C "$dir" && (cd "$dir" && bash contracts/compile.sh) &&
    (cd "$dir/contracts/bin" && find . \( -name '*.nef' -o -name '*.manifest.json' \) | sort | xargs shasum -a 256) > "$dir.sha256"
done
diff "$A.sha256" "$B/deeper.sha256" && echo reproduced
```

`node scripts/check-artifact-reproducibility.mjs` replays the canonical `contracts/compile.sh` in a
scratch copy and compares **both** `contracts/bin/v3` and `contracts/bin/platform`, with separate
profile verdicts. A missing core, empty directory, extra artifact or byte drift in either profile
fails the gate. It does not infer runtime compatibility from reproducibility alone.
The 2026-10-08 replay matched **80/80** files: **78** under `bin/v3` and **2** under
`bin/platform`, with no drift or missing artifacts. Exact digests and the profile verdicts
for the native integration source are in
[`aa-native-abi2-public-platform-reproducibility-20261008.json`](reports/aa-native-abi2-public-platform-reproducibility-20261008.json).
The NEF carries no
source path or URL, and the compiler string in its header is `Neo.Compiler.CSharp 3.9.1+5fa9566e...`, so the
bytes depend only on the sources, the pinned packages and the pinned compiler.

### Native ABI 2 modules

The six `SMARTACCOUNT_NATIVE` modules are built and packaged separately by
`scripts/build_native_modules.py`. Their committed locks use the same published
Framework 3.10.1, and each packaged manifest requires the native ABI 2 authority
service. Two clean builds matched all six NEFs, six packaged manifests and the
packaging certificate; the current input/output maps are in
[`aa-native-abi2-module-build-20261008.json`](reports/aa-native-abi2-module-build-20261008.json).
The receipt identifies both original sources and the explicit native preprocessing
recipe. These modules require AccountManagement and are not public `v3` artifacts.

The native node/NeoExpress runtime has a separate source build and private-chain
gate, documented in [native validation](proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.md).
Module reproducibility and the test-only public-VM epoch probe do not establish
native-chain behavior or public activation.

Historical reference digests before the 2026-10-08 consolidation (SHA-256; these are not pins for the
current source, and a fresh reproduction report is required after every contract or pin change):

| Profile / artifact | SHA-256 |
| --- | --- |
| `v3/UnifiedSmartWalletV3.nef` | `63d33c11d9fe89d7386ec3d96d8a8e79680be432d7ccd01ee17e704e8cced245` |
| `v3/UnifiedSmartWalletV3.manifest.json` | `b72317b021775187f55ed7851cdc268a63b3598153235cf02df3307007fd1546` |
| `platform/UnifiedSmartWalletV3.nef` | `088f9157bb1c5f1217d29e49f6177f9da5a370fa671941da2c6bb216959bbc94` |
| `platform/UnifiedSmartWalletV3.manifest.json` | `9db29a5f9c3d2b38e16daa61a1ea9bbee3227d5cbf81026e23ce88d81420c44d` |

`docs/reports/aa-published-build-reproducibility-20261004.json` lists the 76 files written by the 2026-10-04 build
(24 contracts; the verifiers and hooks are written twice). Two clean exports at paths of 118 and 165
characters, each with an empty NuGet cache, produced identical bytes and no warnings.

## What the bytes are, and are not

- The historical 2026-10-04 artifacts were byte-identical to what the private framework build (`3.10.2-CI00384`) produced from the source as it
  was before the syscall declaration moved into the contract, for all 24 contracts, so contract behaviour and
  ABI did not change when the pin moved.
- They are **not** the bytes deployed on MainNet or TestNet. Those cores were compiled from older source,
  before the verifier gas cap and later changes, so the current NEF differs from the deployed one.
  Deployed-versus-source evidence for the AA core is a separate task.
- The historical 2026-10-04 core emitted `SYSCALL System.Contract.CallWithGasLimit`. Only the private
  PLATFORM profile now emits it; the public profile's four callback tests run without a skip guard.
- 3.10.1 is the pinned published framework. The historical comparison found that 3.10.0 gives the same bytes. 3.9.1 and older bind
  `ContractManagement.Update` to the two-argument native overload instead of the three-argument one (a
  different method token and one byte less code), so every later method offset shifts and the build differs.

## How to bump

1. Change `NeoSmartContractFrameworkVersion` in `Directory.Build.props`, or another package version in
   `tests/AbstractAccount.Contracts.Tests/AbstractAccount.Contracts.Tests.csproj`.
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
[`aa-native-composite-final-build-proof-20261009.json`](reports/aa-native-composite-final-build-proof-20261009.json).
Two independently copied source trees produced identical 104-file runtimes,
50 dependency archives and lock maps. The six native modules independently
reproduced their 12 NEF/manifest files and packaging certificate. The consumer
revalidated current parameter bytes, profile digest, descriptor, recipes,
capability metadata and lifecycle ABI against all 13 packaged files.

The ordinary `v3` and `PLATFORM` outputs remain byte-identical across all 80
artifacts. The final public runtime regression passed 396 tests with no skips;
the required external NeoDID artifact was supplied. The earlier
`aa-native-abi2-runner-build-20261009.json` and
`aa-native-abi2-rpc-runtime-20261009.json` describe intermediate source snapshots
and are not the final composite build. Private-chain/SDK receipts establish
integration behavior separately; these build results do not establish activation
on a public network or compiler correctness.

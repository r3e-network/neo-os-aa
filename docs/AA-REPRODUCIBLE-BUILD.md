# AA contracts: reproducible build from published packages

Status on 2026-10-04 (audit finding R-11 / N-DEP-1, program item P1-C-AAV4-BUILD). Every package the AA
contracts and their tests restore is published on nuget.org, and the toolchain is pinned so that a second
builder gets the same NEF and manifest bytes.

## What is pinned

| What | Pin | Where |
| --- | --- | --- |
| `Neo.SmartContract.Framework`, `Neo.SmartContract.Testing` | 3.10.1 | `Directory.Build.props` (`NeoSmartContractFrameworkVersion`) |
| the Neo packages they pull in | `Neo`, `Neo.Extensions`, `Neo.IO`, `Neo.Json`, `Neo.VM`, `Neo.Disassembler.CSharp` 3.10.1; `Neo.Cryptography.BLS12_381` 3.9.0 | `contracts/neo-platform-packages.json` (SHA-512 of each package) |
| every other package (MSTest, Akka, ...) | resolved version and content hash | `packages.lock.json` beside each of the 25 projects (`packages.<Project>.lock.json` where a directory holds several projects) |
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

The public profile does not bound verifier gas. The registry allowlist and relayer controls in
DEC-AA-2 are separate work (CU-65); this build change does not establish those controls or authorize
a deployment. `contracts/build` remains the historical deployed-artifact fixture.

### Two-build comparison

```bash
for dir in "$A" "$B/deeper"; do          # two different absolute paths
  mkdir -p "$dir" && git archive <commit> | tar -x -C "$dir" && (cd "$dir" && bash contracts/compile.sh) &&
    (cd "$dir/contracts/bin" && find . \( -name '*.nef' -o -name '*.manifest.json' \) | sort | xargs shasum -a 256) > "$dir.sha256"
done
diff "$A.sha256" "$B/deeper.sha256" && echo reproduced
```

`node scripts/check-artifact-reproducibility.mjs` does the same against a scratch copy. The NEF carries no
source path or URL, and the compiler string in its header is `Neo.Compiler.CSharp 3.9.1+5fa9566e...`, so the
bytes depend only on the sources, the pinned packages and the pinned compiler.

Reference digests of the AA core (SHA-256; they change whenever a contract source or a pin changes):

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
- 3.10.1 is the newest published framework. 3.10.0 gives the same bytes. 3.9.1 and older bind
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

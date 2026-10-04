# Neo platform packages and the verifier gas syscall (R-11 / N-DEP-1)

Status on 2026-10-04: **the contract build and its tests no longer need private packages.** Every
package the contracts and their tests restore is published on nuget.org, pinned and reproducible
([AA-REPRODUCIBLE-BUILD.md](AA-REPRODUCIBLE-BUILD.md)). What is still open is a platform gap, not a build
gap: the AA core calls a syscall that no published Neo core registers.

## The gap

`UnifiedSmartWallet.Execution.cs` calls `System.Contract.CallWithGasLimit` twice, to cap every
verifier callback at 10 GAS (VULN-001 mitigation).

- **No published framework declares it.** `Neo.SmartContract.Framework` 3.10.1, 3.10.0 and 3.9.1 all fail
  with `CS0117: 'Contract' does not contain a definition for 'CallWithGasLimit'` (re-run on 2026-10-04
  from a clean package cache). Until then the build pinned a private framework build, `3.10.2-CI00384`,
  that adds exactly that one member to the public API. The contract now declares the syscall itself
  (`[Syscall("System.Contract.CallWithGasLimit")]` on an extern method in `UnifiedSmartWallet.Execution.cs`),
  which the compiler turns into the same `SYSCALL`: the NEF and manifest of every contract are
  byte-identical to the ones the private framework produced.
- **No published Neo core registers it.** The published TestEngine's interop table has no entry for
  hash `1371299780`, so a verifier callback faults with a missing-key error. Four runtime tests drive
  that path (`ExecuteUserOp_VerifierPath_AcceptsValidSessionSignatureWithoutOwnerWitness`,
  `ExecuteUserOp_VerifierPath_RejectsTamperedSessionSignature`,
  `ExecuteUserOp_RecoveryVerifier_EnforcesOwnerAndCoreContext`,
  `ExecuteUserOp_ActiveEscape_OnlyBackupOwnerWitnessMayExecute`). On the published packages they are
  reported **skipped, not passed**, with that reason. Set `NEOOS_REQUIRE_PLATFORM_SYSCALLS=1` and a missing
  syscall fails the run instead. The compiled core is still checked at the bytecode level, on every
  core, by `CompiledCoreSyscallTests`.
- **The private core is the only one that has it.** Neo 3.10.1.1 (below) registers the syscall behind a
  custom hardfork, `HF_Iara`. With it the same suite runs all four tests and passes.
- Activating the syscall on a public network is a separate platform decision.

## What is deployed

The deployed AA cores do not depend on any of this. Public JSON-RPC reads on 2026-09-28:

| Network | AA core | NEF checksum | Compiler | `CallWithGasLimit` syscall |
| --- | --- | --- | --- | --- |
| MainNet | `0x0268a387913b250166ddec032b03332690a1ef78` | 2035992441 | Neo.Compiler.CSharp 3.9.1 | absent |
| TestNet | `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2` | 2785794149 | Neo.Compiler.CSharp 3.9.1 | absent |

The MainNet core is reproducible from public packages: compiling commit `4149496` (the source before
the gas cap) with the public framework 3.9.1 and `nccs` 3.9.1 from a clean cache gives
`UnifiedSmartWalletV3.nef` with checksum 2035992441, byte-identical to the chain and to
`contracts/build/UnifiedSmartWalletV3.nef`. The current source compiles to different bytes (it has the
gas cap and later changes); comparing it with the deployed cores is a separate task.

## The private packages

They are the only way to run the four tests above and the private-chain validation
(`scripts/neoexpress_validate.py`, receipts under `docs/reports/`). The build and the default test run do
not use them, so nothing in `nuget.config` or CI refers to them. Their audited bytes:

| Package | Version | SHA-256 of the `.nupkg` | Public? |
| --- | --- | --- | --- |
| Neo.SmartContract.Framework | 3.10.2-CI00384 | `172597b180f6ae9d93c1901bec11d8f2ce76b46c465a2dd3552ae876e5421d65` | no |
| Neo.SmartContract.Testing | 3.10.2-CI00384 | `92a06b27548c10da98c54043ff4dfd5eaf6c1b74df4fc707b6e7cc67c7b9ce6a` | no |
| Neo.Disassembler.CSharp | 3.10.2-CI00384 | `9ee27bb5b372bba07ef0872ca22ab4700be0c3dc87deb5cbc1ada9a895901f21` | no |
| Neo | 3.10.1.1 | `4218a38a767d8c9c0d8bfbd6cc91c9bd13f9d298c816dd72366a3f3735960d49` | no |
| Neo.Extensions | 3.10.1.1 | `93e296fe0773db0ddaeb4f0a9d9174555f65ae17560497e72e8f4a692ffe500d` | no |
| Neo.IO | 3.10.1.1 | `b1bba7f6aad5275f05ac13f4356c56caaac5866318ef87b30cd14d8ed3a2dcf7` | no |
| Neo.Json | 3.10.1.1 | `0275990e41fe6fb6163183ceb5b151a62a16219294852569d1b85a8ef7f4fa63` | no |
| Neo.VM | 3.10.2-CI00384 | `84bd08d291362cfaf85697f0fb14666719d3443f2f71c39c8de1b9184c20820e` | upstream nightly on the Neo MyGet feed |

The framework and testing hashes equal the ones in `docs/reports/aa-platform-gas-cap-20260921.json`.
Compared with the published 3.10.1 framework, the private one adds `Contract.CallWithGasLimit`, lacks
`AccessControl` and `Ownable2Step`, and otherwise differs only in comments and in the error path of
`Nep11Token.Burn` (compared on 2026-10-04).

Provenance risk: the nuspecs name `neo-project/neo-devpack-dotnet@34255c4` and `neo-project/neo@8461a72`,
but neither commit contains `CallWithGasLimit`. The gas-cap changes were applied on top without being
committed, and the only known copies of the packages are the `.nupkg` files inside the global NuGet
packages folder of the machine that ran the 2026-09-21 private-chain validation. Clearing that cache
without a backup loses them, and with them the ability to run the four tests and the private-chain
validation. **Owner action:** copy the eight `.nupkg` files to durable storage, check each SHA-256 against
the table, and commit the Neo core and DevPack gas-cap changes to branches so the packages can be rebuilt.
If they are republished or rebuilt, their bytes change: record the new hashes here in the same change.

# Neo platform packages and the verifier gas syscall (R-11 / N-DEP-1)

Status on 2026-10-08: the public contract profile and its tests use pinned packages
published on nuget.org. Public verifier execution and private callback gas isolation are
separate profiles, with separate artifact directories and evidence
([AA-REPRODUCIBLE-BUILD.md](AA-REPRODUCIBLE-BUILD.md)).

## Runtime profiles

| Profile | Artifact directory | Verifier callback | Runtime requirement |
| --- | --- | --- | --- |
| Public `v3` | `contracts/bin/v3` | Standard `System.Contract.Call`; validation is read-only and post-execution accounting retains write access | Published Neo runtime; no isolated verifier child gas budget |
| Private `PLATFORM` | `contracts/bin/platform` | `System.Contract.CallWithGasLimit`, 10 GAS per verifier callback | Matching private runtime and activation; cannot run on an ordinary public node |

`bash contracts/compile.sh` builds both profiles from the pinned published compiler and
framework. The script defines `PLATFORM` only in a disposable copy of the execution source;
`--platform` builds only the private core. Public deploy/upgrade helpers select `bin/v3`.
The two-profile reproducibility gate compares both output directories; byte identity alone
does not establish runtime support or deployment parity.

The four verifier-path tests
(`ExecuteUserOp_VerifierPath_AcceptsValidSessionSignatureWithoutOwnerWitness`,
`ExecuteUserOp_VerifierPath_RejectsTamperedSessionSignature`,
`ExecuteUserOp_RecoveryVerifier_EnforcesOwnerAndCoreContext`, and
`ExecuteUserOp_ActiveEscape_OnlyBackupOwnerWitnessMayExecute`) run on the published
TestEngine without a private-syscall skip. `CompiledCoreSyscallTests` checks the actual
NEFs: the public core excludes the private syscall, and the separate `PLATFORM` core
retains both bounded verifier callbacks. `tests/localchain/test_public_profile.py`
exercises a public verifier-signed operation on disposable published NeoExpress.

The private profile declares the syscall with `[Syscall]` because the pinned published
framework does not expose it. This makes it compile, not execute on a runtime lacking the
interop. The historical private Neo 3.10.1.1 build below registers it behind `HF_Iara`.
Historical gas-cap receipts apply only to their exact private runtime/source/artifact
snapshot. The `VerifierGasBudget.v` proof is scoped to `PLATFORM`; the public profile has
no such child budget and public arbitrary-module sponsorship remains a separate resource
and admission-policy concern. Public activation is a platform decision.

## Historical public deployment observation

The deployed AA cores do not depend on any of this. Public JSON-RPC reads on 2026-09-28:

| Network | AA core | NEF checksum | Compiler | `CallWithGasLimit` syscall |
| --- | --- | --- | --- | --- |
| MainNet | `0x0268a387913b250166ddec032b03332690a1ef78` | 2035992441 | Neo.Compiler.CSharp 3.9.1 | absent |
| TestNet | `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2` | 2785794149 | Neo.Compiler.CSharp 3.9.1 | absent |

The MainNet core is reproducible from public packages: compiling commit `4149496` (the source before
the gas cap) with the public framework 3.9.1 and `nccs` 3.9.1 from a clean cache gives
`UnifiedSmartWalletV3.nef` with checksum 2035992441, byte-identical to the chain and to
`contracts/build/UnifiedSmartWalletV3.nef`. The current source has additional contract changes and separate runtime profiles;
current public deployment parity requires a fresh source/artifact/RPC comparison.

## Historical private packages

The following archives were used for the 2026-09-21 private gas-cap validation. They are
not required for the public verifier tests or for compiling either current profile. A
private runtime is required to execute `PLATFORM` callbacks; these archive hashes describe
the historical test environment, not a new runtime release. Nothing in the default
`nuget.config` or CI selects these archives. Their audited bytes:

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

The 2026-10-04 provenance review found that the nuspecs named
`neo-project/neo-devpack-dotnet@34255c4` and `neo-project/neo@8461a72`, while neither
commit contained `CallWithGasLimit`; the tested changes had been applied on top of those
commits. Those historical archive labels therefore do not attest the complete source.
Preserve their exact bytes when retaining the historical receipts. Any new private
runtime release must identify its complete committed source, reproducible package hashes,
activation configuration and runtime tests; do not reuse these hashes for rebuilt archives.

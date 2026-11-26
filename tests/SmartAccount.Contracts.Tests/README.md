# SmartAccount.Contracts.Tests: legacy runtime tests, one live subset

Status at 2026-11-24: **legacy**. This project is kept, not maintained as a gate.

## What it is

53 C# source files (test classes plus the shared `RuntimeTestSupport.cs`), `SmartAccount.Contracts.Tests.csproj` (net10.0, MSTest 3.10.4,
`Neo.SmartContract.Testing` at the version pinned in `Directory.Build.props`) and
its committed `packages.lock.json`. The project compiles every `.cs` file in the
directory (default globbing).

Most of the suite are NeoVM runtime tests of the **retired custom SmartAccount
kernel**: they deploy `SmartAccount.nef` and the plugin artifacts of
`contracts/bin/public` (and `contracts/bin/platform`), select them through
`SMARTACCOUNT_ARTIFACT_DIR`, and exercise the v3 / owner-only-recovery behaviour
of that kernel. The sources and the build recipe of those artifacts were deleted
with the custom track, so they cannot be produced from this tree. Those tests:

- are not protocol-v4 evidence and close none of the `openGates` in
  `contracts/native/profile.json`;
- are not built or run by `scripts/verify_repo.sh` (`scripts/verify_repo.test.mjs`
  asserts that the contract gate never dispatches this project);
- are not part of `SmartAccount.sln` (`scripts/implementation_profiles.test.mjs`
  asserts that the solution does not reference it).

## What is still live

- `.github/workflows/ci.yml` (step "Verify subscription module behavior in
  NeoVM") runs this project once with a filter: `SubscriptionValidatorRuntimeTests`
  (`SubscriptionVerifierRuntimeTests.cs`) and five tests of
  `FixSubscriptionCancelRuntimeTests.cs`. They deploy the v4 module
  `contracts/plugins/validators/SubscriptionValidator` and the mocks under
  `tests/mocks` compiled by that step, not the retired kernel. They are module
  behaviour tests on a test core; they are not a native-profile acceptance gate.
- `RuntimeTestSupport.cs` is compiled into `tests/NativeEpochProbe` (a linked
  `Compile` item) and copied into the scratch tree by
  `scripts/native_epoch_probe.py`, which the native contract gate does run. It
  must stay compilable and self-contained.
- `OwnerOnlyRecoveryRuntimeTests.cs` is registered in
  `tests/fixtures/sa-module-protocol/matrix.json`; `ProtocolMatrixCoverageTests.cs`
  in this project checks that registry. The local-chain scenario that also
  covered it (`sc_v4_owner_only_recovery`) was removed with the retired `source`
  variant of `scripts/localchain/sa_rpc_scenarios.py`.
- `tests/fixtures/sa-module-protocol/rejection-regression.json` recomputes part of
  its coverage from the suites in this directory (`ProtocolFixtureTests`).
- `formal/refinement/test_gas_trace.py` names
  `ImplementationRefinementGasRuntimeTests.cs` as the producer of a gas trace.

## Consequence

Do not cite a pass of this project as native-profile evidence, and do not delete
a file from it without checking the consumers above.

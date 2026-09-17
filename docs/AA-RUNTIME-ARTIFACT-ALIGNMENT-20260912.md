# AA Runtime Artifact Alignment

## Correction

An earlier revision of this note concluded that contracts/build was the release
directory and moved six runtime loaders there. That conclusion was wrong and has
been reverted. Current facts, verified on disk:

- `contracts/compile.sh` writes the canonical output to `contracts/bin/v3`, with
  plugins under `bin/v3/verifiers` and `bin/v3/hooks`.
- `scripts/lib/deploy-helpers.js` (`artifactPaths`) reads the same
  `contracts/bin/v3` directory for every deploy/upgrade script.
- `contracts/build` is a tracked artifact set committed at `fa452d1`
  ("Fix AA scoped verification for proxy agents"). No deploy tooling reads it; the
  only remaining consumer is one frontend helper test.
- `RuntimeTestSupport`, `RuntimeExecutionTests`, `SubscriptionVerifierRuntimeTests`,
  `AuthorityTimelockRuntimeTests`, `Fix_admintimelock_Tests` and
  `Fix_custodytimelock_Tests` point at `contracts/bin/v3` again, with the nested
  plugin layout restored.

## Provenance and Reproducibility Findings

The repository cannot currently prove artifact-to-source equivalence:

- Rebuilding `HEAD` source produces a manifest with 75 methods; the tracked
  `contracts/build` manifest has 64, so the tracked artifacts are stale relative
  to `HEAD` source.
- Rebuilding the `fa452d1` tree with the same compiler and `--optimize=Basic`
  produces a 11678-byte NEF; the tracked artifact is 11676 bytes. Not
  byte-reproducible, so a rebuild alone cannot certify a deployment.
- The tracked artifact is nonetheless what mainnet runs: its SHA-256
  (`009b1b499a87dab1c17c5ed732717af294ae615fc05e1fc958fe712eb443c3ba`) equals the
  NEF read back from the live contract. See `AA-PROXY-SIGNER-SCOPE-20260912.md`.

Recommended gate (not yet implemented): rebuild each released artifact from a
pinned commit in a clean tree and fail when bytes differ, plus fail when a tracked
artifact set no longer matches its source generation.

## Executed Verification

```sh
INCLUDE_VALIDATION_MOCKS=1 bash contracts/compile.sh
dotnet test tests/AbstractAccount.Contracts.Tests/AbstractAccount.Contracts.Tests.csproj \
  --no-restore --verbosity quiet --blame-hang-timeout 60s
```

Result: 233 passed, zero failed or skipped, against the `contracts/bin/v3` output
of the command above.

## Remaining Limits

`MockTransferTarget.transfer` returns true without transferring a token or checking
witness. `RuntimeFixture` defaults to Global signers for unrelated suites; the
scope-sensitive tests set explicit signers. No test exercises native NEO/GAS
callbacks, and none of this is a formal proof. `contracts/build` remains stale in
git; deleting or regenerating it is a deliberate follow-up decision, not a
deploy-tooling fix.

## Reproducibility Gate (implemented)

`scripts/check-artifact-reproducibility.mjs` copies the working-tree sources into a
scratch directory, replays the `contracts/compile.sh` command sequence there, and compares
every `.nef` / `.manifest.json` with `contracts/bin/v3` byte-for-byte.

Current result: **70 artifacts compared, release matches a fresh build: YES**. The tracked
`contracts/build/UnifiedSmartWalletV3.nef` is reported separately as the deployed-mainnet
bytecode anchor and is *expected* to differ from the working-tree source; it must not be
regenerated while it is the only artifact-level evidence of what mainnet runs.

Run it before publishing or upgrading:

```sh
node scripts/check-artifact-reproducibility.mjs          # exit 1 on drift
node scripts/check-artifact-reproducibility.mjs --json   # machine-readable report
```

# Native ABI 2 module authority epochs

Native recovery ends the previous authority generation. The service advances
`AuthorityEpoch`, detaches verifier and hook roots and their dependencies, and
does not depend on a callback to the old modules. Identity, asset address, nonce
channels and frozen state remain unchanged. A recovered owner must configure
fresh module policy before reinstalling it. Reinstalling an old module must not
restore its previous keys, allowlists, limits, spending state or snapshots.

All account-owned storage in the six supported native profiles uses this key:

```
0xA2 || policyPrefix || accountIdLE20 || authorityEpochLE64 || policySuffix
```

The profiles are NeoNativeVerifier, SessionKeyVerifier, MultiSigVerifier,
WhitelistHook, DailyLimitHook and TokenRestrictedHook. Their account getters,
configuration, validation, post-execution, cleanup, signer-domain reads and
prefix enumeration use the same key constructor. Every key construction reads
the current epoch from the fixed native service's safe
`getAuthorityEpoch(accountId)` method; it accepts only an unsigned 64-bit Integer.
Missing accounts, missing ABI support and malformed epochs fail closed. There
is no fallback to an old key or a cached epoch. Global module administration and
authorized-core storage are not account-owned and retain their existing keys.

`AuthorityEpoch` changes only on recovery. `ConfigurationNonce` participates in
the ABI 2 signing domain but must not namespace module state: configuring one
child must preserve the credentials of its already configured siblings.
The two counters have distinct purposes. Account records expose the epoch at
index 13 of the exact 14-field ABI 2 record. Profile metadata is `native-v2`.
The `0xA2` namespace tag prevents old account-only token records from matching
a new prefix scan even when their first eight token bytes equal an epoch.
This requires fresh ABI 2 native modules; old account-only keys are deliberately
unreachable, including at epoch zero. In-place ABI 1 migration is not supported.
The public deployed V3 profile keeps its
existing storage keys and signing domain.

Normal delayed module cleanup deletes the current generation only. Recovery
may leave old generation bytes in storage, but no supported getter or execution
path may read them. This is authority revocation, not physical data erasure.

MultiSig also gives every child an independent deep materialization of both
the original arguments and the original target result. Snapshots are taken
before the first child callback, never from a previously mutated child value.
Only exact Boolean true counts toward threshold; unsupported Interop/iterator
values fail serialization and abort rather than sharing mutable references.
Native validation and post-execution grants and signer domains remain distinct.

Required real VM regressions begin with configured live policy, recover without
old-module cleanup, reinstall the same modules, and show their old credentials
and policy are absent. Fresh policy must work in the new generation, while
other accounts remain unchanged. Include all six profiles and verify raw key
bytes for epoch zero and a nonzero epoch. Composite tests must mutate nested
arguments/results in one child and verify later children and the caller retain
their original values. Compilation, host-only key checks and formal abstractions
are supplementary evidence; they do not replace these executions or establish
public-network deployment readiness.

## Module VM regression

The normal `scripts/verify_repo.sh --contracts-only` gate runs this module
regression automatically, including with `--skip-contract-build`; the isolated
probe builds its own production modules. `NEOOS_NATIVE_EPOCH_RECEIPT` selects a
persistent report path; by default the gate prints a temporary receipt path.
A compile, restore or VM failure stops the gate with a nonzero exit.

To run it alone from the repository root:

```sh
source scripts/dotnet_env.sh
python3 scripts/native_epoch_probe.py --compiler "$NCCS_BIN" --output /tmp/native-epoch-vm.json
```

This compiles the actual six native modules into a temporary tree and executes
them in the published NeoVM. A test-only service at the fixed native address
provides permissive callback grants and an explicit epoch setter. It establishes
module storage isolation and composite object ownership, not native recovery
authorization, native admission, callback gas sufficiency or chain persistence.
The report records copied production/test sources, committed restore locks and
compiled artifacts. Every module and fixture restores in locked mode from those
locks; the explicit native dependency gate inventories both probe projects.
No compiler output is patched. This regression does not substitute for the
separate release build and artifact packaging gate.

The matrix includes fresh reconfiguration, untouched peer accounts, cleanup
without deleting a prior generation, exact epoch type/range/LE64, and an old
untagged token key that would collide with an epoch-zero prefix without `0xA2`.
Composite controls exercise both approval phases, exact Boolean votes, nested
argument/result mutation, preservation of the caller's original result, and
rejection of an Interop iterator result. Diagnostic leaves are explicitly
handwritten test bytecode; the composite and six policy NEFs are real compiler
output. The private native recovery/reinstallation matrix remains required.

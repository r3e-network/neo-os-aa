# Complete reimbursement helper runtime checks

These tests execute the original private `CapReimbursementToActualCost` method in
the reviewed ordinary NEF, from PC 13557 through RET at PC 13764. They extend the
22-instruction arithmetic checks with transaction fields, initial storage, default
record construction, transaction-hash reset, actual native deserialize/serialize,
assertion, heap update and Storage.Put. They are concrete runtime correspondence
evidence, not a universal translation certificate or public deployment approval.

## Entry and artifact identity

The test deploys the unchanged candidate NEF/manifest and uses the public pinned
`ApplicationEngine.LoadContract` API with a test-only method descriptor pointing
at the original private method PC. That API executes the original `_initialize`,
which must establish static slot 34 as storage key byte `0x21`. The descriptor is
not added to the manifest. Original bytecode, tokens and native calls execute;
there is no source surrogate, copied arithmetic script or replacement native
codec. This private-method seam does not prove the two public entrypoint guards
or their complete caller paths.

NEF SHA256: `083ed325f9bdaa6b223662042f32d29f398ba055f507bbdde46daf8113c47f2a`.
Manifest SHA256: `e79fa04969ef3f0bdd6b9df6afe41acdd19767968575ea38c1cd011ee97e5156`.
The runtime packages remain Neo/Neo.VM/Neo.SmartContract.Testing 3.10.1, locked by
the existing project. Relevant source commits are Neo
`d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d`, VM
`004cd6070a940405818d9357638277dd44407e2e`, and testing
`37c03d3e7db8d125efb968a1f1da455f3d205b26`.

## Cases and independent oracle

For well-formed ledger states the oracle is the protocol rule: keep reservation
only for the same transaction; otherwise reset to zero; for positive cost settle
`min(requested, max(cost-reserved,0))`; for zero-fee estimation settle requested;
a nonpositive settlement aborts. The runtime must serialize the updated hash and
reservation and return the settled amount. The oracle is not a translation of
the method's branchless opcode sequence.

Cases cover absent storage, same/new transaction, positive fees, exhausted fees,
zero-fee estimation, signed limits and reservation overflow. A genuine parsed
transaction permits nonnegative fees whose sum is at most `long.MaxValue`; helper
runtime checks do not prove sender funding, witnesses, consensus acceptance, GAS
burning or actual block persistence. The test host allocates execution GAS
independently so zero-fee RPC-style containers can execute the method.

Requested Integer, Boolean, ByteString, Buffer and Null inputs are tested against
the actual engine. ABI Integer metadata does not enforce the tag. ByteString and
Boolean numeric coercions are accepted where positive; Buffer/Null GetInteger
faults must not be silently classified as equivalent bytes/zero.

Injected Array/Struct/Map records, extra/missing fields, invalid bytes, wrong tags
and negative reservations probe the real deserialization and heap behavior. Such
states are explicitly outside the expected reachable ledger invariant unless
identified as a normal record. Accepted repairs or counterexamples do not by
themselves establish a reachable production defect.

## Persistence and failure boundary

The wrapper creates the genuine pinned ApplicationEngine with its own cloned
transaction snapshot and commits it only on HALT, matching the pinned native
block application persistence policy. It does not use TestingApplicationEngine
for the method call: TestEngine.Fee aliases Transaction.NetworkFee and would
otherwise change the fee/hash inputs while allocating host GAS. A successful helper can first commit its child snapshot into the pending
parent cache. A later parent ABORTMSG still prevents that cache from reaching the
original committed snapshot. Tests distinguish pending writes, child-call effects
and outer snapshot persistence; they do not call all of them the same rollback.
The native block path likewise commits successful application snapshots only,
but transaction fees burned by OnPersist are outside application rollback.

Malformed data, nonpositive settlement, arithmetic overflow, read-only call flags
and insufficient execution GAS must fault without committing the new budget.
The estimation case additionally needs a representable aggregate reservation;
`reserved+requested >= 2^255` faults at the original ADD PC 13739. No universal
zero-estimation completion guarantee is claimed.

## Acceptance and maintenance

Write the cases before the test execution helper and retain a failing first run.
Then run the new method suite against exact artifacts and preserve logs outside
the repository. No production source/artifact update, existing seven-test edit,
mainnet/testnet call or deployment is part of this work. The formal certificate
must separately establish source-domain guards, codec/heap assumptions, static
initialization, host effects, gas and storage refinement before whole-method
verification can be claimed.

## Observed local evidence

The new focused suite passes 38/38 with no skipped cases. The initial method
runner run was 31/31 failures; two later primitive CONVERT cases were also
recorded failing before their runner existed. The original seven arithmetic
runtime tests were not edited or rerun by this lane.

The twelve requested-tag cases include padded positive `[7,0]`, padded negative
`[ff,ff]`, signed 32-byte minimum/maximum, and 33-byte zero/negative encodings.
Positive ByteString and Boolean values execute; false/negative/Null/Buffer or
oversized numeric inputs fault as specified by the actual instructions. Separate
primitive checks distinguish explicit CONVERT(Integer): Buffer can convert to
Integer, while Null remains Null; neither makes the original helper implicitly
perform that conversion.

Successful calls assert the real initialized static slot 34 is a Buffer containing
`21`. The storage probes preserve Array/Struct/Map tags, normalize coerced scalar
reservation fields to Integer after ADD, preserve extra fields, and demonstrate
that a mismatched-hash Map missing reservation key can be repaired by SETITEM.
Injected negative reservation can produce a payment quote above paid fees: this
shows the importance of the reachable-ledger invariant, not a proven reachable
production exploit. The canonical produced record remains a two-field Array with
32-byte hash and nonnegative Integer reservation.

After a successful helper return, a later parent ABORTMSG leaves the new budget
visible in the pending parent cache but the original committed test store retains
its old bytes. Zero-fee successful cases commit only to this isolated test store
for readback; real RPC estimation normally discards its execution snapshot. The
host Block carries fixture index/time/nonce without validating a chain header,
and neither signatures, sender fee balances nor OnPersist are executed.

Logs and TRX receipts are outside the repository under `/private/tmp` and record
the exact focused command. These finite observations do not replace any open
kernel proof, environment assumption or complete public-entrypoint certificate.

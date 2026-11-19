# SA Module Protocol — Fixtures (protocol v4)

Fixture home for the shared SA module-protocol (v4) verification work. The
specification is `docs/SA-MODULE-PROTOCOL.md`; the paired constants are
`contracts/custom/SmartAccount.ModuleProtocol.cs` (custom, kernel #39) and
`contracts/native/SmartAccount/SmartAccountModuleProtocol.cs`
(native, kernel #40).

Every vector is **derived from the specification, not from either kernel**:
`generate-vectors.py` reimplements the §4.2/§4.3 envelope, the §6 channel
derivation and the §7.1 key table in plain Python, and writes the files in
`golden-vectors/`. A vector therefore fails when a kernel drifts, which is the
point — regenerating a vector to match a kernel is the wrong repair.

```
python tests/fixtures/sa-module-protocol/generate-vectors.py
```

## 1. Golden vectors

- `golden-vector.schema.json` — shape shared by every file in
  `golden-vectors/`.
- `golden-vectors/operation-envelope.json` — the thirteen-field UserOperation:
  the canonical unsigned serialisation (kernel independent) plus the §4.3
  digest of each kernel.
- `golden-vectors/nonce-channel.json` — the §6 derivation preimage, the full
  namespace digest, the 191-bit channel bytes, the 0x56/0x5C keys and the
  packed `getNonce` value, per kernel.
- `golden-vectors/storage-keys.json` — the §7.1 key table, byte for byte, for
  the shared fixture account.
- `golden-vectors/message-envelope.json` — the §8 message domain and digest,
  the ERC-1271 magic values, and a deterministic RFC 6979 P-256 signature the
  same test key produces over each kernel's digest.
- `golden-vectors/migration.json` — the §14 per-account migration state
  machine: the seeded five-field 0x01 row, the 0x50 `{4, open}` record the
  in-place update writes, and the expected mark → 24h intent → import
  transitions (status codes, legacyModuleCount, invalidation declaration,
  idempotent replay, different-digest rejection).
- `migration-manifest.template.json` — the batch-scan record for a real legacy
  export (`docs/SA-MIGRATION-MANIFEST.md` §5); it stays a template because the
  53/407 account exports do not exist in this repository.

Rules:

1. Every vector pins the **exact inputs** (network, coreHash, accountId, keys,
   subkeys, operation fields) and the **expected byte-level outputs**
   (serialisations, digests, key bytes). Values are literals in the file; no
   expectation is computed at test time.
2. The same vector must pass on BOTH kernels — a vector that only one kernel
   can satisfy is a protocol divergence, not a fixture bug. Because each kernel
   mixes its own core hash and chain magic into every digest (§4.3, §6, §8),
   those digests are pinned per kernel under `expected.custom` and
   `expected.native`; the kernel-independent parts (account identity, canonical
   operation bytes, key table) are pinned once.
3. A vector records the git blob sha of the two constants files it was
   generated against (`constantsRevision`); when a constant changes, every
   vector is regenerated, not edited by hand.
4. Vectors never contain private keys; signatures use fixed test material, not
   real wallet material.
5. A digest that binds the calling script hash (the §8 message digest) is also
   driven through a caller the vector names. For the custom kernel that caller
   is the `MockVerifierCore` stub's deploy hash, for the native kernel the
   script-hash contract built from `expected.native.forwarderScriptHex`; both
   consumers assert their own caller against the pin, so a harness change fails
   loudly instead of silently re-pinning the domain.

## 2. Rejection regression

`rejection-regression.json` — one row per `SA_*` literal declared by the shared
constants file, plus the legacy replay seeds (F-2:
`Fix_sessionkeyrevocation_repro_Tests.cs`, `Fix_subscriptionsubid_repro_Tests.cs`,
and the recovery-ticket seed of F-11).

Each row records the failing input, how the failure surfaces (`throw` for a
raised `SA_*` string, `magic` for the ERC-1271 `0xffffffff` reply), and its
coverage. `status` and `coveringTestFiles` are **recomputed from the test
sources** by `ProtocolFixtureTests.RejectionTableMatchesTheDeclaredCodes`, so a
hand-edited status fails the suite. Two rules decide a row:

- a declared `SA_*` code is covered when a suite in
  `tests/SmartAccount.Contracts.Tests` spells the quoted literal — for a `magic`
  surface the literal names the row the failing case encodes, because the code
  itself never escapes as a throw;
- a `LEGACY_REPLAY_*` seed is covered when the fixture it was captured from
  (`seed`) still exists; those seeds predate this table and spell no code.

`status: "uncovered"` is the honest state of a rejection path that has no test
yet; it is the list to drive down, not a placeholder. Every uncovered row
carries a `note` saying what driver it needs — a declared code with no note is
a driver this table still owes.

## 3. Kernel verification matrix (design report §5.4, full table)

Functional and security (each row names the covering fixture file; kernels add
their runtime tests on top — a matrix row is only closed when BOTH kernels show
a passing trace):

`matrix.json` in this directory is the machine-checked form of the table below.
`ProtocolMatrixCoverageTests` fails when a row is missing or duplicated, when a
`Class.Method` reference no longer resolves to a `[TestMethod]` in
`tests/SmartAccount.Contracts.Tests`, when a named fixture is gone, when a
native reference no longer resolves in `tests/SmartAccount.Native.Tests`, when
the table and the matrix disagree, or when a `partial` row does not carry a
note naming what this repository cannot pin. Status `pinned` means the row has
at least one custom driver and, where a native entry is listed, a native one;
`partial` means the note names the missing half.

| # | Invariant | Fixture / note |
| --- | --- | --- |
| F-1 | multiple scalar validators + same-address multi-instance installs | operation-envelope + new instance tests |
| F-2 | switching validator cannot skip any hook; all hooks run per snapshot | operation-envelope (hookProofs digest) |
| F-3 | threshold members not independently routable; duplicate identity / cycles / nesting rejected | rejection-regression |
| F-4 | post stage only over the approved snapshot set | rejection-regression + runtime |
| F-5 | per-hook forward pre / reverse post; false/FAULT behavior | runtime both kernels |
| F-6 | proof/args/result/hookData tampering rejected | rejection-regression |
| F-7 | empty-slot install, uninstall, last-validator, default policy all timelocked | runtime |
| F-8 | pending intents: concurrency, conflicts, maturity, expiry, stale revision | runtime |
| F-9 | frozen state: every state-changing ABI blocked, not just execute | runtime |
| F-10 | validation/message → post/configuration/cleanup escalation; target→module; same/cross-account reentrancy | runtime (phase gates) |
| F-11 | contractId/updateCounter/NEF/profile drift rejected before and after | rejection-regression |
| F-12 | revoke-regrant, uninstall-reinstall, market sale replay all fail | rejection-regression |
| F-13 | same subId re-creation works; new/old nonce lanes never shared | nonce-channel |
| F-14 | unconsumed recovery ticket replay across clear/setup fails; consumed nullifiers keep failing (F-11 fix) | rejection-regression |
| F-15 | recovery executes without any plugin/Market/Oracle callback | runtime |
| F-16 | no-plugin operations + built-in single/threshold message signatures pass; contract custody cannot fake a message signature | message-envelope |
| F-17 | gas Plan B: over-budget return, exhaust-without-return, descendant burn, whitelist path; Verification vs Application separately | runtime (budget probe) |
| M-1 | real 53/407 account migration fixtures, all legacy prefixes, unknown rows, five-field and 14-slot legacy decoders | migration |
| M-2 | MultiHook order preserved as hookOrder; MultiSig threshold preserved as policy | migration |
| M-3 | nonce/epoch monotonic; proxy/coreHash/name unchanged on the legacy side | migration |
| M-4 | 0x12/0x1C invalidation declared and never authorization | migration + rejection |
| M-5 | owner-only, frozen, recovery-pending, market-locked accounts | migration |
| M-6 | interrupted migration, repeated (idempotent) migration, rollback artifacts, old pending/old signature rejection | migration + rejection |

Cross-kernel equality rows (both kernels must produce identical bytes):

- canonical unsigned operation serialization (custom `StdLib.Serialize` vs
  native `BinarySerializer.Serialize`) — `operation-envelope.json`
  `expected.canonicalUnsignedOperationHex`;
- operation digest and message digest for the same inputs, modulo the actual
  coreHash of each kernel — `operation-envelope.json` `expected.{custom,native}`;
- storage key bytes for 0x50–0x5E — `storage-keys.json`.

## 4. Open fixture work

- `migration-manifest.template.json` — stays a template by design: it describes
  a real legacy chain scan (53 mainnet / 407 testnet accounts, all legacy
  prefixes), and no such export exists here. What the repository *can* prove —
  the §14 state machine, including that the 0x01 row is decoded as migration
  input and kept as evidence — is pinned in `golden-vectors/migration.json` and
  driven by the custom suite (`ProtocolFixtureTests`). The native kernel carries
  the same 0x5A record and event names (pinned in `golden-vectors/storage-keys.json`)
  but has no legacy 0x01 decoder, so the per-account legacy path is custom-only.
- `module-profile.template.json` — documents the canonical profile shape only;
  the live profiles are the modules' own `getModuleProfile()` output.
- The native kernel declares the 0x58 and 0x5D prefixes but exposes no named key
  builder for them yet; the native fixture test asserts their pinned bytes from
  the prefix plus the raw account id instead.

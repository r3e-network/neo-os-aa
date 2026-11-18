# SA Module Protocol — Fixture Skeletons (protocol v4)

Fixture home for the shared SA module-protocol (v4) verification work. The
specification is `docs/SA-MODULE-PROTOCOL.md`; the paired constants are
`contracts/custom/SmartAccount.ModuleProtocol.cs` (ordinary, kernel #39) and
`contracts/native/SmartAccount/SmartAccountModuleProtocol.cs`
(native, kernel #40). These are **skeletons**: expected outputs are left as
`"TODO(kernel39|40)"` markers and are filled by the kernel batches.

## 1. Golden vectors

- `golden-vector.schema.json` — schema shared by every file in
  `golden-vectors/`.
- `golden-vectors/operation-envelope.template.json` — the 13-field UserOperation
  canonical encoding, digest, and both-kernel digest equality.
- `golden-vectors/message-envelope.template.json` — the built-in P-256 message
  envelope, message digest domain, and the ERC-1271 magic outputs.
- `golden-vectors/nonce-channel.template.json` — channel derivation, channel
  bytes, cursor merge with legacy storage, exhaustion sentinel.
- `golden-vectors/migration.template.json` — per-account migration acceptance
  evidence (see `docs/SA-MIGRATION-MANIFEST.md` §5).

Rules:

1. Every vector pins the **exact inputs** (network, coreHash, accountId,
   keys, subkeys, operation fields) and the **expected byte-level outputs**
   (serializations, digests, key bytes). No computed-on-the-fly expectations.
2. The same vector must pass on BOTH kernels — a vector that only one kernel
   can satisfy is a protocol divergence, not a fixture bug.
3. A vector records the constants-file revision it was generated against; when
   a constant changes, every vector referencing it must be regenerated, not
   edited by hand.
4. Vectors never contain private keys; signatures use fixed test keys checked
   into the test project, not real wallet material.

## 2. Rejection regression

`rejection-regression.template.json` — a table of malformed/replayed inputs
that MUST fail closed, one row per `SA_*` error code plus the legacy replay
regressions (F-2: keep the existing legacy fixtures
`tests/SmartAccount.Contracts.Tests/Fix_sessionkeyrevocation_repro_Tests.cs`
and `Fix_subscriptionsubid_repro_Tests.cs` as rejection regression seeds).

## 3. Kernel verification matrix (design report §5.4, full table)

Functional and security (each row names the covering fixture file; kernels
add their runtime tests on top — a matrix row is only closed when BOTH kernels
show a passing trace):

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

- canonical unsigned operation serialization (ordinary `StdLib.Serialize` vs
  native `BinarySerializer.Serialize`);
- operation digest and message digest for the same inputs (modulo the actual
  coreHash of each kernel);
- storage key bytes for 0x50–0x5E (identical prefix + suffix encoding).

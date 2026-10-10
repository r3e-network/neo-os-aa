# Native account usability and validation follow-up

Date: 2026-10-09. Scope: the unactivated Neo N3 AccountManagement ABI 2 draft.
Identity version 1 and the profile parameter digest are unchanged. This review
advances implementation quality; it is not protocol adoption or public activation.

## Changes and user outcomes

- **Review-bound cancellation.** The SDK embeds the full pending-call bytes in
  an Application script that reads, serializes, compares and asserts the pending
  record before cancellation. Replaced or missing content faults before deletion.
  Wallet invocation cannot silently replace this exact script. The native method
  itself still cancels a role slot; an identically recreated record also matches
  the guard. See [transaction guards](../NATIVE_ACCOUNT_TRANSACTION_GUARDS.md).
- **Standard threshold authorities.** Canonical Neo CHECKMULTISIG wallets can
  act as custody, guardian or payer. Every supplied member signature is verified
  before the quorum is assembled in script order. This wallet threshold is
  distinct from the MultiSigVerifier module threshold. A 2-of-3 guardian permits
  any two surviving keys to recover; loss below threshold still cannot unfreeze
  a frozen account. See [threshold recovery](../NATIVE_ACCOUNT_THRESHOLD_RECOVERY.md).
- **Complete signed-file workflow.** The SDK exports public transaction data;
  the workspace imports and verifies its exact bytes, signatures, signer scopes,
  network/profile and explicit fee limits. Submission requires fresh complete
  signed preflight and explicit approval. Unknown submission results retain the
  original hash without automatic resend. After a page refresh, the original
  review and signed file restore only receipt lookup, including expired or
  executed transactions. Restored records cannot authorize preflight or broadcast.
  See [signed transaction import](../NATIVE_SIGNED_TRANSACTION_IMPORT.md).
- **Clear freeze consequences.** Before authorization, the workspace displays
  both unfreeze authorities, the effect on pending changes and recovery timing,
  and requires acknowledgment of guardian availability.
- **Measured module cost reduction.** Replacing a 32-byte loop with a fresh VM
  range copy retains ownership and all authorization checks. The maximum
  recorded composite callback costs 0.95454583 GAS, down from 0.95694229 GAS:
  239,646 datoshi or 0.2504%. Its headroom remains only 4.545417%; the budget is
  unchanged. See [performance evidence](../NATIVE_ACCOUNT_PERFORMANCE.md).

## Validation

| Layer | Result and scope |
| --- | --- |
| Core | 2,003 tests passed, zero skipped; 20 new cases cover guarded cancellation and real standard-multisig recovery. Production core code is unchanged. |
| SDK | 229 tests passed; declaration checks and 4 installed-package consumer tests passed. |
| Frontend | 639 tests passed, zero skipped, including 37 workspace tests; production build passed. |
| Browser | 3 native workflow tests and the general smoke test passed. Desktop 1440px and mobile 390px rendering were inspected at `/native`; no console errors in the native workflow. |
| Contracts | 396 tests passed, zero skipped, including the available cross-repository identity artifact. 80 fresh public/platform artifacts matched byte for byte; 122 existing artifact files remained unchanged. |
| Native modules | Six modules built twice reproducibly; all 20 runtime acceptance scenarios retained. Baseline and candidate each have 540 measured samples across 18 scenarios. |
| Private chain | 38 signed transactions confirmed with exact persisted raw bytes; 3 rejection controls passed. Every submitted transaction passed the portable signature validator, full signed preflight and receipt checks. |
| Formal models | 26 Coq modules / 443 declarations, 247 semantic mutation controls, 61,460 distinct temporal states and 6 SMT obligations / controls passed. This is bounded model evidence, not source/VM/compiler refinement. |

The [private-chain receipt](native-usability-20261009/private-runtime.json)
pins SDK/shared sources, the verified runtime and candidate module build receipts.
It records independent balance, nonce and spending checks, plus the pending-call
readback before and after guarded cancellation. The private node stopped and
temporary wallet state was removed. No public network was touched.

The [public recovery vectors](native-usability-20261009/threshold-public-vectors.json)
contain 20 successful transaction executions and their 37 standard wallet
witnesses, including 17 multisignatures. They are also checked with the shared
WebCrypto verifier. These VM lifecycle cases use controlled time and do not
represent seven days of real chain confirmation.

Browser interactions use fixed public signatures and controlled RPC responses;
the separate private-chain run validates the shared production transport against
an actual node. No live user wallet or hardware signer was exercised. The
production frontend build retains its existing large-bundle warning; this work
does not establish a loading-speed improvement.

The [machine-readable receipt](aa-native-usability-20261009.json) binds this
checkpoint to exact source hashes and evidence. Historical receipts remain
unchanged. CI initially rejected the two new core tests' copyright headers;
the headers were corrected without changing test bodies, and the same format
check then passed locally. Remote check state is read separately at submission.

## Remaining release boundaries

The issue [#242 conformance map](../proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md)
continues to track native identity, lifecycle, execution, resource accounting,
witness compatibility and governance. The native-account proxy used as another
account's custody/recovery authority remains an unresolved source-level concern;
executable confirmation is unavailable. This follow-up does not close it.

Core and RPC integration and the foundation proposal remain upstream draft
review work. Independent consensus-client conformance, arbitrary third-party
module correctness, full compiler refinement, public-network activation and
live wallet interoperability are not established by these local results.

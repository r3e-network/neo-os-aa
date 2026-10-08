# Account consistency follow-up — 2026-10-09

This iteration starts from AA main `3e1e48c` and addresses newly reproduced
integration defects. The native ABI 2 parameter digest and production core
`ff422d9` remain unchanged. Runtime RPC source is now `2f4b607`; the preceding
native convergence reports remain historical evidence for their recorded inputs.

## Changes and compatibility

- Signed-transaction preflight runs real native OnPersist before Application in
  a disposable single-transaction next-block context. It accounts for fee burns,
  proposer rewards and committee changes. The SDK requires the declared context
  and refuses older responses. The assumed block is not a prediction of actual
  transaction ordering, timestamp, proposer or mempool admission.
- Wallet adapter methods retain their original receiver, including class private
  fields. The native workspace clears stale confirmation notices when account,
  intent or queried transaction changes. Custody can cancel pending configuration
  while recovery is pending; proposals and activation retain their restrictions.
- Public V3 sponsored single/batch payloads and argument hashing share a strict
  typed parameter boundary. Nonempty bytes, nested arrays/maps, Hash256,
  PublicKey and actual Neon parameter instances survive SDK, JSON and relay
  conversion. Unknown types and implicit coercions are refused. SDK callers must
  prefix plain hex ByteArray inputs with `0x`; ambiguous bare hex is rejected.
  The existing relay hex convention remains supported. Frontend-only deployments
  use the byte-identical vendored shared module, tested in isolation. Map emission
  matches core RPC insertion order recursively; duplicate VM keys are rejected
  across byte aliases while Boolean and Integer keys remain distinct.
- Sponsorship documentation now distinguishes requested reimbursement, actual
  fees and the settled amount. Policy caps apply to settlement. Zero-fee RPC
  estimation uses the requested upper bound. A transaction fee above MaxPerOp
  can succeed when its requested reimbursement fits the policy.
- Native documentation consistently identifies ABI 2 and retains identity/domain
  version 1 where intended. Guardian cancellation and custody cancellation have
  distinct maturity rules. Native CI includes previously missed input paths and
  validates actual case identities, maximum inputs, negative controls and VM
  results. Verification requires exactly one Boolean true, not merely HALT.
- The bounded-call prerequisite in Neo PR #4759 now uses the same allocation-free
  fee traversal as native core #4768. Twelve measured cases drop from 56 bytes
  per charge to zero, preserving ancestor-budget and fee-exhaustion behavior.

## Evidence

| Gate | Result |
|---|---|
| SDK | 179 tests, types and four independent installed-package cases |
| Frontend | 628 tests, seven browser scenarios and production build |
| RPC | 241 server + 114 client tests in each of published/native core lanes |
| Bounded-call prerequisite | 1,476 core tests; 27 bounded cases |
| Native VM | 20 actual scenarios and five wrong-result controls |
| Python documentation/build/formal guards | 105 tests |
| Complete runtime | Two independent builds; 104 files and 49 package archives identical |
| Native SDK on the new runtime | 36 signed transactions, exact persisted raw bytes, 36 OnPersist declarations and three refusal controls |
| Public V3 targeted private chain | 33 checks; three targeted HALTs covering four operations, one persisted policy FAULT and one signed-argument tamper refusal |
| Formal models | 26 Coq modules, 443 closed declarations, 247 mutations, 61,460 TLC states and six SMT obligations plus six controls |

All listed current gates passed without failed or skipped tests. The first full
frontend run exposed the missing standalone shared-module import; the corrected
complete run passed. Independent review then found a multi-entry Map ordering
defect that single-entry fixtures could not expose. The corrected replay uses
three outer and four inner entries, including distinct Boolean/Integer keys, and
compares actual core RPC, relay and persisted scripts byte for byte. Independent
closure review passed. Red regression logs are retained alongside final results.

Exact source hashes and report hashes are in
[the integration receipt](aa-consistency-iteration-20261009.json).
Supporting receipts cover the [runtime build](aa-native-iteration-runner-build-20261009.json),
[native SDK](aa-native-iteration-sdk-runtime-20261009.json),
[public sponsorship](aa-public-sponsored-iteration-runtime-20261009.json),
[native VM gate](aa-native-ci-probe-consistency-20261009.json) and
[formal/documentation checks](aa-native-docs-ci-formal-20261009.json).

## Branches and remaining boundaries

Three stale Git worktree administration records were backed up, restored for
verification and pruned. Their physical directories remain intact. All original
twelve branch contexts and newly active CU-162/CU-163 work are preserved. CU-162's
encoding fixes were reimplemented with additional regressions; its original
unsafe conversions and incorrect fee prose were not merged unchanged. Active
worktrees are not discarded merely because some changes have been absorbed.

Core #4768, RPC #1115 and proposal #243 remain subject to upstream review and
activation decisions. PR #4759's implementation is repaired, but its reviewer
thread and upstream approval remain separate state. No public-chain activation,
user-wallet signing, npm publication or production database migration occurred.
The sole allowed frontend advisory remains the recorded low Elliptic advisory;
SDK audit is clean. Formal evidence still has `implementationVerified: false`.

The public sponsored target is MockTransferTarget: the proof covers argument
preservation, nonce changes and actual GAS paymaster settlement, not target-token
movement. Its P-256 verifier does not establish a browser WebAuthn ceremony.
Private raw receipts and reproducible probes are retained in the recovery archive.

The current upstream drafts continue the identical source commits from core #4766
and RPC #1114 under neutral branch names; those historical drafts retain their
discussion and check records.

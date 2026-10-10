# Neo N3 native smart accounts

The target is a protocol-native account service, `AccountManagement`, with a
small, explicit authorization boundary. The [ABI 2 profile](proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md)
defines the wire contract. The [SDK](NATIVE_SDK.md) and [workspace](NATIVE_ACCOUNT_WORKSPACE.md)
consume that contract; neither can grant authority the native service rejects.
The profile remains a draft until the Neo proposal and activation process is
complete. Public `UnifiedSmartWalletV3` and private `PLATFORM` are separate
compatibility profiles with separate account identities and artifacts.

The [account user guide](NATIVE_ACCOUNT_USER_GUIDE.md) covers setup, backups,
the authority and timing matrix, and recovery decisions.

## Account identity and authority

An account has a stable account ID and a derived verification-script address.
The address holds assets without deploying one wallet contract per user. Custody
and recovery addresses are authorities, not the account's identity. Changing
custody does not change the funding address or reset operation nonces.

| Role | Authority |
| --- | --- |
| Custody | Direct witness authorization when no verifier is installed; account administration according to the native lifecycle |
| Recovery | Timelocked custody recovery and the profile's emergency controls |
| Verifier | Authorization of the exact operation; bound to an admitted module and its current configuration |
| Hook | Policy checks before and after target execution |
| Fee payer | Signs and pays for the complete transaction, including fees and expiry |
| RPC, SDK, UI | Discovery, construction, simulation and submission; no independent authority |

Recovery advances an authority epoch and the configuration nonce, replaces
custody, detaches the verifier and hook, and clears enrolled dependencies and
pending configuration. It does not invoke the old modules. Account identity,
operation nonces and frozen status remain intact. Unfreezing retains its required
authorities; recovery does not silently enable a frozen account.

The recovery authority is also the guardian for emergency freeze. Choose an
accepted Neo wallet authority controlled independently from custody, and keep
both wallet backups. A guardian can freeze an Active account without custody;
unfreezing requires custody and the configured guardian. Recovery retains that
guardian. If its key is lost while the account is Frozen, this profile provides
no custody-only override or guardian replacement while Frozen. While Active and
without pending custody recovery, custody can propose a guardian replacement;
it takes 24 hours to mature.

Freeze takes effect when its transaction executes and clears **all pending
intents**, including custody recovery and module-policy calls. For emergency
containment followed by recovery, freeze first, confirm the resulting state,
then start a new recovery proposal. Proposing recovery alone does not freeze
the account. A successful counter-advancing transition also invalidates pending
configuration, so every subsequent action must reload current state.

Custody authorizes proposals to replace the verifier, hook or recovery address.
After 24 hours, anyone may pay to activate the current mature intent through
`activateVerifier`, `activateHook` or `activateRecoveryAddress`; no custody or
guardian signature is required at activation. The account must still be Active
with no pending custody recovery. Module replacement still checks code pins and
old-module cleanup. In contrast, applying a delayed module-policy call requires
custody again and the identical stored method and arguments. Custody may cancel
that call for its selected verifier or hook role while it remains pending.
Account-only activation/recovery calls act on pending state at execution. The
SDK's policy cancellation uses a complete transaction script that reads and
serializes the selected pending call, asserts equality with reviewed bytes, and
only then invokes the unchanged native cancellation entrypoint. It faults on
changed or missing content without cancelling a replacement. Exact-script
signing is required; ordinary wallet invoke cannot express this guard. An
identical-byte re-proposal can still match, because the protocol has no unique
proposal-instance counter. See [transaction guards](NATIVE_ACCOUNT_TRANSACTION_GUARDS.md).
Coordinate custody devices and inspect confirmed state after execution.

Supported native modules address storage by account ID and authority epoch.
Reinstalling the same module after recovery starts with empty policy state.
Normal module replacement still performs checked cleanup. The independent
recovery path handles broken or unavailable old modules.

## Execution and revocation

1. Discover the native service on the explicitly selected network and verify
   its identity, ABI version, profile digest and activation.
2. Read current account state and the selected operation nonce channel. Build
   the exact target, method, typed arguments, deadline and nonce.
3. Bind authorization to network, native service, account, authority epoch and
   configuration nonce. Execute with
   `executeUserOp(accountId, operation, expectedAuthorityEpoch, expectedConfigurationNonce)`;
   batch execution uses the same four-argument order.
4. The native service checks both counters before authorization and callbacks.
   The proxy verification path enforces the same canonical envelope. This binds
   transaction-witness authorization as well as operation signatures to the
   reviewed account state; an old signed transaction cannot survive a counter
   change merely because its nonce and block expiry remain valid.
5. Run bounded verifier and hook callbacks, the exact target call, and post
   checks within the transaction. Callback arguments and results have independent
   copies so one callback cannot rewrite another callback's input.
6. Verify the complete signed transaction against the node snapshot before
   broadcast, then read the actual transaction and application outcome.

The proxy witness grants the intended target frame only. It does not grant
unrestricted router descendants or later settlement calls access to assets.
The native account cannot be the transaction's fee payer: its operation proof
does not authorize arbitrary transaction fees.

## Supported policy modules

| Native module | Intended use |
| --- | --- |
| NeoNativeVerifier | Explicit Neo witness authorization with exact verifier scopes |
| SessionKeyVerifier | Expiring delegated keys and constrained operations |
| MultiSigVerifier | Threshold authorization across admitted child verifier modules |
| WhitelistHook | Allowed targets and methods |
| DailyLimitHook | Bounded spending with measured token-balance changes |
| TokenRestrictedHook | Restricted token movement and policy checks |

Native MultiSig selects the first threshold of approving children in configured
roster order. Only those children receive post-execution authority and consume
their policy allowances. Supplying an additional valid signature does not select
that child once the quorum has been reached. The native service retains an
independent approval receipt for this operation, checks the active code pins,
and discards the receipt on completion or failure. Verification receipts never
carry into Application, and batch operations never share receipts.

The composite compares its threshold, ordered roster and signer domains before
and after the selected children's post checks. Those children recheck applicable
current policy and account for the target result without repeating SessionKey
cryptographic verification. Receipt construction, copying and all descendant
calls remain inside the fixed verifier budget.

The native MultiSig profile admits at most three child modules, two required
approvals and three aggregate signer domains. A standalone NeoNativeVerifier
has its own ten-signer bound; the composite limit does not reduce that separate
capability. Ordinary witness quorums such as three-of-five belong in that
standalone verifier; MultiSigVerifier combines different verifier policies.
Supported combinations still need to pass execution against the
current fee policy and their actual module bytecode.

Supported native P-256 keys use their standard Neo signature-account identity as
the canonical signer domain. Configuration strictly validates both compressed
and uncompressed encodings with `canonicalP256PublicKey` before storing the
compressed key; invalid curve points are rejected before any policy write.
Reusing one key as both a SessionKey and a
NeoNative signer therefore does not create two independent votes. This does not
prove that distinct keys belong to independent people or reveal who controls an
arbitrary verification script. Token policies likewise depend on the selected
tokens' behavior and balance queries. Exact profile metadata is an admission
compatibility check, not a proof that arbitrary third-party bytecode follows the
supported module implementations.

Module configuration is delayed by 24 hours; custody recovery is delayed by
seven days. Session expiry must leave time after activation. Delayed key removal
is not an emergency revoke button: freeze provides immediate containment, while
recovery provides the old-module-independent exit.

## Fees and user experience

An external payer may fund a transaction without acquiring account authority.
The native profile has no reimbursement paymaster or automatic sponsorship
settlement. The payer signs the complete transaction after separate system,
network and total fee ceilings have been checked.

An included transaction whose Application ends in FAULT can still charge its
fee payer; reverted state changes do not refund transaction fees. A target
returning Boolean `false` is a business result, not itself a VM fault. Modules
and clients apply their own result checks, including the SDK's strict
Boolean-true requirement for `transfer`.

Bounded calls need enough remaining gas to admit a child budget even when actual
consumption is lower. Node simulation therefore reports `minimumrequiredfee` in
addition to `gasconsumed`; wallet and SDK builders preserve that requirement.
Custom proxy verification and invocation scripts participate in network-fee
calculation. A fee increase after signing requires a new reviewed transaction.

Each verifier callback has a fixed 1 GAS budget; each hook and maintenance
callback has a 2.5 GAS budget. The global Verification limit also applies: a
32-operation encoding bound does not promise that 32 expensive authorizations
fit in one transaction. The SDK simulates and quotes the exact batch. Fee-policy
changes and arbitrary third-party modules can change feasibility, so a measured
boundary vector establishes support only for its recorded runtime and fee policy.

The workspace starts read-only and shows identity separately from the funding
address. Recovery descriptors contain public discovery information, not private
keys. Observed network, wallet, account or pending-intent changes invalidate
prepared reviews. Returned transaction IDs are submissions; exact transaction and receipt
readback are required before confirmation.
After a submission timeout, query the same transaction ID before preparing a
replacement. Successful simulation does not reserve a nonce or guarantee inclusion.

Ordinary wallet `invoke` APIs can handle supported single-authority management
calls. Proxy execution and multiple authorities require exact witness support;
the workspace exports a reviewable SDK recipe and exact script for those flows.
It does not disguise a script export as an executed transaction.

## Verification and activation

Source, contract bytecode, native runtime, RPC and client tests cover distinct
layers. Native module VM probes do not prove the native recovery state machine.
Mock browser tests do not prove a network transaction. Handwritten formal models
do not establish complete NeoVM/compiler refinement or cryptographic soundness.
See the [formal scope](AA-FORMAL-VERIFICATION.md) and
[remaining proof boundaries](reports/aa-native-open-boundaries-20261008.json).

Release evidence must identify the exact source and rebuilt artifacts, exercise
the complete signed transaction on the matching private runtime, verify state and
receipts after success and rejection, and retain reproducible build inputs.
Proposal acceptance, external review, public-network activation, production
deployment and user-controlled wallet signatures remain separate decisions.

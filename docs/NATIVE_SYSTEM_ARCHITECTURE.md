# Neo N3 native smart accounts

The target is a protocol-native account service, `AccountManagement`, with a
small, explicit authorization boundary. The [ABI 2 profile](proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md)
defines the wire contract. The [SDK](NATIVE_SDK.md) and [workspace](NATIVE_ACCOUNT_WORKSPACE.md)
consume that contract; neither can grant authority the native service rejects.
The profile remains a draft until the Neo proposal and activation process is
complete. Public `UnifiedSmartWalletV3` and private `PLATFORM` are separate
compatibility profiles with separate account identities and artifacts.

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

A MultiSig threshold counts modules; it does not prove that their keys belong to
independent people. Token policies depend on the selected tokens' behavior and
balance queries. An ABI marker is an admission compatibility check, not a proof
that arbitrary third-party bytecode follows the supported module implementations.

Module configuration is delayed by 24 hours; custody recovery is delayed by
seven days. Session expiry must leave time after activation. Delayed key removal
is not an emergency revoke button: freeze provides immediate containment, while
recovery provides the old-module-independent exit.

## Fees and user experience

An external payer may fund a transaction without acquiring account authority.
The native profile has no reimbursement paymaster or automatic sponsorship
settlement. The payer signs the complete transaction after separate system,
network and total fee ceilings have been checked.

Bounded calls need enough remaining gas to admit a child budget even when actual
consumption is lower. Node simulation therefore reports `minimumrequiredfee` in
addition to `gasconsumed`; wallet and SDK builders preserve that requirement.
Custom proxy verification and invocation scripts participate in network-fee
calculation. A fee increase after signing requires a new reviewed transaction.

The workspace starts read-only and shows identity separately from the funding
address. Recovery descriptors contain public discovery information, not private
keys. Network, wallet, account or pending-intent changes invalidate prepared
reviews. Returned transaction IDs are submissions; exact transaction and receipt
readback are required before confirmation.

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

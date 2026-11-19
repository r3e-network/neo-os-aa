# Smart account capability boundaries

This is a source-level integration guide. A configured address, a successful build,
or a historical deployment receipt does not show that a public contract contains
the current implementation. Validate the exact NEF, manifest, network and core
binding before enabling a capability for users.

## Delivery priority

The deployed-contract implementation serves NeoOS on the current public runtime.
Native implementation and protocol review proceed in parallel, with independent
release gates. Neither path waits for the other to become usable, and evidence
from one path does not establish runtime guarantees for the other. See the
[implementation strategy](SA-IMPLEMENTATION-STRATEGY.md).

## Runtime profiles

| Profile | Implementation boundary | Deployment requirement |
| --- | --- | --- |
| `public` | Standard `System.Contract.Call`; account nonce, validator modules and hooks, and execution in one transaction | Published Neo runtime; current core and matching module artifacts |
| Private `PLATFORM` | Adds bounded module child calls | Runtime with the matching private syscall; not deployable by choosing a public RPC URL |
| Native SmartAccount | ABI 2 `SmartAccount`, independently derived identity, epoch-scoped modules and bounded callbacks | Corresponding Neo core implementation and hardfork activation; the public v4 deployment does not activate it |

The public profile has no per-child module gas budget. Relays and sponsors must
bound transaction fees and review the selected modules and their mutable child
configuration. Private-profile proofs do not close this public-runtime limitation.

## Native account workflow

The native ABI 2 implementation has independent custody recovery, authority-epoch
module storage, explicit epoch/configuration commitments in execution, bounded
callbacks, witness fee estimation for supported signer shapes and signed-transaction preview. See
[the native architecture](NATIVE_SYSTEM_ARCHITECTURE.md), [SDK](NATIVE_SDK.md) and
[workspace](NATIVE_ACCOUNT_WORKSPACE.md). It requires the matching native runtime
and activation; the public v4 deployment is not evidence of native availability.

Source custody: `contracts/native/SmartAccount/` in this
repository is the only editable copy of the native `SmartAccount` contract
(the true source); the SHA-pinned Neo core checkout used by the
[native VM workflow](../.github/workflows/native-profile.yml) carries
generated copies of those ten files, and the workflow runs
`scripts/sync_native_smartaccount.py --check` against the pinned core before
any build or test work, so drift, missing or unmanaged copies fail the lane
there. The pin now records the regenerated generated-marker commit. This
local true-source/sync structure and its CI gate are repository mechanics;
they do not change the external activation, acceptance or readback boundaries
listed below.

Discovery binds the [current profile parameters](proposals/smartaccount-native-profile-v2-parameters.json)
and their digest, not just `getVersion() == 2`. Identity derivation remains version 1;
authorization and the exact 14-field account record are version 2. Execution takes
four arguments, including the current authority epoch and configuration nonce.
Native composite limits are three children, two approvals/threshold and three
aggregate signer domains. Verifier callbacks have a 1 GAS budget; hooks and
maintenance have 2.5 GAS each. These bounds do not guarantee a maximum batch fits
the network's global Verification budget.

## Public v4 account and operator workflows

| Capability | Supported contract | Remaining boundary |
| --- | --- | --- |
| Account identity | Read the account ID, the derived proxy and the installed validator modules from the selected core; reject mismatches | Legacy reverse indexes may require an explicit account ID |
| Shared drafts | Execute a staged, consistent signed invocation | Collaborator records and UI signature counts do not establish chain authorization |
| MultiSig | Chain-ordered child proofs over the same operation, with child-specific signing domains | Threshold counts validator modules; it does not prove independent humans or custody |
| Session transfers | Exact NEP-17 arguments, proxy sender, nonnegative amount, Boolean success | A token's declared amount does not measure arbitrary additional balance loss |
| Daily limits | Fixed-window accounting and actual net debit, including targets returning false or zero | Token `balanceOf` is a trust dependency; this is not a per-asset universal balance oracle |
| Subscription transfers | Positive amount and successful NEP-17 outcome before consuming a period | Generic non-transfer targets retain their documented return semantics |
| Direct proxy transfer | Derived witness, core scope readback and explicit bounded fee reserve | Relay mode and administrator-configured scope; ordinary wallet invoke APIs cannot add this witness |
| Sponsored execution | Policy-checked settlement with a shared transaction reimbursement ceiling in each core | Sponsored proxy witnesses are refused; arbitrary settlement must not inherit proxy asset authority |
| Operator key recovery | Durable browser key storage and passphrase-encrypted backup | Import requires the draft's already-pinned public key; a link alone cannot replace it |
| Backup-owner escape | Timelock and owner witness; ordinary cleanup-based finalization or callback-free permanent owner-only recovery | Owner-only recovery cannot be undone or reinstall modules; escrow, external approvals and module-held funds remain separate |

## Module names are not full product guarantees

- `P256Validator` verifies its documented P-256 proof format. It is not by
  itself a complete WebAuthn ceremony with origin, RP ID and authenticator-data
  validation.
- `TeeKeyValidator` trusts its registered signing key. A valid signature alone does
  not establish a particular enclave's attestation.
- `ZKEmailVerifier` is disabled and cannot be installed (`getModuleProfile()` advertises no capability and the core rejects the install); do not offer it as a working account option.
- `DelegatedIdentityValidator` uses its documented delegated signing path; do not describe
  it as a locally verified general-purpose zero-knowledge login proof.
- Social recovery's module owner and the core backup owner are separate state.
  Updating one is not evidence that the other changed.

## Validation and release

Run `scripts/verify_repo.sh --profile custom` for public contracts, frontend,
browser, SDK consumers and dependency audits. Use `--profile native` for native
profile/module checks or `--profile all` for both lanes. Run the formal and
private-chain gates with their required
tools, and inspect their recorded scope and skipped checks. The build comparison
must cover both `contracts/bin/public` and `contracts/bin/platform`.

The separate [native VM workflow](../.github/workflows/native-profile.yml) builds a
reviewed immutable core commit and two identical native module copies, then checks
the complete measured composite scenario matrix with the actual native VM. It
rejects missing, duplicate, unknown, failed or over-budget cases; synthetic
transaction signers make this a host test, not mempool or block confirmation.
NativeEpochProbe in the native gate uses a test-only SmartAccount ABI fixture and is a
different test boundary. Protocol v4 renamed the modules to validators and moved configuration onto the
`configure` lifecycle callback. The probe now drives that callback set: it installs,
configures, phase-checks and uninstalls every module the native profile builds, and
asserts the pinned-core caller check, `(accountId, moduleId)` instance state and the
retirement of the `0xA2` authority-epoch layout. Full-node SDK/private-chain receipts remain
separate.
Historical reports retain the commits and bytes they tested; a later test-only
core commit does not change the production runtime identity recorded there.

Before a public rollout, compare every deployed artifact and authorization binding
with the reviewed source; exercise account creation, configuration, transfer,
failure rollback, recovery and fee settlement on the intended runtime. User wallet
signing and public-chain deployment are separate operational steps.

## Current source: callback-free custody recovery

`beginRecovery(accountId, newCustody)` records a pending custody rotation that matures
after the account's `recoveryTimelockMs` (7-90 days, fixed at creation); `cancelRecovery`
deletes the record, and `executeRecovery` — permissionless once matured — applies it.
Execution calls no validator, hook, Market or Oracle: it sweeps every module instance,
threshold policy, hook order, message-subject set, pending intent, nonce channel and
pending migration state, rotates custody to the approved address, clears the recovery
authority, re-enables built-in authorization and advances the authority epoch,
configuration nonce and control revision. `getRecoveryStatus` reads the pending record
back as `[exists, initiatedAt, matureAt, authorityEpochAtInit, newCustody]`.

Recovery preserves identity, asset address and execution nonce history, but it is not a
promise to erase old plugin storage, refund plugin-held funds, revoke token allowances,
settle an active market escrow or remove the independent contract upgrade administrator.
These are source-candidate capabilities; integrations must discover the selected
deployment ABI and read the chain state before exposing them.

## Current source: platform services, freeze and discovery reads

The committed custom source candidate extracts the platform services out of
the core: market escrow settlement (`abandonListing`) lives on `SAAddressMarket`,
paymaster reimbursement (`settleReimbursement`) on `SAPaymaster`, and
platform-account registration plus the owner-rotation timelocks on the
standalone `SAPlatformRegistrar` (`contracts/custom/registrar/`). On top of the
2026-11-13 security remediation, the candidate adds the backup-owner-gated freeze
surface (`freezeAccount` / `unfreezeAccount` / `isAccountFrozen`), not part of
the pinned public artifact.

The 2026-11-16 Ethereum-AA alignment revision adds two safe reads on top of
that candidate: `describeAccount(accountId)` aggregates the full account
descriptor (ERC-7579-style capability discovery), and
`simulateValidation(accountId, op)` — named after ERC-4337's EntryPoint so
4337-aware tooling finds the familiar entry point — is a non-faulting
execution-check preflight (signature and hook execution excluded) that also
reports the escrow latch and the native backup-owner witness. The same revision lets
`SessionKeyValidator` accept a version-0x01 initial-key blob in
the module init data, so a session-key account works on day one;
later key changes go through a fresh configuration intent with its own 24-hour
maturity and seven-day expiry. The SDK exposes
`describeAccount` / `simulateValidation` / `buildSessionKeyInstallCommand` plus
ERC-4337-shaped (`toErc4337UserOperation`, `estimateUserOperationGas`) and
ERC-7715-shaped (`buildSessionKeyPermission`) adapters; the typed-data
signing layout is specified in [SA-EIP-712-SPEC.md](SA-EIP-712-SPEC.md).

A same-day design-phase cleanup removed every pre-deployment compatibility
path (legacy storage-prefix fallbacks, the one-time rotation migration, the
v3 recovery action ticket and the migration/upgrade scripts), bringing the
bringing the candidate to 81 ABI entries against the 90 entries of the pinned public artifact.
is overloaded) against the 90 methods of the pinned public artifact.

The public deployments still run the 90-method artifact, so the extraction,
freeze, discovery and day-one-session-key surfaces stay
source-candidate capabilities behind the
unchanged upgrade-required boundary: a governed upgrade and independent readback
must land before any deployment claims them. Local
evidence so far is source-level only — contract tests cover the extracted
service ABI and the freeze surface, and the
candidate NEF/manifest hashes are re-pinned — while the fresh NeoExpress
receipt, the artifact reproducibility certificate, the CI lanes and the
public-chain readback remain open evidence gates.

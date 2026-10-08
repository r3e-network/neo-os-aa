# Smart account capability boundaries

This is a source-level integration guide. A configured address, a successful build,
or a historical deployment receipt does not show that a public contract contains
the current implementation. Validate the exact NEF, manifest, network and core
binding before enabling a capability for users.

## Runtime profiles

| Profile | Implementation boundary | Deployment requirement |
| --- | --- | --- |
| Public `v3` | Standard `System.Contract.Call`; account nonce, verifier, hooks and execution in one transaction | Published Neo runtime; current core and matching plugin artifacts |
| Private `PLATFORM` | Adds bounded verifier child calls | Runtime with the matching private syscall; not deployable by choosing a public RPC URL |
| Native SmartAccount | ABI 2 `AccountManagement`, independently derived identity, epoch-scoped modules and bounded callbacks | Corresponding Neo core implementation and hardfork activation; public V3 deployment does not activate it |

The public profile has no per-child verifier gas budget. Relays and sponsors must
bound transaction fees and review the selected modules and their mutable child
configuration. Private-profile proofs do not close this public-runtime limitation.

## Native account workflow

The native ABI 2 implementation has independent custody recovery, authority-epoch
module storage, explicit epoch/configuration commitments in execution, bounded
callbacks, witness fee estimation for supported signer shapes and signed-transaction preview. See
[the native architecture](NATIVE_SYSTEM_ARCHITECTURE.md), [SDK](NATIVE_SDK.md) and
[workspace](NATIVE_ACCOUNT_WORKSPACE.md). It requires the matching native runtime
and activation; public V3 deployment is not evidence of native availability.

Discovery binds the [current profile parameters](proposals/smartaccount-native-profile-v2-parameters.json)
and their digest, not just `getVersion() == 2`. Identity derivation remains version 1;
authorization and the exact 14-field account record are version 2. Execution takes
four arguments, including the current authority epoch and configuration nonce.
Native composite limits are three children, two approvals/threshold and three
aggregate signer domains. Verifier callbacks have a 1 GAS budget; hooks and
maintenance have 2.5 GAS each. These bounds do not guarantee a maximum batch fits
the network's global Verification budget.

## Public V3 account and operator workflows

| Capability | Supported contract | Remaining boundary |
| --- | --- | --- |
| Account identity | Read account ID, derived proxy and verifier from the selected core; reject mismatches | Legacy reverse indexes may require an explicit account ID |
| Shared drafts | Execute a staged, consistent signed invocation | Collaborator records and UI signature counts do not establish chain authorization |
| MultiSig | Chain-ordered child proofs over the same operation, with child-specific signing domains | Threshold counts verifier modules; it does not prove independent humans or custody |
| Session transfers | Exact NEP-17 arguments, proxy sender, nonnegative amount, Boolean success | A token's declared amount does not measure arbitrary additional balance loss |
| Daily limits | Fixed-window accounting and actual net debit, including targets returning false or zero | Token `balanceOf` is a trust dependency; this is not a per-asset universal balance oracle |
| Subscription transfers | Positive amount and successful NEP-17 outcome before consuming a period | Generic non-transfer targets retain their documented return semantics |
| Direct proxy transfer | Derived witness, core scope readback and explicit bounded fee reserve | Relay mode and administrator-configured scope; ordinary wallet invoke APIs cannot add this witness |
| Sponsored execution | Existing policy-checked paymaster execution for supported operations | Sponsored proxy witnesses are refused; arbitrary settlement must not inherit proxy asset authority |
| Operator key recovery | Durable browser key storage and passphrase-encrypted backup | Import requires the draft's already-pinned public key; a link alone cannot replace it |
| Backup-owner escape | Timelock, owner witness, replacement ABI validation and atomic cleanup | A faulting old plugin can block finalization; native authority-epoch recovery is a different profile |

## Plugin names are not full product guarantees

- `WebAuthnVerifier` verifies its documented P-256 proof format. It is not by
  itself a complete WebAuthn ceremony with origin, RP ID and authenticator-data
  validation.
- `TEEVerifier` trusts its registered signing key. A valid signature alone does
  not establish a particular enclave's attestation.
- `ZKEmailVerifier` is disabled; do not offer it as a working account option.
- `ZkLoginVerifier` uses its documented delegated signing path; do not describe
  it as a locally verified general-purpose zero-knowledge login proof.
- Social recovery's plugin owner and the core backup owner are separate state.
  Updating one is not evidence that the other changed.

## Validation and release

Run `scripts/verify_repo.sh` for contracts, frontend, browser, SDK consumers and
dependency audits. Run the formal and private-chain gates with their required
tools, and inspect their recorded scope and skipped checks. The build comparison
must cover both `contracts/bin/v3` and `contracts/bin/platform`.

The separate [native VM workflow](../.github/workflows/native-profile.yml) builds a
reviewed immutable core commit and two identical native module copies, then checks
the complete measured composite scenario matrix with the actual native VM. It
rejects missing, duplicate, unknown, failed or over-budget cases; synthetic
transaction signers make this a host test, not mempool or block confirmation.
NativeEpochProbe in the ordinary gate uses a test-only epoch service and is a
different test boundary. Full-node SDK/private-chain receipts remain separate.
Historical reports retain the commits and bytes they tested; a later test-only
core commit does not change the production runtime identity recorded there.

Before a public rollout, compare every deployed artifact and authorization binding
with the reviewed source; exercise account creation, configuration, transfer,
failure rollback, recovery and fee settlement on the intended runtime. User wallet
signing and public-chain deployment are separate operational steps.

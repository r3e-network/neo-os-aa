# Recovery and identity read contract

`finalizeEscape` is a timelocked backup-owner operation. Before calling an old
plugin or changing state, every nonzero replacement verifier must pass the same
V3 manifest and capability validation as `confirmVerifierUpdate`. The zero
verifier remains an explicit return to backup-owner authorization.

Recovery is atomic, but its completion depends on the installed verifier and hook
successfully executing `clearAccount`. A destroyed, incompatible, or faulting
plugin can therefore block finalization even after the timelock. This is not an
unconditional recovery guarantee. Ignoring cleanup faults would leave persistent
plugin authority behind; removing that dependency requires a separately designed
authority epoch/revocation boundary and migration of all consumers of plugin state.

The identity UI accepts an explicit account ID, a platform proxy script hash, or
both. It reads only the existing core ABI:

- `getAccountIdByProxy(proxy)` resolves platform-registered accounts. The reverse
  index is not populated for all legacy accounts. A zero result requires an
  explicit account ID; the UI must not substitute the proxy address as the ID.
- `getProxyScriptHash(accountId)` verifies a supplied or resolved ID against the
  requested proxy, when both are available.
- `getVerifier(accountId)` confirms the account exists and obtains its bound
  verifier. Neo RPC returns UInt160 values as little-endian 20-byte stack values;
  the UI converts them to display-order hex before using Hash160 arguments.

The RPC URL and core hash must be configured, and malformed inputs, mismatched
identity, FAULT responses, and malformed stack values fail closed. The `getAccountIdByAddress` and `getVerifierContractByAddress` names are absent from every
deployed manifest: this core exposes no such ABI. Changing
the account, core, or account-ID prefill invalidates pending UI reads so a late
response cannot restore an earlier account's recovery context.

## Current ticket and execution-configuration boundaries

Recovery signatures use the `neodid-recovery-v2` domain and compact-v3 encoding.
New action requests use `neo_n3_action_v4`: compact action-v4 tickets signed
under `neodid-aa-action-v3`, binding the enrolled master nullifier and current
action-authorization epoch. Both paths bind the AA core and raw 20-byte account
ID along with their ticket-specific context; the proxy address is not the raw
account ID. Direct ticket submission re-derives the expected action ID instead
of accepting an unrelated ID solely because its signature matches. Existing
v3 action signatures are accepted only through the legacy manual route with
current-owner and executor witnesses; old Oracle v3 action packets are rejected.
Pre-v4 active sessions require explicit current-owner reauthorization or a new
authorized session. See [action session migration](action-sessions-v4.md).
Tickets issued before raw-account binding remain incompatible; deployment and
in-flight request migration still require an owner-approved plan.

Account configuration calls reject reentry while execution, verification, or a
verifier/hook configuration or execution context is active. This covers plugin
rotation and configuration calls, metadata, escape, and market escrow, so an
arbitrary target cannot reuse the outer operation's backup-owner witness to change
account authority. Direct owner-authorized configuration outside those contexts
remains available.

## A possible authority-epoch recovery design (proposal only)

The current implementation already provides a useful boundary for assets at the
core-derived proxy: `executeUserOp` selects the verifier and hook from core state,
and `verify` accepts Application-phase witness requests only in an active target
context. `canConfigureVerifier` / `canConfigureHook` require a temporary context;
`canExecuteVerifier` / `canExecuteHook` require the active root and immediate
caller. The checks are implemented in `UnifiedSmartWallet.Execution.cs` and
`UnifiedSmartWallet.VerifyContext.cs`; the corresponding module-side checks are
in `VerifierAuthority.cs` and `HookAuthority.cs`.

Those checks do not prove that detaching a module erases all of its authority:

- Existing module configuration is keyed by account ID, without an installation
  generation. `MultiSigVerifier.ClearAccount` and `MultiHook.ClearAccount` invoke
  core dependency cleanup before deleting their own topology. The core calls each
  supported leaf's cleanup from the registered roster or supported legacy-roster
  fallback; a cleanup fault rolls back the operation. This does not establish
  cleanup for unsupported legacy rosters. Reinstallation can still make
  configuration retained by a module relevant again.
- `SocialRecoveryVerifier.VerifyExecution`, `VerifyAdmin`, and the corresponding
  legacy meta-transaction methods read the plugin's own owner/session state.
  They do not require a current core execution context. External integrations
  trusting those methods need their own revocation migration.
- The recovery verifier owns per-account oracle credits. Its cleanup transfers
  funds back to the recorded owner, which is an external call and another reason
  cleanup may fault. Rotating a core pointer cannot recover funds in a plugin.
- Successful execution of an arbitrary module's `clearAccount` is not proof that
  a malicious implementation actually removed its storage.

A versioned implementation should therefore be specified and tested as follows:

1. Store a monotonic authority epoch in a new core storage namespace, retaining
   the existing account ID, proxy address, and nonce-channel history. This avoids
   silently changing the positional serialized `AccountState` layout.
2. Bind each authorized root and child configuration to `(core, accountId,
   epoch, module)`. Core configuration/execution contexts carry the epoch and
   check it against current state on every callback. Epoch-aware modules reject
   retained configuration from an earlier installation. Reinstallation requires
   initialization for the new epoch; a capability marker alone is insufficient.
3. Version operation-signing domains to include the epoch, including session,
   recovery/action tickets, message-signature validation, and sponsored flows.
   Preserve consumed nonces/nullifiers; incrementing a counter only in core state
   cannot invalidate a plugin's old signature if its signed message omits it.
4. A dedicated emergency transition, after the existing timelock and backup-owner
   witness checks, increments the epoch, clears pending configuration and module
   bindings, and selects backup-owner-only authorization. It must reject entry
   during an active operation and avoid all calls to the old modules. Optional
   cleanup and credit withdrawal happen in separate transactions so their failure
   cannot roll back authority revocation.
5. Quarantine legacy module installations after emergency revocation. Permit
   reattachment only through a reviewed epoch-aware migration with initialized
   state. Third-party contracts must consult the canonical current epoch/binding;
   integrations that permanently trust a plugin's standalone answer remain outside
   the core's revocation guarantee.

Required evidence includes a faulting/destroyed/lying cleanup plugin, stale child
configuration, reinstallation, in-flight callback/reentrancy, pre-epoch signatures
on unused nonce channels, oracle callbacks/credits, and byte-for-byte proxy-address
stability. Both public and private runtimes need actual VM/private-chain coverage.
The proposal introduces no current ABI and has not been implemented or deployed.

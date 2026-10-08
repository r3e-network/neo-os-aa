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
identity, FAULT responses, and malformed stack values fail closed. There is no
`getAccountIdByAddress` or `getVerifierContractByAddress` ABI in this core. Changing
the account, core, or account-ID prefill invalidates pending UI reads so a late
response cannot restore an earlier account's recovery context.

## A possible authority-epoch recovery design (proposal only)

The current implementation already provides a useful boundary for assets at the
core-derived proxy: `ExecuteUserOp` selects the verifier and hook from core state,
and `Verify` accepts Application-phase witness requests only in an active target
context. `CanConfigureVerifier` / `CanConfigureHook` require a temporary context;
`CanExecuteVerifier` / `CanExecuteHook` require the active root and immediate
caller. These are defined in `UnifiedSmartWallet.Execution.cs` and
`UnifiedSmartWallet.VerifyContext.cs`; the corresponding module-side checks are
in `VerifierAuthority.cs` and `HookAuthority.cs`.

Those checks do not prove that detaching a module erases all of its authority:

- Existing module configuration is keyed by account ID, without an installation
  generation. `MultiSigVerifier.ClearAccount` and `MultiHook.ClearAccount` remove
  their own topology only, leaving child storage intact. Reinstallation can make
  retained configuration relevant again.
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

# Configuring MultiSig children

Each ordinary verifier requires the pinned AA core to call it with an exact
per-account configuration context. A MultiSig root forwarding to a child cannot
satisfy that check. The core provides a bounded child initialization path:

`callVerifierChild(accountId, childVerifier, method, args)`

- The caller must satisfy the account's backup-owner witness. The account cannot
  be in market escrow or active execution.
- The current root must expose safe `getChildVerifierConfig(accountId)` returning
  its ordered children and threshold. MultiSig implements this from its existing
  `getConfig` state; `getConfig` remains unchanged.
- The target must be a current direct child, with complete V3 lifecycle ABI and
  `authorizedCore()` equal to this core. The root must be bound to this core too.
- Only `setPublicKey(Hash160, ByteArray)` and `setConfig(Hash160, Array, Integer)`
  are accepted, and `args[0]` must equal `accountId`.
- The first call stages the existing pending verifier-call record and returns
  `false`. An identical second call after 24 hours invokes the child. The record
  binds the root, child, method, arguments, ordered topology, and threshold;
  confirmation checks the current topology again. Changed current inputs stage
  a new 24-hour proposal. The same pending slot is shared with `callVerifier`.
- The core grants configuration context to that child only, invokes it directly,
  and clears the context on return. Direct child calls remain unauthorized.

For example, register a MultiSig root with empty verifier params, configure its
root `setConfig` through the existing `callVerifier` timelock, then initialize a
Web3Auth child's `setPublicKey` and a NeoNative child's `setConfig` through separate
`callVerifierChild` proposals. Each proposal uses the full argument list including
the account ID. Existing pending getters report the root module, commitment hash,
and available time.

This path initializes direct children and does not change cleanup, authority
epochs, or ordinary root configuration. A safe getter is an explicit capability,
not an independent trust attestation for arbitrary third-party root code.

## Child execution isolation

MultiSig counts only an actual Boolean `true` as a child's approval. An Integer
`1`, or another truthy VM value from a contract with a misleading manifest, does
not count toward the threshold.

`CallFlags.ReadOnly` limits storage and calls; it does not make VM collections
immutable. MultiSig therefore serializes the original arguments once and
deserializes a separate copy for every child validation and post-execution call.
Post-execution results receive the same snapshot-and-copy treatment. A child
cannot change another child's signed arguments or accounting input through shared
Array, Struct, Map, or Buffer objects.

Arguments and target results must be serializable by Neo StdLib. Interop and
iterator results are unsupported and fail closed; the contract never silently
passes an unsupported shared object to the next child. Snapshot work adds
serialization and per-child deserialization cost; the configured child limit is
ten. The threshold remains a threshold over configured modules, not a guarantee
of distinct human owners or cryptographic signer domains.

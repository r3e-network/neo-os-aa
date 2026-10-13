# Shared draft execution and signature records

An immutable draft stores the operation before signing. Its `transaction_body.clientInvocation` can therefore contain an empty signature and provisional nonce/deadline. A signer stores the completed invocation in `signatures[].metadata.metaInvocation`. Client and relay submission must resolve the same completed invocation; neither a stale body nor the first signature record is an authorization policy.

`frontend/src/features/operations/signedInvocation.js` is the shared selector used by client submission, relay submission, payload availability and relay readiness. For `executeUserOp`, it checks the six-field ABI, binds the core, account, target, method and argument values to every staged invocation of that wrapper, and compares the declared account and active network. The signing nonce and deadline may differ from an unsigned staged placeholder. Conflicting signed nonces, deadlines, bytes or operation bodies cannot be silently preferred.

Signature metadata is untrusted. Declared typed-data fields, domain network magic, verifier, nonce, deadline, argument hash and compact signature must agree with the invocation and record. The standard EIP-712 domain and type schema must match the deployed verifier layout. Before client submission, the core recomputes the hash of the actual arguments; a claimed metadata hash is not sufficient. When the full EVM signature is supplied, the selector also verifies its compact bytes and recovered EVM signer. Opaque proofs and records without typed-data metadata remain subject to the contract verifier; this selector does not establish on-chain validity, current nonce, deadline freshness, verifier policy or cryptographic quorum. Relay preflight and the chain remain authoritative. A failure makes readiness blocked and is reported again before invoking a wallet or relay.

Caller-controlled `signers` in signature metadata are discarded. Only the staged client invocation supplies witness requirements. Metadata-derived client submission requires an existing staged intent anchor and an allowed AA wrapper. Client wallet submission rejects marked proxy-witness operations and transfers whose source matches the staged account proxy, because the wallet invoke API cannot attach the required custom verification script. The relay's separately validated proxy-witness path handles that capability.

## MultiSig boundary

Approval collection tracks distinct requested signer identities with a nonempty signature record. Extra or duplicate records cannot complete a required roster. This is collaboration progress only; `chainQuorumVerified` remains false. The UI must not describe collected records as verified chain quorum.

The current draft schema does not authenticate the MultiSig verifier's child ordering, child ABI, threshold or proof encoding. Distinct complete signed invocations therefore produce an explicit unsupported-aggregation error. Identical canonical copies are deduplicated. Do not concatenate EVM signatures or treat independent signature records as a MultiSig payload. A supported MultiSig flow must first read and authenticate the bound verifier policy, construct its exact aggregate proof and demonstrate execution against that verifier.

Export bundles retain collected records for inspection and recovery; exporting a `meta_invocations` array does not authorize choosing its first entry.

The explicit MultiSig SDK and frontend session API now supports a chain-fetched, pinned verifier configuration, fixed operation context, ordered aggregate proof and on-chain signature simulation. This is separate from generic draft signature collection. See [MultiSig SDK](../MULTISIG_SDK.md).

## Regression coverage

`frontend/tests/draftSignedInvocation.test.js` covers immutable client/relay equivalence, no input mutation, account/core/target/method/argument/network/typed-data mismatches, conflicting signatures and stale signed bodies, signer injection, malformed/unsigned V3 payloads, proxy transfer client refusal, EVM recovery and distinct roster matching. The original regression set failed 15 of 16 cases before the implementation change.

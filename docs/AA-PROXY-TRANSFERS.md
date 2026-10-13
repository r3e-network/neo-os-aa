# Proxy asset transfers

A virtual account holds assets at the hash of its proxy verification script, not at its account ID. The owner or relay witness alone does not authorize an NEP-17 transfer from that address. The relay can construct the additional witness when the operator enables `AA_RELAY_PROXY_WITNESS_ENABLED=1` and configures the account's verify-scope target.

## Exact transaction shape

The transaction has exactly one application call: `core.executeUserOp(accountId, op)` or `core.executeUserOps(accountId, ops)`, each with two arguments. Argument construction may only contain constant pushes and data construction opcodes. The verifier binds the final call to the actual core and actual account ID. Other entrypoints, other cores/accounts, additional calls and control flow are rejected.

Signer 0 is the fee-paying relay with `CalledByEntry`. Signer 1 is the derived proxy, with precisely one `Allow` rule containing `Or(CalledByContract(core), CalledByContract(configuredTarget))`. The proxy witness has an empty invocation script and a verification script consisting of `core.verify(accountId)`. The relay signature covers the complete transaction, including both signers, script and fees. Both witnesses are present during network-fee calculation and final serialization. The proxy is never permitted to pay the enclosing transaction's fees.

The relay derives the script locally, compares its hash with `getProxyScriptHash(accountId)`, and reads `getVerifyScopeTarget(accountId)` from the selected core/RPC. The configured target must equal the token being transferred. Every operation in a batch must name that same target. A scope change racing submission is rejected by transaction verification. Client-supplied signer or witness metadata is not used to construct this authority.

## The SDK builder

The whole transaction is assembled in one place, `shared/proxyWitness.mjs`, and the relay route and the wallet frontend both call it:

- `buildExecuteUserOpScript({ coreHash, accountId, invocation })` emits the shape-bound script. It refuses every entrypoint other than `executeUserOp`/`executeUserOps`, a wrong core, a wrong account, a wrong argument count and an empty batch, so the bytes it produces can only be the one application call. Its Neo VM push encoder is pinned by test to be byte-identical to the node's own assembler (`neon-js sc.createScript`) for single, batch and nested-argument invocations.
- `buildProxyWitnessTransaction({ coreHash, accountId, invocation, scopeTarget, expectedProxyHash, feePayer, … })` returns the script, the fee-payer signer, the restricted `WitnessRules` proxy signer and the proxy verification witness, in that signer order. It refuses an absent or all-zero `scopeTarget` with `PROXY_SCOPE_TARGET_REQUIRED`, a scope target that is the core, a scope target that is not the transferred token, mixed targets in a batch, and a fee payer that is the proxy.
- `resolveProxyWitnessTransaction({ …, readState })` performs the same build after reading `scopeTarget` and `expectedProxyHash` through an injected reader. The reader must be the submitting core/RPC; no caller can pass those two values in from request metadata.
- `buildProxyWalletSignRequest({ transaction, scope, allowedContracts })` is the browser-wallet signing path. It re-expresses the fee payer in a custom scope — `CustomContracts` with an explicit allowlist, or `Global` — while the proxy keeps its restricted rules and its witness.

`sdk/js/src/proxyWitness.js` re-exports the module, so the SDK carries the same builder. The frontend vendors a byte-identical copy under `frontend/src/shared/` (enforced by `frontend/tests/transferOutcomeShared.test.js`).

The local-chain scenario `AA-12` drives this builder end to end on the deployed core: a throwaway key that is not the contract admin registers an account, pays the fee and moves exactly 1 GAS out of the account's proxy address from a transaction the SDK built, and the same builder refuses an account the admin never scoped before any transaction exists. The receipt records the built script, both signers and the wallet signing request.

## Fee estimation

Published Neo RPC omits custom nonempty verification scripts in `calculatenetworkfee`: its estimate excludes the proxy's VM verification cost and serialized witness bytes. Proxy mode therefore also requires a positive `AA_RELAY_PROXY_NETWORK_FEE_RESERVE` in datoshi and a network or total fee ceiling. The relay adds this operator-selected reserve to the RPC estimate before enforcing every existing cap.

This is a bounded operational reserve, not an automatic exact fee estimate. An insufficient reserve is rejected by the node; an unnecessarily large reserve pays an unnecessarily large network fee. Operators must validate it against their node, script sizes and accepted operation families. The private-chain acceptance uses a 2 GAS reserve for its tested direct transfer. That test value is not a recommendation for a public deployment.

The relay preserves explicit unsponsored opt-in, off-chain sponsorship approval binding, and system/network/total fee ceilings. A token transfer returning Boolean false is refused during preflight and again during fee estimation. No transaction is broadcast after a failing preflight or exceeded ceiling.

## Sponsorship boundary

**Proxy transfers through `executeSponsoredUserOp` and `executeSponsoredUserOps` remain disabled.** The contract's Verification entrypoint refuses these envelopes, and the relay explicitly refuses proxy transfers using either entrypoint before calculating fees or signing a transaction for broadcast.

A transaction witness survives after `executeUserOp` clears its hook and verification context. Current sponsorship accepts a paymaster based on its self-reported `authorizedCore`; that is not an independent trust decision. If settlement invokes a contract covered by the proxy witness scope, that authority could be reused outside the signed operation's hook accounting. Supporting sponsored proxy transfers therefore needs a reviewed design for paymaster authority and witness lifetime. Passing an ordinary paymaster happy-path test is insufficient.

Direct proxy transfers can still use an off-chain relay sponsorship policy: the transaction itself remains a single `executeUserOp(s)` call, and the fee-paying relay is not reimbursed by an on-chain settlement callback.

## Wallet behavior and acceptance

The NEP-17 preset can stage a proxy transfer in relay mode. The staged operation records that a proxy witness is required. The client path now builds the complete proxy-witness transaction with the SDK builder (`buildClientProxyWitnessTransaction`) and carries its custom-scope wallet signing request, so a wallet that signs a built transaction can complete the move: the dApp asks the wallet to sign the transaction as the fee payer and attaches the proxy verification witness itself. Ordinary wallet `invoke` APIs broadcast their own transaction and cannot carry a verification script they did not create, so `executeBroadcast` still refuses to send through such a wallet rather than submit a transfer that would return false and still burn the fee; imported drafts receive the same check at client broadcast. The wallet end-to-end path (a wallet shim on the local chain) is tracked separately. A relay without the feature enabled retains its previous behavior and refuses a standard token transfer that lacks a valid witness.

The configured scope remains an administrator-managed prerequisite. This change does not make arbitrary accounts self-service for scope configuration or activate a native SmartAccount profile.

The current-source private-chain scenario `SRC-09` verifies a real direct transfer's balances, nonce, unchanged owner balance, fee payer, exact signer rules and proxy script. It also verifies invalid signatures, missing/insufficient fee reserves, exceeded network ceilings, relay sponsorship refusal, and node rejection of sponsored envelopes. Its receipt gate rejects missing or altered raw state/transaction evidence. Historical deployed-artifact expectations remain separate.

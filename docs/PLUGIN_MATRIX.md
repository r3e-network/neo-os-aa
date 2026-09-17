# V3 Testnet Plugin Matrix

Date: 2026-03-13
Network: Neo N3 Testnet (`894710606`)
Executor address: `NTmHjwiadq4g3VHpJ5FQigQcD4fF5m8TyX`

Refresh note on 2026-03-15:

- the current shared testnet AA core is now `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2`
- the current shared testnet `Web3AuthVerifier` anchor is now `0x7147f9a508594a7656a25f45d0a7a7dede7c227f`
- the deployment set below is preserved as the historical matrix run environment

This report records the V3 verifier/hook matrix that was executed on testnet after hardening the current branch.

## Pre-Matrix Security Fixes

Before running the matrix, the following issues were fixed in the branch:

- Added `ContractPermission("*", "*")` to the V3 core and plugin contracts so runtime `Contract.Call` paths can actually execute on-chain.
- Fixed `Web3AuthVerifier` typed-data struct encoding so `nonce` and `deadline` are encoded as canonical `uint256` words.
- Added `computeArgsHash` to the V3 core contract because the frontend and SDK already depended on it.
- Fixed the frontend/shared-draft V3 deadline to use milliseconds, matching `Runtime.Time`.
- Fixed the frontend V3 EVM path to compact 65-byte EIP-712 signatures into 64-byte `r||s`.
- Fixed `TEEVerifier`, `WebAuthnVerifier`, and `SessionKeyVerifier` to verify the raw payload with `secp256r1SHA256` instead of double-hashing.
- Added `getPayload()` helpers to `TEEVerifier`, `WebAuthnVerifier`, and `SessionKeyVerifier` so signers and test tools can obtain the exact on-chain payload bytes.
- Changed `SessionKeyVerifier` expiry from `uint` to `BigInteger`.
- Hardened `SubscriptionVerifier` with deterministic salt-mode period nonces so a billing period cannot be replayed.
- Disabled `ZKEmailVerifier` because the previous placeholder accepted arbitrary non-empty blobs and was not production-safe.
- Added `MockTransferTarget` for transfer-oriented hook validation without depending on real token balances.

## Deployment Set

The main deployment set used for the full matrix run was:

- Core: `0x9cbbfc969f94a5056fd6a658cab090bcb3604724`
- Web3AuthVerifier A: `0xf7337238602066ec0f6d89e6305f8e945b99224b`
- Web3AuthVerifier B: `0x0a9141e587d31f50e37557c2ae0d06918a5bf360`
- TEEVerifier: `0x07586f52b3a37cf528c4b3954f3f3aaff40256f2`
- WebAuthnVerifier: `0x08d7b9b7e101f7ad5c369864df9f1b519af91539`
- SessionKeyVerifier v2: `0x63d6a10d388dd4885bc42ba69593734476f47151`
- MultiSigVerifier: `0x11d1012e071fac7fd75569981ac44da097913a84`
- SubscriptionVerifier: `0xaaad17cff9bf9a799e9f1c5e7645267948a11d53`
- ZKEmailVerifier: `0x018bb68bfe6a44a52c938d8dc0002a2d5137b693`
- WhitelistHook: `0xb815609a34fa014ee7c7646bc9638a358eb412c5`
- DailyLimitHook: `0x13f0ed3b0a8c12cc7f9cb9171ae4f829094b976c`
- TokenRestrictedHook: `0x7f195bef087b3507fc83856f21f3513228a96b05`
- MultiHook: `0x65ec99dfa6497389c8a4876cf6a31c25e697359d`
- NeoDIDCredentialHook: `0x4c103d420bb284fa8ab8f8e71a6a46cdead16dc3`
- MockTransferTarget: `0x7796c0ad0d871f4a04ac146750e50cc556771ba6`

## Attack Surface Guards

Direct configuration attacks against plugin contracts were tested and correctly failed:

- `WhitelistHook.setWhitelist(...)` direct external call: `FAULT`
  - Exception: `System.Contract.Call failed ... not found`
- `Web3AuthVerifier.setPublicKey(...)` direct external call: `FAULT`
  - Exception: `System.Contract.Call failed ... not found`

These failures confirm that configuration must still enter through the V3 core context rather than direct external calls.

## Verifier Matrix

### Web3AuthVerifier

- Positive execution tx: `0xfb89094def5d802790dbed1703305023f4c59d8fba3afab7d254a0e67df25b40`
- Result: `MOCK`
- Attack: tampered method/signature payload
  - Result: `FAULT`
  - Reason: `Verifier rejected signature`
- Attack: replaying the same nonce
  - Result: `FAULT`
  - Reason: `Invalid sequence for channel`

### TEEVerifier

- Positive execution tx: `0x94afeea721ed3e32d18ee0e443bde2550bdc3d000e4fe2b719a9cb21dbfc5174`
- Result: `MOCK`
- Attack: tampered signed method
  - Result: `FAULT`
  - Reason: `Verifier rejected signature`

### WebAuthnVerifier

- Positive execution tx: `0x8ce658952ef9f81e5080d15669c2f24a60595149b495c5834bdb69474521bb37`
- Result: `MOCK`
- Attack: tampered signed method
  - Result: `FAULT`
  - Reason: `Verifier rejected signature`

### SessionKeyVerifier

- Positive execution tx: `0x200885231998aa0a4a76f0049f5cc9aa2bf373ef955ed3f566f2c87120ebd2ab`
- Result: `MOCK`
- Attack: invoke a non-authorized method with the same session key
  - Result: `FAULT`
  - Reason: `Method not permitted`
- Attack: configure an already-expired session key
  - Result: `FAULT`
  - Reason: `Session key must expire in the future`

### MultiSigVerifier

- Positive execution tx: `0xa652cd351cb9a656770967874faf5ada8abe47a9d5a0f30499218cc289620445`
- Result: `MOCK`
- Attack: one valid signature plus one invalid sub-signature
  - Result: `FAULT`
  - Reason: `Verifier rejected signature`

### SubscriptionVerifier

- Positive execution tx: `0x6fb033541403164bb66bcdcf58c3c28a76096d74a3da99145d756d8ee402394b`
- Attack: amount exceeds configured subscription amount
  - Result: `FAULT`
  - Reason: `Transfer amount exceeds subscription`
- Attack: replay the same billing-period nonce
  - Result: `FAULT`
  - Reason: `Salt already used`

Note:
- The matrix originally failed when `periodSeconds` was set to `1`, because the expected nonce could cross into the next period between local construction and on-chain evaluation.
- The successful replay-protected test used a safer test period (`60` seconds) so the billing period stayed stable during transaction submission.

### ZKEmailVerifier

- Positive path intentionally disabled.
- Attack / misuse test: non-empty fake proof blob
  - Result: `FAULT`
  - Reason: `ZKEmailVerifier disabled pending real proof verification`

Conclusion:
- This verifier is intentionally blocked from production use until an actual proof-verification implementation exists.

## Hook Matrix

### WhitelistHook

- Positive execution tx: `0xb94465e7a15a2fa249487b70b7573962520792d7add2bde689a4a804b7ca4033`
- Result: `MOCK`
- Attack: call non-whitelisted target
  - Result: `FAULT`
  - Reason: `Target contract not in whitelist`

### DailyLimitHook

- Positive execution tx: `0x235f8b95d773ff3d30e85cca65f932cf0576acbb3753029047b8903787e1d71f`
- Attack: exceed remaining limit after an earlier successful transfer
  - Result: `FAULT`
  - Reason: `Daily limit exceeded`

### TokenRestrictedHook

- Positive execution tx: `0x11e254bd1b98433728ded9fdce9969e1505bbdc54abccb521d6e0c9cf6712c98`
- Result: `GAS`
- Attack: invoke a restricted target
  - Result: `FAULT`
  - Reason: `Interaction with restricted token is forbidden`

### MultiHook

- Positive execution tx: `0x464f5b8ea6f4fe091b2cfcc54dc110aad9dbb37d0207fa8c1021ee718a7d22e3`
- Attack: target is allowed by whitelist but denied by the restricted-token hook
  - Result: `FAULT`
  - Reason: `Interaction with restricted token is forbidden`

Conclusion:
- Hook composition preserved the stronger denial path when multiple hook policies applied to the same operation.

### NeoDIDCredentialHook

- Positive execution tx: `0x0128360207bc4bfdba2dac49a06f720aaa0f7037cb2261992ad13bfa26121d2b`
- Registry-backed configuration:
  - `setRegistry(neoDidRegistryHash)`
  - `requireCredentialCommitmentForContract(accountId, target, provider, claimType, claimCommitment)`
- Positive path:
  - register a real binding on `NeoDIDRegistry`
  - execute the gated target successfully
- Attack: invoke credential-gated target without an active registry binding
  - Result: `FAULT`
  - Reason: `NeoDID Credential Missing`
- Attack: invoke after registry revocation
  - Result: `FAULT`
  - Reason: `NeoDID Credential Missing`

## Overall Status

Passed on testnet:

- Web3AuthVerifier
- TEEVerifier
- WebAuthnVerifier
- SessionKeyVerifier
- MultiSigVerifier
- SubscriptionVerifier
- WhitelistHook
- DailyLimitHook
- TokenRestrictedHook
- MultiHook
- NeoDIDCredentialHook

Intentionally disabled:

- ZKEmailVerifier

Security conclusion:

- The production-capable plugin set now resists the tested direct-config, signature-tampering, nonce-replay, method-scope, amount-limit, restricted-target, and credential-revocation attack scenarios.
- The previous placeholder `ZKEmailVerifier` is no longer silently permissive and is now blocked until a real proof verifier is implemented.

## Paymaster Compatibility

All production-capable verifiers and hooks in the matrix above are fully compatible with the on-chain `AAPaymaster` contract via `executeSponsoredUserOp`. The Paymaster operates at the core execution layer: relays can preflight `ValidatePaymasterOp` off-chain, while the on-chain path delegates to the standard `executeUserOp` flow (which runs the configured verifier and hooks) and then settles the relay reimbursement atomically. No plugin modifications are required.

Compatible combinations include:
- **Web3AuthVerifier + DailyLimitHook + Paymaster** — EVM wallet users with spending limits, gas-free
- **SessionKeyVerifier + WhitelistHook + Paymaster** — delegated game sessions with whitelisted contracts, sponsored
- **MultiSigVerifier + MultiHook + Paymaster** — threshold-approved DAO treasury ops, gas-free for signers
- **TEEVerifier + Paymaster** — automated agent operations fully sponsored by the deploying organization

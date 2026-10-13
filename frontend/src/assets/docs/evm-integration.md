# Ethereum / EVM Integration

The Abstract Account contract natively supports Secp256k1 + Keccak256 verification so Ethereum wallets can authorize Neo execution via EIP-712 typed data.

## Testnet Path

The canonical shared testnet AA core is `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2`; the
generated `frontend/src/config/generatedMorpheusRegistry.js` is the source of that anchor and the
repository README restates it. Point the client there unless you are deliberately overriding it:

- `executeUserOp(accountId, op)` succeeds with a valid EVM signature (the account's verifier runs
  the typed-data path)
- stale nonces, expired deadlines, wrong chain IDs, wrong verifying contracts, and tampered
  `argsHash` values are rejected

The V1/V2 wrappers `executeUnified` and `executeUnifiedByAddress` were removed. No deployed manifest
and no contract source in this repository defines them, so the earlier "hardened testnet
deployment" that the examples here used (`0x5be915…`) is a V1/V2 core and cannot carry a V3
invocation.

## Signing Flow

1. Build the EIP-712 payload from the Neo execution intent.
2. Sign it in MetaMask or another EVM wallet.
3. Relay the signature to Neo through `executeUserOp` (or `executeUserOps` for a batch).
4. Let the Abstract Account contract recover the signer and enforce runtime restrictions before calling the target contract.

## Important Hardening Note

A deterministic proxy witness alone is no longer enough to authorize a raw external contract call. The proxy witness is restricted to a single self-call back into the Abstract Account contract, so EVM signatures must ultimately drive the AA wrapper entrypoint `executeUserOp`, where the policy checks are enforced.

# Morpheus Private Actions & NeoDID Binding (V4 Architecture)

Under the v4 Smart Account architecture the kernel stays minimal: authorization and policy are **module instances** (`validator` and `hook`) installed through configuration intents, and recovery is delegated to an installed `SocialRecoveryService` instead of a bound verifier field. The Neo Smart Account system still integrates with the **Morpheus TEE Environment** to enable Private Actions, session keys, and NeoDID bindings.

## How It Works

Morpheus provides a **Trusted Execution Environment (TEE)** built on AWS Nitro Enclaves. This off-chain, secure enclave acts as a co-signer or policy enforcer without exposing the logic to the public chain; the account verifies the enclave attestation with the `TeeKeyValidator` module.

The process flows exclusively through the `TeeKeyValidator` module, `NeoDIDCredentialHook`, and the on-chain `NeoDIDRegistry`.

### 1. NeoDID Binding via Web3Auth
Users can bind their NeoDID to their Smart Account. This allows a user to authorize actions via their social accounts (Google, Discord, etc.) through Web3Auth, which resolves to a NeoDID signature.

- **Frontend:** User authenticates via Web3Auth.
- **Enclave:** The Morpheus Enclave validates the Web3Auth token and signs an authorization payload.
- **Contracts:** the Oracle / NeoDID flow writes a binding into `NeoDIDRegistry`, and `NeoDIDCredentialHook` checks that registry binding before allowing the gated action.

### 2. Private Actions & Privacy Policies
For actions where the policy (e.g., daily limits, whitelisted addresses, or conditional logic) shouldn't be publicly visible on-chain:

1. The user defines their policy and stores it privately within the Morpheus TEE node.
2. When the user wishes to execute a transaction, they send the intent to the TEE node.
3. The TEE node evaluates the private policy.
4. If approved, the TEE node signs the channel and exact next sequence in the bounded nonce domain, or a direct transaction hash.
5. The `TeeKeyValidator` module on N3 validates the enclave's hardware-level signature before allowing the operation to proceed.

### 3. Session Keys
Session keys let an application submit transactions on behalf of the user without prompting for a signature every time, bounded by limits enforced by the TEE.

- A temporary keypair is generated and installed as a `SessionKeyValidator` instance.
- The TEE signs a certificate binding the temporary key to specific limits (e.g., time, token amounts).
- The `SessionKeyValidator` instance checks the certificate and processes the operation as long as the session constraints are met.

## Verification Flow (V4)
1. **Prepare:** The client builds the operation (13-field v4 intent) and gathers standard N3/EVM signatures.
2. **TEE Signature:** The client requests the Morpheus Enclave to evaluate the private policy. The Enclave returns an `ActionTicket`.
3. **Execute:** The operation is submitted. The account runs its installed validators in module order, and `TeeKeyValidator` authenticates the Enclave's signature, validating the off-chain private rules.

By keeping policy logic inside the TEE and installing only validator modules on-chain, the v4 kernel reduces gas costs and deployment complexity while retaining robust privacy and NeoDID support.

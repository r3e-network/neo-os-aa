# Morpheus Private Actions & NeoDID Binding (V3 Architecture)

Under the V3 Unified Smart Wallet architecture, heavy on-chain components (like Oracle Dead-man switches and Social Recovery) have been removed in favor of the lightweight **L1 Native Escape Hatch**. However, the Neo Abstract Account system still seamlessly integrates with the **Morpheus TEE Environment** to enable Private Actions, Session Keys, and NeoDID bindings.

## How It Works

Instead of storing recovery state on-chain, Morpheus provides a **Trusted Execution Environment (TEE)** using Intel SGX / TDX. This off-chain, secure enclave acts as a co-signer or policy enforcer without exposing the logic to the public chain.

The process flows exclusively through the `TEEVerifier`, `NeoDIDCredentialHook`, and the on-chain `NeoDIDRegistry`.

### 1. NeoDID Binding via Web3Auth
Users can bind their NeoDID to their Abstract Account. This allows a user to authorize actions via their social accounts (Google, Discord, etc.) through Web3Auth, which resolves to a NeoDID signature.

- **Frontend:** User authenticates via Web3Auth.
- **Enclave:** The Morpheus Enclave validates the Web3Auth token and signs an authorization payload.
- **Contracts:** the Oracle / NeoDID flow writes a binding into `NeoDIDRegistry`, and `NeoDIDCredentialHook` checks that registry binding before allowing the gated action.

### 2. Private Actions & Privacy Policies
For actions where the policy (e.g., daily limits, whitelisted addresses, or conditional logic) shouldn't be publicly visible on-chain:

1. The user defines their policy and stores it privately within the Morpheus TEE node.
2. When the user wishes to execute a transaction, they send the intent to the TEE node.
3. The TEE node evaluates the private policy.
4. If approved, the TEE node signs a "Salt Nonce" or a direct transaction hash.
5. The `TEEVerifier` contract on N3 validates the enclave's hardware-level signature before allowing the transaction to proceed.

### 3. Session Keys
Session Keys allow an application to submit transactions on behalf of the user without prompting for a signature every time, bounded by limits enforced by the TEE.

- A temporary keypair is generated.
- The TEE signs a certificate binding the temporary key to specific limits (e.g., time, token amounts).
- The `TEEVerifier` checks the certificate and processes the transaction as long as the session constraints are met.

## Verification Flow (V3)
1. **Prepare:** The client builds the transaction and gathers standard N3/EVM signatures.
2. **TEE Signature:** The client requests the Morpheus Enclave to evaluate the private policy. The Enclave returns an `ActionTicket`.
3. **Execute:** The transaction is submitted. The Unified Smart Wallet delegates validation to the `TEEVerifier`, which successfully authenticates the Enclave's signature, validating the off-chain private rules.

By keeping policy logic inside the TEE and eliminating the legacy on-chain Oracle Dead-man switch, the V3 architecture significantly reduces gas costs and deployment complexity while retaining robust privacy and NeoDID support.

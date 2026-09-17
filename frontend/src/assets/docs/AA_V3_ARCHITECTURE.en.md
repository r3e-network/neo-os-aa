# Neo N3 Abstract Account V3 Historical Design Note

> This document is a historical design note from the V3 design phase. The current runtime contract surface is documented in `README.md`, `docs/architecture.md`, and the frontend architecture docs.

## 1. System Macro Positioning
This design note described the intended V3 direction: unify heterogeneous identities (Web2 social accounts, Web3 DIDs), heterogeneous signatures (EVM, Passkey), and high-privacy computing environments (TEE) behind a single Neo account runtime.

---

## 2. Core Ecosystem Matrix

The entire architecture is divided into five core layers:

### 1. Multi-dimensional Identity Layer (Identity & DID)
Solves the "Who am I?" problem. This layer does not enforce strong bindings on-chain but uses cryptographic proofs to map identities from different ecosystems to a virtual account (`AccountId`) on Neo N3.
* **NeoDID Integration**: Binds a user's Neo N3 `AccountId` to the W3C standard `did:neo:xxx`. Allows storing the hash of the DID Document resolver in the account state, enabling direct mounting of on-chain reputation, SBTs (Soulbound Tokens), and KYC credentials.
* **Web2 Identity Mapping**: Maps identities like Twitter/Google to specific EVM or Passkey public keys via Web3Auth (MPC mechanism) or standard OAuth.
* **Federated Proofs**: Whether it's a cross-chain address or a social media handle, it ultimately converges into a verifiable public-private key pair used to control the AA account.

### 2. Off-chain Trusted Execution & Relayer Layer
Solves the "Who proves, and who pays?" problem.
* **Morpheus TEE Nodes (Trusted Execution Environment)**:
  * **Privacy Policy Computation**: Complex "deadman's switch" conditions (e.g., checking an API to confirm 180 days of inactivity) or high-frequency automated trading intents are calculated within the TEE's Intel SGX/TDX enclave.
  * **Hardware-grade Signatures**: Once the TEE confirms conditions are met, it issues instructions using its hardware private key. This means the most complex logic no longer consumes expensive on-chain GAS.
* **Session Key Issuers**: Upon user login, the TEE or frontend issues a high-frequency temporary session key (e.g., restricted to infinite attacks in a fully on-chain game for 1 hour).
* **Bundler & Paymaster**:
  * Official or third-party operated nodes. They receive the user's `UserOperation` (containing various signatures) and package them into standard N3 transactions.
  * **On-Chain Paymaster (`AAPaymaster`)**: Sponsors deposit GAS and create sponsorship policies (per-account or global, with per-op/daily/total budgets, target/method restrictions, and expiry). The AA core calls `executeSponsoredUserOp`, validates the policy, executes the UserOp, then atomically settles the reimbursement — deducting from the sponsor deposit and sending GAS to the relay. This is fully trustless and verifiable on-chain.
  * **Off-Chain Paymaster (Morpheus)**: If the operation falls under an allowlisted sponsorship policy, the Bundler can request Morpheus pre-authorization before broadcasting. This is an operational convenience, not an authorization boundary.

### 3. Core Gateway Engine
The heart of the system and the only Neo N3 contract that stores state. It employs a **Global Singleton** pattern, providing users with a shared runtime and deterministic virtual accounts.
* **Zero-Deployment Virtual Accounts**: Utilizing Neo N3's unique dynamic scripting and `VerifyContext` locking mechanisms, it generates a virtual address for each user that can receive funds and pass `CheckWitness` authentication without needing to be physically deployed.
* **Minimalist State Storage**: Only stores the account's `Verifier ID`, `Hook ID`, and L1 Escape Hatch state.
* **Hybrid Replay Routing**: Intelligently decides between a standard sequential queue (for DeFi) or a random salt Bitmap (for high-frequency TEE concurrency) based on the Nonce value.
* **Intent Engine (Intent & Batch)**: Supports single calls, array batching, and even the direct submission of NeoVM bytecode containing logic.

### 4. Heterogeneous Verifier Plugin Ecosystem
Solves the "How to verify signatures?" problem. Verifiers dictate "who has the right to use the vault." They are pre-deployed, **Stateless**, pure-computation singleton contracts. The following 7 core Verifiers form the foundation of the system:
* **Web3Auth / EIP-712 Verifier (Traffic Funnel)**:
  * The primary EVM-compatibility verifier in the current V3 runtime.
  * Directly receives Ethereum-standard EIP-712 Typed Data Hashes and `v, r, s` signatures.
  * Internally uses N3's underlying `CryptoLib.VerifyWithECDsa` (for the secp256k1 curve) and custom Keccak256 to perfectly replicate Ethereum signature verification. Allows MetaMask users to seamlessly control N3 assets.
* **TEE / AI Agent Verifier (Privacy & Automation Center)**:
  * Bound to a specific hardware public key. As long as the `UserOperation` carries the TEE node's signature, it is considered approved (because complex business logic has already been pre-screened within the TEE).
* **Session Key Verifier (High-frequency Interaction Tool)**:
  * Provides temporary authorization keys for short-lived, high-frequency interactions (like fully on-chain games or high-frequency trading), supporting fine-grained permission scopes and expiration times.
* **WebAuthn / Passkey Verifier (Native Biometrics)**:
  * Leverages the `secp256r1` curve to verify hardware-backed biometrics (iOS FaceID, Android Fingerprint, YubiKey).
  * Enables a passwordless, hardware-grade secure login experience directly from standard mobile devices.
* **ZK-Email Verifier (Zero-Knowledge Email Proof)**:
  * Verifies Zero-Knowledge proofs generated from standard DKIM email signatures.
  * Allows users to recover accounts, approve large transactions, or execute operations simply by sending an email, without exposing their email content on-chain.
* **Multi-Sig / Threshold Verifier (Heterogeneous Multi-sig)**:
  * Supports complex, heterogeneous threshold signature schemes (e.g., 2-of-3 requiring an EVM signature, a Passkey, and a TEE signature).
  * Ideal for DAO treasuries or high-security institutional vaults.
* **Time-based / Subscription Verifier (Auto-subscriptions)**:
  * Facilitates recurring payments and SaaS-like subscription models.
  * Allows pre-authorized delegates to pull a specific amount of funds at predefined intervals without requiring the user to be online.

**Built-in cold wallet fallback**:
* The native N3 fallback solution is built directly into the gateway. If no external Verifier is configured (Verifier == `UInt160.Zero`), it falls back to solely checking `Runtime.CheckWitness`. This provides a secure backdoor for traditional N3 software/hardware cold wallets to ensure absolute control over underlying assets while saving GAS (no cross-contract call required).

### 5. Policy & Risk Control Plugin Ecosystem (Hooks / Middleware)
Solves the "Can this be executed?" problem. Hooks dictate "how the money can be spent." These are business rule mounting points executed before/after operations. It includes 5 core Hooks:
* **MultiHook**: Allows combining multiple Hooks to implement complex hybrid risk control policies (e.g., requiring both a whitelist and a daily limit simultaneously).
* **DailyLimitHook**: Risk control for large daily transfers.
* **WhitelistHook**: Restricts the account to interact only with trusted smart contracts.
* **TokenRestrictedHook**: Restricts the account to operate only on specific types of tokens (e.g., only transferring a certain game token).
* **NeoDIDCredentialHook**: Verifies if the account has an active matching NeoDID binding on the on-chain `NeoDIDRegistry` before executing certain DeFi operations.

### 6. User-Composable Killer Solutions ("Lego" Architecture in Practice)
Through the Lego-like composability of Verifiers and Hooks, the V3 architecture natively supports several highly commercially valuable account models:

* **Solution A: Web2 Seamless Account (Default Configuration)**
  * **Combination**: Web3Auth Verifier + Empty Hook
  * **Scenario**: Lowers the barrier to entry for Web3. Users log in with Web2 social accounts to generate an account with no transfer restrictions.
* **Solution B: "Bear Market DCA" Vault (Combined Risk Control)**
  * **Combination**: Built-in cold wallet fallback + DailyLimitHook + WhitelistHook (via MultiHook)
  * **Scenario**: Uses an extremely secure hardware cold wallet for control, while restricting daily outbound transfers to a small amount and only allowing interaction with specific DCA (Dollar Cost Averaging) or DeFi staking contracts.
* **Solution C: AI-Managed Quant Fund (Intent-Driven)**
  * **Combination**: TEE / AI Agent Verifier + Max Drawdown Hook (or NeoDIDCredentialHook / Custom Hook)
  * **Scenario**: Funds are delegated to an AI agent running inside a TEE. The AI trades automatically based on market signals, but Hooks strictly enforce a maximum drawdown limit or restrict participation to KYC-compliant pools.
* **Solution D: Fully On-chain Game / Esports Gold Farming Account**
  * **Combination**: Session Key Verifier + TokenRestrictedHook
  * **Scenario**: Gaming guilds issue Session Keys to power-levelers, restricting them to high-frequency in-game operations and the transfer of specific in-game reward tokens, preventing them from touching the vault's core assets.

---

## 3. Security Architecture: L1 Native Escape Hatch

Considering extreme scenarios like TEE downtime, MPC node failure, or Web2 service provider collapse, a non-custodial baseline must be maintained.
This architecture completely abandons the attack-prone and extremely GAS-heavy Oracle deadman's switch, replacing it with a **Time-locked Preemption Model**:

1. **Setup Backup**: The user sets a physical cold wallet address (Native N3 address) as the `BackupOwner` within TEE/Web3Auth and sets a 30-day `Timelock`.
2. **Initiate Escape**: If the TEE/Web2 service goes down, the user initiates `InitiateEscape` via the gateway using the cold wallet, starting a 30-day on-chain countdown.
3. **Anti-Theft Cancel**: A pending escape is **not** silently auto-cancelled by routine activity — that design would let an attacker who triggers a malicious escape keep the countdown frozen indefinitely. On-chain (`UnifiedSmartWallet.Execution.cs`), an active escape is cancelled only by an operation authorized by the `BackupOwner` itself (`Only backup owner can cancel escape`), so the user stays in control and the attacker's attempt dies with the countdown. If the cold wallet is stolen and a hacker triggers the escape, the user receives an alert on their mobile App and cancels the pending escape with a backup-owner-authorized action from a key they still control.
4. **Finalize Takeover**: If the escape window elapses without a backup-owner-authorized cancellation, the cold wallet gains supreme authority and resets the entire AA account's Verifier plugin, achieving absolute L1 asset sovereignty.

---

## 4. Core Workflow: Perfect Fusion of Multi-dimensional Protocols (End-to-End Flow)

Here is an example of a **"Web2 player using TEE relay to play an N3 fully on-chain game Gaslessly"** to demonstrate how the components mesh like gears:

**Phase 1: Identity Establishment & Authorization (NeoDID + Web3Auth + TEE)**
1. The user logs in to the frontend using Google (Web3Auth), generating an Ethereum EIP-712 key pair.
2. The frontend requests the NeoDID registry service, linking the Ethereum public key with `did:neo:xxx`, and obtains the corresponding N3 virtual account address (`AccountId`).
3. The user signs an EIP-712 authorization: "I allow TEE node 0xABC to use up to 100 GAS for gaming over the next 24 hours."

**Phase 2: High-Frequency Game Actions (TEE + Salt Nonce)**
1. The player clicks "Attack" in the game.
2. The request is sent to the TEE node. The TEE node verifies in its memory enclave: authorization is valid, not expired, and not over budget.
3. The TEE node uses its own hardware private key to construct a `UserOperation` and signs the transaction.
4. **Critical Optimization**: To prevent Nonce collisions from high-frequency clicking, the TEE populates the `UserOp` with a UUID acting as a **Salt Nonce**.

**Phase 3: Gasless On-chaining (Bundler + Paymaster)**
1. The TEE packages the signature to the game's official Bundler.
2. The Bundler, acting as the true initiator on N3, pays the N3 NetworkFee/SystemFee out of pocket and pushes the TEE-signed operation into the AA gateway.

**Phase 4: Minimalist Routing & Execution (AA Gateway + Hooks)**
1. **Replay Check**: The AA gateway verifies the UUID Salt is unused, then marks it as used.
2. **Short-circuit Auth**: The AA gateway routes the data directly to the `TEE Verifier` plugin. Hardware signature verification passes instantly.
3. **Security Interception**: The AA gateway verifies the account is not currently locked in an `Escape Hatch` countdown.
4. **Policy Hook**: Calls the `NeoDID Credential Hook` to ensure the player's reputation score is normal.
5. **Proxy Masking**: Mounts the `VerifyContext` lock and dynamically invokes the target game contract.
6. **Success**: The game contract's reverse `CheckWitness` on the virtual address succeeds, recording the player's state.

---

## 5. Architectural Notes

1. **Fusion, not Rejection**: Through the `EIP-712 Verifier`, it perfectly absorbs Ethereum ecosystem developers and existing wallet toolchains; through the `TEE Verifier`, it shifts complex business logic (time, limits, multi-sig thresholds) off-chain, maintaining an absolutely minimalist on-chain foundation.
2. **Neo-specific strengths**: It takes advantage of NeoVM `VerifyContext` and dynamic scripting to achieve deterministic virtual accounts without per-user proxy deployment.
3. **True Modularity (Modular Smart Accounts)**: The master contract never upgrades. Whether integrating new identity standards (like future Apple Passkeys) or integrating more complex DID risk control logic, it merely requires deploying a few hundred lines of stateless plugin contracts and mounting them.

The current runtime should be treated as the authoritative source over this historical design note where they differ.

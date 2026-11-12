# Historical Testnet Validation — Pre-V3 Wallet (March 6-8, 2026)

> **Historical record.** This appendix preserves the V1/V2 "Verified Testnet
> Status" content that previously lived in the repo `README.md`. It describes
> the pre-V3, role-based wallet generation (`executeUnified` /
> `executeUnifiedByAddress`, admins/managers/thresholds, whitelist/blacklist
> controls, dome/oracle unlock) that the V3 rewrite removed. The
> `sdk/js/tests/aa_testnet_*` validators referenced below were deleted with
> that rewrite and no longer exist in the repo, and the contract hashes refer
> to pre-V3 testnet deployments. None of this describes the shipping V3
> system — for the current verified surface see the V3 Plugin Matrix in
> `README.md` and `docs/PLUGIN_MATRIX.md`.

## Verified Testnet Status (V1/V2, archived)

Verified on **Neo N3 testnet** on **March 6, 2026** against hardened contract **`0x5be915aea3ce85e4752d522632f0a9520e377aaf`** (deployment tx **`0x635e75cc321fcb7b0906f6a9c39f9d1b227848e7e56d9648496d7d4df706a984`**) using:
- `sdk/js/tests/aa_testnet_integration_check.js`
- `sdk/js/tests/test-evm-meta-tx.js`
- `sdk/js/tests/aa_testnet_full_validate.js`
- `sdk/js/tests/aa_testnet_negative_meta_validate.js`
- `sdk/js/tests/aa_testnet_max_transfer_validate.js`
- `sdk/js/tests/aa_testnet_direct_proxy_spend_validate.js`

Additional live authorization simulation confirmed `update` still HALTs for the deployer and FAULTs with `Not Deployer` for a non-deployer signer on the hardened deployment.

Re-validated on **March 7, 2026** against the same hardened deployment with a fresh funded signer. The expanded SDK testnet validation suite completed successfully, covering the core integration flow plus threshold-2 multisig, custom verifier, dome/oracle, concurrency, max-transfer, direct-proxy-spend, and approve/allowance validators after tightening the whitelist-mode postconditions.

On **March 8, 2026**, a fresh validation deployment **`0x2dd3b3776ddccdd56c4969342a3f9b0c5516933c`** (deployment tx **`0xe6b65fb40f5f291ba8cb383428b2dd0bcde3ff0c1a0a62de3216fd748a88f364`**) was used to finish validating the remaining wrapper and asset/token paths under the current branch semantics. That diagnostic instance passed live runs of `aa_testnet_integration_check.js`, `aa_testnet_negative_meta_validate.js`, `aa_testnet_threshold2_validate.js`, `aa_testnet_dome_oracle_validate.js`, `aa_testnet_custom_verifier_validate.js`, `aa_testnet_max_transfer_validate.js`, `aa_testnet_approve_allowance_validate.js`, `aa_testnet_full_validate.js`, and `aa_testnet_concurrency_validate.js`. The direct proxy-signed external spend path remained blocked, which is the expected hardened negative path.

### Security Checklist
- [x] Unauthorized bootstrap account creation is rejected.
- [x] Blacklisted targets are blocked from execution.
- [x] Whitelist-only mode blocks non-whitelisted targets.
- [x] Whitelist-only mode still allows explicitly whitelisted targets.
- [x] Meta-transaction replay with a stale nonce is rejected.
- [x] Expired meta-transaction signatures are rejected.
- [x] Tampered `argsHash` values are rejected.
- [x] Wrong EIP-712 chain ID signatures are rejected.
- [x] Wrong EIP-712 verifying-contract signatures are rejected.
- [x] Mismatched pubkey/signature pairs are rejected.
- [x] Invalid signature lengths are rejected.
- [x] Mismatched signer-array lengths are rejected.
- [x] Negative meta-transaction simulations leave nonce state unchanged.
- [x] Upgrade authorization is restricted to the deployer account.
- [x] Direct proxy-signed external spends are rejected on the hardened deployment.
- [x] Threshold `> 1` multisig execution is live-tested.
- [x] Custom verifier flows are live-tested.
- [x] Dome/oracle activation flows are live-tested.
- [x] Concurrency/load behavior is stress-tested.

### Functionality Checklist
- [x] Create account with deterministic address binding.
- [x] Create account without address and bind it later.
- [x] Read admins by account ID and by address.
- [x] Read managers by account ID and by address.
- [x] Read admin and manager thresholds by ID and by address.
- [x] Resolve account ID from address and address from account ID.
- [x] Read nonce values for account and address paths.
- [x] Compute a 32-byte `argsHash` through the contract.
- [x] Execute calls through `executeUnified` by account ID.
- [x] Execute calls through the canonical `executeUnifiedByAddress` runtime entry by bound address.
- [x] Execute EVM meta-transactions by address.
- [x] Execute EVM meta-transactions by account ID.
- [x] Execute mixed Neo-relayer + EVM-signer flows.
- [x] Set admins and managers through native admin operations.
- [x] Set whitelist, blacklist, and whitelist-mode controls.
- [x] Set max-transfer policy values.
- [x] Prove live max-transfer enforcement on an actual GAS token transfer through `executeUnifiedByAddress`.
- [x] Prove live `approve` / allowance enforcement on a token supporting approvals.

Verification note: live max-transfer enforcement was confirmed with `sdk/js/tests/aa_testnet_max_transfer_validate.js` using the owner as the transaction sender plus the deterministic AA proxy as an additional signer with `CustomContracts` scope limited to the AA contract and GAS, the AA witness bound to `verify(accountId)`, and an explicit `setWhitelistByAddress(..., GAS, true)` step before the external GAS `transfer` path.

Threshold note: on **March 7, 2026**, `sdk/js/tests/aa_testnet_threshold2_validate.js` confirmed a live threshold-2 mixed-signature path against hardened testnet deployment `0x5be915aea3ce85e4752d522632f0a9520e377aaf`. The validator raises the account admin threshold from `1` to `2`, proves owner-only `executeUnifiedByAddress` on `getNonce` FAULTs with `Unauthorized`, then proves `executeUnifiedByAddress` on `getNonce` HALTs with one native Neo witness plus one EIP-712 EVM signer and increments the meta-tx nonce.

Custom verifier note: on **March 7, 2026**, the live hardened deployment at `0x5be915aea3ce85e4752d522632f0a9520e377aaf` was updated via `0xba9c7978b93e4c7c86c775fa8eacd07c9c2ab16249f1a16ffbd74219065d490c` to add manifest permission for verifier `verify` calls. After that update, `sdk/js/tests/aa_testnet_custom_verifier_validate.js` deployed a disposable verifier at `0xfd3de95a8b331d4ea419201ef4d41a2a9b3b43b6`, bound it, removed the owner from the native admin set, proved owner-only direct admin mutation FAULTs with `Unauthorized admin`, proved a proxy-signed direct admin mutation HALTs via the custom verifier path, and proved whitelist restrictions still block non-whitelisted `executeUnifiedByAddress` targets.

Dome/oracle note: on **March 7, 2026**, the live hardened deployment at `0x5be915aea3ce85e4752d522632f0a9520e377aaf` was updated via `0x2478107d07291d1a944262893a60d8139a43dd324447e2cf9acd1b27568e167b`, `0xc995eec63592e0b310a5a363dcdb4ee3b5e1487484bfeb72710b0ffd9377a09e`, `0x8d583c34e5c5b2d0899dbb0b5907884888361e4bf57635fec2381e3218b26fec`, `0x460dabeeed69485b14e3083b0589d5decdd87b6a91cda94179ef55b29aef1a50`, `0xd09902cc493d17fb4b31521965ebc66bc83186ba60586769ebbc7c61bf268e72`, `0x9081787daaa46c843f254141d34b128d983564393c75420910dfe3d3e5f20057`, and `0x164cb9440c203d747ad153f6000b7de3bf88527482306e134afd2dd55c4e61d0` while productionizing the oracle flow. The final validator run in `sdk/js/tests/aa_testnet_dome_oracle_validate.js` succeeded against `https://jsonplaceholder.typicode.com/todos/4|$.completed`, proving pre-timeout access FAULTs with `Dome account not active yet`, post-timeout pre-callback access FAULTs with `Dome account not unlocked by oracle`, the oracle callback flips `isDomeOracleUnlocked` to true, and the dome-gated `executeUnifiedByAddress` path HALTs afterward.

Concurrency note: on **March 7, 2026**, `sdk/js/tests/aa_testnet_concurrency_validate.js` completed a bounded live load pass against hardened testnet deployment `0x5be915aea3ce85e4752d522632f0a9520e377aaf` using **12 parallel simulations** plus **2 serialized live meta-transactions**. The harness proved all pre-write and post-write `executeUnifiedByAddress(..., getNonce, ...)` simulations HALT consistently, all parallel nonce reads agree before and after writes, and the EVM signer nonce advances deterministically from `0` to `1` to `2` across live meta-tx submissions without inconsistent policy or nonce results.

Approve/allowance note: on **March 7, 2026**, `sdk/js/tests/aa_testnet_approve_allowance_validate.js` deployed a disposable approval-capable token at `0x698ad0fb426dfe64ed8c100c75e5f6da4cb9c535`, explicitly whitelisted that token for the AA account, set an AA max-transfer limit of `100` for that token, proved a Neo-style `approve(owner, spender, amount)` within limit HALTs and returns `true`, proved an over-limit approve FAULTs with `Amount exceeds max limit`, and confirmed `allowance(owner, spender)` stays at `100` after the rejected over-limit path.

### Fresh Deploy + Real Update Verification

A second destructive verification pass was completed on **March 6, 2026** against a freshly deployed unique testnet instance **`0x171359751dee7f56ea633586bd070a51c8d60e9c`**.

- Fresh deploy tx: **`0x6ed39853b92ace9bf1a87e0b295aeb8455dd987c391a62c6ec28ef25ed9a9c54`**
- Real update tx: **`0x3390f58a10e2aed726d6b414c57eaf59f92216eed44b825f230cd48f57d77b9e`**
- Post-update validation reran `sdk/js/tests/aa_testnet_integration_check.js`, `sdk/js/tests/test-evm-meta-tx.js`, `sdk/js/tests/aa_testnet_full_validate.js`, `sdk/js/tests/aa_testnet_negative_meta_validate.js`, `sdk/js/tests/aa_testnet_max_transfer_validate.js`, and `sdk/js/tests/aa_testnet_direct_proxy_spend_validate.js`
- Post-update authorization simulation confirmed the deployer `update` path still HALTs and a non-deployer signer still FAULTs with `Not Deployer`

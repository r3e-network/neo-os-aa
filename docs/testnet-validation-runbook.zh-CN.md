# 测试网验证 Runbook

> 中文版本与 `docs/testnet-validation-runbook.md` 同构。若两者冲突，以英文版本为准。

本 runbook 按最安全的推荐顺序执行当前的 v4 SDK 测试网验证脚本，遇到第一个失败即停止。

## 必需环境

- `TEST_WIF` 或 `NEO_TESTNET_WIF`，设置为一个专用的、有余额的 Neo 测试网账户

paymaster 策略探针是唯一不需要钱包的阶段：它校验的是绑定在已部署内核上的链下允许列表，因此需要 `SA_CORE_HASH_TESTNET`（已部署的 v4 内核）与 `PAYMASTER_ACCOUNT_ID`（该内核派生的账户）。缺少这两项时套件跳过该阶段，而不是失败。

## 可选环境

- `SA_VALIDATION_RUN_ID`：命名一次套件运行；此后所有阶段共享派生的 `sa-v4-<run id>` 部署标签
- `SA_VALIDATION_DEPLOY_TAG`：直接覆盖该标签
- `SA_MATRIX_SCENARIOS`：以逗号分隔的场景名列表，将 plugin matrix 收窄到指定场景（场景名见 `tests/testnet_plugin_matrix.js` 文件头部）
- `SA_MAX_SYSTEM_FEE` / `SA_MAX_NETWORK_FEE` / `SA_MAX_TOTAL_FEE`：收紧 SDK 在签名前执行的费用上限（默认 `50000000` / `5000000` / `55000000`）
- `TESTNET_RPC_URL`：强制指定一个 Neo N3 测试网 RPC
- `TESTNET_RPC_URLS`：以逗号或空白分隔的 Neo N3 测试网 RPC 候选列表；未设置时，验证器会自动探测官方公共种子 `seed1` 至 `seed5.neo.org:20332`，然后回退到 `https://testnet1.neo.coz.io:443`
- `MORPHEUS_RUNTIME_TOKEN`（首选），或 `PHALA_API_TOKEN` / `PHALA_SHARED_SECRET`，用于启用在线 Morpheus paymaster 中继验证器
- `MORPHEUS_TESTNET_RUNTIME_URL` 或 `MORPHEUS_RUNTIME_URL`，用于覆盖默认的 Morpheus 测试网运行时 URL；否则验证器使用 `https://oracle.meshmini.app/testnet/paymaster/authorize`
- `MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH`，用于直接从本地检出运行 Morpheus paymaster worker handler，例如 `/home/neo/git/neo-morpheus-oracle/workers/phala-worker/src/worker.js`
- `MORPHEUS_PAYMASTER_APP_ID`，若 paymaster 验证器应指向非默认的 CVM app
- `PAYMASTER_ACCOUNT_ID`，若希望在固定的、已在允许列表中的账户上重放，而不是从 `TEST_WIF` 派生 bootstrap 账户
- `SKIP_PAYMASTER_ALLOWLIST_UPDATE=1`，若已手工把该账户加入 Morpheus worker 的允许列表
- `PHALA_SSH_RETRIES`，用于调整 paymaster 验证器的 CVM 桥接重试次数
- `PHALA_CLI`，用于覆盖 Phala CLI 的启动命令。未设置时，验证器优先使用全局 `phala` 二进制，否则回退到 `npx --yes phala`。

如果公共 `paymaster/authorize` 端点返回 `401` 或 `403`，或者在拿到 HTTP 响应之前直接请求就失败，链下验证器会在 CLI 可用时自动改走 `phala` / `npx phala` 的远程 worker 路径重试。需要确定性的本地验证时，设置 `MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH`；此时验证器在本地执行 worker handler，但仍把中继交易提交到 Neo N3 测试网。

## 试运行

在 `sdk/js` 下打印计划执行的命令，不广播任何内容：

```bash
./run_testnet_validation_suite.sh --dry-run
```

干跑在缺少必需变量时把阶段标记为 `blocked`，在可选阶段无法运行时标记为 `skip`，因此它打印的计划就是实跑可执行的计划。

## 实际执行

在 `sdk/js` 下运行完整的有序套件：

```bash
./run_testnet_validation_suite.sh
```

套件会写出 `docs/reports/sa-testnet-validation-suite.latest.json` 与 `docs/TESTNET_VALIDATION_SUMMARY.md`，两者都记录运行 id、部署标签与受测内核。

## v4 部署模型

内核与它安装的模块都以规范 manifest 名称部署。两项协议校验使这一点成为强制要求：SDK 客户端只接管 manifest 名称为 `SmartAccount` 的合约；内核在绑定模块时比较 profile 的 `contractName` 与已部署的 manifest 名称（`docs/SA-MODULE-PROTOCOL.md` 第 7.3 节），不匹配时以 `SA_MODULE_CODE_BINDING_MISMATCH` 拒绝。运行标签会重命名 manifest 并同时破坏这两项校验，因此只有非模块合约（paymaster、地址市场、测试探针）带每次运行的标签后缀。由于给定内核的规范哈希是固定的，重跑会复用链上已有的合约，而不必为重复部署付费。

## 有序脚本

1. `tests/testnet_smoke.js`
2. `tests/testnet_plugin_matrix.js`
3. `tests/testnet_market_escrow.js`
4. `tests/testnet_paymaster_onchain.mjs`
5. `tests/testnet_paymaster_policy.mjs`，当存在 paymaster 运行时令牌、`SA_CORE_HASH_TESTNET` 与 `PAYMASTER_ACCOUNT_ID` 时
6. `tests/testnet_paymaster_relay.mjs`，当 `MORPHEUS_RUNTIME_TOKEN` 或 `PHALA_API_TOKEN` 存在时

## 单条命令

```bash
npm run testnet:validate:smoke
npm run testnet:validate:plugin-matrix
npm run testnet:validate:market
npm run testnet:validate:paymaster-onchain
npm run testnet:validate:paymaster-policy
npm run testnet:validate:paymaster
npm run testnet:validate:report
```

## 安全须知

- runner 遇到第一个失败即停止。
- 若干脚本会部署合约或广播真实的测试网交易，并改变链上状态。
- 测试网验证器有意忽略通用的 `NEO_RPC_URL`；只使用 `TESTNET_RPC_URL` / `TESTNET_RPC_URLS`。每个在线脚本在广播前都会校验 Neo N3 测试网的 network magic。
- plugin matrix 部署 v4 内核以及它要演练的 validator 与 hook 模块，全部使用规范名称，并在 `docs/reports/` 下记录 JSON 报告。
- paymaster 策略验证器会覆盖显式拒绝路径，例如错误的 `dapp_id`、错误的 `account_id`、错误的 `target_contract`、错误的 `method`、缺失的 `operation_hash`，以及超出限额的 gas。
- paymaster 验证器可以复用固定的允许列表账户，也可以注册新账户并在线更新 worker 允许列表。
- 公共 paymaster 端点允许实施托管方的反滥用控制。本地 handler 验证证明策略逻辑与中继接线，且不削弱该生产边界。
- 在跑完整套件之前，优先使用一次性测试密钥，以及全新的或可重置的测试网环境。
- 在相同链上状态上重复运行套件可能改变结果，因为 nonce、verifier 密钥、允许列表与余额都会向前推进。

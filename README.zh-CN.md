# Neo N3 智能账户（SmartAccount）

这是仓库 `README.md` 的中文入口版，帮助中文读者快速找到当前可用的文档和工作流。

## 功能

- **确定性 V3 账户**：每个账户以 20 字节 `accountId` 为键，派生稳定的 Neo 虚拟地址，无需为每个用户单独部署钱包合约。
- **验证器插件授权**：可为每个账户绑定 Web3Auth、TEE、WebAuthn、会话密钥、多签或其他验证器插件。
- **钩子插件策略执行**：可附加可选的钩子插件用于每日限额、代币限制、凭证门控和执行后控制。
- **备份所有者逃生通道**：每个账户可定义原生 Neo 备份所有者及时间锁验证器轮换。
- **跨链 EVM 兼容**：V3 通过 Web3Auth 验证器路径支持 secp256k1 / Keccak256 EIP-712 `UserOperation` 签名。
- **链上 Paymaster（赞助交易）**：`AAPaymaster` 为支持的普通 UserOperation 提供无需信任的 GAS 赞助 —— 赞助商存入 GAS，创建每账户或全局策略，中继在成功执行后自动获得报销。代理地址转账仍要求独立见证，赞助代理转账明确拒绝；具体可用性还取决于已部署 Paymaster、策略、费用上限和链上回读。
- **策略门控执行**：新集成应通过 `executeUserOp(accountId, op)` 执行，nonce 处理、验证、钩子和目标执行保持集中化。

## 项目内容

本项目包含：

- Neo N3 智能账户主合约（`SmartAccount`，V3 交付名 `SmartAccountV3`）
- 前端操作工作区与协作草稿流
- JavaScript SDK 与测试网验证脚本

## 建议阅读顺序

1. `README.md`
2. `docs/HOW_IT_WORKS.zh-CN.md`
3. `docs/WORKFLOWS.zh-CN.md`
4. `docs/DATA_FLOW.zh-CN.md`
5. `docs/architecture.zh-CN.md`
6. `docs/AA-SYSTEM-STATUS.md`
7. `docs/ORDINARY_ACCOUNT_WORKSPACE.md`
8. `docs/AA-FORMAL-VERIFICATION.md`
9. `docs/AA_V3_ARCHITECTURE.zh-CN.md`（历史架构说明）
10. `docs/TESTNET_DEPLOYMENT.md`

同一主分支保留两个实现入口：
[用户合约实现](implementations/ordinary/README.md) 和
[原生 SmartAccount 提交实现](implementations/native/README.md)。
两个目录中的 `profile.json` 记录各自的源码根、兼容路径、构建产物和
验证命令。源码继续放在现有构建路径中，避免破坏当前工具链；原生
SmartAccount 共识服务仍属于对应的 Neo core 仓库。

## 说明

本文件是中文导航入口。英文 README 仍然是仓库的主事实来源。

## 项目结构

- `implementations/ordinary/`：当前可用的 `SmartAccountV3` 用户合约实现入口。
- `implementations/native/`：原生 ABI 2 标准提交实现入口，当前为 draft/unactivated。
- `contracts/`：C# 主入口合约实现。
- `contracts/verifiers/`：验证器插件（Web3Auth、TEE、WebAuthn、SessionKey、MultiSig 等）。
- `contracts/hooks/`：钩子插件（DailyLimit、Whitelist、TokenRestricted、MultiHook、NeoDIDCredential）。
- `contracts/paymaster/`：链上 Paymaster 合约，用于赞助/无 GAS 交易。
- `frontend/`：Vue 前端组件，演示账户创建与签名工作流。
- `sdk/js/`：JavaScript/TypeScript SDK，用于 dApp 集成。
- `docs/`：协议设计与规范标准文档。

## 部署配置

对于通过 `AAPaymaster` 合约的链上赞助交易，将 `VITE_AA_PAYMASTER_HASH` 设置为已部署的 Paymaster 合约哈希。赞助商通过 `setPolicy` 将 GAS 存入 Paymaster 并创建赞助策略，中继调用 AA 核心的 `executeSponsoredUserOp`。核心验证策略、执行 UserOp，然后原子性结算报销。参见 SDK 的 `createSponsoredUserOpPayload` 和 `validatePaymasterOp` 方法。

当前状态补充：

- V3 插件矩阵与 Paymaster 路径已在 Neo N3 testnet 实际验证
- 已验证的 verifier / hook 包括 Web3Auth、TEE、WebAuthn、SessionKey、MultiSig、Subscription、Whitelist、DailyLimit、TokenRestricted、MultiHook、NeoDIDCredentialHook
- `ZKEmailVerifier` 当前被明确禁用，直到真实 proof verifier 实现完成

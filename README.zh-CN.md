# Neo N3 智能账户（SmartAccount）

这是仓库 `README.md` 的中文入口版，帮助中文读者快速找到当前可用的文档和工作流。

## 功能

- **确定性账户**：每个账户以 20 字节 `accountId` 为键（由托管密钥与盐值派生），解析为稳定的 Neo 虚拟地址，无需为每个用户单独部署钱包合约。
- **验证器模块授权**：可为每个账户实例安装 Web3Auth、TEE、P-256、会话密钥、订阅、委托身份、见证或多签等验证器模块。
- **钩子模块策略执行**：可安装钩子模块用于每日限额、代币限制、凭证门控和执行后控制；执行顺序由核心维护的 hook 顺序决定。
- **配置意图**：安装、卸载、重新绑定或重新配置模块都暂存为意图，24 小时后成熟、七天后过期；`proposeConfiguration`、`confirmConfiguration`、`cancelConfiguration` 是唯一的写入路径。
- **备份所有者恢复**：每个账户可定义原生 Neo 备份所有者，恢复由已安装的恢复服务代理执行。
- **跨链 EVM 兼容**：v4 通过委托身份验证器路径支持 secp256k1 / Keccak256 EIP-712 签名。
- **策略门控执行**：新集成应通过 `executeUserOp(accountId, op)` 执行，nonce 处理、验证、钩子和目标执行保持集中化。

## 项目内容

本项目包含：

- Neo N3 智能账户主合约（`SmartAccount`）
- 前端操作工作区与协作草稿流
- JavaScript SDK 与测试网验证脚本

## 建议阅读顺序

完整地图见 [docs/INDEX.zh-CN.md](docs/INDEX.zh-CN.md)。最短路径：

1. [README.md](README.md)（英文规范版）
2. [docs/HOW_IT_WORKS.zh-CN.md](docs/HOW_IT_WORKS.zh-CN.md) —— 端到端心智模型
3. [docs/WORKFLOWS.zh-CN.md](docs/WORKFLOWS.zh-CN.md) —— 交易生命周期与提交流程
4. [docs/DATA_FLOW.zh-CN.md](docs/DATA_FLOW.zh-CN.md) —— 浏览器 / Supabase / 中继 / 链 的边界
5. [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) —— 技术架构
6. [docs/SA-SYSTEM-STATUS.zh-CN.md](docs/SA-SYSTEM-STATUS.zh-CN.md) —— 已建成、已部署、已验证，以及尚未成立的部分
7. [docs/SECURITY_MODEL.zh-CN.md](docs/SECURITY_MODEL.zh-CN.md) —— 威胁模型与信任假设
8. [docs/SA-SPEC.zh-CN.md](docs/SA-SPEC.zh-CN.md) —— 仅有英文的规范与形式化章节导读

同一主分支只保留一个实现：[原生 SmartAccount 提交实现](contracts/native/README.md)
（`contracts/native/`）。原 C# 用户合约实现及其 paymaster、地址市场与
平台注册服务已在仓库转为 native-only 时移除。原生核心安装的验证器、钩子与
恢复模块位于 `contracts/plugins/`。`contracts/native/profile.json` 记录源码根、
兼容路径、构建产物与验证命令；原生 SmartAccount 共识执行仍属于对应的
Neo core 仓库。

## 说明

本文件是中文导航入口。英文 README 仍然是仓库的主事实来源。

## 项目结构

- `contracts/native/`：原生 ABI 2 标准提交实现，包含原生共识 `SmartAccount` 服务的真源与编译它的 Neo core 叠加工程，当前为 draft/unactivated。
- `contracts/plugins/`：原生核心安装的模块合约。
- `contracts/plugins/validators/`：验证器模块（Web3Auth、NeoWitness、P256、TeeKey、SessionKey、Subscription、DelegatedIdentity、MultiSig，以及被禁用的 ZKEmail 模板）。
- `contracts/plugins/hooks/`：钩子模块（DailyLimit、Whitelist、TokenRestricted、NeoDIDCredential；MultiHook 已退役）。
- `contracts/plugins/recovery/`：可选的社交恢复服务，以及委托给它的 action-session 验证器。
- `contracts/plugins/templates/`：第三方验证器与钩子模块的起点模板。
- `contracts/plugins/native-profile/`：共用模块的 native 配置构建。
- `contracts/build/`：公开部署的固定工件。
- `tests/`：合约、native 与本地链测试套件，其部署的 mock 合约位于 `tests/mocks/`。
- `frontend/`：Vue 前端组件，演示账户创建与签名工作流。
- `sdk/js/`：JavaScript/TypeScript SDK，用于 dApp 集成。
- `docs/`：协议设计与规范标准文档。

## 部署配置

链上 Paymaster 合约已随 custom 实现移除，本仓库不再提供赞助策略引擎。部署配置现由 `contracts/native/profile.json` 与 `contracts/plugins/native-profile/profiles.json` 描述：它们给出规范源码根、六个 native-profile 模块、ABI 2 权威与各验证命令消费的产物。原生激活仍属于运行时属性，选择某个 RPC 端点无法将其开启。

当前状态补充：

- 历史上的验证器/钩子矩阵与 Paymaster 路径记录来自 2026 年 3 月的 Neo N3 testnet 运行，其部署集合已非当前 canonical 部署，不代表 v4 的链上验证状态（详见英文 README 的 Historical Testnet Records）
- 当前源码中可供复现的证据是本地链套件 `tests/localchain/`；v4 测试网脚本已迁移到 v4 调用，但本次未运行
- 已随 v4 安装的验证器模块包括 Web3Auth、NeoWitness、P256、TeeKey、SessionKey、Subscription、DelegatedIdentity、MultiSig；钩子模块包括 DailyLimit、Whitelist、TokenRestricted、NeoDIDCredential
- `ZKEmailVerifier` 当前被明确禁用，直到真实 proof 验证实现完成

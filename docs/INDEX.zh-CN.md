# 文档索引

> 中文版本与 `docs/INDEX.md` 同构。若两者冲突，以英文版本为准。

产品名是 **Neo Smart Account —— SA**。"AA" 只保留在指以太坊账户抽象（ERC-4337/7579/7702/7715）时。协议字符串切换已完成：EIP-712 domain 名为 `"Neo Smart Account"`，`sa_contract` / `sa_proxy` 线上键使用 SA 前缀；切换前的旧域票据在本次切换时截止失效。下列所有文档都称本系统为 SA。

先读根目录 [README](../README.md)；本索引是地图，不是手册。

## 语言策略

英文文本是规范文本。本索引中的每篇文档都有名为 `<name>.zh-CN.md` 的中文对照；两侧保持结构一致，中文文件在首段声明冲突时以英文为准。覆盖范围包括阅读路径、原生系列、账户操作、安全模型、运行时规范、闭合与形式化章节、构建与打包，以及参考资料（指南、runbook 与审计）。[SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md) 仍是本章节集合的中文导读。

| 覆盖情况 | 涉及文档 | 说明 |
| --- | --- | --- |
| 双语（EN + `.zh-CN.md`） | 协议、架构、账户、闭合与参考文档 | 56 对；`reports/` 下四份带日期的快照仍仅英文 |

## 从这里开始

| 文档 | 它回答什么 | 语言 |
| --- | --- | --- |
| [SA-SYSTEM-STATUS.zh-CN.md](SA-SYSTEM-STATUS.zh-CN.md) | 已建成、已部署、已验证的部分，以及尚未成立的部分 | 中 · [EN](SA-SYSTEM-STATUS.md) |
| [HOW_IT_WORKS.zh-CN.md](HOW_IT_WORKS.zh-CN.md) | 端到端心智模型与使用指南 | 中 · [EN](HOW_IT_WORKS.md) |
| [USER_GUIDE.zh-CN.md](USER_GUIDE.zh-CN.md) | 运营者 / 签名方的实际操作步骤 | 中 · [EN](USER_GUIDE.md) |
| [QUICK_REFERENCE.zh-CN.md](QUICK_REFERENCE.zh-CN.md) | 命令与速查 | 中 · [EN](QUICK_REFERENCE.md) |
| [WORKFLOWS.zh-CN.md](WORKFLOWS.zh-CN.md) | 交易生命周期与提交流程 | 中 · [EN](WORKFLOWS.md) |
| [DATA_FLOW.zh-CN.md](DATA_FLOW.zh-CN.md) | 浏览器 / Supabase / 中继 / 链 的边界 | 中 · [EN](DATA_FLOW.md) |
| [architecture.zh-CN.md](architecture.zh-CN.md) | 技术架构细节 | 中 · [EN](architecture.md) |
| [NEOOS_ARCHITECTURE.zh-CN.md](NEOOS_ARCHITECTURE.zh-CN.md) | 本仓库在 NeoOS 工作区架构中的位置（指针） | 中 · [EN](NEOOS_ARCHITECTURE.md) |
| [ORGANIZATION.zh-CN.md](ORGANIZATION.zh-CN.md) | 仓库结构与验证地图 | 中 · [EN](ORGANIZATION.md) |
| [SA-IMPLEMENTATION-STRATEGY.zh-CN.md](SA-IMPLEMENTATION-STRATEGY.zh-CN.md) | 两条实现路径与各自的交付边界 | 中 · [EN](SA-IMPLEMENTATION-STRATEGY.md) |

## 原生 SmartAccount

- [NATIVE_SYSTEM_ARCHITECTURE.zh-CN.md](NATIVE_SYSTEM_ARCHITECTURE.zh-CN.md) · [EN](NATIVE_SYSTEM_ARCHITECTURE.md) — 身份、权限、执行、恢复、费用、激活
- [NATIVE_SDK.zh-CN.md](NATIVE_SDK.zh-CN.md) · [EN](NATIVE_SDK.md) — ABI 发现、账户计划、签名交易
- [NATIVE_ACCOUNT_WORKSPACE.zh-CN.md](NATIVE_ACCOUNT_WORKSPACE.zh-CN.md) · [EN](NATIVE_ACCOUNT_WORKSPACE.md) — 发现、注册、备份、钱包边界
- [NATIVE_ACCOUNT_USER_GUIDE.zh-CN.md](NATIVE_ACCOUNT_USER_GUIDE.zh-CN.md) · [EN](NATIVE_ACCOUNT_USER_GUIDE.md) — 备份、权限矩阵、密钥丢失时的决策
- [NATIVE_ACCOUNT_TRANSACTION_GUARDS.zh-CN.md](NATIVE_ACCOUNT_TRANSACTION_GUARDS.zh-CN.md) · [EN](NATIVE_ACCOUNT_TRANSACTION_GUARDS.md) — 精确脚本取消守卫
- [NATIVE_ACCOUNT_THRESHOLD_RECOVERY.zh-CN.md](NATIVE_ACCOUNT_THRESHOLD_RECOVERY.zh-CN.md) · [EN](NATIVE_ACCOUNT_THRESHOLD_RECOVERY.md) — 把门限钱包当作守护者、托管方或付款方
- [NATIVE_SIGNED_TRANSACTION_IMPORT.zh-CN.md](NATIVE_SIGNED_TRANSACTION_IMPORT.zh-CN.md) · [EN](NATIVE_SIGNED_TRANSACTION_IMPORT.md) — 可移植的已签名工件与回执恢复
- [NATIVE_ACCOUNT_PERFORMANCE.zh-CN.md](NATIVE_ACCOUNT_PERFORMANCE.zh-CN.md) · [EN](NATIVE_ACCOUNT_PERFORMANCE.md) — 实测预算与费用行为
- [proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.zh-CN.md](proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.zh-CN.md) · [EN](proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md) — ABI 2 规范草案（Neo proposals #242/#243）
- [proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.zh-CN.md](proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.zh-CN.md) · [EN](proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.md) — 六个原生工件、打包、形式化边界
- [proposals/SMARTACCOUNT-NATIVE-MULTISIG.zh-CN.md](proposals/SMARTACCOUNT-NATIVE-MULTISIG.zh-CN.md) · [EN](proposals/SMARTACCOUNT-NATIVE-MULTISIG.md) — 组合验证器、瞬态批准回执、参数隔离
- [proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.zh-CN.md](proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.zh-CN.md) · [EN](proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.md) — 模块生命周期与恢复撤销
- [proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.zh-CN.md](proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.zh-CN.md) · [EN](proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.md) — 源码构建运行时、代理、配置与恢复证据
- [proposals/smartaccount-native-profile-v2-vectors.json](proposals/smartaccount-native-profile-v2-vectors.json) — 当前的授权与执行向量
- [proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.zh-CN.md](proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.zh-CN.md) · [EN](proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md) — 必需的协议章节、证据、未决的激活门禁
- [reports/sa-native-open-boundaries-20261008.json](reports/sa-native-open-boundaries-20261008.json) — 本地测试与模型证明都没有确立的主张

早期的原生回执只描述它记录的源码与运行时。它们不校验当前 ABI 2 信封；某份回执若不在本检出中，就不是当前发布证据。

## SA 运行时规范

- [SA-EIP-712-SPEC.zh-CN.md](SA-EIP-712-SPEC.zh-CN.md) — 验证器在链上哈希的类型化数据布局（中 · [EN](SA-EIP-712-SPEC.md)）
- [SA-IMPLEMENTATION-REFINEMENT.zh-CN.md](SA-IMPLEMENTATION-REFINEMENT.zh-CN.md) — 精化范围与验收条件（中 · [EN](SA-IMPLEMENTATION-REFINEMENT.md)）
- [SA-METHOD-REFINEMENT.zh-CN.md](SA-METHOD-REFINEMENT.zh-CN.md) — 方法级精化全集，各条作用域互不叠加：工件清单、源码投影、参考 VM、运行时检查、算术、费用语义、公开方法体、syscall 准入、interop 转换与计费、异常身份（中 · [EN](SA-METHOD-REFINEMENT.md)）
- [SA-PROXY-TRANSFERS.zh-CN.md](SA-PROXY-TRANSFERS.zh-CN.md) · [EN](SA-PROXY-TRANSFERS.md) — 直接代理见证的构造、费用策略、拒绝赞助
- [SA-MODULE-PROTOCOL.zh-CN.md](SA-MODULE-PROTOCOL.zh-CN.md) · [EN](SA-MODULE-PROTOCOL.md) — 协议 v4 共享模块规范，两个内核共同遵循
- [SA-MIGRATION-MANIFEST.zh-CN.md](SA-MIGRATION-MANIFEST.zh-CN.md) · [EN](SA-MIGRATION-MANIFEST.md) — 旧版到 v4 的迁移 manifest 与幂等规则
- [SA-CONTRACT-HANDOFF.zh-CN.md](SA-CONTRACT-HANDOFF.zh-CN.md) · [SA-FRONTEND-CORRESPONDENCE.zh-CN.md](SA-FRONTEND-CORRESPONDENCE.zh-CN.md) — 合约 / SDK / 前端的约定记录（[EN](SA-CONTRACT-HANDOFF.md) · [EN](SA-FRONTEND-CORRESPONDENCE.md)）
- 本章节集合的中文导读：[SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md)

## 闭合与形式化验证

- [SA-CLOSURE-GATE.zh-CN.md](SA-CLOSURE-GATE.zh-CN.md) — 决定某个入口点能否算作已验证的门禁（中 · [EN](SA-CLOSURE-GATE.md)）
- [SA-ENTRYPOINT-CLOSURE.zh-CN.md](SA-ENTRYPOINT-CLOSURE.zh-CN.md) — 逐入口点的闭合规则（中 · [EN](SA-ENTRYPOINT-CLOSURE.md)）
- [SA-FORMAL-VERIFICATION.zh-CN.md](SA-FORMAL-VERIFICATION.zh-CN.md) — 有界的 Coq 模型、运行时对应关系与未覆盖边界（中 · [EN](SA-FORMAL-VERIFICATION.md)）
- [reports/sa-closure-gate-20261117.json](reports/sa-closure-gate-20261117.json) — 当前集成回执：作用域内 PASS，完整实现为 **NO-GO**

闭合回执是刻意失败关闭的：`status: NO-GO` 且已验证入口点为零，是诚实状态，不是回归。

## 账户、恢复与运维

- [ACCOUNT_RECOVERY_AND_IDENTITY.zh-CN.md](ACCOUNT_RECOVERY_AND_IDENTITY.zh-CN.md) · [EN](ACCOUNT_RECOVERY_AND_IDENTITY.md) — 恢复边界与规范身份读取
- [OPERATOR_KEY_RECOVERY.zh-CN.md](OPERATOR_KEY_RECOVERY.zh-CN.md) · [EN](OPERATOR_KEY_RECOVERY.md) — 加密的运营者备份与浏览器恢复
- [MORPHEUS_PRIVATE_ACTIONS.zh-CN.md](MORPHEUS_PRIVATE_ACTIONS.zh-CN.md) · [EN](MORPHEUS_PRIVATE_ACTIONS.md) — 恢复验证器与私有操作
- [action-sessions.zh-CN.md](action-sessions.zh-CN.md) · [EN](action-sessions.md) — 会话密钥的作用域、过期与重新授权
- [MULTISIG_SDK.zh-CN.md](MULTISIG_SDK.zh-CN.md) · [MULTISIG_CHILD_CONFIGURATION.zh-CN.md](MULTISIG_CHILD_CONFIGURATION.zh-CN.md) — 多签打包与子配置证明（[EN](MULTISIG_SDK.md) · [EN](MULTISIG_CHILD_CONFIGURATION.md)）
- [PENDING_CONFIG_UPDATE_READ_ABI.zh-CN.md](PENDING_CONFIG_UPDATE_READ_ABI.zh-CN.md) · [EN](PENDING_CONFIG_UPDATE_READ_ABI.md) — 配置更新的读取面
- [CUSTOM_ACCOUNT_WORKSPACE.zh-CN.md](CUSTOM_ACCOUNT_WORKSPACE.zh-CN.md) · [EN](CUSTOM_ACCOUNT_WORKSPACE.md) — custom 账户工作区
- [mainnet-validation-runbook.zh-CN.md](mainnet-validation-runbook.zh-CN.md) · [EN](mainnet-validation-runbook.md) — 只读的主网校验
- [TESTNET_QUICKSTART.zh-CN.md](TESTNET_QUICKSTART.zh-CN.md) · [EN](TESTNET_QUICKSTART.md) — 真实测试网校验之前先跑的两条命令
- [testnet-validation-runbook.zh-CN.md](testnet-validation-runbook.zh-CN.md) · [EN](testnet-validation-runbook.md) — 先干跑再上链的测试网校验
- [POST_DEPLOY_SMOKE_TEST.zh-CN.md](POST_DEPLOY_SMOKE_TEST.zh-CN.md) · [EN](POST_DEPLOY_SMOKE_TEST.md) — 部署后的前端冒烟清单

## 安全、审计与对比

- [SECURITY_MODEL.zh-CN.md](SECURITY_MODEL.zh-CN.md) · [EN](SECURITY_MODEL.md) — 当前的威胁模型与信任假设
- [PROTOCOL_COMPLETENESS_AUDIT.zh-CN.md](PROTOCOL_COMPLETENESS_AUDIT.zh-CN.md) · [EN](PROTOCOL_COMPLETENESS_AUDIT.md) — 协议覆盖范围与已知边界
- [ETHEREUM_AA_COMPARISON.zh-CN.md](ETHEREUM_AA_COMPARISON.zh-CN.md) · [EN](ETHEREUM_AA_COMPARISON.md) — 与以太坊 AA（4337/7702/7579/7715）的对齐点与刻意分歧
- [FRONTEND_DEPENDENCY_SECURITY.zh-CN.md](FRONTEND_DEPENDENCY_SECURITY.zh-CN.md) · [EN](FRONTEND_DEPENDENCY_SECURITY.md) — 前端依赖的暴露面
- [PLUGIN_DEVELOPER_GUIDE.zh-CN.md](PLUGIN_DEVELOPER_GUIDE.zh-CN.md) · [EN](PLUGIN_DEVELOPER_GUIDE.md) — 受支持的验证器 / 钩子插件、生命周期与清理
- [contracts/plugins/templates/](../contracts/plugins/templates/) — 最小验证器 / 钩子起点（目录内有 `README.md`）
- [proposals/SA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.zh-CN.md](proposals/SA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.zh-CN.md) · [EN](proposals/SA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.md) — NeoVM / DevPack 验证器预算扩展
- [proposals/nep-smartaccount-entry-verifier.mediawiki](proposals/nep-smartaccount-entry-verifier.mediawiki) — 入口验证器的 NEP 草案

## 构建与打包

- [SA-REPRODUCIBLE-BUILD.zh-CN.md](SA-REPRODUCIBLE-BUILD.zh-CN.md) — 固定工具链、逐字节重建、pin 升级（中 · [EN](SA-REPRODUCIBLE-BUILD.md)）
- [NEO-PLATFORM-PACKAGES.zh-CN.md](NEO-PLATFORM-PACKAGES.zh-CN.md) · [EN](NEO-PLATFORM-PACKAGES.md) · [../contracts/neo-platform-packages.json](../contracts/neo-platform-packages.json) — 由 `scripts/check_neo_platform_packages.mjs` 强制执行的已审计平台包 pin
- [../sdk/js/PACKAGING.md](../sdk/js/PACKAGING.md) — 可独立安装的 SDK 包

## 证据回执

`docs/reports/` 存放带日期的机器回执。回执只对它指名的提交、工件与运行时构成证据，从来不是对当前工作树的陈述。当前固定的集合：

| 回执 | 覆盖内容 |
| --- | --- |
| [sa-closure-gate-20261117.json](reports/sa-closure-gate-20261117.json) | 集成闭合，NO-GO |
| [sa-artifact-reproducibility-20261116.json](reports/sa-artifact-reproducibility-20261116.json) | 逐字节一致的工件重建 |
| [sa-formal-gate-20261031.json](reports/sa-formal-gate-20261031.json) | Coq 门禁与变异集 |
| [sa-neoexpress-validation-20261031.json](reports/sa-neoexpress-validation-20261031.json) | 私有链部署与回读 |
| [sa-ordinary-candidate-compatibility-20261116.json](reports/sa-ordinary-candidate-compatibility-20261116.json) | custom 账户候选兼容矩阵 |

历史与已被取代的回执，只在某道守卫或某个形式化作用域固定它时才保留。[reports/testnet-validation-v1v2-2026-03.md](reports/testnet-validation-v1v2-2026-03.md) 是归档的 V3 前状态。

## Matrix 域

对兼容的 Neo 钱包，支持在同一笔交易内完成 SA 创建与 `.matrix` 注册。`.matrix` 把人可读名字解析到一个控制地址；前端随后读取核心的按账户状态（`getAccountState`、推导出的代理与绑定的验证器）来确认该地址背后的账户。合约不提供从所有者地址到其账户的反向索引，因此 `.matrix` 名字只是一次查询的起点，不是账户所有权的证明。

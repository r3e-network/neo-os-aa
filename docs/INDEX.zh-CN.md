
> 中文版本与 `docs/INDEX.md` 同构。若两者冲突，以英文版本为准。

产品名是 **Neo Smart Account —— SA**。"AA" 只保留在指以太坊账户抽象（ERC-4337/7579/7702/7715）时。协议字符串切换已完成：EIP-712 domain 名为 `"Neo Smart Account"`，`sa_contract` / `sa_proxy` 线上键使用 SA 前缀；切换前的旧域票据在本次切换时截止失效。下列所有文档都称本系统为 SA。

先读根目录 [README](../README.md)；本索引是地图，不是手册。原先平铺的主题页已 在文档角色化重组第一阶段并入六本按读者的“书”，七份过程文档则在第二阶段合并为 [engineering/](engineering/) 下的两本工程书；每本书开头带章节目录。`frontend/src/assets/docs/` 下的前端帮助页由这些书切片生成：修改某本书后，在 `frontend/` 运行 `npm run sync:docs`（或 `node scripts/sync-frontend-docs.mjs`）重新生成。

## 按角色导航

| 读者 | 读这里 | 它回答什么 |
| --- | --- | --- |
| 普通用户与钱包操作员 | [GUIDE.zh-CN.md](GUIDE.zh-CN.md) · [EN](GUIDE.md) | 端到端心智模型与运营者 / 签名方实操指南、快速参考、交易生命周期与提交流程、原生账户工作台、交易守卫、恢复与操作会话、阈值恢复、已签名交易导入（合并自 HOW_IT_WORKS、QUICK_REFERENCE、WORKFLOWS、四份 NATIVE_ACCOUNT_* 页面与 RECOVERY_AND_SESSIONS） |
| DApp / SDK 开发者 | [SDK.zh-CN.md](SDK.zh-CN.md) · [EN](SDK.md) | 原生 SDK 使用、阈值会话、EIP-712 签名、代理转账、待处理配置更新读取（合并自 NATIVE_SDK、MULTISIG_SDK、SA-EIP-712-SPEC、SA-PROXY-TRANSFERS、PENDING_CONFIG_UPDATE_READ_ABI） |
| 模块（插件）开发者 | [SA-MODULE-PROTOCOL.zh-CN.md](SA-MODULE-PROTOCOL.zh-CN.md) · [EN](SA-MODULE-PROTOCOL.md) | 协议 v4 共享模块规范（双内核共同遵循），文末附录 "Appendix: Module developer guide"（仅英文）收录插件安全、生命周期与清理 |
| 架构师 | [ARCHITECTURE.zh-CN.md](ARCHITECTURE.zh-CN.md) · [EN](ARCHITECTURE.md) —— 以及 —— [SECURITY.zh-CN.md](SECURITY.zh-CN.md) · [EN](SECURITY.md) | 架构书：技术架构、原生系统架构、仓库布局与验证地图、系统状态与能力边界、数据流与存储、与以太坊 AA 对比（合并自 architecture、NATIVE_SYSTEM_ARCHITECTURE、ORGANIZATION、SA-SYSTEM-STATUS、DATA_FLOW 与 ETHEREUM_AA_COMPARISON）；安全书：当前威胁模型与信任假设，含协议完备性审计（附录 A）与前端依赖安全评估（附录 B） |
| 节点与运维 | [OPERATIONS.zh-CN.md](OPERATIONS.zh-CN.md) · [EN](OPERATIONS.md) | 先干跑再上链的测试网校验与只读的主网校验 runbook、部署后的前端冒烟清单、实测的原生预算与费用行为（合并自 validation-runbooks、POST_DEPLOY_SMOKE_TEST 与 NATIVE_ACCOUNT_PERFORMANCE） |
| 协议规范全文 | [Neo-Smart-Account-Documentation-zh-CN.pdf](Neo-Smart-Account-Documentation-zh-CN.pdf) | 完整规范手稿（中文，PDF） |

## 语言策略

英文文本是规范文本。六本角色书与本索引都有名为 `<name>.zh-CN.md` 的中文对照，两侧保持结构一致，中文文件在首段声明冲突时以英文为准。过程 / 验证 / 审计 / 交接层——闭合门禁、形式化验证、逐入口点闭合、前端对应关系、迁移 manifest、合约交接、构建复现记录与未锁的 proposals——仅提供英文：这些章节随每次门禁运行变化，过期的译文会误述证据。[SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md) 仍是这一层的中文导读。

| 覆盖情况 | 涉及文档 | 说明 |
| --- | --- | --- |
| 双语（EN + `.zh-CN.md`） | 六本角色书、模块协议书、本索引、根 README、四份原生 proposals | 12 对 |
| 仅英文 | [engineering/](engineering/) 下的两本工程书与未锁的 proposals | 5 篇；本索引保留条目并标注“仅英文” |

## 工程师与过程记录

过程层（仅英文）随每次门禁运行变化。文档重组第二阶段已把七份原过程文档合并为 [engineering/](engineering/) 下的两本书，每本开头带章节目录：

- [engineering/VERIFICATION-AND-GATES.md](engineering/VERIFICATION-AND-GATES.md) —— SA 形式化验证（有界 Coq 模型、运行时对应关系、未覆盖边界）、可复现构建（固定工具链、逐字节重建、pin 升级）、决定某个入口点能否算作已验证的集成精化闭合门禁、逐入口点闭合清单，以及旧版到 v4 的迁移 manifest 与幂等规则
- [engineering/HANDOFF-RECORDS.md](engineering/HANDOFF-RECORDS.md) —— 合约内部交接的内核检查结论（第十八号闭合作用域）与源码前端与编译器的对应关系记录
- 这一层的中文导读：[SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md)
- 构建打包：[../sdk/js/PACKAGING.md](../sdk/js/PACKAGING.md) 与经审计的 Neo 平台包固定值 [../contracts/neo-platform-packages.json](../contracts/neo-platform-packages.json)（SA 可复现构建章的依据）

闭合回执是刻意失败关闭的：`status: NO-GO` 且已验证入口点为零，是诚实状态，不是回归。当前集成回执：[reports/sa-closure-gate-20261117.json](reports/sa-closure-gate-20261117.json)。

## 原生 SmartAccount 设计记录（proposals）

- [proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.zh-CN.md](proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.zh-CN.md) · [EN](proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md) —— ABI 2 规范草案（Neo proposals #242/#243）
- [proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.zh-CN.md](proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.zh-CN.md) · [EN](proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.md) —— 六个原生工件、打包、形式化边界
- [proposals/SMARTACCOUNT-NATIVE-MULTISIG.zh-CN.md](proposals/SMARTACCOUNT-NATIVE-MULTISIG.zh-CN.md) · [EN](proposals/SMARTACCOUNT-NATIVE-MULTISIG.md) —— 组合验证器、瞬态批准回执、参数隔离
- [proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.zh-CN.md](proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.zh-CN.md) · [EN](proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.md) —— 模块生命周期与恢复撤销
- [proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.md](proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.md)（仅英文）—— 源码构建运行时、代理、配置与恢复证据
- [proposals/smartaccount-native-profile-v2-vectors.json](proposals/smartaccount-native-profile-v2-vectors.json) —— 当前的授权与执行向量
- [proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md](proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md)（仅英文）—— 必需的协议章节、证据、未决的激活门禁
- [proposals/SA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.md](proposals/SA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.md)（仅英文）—— NeoVM / DevPack 验证器预算扩展
- [proposals/nep-smartaccount-entry-verifier.mediawiki](proposals/nep-smartaccount-entry-verifier.mediawiki) —— 入口验证器的 NEP 草案
- [contracts/plugins/templates/](../contracts/plugins/templates/) —— 最小验证器 / 钩子起点（目录内有 `README.md`）
- [reports/sa-native-open-boundaries-20261008.json](reports/sa-native-open-boundaries-20261008.json) —— 本地测试与模型证明都没有确立的主张

早期的原生回执只描述它记录的源码与运行时。它们不校验当前 ABI 2 信封；某份回执若不在本检出中，就不是当前发布证据。

## 证据回执

`docs/reports/` 存放带日期的机器回执。回执只对它指名的提交、工件与运行时构成证据，从来不是对当前工作树的陈述。当前固定的集合：

| 回执 | 覆盖内容 |
| --- | --- |
| [sa-closure-gate-20261117.json](reports/sa-closure-gate-20261117.json) | 集成闭合，NO-GO |
| [sa-artifact-reproducibility-20261116.json](reports/sa-artifact-reproducibility-20261116.json) | 逐字节一致的工件重建 |
| [sa-formal-gate-20261031.json](reports/sa-formal-gate-20261031.json) | Coq 门禁与变异集 |
| [sa-neoexpress-validation-20261031.json](reports/sa-neoexpress-validation-20261031.json) | 私有链部署与回读 |
| [sa-ordinary-candidate-compatibility-20261116.json](reports/sa-ordinary-candidate-compatibility-20261116.json) | custom 账户候选兼容矩阵 |

历史与已被取代的回执，只在某道守卫或某个形式化作用域固定它时才保留。

## Matrix 域

对兼容的 Neo 钱包，支持在同一笔交易内完成 SA 创建与 `.matrix` 注册。`.matrix` 把人可读名字解析到一个控制地址；前端随后读取核心的按账户状态（`getAccount`、推导出的代理与账户控制记录）来确认该地址背后的账户。合约不提供从所有者地址到其账户的反向索引，因此 `.matrix` 名字只是一次查询的起点，不是账户所有权的证明。

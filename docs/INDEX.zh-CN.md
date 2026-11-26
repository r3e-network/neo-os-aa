
中文版本与 `docs/INDEX.md` 同构。若两者冲突，以英文版本为准。

产品名是 **Neo Smart Account —— SA**。"AA" 只在指以太坊账户抽象时使用。下列所有文档都称本系统为 SA。

先读根目录 [README](../README.md)；本索引是地图，不是手册。文档按读者组织成书，每本书开头带章节目录。`frontend/src/assets/docs/` 下的前端帮助页由这些书切片生成：修改某本书后，在 `frontend/` 运行 `npm run sync:docs`（或 `node scripts/sync-frontend-docs.mjs`）重新生成。

## 按角色导航

| 读者 | 读这里 | 它回答什么 |
| --- | --- | --- |
| 普通用户与钱包操作员 | [GUIDE.zh-CN.md](GUIDE.zh-CN.md) · [EN](GUIDE.md) | 端到端心智模型、工作流生命周期、原生账户工作台、阈值钱包权限与已签名交易导入 |
| DApp / SDK 开发者 | [SDK.zh-CN.md](SDK.zh-CN.md) · [EN](SDK.md) | `NativeSmartAccountClient` 的用法：发现、身份、创建、账户状态、执行、凭证代次、模块、账户动作与费用，以及阈值会话 |
| 模块（插件）开发者 | [SA-MODULE-PROTOCOL.zh-CN.md](SA-MODULE-PROTOCOL.zh-CN.md) · [EN](SA-MODULE-PROTOCOL.md) · [模块 NEP 接入说明](proposals/SMARTACCOUNT-MODULE-NEPS.zh-CN.md) | 闭合 26 方法原生 ABI 下的模块行为：命名空间、上限、操作编码、签名域、回调 ABI、生命周期与时间锁、gas 与成本、能力声明档案以及错误与事件表。模块行为不扩展原生 ABI；先读 [v4.1 IDL](proposals/smartaccount-v4.1.idl.json)。末尾两章 "Appendix: Module developer guide" 与 "Frontend module chooser guide" 仅提供英文 |
| 架构师 | [ARCHITECTURE.zh-CN.md](ARCHITECTURE.zh-CN.md) · [EN](ARCHITECTURE.md) —— 以及 —— [SECURITY.zh-CN.md](SECURITY.zh-CN.md) · [EN](SECURITY.md) | 架构书：原生系统架构、账户身份与权限、执行与撤销、支持的策略模块、费用与用户体验、验证与激活。安全书：信任边界、执行安全、配置与治理、紧急遏制、恢复、失败语义、模块信任假设、开放边界与前端依赖安全评估 |
| 节点与运维 | [OPERATIONS.zh-CN.md](OPERATIONS.zh-CN.md) · [EN](OPERATIONS.md) | 本地校验、生成与固定文件、证据规则 |
| 演讲者 | [Neo-Smart-Account-Protocol-Design-zh-CN.pptx](Neo-Smart-Account-Protocol-Design-zh-CN.pptx) · [EN](Neo-Smart-Account-Protocol-Design-en-US.pptx) | 中英双语 48 页协议设计演示文稿（只讲协议，不讲实现）。每页自带演讲者备注与分步动画；独立讲稿、录像与字幕不入库 |
| 协议规范全文 | [Neo-Smart-Account-Documentation-zh-CN.pdf](Neo-Smart-Account-Documentation-zh-CN.pdf) | 49 页；由权威源 [v4.1 IDL](proposals/smartaccount-v4.1.idl.json) 与 [SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md) 派生的完整中文阅读版（PDF）。它不是独立权威，冲突时以 IDL 与 SA-SPEC 为准 |

## 语言策略

读者书的英文文本是规范文本。五本读者书与本索引都有名为 `<name>.zh-CN.md` 的中文对照，其 H2/H3 标题序列与英文书一致，中文文件在首段声明冲突时以英文为准。唯一声明的例外是模块协议书：第 1–18 章中英对等，末尾两章 "Appendix: Module developer guide" 与 "Frontend module chooser guide" 仅提供英文。根 README 同样双语。`frontend/tests/docsTruth.test.js` 中有一条守卫比对标题序列。

| 覆盖情况 | 涉及文档 | 说明 |
| --- | --- | --- |
| 双语（EN + `.zh-CN.md`） | 五本读者书、本索引、根 README、模块协议书与三份原生 proposals（[SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH](proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.zh-CN.md)、[SMARTACCOUNT-NATIVE-MODULE-PROFILES](proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.zh-CN.md)、[SMARTACCOUNT-NATIVE-MULTISIG](proposals/SMARTACCOUNT-NATIVE-MULTISIG.zh-CN.md)） | 11 对；只有模块协议书有英文独有章节（末尾两章） |
| 仅英文 | 下方“当前协议”一节列出的 [proposals/](proposals/) 下的 NEP 草案与机器可读文件、[验证书](engineering/VERIFICATION-AND-GATES.md) 与 [Morpheus 注册表记录](engineering/MORPHEUS-REGISTRY.md) | NEP 草案面向 Neo 流程，以英文撰写；机器可读文件没有可翻译的正文 |
| 仅中文 | [SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md) 与 [SMARTACCOUNT-MODULE-NEPS.zh-CN.md](proposals/SMARTACCOUNT-MODULE-NEPS.zh-CN.md) | 协议规范与模块 NEP 导读 |

## 当前协议

协议只有一份，且未发布：没有任何东西部署到公有网络。

| 层 | 来源 | 作用 |
| --- | --- | --- |
| 原生 ABI | [proposals/smartaccount-v4.1.idl.json](proposals/smartaccount-v4.1.idl.json) · [SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md) | 权威来源：26 个方法、15 个事件、操作编码、nonce 通道、摘要与签名域、存储布局与硬分叉规则。正文与 IDL 不一致时以 IDL 为准。`python scripts/check_smartaccount_v41_idl.py` 校验 IDL 与原生属性、manifest fixture 一致 |
| 模块行为 | [SA-MODULE-PROTOCOL.zh-CN.md](SA-MODULE-PROTOCOL.zh-CN.md) · [EN](SA-MODULE-PROTOCOL.md) | validator、hook 与策略模块在原生 ABI 下必须做什么 |
| 参数 | [proposals/smartaccount-native-profile-parameters.json](proposals/smartaccount-native-profile-parameters.json) · [profile.json](../contracts/native/profile.json) | 钱包、打包与验收共同使用的唯一参数集；由 `docs/proposals/validate-native-smartaccount-profile.py` 校验 |
| 核心 NEP 草案 | [nep-smartaccount-entry-verifier.mediawiki](proposals/nep-smartaccount-entry-verifier.mediawiki) | 原生 SmartAccount 协议服务及其入口验证 |
| 模块 NEP 草案 | [nep-smartaccount-module-interface.mediawiki](proposals/nep-smartaccount-module-interface.mediawiki) · [nep-smartaccount-module-profiles.mediawiki](proposals/nep-smartaccount-module-profiles.mediawiki) | 公共模块接口与具名模块档案 |
| 编译后的模块 ABI | [smartaccount-module-abis.md](proposals/smartaccount-module-abis.md) · [smartaccount-named-module-interfaces.json](proposals/smartaccount-named-module-interfaces.json) · [smartaccount-module-profile.schema.json](proposals/smartaccount-module-profile.schema.json) | 编译后的模块回调 ABI、具名接口与档案 schema |
| 原生设计说明 | [SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH](proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.zh-CN.md) · [SMARTACCOUNT-NATIVE-MODULE-PROFILES](proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.zh-CN.md) · [SMARTACCOUNT-NATIVE-MULTISIG](proposals/SMARTACCOUNT-NATIVE-MULTISIG.zh-CN.md) | 权限代次、模块档案与多签托管；三份均有 `.zh-CN.md` 对照 |
| 评审地图 | [SMARTACCOUNT-ISSUE-242-CONFORMANCE.md](proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md) | 把[原生 SmartAccount 讨论](https://github.com/neo-project/proposals/issues/242)的每个评审领域映射到规则与证据；不记录上游是否接受 |

## 工程师与验证

- [engineering/VERIFICATION-AND-GATES.md](engineering/VERIFICATION-AND-GATES.md) —— “SA 形式化验证”（状态、ABI 投影验收义务、工件、安全边界）与“SA 合约：基于已发布包的可复现构建”（固定内容、还原 / 构建 / 测试、复现、字节能证明什么与不能证明什么、如何升级 pin）
- [engineering/MORPHEUS-REGISTRY.md](engineering/MORPHEUS-REGISTRY.md) —— 外部 Morpheus 钱包服务注册表；不属于协议
- 构建打包：[../sdk/js/PACKAGING.md](../sdk/js/PACKAGING.md) 与 Neo 平台包固定值 [../contracts/neo-platform-packages.json](../contracts/neo-platform-packages.json)
- 机器可读的开放边界台账：[SA-NATIVE-OPEN-BOUNDARIES.json](SA-NATIVE-OPEN-BOUNDARIES.json)

## 证据回执

`docs/reports/` 存放带日期的机器回执。回执只对它指名的提交、工件与运行时构成证据，从来不是对当前工作树的陈述。留存的每份回执都有脚本读取：

| 回执 | 读取方 | 覆盖内容 |
| --- | --- | --- |
| [sa-formal-gate-20261031.json](reports/sa-formal-gate-20261031.json) | `formal/test_verify.py` | 它所指名那次运行的 Coq 门禁与变异集 |
| [sa-native-ci-probe-consistency-20261009.json](reports/sa-native-ci-probe-consistency-20261009.json) | `.github/workflows/native-profile.yml`、`scripts/test_native_profile_ci.py`、`scripts/test_native_budget_benchmark.py` | 原生多签宿主探针及其计价 |
| [smartaccount-current-20261124/](reports/smartaccount-current-20261124/) | `formal/refinement/` | 2026-11-24 工作树的本地验收回执 |

# SA 规范与形式化章节：中文导读

本页是英文规范章节的**中文导读**，不是规范文本的替代。规范、门禁结论与回执内容一律以对应英文文档与实际回执文件为准。写在这里的结论用于帮助中文读者决定"先读哪一篇、这篇到底回答什么问题"，不构成新的承诺。

已提供完整中文对照的文档见 [INDEX.zh-CN.md](INDEX.zh-CN.md) 的语言矩阵。规范、精化、闭合与形式化验证章节现在都有中文对照；每篇中文文件首段都声明与英文同构、冲突时以英文为准。本页保留为导读：说明每篇回答什么问题、建议按什么顺序读，以及哪些结论不能从这些文档里读出来。[INDEX.zh-CN.md](INDEX.zh-CN.md) 中除四份带日期的 `reports/*.md` 快照外，每一篇文档都有中文对照（共 54 对）；`docs/proposals/` 下的七篇协议设计规范全部是中英对照。

## 1. 先理解三类文本

| 类型 | 代表文件 | 它回答什么 | 不能当作什么 |
| --- | --- | --- | --- |
| 规范 / 约定 | `SA-EIP-712-SPEC.md`、`SA-CONTRACT-HANDOFF.md`、`SA-FRONTEND-CORRESPONDENCE.md` | 链上哈希的字节布局、合约与 SDK / 前端的接口约定 | 不是部署证明，也不认证任意第三方实现 |
| 精化与证明 | `SA-FORMAL-VERIFICATION.md`、`SA-METHOD-REFINEMENT.md`（方法级精化全集） | 某一段 C# 源码在多大范围内被参考模型覆盖 | 不是完整 NeoVM / 编译器精化，也不是密码学可靠性证明 |
| 门禁与回执 | `SA-CLOSURE-GATE.md`、`SA-ENTRYPOINT-CLOSURE.md`、`docs/reports/*.json` | 当前哪些入口点算"已闭合"、依据是哪份回执 | 不是对当前 `HEAD` 的陈述；回执只对其记录的提交与字节有效 |

## 2. 建议阅读顺序

下列文件名都是英文规范名；对应的 `*.zh-CN.md` 与之一一对应，可按语言任选其一。

想判断"今天能不能上线"：`SA-CLOSURE-GATE.md` → `docs/reports/sa-closure-gate-20261117.json` → `SA-SYSTEM-STATUS.md`（有中文版）。

想改合约或写集成：`SA-EIP-712-SPEC.md` → `SA-CONTRACT-HANDOFF.md` → `SA-FRONTEND-CORRESPONDENCE.md` → `SA-METHOD-REFINEMENT.md` 第 1 节（工件清单）。

想评估证明边界：`SA-FORMAL-VERIFICATION.md` 的 Status 与 open boundaries 章节 → `docs/reports/sa-native-open-boundaries-20261008.json` → 再按需读单条精化文档。

想复现构建：`SA-REPRODUCIBLE-BUILD.md` → `NEO-PLATFORM-PACKAGES.md` → `docs/reports/sa-artifact-reproducibility-20261116.json`。

## 3. 各篇一句话定位

**门禁与闭合**

- `SA-CLOSURE-GATE.md`：把各条已限定作用域的证明按入口点做一次新的编排与身份连接。它不重新证明任何一条既有结论，只决定这些结论能否合成为一个"该入口点已闭合"的判断。
- `SA-ENTRYPOINT-CLOSURE.md`：逐入口点的结构清单。它是独立的结构检查，不是语义定理。
- `SA-CONTRACT-HANDOFF.md`（第十八号闭合作用域）：合约内部交接的内核检查结论。第十九至二十一号作用域在 `SA-METHOD-REFINEMENT.md` 内，分别见 interop 参数转换、interop 描述符计费窗口效应与异常身份三节。

**精化与证明**

- `SA-FORMAL-VERIFICATION.md`：总入口。给出 Coq 模型范围、运行时对应关系与**未覆盖边界**。任何"已形式化验证"的说法都必须能在这篇里定位到具体作用域。
- `SA-IMPLEMENTATION-REFINEMENT.md`：custom 合约实现的精化目标与验收条件。
- `SA-METHOD-REFINEMENT.md`：方法级精化的单一文档，13 节各自独立、互不叠加：
  - 第 1 节 工件清单与完整指令表——只做结构对账，明确声明不证明 VM、ApplicationEngine、编译器、存储或整方法语义；
  - 第 2–4 节 报销 helper 的源码投影、参考 VM 证书与固定引擎运行时检查；
  - 第 5–7 节 预留算术、数值强制转换与 `AddFee` 费用语义；
  - 第 8–9 节 三个公开纯方法体的参考精化，以及受赞助入口的端到端运行时检查；
  - 第 10–12 节 `System.Contract.Call` / `CALLT` 准入、interop 参数转换（第十九号）与描述符计费窗口效应（第二十号）；
  - 第 13 节 异常身份与可捕获性（第二十一号）。

**协议设计规范（原生 ABI 2，`docs/proposals/`）**

- `SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md`：整份 ABI 2 规范的主体——身份派生与地址、14 字段账户记录、权威分离与生命周期、模块绑定与代码身份、UserOperation 授权与执行、资源与费用计量、治理与升级、迁移、必需 ABI 面与符合性向量。修改链上行为前先读这一篇。
- `SMARTACCOUNT-NATIVE-MODULE-PROFILES.md`：六个原生工件的兼容性边界、构建与打包规则、必需验证与形式化对应边界。
- `SMARTACCOUNT-NATIVE-MULTISIG.md`：组合验证器配置档、瞬态批准回执、依赖清理，以及参数与结果的深度隔离义务。
- `SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.md`：`0xA2 || policyPrefix || accountIdLE20 || authorityEpochLE64 || suffix` 键布局，以及恢复时的权威代次撤销。
- `SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.md`：源码构建运行时、签名代理、配置根变更与联合见证恢复的私有链证据。
- `SA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.md`：`System.Contract.CallWithGasLimit` 平台扩展提案与预算语义。
- `SMARTACCOUNT-ISSUE-242-CONFORMANCE.md`：issue #242 的六个必需章节与六条验收标准的逐条映射。

以上七篇都有同名 `.zh-CN.md` 对照；结构、代码围栏与行内标识按英文原文逐字保留。

**接口约定**

- `SA-EIP-712-SPEC.md`：V3 验证器在链上哈希的类型化数据布局。改签名域必须同时改这里。
- `SA-FRONTEND-CORRESPONDENCE.md`：源码前端与编译器的对应关系，篇幅最大，属于"逐条对账"文档。
- `SA-REPRODUCIBLE-BUILD.md`：固定工具链与逐字节重建流程。

**生态与运营**

- `PLUGIN_DEVELOPER_GUIDE.md`：插件（验证器 / 钩子）开发者的安全指南与生命周期要求。
- `ETHEREUM_AA_COMPARISON.md`：与 ERC-4337 / 7579 / 7702 / 7715 的对齐点与**刻意分歧**。注意其中 "AA" 指以太坊账户抽象，不是本产品名。
- `FRONTEND_DEPENDENCY_SECURITY.md`：前端依赖暴露面。
- `NEO-PLATFORM-PACKAGES.md`：经审计的 Neo 平台包固定值与验证器 Gas 系统调用。
- `testnet-validation-runbook.md`、`POST_DEPLOY_SMOKE_TEST.md`：网络校验与部署后冒烟清单（主网只读、测试网与部署后冒烟三个 runbook 都有中文版）。

## 4. 读这些规范文档时必须带上的三条前提

1. **回执只对它记录的东西有效。** `docs/reports/` 里的每份 JSON 绑定当时的提交、工件与运行时；它从来不是对当前工作树的陈述。回执不在本检出中时，不能当作当前发布证据。
2. **`NO-GO` 是诚实状态，不是回归。** 闭合回执在零个已验证入口点时输出 `status: NO-GO`；把它读成"系统坏了"是误读，把它读成"可以上线"更是误读。
3. **作用域（scope）就是全部。** 每份证明都写明它覆盖的字节数、指令数、方法与运行时；超出该作用域的推断——尤其是"任意第三方插件"和"任意代币"——在文档中始终被列为未覆盖。

## 5. 术语速查

| 术语 | 含义 |
| --- | --- |
| 闭合作用域 / closure scope | 一份被登记、可被门禁编排的证明单元 |
| 内核检查 / kernel-checked | 结论由 Coq 内核接受，而非脚本运行通过 |
| 精化 / refinement | 证明实现与参考模型在指定范围内行为一致 |
| 失败关闭 / fail-closed | 无法确认时一律拒绝，而不是回退到宽松路径 |
| 作用域内通过 / scoped PASS | 仅在该回执记录的作用域内成立 |
| ratchet（棘轮） | 文档守卫中只允许收紧、不允许放宽的台账条目 |

## 6. 维护约定

新增规范或参考章节时，请同时提供中文对照，并同步更新本页的定位表与 [INDEX.zh-CN.md](INDEX.zh-CN.md) 的语言矩阵；不存在“仅英文”的例外。中文文件必须与英文同构，保持两侧的代码标识与路径一致（守卫会扫描中文文档中的反引号标识）。

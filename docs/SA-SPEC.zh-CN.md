# SA 规范与形式化章节：中文导读

本页是英文规范章节的**中文导读**，不是规范文本的替代。规范、门禁结论与回执内容一律以对应英文文档与实际回执文件为准。写在这里的结论用于帮助中文读者决定"先读哪一篇、这篇到底回答什么问题"，不构成新的承诺。

双语覆盖情况见 [INDEX.zh-CN.md](INDEX.zh-CN.md) 的语言矩阵。语言策略按读者分层：面向读者与运营者的章节（规范主体、账户操作、runbook 等）保留中文对照，每篇中文文件首段都声明与英文同构、冲突时以英文为准；过程 / 验证 / 审计 / 交接层（闭合门禁、形式化验证、逐入口点闭合、前端对应关系、迁移 manifest、合约交接、构建复现与未锁的 proposals）仅提供英文——文档重组第二阶段已把这层的七份原文档合并为 [engineering/](engineering/) 下的两本书（VERIFICATION-AND-GATES 与 HANDOFF-RECORDS），下文的定位按章指入。本页保留为导读：说明每篇回答什么问题、建议按什么顺序读，以及哪些结论不能从这些文档里读出来。

## 1. 先理解三类文本

| 类型 | 代表文件 | 它回答什么 | 不能当作什么 |
| --- | --- | --- | --- |
| 规范 / 约定 | `SDK.md`（EIP-712 签名章节）、`engineering/HANDOFF-RECORDS.md`（合约交接章与前端对应关系章） | 链上哈希的字节布局、合约与 SDK / 前端的接口约定 | 不是部署证明，也不认证任意第三方实现 |
| 精化与证明 | `engineering/VERIFICATION-AND-GATES.md`（SA 形式化验证章） | 某一段 C# 源码在多大范围内被参考模型覆盖 | 不是完整 NeoVM / 编译器精化，也不是密码学可靠性证明 |
| 门禁与回执 | `engineering/VERIFICATION-AND-GATES.md`（闭合门禁章与逐入口点闭合清单章）、`docs/reports/*.json` | 当前哪些入口点算“已闭合”、依据是哪份回执 | 不是对当前 `HEAD` 的陈述；回执只对其记录的提交与字节有效 |

## 2. 建议阅读顺序

下列文件名都是英文规范名；面向读者的章节有同名 `.zh-CN.md` 对照，过程 / 验证 / 交接层（闭合、精化总入口、对应关系、迁移、交接、构建复现、未锁的 proposals）仅提供英文，[INDEX.zh-CN.md](INDEX.zh-CN.md) 中已逐条标注。

想判断“今天能不能上线”：`engineering/VERIFICATION-AND-GATES.md` 的集成精化闭合门禁章 → `docs/reports/sa-closure-gate-20261117.json` → `ARCHITECTURE.md` 的“系统状态与能力边界”章（有中文版）。

想改合约或写集成：先读[现行账户协议](SA-MODULE-PROTOCOL.zh-CN.md)，按[模块 NEP 接入说明](proposals/SMARTACCOUNT-MODULE-NEPS.zh-CN.md)找到对应的接口与权限条款，再查[SDK](SDK.zh-CN.md)和[原生 ABI](../tests/fixtures/native-smartaccount.manifest.json)。

想评估证明边界：`engineering/VERIFICATION-AND-GATES.md`（SA 形式化验证章）的 Status 与 open boundaries 章节 → `docs/reports/sa-native-open-boundaries-20261008.json` → 再按需读单条精化文档。

想复现构建：`engineering/VERIFICATION-AND-GATES.md` 的 SA 可复现构建章（含平台包固定值与 verifier gas syscall 章节） → `docs/reports/sa-artifact-reproducibility-20261116.json`。

## 3. 各篇一句话定位

**门禁与闭合**

- `engineering/VERIFICATION-AND-GATES.md`（集成精化闭合门禁章）：把各条已限定作用域的证明按入口点做一次新的编排与身份连接。它不重新证明任何一条既有结论，只决定这些结论能否合成为一个“该入口点已闭合”的判断。
- `engineering/VERIFICATION-AND-GATES.md`（逐入口点闭合清单章）：逐入口点的结构清单。它是独立的结构检查，不是语义定理。
- `engineering/HANDOFF-RECORDS.md`（合约交接章，第十八号闭合作用域）：合约内部交接的内核检查结论。第十九至二十一号作用域的方法级记录曾收录于已移除的方法级精化文档，其反射产物仍归档在 `formal/refinement/fixtures/current-method-proof/`。

**精化与证明**

- `engineering/VERIFICATION-AND-GATES.md`（SA 形式化验证章）：总入口。给出 Coq 模型范围、运行时对应关系与**未覆盖边界**。任何“已形式化验证”的说法都必须能在这章里定位到具体作用域；其附录（custom 合约实现的精化）载有实现精化的目标与验收条件。
- 方法级精化的逐方法记录（工件清单、报销 helper、预留算术、公开纯方法体、`System.Contract.Call`／`CALLT` 准入、interop 参数转换、描述符计费窗口效应与异常身份）曾作为单篇文档存在。它描述的是已退役 custom 合约的方法体，因此随 custom 实现一并移除；可核对的反射产物仍归档在 `formal/refinement/fixtures/current-method-proof/`，并由 `formal/refinement/method_proofs.py` 复算。

**现行协议设计规范**

- [核心协议 NEP](proposals/nep-smartaccount-entry-verifier.mediawiki)规定收款地址、13 字段操作、授权和恢复边界；[中文协议](SA-MODULE-PROTOCOL.zh-CN.md)给出字段、计量和状态转换。
- [模块公共接口和各模块条款](proposals/SMARTACCOUNT-MODULE-NEPS.zh-CN.md)规定发现、配置和回调；[原生模块构建说明](proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.zh-CN.md)说明指定模块产物如何打包。
- [原生评审对照表](proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md)区分协议条款、实现证据和外部接纳；[实现清单](../contracts/native/profile.json)记录仍开放的门禁。

**接口约定**

- `SDK.md`（EIP-712 signing 章节）：V3 验证器在链上哈希的类型化数据布局。改签名域必须同时改这里。
- `engineering/HANDOFF-RECORDS.md`（前端对应关系章）：源码前端与编译器的对应关系，篇幅最大，属于“逐条对账”文档。
- `engineering/VERIFICATION-AND-GATES.md`（SA 可复现构建章）：固定工具链与逐字节重建流程，含经审计的 Neo 平台包固定值与验证器 Gas 系统调用。

**生态与运营**

- `SA-MODULE-PROTOCOL.md` 附录（Appendix: Module developer guide，仅英文）：插件（验证器 / 钩子）开发者的安全指南与生命周期要求。
- `ARCHITECTURE.md`（“与以太坊 AA 对比”章）：与 ERC-4337 / 7579 / 7702 / 7715 的对齐点与**刻意分歧**。注意其中 “AA” 指以太坊账户抽象，不是本产品名。
- `SECURITY.md` 附录 B：前端依赖暴露面。
- `OPERATIONS.md`：网络校验与部署后冒烟清单（主网只读、测试网与部署后冒烟三个 runbook 都有中文版），以及实测的性能基线。

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

新增规范或参考章节时，先按 [INDEX.zh-CN.md](INDEX.zh-CN.md) 的语言矩阵判断层级：面向读者的章节请同时提供中文对照，并同步更新本页的定位表与语言矩阵；过程 / 验证 / 审计 / 交接层仅提供英文，不得“顺手”补一份会随门禁运行过期的译文。中文文件必须与英文同构，保持两侧的代码标识与路径一致（守卫会扫描中文文档中的反引号标识）。

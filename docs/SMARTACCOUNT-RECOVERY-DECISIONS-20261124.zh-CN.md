# SmartAccount 恢复协议裁决记录 · 2026-11-24

本记录承接 [协议审计交接](SMARTACCOUNT-AUDIT-HANDOFF.zh-CN.md) 中“首先裁决的两个协议问题”。**总体验收结论不变，仍为 PARTIAL / NO-GO**：本次只闭合了两个被点名的问题，交接表中的完整行为证明、归档入口证明、成本测量和独立安全审计都没有推进。工作基线仍是分支 `codex/smartaccount-conformance`、HEAD `9e62ad3` 加未提交改动。

## 一、更换恢复人或延长等待期时，旧提案是否有效

### 裁决

进行中的恢复请求按**发起时的策略快照**裁决。标准恢复席位在 `beginRecovery` 时保存核心的恢复授权方与 `recoveryTimelockMs`，执行时要求两者仍等于核心当前值；原有的权限代次快照继续独立核对。

| 语义 | 触发条件 | 旧提案 | 谁可以处理 |
| --- | --- | --- | --- |
| 撤销权限 | 恢复地址换成不同地址 | 失效，`SA_EPOCH_STALE` | 当前托管方或新授权方可取消旧记录并重新发起，新请求完整等待 |
| 只改延时 | 等待期改成不同数值 | 失效，`SA_EPOCH_STALE` | 同上；新数值只约束此后发起的请求 |
| 幂等重写 | 授权方、等待期、保留位全部相同 | **继续有效** | 无需处理；普通完成入口照常 |

规则对核心直接写入 `setRecoveryPolicy` 与治理批量动作 8 相同，因为两条路径共用同一个落地函数。

普通完成入口与钱包审阅入口的差别是刻意的，需要在集成时理解：

- 普通完成只看策略快照和权限代次。幂等重写不改这两者，所以旧请求仍可完成。
- 钱包审阅的取消/完成交易额外绑定确认时看到的核心配置 nonce。任何恢复策略写入（包括幂等重写）都会推进配置 nonce，因此已审阅的交易必须重新审阅。这是“审阅新鲜度”检查，不是“提案有效性”检查。

### 为什么不能沿用原规则

原实现只在发起时保存到期时间和权限代次。恢复策略写入只推进配置 nonce 和控制修订号，不推进权限代次，因此更换恢复人或延长等待期后，旧提案仍可通过普通完成入口执行：延长等待期实际上对已在途的请求不生效，被替换的旧授权方提出的托管权轮换也仍能落地。钱包审阅入口因为绑定配置 nonce 会拒绝，两个入口对同一事实给出相反答案。

### 修正前后

| 项目 | 修正前 | 修正后 |
| --- | --- | --- |
| 发起时保存 | 到期时间、权限代次 | 另加恢复授权方与等待期（存储前缀 `0x03`） |
| 普通 `executeRecovery` | 只核对权限代次与到期时间 | 另核对策略快照，不一致以 `SA_EPOCH_STALE` 失败 |
| 卸载清理 | 清 `0x01`、`0x02` | 另清 `0x03` |
| 离线可见性 | 无法判断请求是否已失效 | 新增只读 `getRecoveryPolicySnapshot(accountId)`，返回 `[authority, timelockMs]` 或空数组 |

失败交易不写入托管权、策略、nonce 或模块状态，回滚由原有调用框架保证。

### 受影响的入口与文件

- 核心入口：`setRecoveryPolicy`、`applyConfigurationActions` 的动作 8（行为不变，但从此决定旧提案的生死）。
- 恢复模块入口：`beginRecovery`、`executeRecovery`、钱包审阅用的取消与完成入口（间接受影响）、`onUninstall`，以及新增的 `getRecoveryPolicySnapshot`。
- 规范条款：`docs/SA-MODULE-PROTOCOL.md` 与 `docs/SA-MODULE-PROTOCOL.zh-CN.md` 第 3 节恢复策略段落；`docs/proposals/nep-smartaccount-module-profiles.mediawiki` 的 RecoveryModule 条款。

## 二、`ownerOnlyRecovery` 对用户承诺什么

### 裁决

它是 **0x51 记录中为布局兼容保留的字段，没有任何授权含义**。当前协议的合法输入只有 `false`，`true` 以 `SA_OPERATION_MALFORMED` 拒绝。恢复的发起和取消始终由托管方或核心记录的恢复授权方见证，与这个位无关。任何客户端都不得把它呈现为“只有所有者可以恢复”。

选择“保留并拒绝 true”而不是“定义成权限开关”的理由：本协议已经用恢复授权方解决托管权丢失问题，再引入“仅所有者可恢复”会与恢复授权方模型冲突，而且会把权限策略重新拉回原生核心，违背“核心尽量小、辅助策略下放模块”的设计决定。旧合约中同名测试描述的是已退役自定义内核里的“永久仅所有者模式”，不是当前协议的证据。

### 修正前后

| 项目 | 修正前 | 修正后 |
| --- | --- | --- |
| 核心 `ApplyRecoveryPolicy` | 接受并原样存储布尔值 | `true` 以 `SA_OPERATION_MALFORMED` 拒绝，核心与治理批量路径相同 |
| SDK 类型 | `ownerOnlyRecovery: boolean` / `?: boolean` | `ownerOnlyRecovery: false` / `?: false` |
| SDK 与钱包构造器 | 接受任意布尔值 | 非 `false` 在构造计划前报错 |
| 文档 | 仅在打包说明中提示“不强制” | 中英文协议、SDK 文档、模块说明均写明保留位语义 |

### 受影响的入口与文件

- 核心入口：`setRecoveryPolicy`、`applyConfigurationActions` 的动作 8。
- `contracts/native/SmartAccount/SmartAccount.Modules.cs`、`SmartAccountRecords.cs`。
- `sdk/js/src/native.d.ts`、`sdk/js/src/index.d.ts`、`shared/nativeSmartAccountClient.mjs` 及其前端副本、`frontend/src/features/native/nativeWorkspace.js`。
- `sdk/js/PACKAGING.md`、`docs/SDK.md`。

### 未清理的历史材料

`scripts/localchain/sa_rpc_scenarios.py` 的 `sc_v4_owner_only_recovery`、`tests/SmartAccount.Contracts.Tests/OwnerOnlyRecoveryRuntimeTests.cs` 和 `tests/fixtures/sa-module-protocol/golden-vectors/migration.json` 仍描述旧合约的“仅所有者”语义。它们针对的是已退役自定义内核，本次没有改动。在决定是否删除或归档之前，不能把它们当作当前原生协议的证据。

## 三、指纹

核心 DLL **没有重新构建**，`c4d9b734…` 仍是交接时的旧产物指纹，不包含本次改动。下表是源码与文档指纹的前后对比。

| 文件 | 修正前 | 修正后 |
| --- | --- | --- |
| `contracts/modules/RecoveryModule/RecoveryModule.cs` | `3fd70d3f4ea4195d` | `87e2b390871a5795` |
| `contracts/native/SmartAccount/SmartAccount.Modules.cs` | `503069f2da468af6` | `8107c74dbadbba2a` |
| `contracts/native/SmartAccount/SmartAccountRecords.cs` | `7f692fc7735acf0d` | `e1decd8aadc96cc9` |
| `docs/SA-MODULE-PROTOCOL.md` | `ad132c0f3c0832c3` | `96bafaf498b4c254` |
| `docs/proposals/nep-smartaccount-module-profiles.mediawiki` | `f07228da6bcb9abe` | `d4cff5c8bc27f431` |
| `docs/proposals/smartaccount-named-module-interfaces.json` | `c1295d4c90a7d8b3` | `8861f7c85ae3d9b9` |
| `formal/source-lock.json` | `11ca36d33f465bcd` | `556c9d0efd6fcf78` |

`formal/source-lock.json` 只移动了六个已有条目的哈希，没有增删条目。对应的内容摘要台账已在 `frontend/tests/docsTruth.test.js` 中更新。

## 四、验证结果

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| 恢复模块编译 | 通过 | `RecoveryModule.csproj` 构建成功 |
| 模块 NEP 与 ABI | 通过 | 20 个模块重新编译后清单与源码 profile 一致；`RecoveryModule` 具名接口核对通过 |
| 源码锁 | 通过 | 锁内所有磁盘文件哈希一致 |
| SDK 单元测试 | 174/174 通过 | 含新增的保留位拒绝用例 |
| SDK 类型检查 | 通过 | `tsc --noEmit` |
| 前端原生工作区测试 | 44/44 通过 | 含更新后的恢复策略动作用例 |
| 前端文档真值套件 | 97/97 通过 | 最终一轮完整运行 |
| 原生核心编译 | **未运行** | 本机没有交接要求的 Neo Core 检出，原生项目无法解析项目引用 |
| 原生单元测试 | **未运行** | 新增的保留位拒绝用例已写入但未执行 |
| 标准模块集成测试 | **未运行** | 新增的四个恢复策略用例已写入但未执行 |
| 形式化模型 | **未运行** | Coq 模型没有加入策略快照失效的定理，见下节 |

新增但尚未执行的回归：

- `tests/SmartAccount.Native.Tests/UT_SmartAccountAuthorization.cs`：`ReservedOwnerOnlyRecoveryInputIsRejected`。
- `tests/SmartAccount.Native.Tests/Integration/UT_SmartAccountStandardModules.cs`：`RecoveryAuthorityChangeRetiresPendingRequest`、`RecoveryTimelockChangeRetiresPendingRequest`、`IdempotentPolicyRewriteKeepsPendingRequestButStalesReviewedTransaction`、`GovernedBatchRecoveryPolicyChangeRetiresPendingRequest`。

这些测试尚未经过编译器检查。接手人在具备 Neo Core 检出后应先运行它们；如与实现有出入，以中英文协议中写明的裁决为准修正实现。

前端全量单测另有 2 个与本次无关的既有失败（Morpheus 公共注册表与运行时目录未与 neo-os-services 导出同步），不在本次改动范围内。

## 五、仍未闭合

1. **原生侧完全未验证。** 本记录的所有原生结论来自代码阅读和规范对照，不是执行证据。
2. **形式化模型落后于实现。** `formal/coq/NativeAuthorityEpoch.v` 的恢复模型只跟踪权限代次和配置 nonce，没有表达“策略快照匹配才可执行”，也没有 `ownerOnlyRecovery` 恒为 false 的不变量。在补上定理并通过之前，模型不能用来支持本次裁决。
3. **重放窗口。** 把授权方从 A 改成 B 再改回 A、且等待期不变时，A 的旧请求会重新满足快照。裁决按“当前策略与发起时相同即有效”处理，没有引入单调的策略版本号。若安全评审认为一次撤销应当永久作废旧请求，需要给 0x51 增加策略版本字段，这会改变记录布局，应单独决策。
4. **交接表中的优先级 1–5 均未推进。**

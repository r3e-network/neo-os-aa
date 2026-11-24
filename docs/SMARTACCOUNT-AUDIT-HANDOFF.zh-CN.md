# SmartAccount 协议审计交接 · 2026-11-24

**验收结论为 PARTIAL / NO-GO。** 当前有证据支持原生核心的 29 个入口分派正确、20 个模块符合声明的接口。尚无证据支持“所有合法输入和状态下，实现均符合协议”。接手后优先核对恢复权限变更与已经开始的恢复请求。这个问题影响谁能成为托管人，值得先于扩展 getter 证明处理。

## 交付目标和设计决定

项目尚未发布，只维护一个协议。原生核心尽量小，支持收款、转账和必要的授权约束。签名名单、门限成员、恢复流程及其他辅助策略下放到模块。模块遵循接口和模块类别两份 NEP 草案。多签必须约束托管人。退出强制支出多签只能经过预先设置的延时恢复。新权限地址加入时必须提供 witness。核对开户、变更恢复人、提出新 custody 各自的生效时点，避免把提议时的同意错误地变成执行时还需在线。[协议](SA-MODULE-PROTOCOL.zh-CN.md) · [模块 NEP 索引](proposals/SMARTACCOUNT-MODULE-NEPS.zh-CN.md)

## 接手的具体代码

使用现有工作区的分支 `codex/smartaccount-conformance`。交接时 HEAD 为 `9e62ad3c254d960dc5aa7e65a1f307a80814bc19`，含未提交修改、未跟踪证明工具和被 Git 忽略的收据。单独检出这个提交无法恢复交接状态。上次成功读到的远端 main 是 `66b1715894f1eb38354ccc02f6cbdeb1c29911aa`，交接时再次查询遇到 TLS 连接失败。若在其他机器接手，先取得对应的工作区快照，再核对输入指纹。[当前构建输入及输出](reports/smartaccount-current-20261124/current-native/build.json)

| 验收对象 | 已得到的证据 | 仍欠缺的结论 |
| --- | --- | --- |
| 当前原生 SmartAccount | 固定 Neo Core 提交和 SDK，在两个干净目录分别构建，4 个 DLL 的对应字节一致。核心 SHA-256 为 `c4d9b734600864fc3af8bbfbd9eefe9643c43f20ea1c221a4a70ad85ddea57d6`。同一核心上 29/29 个入口核对了分派和签名，覆盖 65 个参数槽、464 组入口与标志组合，311 个拒绝用例经引擎验证。[分派收据](reports/smartaccount-current-20261124/current-native/dispatch/result.json) | 完整行为证明 0/29。参数转换、实际方法体、状态写入、费用、异常及回滚仍须连到同一实际运行时。 |
| 标准模块 | 两份草案覆盖 20 个具名模块。20 份编译 manifest 和 20 个部署后的声明读取均匹配。20 个命令通过，错误参数个数和数值类型的对照分别拒绝 20、14 项。[模块引擎记录](reports/smartaccount-current-20261124/module-wire-types/vm-summary.txt) | 模块自身状态机及与核心组合后的权限、失败原子性。草案接纳属于外部事项。 |
| 用户合约归档 | 100 入口归档与 90 入口 main 产物分别锁定。100 入口有分派及若干方法的条件语义证据。[归档入口](reports/smartaccount-current-20261124/ordinary-entry/result.json) · [main 入口](reports/smartaccount-current-20261124/main-entry/result.json) | 用户曾明确要求 100/100。归档仍是完整证明 0/100。109 入口编译器参考构建也有自己的收据，三份产物各自计数。 |
| 原生回归 | 已有一次 1,719 项通过、零跳过的回归。[运行记录](reports/smartaccount-current-20261124/governed-config-native.log) | 当前可复现 DLL 的匹配收据只记录了两项针对分派和发现接口的运行时测试。签字前需在最终选定产物上复核所依赖的回归。[当前运行记录](reports/smartaccount-current-20261124/current-native/host.trx) |

## 首先裁决的两个协议问题

2026-11-24 续：两项已裁决并落到规范、核心入口、恢复模块、SDK 与钱包，但原生测试和形式化模型尚未执行。裁决、修正前后行为、指纹和验证范围见 [恢复协议裁决记录](SMARTACCOUNT-RECOVERY-DECISIONS-20261124.zh-CN.md)。总体验收结论不变。

1. **更换恢复人或延长等待期时，旧提案是否还有效？** 标准模块在发起时保存到期时间与权限代次，完成时核对两者和当前恢复人非零。原生核心的直接写入路径写入新恢复人、延时及标志后调用 `Advance()`，该函数推进配置 nonce 和控制修订号。模块有普通完成入口和绑定当前配置 nonce 的 reviewed 入口。接手人应列出撤销权限、只改延时、幂等重写三种语义，对照中英文协议，检查普通与 reviewed 两种完成方式，以及直接写入和治理批量写入。若规则不足，明确旧提案何时失效、谁能撤销和重新发起，再同步规范、实现、模型与回归。此处已确认代码行为的组成部分，尚未定性为漏洞。[恢复模块](../contracts/modules/RecoveryModule/RecoveryModule.cs) · [原生策略写入](../contracts/native/SmartAccount/SmartAccount.Modules.cs) · [计数器](../contracts/native/SmartAccount/SmartAccountRecords.cs)
2. **当前协议的 `ownerOnlyRecovery` 对用户承诺什么？** 核心记录将它注释为 reserved，但更新入口接受布尔值，事件与查询公开回传。标准恢复模块的发起和取消都调用 `RequireCustodyOrRecovery`。核对规范、SDK 和钱包是否向用户承诺“只有所有者可以恢复”。若是保留位，统一规定合法输入和客户端呈现；若它是权限开关，定义受它约束的动作、授权者和已有提案的处理规则，并验证对应行为。旧合约的同名测试不能代替这个裁决。[核心记录](../contracts/native/SmartAccount/SmartAccountRecords.cs) · [模块授权](../contracts/modules/Shared/ModuleSupport.cs) · [SDK 声明](../sdk/js/src/native.d.ts)

## 随后按资金权限完成验收

| 优先级 | 工作 | 可以签字的条件 |
| --- | --- | --- |
| 1 | 多签启用后的所有资金和管理路径 | 检查直接、单笔、批量、治理、冻结/解冻、凭据变更、模块移除和 reset。所有可达路径均保持已登记的门限；到期前不能恢复单签，到期后按原提案恢复。测量准确的到期边界，核对失败后 custody、策略、nonce、存储及通知。现有测试可从 `ThresholdOwnsSpendingUntilPresetRecoveryMatures` 和 `FrozenAccountRecoversThroughDeployedSeatAfterTimelock` 起步。[集成测试](../tests/SmartAccount.Native.Tests/Integration/UT_SmartAccountStandardModules.cs) |
| 2 | 协议正确性、完整性和使用成本 | 为开户收款、基础转账、多签支出、恢复各列正常和拒绝流程。中英文、SDK、钱包、原生实现对权限主体、签名、错误和单位须一致。用一次实际操作列出 RPC 次数、交易数和费用组成，分别报告常见用法和协议上限。 |
| 3 | 29 个当前原生入口与标准模块 | 从 manifest 枚举入口，每行绑定规范条款、前置条件、授权、状态变化、返回、费用、故障及回滚。先贯通一个完整入口，记录公共引擎引理，再覆盖其余入口。对能力不能替代的模块分别验证，特别是治理模块代码更新、回调资源限制和策略存储归属。[原生 ABI](../tests/fixtures/native-smartaccount.manifest.json) · [开放验收项](../contracts/native/profile.json) |
| 4 | 100 个归档用户入口 | 绑定同一套源码、编译器、100 入口 manifest 和 NEF，逐入口证明编解码、实际 VM 行为、费用和异常回滚。明确可信假设与未证明环节。完整计数只接受满足所有义务的入口。[已有证明边界及产物指纹](reports/smartaccount-current-20261124/README.md) |
| 5 | 发布与独立安全审计 | 单列公共 artifact 读回、Neo Core 接纳、hardfork 和公共网络激活。此前深度安全扫描未启动，历史工具错误为 `Deep Scan cannot safely start a read-only worker: the parent must provide a managed filesystem permission profile.` 在具备对应条件后取得真实扫描结果。 |

## 复验入口

在仓库根目录执行。将 `NEOOS_NATIVE_CORE_SOURCE` 指向已审阅的 Neo Core 检出。当前构建收据使用 `e7fcc132f6546c55ad7342f26d69081a71357be5` 和 .NET SDK `10.0.400`。使用新目录保存复验结果，便于逐字节比较。

```sh
audit_out=$(mktemp -d)
python3 formal/refinement/native_overlay_build.py --core "$NEOOS_NATIVE_CORE_SOURCE" --output "$audit_out"
python3 formal/refinement/native_discovery_proofs.py --assembly "$audit_out/Neo.dll" --output "$audit_out/discovery"
./scripts/verify_repo.sh --profile native --contracts-only
python3 scripts/check_module_neps.py --compiler "$HOME/.dotnet/tools/nccs" --vm-getters --vm-commands
```

复验分派时，在测试进程实际加载上述 DLL 的前提下设置 `SMARTACCOUNT_DISPATCH_EVIDENCE`，运行 `EveryNativeWrapperResolvesItsDeclaredHandler`，再把输出 JSON 与同一 DLL 传给 `formal/refinement/native_dispatch_proofs.py`。更换构建后必须比较测试记录内的 assembly 哈希。记录每个已修问题的协议条款、受影响入口、修正前后行为与产物指纹。完整验收计数和公共网络接纳各自出结论。

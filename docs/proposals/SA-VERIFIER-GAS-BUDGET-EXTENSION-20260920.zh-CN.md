# SA 验证器 Gas 预算扩展

**状态：** 平台扩展提案草案；私有集成已验证，公共激活待定
**日期：** 2026-09-21；验证刷新：2026-10-04
**范围：** Neo N3 SA 配置档所需的 NeoVM / DevPack 能力

## 摘要

当前的 NeoVM `System.Contract.Call` 操作在调用方交易 gas 预算内执行子合约，但它没有为一次不受信任的子调用暴露不可绕过的预算。因此，调用任意验证器的 SA 账户无法为 `validateSignature` 设置独立的上限。

本提案新增 `System.Contract.CallWithGasLimit`。它是平台能力，而不是 SA 合约本地的记账约定。该能力分配一个由执行引擎强制、且被所有后代继承的子预算。其目的是让 SA 核心能够调用验证器，而不允许该验证器消耗整个交易预算。

该实现已在隔离的 Neo core 与 DevPack 工作树中原型化，并配合 `Neo.SmartContract.Framework` 3.10.2-CI00384 集成进当前 `neo-os-sa` 工件。一个匹配的私有 NeoExpress 运行时在区块 0 激活 `HF_SmartAccountV1`，并通过 JSON-RPC 回读产出的工件。本提案不主张任何公共激活、部署或广播。

## 动机与威胁模型

`Runtime.GasLeft`、验证器自行提供的 `BurnGas` 约定、交易 gas 限制，或调用前估算，都不能限制一个已在执行的子调用。这些机制要么保持自愿性质，要么约束整个交易。威胁来自恶意或缺陷验证器：它执行昂贵的 VM 工作，使账户或中继路径不可用。

所需性质是：

> 对于上限为 `L` 的有界调用，目标及其后代产生的每一笔可计费资源开销都记入 `L`；一旦 `L` 耗尽，该调用即失败，其状态变更由正常 Neo 应用引擎的原子性回滚。

本提案不使任意验证器变得正确、诚实或密码学安全。它只约束资源消耗。

## 规范 syscall ABI

```text
System.Contract.CallWithGasLimit(
    scriptHash: Hash160,
    method: String,
    flags: CallFlags,
    gasLimit: Integer,
    args: Array
) -> Any
```

DevPack 声明为：

```csharp
[Syscall("System.Contract.CallWithGasLimit")]
public static extern object CallWithGasLimit(
    UInt160 scriptHash,
    string method,
    CallFlags flags,
    long gasLimit,
    params object?[]? args);
```

`gasLimit` 参数以 datoshi 为单位，与 `Runtime.GasLeft` 使用的同一公共单位。引擎使用生效的费用与操作码乘数把它转换为其内部 femtoGAS 记账单位。调用方不得传入负数或零上限。大于剩余交易预算的上限必须在创建子上下文之前被拒绝。

该 syscall 保留普通 `Contract.Call` 的检查：

- 目标合约必须存在；
- 方法必须是公开 ABI 方法，且不得以 `_` 开头；
- 参数数量必须与 ABI 匹配；
- 调用标志必须有效且被调用方允许；
- 硬分叉激活必须由执行引擎检查。

## 预算语义

1. 引擎为该子调用创建一个私有预算 `B = (limit, parent)`。
2. 子调用中的每一笔可计费开销都记入 `B`，并在提交该开销之前记入父链上的每个祖先预算。
3. 普通的嵌套 `System.Contract.Call` 继承当前预算。
4. 嵌套的 `CallWithGasLimit` 创建新的子预算，但开销仍会穿过所有外层预算。后代不能通过选择新上限来逃逸祖先上限。
5. 费用白名单执行仍然消耗预算。白名单可以抑制交易计费，但不得禁用安全预算。
6. 预算耗尽使该调用失败。该失败不会被转换为 Boolean 失败或成功的空结果。
7. 有界调用失败时，既有的 Neo 交易/应用回滚规则适用于状态、通知与 nonce 变更。
8. 已完成的有界调用不消耗同级调用的独立预算；只有外层交易预算与任何仍处于活动状态的祖先预算继续适用。

该预算是执行引擎对象，不是合约存储。合约不得读取、修改或重置其他调用的预算。

## SA 集成配置档

平台能力激活后，SA 核心应把验证器分派替换为以下确切操作：

```csharp
Contract.CallWithGasLimit(
    state.Verifier,
    "validateSignature",
    CallFlags.ReadOnly,
    verifierGasLimit,
    accountId,
    op);
```

验证器上限必须是协议常量或带有文档化上限的账户/配置档取值。它不得由没有独立最大值的不可信操作提供。结果仍必须作为 Boolean 授权结果检查，且所有既有的 nonce、钩子、执行锁与回滚规则继续生效。

SA 配置档必须公布：

- 默认与最大验证器上限；
- 该上限是否覆盖验证器初始化与回调工作；
- gas 单位与费用因子解释；
- 失败与回滚行为；
- 最低 Neo 硬分叉激活；
- 编译后确切的 NEF 与清单哈希。

## 激活与兼容性

原型把该 syscall 注册在 `Hardfork.HF_SmartAccountV1` 之后。未激活该硬分叉的节点必须拒绝该 syscall，而不是静默执行无界调用。因此，使用新 syscall 编译的合约需要具备激活感知的部署计划，且不得宣称与缺少该 syscall 的节点向后兼容。

必需的依赖顺序：

1. 合并并版本化 Neo core 执行引擎实现。
2. 发布匹配的 DevPack syscall 声明与编译器支持。
3. 在目标网络上激活硬分叉并校验节点配置。
4. 针对匹配的 DevPack 编译 SA 核心。
5. 运行 SA 运行时、形式化边界与 NeoExpress 回读门禁。
6. 比较 C# 源码、NEF 字节、清单字节与已部署 RPC 回读。

## 验证向量

平台实现至少必须通过这些向量：

- 子调用超出其上限并失败；
- 普通嵌套 `Contract.Call` 仍受祖先约束；
- `CALLT` 仍受祖先约束；
- 嵌套有界调用不能逃逸祖先；
- 在上限内的子调用成功；
- 零、负数与超出交易预算的上限被拒绝；
- 费用白名单子调用执行仍然消耗预算；
- 预算耗尽时目标状态与通知回滚；
- 硬分叉激活前该 syscall 不可用。

当前隔离原型通过全部十四个聚焦有界调用测试，包括子状态回滚、通过普通调用与 `CALLT` 的祖先预算继承、`Runtime.LoadScript`、初始化与原生回调、白名单计费、Huyao 之后的 `RET` 归因，以及硬分叉前的 syscall 拒绝，外加编译器发出冒烟测试。集成后的 SA 合约与私有链回读也已通过；在本提案可被标记为普遍实现之前，仍需要公共激活与目标节点一致性。

## 安全与覆盖边界

本扩展只封闭独立的资源预算设计缺口。它不证明验证器密码学、见证解析、完整 NeoVM 语义、回调正确性、插件存储清理或 MultiSig 密钥独立性。这些仍属于分离的 SA 与平台保证义务。

## 当前实现状态

| 门禁 | 结果 |
| --- | --- |
| Neo core 原型 | 已在隔离工作树中实现 |
| Neo core 定向向量 | 14/14 通过 |
| Neo core 完整单元套件 | 1,453/1,453 通过 |
| DevPack 框架构建 | 通过 |
| DevPack 编译器 syscall 冒烟 | 通过 |
| 已发布 core 上的 DevPack 编译器单元套件 | 1,359/1,359 通过 |
| 已发布 DevPack 框架套件 | 已消费匹配的私有包；上游发布仍待定 |
| 当前 SA 源码使用该 syscall | 是；应用触发原型回调预算为 1,000,000,000 datoshi；原生配置档另行规定 100,000,000 datoshi |
| 当前 SA 工件使用该 syscall | 是；NEF 包含 syscall 哈希 `c45fbc51` |
| SA 合约测试 | 配合同级 NeoDIDRegistry 工件为 322/322 通过；独立检出为 320/322，含 2 个显式的跨仓库 DID 跳过 |
| 启用 syscall 的 SA 私有 NeoExpress | PASS；25 次部署、14 个场景、106 笔 HALT 与 2 笔 FAULT 持久化交易、38 个预期负向用例（36 个预检）、84 条断言、25 次完整 RPC 回读（含 DID 清单一致性）；密码学配置档向量包含裸 P-256 WebAuthn/TEE、委托 ZkLogin 与失败关闭的 ZKEmail |
| 公共网络激活/回读 | 未执行 |

当前私有回执为 `docs/reports/sa-neoexpress-validation-20261006.json`。该私有证据为匹配的本地工件缓解 VULN-001，并演练了已交付的组合叶子清理边界。它不是生产安全主张：公共激活/部署、目标节点一致性、密码学与见证语义、完整 NeoVM 精化、任意插件环缺失，以及独立外部审计仍待完成。

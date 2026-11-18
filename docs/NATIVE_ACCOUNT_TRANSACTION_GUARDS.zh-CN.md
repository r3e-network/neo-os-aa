# 原生账户交易守卫

> 中文版本与 `docs/NATIVE_ACCOUNT_TRANSACTION_GUARDS.md` 同构。若两者冲突，以英文版本为准。

原生 SDK 把模块策略取消绑定到签名方审阅过的完整待生效调用。已签名的 Application 脚本会在执行时再次检查该记录，然后调用既有的原生取消方法。这在客户端重新校验与交易打包之间，为被审阅内容的变化闭合了空窗，且不改变原生 ABI 或账户计数器。

## 完整的取消脚本

脚本按以下顺序执行这些指令，比对与取消之间没有任何额外调用：

```text
PUSH moduleType
PUSH accountIdBytes
PUSH 2; PACK
PUSH ReadOnly
PUSH "getPendingModuleCall"
PUSH SmartAccountHashBytes
SYSCALL System.Contract.Call

PUSH 1; PACK
PUSH None
PUSH "serialize"
PUSH StdLibHashBytes
SYSCALL System.Contract.Call
PUSH reviewedPendingCallBytes
EQUAL
ASSERT

PUSH moduleType
PUSH accountIdBytes
PUSH 2; PACK
PUSH All
PUSH "cancelModuleCall"
PUSH SmartAccountHashBytes
SYSCALL System.Contract.Call
```

`ReadOnly`、`None` 与 `All` 分别是调用标志 `5`、`0` 与 `15`。`moduleType` 是两个原生入口都要求的 UTF-8 字符串 `verifier` 或 `hook`；已存储记录的 role 字段是对应的整数 `0` 或 `1`。两个合约哈希与 `accountIdBytes` 都使用 VM 线序字节。第一次调用是原生读取，序列化是纯计算，而取消会在删除所选角色的槽位之前检查当前托管见证。该序列中没有外部模块回调，其他交易无法在这些指令之间执行。

## 规范字节

`reviewedPendingCallBytes` 是返回给调用方审阅的同一条待生效记录的确切 Neo 二进制序列化：

```text
[1, accountId, role, rootBinding, selectedBinding, methodBytes,
 invokedArguments, proposedAt, matureAt, configurationNonce]
```

外层值与各绑定都是 Array。Array 与 Struct 参数保持区分；ByteString 保留其字节；Integer 保留确切值；Null 与 Boolean 保留其 VM 类型。SDK 使用规范 VM 序列化器，绝不使用 JSON、显示顺序哈希或重建的方法专属参数。外层 Array 恰好包含十项，整条记录上限 8192 字节，与原生存储解码一致。参数深度与大小保留其既有配置限制。该守卫直接比对字节，不定义新的摘要或哈希域。

缺失的待生效调用会序列化为 Null 并使比对失败。任何字段变化都会在取消之前让 `ASSERT` 失败。畸形的原生记录同样会在删除之前出错。匹配成功仍需要当前托管见证；它不授予额外权限。出错的交易不会提交应用层写入。该检查不要求成熟、Active 账户或不存在恢复，从而保留原生取消策略。

## 提交与兼容性

取消方案保留 `role` 与 `pending`，并新增 `pendingCallBytes` 与 `requiresExactScript: true`。准备、模拟、签名、导出与导入都必须完整保留 `plan.script`。钱包的“方法 + 参数”请求无法表达该比对。此类方案必须走精确脚本 SDK 路径；界面不得回退到无守卫的 `wallet.invoke` 请求。

原生的两参数取消方法仍对有意授权取消当前角色槽位的应用开放。该守卫是受保护 SDK 交易的保证，不是对每个原生调用方强制的新不变量。既有原生方法、配置摘要、记录格式、身份、授权域与配置计数器语义都保持不变。较旧的客户端不会自动获得该守卫。

额外的原生读取、序列化、比对与内嵌字节会增加脚本大小与费用。既有的模拟与交易费用上限会适用于完整脚本；客户端不得复用旧单次调用的估算。

## 内容身份与回归覆盖

这是精确的内容绑定，不是唯一的提案实例标识。若某个待生效调用被取消后又以逐字节相同的方式重建，包括提案时间戳与配置 nonce，旧守卫仍会匹配。特别是同一区块内的相同重新提案可能具备该性质。要拒绝这种情况，需要持久的提案代际计数器或其他唯一的链上标识，以及单独的协议变更。

回归覆盖必须让实际的 SDK 脚本字节在原生引擎上执行：匹配的取消成功；内容被替换或缺失会出错；使用另一个角色不会取消任何一个被审阅的槽位；缺少托管会出错。去掉守卫的脚本可以说明为何仅靠原生两参数调用无法提供内容绑定。测试还覆盖规范 VM 类型的区分、替换期间账户记录不变、逐字节相同的边界，以及在交易签名过程中完整保留脚本。

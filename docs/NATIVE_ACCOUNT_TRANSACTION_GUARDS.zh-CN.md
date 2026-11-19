# 原生账户交易守卫

> 中文版本与 `docs/NATIVE_ACCOUNT_TRANSACTION_GUARDS.md` 同构。若两者冲突，以英文版本为准。

原生 SDK 把配置意图取消绑定到签名方审阅过的完整待生效意图记录。已签名的 Application 脚本会在执行时再次读取该记录，把它的规范字节与审阅过的字节比对，然后才调用原生取消方法。这在客户端重新校验与交易打包之间闭合了空窗，且不改变原生 ABI 或账户计数器。

## 完整的取消脚本

脚本按以下顺序执行这些指令，比对与取消之间没有任何额外调用：

```text
PUSH intentId
PUSH accountIdBytes
PUSH 2; PACK
PUSH ReadOnly
PUSH "getPendingConfiguration"
PUSH SmartAccountHashBytes
SYSCALL System.Contract.Call

PUSH 1; PACK
PUSH None
PUSH "serialize"
PUSH StdLibHashBytes
SYSCALL System.Contract.Call
PUSH reviewedIntentBytes
EQUAL
ASSERT

PUSH intentId
PUSH accountIdBytes
PUSH 2; PACK
PUSH All
PUSH "cancelConfiguration"
PUSH SmartAccountHashBytes
SYSCALL System.Contract.Call
```

`ReadOnly`、`None` 与 `All` 分别是调用标志 `5`、`0` 与 `15`。`intentId` 是 `proposeConfiguration` 在其 `ConfigurationIntentProposed` 通知中返回的 id；账户从单调计数器派生 id，因此 id 永不复用。两个合约哈希与 `accountIdBytes` 都使用 VM 线序字节。第一次调用是读取，序列化是纯计算，而取消会重新检查意图自身的授权。该序列中没有外部模块回调，其他交易无法在这些指令之间执行。

## 规范字节

`reviewedIntentBytes` 是调用方审阅过的记录的确切 Neo 二进制序列化：

```text
[true, intentId, proposedAt, matureAt, expiresAt, authorityEpoch, actionDigest, actions]
```

外层值与 `actions` 都是 Array，每个动作自身是 `[code, operand…]` 形式的 Array。Array 与 Struct 参数保持区分；ByteString 保留其字节；Integer 保留确切值；Null 与 Boolean 保留其 VM 类型。SDK 使用规范 VM 序列化器，绝不使用 JSON、显示顺序哈希或重建的动作操作数。该守卫直接比对字节，不定义新的摘要或哈希域。

缺失的意图会序列化为空 Array 并使比对失败。任何字段变化——动作摘要、操作数、成熟时间、授权 epoch——都会在取消之前让 `ASSERT` 失败。畸形的原生记录会在删除之前出错。匹配成功仍必须满足原生取消授权：活跃账户上的待生效意图需要托管见证，而超过 `expiresAt` 的意图无需见证即可被任何人丢弃。该守卫不授予额外权限。出错的交易不会提交应用层写入。

## 提交与兼容性

取消方案保留 `intentId` 与审阅过的记录，并新增 `reviewedIntentBytes` 与 `requiresExactScript: true`。准备、模拟、签名、导出与导入都必须完整保留 `plan.script`。钱包的"方法 + 参数"请求无法表达该比对，因此此类方案必须走精确脚本 SDK 路径；界面不得回退到无守卫的 `wallet.invoke` 请求。

`cancelConfiguration(accountId, intentId)` 仍对有意授权取消意图当前内容的应用程序开放。该守卫是受保护 SDK 交易的保证，不是对每个原生调用方强制的新不变量。原生方法、配置摘要、记录格式、身份、授权域与配置计数器语义都保持不变，较旧的客户端不会自动获得该守卫。

额外的读取、序列化、比对与内嵌字节会增加脚本大小与费用。既有的模拟与交易费用上限适用于完整脚本；客户端不得复用旧单次调用形式的估算。

## 内容身份与回归覆盖

这是对已经携带唯一 id 的记录的精确内容绑定。被取消的意图若以完全相同的动作重新提出，会从单调计数器得到新的 `intentId`，因此旧守卫不再匹配；同一区块内的相同重新提案无法重放它。

回归覆盖必须让实际的 SDK 脚本字节在原生引擎上执行：匹配的取消成功；意图被替换或缺失会出错；操作数或动作摘要变化会出错；已过期的意图无需见证即可清理；没有托管的待生效意图会出错。去掉比对的脚本可以说明为何仅靠原生两参数调用无法绑定内容。测试还覆盖规范 VM 类型的区分、替换期间账户记录不变、相同 id 边界，以及在交易签名过程中完整保留脚本。

# 待生效配置更新的读取

> 中文版本与 `docs/PENDING_CONFIG_UPDATE_READ_ABI.md` 同构。若两者冲突，以英文版本为准。

普通部署合约配置新增两个安全方法。它们是对既有待生效标志、成熟时间 getter 以及
update/confirm/cancel 方法的追加；不改变存储，也不改变授权。

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `getPendingVerifierUpdate` | `accountId: Hash160` | `Array` 或 `null` |
| `getPendingHookUpdate` | `accountId: Hash160` | `Array` 或 `null` |

两个方法都是 `safe: true`。非零且合法的账户 ID 在没有任何待生效记录时返回 `null`，
未注册的 ID 也是如此。空值、零值或格式错误的账户 ID 会 fault。这些公开读取不要求
owner witness。

存在结果时，返回值始终是显式的四元素数组：

1. `newModuleHash`：提议的 verifier 或 hook，20 字节的 VM ByteString。
   零表示移除。Neo RPC 以 VM 字节序暴露 Hash160 值；客户端在生成通常的展示形式
   哈希时会反转字节。
2. `verifierParams`：提议的 verifier 参数，以 ByteString 表示。缺失的
   verifier 参数值被归一化为空字节。hook 结果在该位置始终是空字节。
3. `initiatedAt`：整数 Unix 时间戳，单位毫秒。
4. `matureAt`：整数 Unix 时间戳，单位毫秒，等于 `initiatedAt`
   加上配置 timelock（当前为 86,400,000 毫秒）。

内部待生效存储对象不是公开返回布局。verifier 读取取它的 verifier 字段；hook 读取
取它的 hook 字段。取消或成功确认会清除相应记录，因此对应 getter 之后返回 `null`。

本 ABI 描述的是新编译的源码。未声明这些方法名的既有部署仍然只暴露旧的读取。
客户端必须检查 manifest 或处理 method-missing 响应；当目标或参数只来自本地表单或
交易草稿时，不得把它呈现为已由链上验证。`contracts/bin/v3` 下的构建产物是本地
验证输出，不是已部署升级的证据。

> 门禁按英文匹配的边界句原文：`This ABI describes newly compiled source. Existing deployments that do not advertise these method names continue to expose only the older reads.`

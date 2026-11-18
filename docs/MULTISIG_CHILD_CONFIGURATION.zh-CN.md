# 配置 MultiSig 子验证器

> 中文版本与 `docs/MULTISIG_CHILD_CONFIGURATION.md` 同构。若两者冲突，以英文版本为准。

每个普通验证器都要求已固定的 SA 核心以精确的按账户配置上下文来调用它。一个转发到子验证器的 MultiSig 根无法满足该检查。核心源码提供了有界的子初始化路径。`callVerifierChild(accountId, childVerifier, method, args)` 与该端口下文描述的 `getChildVerifierConfig(accountId)` 读取都不在已固定的部署工件中（`contracts/build` 下的核心清单两者都不导出），因此在集成方能够调用本文描述的路径之前，必须先重新构建部署（DS-CU-202 发现 F1）。

- 调用方必须满足账户的备份所有者见证。账户不能处于市场托管或活跃执行中。
- 当前根必须暴露一个安全的 `getChildVerifierConfig(accountId)` 读取，返回根的有序子列表与阈值；该读取不在已固定的部署工件中，属于源码要求，而不是 `contracts/build` 中部署的既有属性。MultiSig 从其既有的 `getConfig` 状态实现它；`getConfig` 本身不变。
- 目标必须是当前的直接子验证器，具备完整的 V3 生命周期 ABI，且 `authorizedCore()` 等于本核心。根也必须绑定到本核心。
- 只接受 `setPublicKey(Hash160, ByteArray)` 与 `setConfig(Hash160, Array, Integer)`，且 `args[0]` 必须等于 `accountId`。
- 首次调用会暂存既有的待生效验证器调用记录并返回 `false`。24 小时之后，完全相同的第二次调用才会调用子验证器。该记录绑定根、子验证器、方法、参数、有序拓扑与阈值；确认时会再次检查当前拓扑。当前输入发生变化会暂存一个新的 24 小时提案。同一个待生效槽位与 `callVerifier` 共享。
- 核心只为该子验证器授予配置上下文，直接调用它，并在返回时清除上下文。对子验证器的直接调用仍然不被授权。

例如：以空的验证器参数注册一个 MultiSig 根，通过既有的 `callVerifier` 时间锁配置其根的 `setConfig`，然后通过各自独立的 `callVerifierChild` 提案分别初始化某个 Web3Auth 子验证器的 `setPublicKey` 与某个 NeoNative 子验证器的 `setConfig`——该路径不在已固定的部署工件中，因此这一序列需要重新构建的部署。每个提案都使用包含账户 ID 的完整参数列表。既有的待生效读取函数会报告根模块、承诺哈希与可用时间。

该路径只初始化直接子验证器，不改变清理、权限 epoch 或常规根配置。安全读取函数是一项显式能力，不是对任意第三方根代码的独立信任证明。

## 子验证器执行隔离

MultiSig 只把真正的 Boolean `true` 计为子验证器的批准。Integer `1`，或来自清单具有误导性的合约的其他真值 VM 值，都不计入阈值。

`CallFlags.ReadOnly` 限制存储与调用，但不会让 VM 集合变为不可变。因此 MultiSig 会把原始参数序列化一次，并为每次子校验与执行后调用反序列化一份独立副本。执行后结果也按同样的快照加复制方式处理。子验证器无法通过共享的 Array、Struct、Map 或 Buffer 对象改变另一个子验证器签名的参数或记账输入。

参数与目标结果必须能被 Neo StdLib 序列化。Interop 与迭代器结果不受支持，会失败关闭；合约绝不会悄悄把不受支持的共享对象传给下一个子验证器。快照会带来序列化与逐子反序列化的开销；配置的子验证器上限为十个。阈值仍然是对已配置模块的阈值，而不是对彼此独立的人类所有者或独立密码学签名域的保证。

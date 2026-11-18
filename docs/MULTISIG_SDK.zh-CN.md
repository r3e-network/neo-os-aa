# MultiSig SDK 与前端会话

> 中文版本与 `docs/MULTISIG_SDK.md` 同构。若两者冲突，以英文版本为准。

JS SDK 中的 `createMultiSigClient` 与前端中的 `createMultiSigDraftSession` 共用同一份 `shared/multiSigCore.mjs`。它们构造 `MultiSigVerifier` 所期望的 `StdLib.Serialize(object[])` 证明。这是一套显式的会话 API；通用的协作者记录与名单计数永远不会被推断为验证器子项。

1. `fetchContext({ coreContractHash, accountIdHash })` 读取 RPC 网络 magic、账户绑定的根验证器、其授权核心，以及有序的 `getConfig` 结果。它把账户、核心、网络、根、子顺序与阈值固定进 `configDigest`。
2. `prepareOperation({ context, operation })` 固定通道 nonce、截止时间与核心计算的参数哈希。请把这份完全相同的操作上下文分享给每个子签名方。截止时间以毫秒计，由调用方显式选择。
3. `buildChildTypedData({ context, operation, childVerifierHash })` 为该子验证器创建 EVM 签名域，**而不是为 MultiSig 根创建**。`fetchChildPayload({ context, operation, childVerifierHash })` 读取 SessionKey / WebAuthn 风格适配器各自的 `getPayload`，返回那些确切的字节及其子 / 操作上下文；把密码学载荷绑定到子身份的那些适配器会拒绝在另一个子域中复用。这并不是不透明证明字节或原生见证子项的通用属性，后者可能使用空的证明字节，并从交易见证推导授权。
4. 收集显式的 `{ childVerifierHash, kind, operation, signatureHex }` 证明。EVM 证明还会携带 `typedData`、`signatureFullHex` 与可选的 `signerAddress`。不透明证明要使用针对该子验证器真实签名格式的适配器；仅有操作元数据不构成有效性证明。
5. `validateBundle` 重新读取网络、根 / 配置、nonce 与参数哈希，拒绝漂移，构造精确的有序槽位，并针对绑定的根模拟 `validateSignature`。它在模拟之后会再次读取配置。被拒绝或出错的验证器都会失败关闭。

```js
const { createMultiSigClient } = require('smart-account');
const multisig = createMultiSigClient({ rpcUrl });
const context = await multisig.fetchContext({ coreContractHash, accountIdHash });
const operation = await multisig.prepareOperation({
  context,
  operation: { targetContract, method: 'symbol', args: [], deadline: String(Date.now() + 600_000) },
});
// 按第 4 步的显式 `{ childVerifierHash, kind, operation, signatureHex }` 记录，
// 为每个子验证器各构造一份证明。SDK 不提供这些证明的收集器：只有调用方知道
// 哪些子项签名、以及使用何种真实签名格式，因此数组在这里组装，而不是被拉取。
const childProofs = [
  { childVerifierHash, kind: 'evm', operation, signatureHex, typedData, signatureFullHex },
];
const bundle = await multisig.validateBundle({ context, operation, childProofs });
// bundle.invocation 是常规交易路径所需的完整 executeUserOp 载荷。
// 请审阅 / 模拟这笔完整交易，包括其费用支付方与任何所需的代理见证。
```

`buildBundle` 是离线的结构化构造器；其结果带有 `chainValidated: false`。只有在读取状态下签名模拟成功时，`validateBundle` 才会把该字段置为 true。这两个值都不是交易终局性，也不是对 nonce / 配置的预留。完整的执行预览与常规链上授权仍然必需。对于需要交易见证的子验证器，可以把签名方见证传给 `createMultiSigClient` / `createMultiSigDraftSession`；最终交易必须携带相同的必需授权。

序列化器上限为 10 个槽位与 65,535 字节总量。缺失的子项使用其原始索引上的 null 槽位，且只有在提供了足以满足阈值的显式证明之后才允许。空十六进制是 ByteString，与 null 不同。重复 / 未知的子项、变更的操作字段、不足的证明、父域 EVM 签名以及被改动的配置固定值都会被拒绝。

公开 V3 的阈值统计的是验证器模块，而不是独立的密钥或人。不同模块可以共享凭据或控制方；一次成功的法定人数模拟并不能建立签名方之间的独立性。原生组合配置定义了自己的签名域规则，必须单独发现。

## 配置子验证器凭据

对于暴露 `callVerifierChild` API 的核心——它不在已固定的部署工件中（`contracts/build` 下的核心清单），因此目前仅为源码能力（DS-CU-202 发现 F1）——`buildChildConfiguration` 会为所有者控制、带时间锁的子配置路径创建一次调用。它只接受 `setPublicKey(accountId, publicKey)` 或 `setConfig(accountId, signers, threshold)`，且只针对直接配置的子验证器。首次调用会暂存确切意图并返回 false；请在 24 小时延迟之后提交完全相同的调用数据以使其生效。成功的 Void 子配置可能返回 null。根、子验证器、子顺序、阈值或参数发生变化，都会重新开始延迟。

`readPendingConfiguration({ context })` 读取共享的验证器待生效槽位（`moduleHash`、`callHash`、`initiatedAt`）。该槽位与根验证器配置共享；仅有一条待生效记录，并不证明它对应某个特定的子请求。在所有者确认之前，请将其与确切的目标调用以及权威核心状态进行比对。合约边界见[子验证器配置](MULTISIG_CHILD_CONFIGURATION.md)。较旧的已部署核心不会因为 SDK 更新而获得该 API。

## 证据与边界

`MultiSigSdkVectorTests.cs` 运行真实的 JS 序列化器，把其字节与 VM 的 `StdLib.Serialize` 比对，拒绝错位与重复的子证明，演练保留阈值的 null 槽位，并用两个独立配置的 SessionKey 子验证器执行一次真实的核心 UserOperation。子载荷按域隔离。这证明了该运行时与该子验证器组合下的序列化 / 聚合路径；它不建立公开部署或所有可能的验证器适配器。

SDK 单元测试覆盖链配置 / 顺序 / 阈值 / 网络 / nonce / 参数漂移、类型化数据子域、错误的固定值、重复子项与配置载荷作用域。前端测试校验 RPC Array 与 base64 ByteArray 的传输编码。本工作不引入任何新的通用“多签已完成”界面徽标。

# 原生 SmartAccount SDK（ABI 2）

> 中文版本与 `docs/NATIVE_SDK.md` 同构。若两者冲突，以英文版本为准。

`NativeSmartAccountClient` 面向共识层原生合约。`SmartAccountClient` 仍是独立的公开已部署合约 V3 客户端。改动其核心哈希，并不会把 V3 注册、EIP-712 签名、身份或交易格式转变为原生协议。

发现流程要求确切的 ABI 2 清单 / 配置摘要、原生 id / 哈希 / 名称、显式期望的网络 magic，以及可调用的 `getVersion() == 2`。节点必须激活 `HF_SmartAccountV1`。私有测试不建立公开激活。

初始化、备份与密钥丢失决策，请先阅读[账户用户指南](NATIVE_ACCOUNT_USER_GUIDE.md)。

## 类型化字节与权限

账户身份、资产地址、托管、恢复权限与费用支付方彼此独立。身份推导仍是版本 1。ABI 2 在其精确的十四字段账户记录的第 13 个索引处新增 authorityEpoch。签名域绑定授权版本 2、网络、服务、账户、authorityEpoch 与 configurationNonce。规范执行同样要求全部四个参数 `(accountId, opOrBatch, expectedAuthorityEpoch, expectedConfigurationNonce)`。这一交易级承诺在托管或配置变更之后保护原生仅见证授权。旧的两参数封装会被拒绝，不存在零计数器的默认值。恢复会推进这两个计数器并撤销已安装模块，同时保留身份 / 资产 / nonce 通道 / Frozen 状态。

Hash160 输入为显示顺序的十六进制；`nativeCodec.hashValue(hash)` 会将其转换为线序 ByteString。ByteString.value 始终是十六进制，绝不是隐式 base64。严格 UTF-8 请使用 `stringValue(text)`。大整数使用十进制字符串或 BigInt。精确的 Array / Struct 类型会被保留；Map、Buffer、循环 / 共享复合值以及违反配置约束的值都会被拒绝。读取使用规范的 `invokescript`，以避免会丢失 Struct 值的 RPC 转换。

## 注册与托管执行

为标准 Neo P-256 CHECKSIG 或规范 CHECKMULTISIG 账户提供钱包适配器 `{account, verificationScript, sign(signDataHex)}`。`sign` 使用 P-256/SHA-256 对提供的确切字节签名一次。单签名适配器返回 64 字节 IEEE P1363 r||s 十六进制；多签名适配器返回 `{publicKey, signature}` 记录。SDK 会校验每个提交的签名，并按脚本顺序组装所需的法定人数。不要添加消息前缀，也不要对已经哈希过的摘要再次哈希。SDK 不存储任何私钥。脚本限制与备份要求见[阈值恢复](NATIVE_ACCOUNT_THRESHOLD_RECOVERY.md)。

```js
const { NativeSmartAccountClient, nativeCodec: c } = require('smart-account');
const client = new NativeSmartAccountClient({rpcUrl, networkMagic});
await client.discover();
const registration = client.buildRegistration({
  custodyAddress: custodyWallet.account,
  salt: random32BytesHex,
  recoveryAddress: recoveryWallet.account,
});
const limits = {maxSystemFee:'1000000000', maxNetworkFee:'300000000', maxTotalFee:'1300000000'};
const tx = await client.prepareTransaction(registration, {
  feePayer: payerWallet, authoritySigners:[custodyWallet, recoveryWallet], ...limits,
});
const signed = await client.signTransaction(tx);
await client.preflightTransaction(signed);
await client.broadcastTransaction(signed);
```

注册要求托管与每个非零恢复权限方为同一笔交易提供见证。引入新的恢复权限方或提出替换托管，同样要求该接收方为提案提供见证。移除可选的恢复权限方使用零值，不需要接收方见证。已成熟的激活仍然无需许可。原生账户代理不能作为托管或恢复权限方；标准钱包、多签钱包与已部署合约权限方保留各自的协议见证路径。内置钱包适配器支持 CHECKSIG / CHECKMULTISIG；已部署合约权限方需要兼容的外部交易构造器。仅有签名方条目并不构成同意的证明。

当某个权限方相对于当前托管、恢复与待生效权限地址是首次引入时，会检查其同意。对已准入的待生效地址重新提案不需要新的接收方同意；但当前控制权限的检查仍然适用。

请等待已确认回执，并对照独立推导的身份校验 AccountCreated / getAccount。向 `registration.accountAddress`（资产本金地址）充值。持久保存盐值；恢复不会替换账户身份。提交返回 `{submitted:true,confirmed:false}`。`getTransactionReceipt(signed)` 校验持久化的原始字节并返回 Application 结果。未知 / 待处理的交易可能产生 RPC 错误；请以有界重试轮询同一个 txid，绝不要在超时之后悄悄签署替代交易。

```js
const state = await client.getAccount(registration.accountId);
const prepared = await client.prepareOperation({
  accountId:state.accountId, targetContract:gasTokenHash, method:'transfer',
  args:[c.hashValue(state.accountAddress), c.hashValue(recipientHash),
        {type:'Integer',value:'100000000'}, {type:'Null'}],
  channel:3n, deadline:deadlineMilliseconds,
});
// verifier=null：真实托管交易见证，操作签名为空。
const plan = client.buildExecution([prepared]);
const transferTx = await client.prepareTransaction(plan, {
  feePayer:payerWallet, authoritySigners:[custodyWallet], ...limits,
});
await client.broadcastTransaction(await client.signTransaction(transferTx));
```

外部支付方是 0 号签名方。除非它同时是显式要求的托管 / 恢复权限方，否则其作用域为 None。代理作用域是限于操作目标的 CustomContracts；其见证为空调用加规范验证脚本。托管 / 恢复作用域指向 SmartAccount。以代理作为支付方、冲突的钱包身份以及不受支持的钱包脚本都会被拒绝。同一钱包被显式选入多个权限角色时，只会编码一次，且仅带上这些推导出的作用域。托管、恢复与支付方都支持标准钱包多签。它们统计的是单个钱包见证内的公钥签名，与原生 MultiSigVerifier 的模块法定人数不同。

`client.exportSignedTransaction(signed)` 生成带版本号的公开工件，包含确切的已签名字节、交易字段、配置与见证。浏览器可以导入它，以复用同一份经审阅的方案，校验钱包签名与费用上限，执行完整的已签名预检，并显式发送这些字节。参见[已签名交易导入](NATIVE_SIGNED_TRANSACTION_IMPORT.md)。导入不会让工作台获得签名密钥。

对于 `cancelRecovery`，请把取消权限方与支付方分开。传入 `cancellationAuthority: custodyWallet.account` 或恢复钱包账户，并在 `authoritySigners` 中同时提供其钱包（若它同时付费，也可作为 `feePayer`）。即使由另一个权限方付费，显式选择仍决定原生合约的见证作用域。托管只能在成熟之前取消；恢复可以取消任何待生效的恢复。SDK 在请求签名之前会重新检查托管的链上时间窗口。未作显式选择时，保留既有的“恢复优先”选择。最终原生执行始终按实际区块状态与时间强制执行。

## 费用与最终预检

来自 RPC 的费用必须是规范的非负 Int64 十进制字符串；畸形值以及低于 `gasconsumed` 的 `minimumrequiredfee` 都会在签名之前被拒绝。缺少最小准入数据时，只允许使用显式的准备预算，且该预算仍必须覆盖实际消耗。最终已签名预检要求这两个字段都存在，并应用相同检查。`gasconsumed` 是实际消耗；有界回调可能需要更大的准入预算。自动 SystemFee 需要 `minimumrequiredfee`；较旧的节点在准备阶段需要显式的 SystemFee 预算。这不会绕过最终校验。费用上限是强制的。`calculatenetworkfee` 会考虑完整的见证形态，并在使用最终已签名见证时重复计算。

`preflightTransaction` 调用 `invoketransaction(base64RawTx)`，并要求哈希 / 网络匹配、快照身份一致、Verification 为 Succeed、Application 为 HALT、`relayed:false`、`mempoolChecked:false`，且最小准入费用不超过已签名的 SystemFee。它还要求 RPC 的 `simulation` 声明满足：`mode:'single-transaction-next-block'`、`height:snapshot.height+1`、规范的 UInt64 十进制字符串 `timestamp`、UInt8 `primaryIndex`、`view:0`、`transactionCount:1`、`onPersist:'HALT'`，以及规范的 UInt160 `nextConsensus`。这确认了原生费用处理已在一次性的单交易次区块上下文中先于 Application 运行。它不预测其他交易、实际的下一任 primary 或时间戳，也不预测内存池接受情况。广播会在完全相同的已签名字节上重复预检。不受支持的 RPC、缺少准备声明或任何不匹配都会拒绝广播；已签名的原始工件仍可导出。

这检查的是账本快照，而不是 nonce 预留或保证的内存池准入。同一 txid 与原始字节的并发提交共享同一个在途请求。预检失败可以在不重新签名的情况下重试。一旦尝试过 sendrawtransaction，其结果就会被保留；错误会携带 txid 与 submissionAttempted，因此超时应通过查询该 txid 来解决。不要在拒绝之后自动提高费用或重新签名。模拟转账返回 Boolean false 会被拒绝，即使 VM 返回 HALT。确认之后请校验实际的资产 / nonce / 策略变化。已提交的 FAULT 仍会向费用支付方收费；回滚与费用影响是两个不同的问题。

## 链上时间与迁移边界

截止时间与延迟使用链上毫秒，而不是客户端时钟。标准见证的 Verification 读取快照中持久化的区块时间；Application 读取执行区块时间。正好等于截止时间仍然有效，但下一个区块可能已经太晚。最终预检使用其声明的假设时间戳，因此在成功重放之后仍要检查持久化结果。配置 / 恢复的成熟是包含边界的；托管对恢复的取消权在成熟之前严格结束。

ABI 2 没有旧版导入端点、导入注册表或迁移事件。注册原生身份不会移动旧资产。旧的原始记录 / 模块与两参数执行封装都会被拒绝；身份推导版本 1 并不意味着存储或授权兼容。旧版迁移适配器或既有的原生状态转换，需要另行规范与验证之后才能使用。

## 模块配置与签名

`buildModuleCall({accountId,role,child?,method,args})` 只接受方法专属参数；核心会前置 accountId。它会检查部署的配置能力，并按方法名加参数个数解析 ABI，其中包含核心前置的账户 ID。不同元数的重载是有效的；重复匹配的签名、安全方法以及没有前置 Hash160 的方法都会被拒绝。无论配置还是见证签名，模块准入都要求带有数值 `abiVersion: 2`、确切的服务的配置摘要与 Boolean 组合标记的元数据。缺失、过旧或类型错误的版本都会被拒绝。核心会独立复核身份 / 代码哈希 / 权限 / 延迟 / epoch。

对于已声明的原生 v2 `MultiSigVerifier` 配置及其确切的 `setConfig(Hash160, Array, Integer)` 能力，SDK 在暂存之前还会检查已知的配置形态：1–3 个有序、唯一的子哈希，以及 1–2 的整数阈值且不超过名单大小。零值、自身与原生合约哈希都会被拒绝。这是内置 schema 的便利检查，而不是对任意第三方 `setConfig` 方法的推断。三域总量、互不相交的子签名域、代码固定值以及当前子策略仍由核心权威检查。初始暂存可能在子配置尚未就绪时成功；其模拟并不证明将来的配置可以被应用。成熟之后，请重建完整的确认步骤并再次模拟，然后再签名。

原生 SessionKeyVerifier 示例：

```js
const config = await client.buildModuleCall({
  accountId, role:'verifier', method:'setSessionKey',
  args:[{type:'ByteString',value:compressedP256PublicKeyHex}, c.hashValue(targetHash),
        c.stringValue('transfer'), {type:'Integer',value:sessionExpiryMilliseconds},
        {type:'Integer',value:spendLimitDatoshi}, c.stringValue('limited session')],
});
```

以托管身份提交，检查 `getPendingModuleCall`，等待链上完整的 24 小时成熟，然后重建并提交完全相同的调用。已签发的方案不可变，并绑定到当前账户快照。暂存返回 false 与已完成的回调结果为 false 是不同的：请通过待生效状态与 configurationNonce 区分。

用显式角色取消不想要的待生效策略调用：

```js
const cancellation = await client.buildAction({
  accountId, action:'cancelModuleCall', role:'verifier',
});
// 在你的应用中展示 cancellation.pending：所选模块、方法、类型化参数与成熟时间。
// 在准备或签名之前取得批准。
const cancellationTx = await client.prepareTransaction(cancellation, {
  feePayer:payerWallet, authoritySigners:[custodyWallet], ...limits,
});
await client.broadcastTransaction(await client.signTransaction(cancellationTx));
```

钩子策略调用请使用 `role:'hook'`。取消方案会保留角色、待生效调用快照及其规范 `pendingCallBytes`。其完整的已签名脚本会读取并序列化当前待生效记录，断言字节相等，然后在同一笔交易中调用 `cancelModuleCall(accountId, role)`。因此内容变动或缺失会在取消之前出错，包括在客户端最后一次校验之后发生的变化。请保留 `requiresExactScript: true`；钱包的“方法 + 参数”式调用会省略这一保护，工作台会拒绝它。原生入口本身保持不变，仍支持有意的槽位取消。这绑定的是内容，而不是唯一的提案实例：在同一区块内重建的、完全相同的记录仍可能匹配。参见[交易守卫规范](NATIVE_ACCOUNT_TRANSACTION_GUARDS.md)。取消移除的是提案，而不是活跃策略。变更之后请构建并审阅新的方案，并检查已确认的待生效状态。

Session 签名方使用 P-256/SHA-256 对 `prepared.preimage` 签名一次。`prepared.digest` 是其独立计算、与链一致的 SHA-256。用 `attachSignature(prepared, signatureHex)` 附加签名并执行 buildExecution。由验证器授权的操作可以使用独立支付方，而无需托管的交易签名。对于 NeoNativeVerifier，请显式把 `verifierSigners:[walletAdapter]` 传给 `prepareTransaction`。SDK 读取核心持有的验证器根与活跃叶子名单，重建完整的已部署 NEF 字节与 JCS 清单代码哈希，检查已存储的固定值，并读取每个原生见证叶子配置的签名方列表。CustomContracts 只包含匹配的叶子。支持带有直接原生见证子项的 MultiSigVerifier 根；递归或未登记的子项会被拒绝。仅仅支付费用不会授予验证器权限。支付方 / 托管与验证器角色可以有意共享同一把密钥，但只有显式选择才会加入该模块作用域。配置 / 名单 / 代码固定值会在签名前后以及广播之前重新检查。

对于原生 MultiSig，已配置的子顺序很重要：校验会选择提交证明通过的前 `threshold` 个子项。只有被选中的法定人数会收到执行后回调并消耗 Session 策略计数器。在 2-of-3 账户中提交三份有效证明，并不意味着消耗了三个子策略。调用方可以通过 Null 槽位有意省略某个子项，从而选择另一个允许的法定人数；对于 NeoNative 见证子项，空 ByteString 是一份“存在”的证明。审阅所选法定人数时，请使用模拟与已确认的策略状态回读。

移除一个活跃子项会清除其账户专属策略并将其从已登记名单中移除。之后重新加入该模块，需要通过完整的延迟子配置流程重新登记与配置，然后才能确认新的 MultiSig 名单。之前成功的子配置不会在移除后保留。

应用层提供签名适配器；通用签名记录并不证明模块批准。原生 MultiSig 适配器必须使用核心依赖顺序、当前配置与互不相交的签名域。不要把公开 V3 的 EIP-712 聚合复用于原生签名。

`getModuleDependencies` 读取权威的活跃 / 清理名单。依赖设置器是模块内部延续；SDK 不暴露任何需托管授权的辅助函数。

## Nonce 与恢复

`prepareOperations({accountId,operations})` 按输入顺序为每个通道分配序列；buildExecution 会输出规范批次。通道小于 2^191，序列小于 2^64，nonce / 截止时间小于 2^255。游标 2^64 表示已耗尽。三十二个操作是语法上限，并不保证它们能满足全局验证 Gas 上限。

`buildAction` 支持以下生命周期。每笔交易都需要费用支付方；表中列出的是除付费之外所需的账户权限。若支付方持有相应密钥，它也可以同时是所列权限方。

| 动作 | 所需账户权限 | 时序与状态 | 取消 |
| --- | --- | --- | --- |
| `proposeVerifier`、`proposeHook` | 托管 | Active；没有待生效托管恢复；开始 24 小时延迟 | 意图仍待生效时，托管使用对应的取消动作 |
| `activateVerifier`、`activateHook`、`activateRecoveryAddress` | 无；仅需支付方 | 成熟时或之后的当前待生效意图；Active；没有待生效托管恢复 | 托管可以取消仍待生效的意图（包括成熟之后），直到激活执行 |
| `buildModuleCall` 提案与应用 | 两次调用都需要托管 | Active；没有待生效托管恢复；24 小时之后重复完全相同的方法 / 参数 | 托管使用带有显式角色与经审阅待生效调用的 `cancelModuleCall` |
| `proposeRecoveryAddress` | 托管与新的非零恢复权限方 | Active；没有待生效托管恢复；开始 24 小时延迟 | 意图仍待生效时，托管使用对应的取消动作 |
| `proposeRecovery` | 已配置守护者与拟定的托管 | Active 或 Frozen；开始七天延迟 | 待生效期间由守护者取消；托管只能在成熟之前取消 |
| `executeRecovery` | 无；仅需支付方 | 成熟时或之后的当前待生效恢复 | 执行之后不再存在待生效恢复 |
| `freeze` | 已配置守护者 | Active；没有协议等待期 | 清除每一个待生效意图；使用 `unfreeze` 恢复 |
| `unfreeze` | 托管与已配置守护者 | Frozen；没有协议等待期 | 不存在待生效提案 |

例如：已成熟的激活只需要 `feePayer:payerWallet` 以及 `prepareTransaction` 中的费用上限；`authoritySigners` 可以省略。仅支付方参与的激活不会豁免待生效状态、成熟度、模块固定值或清理检查。模块策略应用是另一条流程，仍然需要托管。最终模拟会重新检查所选执行者与当前待生效状态。诸如 `executeRecovery(accountId)` 这类仅涉及账户的生命周期调用不会编码经审阅的待生效载荷。客户端重新校验能发现观察到的变化，但无法通过打包锁定待生效状态；请在执行后读取已确认状态。

冻结会推进配置计数器，并清除待生效恢复、验证器 / 钩子 / 地址变更以及模块策略调用。若既需要遏制又需要恢复，请先冻结并确认，然后再提出恢复。恢复会保留 Frozen 状态与已配置的守护者；解冻仍需要新的托管与该守护者。在 Frozen 期间丢失守护者密钥，本配置没有仅托管的豁免。在 Active 且没有待生效托管恢复时，托管可以提出需 24 小时的守护者替换。请使用受支持的 Neo 钱包权限方以及独立控制的守护者；当前 SDK 的传输支持仍是上文描述的标准 P-256 钱包接口。

恢复 / 配置通过 authorityEpoch / configurationNonce 使旧签名失效。SDK 会在签名与广播之前重新检查状态 / 域 / 摘要 / nonce。已准备的操作与方案由同一个客户端实例签发。导入的 JSON 必须从链上状态重建，而不是被提升为可信的签名请求。

## 浏览器与校验边界

`shared/nativeSmartAccount.mjs` 是纯 Uint8Array 编解码器，注入同步的十六进制哈希适配器。`shared/nativeSmartAccountClient.mjs` 提供同一套读取 / 动作 / 操作客户端，注入 RPC。前端镜像逐字节一致。Node 的 P-256 交易签名独立位于 `sdk/js/src/native/transaction.js`。

原生测试覆盖独立的 v2 字节向量、epoch / 计数器最大值、确切封装、严格类型、恶意 RPC 响应、2D nonce / 批次、费用上限、真实 P-256 交易签名与预检拒绝。`npm run test:package` 会在仓库之外安装真实的 tarball，并检查 CJS / ESM / 类型。真实已激活节点的执行是独立门禁；在声称其通过之前，请检查当前运行时回执。

RPC 执行证据会在交易签名之前检查一次，并在确切的已签名交易上再次检查。单操作必须返回恰好一个格式正确、可序列化的 VM 项。批次必须返回一个确切的 Array，每个操作对应一个结果。名为 `transfer` 的方法必须严格返回 Boolean `true`；缺失、截断、类型错误、false 或非 Boolean 的转账结果都不能授权提交。其他目标方法保留其原生返回语义，包括 Boolean `false` 与 Null。生命周期调用合法地返回空栈是允许的，但缺失或畸形的栈会被拒绝。出错的模拟仍可用于诊断，且绝不会自动给出费用批准。

默认 RPC 传输会保留 JSON-RPC 错误的数值 `code` 与结构化 `data`。已签名预检错误还会保留原始 `cause`；广播会附加不可变的 `txid` 与 `submissionAttempted`。预检失败可以在节点恢复后用相同的已签名字节重试。一旦尝试过提交，请检查该交易的回执来解决不确定性，而不是悄悄签署或发送另一笔交易。

可复现的私有集成入口是 `sdk/js/tests/native-runtime-verifiers.py`。请提供 `--runtime`、`--build-receipt`、`--artifacts`、`--module-receipt`、`--dotnet` 与 `--output`。它会校验两份构建回执，创建隔离的环回链，并使用真实 SDK 覆盖 NeoNativeVerifier、SessionKeyVerifier、双 Session 的 2-of-2 以及有序 Session/Native 的 2-of-3 组合。矩阵包含每一种双子法定人数、提交三份证明但只选中前两个、最大序列化操作参数以及最大 nonce 通道。其回执包含已签名预检、确切的持久化原始字节、带作用域的签名方 / 代码固定值证据、独立的余额 / nonce / 支出回读，以及配置变更后拒绝保留的已签名交易。密钥只通过 stdin 进入 Node 桥；临时钱包文件使用 0600 模式。PASS 只适用于该回执中固定的源码 / 运行时 / 工件。

添加 `--signed-artifact-transport` 可通过 SDK 导出以及与浏览器相同的可移植工件校验器运行该矩阵。此模式下每笔提交的交易还会经过公开钱包签名校验、全新的精确已签名预检与确切的原始回执检查。该模式还增加一次受保护的待生效策略取消，并独立校验待生效记录被移除，而账户记录与活跃策略保持不变。

协议要求与剩余的激活门禁，映射在[issue 242 一致性评审](proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md) 中。

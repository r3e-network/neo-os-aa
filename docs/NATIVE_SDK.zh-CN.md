# 原生 SmartAccount SDK（v4）

> 中文版本与 `docs/NATIVE_SDK.md` 同构。若两者冲突，以英文版本为准。

`NativeSmartAccountClient` 面向共识层原生内核；`SmartAccountClient` 面向自定义部署的内核。两者都说 v4 协议：一个十三字段操作、一套身份推导、一套模块 / 意图模型，以及同一份 `SA_*` 错误词表。自定义内核账户不会因为改动 core hash 就变成原生账户：两个内核的差别在交付方式——代理脚本、调用标志、原生合约的负 id——而不在它们接受的操作。

`shared/nativeSmartAccountClient.mjs` 是实现；`sdk/js/src/native.js` 把它绑定到原生合约哈希与 Node 交易工具上。前端镜像逐字节一致。

## 发现与激活

`discover()` 是 ABI 门禁，而且它读取链上状态，而不是某个固定参数摘要：

1. `getversion` 必须报告期望的网络 magic，`getcontractstate` 必须报告期望的哈希、原生合约 id 的正负号，以及清单名 `SmartAccount`。
2. `NATIVE_REQUIRED_ABI` 的每个条目都必须恰好存在一次，且参数类型、返回类型与 `safe` 标志与固定值一致；`NATIVE_REQUIRED_EVENTS` 的每个事件都必须存在。
3. `getProtocolInfo()` 必须回答协议版本 `4`。
4. `getAccountImplementationId()` 必须回答本客户端评审所依据的实现 id（原生内核为 `NativeSmartAccount/v4`）。

它返回一个冻结的配置 `{contract, networkMagic, protocolVersion, implementationId}`。只有节点激活 `HF_SmartAccountV1` 之后，原生内核才可调用；私有测试不建立公开激活。

```js
const { NativeSmartAccountClient, nativeCodec: c } = require('smart-account');

const client = new NativeSmartAccountClient({ rpcUrl, networkMagic });
const profile = await client.discover();
```

## 类型化字节与身份

Hash160 输入为显示顺序的十六进制；`nativeCodec.hashValue(hash)` 会将其转换为线序 ByteString。ByteString 值始终是十六进制，绝不是隐式 base64；UTF-8 请使用 `c.stringValue(text)`。大整数使用十进制字符串或 BigInt。精确的 Array / Struct 类型会被保留；Map、Buffer、循环值与违反配置约束的值都会被拒绝。读取使用 `invokescript`，因此 Struct 值能完整穿过 RPC。

身份是推导出来的，不是注册出来的：`accountId = hash160('aa524704' || custody || salt)`，盐值长度为 1..128 字节。代理地址由账户 id、内核哈希与内核的调用标志决定，因此 `(custody, salt)` 在任一内核上都能重新推导出同一个账户。

```js
const identity = client.deriveIdentity({ custodyAddress: custodyWallet.account, salt });
```

## 创建

`createAccount(Hash160 accountId, Hash160 custody, ByteArray salt, Integer recoveryTimelockMs, Array actions)` 一次性承诺身份。托管地址必须见证该交易；核心会从 `(custody, salt)` 重新推导 id，不匹配即报错。时间锁为 `0` 时选择 7 天最小值；可接受范围是 7..90 天（毫秒）。

`actions` 数组是 24 小时意图延迟的原子例外：核心在创建过程中执行它，因此账户可以带着第一个验证器启动。只要应用了任何动作，账户结束时就必须至少有一个验证器模块，除非默认操作授权处于开启状态。

```js
const create = {
  custodyAddress: custodyWallet.account,
  salt: randomBytesHex,
  recoveryTimelockMs: 30 * 86_400_000,
};
const plan = client.buildCreateAccountScript(create);
const limits = {maxSystemFee:'1000000000', maxNetworkFee:'300000000', maxTotalFee:'1300000000'};
const tx = await client.prepareTransaction(plan, {
  feePayer: payerWallet,
  recipe: { method: 'buildCreateAccountScript', input: create },
  ...limits,
});
const signed = await client.signTransaction(tx);
await client.preflightTransaction(signed);
await client.broadcastTransaction(signed);
```

`prepareTransaction` 按评审时使用的 `recipe` 重建脚本，并拒绝重建字节对不上的脚本，因此归档的评审始终可复核。它把费用支付方解析为 `None` 作用域，把每个 `authorizers` 条目限定到确切的 core hash。账户代理不能作为费用支付方，也不能同时被列为授权方。费用上限是强制的。同一钱包被显式选入多个角色时，只会编码一次并仅带上推导出的作用域；标准钱包多签统计的是单个钱包见证内的公钥，与作用在模块上的阈值策略不同。

请等待已确认回执，并对照独立推导的身份读取 `getAccount`。持久保存盐值：恢复不会替换身份。提交返回 `{submitted:true,confirmed:false}`；`getTransactionReceipt(signed)` 校验持久化的原始字节并返回 Application 结果。未知或待处理的交易可能产生 RPC 错误——请以有界重试轮询同一个 txid，绝不要在超时之后悄悄签署替代交易。

## 账户状态

`getAccount(accountId)` 对不存在的账户返回 `null`，否则返回控制记录：存在性、状态（`Active` / `Frozen` / `MigrationRequired`）、托管、恢复权限方、授权 epoch、配置 nonce、恢复时间锁、默认操作与消息授权、仅所有者恢复、钩子顺序修订、控制修订、带成熟时间的待生效恢复、市场托管标记与遗留行标记。描述符会拒绝高于配置 nonce 的授权 epoch，也会拒绝把代理、核心或（在零值不被允许时）零值当作托管或恢复身份。

## 执行

`buildExecutionScript({accountId, operations})` 对单个操作发出 `executeUserOp(accountId, op)`，对批次发出 `executeUserOps(accountId, ops)`。操作是十三字段的 v4 数组：版本、目标、方法、参数、nonce、nonce 子键、截止时间、验证器 id、凭据代次、授权 epoch、配置 nonce、签名与钩子证明。

`deriveNonceRouting(accountId, routing)` 与 `getNonce(accountId, lookup)` 读取操作必须携带的路由；`getNonceSequence` 读取通道游标。`getOperationDigest` 与 `validateUserOp` 在签名之前读取摘要与核心的判定。核心没有消息入口：消息签名由签名模块按账户的默认消息授权校验，主体记录归该合约所有。

`getNonce` 接收 `{validatorId, nonceSubkey}`，并可选地成对接收 `{credentialGeneration, authorityEpoch}`。成对提供时该读取成为交叉校验：核心返回的通道必须与客户端推导的一致，否则在签名之前就失败；两者都不提供时只采信合约返回的通道，因为代次由核心自行解析（见《凭据代次》）。`resolveCredentialGeneration` 给出已安装验证器的该值；内置通道的代次不由 ABI 发布，它会如实报告不可解析，而不是猜一个。

```js
const plan = client.buildExecutionScript({ accountId: state.accountId, operations: [operation] });
```

代理见证由 SDK 合成：其作用域是限于操作目标的 `CustomContracts`，见证是空调用加规范验证脚本。托管与恢复见证由核心内部的 `Runtime.CheckWitness` 识别，因此被限定到确切的 core hash。仅支付方支付永远不授予账户权限。

`validateNativeInvocationResult` 在签名之前检查执行证据，并在确切的已签名交易上再次检查。单个操作必须返回恰好一个格式正确、可序列化的 VM 项；批次必须返回一个确切的 Array，每个操作对应一个结果。名为 `transfer` 的方法必须严格返回 Boolean `true`；缺失、截断、类型错误、false 或非 Boolean 的转账结果都不能授权提交。其他目标方法保留其原生返回语义，包括 Boolean `false` 与 Null。生命周期调用合法地返回空栈是允许的，但缺失或畸形的栈会被拒绝。出错的模拟仍可用于诊断，且绝不会自动给出费用批准。

## 凭据代次

有三种不同的代次会进入 §4.3 的签名域和 §6 的通道，三者绝不可互换：

| 路由 | 核心绑定的代次 | 存放位置 |
| --- | --- | --- |
| 内置验证器（`validatorId` 为 0） | 账户的 `SubjectRevision` | 0x57 subject 记录 |
| 已安装验证器 | 该实例的 `CredentialGeneration` | 0x52 实例记录，由 `getModule` 发布 |
| 生效中的阈值策略 | 策略的 `CredentialGeneration` | 0x5B 策略记录 |

核心在每个操作和每次 `getNonce` 读取时自行解析代次，因此被链接受的操作用的永远是核心推导出的通道，而不是客户端的猜测。携带账户已离开代次的操作会以 `SA_CREDENTIAL_STALE` 失败；被重塑的阈值策略同样会让其上一代的通道失效。

客户端栈里没有任何默认值。离线构建器没有 RPC，`getAccount` 也不携带该修订号，因此 `UserOperationBuilder` 在缺少显式 `credentialGeneration` 时拒绝构建（`SDK_011`），前端操作工厂则抛出 `EC_credential_generation_required`；两者都不会给内置通道填 1、给其他情况填 2。经过评审的 fixture 可以显式写明代次，那是对该 fixture 的声明，而不是默认值。摘要和通道都绑定了这个值，所以代次过期不会静默滑到下一个通道：它是一次拒绝。

## 模块

注册时可以原子地附带安装：核心在注册时最多执行 16 个动作，而它现在仍会执行的只有 `installModule` 与 `uninstallModule`。此后的一切都走两个公开方法。

`installModule(accountId, moduleType, moduleContractHash, initData)` 与 `removeModule(accountId, moduleId, deInitData)` 取 v4 的安装码——验证器（1）或钩子（4）——不带配置摘要，因为核心读取模块自己的配置；注册动作会带一个，并由共享核心比对。两个调用都接受托管见证或某个已安装验证器实例的见证（用户态治理模块用它管理自身的那种形态），并且都会推进配置 nonce。

```js
const install = client.buildAccountActionScript({
  method: 'installModule',
  accountId: state.accountId,
  args: [moduleTypeCode, moduleContractHash, initData],
});
```

核心不保留任何配置意图：需要成熟 24 小时然后被确认或取消的变更属于治理模块，由它通过这两个方法提交成熟后的调用。期待存在提案窗口的客户端，面向的是另一个合约。`getAccount` 仍会发布 `configurationNonce` 与 `hookOrderRevision`，让读者可以排序变更，同时它在描述符里保留了恢复字段以维持 ABI 稳定，报告其未激活值。

`getModules(accountId, 'validator'|'hook', {cursor, limit})` 分页读取已安装实例；`getModule(accountId, moduleId)` 读取一个描述符（类型、合约哈希与 id、更新计数、NEF 与配置摘要、模块修订、凭据代次、实例隔离、消息能力、阈值资格）。`isModuleInstalled` 在不分页的情况下回答准入问题，`getAuthorizedModuleId` 报告核心为某个阶段路由到的实例。模块只能读取自己持有的状态——生命周期回调属于核心。

钩子顺序由已安装的钩子实例与描述符发布的 `hookOrderRevision` 推导；调用它们的编排器是一个模块，因此核心无顺序可读，也无顺序可改。凭据代次通过移除并重新安装实例推进，也就是由托管授权的 `removeModule`/`installModule` 组合——核心上没有单独的吊销入口。

## 账户动作

`freezeAccount(accountId)` 与 `unfreezeAccount(accountId)` 是核心拥有的两个即时转换，都由 `buildAccountActionScript` 构建，且都只允许托管。冻结会推进授权 epoch，因此此前产生的每个签名都不再通过校验；账户未冻结时解冻会被拒绝。账户等待迁移期间，两者都会被拒绝。

恢复是一个模块。`beginRecovery`、`cancelRecovery`、`executeRecovery` 与 `getRecoveryStatus` 都是恢复模块自己的方法：交接延迟及其成熟都在该模块的存储里，因此核心既不规划也不校验它们，SDK 也不会从核心方案推导恢复权限集合。需要恢复的客户端面向的是恢复模块的脚本哈希。

冻结推进配置 nonce 并清除核心的恢复字段。两个转换都通过授权 epoch 让旧签名失效，SDK 会在签名之前与广播之前重新读取状态、摘要与 nonce。

## 费用与最终预检

来自 RPC 的费用必须是规范的非负 Int64 十进制字符串；畸形值以及低于 `gasconsumed` 的 `minimumrequiredfee` 都会在签名之前被拒绝。最终已签名预检要求这两个字段都存在，并应用相同检查。`calculatenetworkfee` 会考虑完整的见证形态，并在最终已签名见证上重复计算。

`preflightTransaction` 调用 `invoketransaction(base64RawTx)`，并要求哈希与网络匹配、快照身份一致、Verification 为 Succeed、Application 为 HALT、`relayed:false`、`mempoolChecked:false`，且最小准入费用不超过已签名的 SystemFee。它还要求 RPC 的 `simulation` 声明满足：`mode:'single-transaction-next-block'`、`height:snapshot.height+1`、规范的 UInt64 十进制字符串 `timestamp`、UInt8 `primaryIndex`、`view:0`、`transactionCount:1`、`onPersist:'HALT'`，以及规范的 UInt160 `nextConsensus`。这确认了原生费用处理已在一次性的单交易次区块上下文中先于 Application 运行；它不预测其他交易、下一任 primary 或时间戳，也不预测内存池接受情况。广播会在完全相同的已签名字节上重复预检。

已提交的 FAULT 仍会向费用支付方收费。一旦尝试过 `sendrawtransaction`，其结果就会被保留；错误会携带 txid 与 `submissionAttempted`，因此超时应通过查询该 txid 来解决。不要在拒绝之后自行提高费用或重新签名。

## 链上时间

截止时间与延迟使用链上毫秒，而不是客户端时钟。标准见证的 Verification 读取快照中持久化的区块时间；Application 读取执行区块时间。正好等于截止时间仍然有效，但下一个区块可能已经太晚。最终预检使用其声明的假设时间戳，因此在成功重放之后仍要检查持久化结果。配置与恢复的成熟是包含边界的。

## 工件与浏览器边界

`client.exportSignedTransaction(signed)` 生成带版本号的公开工件，包含确切的已签名字节、交易字段、配置与见证。浏览器可以导入它，以复用同一份经评审的方案，校验钱包签名与费用上限，执行完整的已签名预检，并显式发送这些字节。导入不会让工作台获得签名密钥。

默认 RPC 传输会保留 JSON-RPC 错误的数值 `code` 与结构化 `data`；已签名预检错误会保留原始 `cause`，广播会附加不可变的 `txid`。

## 证据与边界

原生测试覆盖 v4 字节向量、epoch 与计数器最大值、确切封装、严格类型、恶意 RPC 响应、nonce 路由与批次、费用上限、真实 P-256 交易签名与预检拒绝。`npm run test:package` 会在仓库之外安装真实的 tarball，并检查 CJS / ESM / 类型。

可复现的 v4 runbook 是 `sdk/js/tests/testnet-v4-harness.js` 以及同目录下的操作脚本。它会加载 `contracts/bin/public`（含 `validators/` 与 `hooks/`），部署核心与其安装的模块，并通过 SDK 驱动 13 字段操作、`proposeConfiguration` / `confirmConfiguration` 意图计划、阈值策略与恢复。这些脚本是 runbook 而非门禁：`npm test` 不运行它们，迁移阶段也不运行它们。`native-runtime-verifiers.py` 与 `native-runtime-driver.mjs` 是已退役的 v3 证据，运行时会以非零退出而 不会半途驱动一条链。PASS 只适用于该回执中固定的源码、运行时与工件。真实已激活节点的公网执行是独立门禁；在声称其通过之前，请检查当前运行时回执。

协议要求与剩余的激活门禁，映射在[issue 242 一致性评审](proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md) 中。

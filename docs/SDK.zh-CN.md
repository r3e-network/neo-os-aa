# SmartAccount SDK 参考

> 中文版本与 `docs/SDK.md` 同构。若两者冲突，以英文版本为准。

本书是面向开发者的 SDK 参考，合并了原先的 NATIVE_SDK、MULTISIG_SDK、SA-EIP-712-SPEC、
SA-PROXY-TRANSFERS 与 PENDING_CONFIG_UPDATE_READ_ABI 五个主题；其内容按章节原样移入本书。

`NativeSmartAccountClient` 面向共识层原生内核；`SmartAccountClient` 面向自定义部署的内核。两者都说 v4 协议：一个十三字段操作、一套身份推导、一套模块 / 意图模型，以及同一份 `SA_*` 错误词表。自定义内核账户不会因为改动 core hash 就变成原生账户：两个内核的差别在交付方式——代理脚本、调用标志、原生合约的负 id——而不在它们接受的操作。

`shared/nativeSmartAccountClient.mjs` 是实现；`sdk/js/src/native.js` 把它绑定到原生合约哈希与 Node 交易工具上。前端镜像逐字节一致。

## 目录

1. [SDK 使用](#sdk-使用) —— 发现、身份、创建、状态、执行、代次、模块、动作、费用
2. [阈值会话](#阈值会话) —— 阈值策略 SDK、前端会话与旧版 V3 子配置
3. [EIP-712 签名](#eip-712-签名) —— V3 验证器在链上哈希的类型化数据布局
4. [代理转账](#代理转账) —— 直接代理见证的构造、费用策略、拒绝赞助
5. [待处理配置更新读取](#待处理配置更新读取) —— 配置更新的读取面

## SDK 使用

### 发现与激活

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

### 类型化字节与身份

Hash160 输入为显示顺序的十六进制；`nativeCodec.hashValue(hash)` 会将其转换为线序 ByteString。ByteString 值始终是十六进制，绝不是隐式 base64；UTF-8 请使用 `c.stringValue(text)`。大整数使用十进制字符串或 BigInt。精确的 Array / Struct 类型会被保留；Map、Buffer、循环值与违反配置约束的值都会被拒绝。读取使用 `invokescript`，因此 Struct 值能完整穿过 RPC。

身份是推导出来的，不是注册出来的：`accountId = hash160('aa524704' || custody || salt)`，盐值长度为 1..128 字节。代理地址由账户 id、内核哈希与内核的调用标志决定，因此 `(custody, salt)` 在任一内核上都能重新推导出同一个账户。

```js
const identity = client.deriveIdentity({ custodyAddress: custodyWallet.account, salt });
```

### 创建

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

### 账户状态

`getAccount(accountId)` 对不存在的账户返回 `null`，否则返回控制记录：存在性、状态（`Active` / `Frozen` / `MigrationRequired`）、托管、恢复权限方、授权 epoch、配置 nonce、恢复时间锁、默认操作与消息授权、仅所有者恢复、钩子顺序修订、控制修订、带成熟时间的待生效恢复、市场托管标记与遗留行标记。描述符会拒绝高于配置 nonce 的授权 epoch，也会拒绝把代理、核心或（在零值不被允许时）零值当作托管或恢复身份。

### 执行

`buildExecutionScript({accountId, operations})` 对单个操作发出 `executeUserOp(accountId, op)`，对批次发出 `executeUserOps(accountId, ops)`。操作是十三字段的 v4 数组：版本、目标、方法、参数、nonce、nonce 子键、截止时间、验证器 id、凭据代次、授权 epoch、配置 nonce、签名与钩子证明。

`deriveNonceRouting(accountId, routing)` 与 `getNonce(accountId, lookup)` 读取操作必须携带的路由；`getNonceSequence` 读取通道游标。`getOperationDigest` 与 `validateUserOp` 在签名之前读取摘要与核心的判定。核心没有消息入口：消息签名由签名模块按账户的默认消息授权校验，主体记录归该合约所有。

`getNonce` 接收 `{validatorId, nonceSubkey}`，并可选地成对接收 `{credentialGeneration, authorityEpoch}`。成对提供时该读取成为交叉校验：核心返回的通道必须与客户端推导的一致，否则在签名之前就失败；两者都不提供时只采信合约返回的通道，因为代次由核心自行解析（见《凭据代次》）。`resolveCredentialGeneration` 给出已安装验证器的该值；内置通道的代次不由 ABI 发布，它会如实报告不可解析，而不是猜一个。

```js
const plan = client.buildExecutionScript({ accountId: state.accountId, operations: [operation] });
```

代理见证由 SDK 合成：其作用域是限于操作目标的 `CustomContracts`，见证是空调用加规范验证脚本。托管与恢复见证由核心内部的 `Runtime.CheckWitness` 识别，因此被限定到确切的 core hash。仅支付方支付永远不授予账户权限。

`validateNativeInvocationResult` 在签名之前检查执行证据，并在确切的已签名交易上再次检查。单个操作必须返回恰好一个格式正确、可序列化的 VM 项；批次必须返回一个确切的 Array，每个操作对应一个结果。名为 `transfer` 的方法必须严格返回 Boolean `true`；缺失、截断、类型错误、false 或非 Boolean 的转账结果都不能授权提交。其他目标方法保留其原生返回语义，包括 Boolean `false` 与 Null。生命周期调用合法地返回空栈是允许的，但缺失或畸形的栈会被拒绝。出错的模拟仍可用于诊断，且绝不会自动给出费用批准。

### 凭据代次

有三种不同的代次会进入 §4.3 的签名域和 §6 的通道，三者绝不可互换：

| 路由 | 核心绑定的代次 | 存放位置 |
| --- | --- | --- |
| 内置验证器（`validatorId` 为 0） | 账户的 `SubjectRevision` | 0x57 subject 记录 |
| 已安装验证器 | 该实例的 `CredentialGeneration` | 0x52 实例记录，由 `getModule` 发布 |
| 生效中的阈值策略 | 策略的 `CredentialGeneration` | 0x5B 策略记录 |

核心在每个操作和每次 `getNonce` 读取时自行解析代次，因此被链接受的操作用的永远是核心推导出的通道，而不是客户端的猜测。携带账户已离开代次的操作会以 `SA_CREDENTIAL_STALE` 失败；被重塑的阈值策略同样会让其上一代的通道失效。

客户端栈里没有任何默认值。离线构建器没有 RPC，`getAccount` 也不携带该修订号，因此 `UserOperationBuilder` 在缺少显式 `credentialGeneration` 时拒绝构建（`SDK_011`），前端操作工厂则抛出 `EC_credential_generation_required`；两者都不会给内置通道填 1、给其他情况填 2。经过评审的 fixture 可以显式写明代次，那是对该 fixture 的声明，而不是默认值。摘要和通道都绑定了这个值，所以代次过期不会静默滑到下一个通道：它是一次拒绝。

### 模块

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

### 账户动作

`freezeAccount(accountId)` 与 `unfreezeAccount(accountId)` 是核心拥有的两个即时转换，都由 `buildAccountActionScript` 构建，且都只允许托管。冻结会推进授权 epoch，因此此前产生的每个签名都不再通过校验；账户未冻结时解冻会被拒绝。账户等待迁移期间，两者都会被拒绝。

恢复是一个模块。`beginRecovery`、`cancelRecovery`、`executeRecovery` 与 `getRecoveryStatus` 都是恢复模块自己的方法：交接延迟及其成熟都在该模块的存储里，因此核心既不规划也不校验它们，SDK 也不会从核心方案推导恢复权限集合。需要恢复的客户端面向的是恢复模块的脚本哈希。

冻结推进配置 nonce 并清除核心的恢复字段。两个转换都通过授权 epoch 让旧签名失效，SDK 会在签名之前与广播之前重新读取状态、摘要与 nonce。

### 费用与最终预检

来自 RPC 的费用必须是规范的非负 Int64 十进制字符串；畸形值以及低于 `gasconsumed` 的 `minimumrequiredfee` 都会在签名之前被拒绝。最终已签名预检要求这两个字段都存在，并应用相同检查。`calculatenetworkfee` 会考虑完整的见证形态，并在最终已签名见证上重复计算。

`preflightTransaction` 调用 `invoketransaction(base64RawTx)`，并要求哈希与网络匹配、快照身份一致、Verification 为 Succeed、Application 为 HALT、`relayed:false`、`mempoolChecked:false`，且最小准入费用不超过已签名的 SystemFee。它还要求 RPC 的 `simulation` 声明满足：`mode:'single-transaction-next-block'`、`height:snapshot.height+1`、规范的 UInt64 十进制字符串 `timestamp`、UInt8 `primaryIndex`、`view:0`、`transactionCount:1`、`onPersist:'HALT'`，以及规范的 UInt160 `nextConsensus`。这确认了原生费用处理已在一次性的单交易次区块上下文中先于 Application 运行；它不预测其他交易、下一任 primary 或时间戳，也不预测内存池接受情况。广播会在完全相同的已签名字节上重复预检。

已提交的 FAULT 仍会向费用支付方收费。一旦尝试过 `sendrawtransaction`，其结果就会被保留；错误会携带 txid 与 `submissionAttempted`，因此超时应通过查询该 txid 来解决。不要在拒绝之后自行提高费用或重新签名。

### 链上时间

截止时间与延迟使用链上毫秒，而不是客户端时钟。标准见证的 Verification 读取快照中持久化的区块时间；Application 读取执行区块时间。正好等于截止时间仍然有效，但下一个区块可能已经太晚。最终预检使用其声明的假设时间戳，因此在成功重放之后仍要检查持久化结果。配置与恢复的成熟是包含边界的。

### 工件与浏览器边界

`client.exportSignedTransaction(signed)` 生成带版本号的公开工件，包含确切的已签名字节、交易字段、配置与见证。浏览器可以导入它，以复用同一份经评审的方案，校验钱包签名与费用上限，执行完整的已签名预检，并显式发送这些字节。导入不会让工作台获得签名密钥。

默认 RPC 传输会保留 JSON-RPC 错误的数值 `code` 与结构化 `data`；已签名预检错误会保留原始 `cause`，广播会附加不可变的 `txid`。

### 证据与边界

原生测试覆盖 v4 字节向量、epoch 与计数器最大值、确切封装、严格类型、恶意 RPC 响应、nonce 路由与批次、费用上限、真实 P-256 交易签名与预检拒绝。`npm run test:package` 会在仓库之外安装真实的 tarball，并检查 CJS / ESM / 类型。

可复现的 v4 runbook 是 `sdk/js/tests/testnet-v4-harness.js` 以及同目录下的操作脚本。它会加载 `contracts/bin/public`（含 `validators/` 与 `hooks/`），部署核心与其安装的模块，并通过 SDK 驱动 13 字段操作、`proposeConfiguration` / `confirmConfiguration` 意图计划、阈值策略与恢复。这些脚本是 runbook 而非门禁：`npm test` 不运行它们，迁移阶段也不运行它们。`native-runtime-verifiers.py` 与 `native-runtime-driver.mjs` 是已退役的 v3 证据，运行时会以非零退出而 不会半途驱动一条链。PASS 只适用于该回执中固定的源码、运行时与工件。真实已激活节点的公网执行是独立门禁；在声称其通过之前，请检查当前运行时回执。

协议要求与剩余的激活门禁，映射在[issue 242 一致性评审](proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md) 中。

## 阈值会话

v4 没有 MultiSig 根，也没有验证器子项。阈值是安装在账户上的验证器模块之上的一层策略：成员就是同一个账户的模块 id，每个成员各自持有自己的凭证代数，而操作只携带一个装配好的签名字段。`shared/multiSigCore.mjs` 是唯一实现；JS SDK（`createThresholdClient`）与前端（`createThresholdSession`）只是把它绑定到某个客户端与某个 RPC。

1. 成员来自核心。`prepareMembers` 读取每个成员的模块描述符——是否已安装、`thresholdMemberEligible`，以及当前的 `credentialGeneration`——并返回每个成员必须签名的 §5 成员摘要。调用方自报的代数从不被信任：过期的代数会产出一个被核心以 `SA_CREDENTIAL_STALE` 拒绝的摘要。
2. 装配是显式的。`assembleSignature({ members })` 序列化 `[moduleId, 64 字节签名]` 对，`assembleOperationSignature({ operationDigest, members })` 返回 `{ signatureHex, members }`，其中 `signatureHex` 就是 13 字段操作的字段 11。
3. 策略本身就是配置。成员与阈值由配置意图中的 `setThresholdPolicy` 动作设定——`[7, policyId, threshold, memberIds[], active]`——因此生效前有 24 小时成熟期。`policyId = 0` 从与模块实例相同的单调分配器取一个新 id，所以策略 id 永远不会与模块 id 冲突。停用策略不携带成员，并释放这些成员以便卸载。

```js
const { createThresholdClient } = require('smart-account');

const threshold = createThresholdClient({ client });
const prepared = await threshold.prepareMembers({
  accountId,
  operationDigest,
  memberIds: [1, 2, 3],
});
// 每个成员用自己的验证器密钥签名 prepared[i].digest。
const signatureHex = threshold.assembleSignature({
  members: [{ moduleId: 1, signature }, { moduleId: 2, signature }],
});
```

前端会话（`frontend/src/features/operations/multiSig.js`）只通过调用方指定的那一个核心读取，因此一个会话不可能混用两个网络的值：

```js
import { createThresholdSession } from './features/operations/multiSig.js';

const session = createThresholdSession({ rpcUrl });
const prepared = await session.prepareMembers({
  networkMagic,
  coreContractHash,
  accountId,
  operation,
  memberModuleIds: [1, 2],
});
// `preview` 重新读取核心的校验结果；`readProxyHash` 读取账户代理。
// 每一次读取都走会话被指定的那个核心哈希。
```

阈值计的是验证器实例，而不是独立的密钥或人。不同模块可以共享凭据或控制方，因此一次成功的法定人数并不建立签名方独立性。

### 配置成员

成员配置就是普通的模块配置：对验证器实例调用 `configure` 需要在配置意图中携带 `configureModule` 动作，因此它与其它任何意图一样走 24 小时成熟期，且模块无法配置自身。轮换凭证则是即时的：`revokeCredentials(accountId, moduleId)` 是托管方授权的核心动作，会当场提升该实例的代数，这也是为什么绑定旧代数的签名在它执行的那一刻起就不再有效。

核心没有暴露读取策略的方法。策略通过 `ThresholdPolicySet` 通知（`accountId`、`policyId`、`threshold`、`memberIds`）可观测，每个成员实例则通过 `getModule` 可观测——描述符携带 `credentialGeneration` 与 `thresholdMemberEligible`，正是成员摘要绑定的那两个值。要读取尚未生效的意图及其成熟时间与动作摘要，请用 `getPendingConfiguration`，并在确认前把该摘要与你实际提案的意图比对；仅有一条待生效记录并不能证明它携带你期望的变更。

### 证据与边界

`MultiSigSdkVectorTests.cs` 运行真实的 JS 序列化器，把其字节与 VM 的 `StdLib.Serialize` 比对，拒绝错位与重复的成员条目，并针对一次真实的核心操作演练阈值路由。序列化器上限为 10 个成员与 65,535 字节总量；空十六进制是 ByteString，与 null 不同。

SDK 单元测试覆盖成员摘要、代数绑定、畸形签名与装配顺序。前端测试校验 RPC Array 与 base64 ByteArray 的传输编码。本工作不引入任何新的通用“多签已完成”徽标。

### 配置 V3 MultiSig 子验证器

MultiSig 根转发到验证器子项属于 v3 已部署合约配置；上文的 v4 阈值没有 MultiSig 根，也没有验证器子项。在该旧配置中，每个普通验证器都要求已固定的 SA 核心以精确的按账户配置上下文来调用它。一个转发到子验证器的 MultiSig 根无法满足该检查。核心源码提供了有界的子初始化路径。`callVerifierChild(accountId, childVerifier, method, args)` 与本节下文描述的 `getChildVerifierConfig(accountId)` 读取都不存在于已固定的部署工件中（`contracts/build` 下的核心清单两者都不导出），因此在集成方能够调用本节描述的路径之前，必须先重新构建部署（DS-CU-202 发现 F1）。

- 调用方必须满足账户的备份所有者见证。账户不能处于市场托管或活跃执行中。
- 当前根必须暴露一个安全的 `getChildVerifierConfig(accountId)` 读取，返回根的有序子列表与阈值；该读取不存在于已固定的部署工件中，属于源码要求，而不是 `contracts/build` 中部署的既有属性。MultiSig 从其既有的 `getConfig` 状态实现它；`getConfig` 本身不变。
- 目标必须是当前的直接子验证器，具备完整的 V3 生命周期 ABI，且 `authorizedCore()` 等于本核心。根也必须绑定到本核心。
- 只接受 `setPublicKey(Hash160, ByteArray)` 与 `setConfig(Hash160, Array, Integer)`，且 `args[0]` 必须等于 `accountId`。
- 首次调用会暂存既有的待生效验证器调用记录并返回 `false`。24 小时之后，完全相同的第二次调用才会调用子验证器。该记录绑定根、子验证器、方法、参数、有序拓扑与阈值；确认时会再次检查当前拓扑。当前输入发生变化会暂存一个新的 24 小时提案。同一个待生效槽位与 `callVerifier` 共享。
- 核心只为该子验证器授予配置上下文，直接调用它，并在返回时清除上下文。对子验证器的直接调用仍然不被授权。

例如：以空的验证器参数注册一个 MultiSig 根，通过既有的 `callVerifier` 时间锁配置其根的 `setConfig`，然后通过各自独立的 `callVerifierChild` 提案分别初始化某个 Web3Auth 子验证器的 `setPublicKey` 与某个 NeoNative 子验证器的 `setConfig`——该路径不存在于已固定的部署工件中，因此这一序列需要重新构建的部署。每个提案都使用包含账户 ID 的完整参数列表。既有的待生效读取函数会报告根模块、承诺哈希与可用时间。

该路径只初始化直接子验证器，不改变清理、权限 epoch 或常规根配置。安全读取函数是一项显式能力，不是对任意第三方根代码的独立信任证明。

#### 子验证器执行隔离

MultiSig 只把真正的 Boolean `true` 计为子验证器的批准。Integer `1`，或来自清单具有误导性的合约的其他真值 VM 值，都不计入阈值。

`CallFlags.ReadOnly` 限制存储与调用，但不会让 VM 集合变为不可变。因此 MultiSig 会把原始参数序列化一次，并为每次子校验与执行后调用反序列化一份独立副本。执行后结果也按同样的快照加复制方式处理。子验证器无法通过共享的 Array、Struct、Map 或 Buffer 对象改变另一个子验证器签名的参数或记账输入。

参数与目标结果必须能被 Neo StdLib 序列化。Interop 与迭代器结果不受支持，会失败关闭；合约绝不会悄悄把不受支持的共享对象传给下一个子验证器。快照会带来序列化与逐子反序列化的开销；配置的子验证器上限为十个。阈值仍然是对已配置模块的阈值，而不是对彼此独立的人类所有者或独立密码学签名域的保证。

## EIP-712 签名

本节是 V3 验证器在链上哈希并校验的 EIP-712 风格签名面的规范参考。字节层面的唯一事实来源是
`contracts/plugins/verifiers/Web3AuthVerifier.cs`；SDK 在 `shared/metaTxCore.mjs`（类型化数据形状）与
`sdk/js/src/metaTx.js`（字节精确的 payload 构造）中镜像它。凡本布局刻意偏离严格 EIP-712 之处，
都列在 [与严格 EIP-712 的偏离](#与严格-eip-712-的偏离) 一节。

### 域分隔符

类型字符串：

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
```

| 字段 | 取值 |
| --- | --- |
| `name` | `"Neo Smart Account"`（已部署验证器实际哈希的线格式常量；在 SA 协议字符串切换中从 `"Neo N3 Abstract Account"` 改为现值——切换前的旧域签名在本次切换时截止失效） |
| `version` | `"1"` |
| `chainId` | Neo 网络魔数（`Runtime.GetNetwork()`），例如主网 `860833102` |
| `verifyingContract` | **验证器**合约哈希（执行 `validateSignature` 的合约），20 字节 |

编码（`Web3AuthVerifier.BuildDomainSeparator`）：

```
domainSeparator = keccak256(
    EIP712_DOMAIN_TYPE_HASH ||
    keccak256("Neo Smart Account") ||
    keccak256("1") ||
    ToUint256Word(chainId) ||          // 32 字节大端字
    ToAddressWord(verifyingContract)   // 12 个零字节 || 20 字节大端
)
```

`EIP712_DOMAIN_TYPE_HASH` 为
`keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`
= `8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f`。

### UserOperation 结构体

类型字符串（V3）：

```
UserOperation(bytes20 accountId,bytes20 coreContract,address targetContract,string method,bytes32 argsHash,uint256 nonce,uint256 deadline)
```

`USER_OPERATION_TYPE_HASH` =
`keccak256("UserOperation(bytes20 accountId,bytes20 coreContract,address targetContract,string method,bytes32 argsHash,uint256 nonce,uint256 deadline)")`
= `577a3a6bd91683e300e814cd25ff6247ab7ca273ddd0153a99919d72ddf9fa04`。

字段编码（`Web3AuthVerifier.BuildMetaTxStructHash`）：

| 字段 | 字编码 |
| --- | --- |
| `accountId` | `ToBytes20Word`：20 字节哈希按**大端显示顺序**，**右**侧补 12 个零字节 |
| `coreContract` | 同一个 `ToBytes20Word`，作用于已授权的 SA 核心哈希（验证器所绑定的核心） |
| `targetContract` | `ToAddressWord`：12 个零字节后接 20 字节大端（标准 `address` 补位） |
| `method` | `keccak256(utf8(method))`——与 EIP-712 的 `string` 编码一致 |
| `argsHash` | 由核心计算的 `keccak256(StdLib.Serialize(op.Args))`（`computeArgsHash`）；该序列化是 NeoVM 的二进制栈项格式，不是 EVM ABI |
| `nonce` | `uint256` 大端 32 字节字 |
| `deadline` | `uint256` 大端 32 字节字（Neo `Runtime.Time` 毫秒） |

```
structHash = keccak256(
    USER_OPERATION_TYPE_HASH ||
    ToBytes20Word(accountId) ||
    ToBytes20Word(coreContract) ||
    ToAddressWord(targetContract) ||
    keccak256(utf8(method)) ||
    argsHash ||
    ToUint256Word(nonce) ||
    ToUint256Word(deadline)
)
```

### 签名 payload 与签名

```
payload = 0x19 || 0x01 || domainSeparator || structHash   // 66 bytes
digest  = keccak256(payload)
```

- 该 digest 以 **secp256k1 ECDSA** 签名；**没有 EIP-191 个人消息前缀**——`0x1901` 前缀就是唯一的信封。
- 链上签名是紧凑的 64 字节 `r || s` 形式（不含 `v`）。
  `Web3AuthVerifier.validateSignature` 断言长度恰为 64 字节。
- `nonce` 与 `deadline` 必须满足 `0 <= value < 2^255`（NeoVM 有符号
  `Integer` 的定义域）；SDK 构造器拒绝超出定义域的值。
- 账户 id 与注册绑定：`computeRegistrationAccountId`
  承诺了验证器、其参数、钩子、备份所有者以及逃生时间锁，因此为某一配置签出的签名
  无法被重放到另一配置上。

### 与严格 EIP-712 的偏离

1. `bytes20` 不是 EIP-712 的原子类型。本布局把它当作 32 字节字，其中 20 个哈希字节按大端
   **右**侧补零；而 EIP-712 的 `address` 是左侧补零。只有 `accountId` 与
   `coreContract` 使用它；`targetContract` 遵循标准的左补零
   `address` 编码。
2. `argsHash` 承诺的是参数列表的 NeoVM `StdLib.Serialize` 字节形式。跨语言签名方必须逐字节
   复现该序列化，或直接向核心读取 `computeArgsHash` 的结果。
3. `chainId` 承载的是 Neo **网络魔数**，不是 EVM 链 id。

这些偏离是刻意保留的：payload 在同一条链的 VM 内生成并校验，钱包侧签名由下面的字节精确
构造器提供，而不是由通用 EIP-712 实现提供。

### SDK 构造器

- `buildUserOperationTypedData(options)` —— 面向钱包与展示层的类型化数据
  （domain + types + message），对应上面的布局。
- `buildUserOperationSigningPayload(options)` —— 完整的 66 字节
  `0x1901` 信封 payload，可直接交给原始 secp256k1 签名器。域分隔符与结构体哈希是
  该 payload 内部的 `ethers.TypedDataEncoder` 输出：v4 SDK 只暴露 payload 与其摘要，
  不再把两个中间哈希作为独立构造器。
- `buildUserOperationSigningDigest(options)` —— 该 payload 的 `keccak256`，
  即原始 secp256k1 签名器实际签名的 32 字节。
- `SmartAccountClient.computeArgsHash(args)` —— 向核心索取规范
  `argsHash`，而不是在客户端重新实现序列化。

黄金向量测试（`sdk/js/tests/flow.unit.test.js`，即 "EIP-712 typed
data hash matches expected test vector"）端到端钉住了这一字节布局。

## 代理转账

虚拟账户的资产位于其代理验证脚本的哈希处，而不是其账户 ID 处。仅有所有者或中继见证，并不授权从该地址进行 NEP-17 转账。当运营者启用 `AA_RELAY_PROXY_WITNESS_ENABLED=1` 并配置账户的验证作用域目标时，中继可以构造额外的见证。

### 确切的交易形态

交易恰好只有一个应用层调用：`core.executeUserOp(accountId, op)` 或 `core.executeUserOps(accountId, ops)`，各有两个参数。参数构造只允许包含常量压栈与数据构造操作码。验证器把最终调用绑定到实际核心与实际账户 ID。对该直接（非赞助）形态而言，其他入口点、其他核心 / 账户、额外调用与控制流都会被拒绝。v4 custom Verification 内核还以同样的数据压栈纪律单独绑定两个五参数的 sponsored 包装入口（单条与批量皆可）——该内核接受意味着什么、不意味着什么，见下文“赞助边界”。

0 号签名方是支付费用的中继，作用域为 `CalledByEntry`。1 号签名方是推导出的代理，恰好带一条 `Allow` 规则，包含 `Or(CalledByContract(core), CalledByContract(configuredTarget))`。代理见证的调用脚本为空，验证脚本由 `core.verify(accountId)` 构成。中继签名覆盖完整交易，包括两个签名方、脚本与费用。在计算网络费用与最终序列化时，两个见证都存在。绝不允许代理支付外层交易的费用。

中继在本地推导脚本，把其哈希与 `getProxyScriptHash(accountId)` 比对，并从选定的核心 / RPC 读取 `getVerifyScopeTarget(accountId)`。配置的目标必须等于被转移的代币。批次中的每个操作都必须指名同一个目标。与提交竞争的作用域变更会被交易验证拒绝。客户端提供的签名方或见证元数据不会用于构造该权限。

### SDK 构造器

整笔交易在一个地方组装——`shared/proxyWitness.mjs`，中继路由与钱包前端都调用它：

- `buildExecuteUserOpScript({ coreHash, accountId, invocation })` 输出受形态约束的脚本。它拒绝除 `executeUserOp`/`executeUserOps` 之外的每个入口点、错误的核心、错误的账户、错误的参数个数与空批次，因此它产出的字节只能是那一个应用层调用。其 Neo VM 压栈编码器由测试固定，在单条、批量与嵌套参数调用上与节点自身的汇编器（`neon-js sc.createScript`）逐字节一致。
- `buildProxyWitnessTransaction({ coreHash, accountId, invocation, scopeTarget, expectedProxyHash, feePayer, … })` 按该签名方顺序返回脚本、费用支付方签名方、受限的 `WitnessRules` 代理签名方与代理验证见证。它会以 `PROXY_SCOPE_TARGET_REQUIRED` 拒绝缺失或全零的 `scopeTarget`，拒绝作用域目标为核心、作用域目标不是被转移代币、批次中目标混用，以及费用支付方是代理的情况。
- `resolveProxyWitnessTransaction({ …, readState })` 通过注入的读取器读取 `scopeTarget` 与 `expectedProxyHash` 之后执行同样的构建。读取器必须是提交所用的核心 / RPC；任何调用方都不能从请求元数据传入这两个值。
- `buildProxyWalletSignRequest({ transaction, scope, allowedContracts })` 是浏览器钱包签名路径。它把费用支付方重新表达为自定义作用域——带显式白名单的 `CustomContracts`，或 `Global`——而代理保留其受限规则与见证。

`sdk/js/src/proxyWitness.js` 重新导出该模块，因此 SDK 携带同一个构造器。前端在 `frontend/src/shared/` 下内置了一份逐字节相同的副本（由 `frontend/tests/transferOutcomeShared.test.js` 强制）。

本地链场景 `SA-12` 在已部署核心上端到端驱动该构造器：一把非合约管理员的临时密钥注册账户、支付费用，并从 SDK 构造的交易中把恰好 1 GAS 移出账户的代理地址；同一个构造器在交易存在之前就拒绝管理员从未配置作用域的账户。回执记录了构造出的脚本、两个签名方与钱包签名请求。

### 费用估算

已发布的 Neo RPC 在 `calculatenetworkfee` 中会省略自定义的非空验证脚本：其估算不包含代理的 VM 验证开销与序列化见证字节。因此代理模式还要求以 datoshi 计的正数 `AA_RELAY_PROXY_NETWORK_FEE_RESERVE`，以及网络或总费用上限。中继在强制所有既有上限之前，会把该运营者选定的预留加到 RPC 估算之上。

这是有界的运营预留，不是自动的精确费用估算。预留不足会被节点拒绝；不必要地过大的预留会支付不必要地过高的网络费用。运营者必须针对自己的节点、脚本大小与接受的操作族进行验证。私有链验收为其测试过的直接转账使用 2 GAS 预留。该测试值不是公开部署的建议值。

中继会保留显式的不赞助选择加入、链下赞助批准绑定，以及系统 / 网络 / 总费用上限。代币转账返回 Boolean false 时，会在预检期间被拒绝，并在费用估算期间再次被拒绝。预检失败或超出上限之后不会广播任何交易。

### 赞助边界

**受赞助的代理转账是内核可接受、但部署层不支持的。** 当前 v4 custom Verification 精确绑定四种交易形态——两参数的 `executeUserOp`/`executeUserOps` 调用与五参数的 `executeSponsoredUserOp`/`executeSponsoredUserOps` 包装（各自含单条与批量）——且运行时套件在真实代理见证下，以确切的五参数 sponsored 信封驱动一次 GAS 转账，并拒绝追加调用、为其他账户 / 核心构造的调用以及非代理费用支付方。这是受形态约束的内核接受，不是端到端能力：relay 路由尚未迁移到 v4 模块 ABI，仍会在计算费用或为广播签名交易之前，显式拒绝使用这两个 sponsored 入口的代理转账；真实链上的受赞助代理转账证据仅限于该回归套件，没有任何当前源码的链上回执断言一次结算。启用该路由仍需下文经评审的设计。

交易见证在 `executeUserOp` 清除其钩子与验证上下文之后仍然存在。当前赞助接受一个基于其自报 `authorizedCore` 的 Paymaster；那不是独立的信任决策。若结算调用了代理见证作用域覆盖的合约，该权限可能在已签名操作的钩子记账之外被复用。因此支持受赞助的代理转账，需要针对 Paymaster 权限与见证生命周期的经评审设计。通过常规 Paymaster 的正常路径测试是不够的。

直接代理转账仍可使用链下的中继赞助策略：交易本身仍是单次 `executeUserOp(s)` 调用，支付费用的中继不会通过链上结算回调获得报销。

### 钱包行为与验收

NEP-17 预设可以在中继模式下暂存一次代理转账。暂存的操作会记录需要代理见证。客户端路径现在用 SDK 构造器（`buildClientProxyWitnessTransaction`）构建完整的代理见证交易，并携带其自定义作用域的钱包签名请求，因此能为构造出的交易签名的钱包可以完成转移：dApp 请钱包以费用支付方身份签署交易，并自行附加代理验证见证。普通钱包的 `invoke` API 会广播它自己的交易，无法携带不是它创建的验证脚本，因此 `executeBroadcast` 仍拒绝经此类钱包发送，而不是提交一笔会返回 false 却仍燃烧费用的转账；导入的草稿在客户端广播时也接受同样的检查。钱包端到端路径（本地链上的钱包垫片）单独跟踪。未启用该特性的中继保留其先前行为，并拒绝缺少有效见证的标准代币转账。

配置的作用域仍是管理员管理的前置条件。该变更不会让任意账户自助配置作用域，也不会激活某个原生 SmartAccount 配置。

协议 v4 的当前源码测试套件不再驱动中继路径：它的四个场景覆盖账户创建、配置意图、 核心钩子顺序与仅所有者恢复，因此没有任何当前源码回执断言代理转账的余额、确切的签 名方规则、费用预留或中继赞助拒绝。这些断言仍针对冻结的已部署工件及其预期 （`tests/localchain/expected-deployed.json`）运行；那是对已部署合约的历史证据，而 非对 v4 核心的声明。把中继路径重新对齐到 v4 模块 ABI 是独立的工作。

### 工件刷新改变了什么、没改变什么

重新钉扎构建（2026-11-20 的可复现性证书、其私有链源码回执与溯源连接结果）只移动
工件身份。它不会：

- 把 `SA-12` 回执变成 v4 源码证明——该场景仍针对冻结的已部署工件运行，且没有任何
  当前源码回执断言代理转账余额、确切签名方规则、费用预留或赞助拒绝；
- 启用受赞助的代理转账——内核对确切五参数信封的接受并不等于端到端启用：中继仍拒绝这两个
  sponsored 入口，真实链上的受赞助代理转账证据仍限于运行时回归套件，且下文针对 Paymaster
  权限与见证生命周期的经评审设计仍然必需；
- 把中继重新对齐到 v4 模块 ABI——那仍是独立工作，且在该特性关闭时，中继依旧
  拒绝缺少有效见证的标准代币转账。

工件哈希是身份，绝不是验收。把那个数字读成“代理转账已在 v4 上得到证明”，正是本节
要拒绝的推断。

## 待处理配置更新读取

custom 部署合约配置新增两个安全方法。它们是对既有待生效标志、成熟时间 getter 以及
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
交易草稿时，不得把它呈现为已由链上验证。`contracts/bin/public` 下的构建产物是本地
验证输出，不是已部署升级的证据。

> 门禁按英文匹配的边界句原文：`This ABI describes newly compiled source. Existing deployments that do not advertise these method names continue to expose only the older reads.`

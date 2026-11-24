# SmartAccount SDK 参考

请使用 `NativeSmartAccountClient` 连接原生 SmartAccount。协议尚未发布；客户端只接受[当前参数](proposals/smartaccount-native-profile-parameters.json)。

## 目录

1. [SDK 使用](#sdk-使用) —— 发现、身份、创建、状态、执行、代次、模块、动作、费用
2. [阈值会话](#阈值会话) —— 阈值策略 SDK 与钱包会话
3. [EIP-712 签名](#eip-712-签名) —— Web3AuthValidator 的类型化签名数据
4. [代理转账](#代理转账) —— 直接代理见证的构造、费用策略、拒绝赞助
5. [待处理配置更新读取](#待处理配置更新读取) —— 配置更新的读取面

## SDK 使用

### 节点检查

`discover()` 核对网络、原生合约地址、名称、负数原生 ID、清单的参数指纹、方法签名与事件名。节点还须返回固定编码标记和实现名 `NativeSmartAccount`。任何不匹配均停止操作，重新验证失败会清除原先的连接状态。

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

`getAccount(accountId)` 对未注册账户返回 `null`；已注册账户只可能正常或冻结。核心返回 15 个字段：存在标记、状态、托管和恢复地址、权限代际、配置计数、恢复延迟、两种内置授权开关、仅托管人恢复标记、钩子和控制记录的修订号，以及三个不承载有效恢复或市场状态的保留字段。查询已安装的恢复席位才能得知真实恢复状态。开户时权限代际为 1，配置计数为 0。

### 执行

`buildExecutionScript({accountId, operations})` 对单个操作发出 `executeUserOp(accountId, op)`，对批次发出 `executeUserOps(accountId, ops)`。操作是十三字段的数组：版本、目标、方法、参数、nonce、nonce 子键、截止时间、验证器 id、凭据代次、授权 epoch、配置 nonce、签名与钩子证明。

`deriveNonceRouting(accountId, routing)` 在本地计算通道；`getNonce` 读取打包后的 nonce，`getNonceSequence` 读取通道游标。签名前用本地 `operationDigest` 计算摘要，签名字段可以为空。链上 `getOperationDigest` 要求传入非空签名字段，但会清空该字段再计算摘要，不验证签名。签好后用 `validateUserOp` 预检，不消耗 nonce。应用验证消息签名时直接调用核心的 `isValidSignature`，因为摘要绑定调用应用；SigningModule 可读取生效名单，修改名单要经过治理。

`getNonce` 接收 `{validatorId, nonceSubkey}`。同时提供 `credentialGeneration` 和 `authorityEpoch` 时，客户端会校验返回的通道与本地推导一致；两者都省略时使用核心结果。`resolveCredentialGeneration` 对已注册账户的托管路径返回 1，对已安装的验证器返回实例凭据代次，对已生效的强制多签策略返回该策略的凭据代次。

```js
const plan = client.buildExecutionScript({ accountId: state.accountId, operations: [operation] });
```

代理见证由 SDK 合成：其作用域是限于操作目标的 `CustomContracts`，见证是空调用加规范验证脚本。托管与恢复见证由核心内部的 `Runtime.CheckWitness` 识别，因此被限定到确切的 core hash。仅支付方支付永远不授予账户权限。

`validateNativeInvocationResult` 在签名之前检查执行证据，并在确切的已签名交易上再次检查。单个操作必须返回恰好一个格式正确、可序列化的 VM 项；批次必须返回一个确切的 Array，每个操作对应一个结果。名为 `transfer` 的方法必须严格返回 Boolean `true`；缺失、截断、类型错误、false 或非 Boolean 的转账结果都不能授权提交。其他目标方法保留其原生返回语义，包括 Boolean `false` 与 Null。生命周期调用合法地返回空栈是允许的，但缺失或畸形的栈会被拒绝。出错的模拟仍可用于诊断，且绝不会自动给出费用批准。

### 凭据代次

内建托管路径的操作凭据代次固定为 1。已安装的验证器使用 `getModule` 返回的凭据代次；多签路径使用 `getThresholdPolicy` 返回的已激活策略代次。过期的代次或权限代际会改变 nonce 通道，不能用于当前操作。消息主体修订号由 `getMessageSubjects` 返回，独立于托管操作凭据。

### 模块

基础账户收款和转账无需安装模块。启用可选功能时，按[具名模块条款](proposals/SMARTACCOUNT-MODULE-NEPS.zh-CN.md)选择权限和安装参数。注册可附带最多 16 个安装或卸载动作。已有活动账户直接调用安装入口时，核心会读取部署合约的声明：

```js
const install = client.buildAccountActionScript({
  method: 'installModule',
  accountId: state.accountId,
  args: [moduleTypeCode, moduleContractHash, initData],
});
```

安装类型码为验证器 1、钩子 4、恢复席位 5。安装成功返回正整数实例编号。正常卸载启用的具名模块时调用 `removeModule(accountId, moduleId, [])`，按实例编号移除。注册及批量安装动作还会比对预期声明摘要。直接管理模块需要托管见证或获准的已安装验证器；启用强制支出多签后，此路径不再可用。

`getModules(accountId, 'recovery', {cursor, limit})` 分页读取恢复席位；另外两类使用 `'validator'`、`'hook'`。`getModule(accountId, moduleId)` 读取单个实例。核心按已安装序列执行钩子；编排模块可以确认现有顺序并请求撤销凭据。撤销会推进凭据代次，保留实例；卸载后重装则分配新的编号。

### 账户动作

启用强制支出多签前，托管人可以冻结活动账户；托管人或获准的已安装验证器可以解冻已冻结账户。两次转换都会推进权限代际和配置 nonce。原恢复策略保留，绑定旧代际的请求失效。

使用 `client.buildRecoveryModulePlan({ accountId, action, authority, newCustody })`，通过已安装的恢复席位准备发起、取消或执行请求。非零新托管人必须提供见证。取消和执行会绑定用户核对过的请求编号和配置 nonce。只有预设恢复席位可以在延时届满后完成核心重置。参见[恢复模块条款](proposals/nep-smartaccount-module-profiles.mediawiki#RecoveryModule)与[模块自身的 ABI](proposals/smartaccount-module-abis.md#recoverymodule)。

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

原生测试覆盖 编码向量、epoch 与计数器最大值、确切封装、严格类型、恶意 RPC 响应、nonce 路由与批次、费用上限、真实 P-256 交易签名与预检拒绝。`npm run test:package` 会在仓库之外安装真实的 tarball，并检查 CJS / ESM / 类型。

本地原生 VM 测试运行编译后的核心与标准模块，参见[构建说明](../contracts/native/README.md)。公共网络激活需要独立证据。

协议要求与剩余的激活门禁，映射在[issue 242 一致性评审](proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md) 中。

## 阈值会话

核心没有 MultiSig 根，也没有验证器子项。阈值是安装在账户上的验证器模块之上的一层策略：成员就是同一个账户的模块 id，每个成员各自持有自己的凭证代数，而操作只携带一个装配好的签名字段。`shared/multiSigCore.mjs` 是唯一实现；JS SDK（`createThresholdClient`）与前端（`createThresholdSession`）只是把它绑定到某个客户端与某个 RPC。

1. 成员来自核心。`prepareMembers` 读取每个成员的模块描述符——是否已安装、`thresholdMemberEligible`，以及当前的 `credentialGeneration`——并返回每个成员必须签名的 §5 成员摘要。调用方自报的代数从不被信任：过期的代数会产出一个被核心以 `SA_CREDENTIAL_STALE` 拒绝的摘要。
2. 装配是显式的。`assembleSignature({ members })` 序列化 `[moduleId, 64 字节签名]` 对，`assembleOperationSignature({ operationDigest, members })` 返回 `{ signatureHex, members }`，其中 `signatureHex` 就是 13 字段操作的字段 11。
3. 先安装标准恢复模块并配置恢复授权方。在治理提案最后加入 `[7, 0, 阈值, 成员编号, true]`，24 小时后确认。生效后，账户支出均须达到门限。要更换成员或恢复基础转账，须走预设延时恢复流程。

```js
const { createThresholdClient } = require('@r3e-network/neo-smart-account');

const threshold = createThresholdClient({ client });
const prepared = await threshold.prepareMembers({
  accountId,
  operationDigest,
  memberIds: [1, 2, 3],
});
// 每个成员用自己的验证器密钥签名 prepared[i].digest。
const signatureHex = threshold.assembleSignature({
  members: [{ moduleId: 1, signature: firstSignature }, { moduleId: 2, signature: secondSignature }, { moduleId: 3, signature: '' }],
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

核心要求每个成员使用不同的公钥。同一人仍可能控制多把密钥。

### 查询支出策略

调用 `client.getThresholdPolicy(accountId)` 即可读取当前策略编号、门限、成员和凭据代次。基础账户返回 `null`。对于尚待确认的提案，可向治理模块查询 `getPendingConfiguration`，确认前核对动作摘要。

### 证据与边界

`MultiSigSdkVectorTests.cs` 运行真实的 JS 序列化器，把其字节与 VM 的 `StdLib.Serialize` 比对，拒绝错位与重复的成员条目，并针对一次真实的核心操作演练阈值路由。序列化器上限为 10 个成员与 65,535 字节总量；空十六进制是 ByteString，与 null 不同。

SDK 单元测试覆盖成员摘要、代数绑定、畸形签名与装配顺序。前端测试校验 RPC Array 与 base64 ByteArray 的传输编码。本工作不引入任何新的通用“多签已完成”徽标。

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

# 原生 SmartAccount 配置档（Profile）

> 历史研究记录，不是当前协议。参见[当前规范](../../SA-MODULE-PROTOCOL.zh-CN.md)。

> 中文版本与 `docs/archive/native-research/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md` 同构。若两者冲突，以英文版本为准。

**基础：** 草案 PR [#243](https://github.com/neo-project/proposals/pull/243)

**讨论：** Issue [#242](https://github.com/neo-project/proposals/issues/242)

**状态：** 草案协议配置档；尚未激活，也不是已采纳的标准
**版本：** 2（身份派生版本 1；授权与账户记录版本 2）

## 1. 范围

本文为 SmartAccount 协议基础定义一份原生 Neo N3 配置档。它规定原生合约身份、激活边界、账户身份、验证脚本地址、账户状态、模块生命周期、UserOperation 授权、资源计量、治理与迁移。

它不分配 NEP 编号。它既不合并也不取代 [#218](https://github.com/neo-project/proposals/pull/218) 中的通用验证脚本提案，也不采纳 #219 或 #220 中的可选提案。

在激活硬分叉、与之匹配的节点实现、与之匹配的 DevPack 接口面以及已发布的符合性向量被一并接受之前，任何实现都不得（MUST NOT）把本配置档作为已激活能力对外暴露。

## 2. 规范用语

**MUST**、**MUST NOT**、**REQUIRED**、**SHOULD**、**SHOULD NOT** 与 **MAY** 为规范用语。

本文所有字节串按线上顺序（wire order）展示。Neo 的 `UInt160` 以其标准 `ToArray()` 表示序列化。十六进制展示不会再反转一次字节序。

## 3. 固定配置档参数

| 参数 | 值 |
|---|---|
| 原生合约名 | `SmartAccount` |
| 原生合约哈希 | `GetContractHash(UInt160.Zero, 0, "SmartAccount")` |
| 配置档版本 | `2` |
| 身份派生版本 | `1`（未变） |
| 授权版本 | `2` |
| 账户记录版本 | `2` |
| 权威纪元与配置 nonce | 两个相互独立的无符号 64 位计数器 |
| 原生 ABI 版本 | `2` |
| 原生验证器子级上限 | `3` |
| 原生验证器阈值 / 已批准子级上限 | `2` / `2` |
| 聚合原生签名方域上限 | `3` |
| 批处理大小上限 | `32` 个操作 |
| 方法名长度上限 | `128` 个 UTF-8 字节 |
| 参数个数上限 | `64` 个值 |
| 参数序列化后大小上限 | `4096` 字节 |
| 签名大小上限 | `1024` 字节 |
| 参数嵌套深度上限 | `8` |
| 验证器回调预算 | 每个回调 `100,000,000` datoshi |
| 钩子回调预算 | 每个回调 `250,000,000` datoshi |
| 模块维护回调预算 | 每个回调 `250,000,000` datoshi |
| 验证器校验调用标志 | `ReadOnly` (`0x05`) |
| 验证器后置调用标志 | `All` (`0x0F`) |
| 钩子回调标志 | `All` (`0x0F`) |
| 目标调用标志 | `All` (`0x0F`) |
| 模块变更延迟 | `86,400,000` 毫秒 |
| 托管恢复延迟 | `604,800,000` 毫秒 |
| 原生赞助 | 版本 2 不包含 |

资源预算是固定配置参数。它们不是操作字段、不是账户可控制的值，也不是费用白名单豁免项。后续配置档版本若改变这些预算，必须使用新的 ABI 版本与新的激活边界。

### 资源单位与有效上限

本配置档以 **datoshi** 作为资源单位（`1 GAS = 100,000,000 datoshi`）。回调排期是固定的；因此配置档默认值与配置档最大值是同一个值，不能由账户、模块、中继或操作提供：

| 回调 | 单位 | 配置档默认值 | 配置档最大值 |
|---|---|---:|---:|
| 验证器校验与执行后回调 | datoshi | `100,000,000` | `100,000,000` |
| 钩子执行前与执行后回调 | datoshi | `250,000,000` | `250,000,000` |
| 模块维护与清理 | datoshi | `250,000,000` | `250,000,000` |

这些是子调用上限，不是外层交易的默认值或最大值。有效准入上限取三者中的最小值：固定配置档上限、外层交易剩余预算、以及每一层处于活动状态的祖先预算。非正数上限，或高于上述任一剩余预算的上限，必须在子上下文创建之前被拒绝。本配置档不定义外层交易费用的默认值或上限；这些值仍属于网络费用策略与交易显式费用上限的一部分。

激活记录必须包含下列参数摘要：

```text
profileParameterDigest = SHA256(
    ASCII("NeoSmartAccount/Profile") ||
    UInt8(2) ||
    CanonicalProfileParameterJsonUtf8
)
```

在版本 2 中，`CanonicalProfileParameterJsonUtf8` 恰为下列字节序列：

```text
{"abiVersion":2,"accountRecordVersion":2,"argumentCountMax":64,"argumentDepthMax":8,"argumentSizeMax":4096,"authorityAdmission":{"absentPriorAuthorities":"emptySet","authorityReservation":"none","authoritySlots":["custodyAddress","recoveryAddress","pendingRecovery.newCustodyAddress","pendingRecoveryAddr.recoveryAddress"],"introducedAddresses":"Authorities(next)-Authorities(prior)","pendingPromotion":"noAdditionalRecipientWitness","priorState":"validStoredRecordImmediatelyBeforeTransition","recipientConsent":"witnessEveryIntroducedNonzeroAddress","registeredNativeProxies":"rejectCurrentAndPendingOnReadAndWrite","removedAddressRenomination":"freshRecipientWitness","retainedAddressReuse":"noAdditionalRecipientWitness","transitionInitiatorWitnesses":"unchanged","version":1,"zeroAuthority":"excluded"},"authorityEpochWidthBits":64,"authorizationDomainSuffix":["authorityEpochLE64","configurationNonceLE64"],"authorizationVersion":2,"batchMax":32,"childConfiguration":true,"compositeReceipt":{"fields":["BooleanTrue","OrderedApprovedHash160Array","PolicyCommitmentByteString32"],"lifetime":"oneApplicationOperation","policyCommitment":"SHA256(NeoBinarySerialize([threshold,orderedChildren,orderedChildSignerDomains]))","postSignatureRevalidation":false,"selection":"firstThresholdValidChildren","verificationReceiptReused":false,"version":1},"compositeVerifierCallbacks":{"postExecute":{"name":"postExecuteComposite","parameters":["Hash160","Array","Any","Array"],"returnType":"Void","safe":false},"validation":{"name":"validateCompositeSignature","parameters":["Hash160","Array"],"returnType":"Array","safe":false}},"compositeVerifierMaxApprovedChildren":2,"compositeVerifierMaxChildren":3,"compositeVerifierMaxSignerDomains":3,"compositeVerifierMaxThreshold":2,"configurationNonceWidthBits":64,"contractName":"SmartAccount","custodyRecoveryDelayMs":604800000,"executionArgumentOrder":["accountId","operationOrBatch","expectedAuthorityEpoch","expectedConfigurationNonce"],"executionCounterCommitments":["authorityEpoch","configurationNonce"],"hookBudgetDatoshi":250000000,"identityVersion":1,"maintenanceBudgetDatoshi":250000000,"methodBytesMax":128,"moduleChangeDelayMs":86400000,"moduleCompositeVerifierMarkerRequired":true,"moduleProfileDigestRequired":true,"nativeP256Canonicalization":{"accountRegistrationRequired":false,"algorithm":"compressedDecodeThenExactUncompressedRoundTrip","argumentStackType":"ByteString","cpuFeeUnits":32768,"name":"canonicalP256PublicKey","ownedResult":true,"parameters":["ByteArray"],"requiredCallFlags":"None","returnType":"ByteArray","safe":true},"nativeP256SignerDomain":{"canonicalSigner":"CreateStandardAccount(compressedSecp256r1PublicKey)","domainsPerKey":1,"scheme":"NativeScript"},"nativeSessionMetadataStorage":{"atomicWithSessionConfiguration":true,"deletedWithSession":true,"legacyFallback":false,"metadataRecordFields":3,"namespace":"authorityEpoch","policyPrefix":"06","readFresh":true,"sessionConfigurationInitialValue":0,"storedMetadataLastUsedAt":0,"valueType":"CanonicalUInt64NeoInteger"},"nativeSessionPublicKey":{"acceptedEncodingBytes":[33,65],"invalidPoint":"rejectAtomically","normalization":"secp256r1DecodeThenCompress","normalizationServiceMethod":"canonicalP256PublicKey","storedEncodingBytes":33},"nativeSessionSignerDomainStorage":{"atomicWithSessionConfiguration":true,"deletedWithSession":true,"legacyFallback":false,"namespace":"authorityEpoch","policyPrefix":"05","readFresh":true,"sessionRecordFields":5,"valueBytes":32},"nativeSponsorship":false,"nativeWitnessSignerDomainStorage":{"atomicWithConfiguration":true,"configurationRecordFields":2,"deletedWithAccountCleanup":true,"encoding":"orderedPackedByteString32","legacyFallback":false,"maxDomains":10,"namespace":"authorityEpoch","policyPrefix":"03","readFresh":true},"profileVersion":2,"recoveryRevokesModules":true,"signatureBytesMax":1024,"verifierBudgetDatoshi":100000000}
```

由此得到的版本 2 摘要为：

```text
ae557647b63789c7af0a8c7816dc90d5c0d7e65afb78ce3c669de9a01ce3c91a
```

这份尚未激活的 ABI 2 草案的本地修订把完整的权威准入策略绑定进 `authorityAdmission`：当前与待生效的权威集合、读写两侧对已登记代理的拒绝，以及每次状态迁移对其非零集合差集的同意要求。该策略版本为 `1`；它不改变身份派生、操作编码、四个执行参数或资源预算。发现流程必须要求这一确切的新参数摘要。一个拥有相同方法列表但使用旧摘要的 ABI 2 运行时并不标识本次修订，不得被当作本修订的实现接受。

携带旧摘要的模块在配合本修订使用之前，需要重新打包、做代码身份复核，并回读已部署字节。更早的报告与回执保留其原始摘要作为历史证据；它们不得被改写，也不得被呈现为对新摘要的验证。该指纹绑定的是所声明的语义，而不是这些语义的正确性：精确源码、见证执行与运行时一致性证据仍是彼此独立的要求。

## 4. 原生身份与激活

### 4.1 SmartAccount 原生合约身份

合约名恰为 `SmartAccount`。其原生哈希由 Neo 标准原生合约身份函数产生：

```text
GetContractHash(UInt160.Zero, 0, "SmartAccount")
```

该原生合约必须发布下列原生清单元数据：

```json
{
  "smartAccount": {
    "abiVersion": 2,
    "profileParameterDigest": "ae557647b63789c7af0a8c7816dc90d5c0d7e65afb78ce3c669de9a01ce3c91a"
  }
}
```

ABI 版本是协议身份的一部分，不得从方法列表推断。

合约哈希标识的是一个无需许可的协议派发器，而不是账户所有者或资产持有主体。自激活起，`CheckWitness(SmartAccount.Hash)` 必须返回 false，在直接派发的目标中亦然，且与交易签名方作用域无关。旧式的“直接调用者即见证”快捷路径不得授权该合约哈希。该限制在激活前不得适用。

### 4.2 激活

本配置档由协议配置中的专用网络硬分叉键 `HF_SmartAccountV1` 激活。激活必须是独立的硬分叉条目；不得复用既有硬分叉。

每条网络必须配置显式的激活高度。缺失激活条目表示**停用**，而不是创世即激活。节点必须在激活前拒绝原生 SmartAccount 调用，且不得因为加载到未配置的协议设置而在创世时产生 SmartAccount 状态。

在激活区块，节点必须：

1. 创建原生 `SmartAccount` 合约状态；
2. 初始化配置档版本与固定参数摘要；
3. 发出常规的原生合约部署通知；
4. 自该区块起提供版本 2 ABI。

激活前，`SmartAccount` 没有可调用的版本 2 ABI。既有普通合约与既有验证脚本必须保持其当前行为。

该原生合约没有普通合约的部署发送方、NEF 更新方法、管理员或运行时热升级路径。代码与 ABI 变更需要后续的协议激活并附带显式迁移例程。

## 5. 账户身份与地址

### 5.1 账户标识符

账户由托管地址与 32 字节盐登记。原生核心按如下方式计算标识符：

```text
accountId = Hash160(
    ASCII("NeoSmartAccount") ||
    UInt8(1) ||
    UInt32LE(networkMagic) ||
    coreHash.ToArray() ||
    custodyAddress.ToArray() ||
    salt
)
```

`Hash160` 为 RIPEMD-160(SHA-256(input))。域字符串、版本字节、网络编码、字段顺序与字节表示都是固定的。账户标识符必须非零。原生核心必须拒绝已登记的标识符，而不是覆盖它。

该标识符是账户状态键。它不是资产地址，不得被当作资产地址使用。

### 5.2 验证脚本地址

持有资产的地址由下列精确验证脚本派生：

```text
PUSH accountId
PUSH 1
PACK
PUSH ReadOnly
PUSH "verify"
PUSH SmartAccount.Hash
SYSCALL System.Contract.Call
```

该脚本必须使用 Neo 的规范 push 编码，并且必须在栈上恰好留下一个 Boolean 值。它必须符合 #218 中可静态解析的合约调用形态。该静态调用为：

```text
verifierContract = SmartAccount.Hash
method           = "verify"
callFlags        = ReadOnly (0x05)
argumentCount    = 1
arguments        = [accountId]
```

地址就是这些字节的脚本哈希。改变任何一个字节——包括账户标识符、调用标志、方法名或原生合约哈希——都会生成新地址。此类变更必须被视为地址与资产迁移，而不是原址账户升级。

### 5.3 验证触发桥

`verify(accountId)` 仅在 Verification 触发期间可用。验证脚本是资产地址兼容桥，不是第二个授权入口点。它不得为仅仅把账户地址列为签名方的任意交易授权。

对于版本 2，交易脚本必须是本账户的规范应用信封。该信封恰为一次应用调用，包含下列语义值且没有额外指令：

```text
System.Contract.Call(
    SmartAccount.Hash,
    "executeUserOp" or "executeUserOps",
    All,
    accountId,
    op or ops,
    expectedAuthorityEpoch,
    expectedConfigurationNonce
)
```

脚本解析器必须要求原生合约哈希、方法名、调用标志、四个参数、账户标识符、两个当前权威计数器以及规范操作字节全部匹配。两个期望计数器都必须是精确的 UInt64 Integer，并且在 Verification 与 Application 两个阶段都等于当前存储的 `authorityEpoch` 与 `configurationNonce`。原先的双参数入口点不得继续可调用。两个期望计数器编码在未签名交易脚本中，因此交易见证模式（托管回退与 NeoNativeVerifier）除了操作签名之外，也对这些计数器作出承诺。原生回调仍收到未改动的六字段 UserOperation。批处理形式还必须满足批处理边界与同账户规则。直接调用代币、NFT、应用合约或无关原生方法的交易，必须使账户地址验证失败。

规范信封是 Neo 动态合约调用构造器对下列值逐字节的输出，无前后缀：

```text
EmitDynamicCall(
    SmartAccount.Hash,
    "executeUserOp" or "executeUserOps",
    CallFlags.All,
    [accountId, op or ops, expectedAuthorityEpoch, expectedConfigurationNonce]
)
```

构造器必须使用规范 VM push 编码：空数组用 `NEWARRAY0`，非空数组用 `PACK`。操作数组本身必须使用基础提案与本配置档定义的规范序列化。解析器必须拒绝语义等价但包含额外指令、替代调用标志、动态方法值或非规范 push 编码的脚本。

`op` 或 `ops` 的类型化初始化器必须精确保留 VM 值类型：

| 值 | 规范初始化器 |
|---|---|
| Null | `PUSHNULL` |
| Boolean | `PUSHT` 或 `PUSHF` |
| Integer | Neo `ScriptBuilder.EmitPush` 发出的最短有符号编码 |
| ByteString | 该构造器发出的最短长度前缀数据 push |
| 空 Array | `NEWARRAY0` |
| 空 Struct | `NEWSTRUCT0` |
| 非空 Array | 逆序初始化各元素，按规范 push 计数，然后 `PACK` |
| 非空 Struct | 逆序初始化各元素，按规范 push 计数，然后 `PACKSTRUCT` |

这些规则递归适用。为空 Array 发出 `PUSH0 PACK` 的 SDK 重载不满足本配置档。初始化器中不允许 `CONVERT`、重复的栈值、分支、调用或额外 syscall，即便它们会产生相等的值。Struct 仍是参数类型，而不是用于操作、批处理或顶层参数 Array 的替代类型。完整交易还必须满足 Neo 常规的交易大小与执行资源限制；逐操作合法并不意味着最大规模的批处理能装进这些限制。

信封校验通过后，`verify(accountId)` 必须：

1. 要求调用方脚本哈希等于确定性的账户地址；
2. 载入账户状态并要求其处于活动状态；
3. 由 `accountId` 重算地址并要求精确匹配；
4. 在不改变状态的前提下校验操作形态、截止时间、当前 nonce、模块代码身份与授权；
5. 对已准入的组合验证器调用只读的 `validateCompositeSignature`，对标量验证器调用 `validateSignature`；未安装验证器时使用原生见证回退；
6. 返回授权结果，不消耗 nonce、不执行钩子、不调用目标、不发通知。

对于批处理，Verification 触发必须按操作顺序处理各通道的 nonce，并为每个通道使用私有的影子游标。首次出现时载入存储的游标；后续出现时使用同一批中更早操作推进后的游标。这些影子更新不得写入存储。用未变化的存储游标逐一校验每个操作是错误的：当某通道存储游标为 0 时，同一批内的 0 再接 1 是合法的。重复、跳号或已耗尽的序号仍必须被拒绝。校验失败不得消耗任何 nonce。本条规则只覆盖 nonce 模拟；它不为操作授权，也不预测钩子/目标状态变化。

Application 触发的执行会重复做纯校验，然后执行有状态的 nonce、钩子、目标与后置回调步骤。这种刻意的双重求值是必需的，因为 Verification 触发执行无法提交应用状态。因此验证器对该回调必须是确定性的且只读的。

原生见证回退要求托管地址见证同一笔交易，并要求操作签名为空。已配置验证器的账户使用规范信封中的操作签名/证明；托管方对该配置档不被隐式要求。账户地址代理绝不能被接受为其自身的托管见证，调用方提供的签名方列表也不得被当作证明。

### 5.4 应用见证权限

验证触发桥成功并不意味着不受限的应用见证。对于已登记的 SmartAccount 资产地址，应用见证的接受还必须要求该账户存在活动的目标授权，并且要求该调用与 SmartAccount 在操作授权之后建立的目标调用完全一致。Neo 常规签名方与 WitnessRule 检查依然适用；该授权不能凭空制造缺失的见证，也不能扩大其声明的范围。

Global 签名方、自定义作用域中匹配的合约哈希，或重入同一目标合约，都不得绕过这一额外限制。目标的初始化与内部 VM 调用属于其本次调用；新的跨合约调用与任意后代调用不属于。验证器、钩子、配置与清理阶段不携带资产见证授权。原生 SmartAccount 合约与应用见证求值器必须共同执行这一约束；一个调用方可以选择忽略的公开 Boolean 查询并不等价。

## 6. 规范账户状态

原生合约对每个 `accountId` 存储一条规范记录：

```text
AccountState {
    version:              UInt8
    accountId:            UInt160
    accountAddress:       UInt160
    custodyAddress:       UInt160
    recoveryAddress:      UInt160 | zero
    verifier:             ModuleBinding | native-witness
    hook:                 ModuleBinding | none
    status:               Active | Frozen
    configurationNonce:   UInt64
    pendingVerifier:      PendingModuleChange | none
    pendingHook:          PendingModuleChange | none
    pendingRecoveryAddr:  PendingRecoveryAddressChange | none
    pendingRecovery:      PendingRecovery | none
    authorityEpoch:       UInt64
}

ModuleBinding {
    contract:             UInt160
    codeHash:              UInt256
}

PendingModuleChange {
    contract:             UInt160 | zero
    codeHash:              UInt256 | zero
    proposedAt:            UInt64
    activateAt:            UInt64
    expectedConfiguration: UInt64
}

PendingRecovery {
    newCustodyAddress:     UInt160
    proposedAt:            UInt64
    executeAt:             UInt64
    expectedConfiguration: UInt64
}

PendingRecoveryAddressChange {
    recoveryAddress:       UInt160 | zero
    proposedAt:            UInt64
    activateAt:            UInt64
    expectedConfiguration: UInt64
}
```

原生存储编码必须使用确定的字段顺序与固定整数语义。`AccountState` 的规范栈表示是一个恰含 14 个位置的 Array（位置 0 到 12 的含义保持不变）：

```text
[version, accountId, accountAddress, custodyAddress, recoveryAddress,
 verifier, hook, status, configurationNonce, pendingVerifier, pendingHook,
 pendingRecoveryAddr, pendingRecovery, authorityEpoch]
```

`version` 恰为 `2`；`status` 是规范的非负 Integer。索引 13 的 `authorityEpoch` 与索引 8 的 `configurationNonce` 是两个独立的无符号 64 位 Integer，初值为零。计数器溢出必须在变更前致命失败（fault）。版本 2 使用 `Active = 0` 与 `Frozen = 1`；所有其他状态值必须被拒绝。`accountId`、`accountAddress` 与 `custodyAddress` 是 20 字节 ByteString。取值为零的可选地址是 20 字节全零 ByteString。缺失的可选记录为 `Null`。每个 `ModuleBinding` 为 `[contract, codeHash]`；每条 pending 记录使用上文声明的字段顺序，不得省略字段。Neo 的规范二进制序列化器直接作用于该 Array，不经过 map 或文本 JSON 层。缺失字段、多余字段、类型错误与非规范编码必须失败关闭。

SmartAccount 原生合约对每个 nonce 通道独立存储下一个序号。nonce 键为 `(accountId, channel)`，其中 `channel = nonce >> 64`；存储值是下一个 `sequence`，或耗尽哨兵 `2^64`。规范存储键为一字节字段前缀 `0x20`，后接 20 字节 `accountId` 线上表示与 24 字节无符号大端通道号。通道满足 `0 <= channel < 2^191`；该 24 字节字段的最高位必须为零。保留这个定宽字段不会扩展操作 ABI 所使用的有符号 NeoVM Integer 域。账户记录键使用字段前缀 `0x10` 后接 `accountId`；其他任何状态都不得使用这两个前缀。

## 7. 账户生命周期与权威分离

解码后的账户记录必须满足 `authorityEpoch <= configurationNonce`。两个计数器都从零开始；配置流程只推进 `configurationNonce`，恢复流程则同时推进两者。违反该可达状态不变量的记录必须被拒绝，即使两个值各自都在 UInt64 范围内。纯授权域编码器可以为符合性向量编码任意 UInt64 组合；此类向量并不表示该组合是有效的已存储账户状态。

### 权威准入

当前与待生效的托管或恢复权威不得是已登记的原生 SmartAccount 代理。此限制是在下文自身代理、原生合约与角色分离检查之外的额外要求。每次账户状态读写都必须针对已登记代理查询来校验所有当前与待生效的非零权威地址。格式错误的已存储权威必须失败关闭；延迟激活或其他配置路径都不能绕过它。普通钱包、CHECKMULTISIG 与已部署合约作为权威仍然受支持，前提是其原生见证检查在实际调用上下文中成功。

设 `Authorities(state)` 为 `custodyAddress`、`recoveryAddress`、`pendingRecovery.newCustodyAddress` 与 `pendingRecoveryAddr.recoveryAddress` 中非零地址的集合；缺失的 pending 记录不贡献任何地址。先前不存在的账户其权威集为空。在存储一次状态迁移之前，除该迁移已有的发起方见证之外，准入还必须要求 `Authorities(next) - Authorities(prior)` 中每个地址的见证。此处 `prior` 是该迁移紧邻之前有效的存储记录，`next` 是完整的拟定记录。重复地址只检查一次；零表示恢复位缺失，不需要见证。

因此，创建要求托管方以及每一个非零恢复接收方同意。当提议的接收方地址是新引入时，恢复地址提名与托管恢复提名要求该接收方的见证。已存在于当前或待生效权威集中且未改变的接收方无需再次见证；替换或取消某个意图会移除存储记录中不再体现的任何同意。重新提名此类被移除的地址需要重新同意。该准入规则不缩短任何延迟、不为其他迁移发起方授权，也不允许本不合法的角色。

成熟激活与托管恢复执行仍然无需许可，因为其目标地址已在 pending 记录中获得准入。它们不得仅为把该地址移入当前槽位而要求新的接收方见证。取消与移除不引入任何权威；其既有发起方见证要求仍然适用。

SmartAccount 原生合约不得在反向索引中预留权威地址，也不得因另一账户提名该地址而阻止其独立登记账户。预先计算但尚未登记的原生代理无法通过其规范交易验证，因为该账户尚不存在。因此准入同意阻止了通过有效的原生代理见证记录这样一个未来代理；已登记的代理则被独立拒绝。提名失败不得留下权威预留、账户状态变更或通知。这些规则维持目标帧见证隔离与单账户规范信封；两种机制都不会为让嵌套代理权威可用而被放宽。

### 7.1 创建

`registerAccount(custodyAddress, salt, verifier, hook, recoveryAddress)` 必须：

- 是 Application 触发的调用；
- 要求非零托管地址；
- 要求 32 字节盐；
- 要求恢复地址为零，或与托管地址不同；
- 要求托管与恢复地址不得等于账户地址代理；
- 要求托管地址与每一个非零恢复地址见证该交易；
- 内部计算账户标识符与代理地址；
- 在存储前校验验证器与钩子 ABI；
- 拒绝重复的标识符；
- 将所有 nonce 通道初始化为序号零；
- 将账户初始化为 `Active`，配置 nonce 与权威纪元均为零；
- 发出 `AccountCreated`。

调用方不得把 `accountId` 或 `accountAddress` 作为权威值提供。

### 7.2 配置权威

当前托管地址是配置权威。它可以提议：

- 替换或移除验证器；
- 替换或移除钩子；
- 替换或移除恢复地址。

每次变更都延迟固定的模块变更延迟。每份提议记录当前 `configurationNonce`。替换某个意图会重启完整延迟。在其记录的成熟时间点或之后，激活无需许可，且必须拒绝过期的提议。取消是即时的，要求已存在提议且要求当前托管方见证，并且不推进配置 nonce。

所有配置提议与激活都要求账户处于 Active；托管恢复待生效期间，配置变更必须被拒绝。这包括验证器、钩子、恢复地址、根模块与子模块等配置路径。否则，托管方可能在直接取消权到期后通过推进配置 nonce 使已成熟的恢复失效。取消配置意图仍然允许，因为它既不改变生效绑定，也不推进该 nonce。账户处于 Frozen 时同样禁止恢复地址配置，以防通过移除恢复权威绕过联合见证解冻规则。

每一次成功的配置激活、恢复执行、冻结或解冻都会推进配置 nonce 并清除所有 pending 意图，包括托管恢复与恢复地址轮换。不保留任何过期的 pending 记录。配置计数器与时间戳运算不得回绕；配置计数器耗尽后，拒绝需要另一个配置计数器值的提议与迁移。pending 记录必须绑定当前配置 nonce 与其所属类型的精确固定延迟。调用方不得提供成熟时间。

移除验证器会选择原生见证回退。移除钩子会选择不使用钩子。这两种操作都不改变账户地址或 nonce 状态。

### 7.3 恢复权威

恢复地址是可选的。配置后，它是独立于托管方的权威。恢复地址可以提议新的托管地址。该提议仅在固定托管恢复延迟之后、且其配置 nonce 仍然当前时才可执行。新引入的接收方还必须提供上文定义的准入见证；恢复权威不能提名一个未表示同意的新的托管地址。

拟定的新托管地址必须非零，且必须同时不同于当前托管地址、已配置的恢复地址与账户地址代理。拟定的恢复地址必须为零，或同时不同于当前托管地址与账户地址代理。托管地址与非零恢复地址不得是原生合约哈希。这些检查适用于登记时、延迟轮换期间，以及校验已存储的当前或待生效权威时。零仅表示恢复位缺失；它永远不是托管权威。

当前托管方只能在严格早于执行时间（`now < executeAt`）时取消待生效的托管恢复。在相等时刻，该权利已经到期。延迟之后，任何人都可提交 `executeRecovery`；原生合约不要求旧托管方配合。恢复地址可以取消自己提出的 pending 提议。过期或已取消的提议必须致命失败。

执行恢复时：

- 替换托管地址，但不重新派生账户身份；
- 保留账户标识符、账户地址、nonce 状态与恢复地址；
- 移除验证器与钩子根及其全部依赖记录，选择原生见证回退；
- 撤销所有旧模块代次，不调用任何外部回调；
- 清除所有 pending 意图，包括本次已执行的恢复；
- 在带溢出检查的前提下同时推进配置 nonce 与权威纪元；
- 已冻结的账户保持冻结；
- 发出 `RecoveryExecuted`。

若未配置恢复地址，则不存在恢复迁移。不存在委员会、管理员、插件或中继的恢复绕过路径。

### 7.4 冻结与解冻

已配置的恢复地址可以立即冻结账户。被冻结的账户不能执行 UserOperation，也不能提议或激活配置变更，包括恢复地址轮换。恢复操作保持可用，以便修复托管。

存在恢复地址时，解冻同时要求当前托管见证与已配置恢复见证。不存在恢复地址时，仅要求托管见证。因此，没有恢复地址的冻结账户只能由托管权威解冻。

`freeze` 必须要求恢复见证，且账户没有恢复地址时不可用。`unfreeze` 必须要求上文所述的权威。冻结要求 Active 状态，解冻要求 Frozen 状态；相同状态的重复调用必须致命失败。两者都推进配置 nonce 并清除所有 pending 意图，使提议无法跨越状态迁移。

### 7.5 权威代次与恢复隔离

每个原生模块都必须把所有账户自有的持久状态按账户标识符与当前 `authorityEpoch` 命名空间化，纪元取自 SmartAccount 原生合约。原生模块键编码必须为 `0xA2 || policyPrefix || accountIdLE20 || authorityEpochLE64 || suffix`，其中包含一字节策略前缀、20 字节账户标识符与无符号 64 位小端纪元。独立的 `0xA2` 版本标签避免与无版本的旧键混淆。模块必须拒绝无效或不可用的纪元；不存在旧命名空间回退，也不能选择未来代次。配置计数器不是存储命名空间。恢复后重新安装的同一模块必须看到空的当前代次命名空间；旧的授权、密钥、支出状态与瞬态快照不得重新生效。历史存储可以继续不可达；恢复绝不依赖旧模块的可用性、代码身份或成功清理。模块必须把每个回调绑定到当前已认证的原生账户/模块/阶段。

只有成功的托管恢复才推进 `authorityEpoch`。配置、冻结与解冻保留权威纪元，并如上文所述推进独立的配置 nonce。两个计数器都绑定授权，因此一次配置迁移会使先前已签名但未消耗的操作失效。恢复在返回前清除所有 pending 意图与根；目标 nonce、身份与冻结状态保持不变。其后解冻仍要求当前托管与已配置恢复见证。不引入任何委员会绕过。

原生 ABI 1 模块不得被重新标记为 ABI 2。打包后的 ABI 2 模块必须声明 native-v2 配置档、显式 ABI 版本，以及读取 `getAuthorityEpoch` 的权限。当前原生描述符准入的每个模块都必须通过恢复/重装隔离向量。既有 ABI 1 账户记录的迁移需要单独激活的确定性迁移例程；不存在把 13 字段记录隐式解释为 ABI 2 的做法。

每个模块清单还必须声明 `extra.smartAccount.profileDigest`，其值恰为 64 个小写十六进制字符，等于原生合约的 `profileParameterDigest`；并声明 `extra.smartAccount.compositeVerifier`，其值恰为 JSON Boolean。后者仅对使用组合回执回调的验证器为 `true`；验证器的 `supportsComposition()` 必须返回相同的值。钩子必须声明 `false`；其独立的钩子组合发现机制保持不变。组合根还必须通过 `extra.smartAccount.compositeProfile` 以非空字符串按名称声明其配置档；准入读取该清单声明，绝不在链码中硬编码诸如 `MultiSigVerifier` 或 `MultiHook` 之类的模块合约名。组合验证器的声明必须与其 `compositeVerifier` 能力标记一致；非组合验证器不得声明组合配置档。叶子模块不得发布依赖，依赖声明缺失或为空会使任何依赖发布致命失败。

声明缺失、不匹配或类型错误必须导致准入失败。打包器从规范参数 JSON 计算指纹；它不得从编译器标签推断兼容性，也不得静默套用旧指纹。

## 8. 模块绑定与代码身份

每个 ABI 2 验证器（包括组合根）都必须保留下列标量兼容描述符且类型与下文完全一致。普通叶子验证器使用这些回调完成执行；已准入的组合根使用下文另外规定的组合回调。本原生配置档在基线描述符上比基础提案“可定义单独组合 ABI”的一般许可更严格；它不使任何一个执行后回调变成可选。

```text
validateSignature(accountId: Hash160, op: Array) -> Boolean
postExecute(accountId: Hash160, op: Array, result: Any) -> Void
```

组合验证器还必须额外暴露两个非 safe 回调描述符：

```text
validateCompositeSignature(accountId: Hash160, op: Array) -> Array
postExecuteComposite(accountId: Hash160, op: Array, result: Any, receipt: Array) -> Void
```

第一个回调尽管描述符为非 safe，却以 `ReadOnly` 调用。它必须返回恰为三元素的 Array：`[Boolean true, orderedApprovedChildren, policyCommitment32]`。已批准子级必须构成当前生效验证器子级的非空、有序、去重子集，以精确的 20 字节 ByteString 表示。策略承诺必须是精确的 32 字节 ByteString。固定配置档边界适用于子级数、已批准数、阈值与聚合签名方域。

`SmartAccount` 必须在任何目标调用之前严格解析并复制该结果。回执归单次 Application 操作所有；它不得写入合约存储、不得从交易参数接受、不得与另一操作共享，也不得从 Verification 携带到 Application。Verification 解析后丢弃其回执。Application 执行新鲜校验，并仅保留自己的回执直到该操作的后置回调完成或致命失败。批处理中的每个操作各自产生新回执。组合后置回调使用已校验的选择，不重复验证子级签名。其已认证的子级授权限定于已批准子集，而核心仍校验每个当前生效子级的代码绑定。

这是对未发布 ABI 2 草案的修订。配置档发现必须把组合回调与回执语义，连同实测的固定组合上限，一并绑定进权威参数摘要。仅匹配 ABI 编号或 `native-v2` 标签不足以准入早期草案模块。

叶子验证器还必须额外暴露该 safe 发现方法：

```text
getSignerDomains(accountId: Hash160) -> Array
```

返回的每个元素必须是 32 字节签名方域承诺。承诺按如下方式计算：

```text
SHA256(ASCII("NeoSmartAccount/SignerDomain") || UInt8(1) ||
       schemeTag || canonicalSignerMaterial)
```

`schemeTag` 与 `canonicalSignerMaterial` 由配置档定义。签名方域编码版本 1 把 `0x01` 分配给 secp256k1，`0x02` 分配给 secp256r1，`0x03` 分配给原生脚本身份，`0x04` 分配给 DKIM 注册表权威。对 secp256k1 与 secp256r1 身份使用压缩公钥编码，对原生见证身份使用规范的 20 字节脚本哈希，对非密钥配置档使用已配置的权威承诺。验证器必须返回能够授权该账户的全部签名方域，而不只是当前操作使用的签名方。若某个动态策略的签名方集合无法静态表示，它必须返回空数组，且在版本 2 中不是 `MultiSigVerifier` 的合格子级。

原生 ABI 2 把每个 P-256 公钥授权者归一化为恰一个原生标准账户域：`NativeScript(CreateStandardAccount(compressedPublicKey))`。其方案标签为 `0x03`，签名方材料是该标准账户 20 字节脚本哈希的线上顺序。因此使用同一私钥的会话密钥验证器与原生见证验证器暴露同一个域，不能计作两次独立批准。旧式的非原生 `0x02` 密钥域保持独立。该规则并不确立任意脚本的独立所有权。

原生 SessionKey 配置档保留五字段的 `getSessionKey` 记录。其规范签名方域在同一权威纪元命名空间下以策略前缀 `0x05` 单独存储，恰为 32 个裸字节。配置会话时必须由已配置公钥派生该值，并原子地写入两个条目；清除会话时必须删除两个条目。签名方域发现必须重新读取该条目，并拒绝缺失或格式错误的值，不回退到更旧的存储布局。这是确定性配置数据，不是批准回执或缓存；恢复通过推进权威纪元将其隔离。域发现与策略承诺仍在校验期间以及组合后置执行前后受到检查。

原生会话配置接受合法的 33 字节压缩与 65 字节未压缩 secp256r1 公钥，使用前先解码曲线点，并存储规范的 33 字节压缩表示。非法的曲线编码必须拒绝整个配置交易。同一个点的两种编码必须产生相同的标准账户与签名方域。

`canonicalP256PublicKey(publicKey: ByteArray) -> ByteArray` 是一个 safe、纯的原生方法，所需调用标志为 `None`，基础 CPU 费用为 `32768` 单位（在执行费系数之前）。其 VM 参数必须是精确的 ByteString；Buffer、Integer、Boolean、Array 与 null 均被拒绝。它不要求已登记账户。该方法必须解码合法的 33 字节压缩点。对于 65 字节输入，它必须解压所给的 X 坐标与 Y 奇偶位，然后把完整未压缩点编码与原始字节比对，比对通过后才返回自有的 33 字节压缩编码。仅检查长度或奇偶位是不够的。原生 SessionKey 模块必须在配置写入前调用该 helper，并在清单中显式声明其原生合约方法权限。该 helper 不写存储、不发通知、不授予模块权限、不发起外部回调。

原生会话的最后使用时间在同一权威纪元命名空间下以策略前缀 `0x06` 单独存储，采用规范 NeoVM Integer 字节编码的无符号 64 位值，并与会话配置一起原子地初始化为零。负数、溢出或冗余编码的值必须被拒绝。前缀 `0x02` 保留三字段元数据记录 `[CreatedAt, 0, Description]`；公开元数据 getter 必须重新读取 `0x06` 并投影出原有的 `[CreatedAt, LastUsedAt, Description]` 形状。执行后只更新 `0x06`，不重写描述。`0x06` 缺失或格式错误必须失败关闭，不得使用旧式回退。会话撤销会移除前缀 `0x01`、`0x02`、`0x03`、`0x05` 与 `0x06`，同时保留 `0x04` 轮换时间戳；账户清理则移除全部六个前缀。

原生 NeoNativeVerifier 配置档保留其两字段 `getConfig` 记录。它在同一权威纪元命名空间下以策略前缀 `0x03` 按签名方顺序把已配置的签名方域拼接为 32 字节值存储。`setConfig` 必须派生并原子替换该条目以匹配签名方配置；账户清理必须删除它。发现流程必须重新读取该条目，并拒绝缺失、为空、未对齐或超限的值，不使用旧式回退。该存储支持既有的最多十个已配置见证签名方；原生组合仍独立执行至多三个聚合签名方域的上限。它存储的是确定性身份，而不是见证或签名批准。

对于原生 MultiSig 配置档，策略承诺恰为 `SHA256(NeoBinarySerialize([Integer threshold, Array orderedChildren, Array orderedChildSignerDomains]))`。每个子级身份是 20 字节 ByteString；每个子级域条目是若干精确 32 字节 ByteString 按发现顺序构成的 Array。校验按配置顺序选择前 `threshold` 个合法子级，并只把该选择传给执行后回调。根在子级后置回调前后各检查一次新鲜策略承诺。它绝不以持久批准缓存替代密码学校验。

已安装的钩子必须恰好暴露：

```text
preExecute(accountId: Hash160, op: Array) -> Void
postExecute(accountId: Hash160, op: Array, result: Any) -> Void
```

每个已安装的验证器与钩子还必须暴露该 safe 发现方法：

```text
supportsComposition() -> Boolean
```

每个已安装的验证器与钩子还必须暴露该非 safe 维护方法：

```text
clearAccount(accountId: Hash160) -> Void
```

根与子级都必须具备这套完整的生命周期 ABI。清理仅在已认证的 `cleanup` 上下文与固定维护预算下运行；仅有 ABI 准入并不能保证任意插件存储被完整移除。

叶子模块必须返回 `false`。组合模块必须返回 `true`，且不得作为另一组合的子级安装。当前 ABI 2 构建把 `MultiSigVerifier` 实现为其唯一原生组合配置档。`MultiHook` 是普通合约组合模块，仍是未来的原生配置档候选；其普通标记或旧工件不得作为原生模块准入。新增原生 `MultiHook` 需要单独的原生项目、描述符条目、打包后的 ABI 2 身份、权威/纪元实现以及私有链符合性证据。任意递归组合不属于本配置档。

绑定组合时，`SmartAccount` 必须把每个子级当作已部署模块校验其具备上述精确生命周期 ABI、要求 `supportsComposition()` 返回 `false`、拒绝零值、重复与自身身份，并执行固定的验证器组合上限以及至多 8 个钩子子级的上限。签名方域发现仅适用于验证器子级：每个子级都必须返回非空的 `getSignerDomains` 结果，子级内部及子级之间不得出现重复承诺。钩子子级不实现签名方域发现。`MultiSigVerifier` 必须把其已配置策略与已批准子级选择绑定到瞬态回执。其后置回调必须拒绝与当前已配置策略不匹配的策略承诺。原生核心必须把已校验的子级列表记录到核心自有、按账户作用域的依赖登记表中；组合不得拥有权威清理名单。

签名方域分离是配置不变量，而不是密码学独立性的证明。它防止协议定义的验证器配置档复用同一个规范密钥或权威承诺。它不证明私钥之间不合作、不证明见证规则语义、不证明远程证明的正确性，也不证明一个就其已配置域撒谎的任意第三方验证器的行为。此类验证器需要独立审计，不得被当作与协议定义的密钥配置档等价。

在组合发布其子级名单之前，原生核心必须提供等价于以下的子级配置路径：

```text
callVerifierChild(accountId: Hash160, childVerifier: Hash160,
                  method: String, args: Array) -> Any
```

该路径必须仅对账户的托管权威可用，必须要求生效的根验证器声明组合能力，必须只接受已校验的叶子子级，必须使用模块维护回调预算，并且必须使用与根验证器配置相同的延迟调用语义。子级调用必须以子级的配置上下文执行，而不是根的上下文。当其根绑定或账户配置 nonce 改变时，待生效的子级调用必须失效。第 7 节中每一次配置 nonce 迁移都会连同其他 pending 意图一起清除这些待生效调用。本原生配置档不定义逃生、市场结算或账户移除入口点；普通合约的生命周期路径不得被推断为原生 ABI 方法。

在移除或替换组合绑定之前，原生核心必须在该子级已认证的 `cleanup` 上下文下，对每一个被移除或先前已登记的叶子子级调用 `clearAccount(accountId)`。在部分替换中，被保留的子级保持已配置状态。任何子级致命失败都必须中止整个操作，并回滚根绑定、依赖登记表与全部子级状态变更。最终移除必须在所有子级清理成功后清除根登记表。

对于替换，在旧根与子级的清理回调完成之后、提交新绑定之前，核心必须针对拟定绑定重新校验替换对象的当前代码身份、ABI、配置档元数据、封锁策略与只读组合发现。缺失、已变更、被封锁或新近不兼容的替换对象必须致命失败，并回滚整个迁移，包括清理写入与通知。在外部清理回调之前所做的校验对于这个提交边界是不够的。

验证器校验必须只读。钩子与验证器的执行后回调只能通过其常规应用权限写入。

原生合约必须拒绝缺失、被封锁、ABI 类型错误或不是已部署合约的模块。若模块当前代码身份与已存储绑定不同，原生合约必须拒绝该模块。在版本 2 中，原生合约（包括 `SmartAccount` 自身）不得被安装为验证器或钩子。

原生合约必须以 `ReadOnly` 调用 `validateSignature` 或 `validateCompositeSignature`，并以 `All` 调用验证器的 `postExecute` 或 `postExecuteComposite`、每个钩子回调以及目标方法。这些固定标志不是操作字段，调用方不能削弱或扩大。

模块代码身份为：

```text
codeHash = SHA256(
    nefBytes ||
    UInt8(0) ||
    CanonicalManifestJsonUtf8
)
```

`CanonicalManifestJsonUtf8` 必须是完整已部署清单（含 `extra`）的 RFC 8785 JSON 规范化方案（JCS）编码。对象名必须按无符号 UTF-16 码元递归排序；数组顺序必须保留。字符串必须使用严格 UTF-8 与 JCS 转义，不做 Unicode 归一化。有限 binary64 数值必须使用 RFC 8785 规定的 ECMAScript 数字序列化，包括把负零编码为 `0`。仅对键排序或使用平台默认 JSON 转义的序列化器是不够的。非法 Unicode、重复成员名、非有限数值以及超过 Neo JSON 现有 64 层限制的嵌套必须被拒绝。规范输出还必须满足 Neo 的清单字节大小限制。任何解析器都不得在绑定前修复或静默丢弃非法数据。

`nefBytes` 必须包含完整的已部署 NEF 序列化，包括其头部、方法 token 与校验和。零分隔符恰为一字节。所有字节数组与清单数组保持其定义顺序。哈希在使用前从当前已部署状态重算；缺失、被封锁或已变更的模块必须致命失败，而不是保留缓存准入。这些规则在哈希抗碰撞假设下钉住模块字节；它们不证明模块行为、签名方诚实性或密码学正确性。

参考：[RFC 8785, JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html)。

### 8.1 已认证的调用上下文

原生合约必须暴露该 safe 查询：

```text
hasModuleContext(accountId: Hash160, moduleType: String, module: Hash160,
                 phase: String) -> Boolean
isAccountAuthorized(accountId: Hash160) -> Boolean
```

`moduleType` 恰为 `"verifier"` 或 `"hook"`。`phase` 恰为 `"validation"`、`"preExecute"`、`"postExecute"`、`"configuration"` 或 `"cleanup"`。验证器没有 preExecute 阶段；钩子没有 validation 阶段。可变回调阶段仅在 Application 期间可用。Validation 上下文在 Verification 或 Application 中的验证器回调期间均可用。未知的阶段/类型字符串或不存在匹配上下文时返回 false。

`hasModuleContext` 必须认证实际的查询模块、账户、角色、阶段与当前调用；仅提供一个允许的模块哈希是不够的。SmartAccount 原生合约只把它调度的那个具体回调授予直接上下文。初始化与内部 VM 调用共享该授权，但对同一脚本哈希的新跨合约调用不共享。仅针对 validation、preExecute 与 postExecute，组合可以把当前阶段委派给由该根调用直接调用、已校验且已登记的叶子。组合验证器的 postExecute 授权还必须限定于回执中的已批准子级。孙级、未登记子级、中间层或 LoadScript 上下文不得继承该授权。配置与清理始终为每个受影响的模块单独授予直接上下文；它们不会一次性授权所有子级。

`isAccountAuthorized` 仅在实际调用方是该账户当前已授权的目标调用时为 true。在模块回调期间以及对任意目标后代调用时为 false。它不是见证的替代物；第 5.4 节定义了应用见证求值中的额外执行要求。

每个变更型账户入口点与操作批处理都必须在任何外部回调之前持有同账户锁。重入的变更或执行必须致命失败。只读上下文查询不获取该锁。跨账户调用可以在各自的授权范围内嵌套；内层调用不得消耗或替换被挂起的外层调用的授权。上下文是瞬态的、按阶段分离的，并在正常返回与 VM FAULT 时移除，包括原生延续已执行但其子级 RET 尚未计费之后发生的故障。

### 8.2 按账户作用域的延迟模块配置

版本 2 暴露下列 Application 方法：

```text
callVerifier(accountId: Hash160, method: String, args: Array) -> Any
callHook(accountId: Hash160, method: String, args: Array) -> Any
callVerifierChild(accountId: Hash160, childVerifier: Hash160,
                  method: String, args: Array) -> Any
callHookChild(accountId: Hash160, childHook: Hash160,
              method: String, args: Array) -> Any
cancelModuleCall(accountId: Hash160, moduleType: String) -> Void
```

四个调用路径都要求当前托管见证、Active 账户、无待生效的托管恢复、可用的配置 nonce 以及同账户锁。`moduleType` 恰为 `"verifier"` 或 `"hook"`。子级路径还要求该角色生效的根是受支持的组合，且其目标是不同于该根且已准入的叶子。

调用路径是两步操作，而不是即时转调 API。当该角色没有待生效调用时，它记录完整不可变的调用意图并返回 Boolean `false`，不调用任何可变模块方法。在其模块变更成熟时间点或之后重复完全相同的调用会执行它。未成熟或非完全相同的重复必须致命失败，既不替换意图也不重启其延迟。取消要求托管方见证且存在意图；在 Frozen 或恢复期间仍可用，且不推进配置 nonce。取消后的新意图会重新开始完整延迟。

每个账户与角色的待生效调用只有一条。意图绑定账户、角色、生效根身份与代码哈希、选定模块身份与代码哈希、方法字节、完整规范参数字节、提议时间、成熟时间与当前配置 nonce。成功的可变回调推进配置 nonce 并清除所有账户意图。其常规结果（包括 Boolean `false` 或 Null）原样返回。`getPendingModuleCall` 用于区分已记录的提议与返回 false 的已完成回调：

```text
getPendingModuleCall(accountId: Hash160, moduleType: String) -> Any
```

该 safe 查询返回 pending 记录或 Null；未知账户会致命失败。调用方只提供方法相关的参数。核心必须把权威的 `accountId` 作为第零个参数前置。它不得接受 `args` 中提供的账户标识符作为替代。参数具有与 UserOperation 参数完全相同的 VM 类型、深度与序列化边界，最多供给 63 个值，使被调用方法最多有 64 个参数。方法名具有相同的 UTF-8 长度边界，且不得以 `_` 开头。

可配置模块必须在 `extra.smartAccount.configurationMethods` 声明一组唯一方法名。清单缺失该列表即不授予任何通用配置能力。选定的已部署 ABI 方法必须被列入该列表、必须为非 safe、其参数个数必须恰比供给参数个数多一个，且第一个参数为 `Hash160`。生命周期方法 `validateSignature`、`validateCompositeSignature`、`postExecuteComposite`、`validateSignatureForPostExecute`、`preExecute`、`postExecute`、`clearAccount`、`supportsComposition` 与 `getSignerDomains` 不得出现在该列表中。元数据是被钉住代码身份的一部分。它是能力声明，而不是任意插件会把自身写入限定于该账户的证明。

确认时，核心在只授予选定模块的 `configuration` 上下文之前，重新检查成熟时间、全部绑定字节、代码身份、封锁策略、ABI 与权威。它传入 `All` 与固定维护预算。任何失败都会回滚待生效调用的消耗、配置 nonce、登记表、通知与全部模块写入。即使组合还没有把某个子级发布为活动，子级配置也会登记到核心的清理名单中。在回调之后、提交配置之前，核心必须针对原始身份、代码哈希、ABI 与封锁策略重新校验选定模块与绑定根。若回调破坏了、改变了或封锁了任一方绑定，必须致命失败并回滚其全部影响；仅检查选定子级是不够的。若账户已处于活动状态，核心必须在其配置后重新校验完整的生效验证器签名方域分离；相互冲突的变更会致命失败。

待生效调用存储必须使用精确的 Array：`[1, accountId, role, rootBinding, selectedBinding, methodBytes, invokedArguments, proposedAt, matureAt, configurationNonce]`。`role` 为 Integer `0`（验证器）或 `1`（钩子）；version、role、configurationNonce 与时间戳必须是精确 Integer，而不是 Boolean 或 ByteString 强制转换。时间戳与 configurationNonce 使用 UInt64 边界与固定模块变更延迟。`methodBytes` 必须是严格 UTF-8 ByteString；`invokedArguments` 必须包含前置的 accountId 并满足规范参数规则。查询与确认必须拒绝格式错误、根已过期或配置 nonce 已过期的记录。托管方取消可以删除格式错误的意图而不执行它。

### 8.3 权威组合登记表

原生合约暴露下列 Application 方法：

```text
setVerifierDependencies(accountId: Hash160, children: Array) -> Void
setHookDependencies(accountId: Hash160, children: Array) -> Void
clearVerifierDependencies(accountId: Hash160) -> Void
clearHookDependencies(accountId: Hash160) -> Void
```

设置方法认证实际生效根当前的 `configuration` 调用。它不得接受托管签名、仅哈希相等、其他账户的上下文、子级、同一根的新调用或目标授权作为替代。这些是已加锁迁移的内部回调延续，而不是独立授权的账户变更。清理上下文只能通过对应的 clear 方法确认已清空的登记表；它不得发布新的名单。

核心为每个账户与角色分别保存：

1. 被钉住的根绑定；
2. 所有已登记叶子绑定的有序清理名单，包括已配置但尚未发布为活动的叶子；
3. 有序的生效子级哈希列表。

两个名单都受固定验证器子级上限或 8 个钩子叶子上限约束。每个身份非零、不同于根与所有其他条目、非原生、已部署、未被封锁，并钉住其当前代码。活动列表是清理名单的子集。发布前要检查叶子准入，验证器子级还需检查非空且互不相交的签名方域。数组顺序对协议可见；不得用哈希序或字典序替代。

部分替换时，先在该叶子单独的 `cleanup` 授权下清理每一个被移除的活动叶子，再把它从清理名单中移除。被保留的活动叶子与已登记但未生效的叶子保持其状态。发布空的生效列表会清理先前的活动叶子；最终移除根时还会额外清理每一个已登记但未生效的叶子。随后核心在调用旧根的清理之前清空登记表。根或叶子的致命失败会回滚整次更新。冻结保留已安装的根与登记表。恢复按第 7 节所述撤销两个根并删除登记表，不调用外部清理回调；旧模块状态在其原权威纪元下保持不可达。

登记表查询是 safe 的，对未知账户会致命失败：

```text
getModuleDependencies(accountId: Hash160, moduleType: String) -> Array
```

它返回 `[rootBindingOrNull, cleanupBindings, activeChildHashes]`。每个绑定为 `[Hash160 bytes, codeHash bytes]`。空角色返回 `[Null, [], []]`。登记表属于原生核心，绝不属于插件提供的存储。组合声明的配置档名称并不确立其诚实行为。本仓库目前只构建并打包 `MultiSigVerifier` 作为受支持的原生组合。该构建描述符不是工件哈希的共识白名单。核心会单独检查受支持的组合接口、精确配置档元数据、代码身份与运行时发现规则。另一个满足这些规则的原生实现仍需自身的行为与资源评审；仅凭准入并不使其成为本仓库受支持的工件。普通 `MultiHook` 工件缺少该原生 ABI/配置档，因此仍不兼容。任意模块行为仍是信任边界。

原生 MultiSig 模块配置档使用核心自有的瞬态回执完成执行后批准选择。历史叶子方法 `validateSignatureForPostExecute` 若为兼容而保留，则本组合路径不使用它，且不得把它作为配置能力暴露。普通 `validateSignature` 仍限于 validation 授权。回执处理不产生新的权威阶段。后代调用仍共享根回调的固定预算。模块策略承诺规则定义于 `SMARTACCOUNT-NATIVE-MULTISIG.md`。

组合维护回调内部由登记表延续所执行的发现与清理，继承该回调的剩余预算与固定标志；它们不得在其下再分配一份等额维护预算。直接发起的维护根仍获得完整的固定回调上限，并受第 10 节的交易与祖先准入检查约束。

待生效调用记录与依赖记录不改变十四字段账户记录。实现必须在序列化与回滚之间保持这些逻辑记录；任何客户端都不得从存储键推断授权。

## 9. UserOperation 授权与执行

原生合约实现基础提案精确的六字段 UserOperation：

```text
[targetContract, method, args, nonce, deadline, signature]
```

它必须在调用任何外部模块之前校验形态、边界、规范参数类型与数值范围。受支持的参数值为 `Null`、`Boolean`、`Integer`、`ByteString`、`Array` 与 `Struct`。本配置档拒绝 `Map` 与 `InteropInterface` 值。嵌套数组与结构体的最大深度为八。

操作及其顶层 `args` 必须是精确的 Array 类型，而不是 Struct。目标、方法与签名必须是精确的 ByteString 类型；Buffer 不是替代编码。目标非零且为 20 字节，方法为 1 到 128 字节的严格 UTF-8，签名至多 1024 字节。顶层参数 Array 不计作嵌套层级；每个嵌套 Array 或 Struct 计一层。完整参数 Array（含其类型与长度头部）序列化后必须至多 4096 字节，且顶层值至多 64 个。对复合值的重复引用（包括环）必须被拒绝，与 Neo 的规范二进制序列化器一致。相互独立、取值相等的复合参数仍然允许。

两个数值字段必须是精确的 Integer 类型并满足：

```text
0 <= nonce < 2^255
0 <= deadline < 2^255
```

NeoVM 使用有符号 256 位 Integer。自 `2^255` 到 `2^256 - 1` 的值需要 33 字节有符号表示，无法使用本 ABI。节点或客户端不得把 ByteString 或 Boolean 强制转换为这些字段、截断越界值，或把负 Integer 重新解释为无符号。这修正了早期草案无法表示的无符号 256 位范围，而不改变任何可表示的操作与已发布的签名向量。

Nonce 处理是精确的：

```text
channel  = nonce >> 64
sequence = nonce & (2^64 - 1)
```

只接受存储的下一个序号。序号 `2^64 - 1` 可被消耗，此后该通道游标变为显式耗尽哨兵 `2^64`。游标为 `2^64` 的通道永久耗尽，不得回绕，也不得再接受任何操作。

执行顺序为：

1. 要求 Application 触发并建立同账户执行锁；
2. 校验操作与账户状态，拒绝被冻结的账户；
3. 拒绝已过期的截止时间或错误的下一序号；
4. 校验已安装模块的代码身份与 ABI；
5. 校验授权；
6. 消耗 nonce；
7. 调用钩子 `preExecute`；
8. 以完全相同的方法与参数调用目标；
9. 调用钩子 `postExecute`，随后对已准入的组合调用验证器 `postExecuteComposite`，对标量验证器调用 `postExecute`；
10. 发出 `UserOpExecuted` 并清除临时状态。

`executeUserOps` 必须校验 `ops` 非空、至多包含 32 个操作，且只包含供给的 `accountId` 的操作。同账户执行锁在整个批处理期间保持持有。所有操作按数组顺序在一个应用状态边界内执行。任何操作失败都必须回滚该批产生的每一个 nonce 递增、目标写入、回调写入、冻结迁移与通知。

不含简写时，生效的规范顺序为：

```text
lock
validate
deadline-and-nonce-check
validateSignature, validateCompositeSignature, or native-witness fallback
consume-nonce
hook.preExecute
target call
hook.postExecute
verifier.postExecute or verifier.postExecuteComposite(owned receipt)
UserOpExecuted
unlock
```

账户不得接受调用方提供的验证器或钩子身份。同账户重入执行必须在任何外部模块运行之前致命失败。目标的 Boolean `false` 是常规结果；核心不会把它转换为 VM 故障。

任何校验失败、模块失败、目标 VM 故障、资源耗尽或后置回调失败都必须回滚 nonce、目标状态、模块状态、冻结状态与通知。交易费用不退还。

### 9.1 原生见证回退

当 `verifier` 为零时，授权使用已存储的托管见证。操作的签名字段必须是空字节串。原生合约必须调用 `CheckWitnessInternal(custodyAddress)`，且不得接受供给的签名方列表作为证明。

该回退为调用该 UserOperation 的交易授权。它不创建中继签名格式，也不取代基于验证器的授权。

### 9.2 授权域

验证器配置档必须把其授权摘要绑定到：

```text
ASCII("NeoSmartAccount/UserOperation") ||
UInt8(2) ||
UInt32LE(networkMagic) ||
coreHash.ToArray() ||
accountId.ToArray() ||
UInt64LE(authorityEpoch) ||
UInt64LE(configurationNonce) ||
canonicalOperationWithoutSignature
```

`canonicalOperationWithoutSignature` 是规范的六字段操作，其中第五个字段被替换为空 `ByteString`。摘要是完整字节序列的 `SHA256`。原生核心必须通过只读方法暴露该域与操作摘要，使独立的验证器配置档不必从展示字符串重建网络或核心身份。

`getAuthorizationDomain(accountId)` 读取已登记账户，并按该公式返回到 `configurationNonce` 为止的字节。它是 safe 的 `ReadStates` 方法。`getOperationDigest(accountId, op)` 返回由该域后接规范操作字节构成的单一 SHA-256 摘要。未知账户会致命失败。为任一旧计数器值产生的签名不得授权当前状态。身份派生仍为版本 1；改变授权域不得改变 accountId、验证脚本字节或资产地址。

### 9.3 链上时间与截止时间边界

时间值取自确定性链上下文的整数毫秒，绝不取自钱包、中继或节点的墙上时钟。当执行具有持久化区块时，SmartAccount 原生合约使用该区块的时间戳。否则它使用执行快照中由 `Ledger.CurrentHash` 标识的头部时间戳。缺失持久化头部必须致命失败；零值或本地时间都不是回退。

标准 Neo 见证验证路径不提供持久化区块，因此 Verification 使用快照的持久化头部时间。需要在该触发中取得时间的验证器必须读取同一持久化区块/头部；它不得假设仅 Application 可用的 `Runtime.Time` 服务一定可用。区块中的 Application 执行使用该区块时间戳，包括交易预检所用的显式假定区块。更早的 Verification 结果不得取代 Application 对截止时间或模块策略的检查。

当 `now > deadline` 时操作恰为过期；相等时可以接受。模块可以施加更严格且单独成文的策略。配置与恢复的成熟使用相同的 Application 时间：`now >= matureAt` 时允许执行，而托管方取消恢复则要求 `now < executeAt`。固定延迟以毫秒计，不是区块数。

例如，截止时间为 `1000` 的操作可以在持久化时间戳为 `1000` 时通过 Verification，却在时间戳为 `1001` 的区块中 Application 失败。失败的 Application 不消耗其 nonce，也不提交目标/模块状态；若交易被打包，常规交易费用仍然适用。客户端不得把成功的 Verification 或假定下一区块的重放解释为对 nonce、时间戳或打包的预留。它必须检查实际持久化的 Application 结果。

### 9.4 当前实现中的目标返回值

`executeUserOp` 的 `Any` 返回类型与回调参数 `result: Any` 并不意味着任意运行时对象都能通过本配置档返回。当前原生实现在执行后回调之前序列化目标结果，并为每个根回调及调用方反序列化一份独立副本。即使没有安装验证器或钩子也一样。ABI 为 `Void` 的目标产生 Null；Boolean `false` 仍是常规结果。

既有结果序列化器接受 Null、Boolean、Integer、ByteString、Buffer、Array、Struct 与 Map，并保留其 VM 类型。它拒绝 InteropInterface 值（包括迭代器与存储上下文）与 Pointer 值。它还拒绝把同一个 Array、Struct 或 Map 重复引用，即使图形没有环。内容相等的不同容器是允许的。Buffer 在此受支持，但它不是受支持的 UserOperation 参数类型。

结果快照以执行引擎的 `MaxItemSize` 作为序列化后总字节上限（含类型标签与长度前缀），以 `MaxStackSize` 作为序列化值个数上限。容器计作一个值；Map 的每个键与值分别计数。在当前参考运行时 Neo.VM `3.10.2-CI00384` 中，这两个默认值分别为 **131,070 字节**与 **2,048 个值**。它们是实现使用的现有 VM 限制，不是额外的固定配置档参数，也不保证处于任一限制处的值能装进外围执行与回调预算。参数侧的 4096 字节与深度 8 限制不会被用来替代结果侧限制。

不支持的结果、重复的容器引用或序列化限制失败，会在执行后回调之前使操作致命失败。常规应用回滚适用于目标写入、nonce 变更与通知；交易费用仍可收取。既有结果隔离测试覆盖了独立的嵌套 Array/Buffer 副本，以及对循环 Array 或 InteropInterface 结果的拒绝。这些实现细节解释了当前的返回值边界；本次澄清不改变任何 ABI、参数摘要、共识规则或普通合约实现。

## 10. 资源与费用计量

原生合约对每个外部验证器与钩子回调都必须使用平台的有界调用能力：

```text
System.Contract.CallWithGasLimit(
    target,
    method,
    flags,
    fixedProfileBudget,
    args
)
```

该平台能力由确切的 syscall 名称 `System.Contract.CallWithGasLimit` 与上文所示的确切参数顺序标识。它仅在单独配置的 `HF_SmartAccountV1` 激活边界之后可用。节点必须在该边界之前拒绝该 syscall，且不得把缺失 `HF_SmartAccountV1` 条目当作创世即激活。`gasLimit` 值是 datoshi 整数；它必须为正，并且在被调用方上下文创建之前同时装进外围交易预算与每一层生效的祖先有界调用预算。

该能力必须满足以下全部要求：

1. 回调及其后代中的每笔可计费开销都消耗生效的子级预算；
2. 普通嵌套调用继承全部祖先预算；
3. 嵌套的有界调用不能逃出祖先预算；
4. 费用白名单不能绕过预算；
5. 零值、负值与超出交易预算的上限被拒绝；
6. 耗尽时失败关闭，并回滚应用状态与通知；
7. 预算覆盖回调初始化、执行、嵌套调用与返回值处理。

同一能力必须用于每一个外部模块维护回调，包括生命周期清理（`clearAccount`）、配置档特有配置与组合标记发现。这些调用使用固定的模块维护预算 `250,000,000` datoshi。耗尽预算的维护回调必须致命失败，且必须使外围模块配置或清理迁移保持不变。托管恢复不调用这些回调。维护预算独立于验证器与钩子执行预算，不得由账户或模块提供。

当维护回调是组合根时，其为子级发现与子级清理发起的普通后代调用继承生效的根维护预算。因此根与其后代构成一棵有界维护调用树；协议不得要求每个后代在根之下再分配一份等额固定预算，因为那会使合法配置依赖于实现特有的派发开销。后代仍消耗根的剩余预算，且不能通过改用普通调用逃出预算。

对本配置档而言，“后代”包括普通合约调用、静态方法 token、合约的 `_initialize` 方法、`System.Runtime.LoadScript`，以及回调返回前到达的原生异步回调延续。每个后代保持生效的预算链。动态执行不会额外获取调用权限或已部署合约身份，该预算继承也不改变既有的交易费用白名单语义。从后代返回不会退还未消耗的预算。

验证器预算为每个回调 `100,000,000` datoshi。该回调从 Verification 触发可达，因此配置档取值必须保持小于或等于 Neo 的 `MaxVerificationGas` 上限 `150,000,000` datoshi。钩子预算为每个回调 `250,000,000` datoshi，仅适用于 Application 触发的钩子路径。目标调用使用外围交易预算，不会被静默分配验证器预算。

Neo 常规费用收取仍然适用。费用白名单可以改变交易费用收取，但不得改变安全预算。ABI 2 没有原生 paymaster 或自动报销路径。外部交易费用支付方可以支付常规 Neo 费用，但已登记账户代理不得是交易发送方。支付方为完整交易及其费用签名；UserOperation 授权并不授权用代理 GAS 支付任意交易费用。这不放宽精确操作信封或目标帧见证权限。

Application 费用估算必须区分已消耗 gas 与准入每个固定有界回调所需的最小交易预算。后者包括已消耗 gas 的峰值加上下一个回调的固定预算，并按运行时的确切费用单位与上限换算。RPC 模拟结果必须把该值暴露为 `minimumrequiredfee`；客户端在签名前必须至少使用 `max(gasconsumed, minimumrequiredfee)`，并应用显式的系统费/网络费/总额上限。缺少必需字段并不证明仅按已消耗量估算就安全。通用代理见证估算必须考虑确切的验证脚本字节、见证布局、已消耗验证成本以及在 MaxVerificationGas 内的有界回调准入要求。该取值是所观测模拟轨迹的下界，而不是模块全部可能轨迹的界。费用字段、GasLeft 与链状态变化可能改变行为；客户端必须以最终签名的交易及其最终费用字段重放。模拟不保证状态变化后或最终签名见证验证后的准入，且已准入但致命失败的交易仍按 Neo 常规规则向其外部支付方收费。

## 11. 治理与升级

原生合约没有运行时管理员。其代码、ABI、原生哈希与硬分叉激活由共识治理。既有委员会策略机制可以按通用 Neo 协议封锁合约，但不存在针对账户托管、恢复或模块绑定的 SmartAccount 专属委员会绕过路径。

ABI 或状态布局变更需要：

1. 新的配置档版本；
2. 新的激活边界；
3. 确定性迁移例程；
4. 覆盖激活前后行为的跨客户端向量；
5. 针对既有地址与资产的显式兼容规则。

不存在绕过上述权威与延迟规则而改变托管、验证器、钩子或账户地址的应急方法。

## 12. 迁移与兼容性

既有普通 SmartAccount 仍是普通已部署合约。不会为它们隐式创建原生账户，也不会有任何既有地址改变含义。

ABI 2 不定义旧版导入入口点、导入登记表、迁移事件或原生地址别名。登记账户不会记录旧版身份，也不授权移动旧版资产。原生地址与旧版地址不同；在发生显式授权转移之前，资产仍留在旧版地址。

可选的迁移适配器是本配置档之外单独规定的扩展。它可以组合既有登记调用与显式授权的转移，但不得声称具有原生导入身份。若此类扩展发布导入映射，其自身规范必须定义登记表与事件、要求旧版账户与新托管方双方的见证、绑定旧版核心、账户标识符与资产地址、拒绝重复导入，并保持到新派生原生账户标识符的单向不可变映射。这些要求不增加 ABI 2 原生合约方法，也不确立已实现的适配器行为。既有旧版见证规则可能限制哪些组合是可能的；适配器需要单独实现与符合性证据。

ABI 1 到 ABI 2 是未激活草案的破坏性修订，不是已部署状态的自动升级。本文下的首次激活即从 ABI 2 开始。身份派生版本 1 保留了公式；它并不使旧账户记录、模块 ABI 或执行信封兼容。原生核心必须拒绝 ABI 1 的十三字段记录、ABI 1 模块以及旧式双参数执行调用。它不得静默追加纪元、推断初始计数器或导入更旧的状态命名空间。

本配置档不提供旧版原生状态转换例程。已包含先前实验性原生状态的网络不能把本草案当作其迁移方案：它需要第 11 节所要求的单独规定的激活、确定性状态转换与跨客户端向量。ABI 2 不提供反向映射、透明脚本替换或资产的隐式转移。

## 13. 必需的 ABI 面

版本 2 ABI 必须包含下列方法与事件。确切的 Neo ABI 参数类型是规范性的。

### 只读方法

```text
getPendingModuleCall(accountId: Hash160, moduleType: String) -> Any
getModuleDependencies(accountId: Hash160, moduleType: String) -> Array
getVersion() -> Integer
getAccount(accountId: Hash160) -> Any
getAccountAddress(accountId: Hash160) -> Hash160
getNonce(accountId: Hash160, channel: Integer) -> Integer
getAuthorityEpoch(accountId: Hash160) -> Integer
canonicalP256PublicKey(publicKey: ByteArray) -> ByteArray
getAuthorizationDomain(accountId: Hash160) -> ByteArray
getOperationDigest(accountId: Hash160, op: Array) -> ByteArray
verify(accountId: Hash160) -> Boolean
hasModuleContext(accountId: Hash160, moduleType: String, module: Hash160,
                 phase: String) -> Boolean
isAccountAuthorized(accountId: Hash160) -> Boolean
```

### Application 方法

```text
callVerifier(accountId: Hash160, method: String, args: Array) -> Any
callHook(accountId: Hash160, method: String, args: Array) -> Any
callHookChild(accountId: Hash160, childHook: Hash160,
              method: String, args: Array) -> Any
cancelModuleCall(accountId: Hash160, moduleType: String) -> Void
setVerifierDependencies(accountId: Hash160, children: Array) -> Void
setHookDependencies(accountId: Hash160, children: Array) -> Void
clearVerifierDependencies(accountId: Hash160) -> Void
clearHookDependencies(accountId: Hash160) -> Void
registerAccount(custodyAddress: Hash160, salt: ByteArray,
                verifier: Hash160, hook: Hash160,
                recoveryAddress: Hash160) -> Hash160
executeUserOp(accountId: Hash160, op: Array, expectedAuthorityEpoch: Integer, expectedConfigurationNonce: Integer) -> Any
executeUserOps(accountId: Hash160, ops: Array, expectedAuthorityEpoch: Integer, expectedConfigurationNonce: Integer) -> Array
callVerifierChild(accountId: Hash160, childVerifier: Hash160,
                  method: String, args: Array) -> Any
proposeVerifier(accountId: Hash160, verifier: Hash160) -> Void
activateVerifier(accountId: Hash160) -> Void
cancelVerifier(accountId: Hash160) -> Void
proposeHook(accountId: Hash160, hook: Hash160) -> Void
activateHook(accountId: Hash160) -> Void
cancelHook(accountId: Hash160) -> Void
proposeRecoveryAddress(accountId: Hash160, recovery: Hash160) -> Void
activateRecoveryAddress(accountId: Hash160) -> Void
cancelRecoveryAddress(accountId: Hash160) -> Void
proposeRecovery(accountId: Hash160, newCustody: Hash160) -> Void
executeRecovery(accountId: Hash160) -> Void
cancelRecovery(accountId: Hash160) -> Void
freeze(accountId: Hash160) -> Void
unfreeze(accountId: Hash160) -> Void
```

### 事件

```text
AccountCreated(accountId, accountAddress, custodyAddress, verifier, hook,
               recoveryAddress)
VerifierChangeProposed(accountId, verifier, activateAt, configurationNonce)
VerifierChanged(accountId, verifier, configurationNonce)
VerifierChangeCancelled(accountId, configurationNonce)
HookChangeProposed(accountId, hook, activateAt, configurationNonce)
HookChanged(accountId, hook, configurationNonce)
HookChangeCancelled(accountId, configurationNonce)
RecoveryAddressChangeProposed(accountId, recoveryAddress, activateAt,
                               configurationNonce)
RecoveryAddressChanged(accountId, recoveryAddress, configurationNonce)
RecoveryAddressChangeCancelled(accountId, configurationNonce)
RecoveryProposed(accountId, newCustodyAddress, executeAt, configurationNonce)
RecoveryCancelled(accountId, configurationNonce)
RecoveryExecuted(accountId, oldCustodyAddress, newCustodyAddress,
                 configurationNonce, authorityEpoch)
AccountFrozen(accountId)
AccountUnfrozen(accountId)
UserOpExecuted(accountId, targetContract, method, nonce)
ModuleCallPending(accountId, moduleType, module, method, matureAt,
                 configurationNonce)
ModuleCallSettled(accountId, moduleType, configurationNonce)
ModuleCallCancelled(accountId, moduleType, configurationNonce)
ModuleDependenciesChanged(accountId, moduleType, activeChildren,
                          configurationNonce)
```

事件字段顺序与类型必须发布在原生清单中，并且对 ABI 版本 2 保持稳定。

事件参数的规范类型与顺序为：

| 事件 | 参数 |
|---|---|
| `AccountCreated` | `Hash160, Hash160, Hash160, Hash160, Hash160, Hash160` |
| `VerifierChangeProposed` | `Hash160, Hash160, Integer, Integer` |
| `VerifierChanged` | `Hash160, Hash160, Integer` |
| `VerifierChangeCancelled` | `Hash160, Integer` |
| `HookChangeProposed` | `Hash160, Hash160, Integer, Integer` |
| `HookChanged` | `Hash160, Hash160, Integer` |
| `HookChangeCancelled` | `Hash160, Integer` |
| `RecoveryAddressChangeProposed` | `Hash160, Hash160, Integer, Integer` |
| `RecoveryAddressChanged` | `Hash160, Hash160, Integer` |
| `RecoveryAddressChangeCancelled` | `Hash160, Integer` |
| `RecoveryProposed` | `Hash160, Hash160, Integer, Integer` |
| `RecoveryCancelled` | `Hash160, Integer` |
| `RecoveryExecuted` | `Hash160, Hash160, Hash160, Integer, Integer` |
| `AccountFrozen` | `Hash160` |
| `AccountUnfrozen` | `Hash160` |
| `UserOpExecuted` | `Hash160, Hash160, String, Integer` |
| `ModuleCallPending` | `Hash160, String, Hash160, String, Integer, Integer` |
| `ModuleCallSettled` | `Hash160, String, Integer` |
| `ModuleCallCancelled` | `Hash160, String, Integer` |
| `ModuleDependenciesChanged` | `Hash160, String, Array, Integer` |

对 `getAccountAddress`、`getNonce`、`getOperationDigest`、`getAuthorizationDomain` 与 `getAuthorityEpoch` 的未知账户查询必须致命失败。`getVersion` 与 `canonicalP256PublicKey` 在激活后不需要账户记录。每一个格式错误的 ABI 值、非法权威、过期延迟迁移、缺失模块、被封锁模块、回调预算耗尽、目标故障以及错误的回调结果类型，都必须致命失败，并必须保持外层应用状态回滚规则。

### 费用（暂定）

当前每个原生 ABI 方法都声明相同的平铺基础 CPU 费用（在执行费系数之前为 32768 单位）。该平铺排期是暂定的：按方法差异化的费用模型仍是显式跟踪的未决事项（“openGate” 费用模型 TODO），且可以在主网激活前重新审视。费用值不在配置档参数摘要的覆盖范围内，因此修订排期不会使任何已发布向量、清单身份或模块准入失效；客户端必须从原生清单读取实际费用，而不是硬编码。

## 14. 符合性向量

实现必须为本节每个边界发布机器可读向量。下列身份向量是规范性的：

```text
networkMagic = 0x12345678
coreHash     = 398dc3f0227d7efac5533ed5ce9937390c158084
custody      = 202122232425262728292a2b2c2d2e2f30313233
salt         = 404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f

accountId    = 0x2168f4b52e13e1400a4cc93228f4c302d122b4b7
accountAddress = 0x09e1715bc1e2860a9b45dd44f6e394c228bb69d6
```

对应测试集还必须覆盖：

- 零值与重复标识符；
- 非法盐长度与托管值；
- 精确的验证脚本字节与脚本哈希；
- 每个版本 1 方案标签与规范材料的签名方域承诺；
- 严格 UTF-8 方法边界；
- 参数深度、类型、个数与序列化大小边界；
- nonce 序号零、最大值、耗尽与通道独立性；
- 截止时间等于当前时间与一毫秒过期的边界；
- 验证器与钩子 ABI 不匹配；
- 同一合约哈希下的模块代码替换；
- 回调预算耗尽、嵌套继承与费用白名单；
- 同账户重入与目标 Boolean `false`；
- 精确的回调帧、账户、角色与阶段隔离；
- 在生效目标调用之外拒绝 Global 作用域代理见证；
- 一层子级委派，以及拒绝同哈希重入与动态脚本；
- nonce、目标状态、回调状态与通知的回滚；
- 恢复延迟、过期配置 nonce、取消与冻结状态；
- 激活前拒绝与激活区块初始化；
- 拒绝 ABI 1 记录、模块与执行信封；无隐式旧版导入或资产托管。

单独规定的迁移适配器还必须额外发布并通过其自身的见证、重复导入、映射/事件与资产转移向量。这些扩展特有的用例不是对当前原生 ABI 的主张。

## 15. 评审与激活门禁

协议评审候选必须包含完整的规范状态模型、规范的身份/授权/nonce/见证向量、资源与失败语义、权威/治理/恢复规则，以及对 #218 与 #243 中基础提案的显式兼容性。提交评审的实现与测试必须标明其确切的源码与工件输入，并披露每一项未完成的符合性或上线要求。草案 PR 与私有链证据可以在网络激活获批之前接受评审；它们并不表示该批准已获通过。

公开激活还要求以下全部条件：

1. 激活标识符与显式网络配置经该网络协议治理流程接受；
2. 有界调用引擎能力已实现并通过独立测试；
3. 原生 ABI 与存储编码与本文逐字节一致；
4. 向量已由至少两个独立客户端校验；
5. NeoExpress 验证激活、执行、回滚与回读一致性，以及适用于该网络实际先前状态的每一条迁移路径；
6. 源码、原生清单/工件身份与已部署回读哈希一致；
7. 安全审计不存在未缓解的严重或高危发现。

无旧版原生状态的首次激活必须证明拒绝过时记录与入口点且不存在隐式导入。它不得以该证明替代在确有先前状态的网络上的迁移测试。任何可选适配器在使用前都需要各自经过评审的规范与证据。

在这些公开激活门禁通过之前，本文仍是一份设计配置档，不得被展示为已激活的 Neo 原生 SmartAccount 合约。

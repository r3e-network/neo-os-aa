# SmartAccount v4.1 协议规范（权威）

本文件是 Neo N3 SmartAccount **v4.1 的原生协议规范**，与机器可读的
[smartaccount-v4.1.idl.json](proposals/smartaccount-v4.1.idl.json) 一起构成唯一实现来源。
原生合约、模块、SDK、前端和测试凡与本文件或该 IDL 冲突，以两者为准；两者之间若出现表述差异，
以 IDL 的方法、事件和类型定义为准，并在本文件修订后再落地实现。

## 0. 权威来源与周边文档

- **唯一实现来源**：[smartaccount-v4.1.idl.json](proposals/smartaccount-v4.1.idl.json) 与本文。
- **派生阅读版，非独立权威**：[Neo-Smart-Account-Documentation-zh-CN.pdf](Neo-Smart-Account-Documentation-zh-CN.pdf)
  是由上述权威源（IDL 与本文件、模块协议）派生的完整中文阅读版，便于通读，不新增事实。
  它与 IDL 或本文件冲突时，以 IDL 与本文件为准。
- 模块侧条款见 [SA-MODULE-PROTOCOL.zh-CN.md](SA-MODULE-PROTOCOL.zh-CN.md) 与
  [SMARTACCOUNT-MODULE-NEPS.zh-CN.md](proposals/SMARTACCOUNT-MODULE-NEPS.zh-CN.md)；它们描述模块行为，
  不扩大原生 ABI。
- 只读门禁：`python scripts/check_smartaccount_v41_idl.py` 校验 IDL 与原生属性、manifest fixture 一致。

## 1. 范围与术语

v4.1 冻结一个**精确闭合的 26 方法原生 ABI** 和 **15 个事件**。每笔交易
只执行一个 UserOperation，没有批量执行入口。原生只做最小核心：
身份、稳定代理地址、custody 与状态、模块注册与代码绑定、nonce 与 epoch、规范编码与摘要、
单路由执行、目标帧 witness、不可重入、操作体积上限、原子回滚、冻结、凭证撤销和受限 reset。

以下概念**不属于**原生 ABI：消息签名域与名单、门限成员与 quorum、恢复 guardian/delay/流程、
治理延迟与意图、Hook 顺序。它们分别由 SigningModule、ThresholdPolicyModule、RecoveryModule、
GovernanceModule 和 HookOrchestratorModule 拥有。

## 2. 原生 ABI（26 方法）

方法名、参数顺序、返回类型、CallFlags、safe 标记与 CPU fee 均以
[IDL](proposals/smartaccount-v4.1.idl.json) 和 `tests/fixtures/native-smartaccount.manifest.json` 为准。
全部方法 CPU fee 为 `1 << 15`。禁止重命名、别名或新增入口。

### 2.1 账户

| 方法 | 参数 | 返回 | CallFlags | safe |
| --- | --- | --- | --- | --- |
| `createAccount` | accountId: Hash160, custody: Hash160, salt: ByteArray, actions: Array | Void | All | false |
| `createAccounts` | accountIds: Array, custody: Hash160, salts: Array | Void | All | false |
| `getAccount` | accountId: Hash160 | Array（9 字段描述符） | ReadStates | true |
| `getAccountAddress` | accountId: Hash160 | Hash160 | ReadStates | true |
| `freezeAccount` | accountId: Hash160 | Void | All | false |
| `unfreezeAccount` | accountId: Hash160 | Void | All | false |

`createAccount` 的 `accountId` 必须等于 `RIPEMD160(SHA256(0xAA524704 || custody || salt))` 的反转；
初始 actions 只允许安装默认模块（action code 1），在注册 custody witness 下原子执行。
`createAccounts` 一次登记 1..64 个 id/salt 对，不带初始 actions，全有或全无。
`getAccount` 对未知账户返回全零描述符（`exists = false`），不 FAULT。
`getAccountAddress` 返回固定代理脚本哈希，跨冻结、恢复和 reset 保持不变。

### 2.2 执行与验证

| 方法 | 参数 | 返回 | CallFlags | safe |
| --- | --- | --- | --- | --- |
| `executeUserOp` | accountId: Hash160, operation: Array | Any | All | false |
| `validateUserOp` | accountId: Hash160, operation: Array | Array（`[accepted, digest]`） | ReadStates | true |
| `validateMember` | accountId: Hash160, memberId: Integer, operationDigest: ByteArray, operation: Array | Boolean | ReadStates | true |
| `verify` | accountId: Hash160 | Boolean | ReadOnly | true |
| `getOperationDigest` | accountId: Hash160, operation: Array | ByteArray（32 字节） | ReadStates | true |
| `getNonce` | accountId: Hash160, validatorId: Integer, nonceSubkey: ByteArray | Integer | ReadStates | true |
| `getNonceSequence` | accountId: Hash160, channel: Integer | Integer | ReadStates | true |

- `executeUserOp` 校验并消费一个 nonce，运行 Hook 括号和单目标 dispatch，返回目标调用结果；
  目标 FAULT 使整次调用回滚。每笔交易恰好携带一个操作；32 个操作的批执行入口 `executeUserOps` 已移除。
- `validateUserOp` 只做预览：不消费 nonce、不写状态；结构性校验通过后，拒绝以 `accepted=false`
  报告，而不是 FAULT。
- `validateMember` 是 **active composite caller 的 leaf 验证窄承接**：只接受正在被验证的 composite
  实例、完全一致的 operation 字节与 digest、active 且 threshold-member-eligible 的非 composite leaf；
  它不保存也不解释 roster、weight 或 quorum。
- `verify` 是嵌入代理脚本的固定入口，只做准入检查（§2.5），不验签。
- `getNonce` 返回 `(channel << 64) | sequence`；`getNonceSequence` 返回显式 channel 的 64 位游标；
  耗尽哨兵为 `2^64`，读取时原样返回该值、绝不按 `(channel << 64) | sequence` 打包。

### 2.3 模块与配置

| 方法 | 参数 | 返回 | CallFlags | safe |
| --- | --- | --- | --- | --- |
| `installModule` | accountId: Hash160, moduleType: Integer, moduleContractHash: Hash160, initData: Array | Integer | All | false |
| `removeModule` | accountId: Hash160, moduleId: Integer, deInitData: Array | Void | All | false |
| `configureModule` | accountId: Hash160, moduleId: Integer, data: Array | Void | All | false |
| `setBuiltinAuthorization` | accountId: Hash160, defaultOperationAuthorization: Boolean, defaultMessageAuthorization: Boolean | Void | All | false |
| `applyConfigurationActions` | accountId: Hash160, actions: Array | Void | All | false |
| `revokeModuleCredentials` | accountId: Hash160, moduleId: Integer | Void | All | false |
| `resetAccount` | accountId: Hash160, newCustody: Hash160 | Void | All | false |
| `getModules` | accountId: Hash160, moduleType: String, cursor: Integer, limit: Integer | Array（`[ids, nextCursor, configurationNonce]`） | ReadStates | true |
| `getModule` | accountId: Hash160, moduleId: Integer | Array（15 字段描述符） | ReadStates | true |
| `isModuleInstalled` | accountId: Hash160, moduleType: String, moduleHash: Hash160, additionalContext: ByteArray | Boolean | ReadStates | true |
| `getAuthorizedModuleId` | accountId: Hash160, phase: Integer | Integer | ReadStates | true |

- `moduleType` 为 manifest 字符串 `validator`、`hook`、`recovery`；数值类型码为 1=validator、4=hook、5=recovery。
- `installModule` 分配永不复用的 `moduleId`，绑定代码身份与 profile 摘要，运行 `onInstall`，
  成功整批只推进一次 `configurationNonce`。
- `configureModule` 与 `applyConfigurationActions` 是**窄核心写入承接**：不保存治理意图、延迟窗口或冲突策略。
  Hook 顺序只能经治理后的 `configureModule` 改变。
  `installModule`、`removeModule`、`configureModule`、`setBuiltinAuthorization`、`applyConfigurationActions`
  与 `unfreezeAccount` 只接受 governance 调用方：直接调用方是该账户当前已安装、代码绑定且声明 `Governance` 的
  validator 实例。custody witness 直接调用这些入口被拒绝。
- `setBuiltinAuthorization` 的 operation 开关门控内置 custody 路由；message 开关仅保留记录布局兼容性，
  v4.1 没有原生消息入口，因此不授予消息权限。
- `revokeModuleCredentials`（custody witness 或 governance 调用方）与 `freezeAccount`（仅 custody witness）
  是即时应急通道，不回调、不延迟。
- `getAuthorizedModuleId` 合法 phase 为 1..9，未授权返回 -1；phase 7 保留且永不授予。
- `isModuleInstalled` 的 `additionalContext` 在 v4.1 接受但忽略。

### 2.4 协议信息

| 方法 | 参数 | 返回 | CallFlags | safe |
| --- | --- | --- | --- | --- |
| `getProtocolInfo` | — | Array（`[4]`） | None | true |
| `getAccountImplementationId` | — | String（`NativeSmartAccount`） | None | true |

### 2.5 交易结构、witness 与费用

- **交易结构**：账户地址的 verification script 固定，只调用 `verify(accountId)`。操作放在交易 script 里，
  作为恰好一次 `executeUserOp(accountId, operation)` 调用的参数。
- **`verify` 只做准入**：调用方是该账户的代理地址，且代理不是这笔交易的付款方；账户存在且为 `Active`；
  交易 script 通过 `ValidateEntryScript`（先比对固定尾部字节，再按字面量解码，解码前把字面量长度限制在
  operation 上限的两倍；原生不执行也不构造 script）；deadline、authorityEpoch、configurationNonce 与
  nonce 可用性（§6）。`verify` 不验签，也不回调模块，因为 Neo 对单个 witness 的计费上限是 1.5 GAS。
- **Application trigger**：只有代理在自身目标 dispatch 内被直接调用的帧通过 witness 检查。目标调用的嵌套帧
  不算目标，所以代理无法借一个自身调用 `NEO.transfer` 的目标合约转出 NEO 或 GAS，只有直接以原生合约为
  目标才行。
- **授权只发生一次，在 `executeUserOp` 内**：`validatorId = 0` 走内置签名（custody 的 P-256 公钥对
  §7 摘要验签），否则调用已安装 validator 实例的 `validateUserOp`。签名无效的交易能通过 witness 检查，
  但在执行时 FAULT：状态不变，手续费照付。中继方应先模拟。
- **费用**：没有逐调用 gas 预算、聚合上限、`System.Contract.CallWithGasLimit`（已移除）或 `MinimumRequiredFee`
  （已移除）。声明的 `SystemFee` 是唯一上限，Neo 全额燃烧；钱包按模拟消耗申报。实测成本见
  [SA-MODULE-PROTOCOL.zh-CN.md](SA-MODULE-PROTOCOL.zh-CN.md) §11。

## 3. 职责边界

| 责任 | 拥有者 |
| --- | --- |
| 账户身份、稳定代理地址、custody、状态、authority epoch、configurationNonce、control revision | 原生 |
| 模块注册、枚举、代码绑定元数据 | 原生 |
| nonce channel、namespace 冲突检测 | 原生 |
| canonical operation、摘要与 UserOp 签名域 | 原生 |
| 单路由验证/执行、目标帧 witness、不可重入、资源边界、原子回滚 | 原生 |
| 冻结、凭证撤销、受限 reset | 原生 |
| 消息签名域、subjects、quorum、`isValidSignature` | SigningModule（唯一公开消息入口） |
| guardian、delay、恢复流程 | RecoveryModule |
| 成员、权重、quorum、threshold policy | ThresholdPolicyModule |
| 治理延迟、执行窗口、冲突、action commitment | GovernanceModule |
| Hook 顺序、planner snapshot | HookOrchestratorModule |
| 资产余额与转账 | Neo N3 原生资产 / NEP-17 合约 |

`validateMember`、`configureModule`、`applyConfigurationActions` 是原生窄承接，
只承接验证或写入落地，不承接对应策略状态。

## 4. 账户生命周期与权限

- **即时**：普通 UserOp、`freezeAccount`、`revokeModuleCredentials`；`createAccount` 的初始安装原子执行。
- **必须经 GovernanceModule 24 小时延迟**：`installModule`、`removeModule`、`configureModule`、
  `setBuiltinAuthorization`、`applyConfigurationActions`、普通 `unfreezeAccount`。核心对这些入口只认 governance
  调用方，custody witness 不能直接调用。GovernanceModule 负责执行窗口（7 天）、
  最多 16 个 pending intent、冲突检测和 action commitment；原生不保存这些策略。
- **受限 reset**：`resetAccount` 只接受当前绑定、代码匹配且已由 RecoveryModule 成熟的调用。
  原生只检查绑定与落地，guardian quorum 和 delay 在 RecoveryModule 内检查。

## 5. Canonical operation

操作是 13 字段 `Array`（拒绝 Struct 容器）：

| # | 字段 | 类型 | 约束 |
| --- | --- | --- | --- |
| 0 | version | Integer | 必须为 4 |
| 1 | target | ByteArray | 20 字节且非零 |
| 2 | method | ByteArray | 1..128 字节严格 UTF-8 |
| 3 | args | Array | 最多 64 项，深度最多 8，序列化最多 4096 字节 |
| 4 | nonce | Integer | 非负，`channel[191] || sequence[64]` |
| 5 | nonceSubkey | ByteArray | 必须 32 字节 |
| 6 | deadline | Integer | 非负且小于 `2^255`，运行时毫秒 |
| 7 | validatorId | Integer | 非负；0 = 内置 custody 路由 |
| 8 | credentialGeneration | Integer | 至少 1 |
| 9 | authorityEpoch | Integer | UInt64 域 |
| 10 | configurationNonce | Integer | UInt64 域 |
| 11 | signature | ByteArray | 1..8192 字节，由 validator 定义 |
| 12 | hookProofs | Array | 0..8 个 `[hookId, proof]`，hookId 严格升序、不重复，proof 合计最多 4096 字节 |

canonical bytes 为 NeoVM binary stack-item 序列化，其中字段 11 以空 ByteString 代替。
operation 编码上限 16384 字节，等于 args 4096 + signature 8192 + hookProofs 4096 之和。它只是兜底，
对用户不产生额外费用；超出即 `SA_OPERATION_MALFORMED`。没有交易 envelope 上限。

## 6. Nonce

- channel 为 `SHA256(U1(4) || coreHash || accountId || U64BE(authorityEpoch) || U64BE(validatorId) ||
  U64BE(credentialGeneration) || nonceSubkey)` 的低 191 位；24 字节大端存储，`channel[0] = digest[8] & 0x7F`。
- 完整 256 位派生摘要存入 `0x5C`，用于截断碰撞的 fail-closed 检测；第二次派生命中已用 channel
  以 `SA_NONCE_CHANNEL_COLLISION` 拒绝。
- sequence 是 operation nonce 的低 64 位；查询打包为 `(channel << 64) | sequence`。
- 耗尽哨兵 `2^64`（原样返回，不打包）；channel 死亡且永不回绕。

## 7. 摘要与签名域

**UserOp 摘要**：

```
domain = UTF8("NeoSmartAccount/UserOperation") || U1(4) || U32LE(networkMagic)
       || coreHash[20] || accountId[20]
       || U64BE(validatorId) || U64BE(credentialGeneration)
       || U64BE(authorityEpoch) || U64BE(configurationNonce)
digest = SHA256(domain || canonicalUnsignedOperation)
```

`coreHash` 必须是实际执行的 native SmartAccount 哈希，绝不采用调用方声明值；地址使用原始
UInt160 字节，不做显示反转。

**Threshold member 摘要**由 ThresholdPolicyModule 通过 validator member digest 生成：

```
SHA256(UTF8("NeoSmartAccount/ThresholdMember") || U1(4) || operationDigest
     || U64BE(memberId) || U64BE(memberCredentialGeneration))
```

**消息域**完全由 SigningModule 拥有：原生不定义消息摘要、不暴露消息入口。
SigningModule 是唯一的公共消息签名入口。

## 8. 配置与 configurationNonce

活动 action code：

| code | 名称 | 形状 |
| --- | --- | --- |
| 1 | install | `[1, moduleType, moduleHash, profileDigest, initData]` |
| 2 | remove | `[2, moduleId, deInitData]` |
| 3 | configure（仅治理） | `[3, moduleId, data]` |
| 5 | setBuiltinAuthorization | `[5, defaultOperationAuthorization, defaultMessageAuthorization]` |
| 7 | setRequiredValidator（仅治理） | `[7, validatorId, required]` |

- `configurationNonce` 在每次成功的配置调用后**只推进一次**；1..16 个 action 的批次同样只推进一次。
- `configurationNonce` 写入 UserOp 摘要；用过期 nonce 签名的写操作以
  `SA_CONFIGURATION_NONCE_STALE` FAULT。它不是 operation nonce。
- 创建时的初始 actions 只允许 action code 1（安装默认模块），原子且即时；其余配置属于治理路径。

## 9. 回调阶段、代码绑定与 Hook 顺序

回调阶段（`getAuthorizedModuleId` 的 phase）：

| code | 阶段 | 说明 |
| --- | --- | --- |
| 0 | None | 无授权 |
| 1 | Validation | validator 验证 |
| 2 | HookPre | preCheck |
| 3 | TargetDispatch | 目标帧 |
| 4 | HookPost | postCheck |
| 5 | Completion | onUserOpComplete |
| 6 | Configuration | configure / onInstall / onUninstall |
| 7 | Cleanup | 保留，永不授予 |
| 8 | MemberValidation | composite leaf 验证 |
| 9 | HookPlanning | planner |

模块回调：`getModuleProfile`、`onInstall`、`onUninstall`、`configure`、`validateUserOp`、
`onUserOpComplete`、`preCheck`、`postCheck`、`isValidSignature`（SigningModule）、
`planHooks`（HookOrchestratorModule）。

**代码绑定**：`0x52` 记录 contractHash、contractId、updateCounter、NEF SHA-256、canonical profile
SHA-256、moduleRevision、credentialGeneration。绑定在安装时、每次模块回调前后以及提交前检查；
contractId 与 updateCounter 共同标识一个部署槽位与修订。任何漂移以
`SA_MODULE_CODE_BINDING_MISMATCH` FAULT；地址重部署不继承授权。

**Hook 顺序**：只由 HookOrchestratorModule 拥有，只能经治理后的 `configureModule` 修改，没有原生 setter。
`planHooks` 的返回被校验为已安装 hook id 的排列，冻结在 engine-local 调用状态中，
并在同一 operation 内**单次消费**；pre 按计划升序，post 按同一冻结集合逆序。

## 10. 存储布局与 schema

key = 1 字节 prefix || 原始 20 字节 accountId || 固定宽度大端整数后缀。

| prefix | 后缀 | 用途 |
| --- | --- | --- |
| `0x11` | proxyAddress | proxy -> accountId 反查 |
| `0x50` | — | protocol info |
| `0x51` | accountId | account control record |
| `0x52` | accountId \|\| moduleId[8 BE] | module instance record |
| `0x53` | accountId \|\| type[1] \|\| moduleId[8 BE] | installed-instance 枚举索引 |
| `0x56` | accountId \|\| channel[24 BE] | nonce cursor |
| `0x5C` | accountId \|\| channel[24 BE] | nonce namespace 完整摘要 |

保留 prefix：`0x54`、`0x55`、`0x57`..`0x5B`、`0x5D`..`0x5F`。

**AccountControl（0x51，canonical 11 字段）**：`[kind="SA:AC", version=1]` 之后为 status、custody、
authorityEpoch、configurationNonce、nextModuleId、defaultOperationAuthorization、
defaultMessageAuthorization、requiredValidatorId、controlRevision。注册值为
`[0, custody, 1, 0, 1, true, true, 0, 1]`。

**ModuleInstance（0x52，canonical 16 字段）**：`[kind="SA:MI", version=1]` 之后为 moduleType、
contractHash、contractId、updateCounter、nefSha256(32)、profileSha256(32)、moduleRevision、
credentialGeneration、instanceIsolation、messageCapability、thresholdMemberEligible、compositeLayer、
governance、hookPlanner。

两种记录都只有这一种带 kind 与 version 的形态：没有其他布局。
未知 schema version、kind 不匹配、字段数不符、非 canonical 编码和越域值全部 fail closed；
任何读取都不修复记录。

## 11. Hardfork 兼容

- 当前 gate：`HF_SmartAccountV1`，是原生合约唯一的激活硬分叉。没有单独的 v4.1 门控
  （`SmartAccountV41`、`HF_SmartAccountV41` 均已移除）：记录格式、governance 调用方规则和
  P-256 `VerifyHash` 路径都自 `HF_SmartAccountV1` 激活起生效，不存在门控前后两种写格式。
- 不设生产网络激活高度，需显式配置。
- 激活后状态格式不可降级；后续版本必须保持 schema、ABI、native hash 和代理地址兼容。
- 不变量：native id、native hash（`0x398dc3f0227d7efac5533ed5ce9937390c158084`）、
  accountId 推导、代理地址推导。

## 12. reset 后状态

`resetAccount` 成功后原子地：

- 移除全部模块实例（逐个发出 `ModuleInstanceRemoved`），删除全部 nonce cursor 与 namespace 行；
- 写入 `newCustody`（非零时），否则保持原 custody；
- 恢复 `Active`、operation/message 开关为 true、`requiredValidatorId` 为 0；
- authorityEpoch、configurationNonce、controlRevision 各推进一次；
- 保留 moduleId 分配器与代理地址；
- 发出 `AccountReset`。

reset 使所有旧 operation 签名、旧 credential generation、全部 nonce channel 失效；
模块私有残留记录因旧 instance identity 不可达，不由原生解释或遍历清理。

## 13. 错误与权限

IDL 的 `errors.native` 列出原生错误；`errors.moduleOnly` 只属于模块。代表性错误：

`SA_UNAUTHORIZED`、`SA_OPERATION_MALFORMED`、`SA_PROTOCOL_VERSION`、`SA_EPOCH_STALE`、
`SA_CONFIGURATION_NONCE_STALE`、`SA_NONCE_INVALID`、`SA_NONCE_EXHAUSTED`、
`SA_NONCE_CHANNEL_COLLISION`、`SA_DEADLINE_EXPIRED`、`SA_VALIDATION_REJECTED`、
`SA_MODULE_CODE_BINDING_MISMATCH`、`SA_MODULE_NOT_INSTALLED`、`SA_MODULE_TYPE_UNSUPPORTED`、
`SA_CREDENTIAL_STALE`、`SA_REENTRANCY_FORBIDDEN`、`SA_BUILTIN_ROUTE_REQUIRED`、
`SA_ACCOUNT_NOT_FOUND`、`SA_ACCOUNT_STATUS`。没有 gas 预算类错误（`SA_GAS_BUDGET_EXCEEDED` 已移除）。

权限依次来自：custody witness、代理帧 witness（仅 `executeUserOp` 内目标调用的直接帧）、
当前 phase 的 active module 授权、governance 调用方、RecoveryModule 的成熟 reset 调用。写方法 CallFlags 为 `All`，读方法为 `ReadStates`，
`verify` 为 `ReadOnly`，协议信息方法为 `None`。safe 标记只表示可安全预览，不表示授权或行为保证。

## 14. P256

签名为 64 字节 `r || s`（IEEE P1363），公钥为 33 字节压缩 P-256 点。Neo 3.10.1 的
`CryptoLib.verifyWithECDsa` 只有「先哈希再验签」的曲线变体（`secp256r1SHA256` 等），
**没有**可以直接校验已算好 32 字节 digest 的入口；`Crypto.VerifySignature` 同样会对入参再做一次哈希。

因此两条路径的写法固定如下，二者不可互换：

- **合约侧（模块/validator）**：`CryptoLib` 接收 **preimage**，平台在内部**恰好执行一次** SHA-256，
  这一次哈希即 §8 的消息 digest。把 digest 再传给 `CryptoLib.VerifyWithECDsa` 会造成二次哈希，
  从而拒绝所有有效签名（由固定反向向量锁定）。合约侧不得声称存在「预哈希 verify syscall」。
- **原生侧**：对 32 字节 digest 使用 `Crypto.CreateECDsa(key).VerifyHash(digest, signature)`
  （`VerifyHash`），不哈希第二次，并断言 digest 长度恰好 32。

## 15. 资产

资产余额与转账由 Neo N3 原生资产和 NEP-17 合约拥有。原生只提供稳定代理地址和受认证的通用
dispatch，不拥有任何 token ledger，也不在 dispatch 目标调用之外修改 NEP-17 余额。

## 16. 当前实现与 v4.1 目标差异

截至 2026-11-26，原生实现与 v4.1 目标没有已知差异。以下逐条说明实际状态。

1. 原生 ABI 已按 §2 闭合为 26 方法；没有批量执行入口，消息签名只经已安装 SigningModule 的公开入口。
2. SigningModule 的 `isValidSignature` 是公开 `[Safe]` 消息入口（六参数，`pairs` 为扁平的
   script/signature ByteString 序列，长度为偶数且不超过 2×MaxSubjects），只读状态、失败一律返回 false。
3. 模块安装/删除/配置、内建授权开关、`applyConfigurationActions` 与 `unfreezeAccount` 只接受 governance
   调用方（§4），custody witness 直接调用被拒绝。核心本身没有解冻延迟，延迟是治理模块的策略。
4. account 的初始 actions 只允许 code 1（安装）；2/3/5/7 是创建后的治理路径，在创建时被拒绝。
5. P256 两条路径已按 §14 分开：合约侧 `CryptoLib` 只收 preimage 并在内部恰好一次 SHA-256，
   原生侧对 32 字节 digest 用 `VerifyHash`；把 digest 再交给 `CryptoLib` 属二次哈希，已被反向向量拒绝。
6. `defaultMessageAuthorization` 目前只存在于记录布局中，原生没有读取它的入口。
7. 存储记录只有带 kind 与 version 的一种形态（§10）；ABI 与 manifest fixture 均为 26 方法，没有单独的 v4.1 硬分叉门控（§11）。
8. witness 检查只做准入，授权与费用规则见 §2.5；核心不设逐调用 gas 预算，也不使用嵌套执行引擎或操作码解释器。

## 17. 阅读指南（周边文档）

### 17.1 三类文本

| 类型 | 代表文件 | 它回答什么 | 不能当作什么 |
| --- | --- | --- | --- |
| 规范 / 约定 | 本文件、[IDL](proposals/smartaccount-v4.1.idl.json)、[SA-MODULE-PROTOCOL.zh-CN.md](SA-MODULE-PROTOCOL.zh-CN.md) | 字节布局、ABI、模块行为与接口约定 | 不是实现证明 |
| 精化与证明 | [engineering/VERIFICATION-AND-GATES.md](engineering/VERIFICATION-AND-GATES.md)（SA 形式化验证章）、[SA-NATIVE-OPEN-BOUNDARIES.json](SA-NATIVE-OPEN-BOUNDARIES.json) | 某段源码在多大范围被参考模型覆盖、哪些边界仍未覆盖 | 不是完整 NeoVM 精化或密码学证明 |
| 门禁与回执 | `engineering/VERIFICATION-AND-GATES.md`（SA 可复现构建章）、`docs/reports/sa-formal-gate-20261031.json`、`docs/reports/smartaccount-current-20261124/` | 哪些门禁在跑、复现构建钉住什么、各自依据哪份回执 | 不是公共网络部署证明 |

### 17.2 建议阅读顺序

想改合约或写集成：先读本文件的第 2 至 12 节，再读
[SA-MODULE-PROTOCOL.zh-CN.md](SA-MODULE-PROTOCOL.zh-CN.md) 与
[模块 NEP 接入说明](proposals/SMARTACCOUNT-MODULE-NEPS.zh-CN.md)，最后查 [SDK](SDK.zh-CN.md)
和 [原生 manifest fixture](../tests/fixtures/native-smartaccount.manifest.json)。

想判断当前的证据状态：`engineering/VERIFICATION-AND-GATES.md` 的 SA 形式化验证章 →
[SA-NATIVE-OPEN-BOUNDARIES.json](SA-NATIVE-OPEN-BOUNDARIES.json) → [ARCHITECTURE.zh-CN.md](ARCHITECTURE.zh-CN.md) 的原生系统架构章。

想复现构建：`engineering/VERIFICATION-AND-GATES.md` 的 SA 可复现构建章 →
`contracts/neo-platform-packages.json` 与各项目的 `packages.lock.json`。

### 17.3 三条前提

1. **回执只对它记录的东西有效。** `docs/reports/` 的 JSON 绑定当时的提交、工件与运行时，不是对当前工作树的陈述。
2. **证明只覆盖写明的作用域。** 每份证明都写明覆盖的字节、指令、方法与运行时；超出作用域的推断始终列为未覆盖，不因相邻入口已证而外推。
3. **开放边界是明确保留的。** `SA-NATIVE-OPEN-BOUNDARIES.json` 记录 `status: OPEN_BOUNDARIES_RETAINED` 与 `implementationVerified: false`：模型证明的是协议规则，不是编译后的合约字节。

### 17.4 术语速查

| 术语 | 含义 |
| --- | --- |
| 闭合作用域 / closure scope | 一份被登记、可被门禁编排的证明单元 |
| 内核检查 / kernel-checked | 结论由 Coq 内核接受，而非脚本运行通过 |
| 精化 / refinement | 证明实现与参考模型在指定范围内行为一致 |
| 失败关闭 / fail-closed | 无法确认时一律拒绝，而不是回退到宽松路径 |
| 作用域内通过 / scoped PASS | 仅在该回执记录的作用域内成立 |
| ratchet（棘轮） | 文档守卫中只允许收紧、不允许放宽的台账条目 |

## 18. 维护约定

新增或修改协议条款时，先改 [IDL](proposals/smartaccount-v4.1.idl.json)，再同步本文件、
模块协议与 `ARCHITECTURE.md`，最后运行 `python scripts/check_smartaccount_v41_idl.py`。
面向读者的章节提供中文对照并保持代码标识与路径一致；过程、验证、审计与交接层仅提供英文，
不得补一份会随门禁运行过期的译文。

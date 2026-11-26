# SmartAccount 模块协议

本协议尚未发布，只定义当前原生核心及其模块。[当前参数](proposals/smartaccount-native-profile-parameters.json)用于实现、打包和钱包校验；[实现清单](../contracts/native/profile.json)列出尚未闭合的事项。

唯一实现来源是 [v4.1 IDL](proposals/smartaccount-v4.1.idl.json) 与 [SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md)；本文描述该闭合 26 方法原生 ABI 下的模块行为。原生核心提供 `installModule`、`removeModule`、`configureModule`、`setBuiltinAuthorization`、`applyConfigurationActions`、`revokeModuleCredentials`、`resetAccount` 以及只读模块查询。托管方可即时执行普通 UserOp、冻结和撤销凭证。模块安装、卸载、配置、内置授权切换和普通解冻必须经 GovernanceModule 的 24 小时延迟成熟确认；核心不保存治理意图。消息签名由 SigningModule 验证，它是唯一公共消息入口；原生核心没有 `isValidSignature`。参见[标准模块目录](../contracts/modules/README.md)。协议未在公共网络激活。

配套文档：

- [核心协议 NEP](proposals/nep-smartaccount-entry-verifier.mediawiki)：账户身份、操作编码、权限与恢复。
- [模块 NEP 接入说明](proposals/SMARTACCOUNT-MODULE-NEPS.zh-CN.md)：查询每个模块对应的规范条款、接口格式和校验命令。
- [英文对应版本](SA-MODULE-PROTOCOL.md)。
- `tests/fixtures/sa-module-protocol/README.md` —— golden 向量/拒绝回归 fixture
  格式与 kernel 验证矩阵。
- `contracts/native/SmartAccount/SmartAccountModuleProtocol.cs` ——
  常量文件，承载本文全部数值（§15）。

## 1. 范围与术语

### 1.1 术语

验证器（validator）负责授权判断；钩子（hook）在执行前后检查策略。

模块类型（一字节类型码，ERC-7579 编号）：

| 类型 | 名称 | 是否支持 |
| --- | --- | --- |
| 1 | validator | 支持 |
| 2 | executor | 不支持，安装时拒绝 |
| 3 | fallback handler | 不支持 —— 同上 |
| 4 | hook | 支持 |
| 5 | recovery 恢复席位（原生扩展） | 支持；每账户最多一个 |

类型 2/3 不是 validator/hook 的别名。未实现却声明支持是被禁止的；profile 写
“不支持”，不写“可能”。

### 1.2 标准模块

可安装的模块及其职责见[模块目录](../contracts/modules/README.md)。

## 2. moduleId —— 实例命名空间

- `moduleId` 为**每账户持久、单调递增的 UInt64**。分配从 1 开始；**0 保留给内建授权**。
- 模块实例由 `(accountId, moduleId)` 唯一标识 —— 不由合约地址标识。
- 同一单调分配器也发放**阈值政策 id**（§4.2），因此账户内每个可路由 id 都来自同一
  无碰撞空间。
- **moduleId 永不复用。** 卸载后，旧实例的签名、pending 意图与插件数据不可能悄悄
  重新挂接到新实例。
- 模块记录另存：模块类型、合约哈希、代码绑定（§7.3）、模块修订与每实例
  `credentialGeneration`。
- **同一合约地址可在同一账户安装多个实例**，但仅当模块能力 profile 声明
  `instanceIsolation`（§12）。未声明时，该合约每账户每类型至多安装一个实例。

理由（设计报告 §3.1 钉扎）：基于地址的身份无法表达同一 SessionKeyValidator 的多
session；地址不得同时承担代码身份、实例身份与授权代际。

## 3. 集合上限与顺序语义

Profile 上限（协议级；除注明由标准模块负责的行外，均由原生核心强制，数值钉扎于 §15 常量文件）：

| 上限 | 数值 |
| --- | --- |
| 每账户 validator 实例（含阈值成员） | 32 |
| 每账户 hook 实例 | 8 |
| 每阈值政策成员 | 10 |
| 阈值取值 | 1–10 |
| composite 图深度 | 1 层（禁止嵌套、禁止环） |
| 每个治理配置提案或每个 `applyConfigurationActions` 组的动作数 | 16 |
| 每账户未结束的治理配置提案数（保存在治理模块自身存储） | 16 |
| 枚举分页 limit（`getModules`） | 1–32 |

这些是协议上限，**不是**性能保证：合法最坏组合（10 阈值成员、8 hook、最大 proof）
必须先对照声明的系统费（§11）测量，才能做任何发布声明；仅验证“超限被拒绝”不算验收。

**hook 顺序。** hook 顺序是 HookOrchestratorModule 的状态，不是原生记录；它只能经治理延迟后的 `configureModule` 回调修改，核心不保存顺序、也不暴露 setter。执行时核心调用账户唯一的 `hookPlanner` 实例（`planHooks`），把回复校验为已安装 hook id 的排列，冻结在 engine-local 调用状态中，并在该操作内单次消费：`preCheck` 按计划顺序执行，`postCheck` 对同一冻结集合逆序执行。执行期间重入的配置变更不会改变在途序列。签名绑定 hook proof 摘要（§5），签名者看到的 hook 集合与实际运行的集合不可能不一致。

**恢复是模块状态。** 恢复策略 setter、治理动作 8、恢复授权方、恢复延迟以及 begin/cancel/execute/status 都属于 RecoveryModule。原生核心不保存恢复策略、guardian 名单或时间锁，也不暴露恢复 setter。唯一的原生恢复落地是 `resetAccount`，它只接受账户当前已安装、代码绑定有效的恢复模块在自身记录成熟后的调用；核心只检查绑定与落地。`ownerOnlyRecovery` 是 0x51 记录中的保留字段，在当前协议中没有任何授权含义，客户端不得将其呈现为权限特性。

## 4. 操作 —— canonical 编码

### 4.1 线上形态

UserOperation 是**严格的 13 字段 NeoVM `Array`**（操作中任何位置出现
`Struct` 即拒绝）：

```
[0]  version              Integer   = 4 (ModuleProtocolVersion)
[1]  target               ByteString，20 字节，非零
[2]  method               ByteString，1–128 字节严格 UTF-8
[3]  args                  Array，≤64 项，深度 ≤8，序列化 ≤4096 字节；
                          元素仅 Null/Boolean/Integer/ByteString/Array
[4]  nonce                Integer ≥0 —— 191 位 channel ‖ 64 位 sequence
[5]  nonceSubkey          ByteString，恰好 32 字节
[6]  deadline              Integer ≥0 <2^255（Runtime.Time 毫秒）
[7]  validatorId           Integer ≥0 —— 0 = 内建；否则为账户的 moduleId
                          或阈值政策 policyId
[8]  credentialGeneration Integer ≥1 —— [7] 的每实例代数
[9]  authorityEpoch        Integer ≥0（UInt64 域）
[10] configurationNonce    Integer ≥0（UInt64 域）
[11] signature            ByteString，1–8192 字节，validator 自定义 DTO（§6）
[12] hookProofs            `[hookId:Integer, proof:ByteString]` 二元项数组，
                          0–8 项，hookId 唯一且严格升序，proof 总字节 ≤4096
```

操作级上限：单操作编码 ≤16384 字节，即 args 4096 + signature 8192 + hookProofs 4096 之和。
它只是兜底，对用户不产生额外费用；每笔交易恰好携带一个操作。多余字段、重复 hook proof、乱序 proof、非规范整数（负值或超出字段声明域）
一律拒绝。

### 4.2 canonical 序列化

未签名操作的 canonical 字节形态 = 同一 13 字段 Array 的 NeoVM 二进制
stack-item 序列化，其中 `[11] signature` 替换为**空 ByteString**。原生核心用
`Neo.VM.BinarySerializer.Serialize` 生成；golden 向量（§15 fixture 集）钉扎这些字节。

### 4.3 操作摘要与签名域

```
domain := UTF8("NeoSmartAccount/UserOperation")        // 29 字节
         || U1 (version = 4)
         || U32LE (network magic)
|| coreHash, 20 原始字节（*实际*执行的原生核心哈希）
         || accountId (20 原始 UInt160 字节)
         || U64BE (validatorId)
         || U64BE (credentialGeneration)
         || U64BE (authorityEpoch)
         || U64BE (configurationNonce)

digest := SHA256( domain || canonicalUnsignedOperation )
```

全部未签名操作字段（含 hookProofs 数组）都在 canonical 序列化内，故摘要覆盖它们。
整数域编码：`U1` 一字节；`U32LE` 4 字节小端（与既有原生域分隔符约定一致）；`U64BE`
8 字节大端。地址字节取 `UInt160.ToArray()` 的原始字节 —— 绝不用显示反序。

`version`、`validatorId`、`credentialGeneration` 同时出现在数组与域中；域副本是签名
绑定的权威，数组副本用于执行路由。

`credentialGeneration` **没有默认值**。§6.1 说明不同路由绑定哪个代次；客户端若自行
填写 1 或 2，就会派生出核心永不校验的签名域与通道，并且失败形态是“签名绑定到账户
不使用的命名空间”，而不是可重试的 nonce 不匹配。

## 5. 签名 DTO 结构

`signature` 字段是 validator 自定义 DTO（对核心不透明），上界 1–8192 字节。每种
validator 签名格式**必须**在其自身 DTO 内、或通过哈希上述核心摘要，至少绑定：

- 协议版本、网络、实际 core hash、accountId；
- `validatorId` 与 `credentialGeneration`（每实例）；
- `authorityEpoch` 与 `configurationNonce`；
- 全部未签名操作字段与 hookProofs 摘要。

覆盖的格式与 DTO 要点（validator 内部布局归其所有，但绑定要求可按本清单审计）：

| Validator | DTO 要点 |
| --- | --- |
| SessionKeyValidator | session 凭证 id、委托授权摘要、期限；绑定 generation（撤销 ⇒ 代数推进 ⇒ 旧签名失效） |
| MultiSigValidator（作为政策） | 成员标识 + 各成员签名列表；绑定 policyId 与成员代数；政策成员绝不可独立路由 |
| TeeKeyValidator | 96 字节：32 字节 key id（`SHA256(compressedPublicKey)`，须等于已配置密钥的 id）‖ 64 字节 P-256 `r‖s`，签的是成员/操作摘要；链上不验证远程证明 quote |
| Web3AuthValidator | EIP-712 风格 typed payload，见 `docs/SDK.zh-CN.md`（域名 `"Neo Smart Account"`），64 字节紧凑签名 |
| P256Validator | 裸 P-256 `r‖s`（64 字节），对实例配置密钥 |
| DelegatedIdentityValidator | 配置 P-256 signer 签名 + 身份承诺 |
| 内建（validatorId = 0） | 一份规范的 P-256 托管脚本及其对操作摘要的签名 |

阈值路由：`validatorId` 指向阈值政策时，核心在自身调度下逐个直接调用
成员 validator，批准收据保存在核心调用局部状态；`postCheck` 阶段仅对验证阶段
获准成员执行 completion。启用前必须安装标准恢复模块，配置恢复授权方。每个成员须使用协议指定的标准验证器和不同的压缩公钥。
启用后，核心记录唯一可支出的策略编号，关闭基础转账。收款照常，支出须达到签名门限。
托管人、验证器和治理模块都不能直接更换成员、重开基础转账或修改恢复设置。
启用时权限代次递增，之前提出的恢复请求随之失效。恢复基本账户须重新发起请求，经预设延时后由原恢复模块完成。

## 6. nonce channel 与命名空间派生

- channel := `SHA256( U1(4) || coreHash || accountId || U64BE(authorityEpoch) ||
  U64BE(validatorId) || U64BE(credentialGeneration) || nonceSubkey )` 的**低 191 位**。
- channel 是**派生的，不是自选的**。`nonce` 低 64 位是 sequence；必须等于存储
  游标（或耗尽哨兵）。
- 存储键中的 channel 字节为 24 字节，大端，`channel[0] = digest[8] & 0x7F`（只清最高 1 位，共 191 位）。
- 每 channel 持久保存**完整 256 位派生摘要**（0x5C）；若第二个不同派生映射到
  已使用的 191 位 channel，操作被拒绝（截断碰撞 fail-closed），绝不静默共享。
- sequence 耗尽（游标 == 2^64 哨兵）：channel 死亡；无回绕。
- 插件不维护必须与核心游标精确同步的私有 sequence 计数器；核心 nonce 是唯一
  sequence 源（SubscriptionValidator 只消费核心 nonce）。

`configurationNonce` **不是**操作 nonce：每次安全配置提交、凭证撤销、freeze/
unfreeze、恢复与 custody 变更都单调推进；操作消费与额度计数不推进它；清理、卸载不重置它。

### 6.1 各路由绑定的代次

`credentialGeneration` 不是全局计数器：它标识路由主体当前的凭证集合，由核心按路由
解析（绝不是调用方给的默认值；内置路由的代次也没有任何 ABI 方法对外发布）。

| 路由 | 绑定的代次 | 记录 |
| --- | --- | --- |
| 内置（`validatorId` = 0） | 操作固定为 1 | 账户控制记录中的 custody |
| 已安装验证器实例 | 该实例的 `CredentialGeneration` | 0x52 |

原生核心 共同成立的推论：

- 普通账户用代理地址收款，凭一份托管签名转账。基础操作的凭据代次固定为 1。
  托管人更换后，权限代次使旧签名失效。消息入口由 SigningModule 拥有，原生核心不授予消息权限。
- 已安装实例从代次 1 开始，只在 `revokeModuleCredentials` 时推进——那是管理族授权、
  无回调的即时撤销，一次废弃所有绑定旧代次的签名。重新绑定模块代码推进的是
  `moduleRevision`，不是凭据代次。
- 强制验证器就是一个已安装实例，绑定它自己的实例代次。重置会移除全部实例并推进权限代次。
  已分配的编号永不复用。
- 因为代次在 §4.3 的签名域内，过期值不是可重试的 nonce 不匹配。操作路由代次不符时以 `SA_CREDENTIAL_STALE` 故障。
  撤销同时推进配置 nonce，因此在撤销之前签名的操作通常会更早以
  `SA_CONFIGURATION_NONCE_STALE` 故障；只有携带当前 nonce 的操作才会走到凭据检查。
  消息路径由 SigningModule 拥有：其代次检查位于该模块的 `isValidSignature` 回调内部，不在原生入口，失败通道由模块定义。
- `getNonce` 在核心内部解析代次并返回核心会使用的通道。调用方可自行交叉校验，但以
  核心的答案为准。

## 7. 存储布局规划

### 7.1 共享 0x50–0x5F 区域（原生核心，键字节一致）

键构造：1 字节前缀 ‖ 原始 20 字节 accountId ‖ 注明处的定宽**大端**整数后缀。
0x50 是唯一的裸键。所有整数键后缀均为定长大端。

| 前缀 | 键后缀 | 用途 |
| --- | --- | --- |
| 0x50 | 裸键 | 协议信息 |
| 0x51 | +acctId | 账户控制元数据（§7.2） |
| 0x52 | +acctId+moduleId[8 BE] | 模块实例记录（14 字段：type[1]、contractHash、contractId、updateCounter、nefSha256、profileSha256、moduleRevision、credentialGeneration、instanceIsolation、messageCapability、thresholdMemberEligible、compositeLayer、governance、hookPlanner） |
| 0x53 | +acctId+type[1]+moduleId[8 BE] | 已安装实例枚举索引（marker 行；按类型升序 moduleId 扫描；类型为 validator 1、hook 4 或 recovery 5） |
| 0x56 | +acctId+channel[24 BE] | nonce 游标 |
| 0x5C | +acctId+channel[24 BE] | nonce 命名空间完整摘要（碰撞检测） |

区间内其余前缀 —— 0x54、0x55、0x57–0x5B 与 0x5D–0x5F —— 均保留不分配。
hook 顺序、消息名单与门限策略属于模块状态，保存在各自的存储中。配置提案同样不是核心状态：标准治理模块把它们保存在自己的存储前缀下。

区间之外，`0x11 ‖ proxyAddress → accountId` 索引每一个已注册账户。注册会拒绝作为账户代理
地址或核心自身的 custody 地址，也会拒绝已是 custody 地址的代理地址。

升级前必须在两网重新扫描 0x50–0x5F 区间；发现未知占用即中止升级 —— 绝不覆盖。

### 7.2 0x51 账户控制元数据

固定顺序的 9 字段数组：status（Active/Frozen）、custody、authorityEpoch、
configurationNonce；nextModuleId（moduleId 分配器）；默认操作授权开关与默认消息授权开关；
`requiredValidatorId`（强制路由；为 0 时任何验证器实例都可被路由）；controlRevision。
注册时写入 `Active, custody, 1, 0, 1, true, true, 0, 1`。恢复、门限、消息名单与 hook 顺序
不是控制字段：它们属于模块。

### 7.3 0x52 代码绑定（原生核心 定义一致）

contractHash、ContractId、UpdateCounter、SHA256(NEF bytes)、SHA256(canonical 模块
profile JSON)。ContractId 阻断销毁重部署；UpdateCounter 捕捉 manifest-only 更新；
NEF 哈希钉扎代码；profile 哈希钉扎接口能力。每次模块回调前后及提交前检查绑定；
同地址重部署不继承授权。逐回调检查只比较 `(ContractId, UpdateCounter)`：这对值唯一
对应一个（部署槽位、版本），与记录里安装时钉过的 NEF 哈希等价，但不必在每个回调里
重算 NEF 哈希。

## 8. 消息签名（SigningModule，ERC-1271 profile）

原生核心不定义消息入口。SigningModule 是唯一公共消息签名入口，拥有消息域、主体名单、阈值和 ERC-1271 回复。

API（模块）：`SigningModule.isValidSignature(accountId, originalSender, validatorId, credentialGeneration, hash, pairs)`。
- `hash` 是调用方提供的 32 字节消息摘要。
- 成功返回严格四字节 magic `0x1626ba7e`（ERC-1271 `MAGICVALUE`），失败返回另一个固定四字节值（`0xffffffff`）；成功通道绝不抛异常。
- 消息验证只读：不消费操作 nonce，也不能由交易 witness 满足（合约 custody 通过 `CheckWitness` 并不因此产生离线消息签名）。

模块绑定自己的消息摘要域，例如：

```
domain := UTF8("NeoSmartAccount/Message")
         || U1 (4)
         || U32LE (network)
         || coreHash, 20 原始字节
         || accountId (20 原始字节)
         || originalSender, 20 原始字节
         || U64BE (validatorId)
         || U64BE (credentialGeneration)
         || U64BE (authorityEpoch)
messageDigest := SHA256( domain || hash )
```

精确字节属于已部署 SigningModule 的 profile；原生 IDL 有意不发布消息域，也不发布消息方法。模块的主体名单、阈值和凭据代次都是它自己的状态。经 `resetAccount` 轮换 custody 会改变账户 epoch 并使旧消息签名失效，但不会改写模块名单。消息授权不授予转账权限。

### 8.1 消息签名主体

SigningModule 拥有主体集合：内置 custody 密钥可以是一个主体，但原生核心不保存主体名单。已安装该模块的账户从模块读取主体，绝不从原生查询读取。SessionKeyValidator 与 SubscriptionValidator 默认不声明任意消息能力。没有消息能力模块的账户没有公共消息入口。

## 9. 公共接口（原生核心 命名一致）

查询：`getProtocolInfo()`、`getAccountImplementationId()`、`getAccount(accountId)`
（返回 `[exists, status, custody, authorityEpoch, configurationNonce,
defaultOperationAuthorization, defaultMessageAuthorization, requiredValidatorId,
controlRevision]`；未知账户返回 `false` 与全零）、`getAccountAddress(accountId)`、
`getModules(accountId, moduleType, cursor, limit)`（limit 1–32；返回
`[items, nextCursor, configurationNonce]`；cursor 基于 moduleId）、
`getModule(accountId, moduleId)`（§7.1 的 14 个记录字段，前面加上 `moduleId`；实例不存在时返回空数组）、
`isModuleInstalled(accountId, moduleType, moduleHash, additionalContext)`、
`getAuthorizedModuleId(accountId, phase)`、`getNonce(accountId, validatorId, nonceSubkey)`（packed）、
`getNonceSequence(accountId, channel)`、`getOperationDigest(accountId, operation)`。没有原生消息或门限查询：由 SigningModule 与 ThresholdPolicyModule 提供对应读取。

注册：`createAccount(accountId, custody, salt, actions)` 与批量入口
`createAccounts(accountIds, custody, salts)`。批量入口要求 1–64 对长度相等的 id/salt，共用一个托管见证，
每个账户都不带注册动作。`actions` 最多容纳 16 条初始动作数组；只接受安装动作（动作码 1），
它们在控制记录写入之后原子执行，整组只推进一次配置 nonce，因此 §1.2 的标准模块就在注册调用中完成安装。
配置、卸载、内置授权和必需验证器属于治理路径，在初始组中被拒绝。核心不保存恢复时间锁或恢复策略：
RecoveryModule 自行设定延迟。

配置：`installModule(accountId, moduleType, moduleContractHash, initData)`、
`removeModule(accountId, moduleId, deInitData)`、`configureModule(accountId, moduleId, data)`、
成组的 `applyConfigurationActions(accountId, actions)`，以及受限落地入口
`setBuiltinAuthorization(accountId, defaultOperationAuthorization, defaultMessageAuthorization)`
与 `revokeModuleCredentials(accountId, moduleId)`。安装、卸载、配置、内置授权开关与成组入口只接受 governance 调用方；
`revokeModuleCredentials` 接受托管见证或 governance 调用方。每个入口都要求账户处于 Active 且空闲，并恰好推进一次
配置 nonce（成组入口对整组只推进一次）。核心不保留意图记录、没有成熟窗口、没有取消路径：
这些由治理模块管理。提案成熟后，模块按签名时的顺序提交动作（§10）。

受治理配置（安装、卸载、配置、内置授权切换、`applyConfigurationActions` 与普通解冻）的管理调用方由核心这样解析：
直接调用方必须是该账户已安装、声明 `governance` 且代码绑定仍然有效的 validator 实例；其他任何调用方（包括托管方）
都以 `SA_UNAUTHORIZED` 失败。标准 GovernanceModule 就是这样的实例，在自身 24 小时延迟之后提交动作（§10）；
核心不保存延迟。托管方保留即时应急入口 `freezeAccount`（仅限托管见证）与
`revokeModuleCredentials`。`resetAccount` 只限绑定的恢复席位（§9）。

动作码为安装（1，`[1, moduleType, moduleHash, profileDigest, initData]`）、卸载（2，`[2, moduleId, deInitData]`）、
配置（3，`[3, moduleId, data]`）、内建授权（5，`[5, operation, message]`）与
强制验证器（7，`[7, validatorId, required]`）；其他动作码以 `SA_OPERATION_MALFORMED` 失败。
`createAccount` 的初始组只接受安装动作。

执行：`validateUserOp(accountId, operation)`（只读、真实验证、结构化结果）、
`executeUserOp(accountId, operation)`、
`freezeAccount(accountId)`、`unfreezeAccount(accountId)`（仅限 governance 调用方）。每笔交易恰好携带一个操作。恢复是一个模块：
`beginRecovery`、`cancelRecovery`、`executeRecovery` 与状态读取都是 RecoveryModule 的方法，
核心除受限 `resetAccount` 落地入口外一个都不暴露。

`resetAccount(accountId, newCustody)` 就是该落地入口。它只接受该账户已安装的恢复席位
（类型 5，每账户一个）作为调用合约；托管人与其他所有调用方都以 `SA_UNAUTHORIZED` 失败。
它移除全部实例与 nonce 记录、写入 `newCustody`、恢复注册开关且状态为 Active、`requiredValidatorId` 为 0，
并推进权限代次、配置 nonce 与控制修订号。id 分配器保持不变。

组合验证：`validateMember(accountId, memberId, operationDigest, operation)` 只能由正在被验证的
组合验证器调用，且只针对本次验证的操作字节与摘要。它在成员验证阶段运行叶子成员的
`validateUserOp`：最多 10 个成员，不允许重复，不允许嵌套组合。

witness 入口 `verify(accountId)` 嵌在固定的代理 verification script 里，对 witness 检查只回答准入
（§11.1）：它不授权任何东西，也不授予任何帧。

生命周期模块回调（核心→模块）：`onInstall(accountId, moduleId, moduleType,
initData)`、`onUninstall(accountId, moduleId, moduleType, deInitData)`、
`configure(accountId, moduleId, moduleType, configData)`、hook 的
`preCheck`/`postCheck`、validator 的 `validateUserOp`/`onUserOpComplete`，都在交易所声明的系统费内
运行（§11.1）。各模块经核心配置门解码自己的 `configData`；核心不保存按方法的允许列表。

### 9.1 编译产物的回调 ABI

manifest 方法名是 C# 方法名首字母小写（`OnInstall` → `onInstall`、
`ValidateUserOp` → `validateUserOp`）。`preCheck` 的参数名为 `operation`；
`postCheck` 的最后一个参数名为 `hookData`。下表类型均为 manifest 参数类型。

| 方向 | 操作 | manifest ABI | 说明 |
| --- | --- | --- | --- |
| core→module | `getModuleProfile()` | `→ String`，**safe** | canonical profile 字节，≤ 2048 字节，无参数、不可写。 |
| core→module | `onInstall(accountId, moduleId, moduleType, initData)` | `Hash160, Integer, Integer, Array → Void` | `initData` 是命令数组（见 §9.3）或空数组。 |
| core→module | `configure(accountId, moduleId, moduleType, configData)` | `Hash160, Integer, Integer, Array → Void` | 同一命令形态；在配置阶段执行。 |
| core→module | `onUninstall(accountId, moduleId, moduleType, deInitData)` | `Hash160, Integer, Integer, Array → Void` | 必须清空 `(accountId, moduleId)` 的全部实例键。 |
| core→module（validator） | `validateUserOp(accountId, operationDigest, operation)` | `Hash160, ByteArray, Array → Boolean`，**safe** | `operationDigest` 为 §4.3 核心摘要；`operation` 为 canonical 13 字段视图。 |
| core→module（validator） | `onUserOpComplete(accountId, operation, result)` | `Hash160, Array, Any → Void` | 仅 completion 阶段；`result` 是净化后的目标返回值。 |
| core→module（hook） | `preCheck(accountId, operation)` | `Hash160, Array → ByteArray` | 返回本实例的 `hookData`；`null` 归一化为空字节串；最多 512 字节，否则 `SA_HOOK_DATA_TOO_LARGE`。 |
| core→module（hook） | `postCheck(accountId, operation, result, hookData)` | `Hash160, Array, Any, ByteArray → Void` | 收到的正是同一实例 `preCheck` 返回的字节，绝不是另一实例的。 |
| core→module（validator，`messageCapability`） | `isValidSignature(accountId, originalSender, validatorId, generation, hash, signatures)` | `Hash160, Hash160, Integer, Integer, ByteArray, Array → Boolean`，**safe** | `hash` 是核心域绑定的模块消息摘要，直接验证。调用方被限制为 `ReadOnly`。 |
| core→module（validator，`hookPlanner`） | `planHooks(accountId, operationDigest, operation)` | `Hash160, ByteArray, Array → Array`，**safe** | 返回本次操作的 hook 顺序：每个已安装 hook 恰好一个编号，均已安装、不重复 —— 否则 `SA_PROOF_INVALID`。每账户最多一个规划器（`SA_MODULE_LIMIT_PLANNER`）。 |

安装时的检查顺序：profile 摘要 → profile 解析（版本、模块类型、合约名、能力）→
上述完整回调面。缺方法在写入实例前就失败；`getModuleProfile` 与验证/消息回调必须
声明为 `safe`，因此调用方即使传入写标志也无法从其中写入。hook pre/post 按设计可写
（它们要计量余额），但只使用自身实例键。

回复按类型严格判定，不做强制转换。`validateUserOp` 只有恰好返回 `Boolean true`
才表示批准；其他任何回复类型都是 ABI 违约，以 `SA_CALLBACK_RETURN_TYPE` 失败，
执行路径与只读预览一致。`isValidSignature` 绝不失败——ERC-1271 必须 fail-closed——
因此非 `Boolean` 的回复与 `Boolean false` 等价。`preCheck` 回复必须是 `ByteArray`
（否则同样视为 ABI 违约），`getModuleProfile` 回复必须是 `String`，否则安装以
`SA_MODULE_CODE_BINDING_MISMATCH` 失败；所有返回 `Void` 的回调必须把求值栈清空。

### 9.2 实例鉴权（模块侧）

模块从不信任调用方声明的实例，按以下顺序解析：

1. `authorizedCore()`（模块存储）必须等于 `Runtime.CallingScriptHash`；为零或非法
   核心时以纯文本消息 `SA core not configured`（不是协议错误码）失败，其他调用方以
   `Unauthorized caller` 失败。`contracts/modules` 下的标准模块对这两种情况分别抛出
   `SA_PHASE_VIOLATION` 与 `SA_UNAUTHORIZED`。
2. 核心通过 `getAuthorizedModuleId(accountId, phase)` 回答当前寻址的实例。阶段为
   `Validation 1`、`HookPre 2`、`TargetDispatch 3`、`HookPost 4`、`Completion 5`、
   `Configuration 6`；成员验证为 `8`，hook 规划为 `9`（`Cleanup 7` 保留，从不授予）；返回 `0`
   表示该阶段不寻址本模块。生命周期回调仅当阶段 6
   返回值与收到的 `moduleId` 完全相等时才获授权。
3. `validateUserOp` 在只读预览期执行时没有 writer 阶段，模块改用
   `operation[validatorId]`（索引 7）作为实例 id。
4. `getModule(accountId, moduleId)` 返回描述符
   `[moduleId, moduleType, contractHash, contractId, updateCounter, nefSha256,
   profileSha256, moduleRevision, credentialGeneration, instanceIsolation,
   messageCapability, thresholdMemberEligible, compositeLayer, governance,
   hookPlanner]`。索引 8（`credentialGeneration`）把成员的签名绑定到它自己的实例。
5. 持有资产的脚本哈希为 `getAccountAddress(accountId)`。
实例键为 `prefix（1 字节）‖ accountId（20 字节）‖ moduleId（8 字节大端）`；
模块绝不以调用方提供的 context blob 为键。

### 9.3 配置命令数组

三个生命周期参数都是 VM 数组。安装时按具名条款的[安装格式](proposals/nep-smartaccount-module-profiles.mediawiki#Installation_data)构造 `initData`。
配置时，`configData` 是一条 `[command, ...args]` 命令。正常卸载任一启用的具名模块时传 `deInitData = []`，没有卸载命令。
第三方模块自行定义数据含义。核心限制数组长度（见 §3）。内置模块的配置命令如下：

| 模块 | 命令 |
| --- | --- |
| `P256Validator`、`Web3AuthValidator`、`TeeKeyValidator` | `setPublicKey(publicKey)` —— 33 字节压缩或 65 字节未压缩，存储为压缩形式。 |
| `NeoWitnessValidator` | `setSigners(signers[], threshold)` |
| `MultiSigValidator` | `setMemberKey(publicKey)` —— 每实例一把密钥。 |
| `SessionKeyValidator` | `setSessionKey(publicKey, target, method, validUntil, spendingLimit, description)` / `clearSessionKey()`；到期时间为 Unix 毫秒时间戳 |
| `SubscriptionValidator` | `createSubscription(subId, merchant, token, amount, periodSeconds)` / `cancelSubscription(subId)`；[订阅 ID 与账期规则](proposals/SMARTACCOUNT-MODULE-NEPS.zh-CN.md) |
| `DelegatedIdentityValidator` | `setConfig(publicKey, provider, masterNullifier)` |
| `ZKEmailVerifier` | 无 —— 证明验证器尚未部署，所有回调 fail-closed。 |
| `ActionSessionValidator` | `setRecoveryService(service)` / `clearRecoveryService()` |
| `DailyLimitHook` | `setDailyLimit(token, maxAmount, useRollingWindow)` / `clearDailyLimit(token)` |
| `TokenRestrictedHook` | `restrictToken(token)` / `unrestrictToken(token)` |
| `WhitelistHook` | `allowTarget(target)` / `denyTarget(target)` |
| `NeoDIDCredentialHook` | `requireCredential(target, provider, claimType, commitment)` / `clearRequirement(target)` |
| `MultiHook` | 无 —— 核心不接纳该模块类型。 |
| `HookOrchestratorModule` | 无。`initData` 为 `[]`，或 `[hookIds[]]`：在安装的同一次调用里确认已安装的 hook 顺序，列表必须等于该账户按升序排列的已安装 hook 集合。 |
| `GovernanceModule` | 无 —— `initData` 必须为 `[]`；配置经其自身的提案入口进行（§10）。 |
| `RecoveryModule` | 无 —— `initData` 必须为 `[]`；恢复请求经其自身的入口进行（§12）。 |
| `SigningModule`、`ThresholdPolicyModule` | 无 —— `initData` 必须为 `[]`；只读适配器，没有配置。 |

### 9.4 核心与模块的职责划分

本文档是模块行为的规范来源，PDF 阅读版由它派生。职责划分如下：

1. 恢复策略与恢复延迟属于 RecoveryModule 的状态；核心没有恢复策略 setter。
2. 消息主体、成员名单与门限策略属于模块状态。
3. 模块配置经通用的 `configureModule` 与 `applyConfigurationActions` 落地：闭合 v4.1 ABI 为 26 个公开方法。
4. 注册携带调用方提供的 `actions`，因此核心不保存任何模块哈希。
5. hook 规划与 hook 括号由核心执行。核心调用账户唯一的 `hookPlanner` 实例（`planHooks`），冻结返回的顺序，然后自行派发 `preCheck` / `postCheck`、成员回调与完成回调。顺序、快照冻结、`hookData` 配对与代码绑定复核仍是宿主强制的事实，而不是模块的承诺。
6. 除冻结与凭证撤销外，每个管理入口只接受该账户代码绑定、声明 `governance` 的调用方。
7. 没有逐调用或聚合 gas 预算：回调在交易所声明的系统费内运行（§11.1）。
## 10. 生命周期、治理意图与时间锁

本节的等待窗口覆盖全部受治理配置。核心只认 governance 调用方，托管方直接调用核心管理入口会以 `SA_UNAUTHORIZED` 失败。

正常配置（空槽安装、卸载、hook 顺序调整、signer 变更、默认授权开关、代码重绑定）
—— 一律 **24 h 延迟**（86 400 000 ms）。

例外：
- 新账户注册原子安装默认模块（仅动作码 1）；
- 紧急冻结立即；
- validator 凭证的 callback-free 撤销立即 —— 必须是核心定义的单向撤销（代数
  推进）；模块不得把“撤销”解释成授权；
- 恢复属于 RecoveryModule，核心只承接成熟后的受限 `resetAccount`，不调用插件。

Pending 意图是治理模块的状态，不是核心状态。标准治理模块用自己的计数器分配每账户的
`intentId`，并把每条记录存放在自己的前缀下（§7.1）；核心的 `nextIntentId` 只是保留的
布局字段。每账户未结束意图 ≤16；`proposedAt + 24 h = matureAt`；
`expiresAt = matureAt + 7 天`（604 800 000 ms）。意图绑定 authorityEpoch、configurationNonce
与精确的序列化动作字节；确认必须原样重交这些字节，成熟前以 `SA_INTENT_IMMATURE`、
过期后以 `SA_INTENT_EXPIRED` 拒绝，并在动作执行前删除记录。动作摘要或资源集（动作推导的键
加声明的读集）与某个 pending 意图相交的提案在提交时即被拒绝（`SA_INTENT_CONFLICT`），
不排队也不合并。提交后只作废过期代次或相冲突的意图，不是所有 pending。到期记录由显式
取消入口或下一次提案清理。提议、确认与取消未到期的意图都要求托管见证；调用这些入口的
已安装 validator 合约不是管理见证，任何人都可以清理到期意图。账户处于 Frozen 时，只有
解冻意图可以被提出、确认或取消。

SigningModule 拥有消息主体集合与阈值；ThresholdPolicyModule 拥有成员名单与门限。它们既不是原生动作，也不是原生查询。修改它们的治理提案是提交给对应模块的模块提案；原生核心只接收 §9 描述的通用配置回调。

只含受治理模块动作的提案可在资源互不重叠时分别到期、按任一顺序确认。资源检查涵盖将释放和新增的成员，以及新编号分配。确认不会替另一份提案改写原始收据或缩短等待时间。绕过治理的直接变更及影响范围未知的回调不能让旧提案重新生效。未知动作会在提案分配编号前被拒绝。

**原子配置。** 核心入口 `applyConfigurationActions(accountId, actions)` 按原顺序执行 1 至 16 个动作：安装（1）、卸载（2）、配置（3）、内建授权（5）与必需验证器（7），载荷和提案相同。全部成功，账户配置 nonce 与控制修订号各推进一次；任一动作失败，整组不生效。内建操作授权已关闭时，不可单独卸载最后一个验证器；可以在同一组里重新打开授权。所有受治理动作都经账户的 governance 调用方进入该入口：标准 GovernanceModule 在成熟确认后提交；核心不保存延迟或意图。`createAccount` 只接受初始安装动作（动作码 1）。

| 用户关心的问题 | 核心实际保证什么 |
|---|---|
| 谁可以调整配置？ | 只有已安装且代码绑定、声明 `governance` 的 validator 实例；标准 GovernanceModule 在 24 小时延迟成熟后提交。托管方直接调用被核心拒绝。 |
| 哪些变更要等？ | 通过标准治理模块提出的配置变更要等满 24 小时，确认的动作、顺序和有效期必须与原提案一致。不能把这个承诺套用到所有模块自己的写入口。 |
| 谁能成为新恢复方？ | 修改为新的恢复地址时，除了管理员，还需要新地址提供见证。 |
| 多个变更能否一起完成？ | 可以。治理提案中的核心动作必须连续；模块动作可以在这组之前或之后。把模块动作夹在两段核心动作之间的提案会在分配编号前被拒绝，不会擅自调整已签顺序。若模块回调造成额外的版本推进，使整笔超过一次，确认会整笔回滚。 |

核心共有 26 个原生方法，参数摘要绑定治理代码和清单。客户端在连接时同时核对核心接口和清单中的参数摘要，任一不匹配便停止。

托管方调用 `SmartAccount.freezeAccount` 可立即冻结；冻结是应急路径，永不经过治理延迟。
`GovernanceModule.unfreezeAccount` 只创建提案，24 小时后才可确认；只有成熟确认
才能到达原生 `unfreezeAccount` 落地入口。核心只接受 governance 调用方；托管方直接解冻以 `SA_UNAUTHORIZED` 失败。
冻结和解冻都会推进授权代际。
卸载最后一个验证器时，整组配置完成前必须启用内建操作授权；已有 hook 保留，不会自动开启后备授权。

标准恢复模块接受托管人或已配置恢复方的请求；如指定新托管人，还需新托管人见证。只有已安装且代码绑定有效的恢复席位可以调用核心重置。每账户时间锁为 7–90 天；恢复
意图不得被另一请求覆盖或重启；成熟后可 permissionless 执行已批准的精确结果；推进 authorityEpoch/configurationNonce、移除
全部模块实例与 nonce 记录、作废 pending、恢复内建授权。
重置与已批准组合的落地属于同一笔交易：交易结束时必须留有具备 governance 能力、代码绑定有效的验证器，
否则整笔交易以 `SA_UNAUTHORIZED` 失败，重置连同其余写入一并回滚。

## 11. Gas 与实测成本

### 11.1 Witness 与费用模型

交易结构：账户的 verification script 固定，只调用 `verify(accountId)`。操作放在交易 script 里，作为恰好一次
`executeUserOp(accountId, operation)` 调用的参数。

`verify` 只做准入：调用方是该账户的代理，且代理不是这笔交易的付款方；账户存在且为 Active；
交易 script 就是那一次 `executeUserOp` 调用（`ValidateEntryScript` 先比对固定尾部字节，再按字面量解码，
解码前把字面量长度限制在操作上限的两倍；核心不执行也不构造 script）；deadline、authority epoch
与 configuration nonce 是当前值；nonce 可用。`verify` 不验签，也不调用模块，因为 Neo 对单个 witness
的计费上限是 1.5 GAS。Application trigger 下，只有代理在自身目标 dispatch 内的帧返回 true。
目标调用的嵌套帧不算目标，所以代理无法借一个自身调用 `NEO.transfer` 的目标合约转出 NEO 或 GAS；
只有直接以原生合约为目标才行。

授权只发生一次，在 `executeUserOp` 内：`validatorId = 0` 走内置签名（对域分隔的 canonical 操作做一次
SHA-256，用 P-256 验签），否则调用已安装 validator 实例的 `validateUserOp`。因此签名无效的交易能通过
witness 检查，却在执行时被拒：交易 FAULT，状态不变，手续费照付。中继方应先模拟。

核心自身不设 gas 上限：没有逐调用预算、没有聚合上限、没有 `System.Contract.CallWithGasLimit`， 也没有 `MinimumRequiredFee`。声明的 `SystemFee` 是唯一上限，Neo 全额燃烧。
钱包按模拟消耗申报。

引擎只保留内核必需的状态：账户重入锁、当前回调身份（模块编号、合约、阶段）、用于 witness 授权的目标锚帧、
组合验证状态，以及 reset 之后的受限初始化。代理和原生合约哈希绝不可能成为无关帧的 witness。

决定最坏情况的边界钉在协议常量文件（`contracts/native/SmartAccount/SmartAccountModuleProtocol.cs`）：
`HookDataBytesMax = 512`、`ModuleProfileBytesMax = 2048`、`ArgsCountMax = 64`、
`HookProofsEntriesMax = 8`、`HookProofBytesMax = 4096`（聚合）、`OperationEncodedSizeMax = 16384`。
`getModuleProfile` 以 `CallFlags.ReadStates` 执行：profile 不能读余额、不能调用其他合约、不能写。

### 11.2 实测成本

Datoshi = 1e-8 GAS；ExecFeeFactor 30，启用 `HF_Huyao`，默认 Policy。第一列是执行引擎，第二列是运行
代理 verification script 的引擎。钱包支付总额 = 声明系统费 + 网络费，取自钱包报价路径（单位 datoshi，括号内为 GAS）。

| 场景 | 执行引擎 | 代理 witness 引擎 | 网络费 | 钱包支付总额 |
| --- | --- | --- | --- | --- |
| 普通 NEO 转账 | 9,915,830 | 不适用 | 1,227,520 | 11,143,350（约 0.111 GAS） |
| 单密钥托管，转账 | 12,866,237 | 1,966,546 | 3,548,066 | 16,414,303（约 0.164 GAS） |
| 模块路由 1-of-1 | 18,274,253 | 1,966,546 | 3,425,066 | 21,699,319（约 0.217 GAS） |
| 门限 2-of-3 | 26,631,930 | 1,966,546 | 3,425,066 | 30,056,996（约 0.301 GAS） |
| 门限 10-of-10 | 55,883,801 | 1,966,546 | 3,425,066 | 59,308,867（约 0.593 GAS） |

网络费 = 托管签名成本 983,520 + 代理 witness 引擎消耗 + 字节费（每字节 1,000；普通转账 244 字节，托管转账 598 字节，模块场景 475 字节）。
关闭 `HF_Huyao` 时各项略高：托管转账的执行引擎 13,051,820、witness 引擎 2,028,330、网络费 3,609,850、合计 16,661,670（约 0.167 GAS）。

本文档早期版本对同样场景给出的 3.0 至 15.4 GAS 已过时。

## 12. 模块能力声明 profile

每个可安装模块附带 canonical profile JSON（profile 哈希进入 0x52 绑定）。Schema
（下例为验证器；钩子、恢复席位的回调和完整模板见[模块标准接入说明](proposals/SMARTACCOUNT-MODULE-NEPS.zh-CN.md)）：

```json
{
  "profileVersion": 1,
  "moduleType": "validator",
  "contractName": "…",
  "capabilities": {
    "instanceIsolation": false,
    "messageCapability": false,
    "thresholdMemberEligible": false,
    "compositeLayer": 0
  },
  "lifecycle": ["onInstall", "onUninstall", "configure"],
  "callbacks": ["validateUserOp", "onUserOpComplete"]
}
```

- `instanceIsolation: true` 是同一合约地址多实例安装的前提。
- `messageCapability` 门控 §8 模块消息签名。**SessionKeyValidator 与
  SubscriptionValidator 默认 `messageCapability: false`** —— 受限执行凭证不得
  升级为任意离线授权。
- `thresholdMemberEligible` 标记可加入阈值政策的标量 validator。它只是必要条件（见下方矩阵后的说明）。
- `compositeLayer` ≤ 1（单层；无嵌套/环）。
- `governance` 与 `hookPlanner` 是可选席位标志：为 false 时必须整个键省略，出现时必须是
  `true`，且只有 validator 可以声明。0x52 描述符里的这两位就读自这里：延迟配置落地只
  接受声明 `governance` 的实例，`planHooks` 只调用唯一声明 `hookPlanner` 的实例（该
  实例还必须暴露 safe 的 `planHooks` 回调）。

### 12.1 canonical 字节与唯一事实源

profile 是对象键排序、无空白、**末尾无换行**的 UTF-8 JSON 文档；canonical 形态既是
模块返回的字节，也是安装方计算哈希的对象。不允许类 `timestamp` 或依赖环境的字段：
同一源在任何机器上必须产出同一字节。

每个模块把 canonical 字节存两份，两份都要校验：

| 位置 | 用途 |
| --- | --- |
| `contracts/plugins/<validators\|hooks\|recovery>/<Name>.profile.json` | 可单独审阅的事实源。 |
| 模块源码里的 `private const string ModuleProfileJson = "…"` | 上链后 `getModuleProfile()` 实际返回的字节。 |

`scripts/sync-module-profiles.mjs` 重写非 canonical 文件、用 `.profile.json` 回填
字面量、校验模块确实声明了 profile 声称的回调，并支持 `--check`（STALE/ERROR 时以
退出码 1 失败）。`scripts/sync-module-profiles.mjs --check` 在 STALE/ERROR 时失败；请在构建前先运行它，

绑定顺序与失败模式（原生核心 一致）：

1. `getModuleProfile` 必须存在且为 `safe` → 否则 `SA_MODULE_CODE_BINDING_MISMATCH`。
2. `SHA-256(返回字节)` 必须等于安装动作里的 `profileDigest32` → 否则
   `SA_MODULE_CODE_BINDING_MISMATCH`。
3. `profileVersion` 必须为 1，`moduleType` 必须与请求类型一致，`contractName` 必须
   等于 manifest 名，四个能力键必须齐全 → 否则
   `SA_MODULE_CODE_BINDING_MISMATCH` 或 `SA_MODULE_TYPE_UNSUPPORTED`。
4. hook 或 recovery profile 声称 `messageCapability`、`thresholdMemberEligible`、
   `governance` 或 `hookPlanner` 时以 `SA_MODULE_TYPE_UNSUPPORTED` 失败；仅 validator
   可以声明后两者；`compositeLayer` 超出 0–1 同样失败。
5. 只有到这一步才校验 §9.1 的回调 ABI 并写入实例；记录的能力标志读自 profile，
   绝不由安装方声明。

本仓库发布的能力矩阵：

| 模块 | instanceIsolation | messageCapability | thresholdMemberEligible | compositeLayer |
| --- | --- | --- | --- | --- |
| `P256Validator` | false | false | true | 0 |
| `Web3AuthValidator` | false | true | true | 0 |
| `TeeKeyValidator` | false | false | true | 0 |
| `NeoWitnessValidator` | false | false | true | 0 |
| `DelegatedIdentityValidator` | false | false | true | 0 |
| `MultiSigValidator` | true | false | true | 0 |
| `SessionKeyValidator` | true | false | false | 0 |
| `SubscriptionValidator` | false | false | false | 0 |
| `ZKEmailVerifier` | false | false | false | 0 |
| `ActionSessionValidator` | false | false | false | 0 |
| `DailyLimitHook`、`TokenRestrictedHook`、`WhitelistHook`、`NeoDIDCredentialHook` | false | false | false | 0 |
| `MultiHook` | false | false | false | 1 |

`thresholdMemberEligible` 仅是门限成员入册的必要条件。核心还要求每个成员的代码是被钉住的标准
成员 validator（`MultiSigValidator`，按 NEF 与 manifest 摘要核对），并调用其成员公钥入口
（manifest 方法名 getMemberKey(accountId, moduleId)）取得互不相同的 33 字节压缩公钥。当前只有
`MultiSigValidator` 同时满足两条，因此矩阵中其他为 `true` 的行尚不能入册为政策成员。

`SigningModule` 是唯一公共消息入口；声称 `messageCapability` 却没有 `isValidSignature` 的
profile 仍会在 §9.1 绑定失败。`Web3AuthValidator` 的 `isValidSignature` 是验证器内部能力，
不是原生或公共消息入口。

## 13. ERC 对齐边界

接口命名尽量对齐 ERC-7579/4337/1271（模块类型、`isValidSignature`、
`validateUserOp` 风格验证、`executeUserOp`、安装/卸载生命周期事件）。
**协议不宣称 Ethereum 协议兼容：**
- Neo SA 不是 `PackedUserOperation`/`EntryPoint.handleOps`；一笔交易只携带一个操作，不是 bundle。
- NeoVM nonce 域是**派生的 191 位 channel + 64 位 sequence**；ERC-4337 是自选
  key 的 192+64。
- ERC-7562 是 Ethereum mempool 验证规则集，不是 Neo 共识规则；声明的 Neo 系统费不是
  Ethereum verification gas 的换算。
- ERC-1271 语义（magic 值、只读、任意方案）作为 **Neo profile** 受尊重。

所有文档/UI 措辞规则：“职责与安全模型对齐的 Neo profile”，绝不写“完整兼容
ERC-4337/ERC-7579”。

## 14. 账户初始状态

账户从注册创建。只有 Active 与 Frozen 两种状态；其他状态码必须拒绝。

## 15. 共享常量文件与 fixture

| 工件 | 路径 |
| --- | --- |

| 原生版常量 | `contracts/native/SmartAccount/SmartAccountModuleProtocol.cs`（internal static `SmartAccountModuleProtocol`，经 `scripts/sync_native_smartaccount.py` 同步到 neo-native-core） |
| fixture 骨架 | `tests/fixtures/sa-module-protocol/`（README + schema + 模板） |

常量文件钉住以下数值：固定编码标记 4；模块类型码 1/4/5；§3 全部上限；13
字段操作字段序号；nonce 尺寸（32 字节 subkey、24 字节 channel）；序列化上限
（4096/8192/4096/16384）；核心声明的存储前缀（0x50、0x51、0x52、0x53、0x56、
0x5C）；§17 错误码字符串；§18 事件显示名；以及定宽大端键后缀编码（`UInt64ToBigEndian`
与各前缀复合键构建器）。恢复延迟上下限与治理延迟都是模块常量，不是核心常量。

## 16. Kernel 实施映射

> 下表是设计映射，不是已交付的原生 ABI 或能力清单。

### 16.1 原生 kernel

| 规范章节 | 原生版需创建/修改的文件 |
| --- | --- |
| 常量 | 消费 `SmartAccountModuleProtocol.cs`（随后运行 `scripts/sync_native_smartaccount.py` 物化 neo-native-core 副本） |
| §4/§5 操作/摘要 | `SmartAccountProtocol.cs`（签名域、13 字段操作、入口 script 识别） |
| §6 nonce | `SmartAccountProtocol.cs` + nonce 存储 partial（0x56/0x5C） |
| §7 状态 | `SmartAccountRecords.cs`（0x51 记录与其 codec） |
| §2/§3 集合 | `SmartAccount.Modules.cs`（实例记录、枚举、模块上限）、`SmartAccountModulePolicy.cs`（profile 校验、组合层） |
| §9/§10 生命周期与治理动作 | `SmartAccount.Modules.cs`、`SmartAccount.Execution.cs`（配置动作）；pending 意图保存在 `contracts/modules/GovernanceModule`，不在核心 |
| §8 消息 | `contracts/modules/SigningModule`（消息域、主体与阈值）；原生核心没有消息入口 |
| §11.1 witness 与费用 | `SmartAccount.Execution.cs`（`verify`）、`SmartAccountInvocationContext.cs`（目标锚帧）；核心不设 gas 预算 |
| 调用阶段门 | `SmartAccountInvocationContext.cs`（精确的回调帧与目标帧授予；validation/message 绝不可触达 post/configuration/cleanup 写） |
### 16.2 原生不变量（fixture 矩阵）

完整矩阵见 `tests/fixtures/sa-module-protocol/README.md`：
同地址多实例安装；换 validator 不能跳过任何 hook；阈值成员不可独立路由；重复身份、
环、嵌套拒绝；post 仅对原获准快照集合执行；hook 正序/逆序及 false/FAULT 处理；
proof/args/hookData 篡改拒绝；空槽/卸载/最后 validator/默认政策的时间锁；pending
并发、冲突、成熟、过期、过期修订；冻结状态全 ABI 清扫；validation/message→
post/configuration/cleanup 提权攻击；contractId/updateCounter/NEF/profile 前后
漂移；撤销重授与重放；同 subId 重建新代数；未消费 recovery ticket 跨
clear/setup 重放；恢复不依赖任何插件回调；无插件操作与 SigningModule 消息签名；合约
custody 不能伪造消息签名；Verification trigger 下的 witness 准入与 Application trigger 下的代理帧分别验证，
以及 nonce 与代际单调性。

## 17. 错误码

错误码为稳定字符串常量（`SA_*`）；kernel 异常携带它们（可在空格后附加细节后缀）。
原生核心的拼写钉扎于 `contracts/native/SmartAccount/SmartAccountModuleProtocol.cs`；
第一张表中的每个错误码都在该文件声明且可达。标准模块在
`contracts/modules/Shared/ModuleSupport.cs` 保存共享错误码的副本，外加第二张表中
仅模块使用的错误码。`contracts/plugins` 下的 validator 与 hook 用普通消息断言，
不使用 `SA_*` 错误码。

| 错误码 | 含义 |
| --- | --- |
| `SA_PROTOCOL_VERSION` | 操作版本 ≠ 4 |
| `SA_OPERATION_MALFORMED` | 非规范形态、尺寸、深度、排序、整数域（nonce 与 deadline 字段是两处明确例外，见对应行）；畸形的动作数组 |
| `SA_OPERATION_FIELD_COUNT` | 字段数 ≠ 13 |
| `SA_MODULE_TYPE_UNSUPPORTED` | 模块类型非 1、4 或 5；profile 的 `moduleType` 或能力与请求类型矛盾 |
| `SA_MODULE_LIMIT_VALIDATOR` / `SA_MODULE_LIMIT_HOOK` / `SA_MODULE_LIMIT_RECOVERY` / `SA_MODULE_LIMIT_PLANNER` / `SA_MODULE_LIMIT_ACTIONS` / `SA_MODULE_LIMIT_BATCH` | 超出 §3 上限（每类实例数、hook 规划器、每组动作数、`createAccounts` 每批账户数）；`SA_MODULE_LIMIT_THRESHOLD` 与 `SA_MODULE_LIMIT_MEMBERS` 为仅模块使用的错误码 |
| `SA_MODULE_NOT_INSTALLED` | moduleId 未安装于该账户 |
| `SA_MODULE_ID_INVALID` | 枚举游标超出 UInt64 域；卸载动作的模块编号为 0 |
| `SA_MODULE_INSTANCE_ISOLATION_REQUIRED` | 未声明 `instanceIsolation` 的同地址重装 |
| `SA_MODULE_CODE_BINDING_MISMATCH` | contractId/updateCounter/NEF/profile 漂移；非规范 profile；成员、恢复或治理代码与其钉住的摘要不符 |
| `SA_MODULE_NOT_ROUTABLE` | 已登记强制验证器时路由到其他实例；内置路由已关闭时使用内置路由；直接路由到非 validator 实例 |
| `SA_VALIDATION_REJECTED` | validator 拒绝操作；内置 custody 签名无效 |
| `SA_VALIDATOR_NOT_FOUND` | 被路由的实例未安装，或不是 validator 实例 |
| `SA_CALLBACK_RETURN_TYPE` | `validateUserOp` 返回了非 `Boolean` 的值，或 `preCheck` 返回的既不是 `ByteArray` 也不是 `null`（§9.1） |
| `SA_HOOK_DATA_TOO_LARGE` | hookData > 512 字节 |
| `SA_PROOF_INVALID` | 签名或 hook 证明重复/未排序/超长；为未安装的 hook 提供证明；`planHooks` 的回复不是已安装 hook 编号的排列 |
| `SA_NONCE_INVALID` / `SA_NONCE_EXHAUSTED` / `SA_NONCE_CHANNEL_COLLISION` | nonce 的 channel 或序号不匹配，以及 nonce 超出其声明的整数域（`SA_OPERATION_MALFORMED` 整数域规则的第一处例外）/ channel 死亡 / 191 位截断碰撞 |
| `SA_DEADLINE_EXPIRED` | 超过期限，以及 deadline 超出其声明的整数域（第二处例外） |
| `SA_EPOCH_STALE` / `SA_CONFIGURATION_NONCE_STALE` / `SA_CREDENTIAL_STALE` | 签名绑定到已被取代的代际/nonce/凭证代 |
| `SA_INTENT_CONFLICT` | 仅 `GovernanceModule`：提交的提案其动作摘要或读集与某一待处理提案相交（§10）。核心不定义任何 intent 错误；门限政策模块以 `SA_OPERATION_MALFORMED`、`SA_MODULE_LIMIT_MEMBERS` 或 `SA_MODULE_LIMIT_THRESHOLD` 拒绝非法成员集。 |
| `SA_ACCOUNT_NOT_FOUND` / `SA_ACCOUNT_FROZEN` / `SA_ACCOUNT_STATUS` | 账户状态门控 |
| `SA_REENTRANCY_FORBIDDEN` | 同账户或跨账户嵌套执行；账户有未结束的执行时写入配置 |
| `SA_BUILTIN_ROUTE_REQUIRED` | 配置组执行后账户既无内建操作路由也无 validator 实例（§10） |
| `SA_UNAUTHORIZED` | 调用方/主体 witness 校验失败；受治理管理入口被该账户代码绑定、声明 `governance` 的 validator 实例以外的调用方调用；非钉住已安装模块的合约请求核心重置或治理落地；重置过账户的执行结束时未留有具备 governance 能力、代码绑定有效的验证器 |
| `SA_PHASE_VIOLATION` | 核心：调用上下文的阶段门（为未进入的账户请求授予（回调或目标）、把核心自身当作 dispatch 目标），以及同一次执行内对同一账户的第二次重置（`SmartAccountInvocationContext.cs`、`SmartAccount.Modules.cs`）。`GovernanceModule` 与共享模块支持库对核心动作被拆成多组、未部署的重绑定动作、配置 nonce 推进超过一次、核心已被钉住或尚未配置抛出同一错误码 |

hook 通过在 `preCheck` 或 `postCheck` 内抛出异常来拒绝操作；核心自身不附加任何
hook 拒绝错误码。

仅模块使用的错误码。`contracts/modules` 下的标准模块除上表的核心错误码外还会抛出下列
错误码；核心不抛出它们。

| 错误码 | 抛出位置 |
| --- | --- |
| `SA_INTENT_IMMATURE` / `SA_INTENT_EXPIRED` | `GovernanceModule`：在 `matureAt` 之前 / `expiresAt` 之后确认提案（§10） |
| `SA_INTENT_NOT_FOUND` / `SA_INTENT_LIMIT` / `SA_INTENT_CONFLICT` | `GovernanceModule`：提案编号未知；已有 16 个 pending 提案时再提交新提案；提案的动作摘要或资源集与某个 pending 提案相交（§10） |
| `SA_RECOVERY_PENDING` / `SA_RECOVERY_LOCKED` | `RecoveryModule`：没有 pending 请求时取消或执行，或发起第二个请求 / 时间锁未到就执行（§12） |

## 18. 事件表

下表是原生 SmartAccount 合约的事件。参数顺序和 manifest 类型均属于接口。处理模块通知时，应另行核对发出通知的合约。

| 事件 | 参数 |
| --- | --- |
| `AccountRegistered` | `accountId: Hash160`, `custody: Hash160` |
| `ModuleInstalled` | `accountId: Hash160`, `moduleType: String`, `moduleHash: Hash160` |
| `ModuleRemoved` | `accountId: Hash160`, `moduleType: String`, `moduleHash: Hash160` |
| `UserOpExecuted` | `accountId: Hash160`, `targetContract: Hash160`, `method: String`, `nonce: Integer` |
| `ModuleInstanceInstalled` | `accountId: Hash160`, `moduleId: Integer`, `moduleType: Integer`, `contractHash: Hash160`, `credentialGeneration: Integer` |
| `ModuleInstanceRemoved` | `accountId: Hash160`, `moduleId: Integer` |
| `NonceChannelOpened` | `accountId: Hash160`, `channelDigest: ByteArray` |
| `NonceChannelExhausted` | `accountId: Hash160`, `channelDigest: ByteArray` |
| `AccountFrozen` | `accountId: Hash160`, `authorityEpoch: Integer` |
| `AccountUnfrozen` | `accountId: Hash160`, `authorityEpoch: Integer` |
| `ModuleCredentialsRevoked` | `accountId: Hash160`, `moduleId: Integer`, `credentialGeneration: Integer` |
| `AccountReset` | `accountId: Hash160`, `custody: Hash160`, `authorityEpoch: Integer` |
| `BuiltinAuthorizationSet` | `accountId: Hash160`, `defaultOperationAuthorization: Boolean`, `defaultMessageAuthorization: Boolean` |
| `ModuleInstanceConfigured` | `accountId: Hash160`, `moduleId: Integer`, `credentialGeneration: Integer` |
| `RequiredValidatorSet` | `accountId: Hash160`, `validatorId: Integer`, `required: Boolean` |

---

> 附录（Appendix: Module developer guide，模块开发者指南）与 Frontend module chooser guide（前端模块选择指南）两章仅提供英文，见 [SA-MODULE-PROTOCOL.md](SA-MODULE-PROTOCOL.md) 文末；其余各章中英对等，冲突时以英文为准。

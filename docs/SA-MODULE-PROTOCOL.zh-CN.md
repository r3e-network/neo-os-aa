# SA 模块协议 —— 共同规范（协议版本 4）

本文件是 Neo Smart Account（SA）模块模型的**唯一共同规范**，供两个 kernel 批次实施：

- 普通合约版 kernel —— 任务 #39（`contracts/`）
- 原生合约版 kernel —— 任务 #40（`contracts/native/SmartAccount/`）

本文定义的 DTO、profile、存储布局、上限、错误码、事件与 gas 预算对两版**完全一致**；
任何一版 kernel 不得偏离或自行重新设计。凡两版运行时确有差异之处（如 caller/阶段
门实现机制），必须作为披露的能力差异显式列出，绝不允许表现为 DTO 分叉。

状态：**已交付规范 + 共享常量 + fixture 骨架；kernel 尚未实施。** 本文不声称任何
当前合约源码的链上部署或协议符合性。

配套文档：

- `docs/SA-MODULE-PROTOCOL.md` —— 英文对应版本（与本文共同权威；如有出入，以两份
  较新的修订为准）。
- `docs/SA-MIGRATION-MANIFEST.md` —— 旧→新迁移 manifest 设计（§14）。
- `tests/fixtures/sa-module-protocol/README.md` —— golden 向量/拒绝回归 fixture
  格式与 kernel 验证矩阵。
- `contracts/custom/SmartAccount.ModuleProtocol.cs` 与
  `contracts/native/SmartAccount/SmartAccountModuleProtocol.cs` ——
  成对常量文件，承载本文全部数值（§15）。两个文件必须始终携带相同数值。

## 1. 范围与术语迁移

### 1.1 术语

旧模型的授权决策模块名为 `verifier`。协议 v4 采用 ERC-7579 术语 **validator**；
`hook` 名称不变。合约 API、存储、事件与错误码一律使用 `validator`/`Validator`；
旧 `verifier`/`Verifier` 名称移除且不保留别名（仅身份决定的 witness 入口
`verify(accountId)` 保留，因其嵌入代理脚本 —— 见 `docs/SA-EIP-712-SPEC.md` 与
§13）。

模块类型（一字节类型码，ERC-7579 编号）：

| 类型 | 名称 | v4 是否支持 |
| --- | --- | --- |
| 1 | validator | 支持 |
| 2 | executor | 不支持 —— `supportsModuleType` 返回 false，安装拒绝 |
| 3 | fallback handler | 不支持 —— 同上 |
| 4 | hook | 支持 |

类型 2/3 不是 validator/hook 的别名。未实现却声明支持是被禁止的；profile 写
“不支持”，不写“可能”。

### 1.2 插件改名与去向（出自已批准设计报告 §3.12）

| 旧插件 | v4 去向 |
| --- | --- |
| MultiHook | 停止新安装；迁移时按旧正序展开为核心 `hookOrder` |
| MultiSigVerifier | 变为 **MultiSigValidator** —— 阈值*政策*；编排与批准收据归核心 |
| NeoNativeVerifier | NeoWitnessValidator（多主体交易 witness；默认单 witness 已内建） |
| SessionKeyVerifier | SessionKeyValidator —— 实例隔离，每实例一组委托凭证 |
| SubscriptionVerifier | SubscriptionValidator —— 核心 nonce 是唯一 sequence；同 subId 重建 ⇒ 新 credential generation |
| Web3AuthVerifier | Web3AuthValidator —— 同签名方案，完整新签名域 |
| WebAuthnVerifier | **P256Validator**（裸 P-256；不声称 WebAuthn ceremony） |
| TEEVerifier | **TeeKeyValidator**（仅配置 enclave key 验签；不声称远程 attestation） |
| ZkLoginVerifier | **DelegatedIdentityValidator**（配置 P-256 signer + 身份绑定；不声称通用 ZK proof） |
| ZKEmailVerifier | 维持禁用；仅保留禁用模板，不发布可安装生产 validator |
| DailyLimitHook / TokenRestrictedHook / WhitelistHook / NeoDIDCredentialHook | 保留、实例化（外部 registry 读取计入回调 gas 预算） |
| SocialRecoveryVerifier | 拆分为可选 social recovery *service* 与可选 action-session validator；基础恢复为核心内建 |
| HookAuthority / VerifierAuthority、SignerDomain、VerifierPayload、模板 | 共同协议库更新，不算可安装插件 |

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

Profile 上限（协议级，两 kernel 强制，数值钉扎于 §15 常量文件）：

| 上限 | 数值 |
| --- | --- |
| 每账户 validator 实例（含阈值成员） | 32 |
| 每账户 hook 实例 | 8 |
| 每阈值政策成员 | 10 |
| 阈值取值 | 1–10 |
| composite 图深度 | 1 层（禁止嵌套、禁止环） |
| 每配置意图动作数 | 16 |
| 每账户未结束配置意图数 | 16 |
| 同账户 batch envelope 操作数 | 32 |
| 枚举分页 limit（`getModules`） | 1–32 |

这些是协议上限，**不是**性能保证：合法最坏组合（10 阈值成员、8 hook、最大 proof）
必须先对照 gas 预算（§11）测量，才能做任何发布声明；仅验证“超限被拒绝”不算验收。

**hook 顺序。** 核心为每账户持有一份 `hookOrder`：已安装 hook moduleId 的有序
列表，长度 ≤ 8。执行时：

- `preCheck` 按**列表正序**执行；
- `postCheck` 对**同一快照按逆序**执行。

顺序基于快照：执行期间重入的配置变更不会改变在途序列。签名绑定 hook proof 摘要
（§5），签名者看到的 hook 集合与实际运行的集合不可能不一致。

## 4. 操作 envelope —— canonical 编码

### 4.1 线上形态

v4 UserOperation 是**严格的 13 字段 NeoVM `Array`**（操作中任何位置出现
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

envelope 级上限：单操作编码 ≤16 KiB；单交易 envelope（单笔或 ≤32 笔 batch）编码
≤64 KiB。多余字段、重复 hook proof、乱序 proof、非规范整数（负值或超出字段声明域）
一律拒绝。

### 4.2 canonical 序列化

未签名操作的 canonical 字节形态 = 同一 13 字段 Array 的 NeoVM 二进制
stack-item 序列化，其中 `[11] signature` 替换为**空 ByteString**。普通 kernel 用
`StdLib.Serialize` 生成，原生 kernel 用 `Neo.VM.BinarySerializer.Serialize` 生成；
两个序列化器对这些形态产生相同字节，golden 向量（§15 fixture 集）钉扎该相等性。

### 4.3 操作摘要与签名域

```
domain := UTF8("NeoSmartAccount/UserOperation")        // 29 字节
         || U1 (version = 4)
         || U32LE (network magic)
         || coreHash (20 原始字节，*实际*执行核心哈希；
                       普通 kernel 不得替换为原生 ServiceHash 常量，反之亦然)
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
| TeeKeyValidator | enclave key id + attested 签名 blob |
| Web3AuthValidator | EIP-712 风格 typed payload，见 `docs/SA-EIP-712-SPEC.md`（域名 `"Neo Smart Account"`），64 字节紧凑签名 |
| P256Validator（原 WebAuthn） | 裸 P-256 `r‖s`（64 字节），对实例配置密钥 |
| DelegatedIdentityValidator（原 ZkLogin） | 配置 P-256 signer 签名 + 身份承诺 |
| 内建（validatorId = 0） | §8 消息 profile 复用于操作模式：canonical P-256 脚本 + 签名，阈值按 0x57 |

阈值路由：`validatorId` 指向阈值政策时，核心在**共享父验证预算**下逐个直接调用
成员 validator，批准收据保存在核心调用局部状态；`postCheck` 阶段仅对验证阶段
获准成员执行 completion。成员必须是标量 validator；同一成员不得加入两个活动政策；
被政策引用的成员在被引用期间不可卸载。

## 6. nonce channel 与命名空间派生

- channel := `SHA256( U1(4) || coreHash || accountId || U64BE(authorityEpoch) ||
  U64BE(validatorId) || U64BE(credentialGeneration) || nonceSubkey )` 的**低 191 位**。
- channel 是**派生的，不是自选的**。`nonce` 低 64 位是 sequence；必须等于存储
  游标（或耗尽哨兵）。
- 存储键中的 channel 字节为 24 字节，右对齐大端，高 7 位为零。
- 每 channel 持久保存**完整 256 位派生摘要**（0x5C）；若第二个不同派生映射到
  已使用的 191 位 channel，操作被拒绝（截断碰撞 fail-closed），绝不静默共享。
- sequence 耗尽（游标 == 2^64 哨兵）：channel 死亡；无回绕。
- 旧游标合并规则（迁移，§14）：新游标永不降低；读新游标时先取
  `max(同 channel 的旧 0x03 值, 新 0x56 值)` 再写入。
- 插件不维护必须与核心游标精确同步的私有 sequence 计数器；核心 nonce 是唯一
  sequence 源（SubscriptionValidator 只消费核心 nonce）。

`configurationNonce` **不是**操作 nonce：每次安全配置提交、凭证撤销、freeze/
unfreeze、恢复与 custody 变更都单调推进；操作消费与额度计数不推进它；清理、卸载、
市场出售不重置它。

## 7. 存储布局规划

### 7.1 共享 0x50–0x5F 区域（两 kernel，键字节一致）

键构造：1 字节前缀 ‖ 原始 20 字节 accountId ‖ 注明处的定宽**大端**整数后缀。
0x5F 保留不分配。

| 前缀 | 键后缀 | 用途 |
| --- | --- | --- |
| 0x50 | bare | 协议版本、布局版本、激活状态、profile 摘要 |
| 0x51 | +acctId | 账户控制元数据（§7.2） |
| 0x52 | +acctId+moduleId[8 BE] | 模块实例记录（type[1]、contractHash、contractId、updateCounter、nefSha256、profileSha256、moduleRevision、credentialGeneration、能力标志） |
| 0x53 | +acctId+type[1]+moduleId[8 BE] | 安装实例枚举索引（marker 行；按类型升序 moduleId 扫描） |
| 0x54 | +acctId | 核心持有 hookOrder 列表 + hookOrderRevision |
| 0x55 | +acctId+intentId[8 BE] | 配置意图记录 |
| 0x56 | +acctId+channel[24 BE] | nonce 游标（新编码） |
| 0x57 | +acctId | 内建消息签名主体（≤16 个 P-256 密钥、阈值）+ subjectRevision |
| 0x58 | +acctId | Application 回调/执行上下文（阶段 + 重入状态） |
| 0x59 | +acctId | 核心恢复与紧急失效记录（Market 逃生路径，§7.5） |
| 0x5A | +acctId | 迁移状态与旧状态摘要（§14） |
| 0x5B | +acctId+policyId[8 BE] | 阈值成员列表与政策 commitment |
| 0x5C | +acctId+channel[24 BE] | nonce 命名空间完整摘要（碰撞检测） |
| 0x5D | +acctId | Market 锁 ↔ custody/控制代际 ↔ listing 绑定（§7.5） |
| 0x5E | +acctId | 有界配置意图索引 |

升级前必须在两网重新扫描 0x50–0x5F 区间；发现未知占用即中止升级 —— 绝不覆盖。

### 7.2 0x51 账户控制元数据

status（Active/Frozen/MigrationRequired）、custody、恢复 authority；
authorityEpoch、configurationNonce；nextModuleId（moduleId 与 policyId 共用分配器）、
nextIntentId；默认操作授权开关与默认消息授权开关；recoveryTimelockMs（7–90 天；
迁移账户保持既有值）；hookOrderRevision、defaultPolicyRevision、controlRevision；
旧永久 owner-only 标志（迁移后继续约束该账户）。

### 7.3 0x52 代码绑定（两 kernel 定义一致）

contractHash、ContractId、UpdateCounter、SHA256(NEF bytes)、SHA256(canonical 模块
profile JSON)。ContractId 阻断销毁重部署；UpdateCounter 捕捉 manifest-only 更新；
NEF 哈希钉扎代码；profile 哈希钉扎接口能力。每次模块回调前后及提交前检查绑定；
同地址重部署不继承授权。

### 7.4 旧区域

**普通 kernel：**
- 0x01 旧五字段 AccountState 行**保留作迁移输入/历史证据**；新状态只写 0x51。
  新代码绝不经旧 Verifier/HookId 字段路由；legacy decoder 仅为迁移存在。
- 0x12 与 0x1C **退役**：新授权绝不源自它们。迁移意图为账户的 0x12/0x1C 行记录
  显式失效声明（存于 0x5A）；这些字节永不重新分配。

**原生 kernel：** 0x10 账户键下的旧 14-slot Array 仍是迁移输入；迁移后由新
0x51 记录取代。0x10/0x11/0x20/0x30/0x40 旧前缀不被新模块模型重新解释。

### 7.5 Market 最小锁（0x5D / 0x59）

- 0x06 / 0x07 / 0x1D 仍为 **Market 独占的物理标记写入**（Market 入口写入或删除；
  其他一律不可 —— 现有 owner 侧 `InitiateMarketEscrowCancel` 直写 0x1D 与
  ForceCancel/FinalizeEscapeToOwner 删除标记属于 kernel 批次需修复的缺陷，见 §16）。
- 0x5D 为每账户绑定：escrow 锁、其 custody/控制代际与 listing id。
- owner 发起与完成的逃生只写 **0x59 核心恢复记录** —— 绝不写旧 Market 前缀。
- 成熟的 callback-free 逃生使该旧代际锁失效：Market settle/cancel 必须先校验
  listing + 控制代际；逃生后的账户不得按旧绑定出售。后续 Market 认领清理物理标记。
- owner 逃生不调用 Market；listing 可由独立 keeper 异步失效。

## 8. 内建消息签名 envelope（ERC-1271 profile）

两 kernel 都实现核心 P-256 单签/阈值消息验证，不依赖插件。

API：`isValidSignature(accountId, hash, signatureEnvelope)`。
- `hash`：32 字节 ByteString（调用方提供的消息摘要）。
- 返回严格四字节 magic；成功 = `0x1626ba7e`（ERC-1271 `MAGICVALUE`）；失败返回
  另一个固定四字节值（`0xffffffff`）—— 成功通道绝不抛异常。
- 消息验证**只读**：不消费操作 nonce、不运行有状态额度 hook、也不能由交易 witness
  满足（合约 custody 通过 `CheckWitness` 并不因此产生离线消息签名；必须显式授权
  消息主体）。

内建 envelope（Array）：

```
[0] version               = 4
[1] validatorId            = 0（内建）或已安装且声明 messageCapability（§12）
                            模块的 moduleId
[2] credentialGeneration   内建：0x57 的 messageSubjectRevision；
                            模块：实例 credentialGeneration
[3] signatures             [verificationScript:ByteString, signature:ByteString
                            64 字节 r‖s] 二元项数组
```

消息摘要域：

```
domain := UTF8("NeoSmartAccount/Message")
         || U1 (4)
         || U32LE (network)
         || coreHash (20 原始字节)
         || accountId (20 原始字节)
         || originalSender (20 原始字节)
         || U64BE (validatorId)
         || U64BE (credentialGeneration)
         || U64BE (authorityEpoch)
messageDigest := SHA256( domain || hash )
```

内建规则：每个 `verificationScript` 必须是压缩点的 canonical N3 P-256 验证脚本
（标准钱包脚本构建器形态）；`SHA256(script)`（脚本哈希）必须是 0x57 中 ≤16 个已
授权主体之一；envelope 内脚本两两相异；对 `messageDigest` 的 P-256 签名有效；
数量 ≥ 配置阈值。重复密钥、非曲线点与非规范脚本拒绝。主体集合与阈值存于 0x57，
配 `subjectRevision`，每次主体变更（custody 门控、24 h 配置）推进。新账户注册必须
设置消息主体（默认可与 custody 相同）。

模块消息签名：`validatorId` = 实例 moduleId；仅限声明 `messageCapability` 的模块。
核心转发脱敏后的签名 payload 与 `originalSender`；执行额度 hook 绝不适用于不透明
消息哈希。SessionKeyValidator 与 SubscriptionValidator **默认不声明**任意消息能力。

## 9. 公共接口（两 kernel 命名一致）

查询：`getProtocolInfo`、`getAccount(accountId)`、`supportsModuleType(type)`、
`supportsExecutionMode(mode)`、`getModules(accountId, type, cursor, limit)`
（limit 1–32；返回下一 cursor 与当前 configurationNonce；cursor 基于 moduleId）、
`getModule(accountId, moduleId)`、
`isModuleInstalled(accountId, type, moduleHash, additionalContext)`、
`getHookOrder(accountId)`、`getPendingConfiguration(accountId, intentId)`、
`getNonce(accountId, validatorId, nonceSubkey)`（packed）、
`getNonceSequence(accountId, channel)`、
`getOperationDigest(accountId, operation)`、
`isValidSignature(accountId, hash, signatureEnvelope)`。

配置：`proposeConfiguration(accountId, actions, readSet)`、
`confirmConfiguration(accountId, intentId, actions)`、
`cancelConfiguration(accountId, intentId)`。

动作：`installModule`、`uninstallModule`、`configureModule`、`setHookOrder`、
`setDefaultPolicy`、`rebindModuleCode`、`setThresholdPolicy`、`setRecoveryPolicy`。
多动作意图是单一原子提案 —— 绝不是绕过时间锁的路径。

执行：`validateUserOp(accountId, operation)`（只读、真实验证、结构化结果）、
`executeUserOp(accountId, operation)`、`executeUserOps(accountId, operations)`、
`freezeAccount(accountId)`、`unfreezeAccount(accountId)`、`beginRecovery(...)`、
`cancelRecovery(accountId)`、`executeRecovery(accountId)`。

身份决定的 witness 入口 `verify(accountId)`（嵌入代理脚本）保留为真正的 witness
门，不是旧 API 别名。旧 `getVerifier`/`getHook`/`CallVerifier`/`CallHook`/`*Child`
表面在两 kernel 一并移除、不留别名。

生命周期模块回调（核心→模块）：`onInstall(accountId, moduleId, generation,
initData)`、`onUninstall(accountId, moduleId, generation, deInitData)`、
`configure(accountId, moduleId, generation, configData)`、hook 的
`preCheck`/`postCheck`、validator 的 `validateUserOp`/`onUserOpComplete`，均受 §11
预算约束。核心不再硬编码 `setPublicKey` 等按方法允许列表 —— 模块经核心配置门解码
自己的 `configData`。

## 10. 生命周期、pending 意图与时间锁

正常配置（空槽安装、卸载、hook 顺序调整、signer 变更、默认授权开关、代码重绑定）
—— 一律 **24 h 延迟**（86 400 000 ms）。

例外：
- 新账户注册原子安装完整初始配置（此前无资产与既有政策）；
- 紧急冻结立即；
- validator 凭证的 callback-free 撤销立即 —— 必须是核心定义的单向撤销（代数
  推进）；模块不得把“撤销”解释成授权；
- callback-free 恢复走账户 recoveryTimelock，不调用插件。

Pending 意图：每账户独立 `intentId`（0x51 内独立分配器）；未结束数 ≤16；
`proposedAt + 24 h = matureAt`；`expiresAt = matureAt + 7 天`（604 800 000 ms）。
意图绑定 authorityEpoch、精确动作摘要与有界读写集。同资源冲突（同模块修订、hook
顺序、默认政策、控制主体）不得并行；不同实例的独立配置可以并行。提交意图只使
冲突的过期意图失效，不是所有 pending。到期意图显式清理；成熟记录不得偷偷替换。
确认再要求 custody witness；引入新控制主体还要求新主体见证。

冻结语义：custody witness 可冻结；冻结后仅只读查询、恢复/逃生与 unfreeze 可达；
冻结推进代际（旧签名与意图失效）。最后一个 validator 规则：内建路由永远存在但受
默认政策门控 —— 卸载最后一个 validator 必须在同一 24 h 意图中启用内建路由，且既有
hook 继续运行；没有自动 owner fallback；仅紧急恢复可 callback-free 摘除全部政策。

恢复：核心内建；custody 自救 + 可选恢复 authority；每账户时间锁 7–90 天；恢复
意图不得被另一请求覆盖或重启；成熟后可 permissionless 执行已批准的精确结果；不
调用旧 verifier/hook/Market/Oracle；推进 authorityEpoch/configurationNonce、摘除
全部模块与政策、作废 pending、启用内建授权；旧永久 owner-only 标志迁移后继续有效。

## 11. gas 硬预算 profile（已批准方案 B）

单位：**datoshi**，1 GAS = 100 000 000 datoshi（与既有
`System.Contract.CallWithGasLimit` 用法同单位）。两 kernel 数值一致：

| 回调 | 每次调用硬预算 |
| --- | --- |
| 验证 aggregate（每账户每交易；被路由 validator 与全部阈值成员共享） | 100 000 000（1 GAS） |
| 每个 hook `preCheck` / `postCheck` | 250 000 000（2.5 GAS） |
| validator completion aggregate（被路由 validator + 获准阈值成员） | 100 000 000（1 GAS） |
| 每个生命周期/配置回调（`onInstall`、`onUninstall`、`configure`） | 250 000 000（2.5 GAS） |

语义：预算包含**全部后代调用**（whitelist 不可绕过）；经
`System.Contract.CallWithGasLimit` 强制；阈值验证共享父预算（成员预算绝不相加放大）；
核心调度与序列化 GAS 与回调预算分开核算。预算是上限不是保证 —— 合法最坏组合
必须在发布前测量（fixture 矩阵，§15）。1 GAS 验证 aggregate 为 1.5 GAS 总验证
上限之下的核心调度刻意留白。任何超限使整笔交易 fail-closed 失败；没有
try-and-continue。

## 12. 模块能力声明 profile

每个可安装模块附带 canonical profile JSON（profile 哈希进入 0x52 绑定）。Schema
（骨架见 `tests/fixtures/sa-module-protocol/module-profile.template.json`）：

```json
{
  "profileVersion": 1,
  "moduleType": "validator | hook",
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
- `thresholdMemberEligible` 标记可加入阈值政策的标量 validator。
- `compositeLayer` ≤ 1（单层；无嵌套/环）。

## 13. ERC 对齐边界

接口命名尽量对齐 ERC-7579/4337/1271（模块类型、`isValidSignature`、
`validateUserOp` 风格验证、`executeUserOp(s)`、安装/卸载生命周期事件）。
**协议不宣称 Ethereum 协议兼容：**
- Neo SA 不是 `PackedUserOperation`/`EntryPoint.handleOps`；同账户 batch 不是跨
  账户 bundler bundle。
- NeoVM nonce 域是**派生的 191 位 channel + 64 位 sequence**；ERC-4337 是自选
  key 的 192+64。
- ERC-7562 是 Ethereum mempool 验证规则集，不是 Neo 共识规则；Neo GAS 预算不是
  Ethereum verification gas 的换算。
- ERC-1271 语义（magic 值、只读、任意方案）作为 **Neo profile** 受尊重。

所有文档/UI 措辞规则：“职责与安全模型对齐的 Neo profile”，绝不写“完整兼容
ERC-4337/ERC-7579”。

## 14. 迁移 manifest（摘要 —— 完整设计见 docs/SA-MIGRATION-MANIFEST.md）

每账户分类：`no-plugin`、`scalar-plugin`、`multihook`、`multisig`、
`unknown-plugin`、`owner-only`、`market-locked`、`recovery-pending`。未知插件绝不
猜测迁移 —— 账户进入 `MigrationRequired`（执行与消息授权拒绝；查询、冻结与
callback-free 恢复保留）。迁移意图对 manifest 摘要幂等；0x01 旧五字段与原生
14-slot Array 仅作输入；旧 pending、旧签名、0x12 与 0x1C 绝非授权依据。

## 15. 共享常量文件与 fixture

| 工件 | 路径 |
| --- | --- |
| 普通版常量 | `contracts/custom/SmartAccount.ModuleProtocol.cs`（partial `SmartAccount`） |
| 原生版常量 | `contracts/native/SmartAccount/SmartAccountModuleProtocol.cs`（internal static `SmartAccountModuleProtocol`，经 `scripts/sync_native_smartaccount.py` 同步到 neo-native-core） |
| fixture 骨架 | `tests/fixtures/sa-module-protocol/`（README + schema + 模板） |

两个常量文件对以下数值保持一致：协议版本 4；模块类型码 1/4；§3 全部上限；13
字段 envelope 字段序号；nonce 尺寸（32 字节 subkey、24 字节 channel）；序列化上限
（4096/8192/4096/16384/65536）；时间锁（86 400 000 / 604 800 000 /
7 776 000 000 ms）；gas 预算（100 000 000 / 250 000 000 datoshi）；ERC-1271 magic
（0x1626ba7e / 0xffffffff）；域字符串（"NeoSmartAccount/UserOperation"、
"NeoSmartAccount/Message"）；存储前缀 0x50–0x5E；§17 错误码字符串；§18 事件显示
名；以及定宽大端键后缀编码（两个文件都提供相同键构建器：`UInt64ToBigEndian`
与各前缀复合键构建器）。

## 16. Kernel 实施映射（任务 #39 / #40）

### 16.1 普通 kernel（#39，与 #25 共享修改批次）

| 规范章节 | 普通版需创建/修改的文件 |
| --- | --- |
| §2/§3/§7 常量 | 消费 `contracts/custom/SmartAccount.ModuleProtocol.cs`（本批已加入 `SmartAccount.csproj`） |
| §7.1/§7.4 前缀 | 在 `SmartAccount.cs` STORAGE PREFIX MAP 注释中追加 0x50–0x5E 行；把 `SmartAccount.ModuleProtocol.cs` 加入 `tests/SmartAccount.Contracts.Tests/StoragePrefixMapTests.cs` 的 `WalletPartials`，**与首次键使用同一批次**（DeriveShape 要求使用证据） |
| §4/§5 envelope + 摘要 | `SmartAccount.Execution.cs`（13 字段解码、摘要、batch）；如拆分则新建 `SmartAccount.Intents.cs` |
| §6 nonce | `SmartAccount.Internal.cs`/新 nonce partial（0x56/0x5C，与旧 0x03 合并） |
| §8 消息 | `SmartAccount.State.cs`（内建 P-256 主体，0x57） |
| §9 接口+生命周期 | `SmartAccount.Accounts.cs`（custody+salt 注册身份、原子初始安装）、`SmartAccount.Internal.cs`/新 modules partial（0x51–0x53、0x5B）、**删除** `SmartAccount.HookChildren.cs` 与 `SmartAccount.VerifierChildren.cs`（改核心持有集合） |
| §10 意图 | 新 intents partial（0x55/0x5E） |
| §7.5 Market | `SmartAccount.MarketEscrow.cs`（0x5D 绑定、owner 不直写 0x1D、代际校验）、`SmartAccount.Escape.cs`（0x59 记录、callback-free 逃生） |
| F-1（verify scope） | `SmartAccount.VerifyContext.cs` —— 删除 `verifyScopeTarget` 授权、阶段门 |
| F-7（阶段门） | `SmartAccount.VerifyContext.cs` + `SmartAccount.Execution.cs`（0x58 上下文、只读回调用直接 caller + ReadOnly + 严格域检查） |
| 事件 | `SmartAccount.Events.cs`（§18 表；保留既有无 AA 事件） |
| 插件 | `contracts/plugins/verifiers/*`、`contracts/plugins/hooks/*` 按 §1.2 改名；MultiHook 停止安装 |

### 16.2 原生 kernel（#40，与 #29 共享修改批次）

| 规范章节 | 原生版需创建/修改的文件 |
| --- | --- |
| 常量 | 消费 `SmartAccountModuleProtocol.cs`（本批产出；随后运行 `scripts/sync_native_smartaccount.py` 物化 neo-native-core 副本） |
| §4/§5 envelope/摘要 | `SmartAccountProtocol.cs`（v4 域、13 字段序列化）、`SmartAccountEnvelope.cs`（13 字段操作） |
| §6 nonce | `SmartAccountProtocol.cs` + nonce 存储 partial（0x56/0x5C；与旧 0x20 合并） |
| §7 状态 | `SmartAccountState.cs`（新 0x51 记录；旧 14-slot decoder 仅保留用于迁移） |
| §2/§3 集合 | `SmartAccount.Modules.cs`（实例记录、枚举、hookOrder、阈值政策）、`SmartAccountModulePolicy.cs`（新上限） |
| §9/§10 生命周期与意图 | `SmartAccount.Modules.cs`、新 intents partial（0x55/0x5E） |
| §8 消息 | `SmartAccount.Keys.cs`（P-256 主体）、`SmartAccount.cs`（`isValidSignature` ABI） |
| §11 gas | `SmartAccount.Execution.cs`（CallWithGasLimit 预算 —— 核心 syscall 已存在） |
| F-7 阶段门 | `SmartAccountInvocationContext.cs`（精确 writer-phase 帧；validation/message 绝不可触达 post/configuration/cleanup 写） |
| §7.5 Market | 核心 0x5D/0x59 记录；Market 合约更新在 services 批次 |

### 16.3 跨 kernel 不变量（fixture 矩阵）

完整矩阵见 `tests/fixtures/sa-module-protocol/README.md`（源自设计报告 §5.4）：
同地址多实例安装；换 validator 不能跳过任何 hook；阈值成员不可独立路由；重复身份、
环、嵌套拒绝；post 仅对原获准快照集合执行；hook 正序/逆序及 false/FAULT 处理；
proof/args/hookData 篡改拒绝；空槽/卸载/最后 validator/默认政策的时间锁；pending
并发、冲突、成熟、过期、过期修订；冻结状态全 ABI 清扫；validation/message→
post/configuration/cleanup 提权攻击；contractId/updateCounter/NEF/profile 前后
漂移；撤销重授与市场出售重放；同 subId 重建新代数；未消费 recovery ticket 跨
clear/setup 重放（F-11）；恢复不依赖任何插件回调；无插件操作与内建消息签名；合约
custody 不能伪造消息签名；Verification 与 Application 分开的 gas 超限/不返回/
whitelist 路径；两网 53/407 真实账户迁移 fixture、全部旧前缀、MultiHook 顺序、
MultiSig 阈值、nonce 与代际单调性、0x12/0x1C 失效、中断与重复迁移。

## 17. 错误码

错误码为稳定字符串常量（`SA_*`），两 kernel 逐字共享；kernel 异常携带它们（可在
空格后附加细节后缀）。常量文件钉扎拼写。

| 错误码 | 含义 |
| --- | --- |
| `SA_PROTOCOL_VERSION` | 操作/envelope 版本 ≠ 4 |
| `SA_OPERATION_MALFORMED` | 非规范形态、尺寸、深度、排序、整数域 |
| `SA_OPERATION_FIELD_COUNT` | 字段数 ≠ 13 |
| `SA_MODULE_TYPE_UNSUPPORTED` | 模块类型非 1 或 4 |
| `SA_MODULE_LIMIT_VALIDATOR` / `SA_MODULE_LIMIT_HOOK` / `SA_MODULE_LIMIT_THRESHOLD` / `SA_MODULE_LIMIT_MEMBERS` / `SA_MODULE_LIMIT_ACTIONS` / `SA_MODULE_LIMIT_INTENTS` / `SA_MODULE_LIMIT_BATCH` | 超出 profile 上限 |
| `SA_MODULE_NOT_INSTALLED` | moduleId 未安装于该账户 |
| `SA_MODULE_ID_INVALID` | 模块路由 id 为 0 或未分配 |
| `SA_MODULE_INSTANCE_ISOLATION_REQUIRED` | 未声明 `instanceIsolation` 的同地址重装 |
| `SA_MODULE_CODE_BINDING_MISMATCH` | contractId/updateCounter/NEF/profile 漂移 |
| `SA_MODULE_NOT_ROUTABLE` | 阈值政策成员被直接路由 |
| `SA_MODULE_MESSAGE_CAPABILITY_ABSENT` | 模块缺少 `messageCapability` |
| `SA_VALIDATION_REJECTED` | validator 拒绝操作 |
| `SA_VALIDATOR_NOT_FOUND` | 被路由 validator/政策不存在 |
| `SA_HOOK_REJECTED` | hook pre/post 失败 |
| `SA_HOOK_DATA_TOO_LARGE` | hookData > 512 字节 |
| `SA_PROOF_INVALID` | hook proof 重复/乱序/超限 |
| `SA_NONCE_INVALID` / `SA_NONCE_EXHAUSTED` / `SA_NONCE_CHANNEL_COLLISION` | nonce 不匹配 / channel 死亡 / 191 位截断碰撞 |
| `SA_DEADLINE_EXPIRED` | 超过期限 |
| `SA_EPOCH_STALE` / `SA_CONFIGURATION_NONCE_STALE` / `SA_CREDENTIAL_STALE` | 签名绑定到已被取代的代际/nonce/凭证代 |
| `SA_INTENT_IMMATURE` / `SA_INTENT_EXPIRED` / `SA_INTENT_CONFLICT` / `SA_INTENT_NOT_FOUND` / `SA_INTENT_LIMIT` | 意图生命周期违规 |
| `SA_ACCOUNT_NOT_FOUND` / `SA_ACCOUNT_FROZEN` / `SA_ACCOUNT_STATUS` | 账户状态门 |
| `SA_RECOVERY_PENDING` / `SA_RECOVERY_LOCKED` | 恢复进行中 / 时间锁内 |
| `SA_REENTRANCY_FORBIDDEN` | 同账户或跨账户嵌套执行 |
| `SA_PHASE_VIOLATION` | 回调在其 writer 阶段之外被调用 |
| `SA_GAS_BUDGET_EXCEEDED` | 回调超出 §11 预算（fail-closed） |
| `SA_MESSAGE_INVALID` | 消息 envelope 失败（返回 magic-invalid；畸形输入亦可抛出） |
| `SA_MIGRATION_REQUIRED` | 账户未迁移；执行/消息被拒 |
| `SA_MARKET_LOCKED` | Market 动作的 0x5D 代际绑定不匹配 |
| `SA_UNAUTHORIZED` | caller/主体 witness 失败 |

## 18. 事件表

沿用的既有（无 AA）事件：`AccountRegistered`、`ModuleInstalled`、
`ModuleUpdateInitiated`、`ModuleUpdateConfirmed`、`ModuleUpdateCancelled`、
`ModuleRemoved`、`MetadataUriUpdated`、`UserOpExecuted`、`EscapeInitiated`、
`EscapeCancelled`、`EscapeFinalized`、`MarketEscrowEntered`、
`MarketEscrowCancelled`、`MarketEscrowSettled`、`SponsoredUserOpExecuted`。

`VerifyScopeTargetSet` 随 F-1 修复**退役**。

新增模块模型事件（显示名钉扎于常量文件；payload 顺序固定）：

| 事件 | Payload |
| --- | --- |
| `ModuleInstanceInstalled` | accountId, moduleId, moduleType, contractHash, credentialGeneration |
| `ModuleInstanceConfigured` | accountId, moduleId, credentialGeneration |
| `ModuleInstanceRemoved` | accountId, moduleId |
| `ModuleCodeRebound` | accountId, moduleId, bindingDigest |
| `HookOrderSet` | accountId, hookOrderRevision, hookIds |
| `ThresholdPolicySet` | accountId, policyId, threshold, memberIds |
| `ConfigurationIntentProposed` | accountId, intentId, actionCount, actionDigest |
| `ConfigurationIntentConfirmed` | accountId, intentId, configurationNonce |
| `ConfigurationIntentCancelled` | accountId, intentId |
| `ConfigurationIntentExpired` | accountId, intentId |
| `CredentialRevoked` | accountId, moduleId, credentialGeneration |
| `NonceChannelOpened` | accountId, channelDigest |
| `NonceChannelExhausted` | accountId, channelDigest |
| `MessageSubjectUpdated` | accountId, subjectCount, threshold, subjectRevision |
| `AccountFrozen` | accountId, authorityEpoch |
| `AccountUnfrozen` | accountId, authorityEpoch |
| `RecoveryInitiated` | accountId, newCustody, matureAt |
| `RecoveryCancelled` | accountId |
| `RecoveryExecuted` | accountId, authorityEpoch, configurationNonce |
| `MarketControlEpochBound` | accountId, listingId, controlEpoch |
| `MarketLockInvalidated` | accountId, controlEpoch |
| `CoreRecoveryRecorded` | accountId, matureAt |
| `MigrationRequired` | accountId, legacyModuleCount |
| `MigrationImported` | accountId, manifestDigest, classification |

每个生命周期转换恰好发出一个事件；安装/卸载失败即抛出（无部分提交的事件对）。

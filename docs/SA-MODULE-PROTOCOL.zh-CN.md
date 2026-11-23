# SA 模块协议 —— 共同规范（协议版本 4）

本文件是 Neo Smart Account（SA）模块模型的**唯一共同规范**，由 native kernel 批次实施：

- 原生合约版 kernel —— 任务 #40（`contracts/native/SmartAccount/`）
- 已退役的 custom kernel —— 任务 #39，归档交付记录

本文定义的 DTO、profile、存储布局、上限、错误码、事件与 gas 预算，是核心与每个模块之间的
契约；任何实现不得偏离或自行重新设计。凡运行时确有差异之处（如 caller/阶段门实现机制），
必须作为披露的能力差异显式列出，绝不允许表现为 DTO 分叉。

状态：**已交付规范 + 共享常量 + fixture + native kernel。**
`contracts/native/SmartAccount` 已实现本文描述的表面；
`tests/SmartAccount.Native.Tests` 覆盖它，并对
`tests/SmartAccount.Native.Tests/TestFile/smartaccount-v4-vectors.json` 中的共享向量
做断言。曾经实现同一表面的第二个 kernel 已退役，因此本文与其向量是唯一的共享契约。
本文不声称该源码已在链上部署；形式化模型的状态单独记录在
`docs/engineering/VERIFICATION-AND-GATES.md`（仅英文，SA 形式化验证章）。

配套文档：

- `docs/SA-MODULE-PROTOCOL.md` —— 英文对应版本（与本文共同权威；如有出入，以两份
  较新的修订为准）。
- `docs/engineering/VERIFICATION-AND-GATES.md` —— SA 迁移 manifest 章（旧→新设计；§14 为摘要）。
- `tests/fixtures/sa-module-protocol/README.md` —— golden 向量/拒绝回归 fixture
  格式与 kernel 验证矩阵。
- `contracts/native/SmartAccount/SmartAccountModuleProtocol.cs` ——
  常量文件，承载本文全部数值（§15）。

## 1. 范围与术语迁移

### 1.1 术语

旧模型的授权决策模块名为 `verifier`。协议 v4 采用 ERC-7579 术语 **validator**；
`hook` 名称不变。合约 API、存储、事件与错误码一律使用 `validator`/`Validator`；
旧 `verifier`/`Verifier` 名称移除且不保留别名（仅身份决定的 witness 入口
`verify(accountId)` 保留，因其嵌入代理脚本 —— 见 `docs/SDK.zh-CN.md` 与
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

**hook 顺序。** 核心从账户已安装的 hook 索引（0x53）按 moduleId 升序取得 `hookOrder`，
最多 8 项。所有授权路径都执行这份列表。执行时：

- `preCheck` 按**列表正序**执行；
- `postCheck` 对**同一快照按逆序**执行。

顺序基于快照：执行期间重入的配置变更不会改变在途序列。签名绑定 hook proof 摘要
（§5），签名者看到的 hook 集合与实际运行的集合不可能不一致。

设置恢复策略需要现管理方签署。更换非零恢复地址时，新地址也须签署；保留原恢复地址不需要重复同意。恢复席位可在 Active 或 Frozen 完成已成熟的恢复，MigrationRequired 不可恢复。

原生重置只接受已安装、代码绑定仍有效的恢复模块直接调用。标准恢复模块在提议时要求新托管方提供见证；钱包确认的取消和执行还绑定待办编号与核心配置 nonce。第三方恢复模块需要独立证明准入与延迟规则。

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
stack-item 序列化，其中 `[11] signature` 替换为**空 ByteString**。custom kernel 用
`StdLib.Serialize` 生成，原生 kernel 用 `Neo.VM.BinarySerializer.Serialize` 生成；
两个序列化器对这些形态产生相同字节，golden 向量（§15 fixture 集）钉扎该相等性。

### 4.3 操作摘要与签名域

```
domain := UTF8("NeoSmartAccount/UserOperation")        // 29 字节
         || U1 (version = 4)
         || U32LE (network magic)
         || coreHash, 20 原始字节（*实际*执行核心哈希；
                       custom kernel 不得替换为原生 ServiceHash 常量，反之亦然)
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
| TeeKeyValidator | enclave key id + attested 签名 blob |
| Web3AuthValidator | EIP-712 风格 typed payload，见 `docs/SDK.zh-CN.md`（域名 `"Neo Smart Account"`），64 字节紧凑签名 |
| P256Validator（原 WebAuthn） | 裸 P-256 `r‖s`（64 字节），对实例配置密钥 |
| DelegatedIdentityValidator（原 ZkLogin） | 配置 P-256 signer 签名 + 身份承诺 |
| 内建（validatorId = 0） | §8 消息 profile 复用于操作模式：canonical P-256 脚本 + 签名，阈值按 0x57 |

阈值路由：`validatorId` 指向阈值政策时，核心在**共享父验证预算**下逐个直接调用
成员 validator，批准收据保存在核心调用局部状态；`postCheck` 阶段仅对验证阶段
获准成员执行 completion。成员必须是标量 validator；同一成员不得加入两个活动政策；
被政策引用的成员在被引用期间不可卸载。成员侧在自己的 0x52 记录里携带指向活动政策
的反查指针（`activePolicyId`，§7.1），由政策执行器在每次激活、重写和解激活时维护；
因此路由与卸载检查只读一条实例记录，无需扫描账户下全部政策；解激活政策会清掉指针，
成员随之释放，不需第二轮扫描。

## 6. nonce channel 与命名空间派生

- channel := `SHA256( U1(4) || coreHash || accountId || U64BE(authorityEpoch) ||
  U64BE(validatorId) || U64BE(credentialGeneration) || nonceSubkey )` 的**低 191 位**。
- channel 是**派生的，不是自选的**。`nonce` 低 64 位是 sequence；必须等于存储
  游标（或耗尽哨兵）。
- 存储键中的 channel 字节为 24 字节，大端，`channel[0] = digest[8] & 0x7F`（只清最高 1 位，共 191 位）。
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

### 6.1 各路由绑定的代次

`credentialGeneration` 不是全局计数器：它标识路由主体当前的凭证集合，由核心按路由
解析（绝不是调用方给的默认值；内置路由的代次也没有任何 ABI 方法对外发布）。

| 路由 | 绑定的代次 | 记录 |
| --- | --- | --- |
| 内置（`validatorId` = 0） | 账户的 `SubjectRevision` | 0x57 |
| 已安装验证器实例 | 该实例的 `CredentialGeneration` | 0x52 |
| 生效中的阈值策略 | 策略的 `CredentialGeneration` | 0x5B |

两 kernel 共同成立的推论：

- 内置代次**不是**固定的 1。每次主体变更都推进 `SubjectRevision`（§8.3），客户端
  硬编码 1 会派生出核心在修订号推进后永不能重现的通道。无 0x57 主体记录的账户仍
  处于代次 1。
- 已安装实例从代次 1 开始，只在 `revokeCredentials` 时推进——那是 custody 授权、
  无回调的即时撤销，一次废弃所有绑定旧代次的签名。重新绑定模块代码推进的是
  `moduleRevision`，不是凭据代次。
- 阈值策略的代次跨重写单调（新策略写入时为代次 1；每次重写携带旧值再自增），因此
  重塑后的策略会杀死上一代的通道，且永不重置为 1。
- 因为代次在 §4.3 的签名域内，过期值不是可重试的 nonce 不匹配。已安装验证器或阈值策略
  路由以 `SA_CREDENTIAL_STALE` 故障；内置路由则以自身的无效签名结果拒绝该消息，因为代次
  在比较任何主体之前就已经与 `SubjectRevision` 比对。
- `getNonce` 在核心内部解析代次并返回核心会使用的通道。调用方可自行交叉校验，但以
  核心的答案为准。

## 7. 存储布局规划

### 7.1 共享 0x50–0x5F 区域（两 kernel，键字节一致）

键构造：1 字节前缀 ‖ 原始 20 字节 accountId ‖ 注明处的定宽**大端**整数后缀。
0x5F 保留不分配。

| 前缀 | 键后缀 | 用途 |
| --- | --- | --- |
| 0x50 | bare | 协议版本、布局版本、激活状态、profile 摘要 |
| 0x51 | +acctId | 账户控制元数据（§7.2） |
| 0x52 | +acctId+moduleId[8 BE] | 模块实例记录（type[1]、contractHash、contractId、updateCounter、nefSha256、profileSha256、moduleRevision、credentialGeneration、能力标志、activePolicyId） |
| 0x53 | +acctId+type[1]+moduleId[8 BE] | 安装实例枚举索引（marker 行；按类型升序 moduleId 扫描） |
| 0x54 | +acctId | 保留；有效顺序取自 0x53 的 hook 索引，修订号在 0x51 |
| 0x55 | +acctId+intentId[8 BE] | 配置意图记录 |
| 0x56 | +acctId+channel[24 BE] | nonce 游标（新编码） |
| 0x57 | +acctId | 内建消息签名主体（≤16 个 20 或 32 字节主体，阈值）+ subjectRevision（§8.1） |
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
同地址重部署不继承授权。逐回调检查只比较 `(ContractId, UpdateCounter)`：这对值唯一
对应一个（部署槽位、版本），与记录里安装时钉过的 NEF 哈希等价，但不必在每个回调里
重算 NEF 哈希。

### 7.4 旧区域

**custom kernel：**
- 0x01 旧五字段 AccountState 行**保留作迁移输入/历史证据**；新状态只写 0x51。
  新代码绝不经旧 Verifier/HookId 字段路由；legacy decoder 仅为迁移存在。
- 0x12 与 0x1C **退役**：新授权绝不源自它们。迁移意图为账户的 0x12/0x1C 行记录
  显式失效声明（存于 0x5A）；这些字节永不重新分配。

**原生 kernel：** 0x10 账户键下的旧 14-slot Array 仍是迁移输入；迁移后由新
0x51 记录取代。0x10/0x11/0x20/0x30/0x40 旧前缀不被新模块模型重新解释。

### 7.5 Market 最小锁（0x5D / 0x59）

- 0x06 / 0x07 / 0x1D 仍为 **Market 独占的物理标记写入**（Market 入口写入或删除；
  其他一律不可 —— 现有 owner 侧 `initiateMarketEscrowCancel` 直写 0x1D 与
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
         || coreHash, 20 原始字节
         || accountId (20 原始字节)
         || originalSender, 20 原始字节
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

### 8.1 0x57 的两个键

每个账户的主体存储占两个键，宽度故意不同：

| 键 | 字节数 | 含义 |
| --- | --- | --- |
| `0x57 ‖ accountId` | 21 | canonical 主体行：`MessageSubjectRecord`（≤16 个主体、阈值、`SubjectRevision`） |
| `0x57 ‖ accountId ‖ 0x01` | 22 | 内部 provenance 标记，绝不是第二条主体行 |

canonical 行保持 **21 字节**：改成 22 会移动所有既有账户的记录，并把一个已评审的键
变成另一个键。标记复用 canonical 前缀加一字节后缀，而不另占一个协议前缀，且只由核心
写入与删除。

### 8.2 主体匹配

主体条目绑定的是签名者**脚本**，接受两种宽度：

- 32 字节主体是签名者验证脚本的裸 `SHA256`，必须精确相等；
- 20 字节主体是签名者的账户地址（`RIPEMD160(SHA256(script))`，即 N3 script hash），
  必须精确相等。

其他宽度一律不匹配。两种形态都对应同一套对 `messageDigest` 的 ECDSA 校验，因此同一
账户可以混用；注册写入的是 20 字节形态，因为 canonical P-256 custody 脚本的哈希正好
就是 custody 地址，该密钥因此无需等待 24 小时的主体意图即可立即签发内建消息。

### 8.3 custody 派生的主体与 provenance

注册写入 `Subjects = [custody]`、阈值 1、`SubjectRevision` 1，并置上 22 字节的
provenance 标记。custody 轮换时，核心只在**该标记存在**的情况下把主体集合改写为新
custody 并推进 `SubjectRevision`：

- 标记缺失意味着 provenance 未知：主体集合既可能是（通过主体意图）显式配置的，也可能是早于
  该标记的历史默认主体状态。运行时对两者都不做推断——它只是不改写——且即便某个主体恰好等于
  旧 custody 地址，也不会被解读为显式委托的证据：绝不用地址相等来推断 provenance；
- 标记存在但取值异常属于完整性故障，而不是轮换信号；
- 轮换会以新修订号发出主体更新事件，因此内置凭据代次随主体集合一同推进。Escape
  （§7.5）与账户拆除会删除这两个键。

## 9. 公共接口（两 kernel 命名一致）

查询：`getProtocolInfo`、`getAccount(accountId)`、`getAccountAddress(accountId)`、`supportsModuleType(type)`、
`supportsExecutionMode(mode)`、`getModules(accountId, type, cursor, limit)`
（limit 1–32；返回下一 cursor 与当前 configurationNonce；cursor 基于 moduleId）、
`getModule(accountId, moduleId)`、
`isModuleInstalled(accountId, type, moduleHash, additionalContext)`、
`getAuthorizedModuleId(accountId, phase)`、
`getNonce(accountId, validatorId, nonceSubkey)`（packed）、
`getNonceSequence(accountId, channel)`、
`getOperationDigest(accountId, operation)`。

配置：`installModule(accountId, moduleType, moduleContractHash, initData)` 与
`removeModule(accountId, moduleId, deInitData)`，两者都由托管见证或某个已安装验证器实例的见证授权，
且都会推进配置 nonce。核心不保留意图记录、没有成熟窗口、没有取消路径：
那些属于治理模块，由它通过这两个方法提交成熟后的调用。

动作：核心只执行两个动作码，`installModule` 与 `uninstallModule`，
注册通过两个模块方法所用的同一个执行器跑它们。v3 kernel 携带的其他每个动作码都已移除 ——
仍组装它们的脚本会以 `SA_OPERATION_MALFORMED` 被拒绝，而不是被静默忽略。

执行：`validateUserOp(accountId, operation)`（只读、真实验证、结构化结果）、
`executeUserOp(accountId, operation)`、`executeUserOps(accountId, operations)`、
`freezeAccount(accountId)`、`unfreezeAccount(accountId)`。恢复是一个模块：
`beginRecovery`、`cancelRecovery` 与 `executeRecovery` 是那个模块的方法，
核心一个都不暴露。

身份决定的 witness 入口 `verify(accountId)`（嵌入代理脚本）保留为真正的 witness
门，不是旧 API 别名。旧 `getVerifier`/`getHook`/`CallVerifier`/`CallHook`/`*Child`
表面在两 kernel 一并移除、不留别名。

生命周期模块回调（核心→模块）：`onInstall(accountId, moduleId, generation,
initData)`、`onUninstall(accountId, moduleId, generation, deInitData)`、
`configure(accountId, moduleId, generation, configData)`、hook 的
`preCheck`/`postCheck`、validator 的 `validateUserOp`/`onUserOpComplete`，均受 §11
预算约束。核心不再硬编码 `setPublicKey` 等按方法允许列表 —— 模块经核心配置门解码
自己的 `configData`。

### 9.1 编译产物的回调 ABI

manifest 方法名是 C# 方法名首字母小写（`OnInstall` → `onInstall`、
`ValidateUserOp` → `validateUserOp`）。`preCheck` 的参数名为 `operation`；
`postCheck` 的最后一个参数名为 `hookData`。下表类型均为 manifest 参数类型。

| 方向 | 操作 | manifest ABI | 说明 |
| --- | --- | --- | --- |
| module→core | `getModuleProfile()` | `→ String`，**safe** | canonical profile 字节，≤ 2048 字节，无参数、不可写。 |
| core→module | `onInstall(accountId, moduleId, generation, initData)` | `Hash160, Integer, Integer, Array → Void` | `initData` 是命令数组（见 §9.3）或空数组。 |
| core→module | `configure(accountId, moduleId, generation, configData)` | `Hash160, Integer, Integer, Array → Void` | 同一命令形态；在配置阶段执行。 |
| core→module | `onUninstall(accountId, moduleId, generation, deInitData)` | `Hash160, Integer, Integer, Array → Void` | 必须清空 `(accountId, moduleId)` 的全部实例键。 |
| core→module（validator） | `validateUserOp(accountId, operationDigest, operation)` | `Hash160, ByteArray, Array → Boolean`，**safe** | `operationDigest` 为 §4.3 核心摘要；`operation` 为 canonical 13 字段视图。 |
| core→module（validator） | `onUserOpComplete(accountId, operation, result)` | `Hash160, Array, Any → Void` | 仅 completion 阶段；`result` 是净化后的目标返回值。 |
| core→module（hook） | `preCheck(accountId, operation)` | `Hash160, Array → ByteArray` | 返回本实例的 `hookData`；`null` 归一化为空字节串；最多 512 字节，否则 `SA_HOOK_DATA_TOO_LARGE`。 |
| core→module（hook） | `postCheck(accountId, operation, result, hookData)` | `Hash160, Array, Any, ByteArray → Void` | 收到的正是同一实例 `preCheck` 返回的字节，绝不是另一实例的。 |
| core→module（validator，`messageCapability`） | `isValidSignature(accountId, originalSender, validatorId, generation, hash, signatures)` | `Hash160, Hash160, Integer, Integer, ByteArray, Array → Boolean`，**safe** | `hash` 是核心域绑定的模块消息摘要，直接验证。调用方被限制为 `ReadOnly`。 |

安装时的检查顺序：profile 摘要 → profile 解析（版本、模块类型、合约名、能力）→
上述完整回调面。缺方法在写入实例前就失败；`getModuleProfile` 与验证/消息回调必须
声明为 `safe`，因此调用方即使传入写标志也无法从其中写入。hook pre/post 按设计可写
（它们要计量余额），但只使用自身实例键。

回复按类型严格判定，不做强制转换（§11）。`validateUserOp` 只有恰好返回 `Boolean true`
才表示批准；其他任何回复类型都是 ABI 违约，以 `SA_MODULE_TYPE_UNSUPPORTED` 失败，
执行路径与只读预览一致。`isValidSignature` 绝不失败——ERC-1271 必须 fail-closed——
因此非 `Boolean` 的回复与 `Boolean false` 等价。`preCheck` 回复必须是 `ByteArray`
（否则同样视为 ABI 违约），`getModuleProfile` 回复必须是 `String`，否则安装以
`SA_MODULE_CODE_BINDING_MISMATCH` 失败；所有返回 `Void` 的回调必须把求值栈清空。

### 9.2 实例鉴权（模块侧）

模块从不信任调用方声明的实例，按以下顺序解析：

1. `authorizedCore()`（模块存储）必须等于 `Runtime.CallingScriptHash`；为零或非法
   核心时以 `SA_CORE_NOT_CONFIGURED` 失败，其他调用方以 `Unauthorized caller` 失败。
2. 核心通过 `getAuthorizedModuleId(accountId, phase)` 回答当前寻址的实例。阶段为
   `Validation 1`、`HookPre 2`、`TargetDispatch 3`、`HookPost 4`、`Completion 5`、
   `Configuration 6`；返回 `0` 表示该阶段不寻址本模块。生命周期回调仅当阶段 6
   返回值与收到的 `moduleId` 完全相等时才获授权。
3. `validateUserOp` 在只读预览期执行时没有 writer 阶段，模块改用
   `operation[validatorId]`（索引 7）作为实例 id。
4. `getModule(accountId, moduleId)` 返回描述符
   `[moduleId, moduleType, contractHash, contractId, updateCounter, nefSha256,
   profileSha256, moduleRevision, credentialGeneration, instanceIsolation,
   messageCapability, thresholdMemberEligible]`。索引 8
   （`credentialGeneration`）把阈值成员的签名绑定到它自己的实例。
5. 持有资产的脚本哈希：custom kernel 用 `getProxyScriptHash(accountId)`，原生 kernel
   用 `getAccountAddress(accountId)`。

实例键为 `prefix（1 字节）‖ accountId（20 字节）‖ moduleId（8 字节大端）`；
模块绝不以调用方提供的 context blob 为键。

### 9.3 配置命令数组

`initData`、`configData`、`deInitData` 都是 `[command, ...args]` 数组。命令词汇由
模块自己拥有；核心只约束数组上限（≤ §3 参数上限）与 2.5 GAS 生命周期预算。
随仓库发布的模块使用：

| 模块 | 命令 |
| --- | --- |
| `P256Validator`、`Web3AuthValidator`、`TeeKeyValidator` | `setPublicKey(publicKey)` —— 33 字节压缩或 65 字节未压缩，存储为压缩形式。 |
| `NeoWitnessValidator` | `setSigners(signers[], threshold)` |
| `MultiSigValidator` | `setMemberKey(publicKey)` —— 每实例一把密钥。 |
| `SessionKeyValidator` | `setSessionKey(publicKey, target, method, expiry, cap, subId)` / `clearSessionKey()` |
| `SubscriptionValidator` | `createSubscription(publicKey, payee, token, amount, period)` / `cancelSubscription(subId)` |
| `DelegatedIdentityValidator` | `setConfig(publicKey, provider, masterNullifier)` |
| `ZKEmailVerifier` | 无 —— 证明验证器尚未部署，所有回调 fail-closed。 |
| `ActionSessionValidator` | `setRecoveryService(service)` / `clearRecoveryService()` |
| `DailyLimitHook` | `setDailyLimit(token, maxAmount, useRollingWindow)` / `clearDailyLimit(token)` |
| `TokenRestrictedHook` | `restrictToken(token)` / `unrestrictToken(token)` |
| `WhitelistHook` | `allowTarget(target)` / `denyTarget(target)` |
| `NeoDIDCredentialHook` | `requireCredential(target, provider, claimType, commitment)` / `clearRequirement(target)` |
| `MultiHook` | 无 —— 已退役，安装被拒（§1.2）。 |

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

冻结语义：custody witness 可冻结；冻结后仅只读查询、恢复/逃生与 unfreeze 可 达；
`freezeAccount` 立即生效，而 `unfreezeAccount` 只提议解冻意图，由 `confirmConfiguration`
在统一 24 h 延迟后执行 —— 处于 `MigrationRequired` 的账户永远不能解冻；
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

| 回调 | 硬预算 |
| --- | --- |
| 每次 `validateUserOp` 调用（被路由 validator 或单个阈值成员） | 100 000 000（1 GAS） |
| 验证 aggregate（每账户每交易；被路由 validator 与全部阈值成员共享） | 100 000 000 × (1 + 10) = 1 100 000 000（11 GAS） |
| 每次 `onUserOpComplete` 调用（被路由 validator 或单个获准成员） | 100 000 000（1 GAS） |
| completion aggregate（被路由 validator + 获准阈值成员） | 100 000 000 × (1 + 10) = 1 100 000 000（11 GAS） |
| 每个 hook `preCheck` / `postCheck` | 250 000 000（2.5 GAS） |
| hook aggregate（每账户每交易） | 250 000 000 × 8 = 2 000 000 000（20 GAS） |
| 每个生命周期/配置回调（`onInstall`、`onUninstall`、`configure`） | 250 000 000（2.5 GAS） |

语义：预算包含**全部后代调用**（whitelist 不可绕过）；经
`System.Contract.CallWithGasLimit` 强制；阈值验证共享父预算（成员预算绝不相加放大）；
核心调度与序列化 GAS 与回调预算分开核算。预算是上限不是保证 —— 合法最坏组合
必须在发布前测量（fixture 矩阵，§15）。

**为什么 aggregate 是「单次上限 × 重数」。** aggregate 必须至少容纳一整轮
*最大* 合法验证，否则核心宣称的重数根本不可达。把验证 aggregate 固定为 1 GAS
会让任何含两个 P-256 成员的策略不可用：实测单个成员回调已花掉它的一半以上，
而两个成员的轮次直接以 `SA_GAS_BUDGET_EXCEEDED` 失败，尽管核心允许
`MaxThresholdPolicyMembers = 10` 个共签者。因此两个 validator aggregate 都按
`单次上限 × (1 + MaxThresholdPolicyMembers)` 取值，与 hook 池原本就采用的规则
（`HookCallbackGasLimit × MaxHookModuleInstances`）一致。由于单次回调的计费
永不超过自己的上限，一整轮最多计入 `(1 + 10) × 1 GAS` —— 合法配置永远不会
耗尽池，个体模块的边界仍由单次上限而非池承担。参考构建上实测一整笔
`executeUserOp`（含核心调度）的端到端成本：1 成员 3.0 GAS、2 成员 4.4 GAS、
3 成员 5.8 GAS、10 成员 15.4 GAS。

任何超限使整笔交易 fail-closed 失败；没有 try-and-continue。

### 11.1 数值位置与覆盖范围

内核把单次上限钉在协议常量文件里
（`contracts/native/SmartAccount/SmartAccountModuleProtocol.cs`）：
`ValidationPerCallGasLimit = 100_000_000`、`CompletionPerCallGasLimit =
100_000_000`、`HookCallbackGasLimit = 250_000_000`、
`LifecycleCallbackGasLimit = 250_000_000`。两个 validator aggregate 由这些上限与
`MaxThresholdPolicyMembers` 计算得出（kernel 模块分区的
`ValidationAggregateGasLimit()` / `CompletionAggregateGasLimit()`；hook aggregate
是 `HookAggregateGasBudget()`）。

决定最坏情况的边界也在同一批文件：`HookDataBytesMax = 512`、
`ModuleProfileBytesMax = 2048`、`ArgsCountMax = 64`、`HookProofsEntriesMax = 8`、
`HookProofBytesMax = 4096`（聚合）、`OperationEncodedSizeMax = 16384`、
`EnvelopeEncodedSizeMax = 65536`。

- `getModuleProfile` 按生命周期回调计费（2.5 GAS），以 `CallFlags.ReadStates`
  执行：profile 不能读余额、不能调用其他合约、不能写。
- 每个 hook 回调有自己的 2.5 GAS 上限；一个 hook 的剩余预算绝不结转到下一个。
  `preCheck` 按 `hookOrder` 升序执行，`postCheck` 对同一获准集合逆序执行。
- 验证 aggregate 覆盖一笔交易内的全部 validator 调用（含阈值成员）；completion
  另有自己的 1 GAS aggregate。
- 返回值 ABI 类型不对的回调在 manifest 检查时失败，而不是 gas：核心不做类型强转。

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
因为已退役的 `contracts/compile.sh` 不再把它链接进编译流程。

绑定顺序与失败模式（两 kernel 一致）：

1. `getModuleProfile` 必须存在且为 `safe` → 否则 `SA_MODULE_CODE_BINDING_MISMATCH`。
2. `SHA-256(返回字节)` 必须等于安装动作里的 `profileDigest32` → 否则
   `SA_MODULE_CODE_BINDING_MISMATCH`。
3. `profileVersion` 必须为 1，`moduleType` 必须与请求类型一致，`contractName` 必须
   等于 manifest 名，四个能力键必须齐全 → 否则
   `SA_MODULE_CODE_BINDING_MISMATCH` 或 `SA_MODULE_TYPE_UNSUPPORTED`。
4. hook profile 声称 `messageCapability` 或 `thresholdMemberEligible` 时以
   `SA_MODULE_TYPE_UNSUPPORTED` 失败；`compositeLayer` 超出 0–1 同样失败。
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

`Web3AuthValidator` 是唯一实现 `isValidSignature` 的已发布 validator；声称
`messageCapability` 却没有该方法的 profile 仍会在 §9.1 绑定失败。

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

## 14. 迁移 manifest（摘要 —— 完整设计见 docs/engineering/VERIFICATION-AND-GATES.md 的 SA 迁移 manifest 章）

每账户分类：`no-plugin`、`scalar-plugin`、`multihook`、`multisig`、
`unknown-plugin`、`owner-only`、`market-locked`、`recovery-pending`。未知插件绝不
猜测迁移 —— 账户进入 `MigrationRequired`（执行与消息授权拒绝；查询、冻结与
callback-free 恢复保留）。迁移意图对 manifest 摘要幂等；0x01 旧五字段与原生
14-slot Array 仅作输入；旧 pending、旧签名、0x12 与 0x1C 绝非授权依据。

## 15. 共享常量文件与 fixture

| 工件 | 路径 |
| --- | --- |

| 原生版常量 | `contracts/native/SmartAccount/SmartAccountModuleProtocol.cs`（internal static `SmartAccountModuleProtocol`，经 `scripts/sync_native_smartaccount.py` 同步到 neo-native-core） |
| fixture 骨架 | `tests/fixtures/sa-module-protocol/`（README + schema + 模板） |

常量文件钉住以下数值：协议版本 4；模块类型码 1/4；§3 全部上限；13
字段 envelope 字段序号；nonce 尺寸（32 字节 subkey、24 字节 channel）；序列化上限
（4096/8192/4096/16384/65536）；时间锁（86 400 000 / 604 800 000 /
7 776 000 000 ms）；gas 预算（100 000 000 / 250 000 000 datoshi）；ERC-1271 magic
（0x1626ba7e / 0xffffffff）；域字符串（"NeoSmartAccount/UserOperation"、
"NeoSmartAccount/Message"）；存储前缀 0x50–0x5E；§17 错误码字符串；§18 事件显示
名；以及定宽大端键后缀编码（两个文件都提供相同键构建器：`UInt64ToBigEndian`
与各前缀复合键构建器）。

## 16. Kernel 实施映射

> 下方的 #39 表是已退役 custom kernel 的交付记录归档；仍描述本仓库的是 #40 映射。

### 16.1 已退役的 custom kernel（#39，归档交付记录）

| 规范章节 | custom 版需创建/修改的文件 |
| --- | --- |
| §2/§3/§7 常量 | 消费随已退役 custom kernel 一起发布的常量文件（`SmartAccount.ModuleProtocol.cs`） |
| §7.1/§7.4 前缀 | 在 `SmartAccount.cs` STORAGE PREFIX MAP 注释中追加 0x50–0x5E 行；把 `SmartAccount.ModuleProtocol.cs` 加入 `tests/SmartAccount.Contracts.Tests/StoragePrefixMapTests.cs` 的 `WalletPartials`，**与首次键使用同一批次**（DeriveShape 要求使用证据） |
| §4/§5 envelope + 摘要 | `SmartAccount.Execution.cs`（13 字段解码、摘要、batch）；如拆分则新建 `SmartAccount.Intents.cs` |
| §6 nonce | `SmartAccount.Internal.cs`/新 nonce partial（0x56/0x5C，与旧 0x03 合并） |
| §8 消息 | `SmartAccount.State.cs`（内建 P-256 主体，0x57） |
| §9 接口+生命周期 | `SmartAccount.Accounts.cs`（custody+salt 注册身份、原子初始安装）、`SmartAccount.Modules.cs`（0x51–0x53、0x5B；`AssertModuleCallbackAbi`、`BindModuleProfile`、hook pre/post 调度）、`SmartAccount.State.cs`（`getModule`/`getModules` 描述符）、`SmartAccount.Message.cs`（模块 `isValidSignature` 路由）；不再保留 `HookChildren`/`VerifierChildren` 适配 partial |
| §10 意图 | 新 intents partial（0x55/0x5E） |
| §7.5 Market | `SmartAccount.MarketEscrow.cs`（0x5D 绑定、owner 不直写 0x1D、代际校验）、`SmartAccount.Escape.cs`（0x59 记录、callback-free 逃生） |
| F-1（verify scope） | `SmartAccount.VerifyContext.cs` —— 删除 `verifyScopeTarget` 授权、阶段门 |
| F-7（阶段门） | `SmartAccount.VerifyContext.cs` + `SmartAccount.Execution.cs`（0x58 上下文、只读回调用直接 caller + ReadOnly + 严格域检查） |
| 事件 | `SmartAccount.Events.cs`（§18 表；保留既有无 AA 事件） |
| 插件 | `contracts/plugins/validators/` —— 9 个 validator（`P256Validator`、`Web3AuthValidator`、`TeeKeyValidator`、`NeoWitnessValidator`、`DelegatedIdentityValidator`、`MultiSigValidator`、`SessionKeyValidator`、`SubscriptionValidator`、`ZKEmailVerifier`），加共享层 `ModuleOperation.cs`、`ValidatorAuthority.cs`、`ValidatorPayload.cs`、`ValidatorClock.cs`、`ValidatorModels.cs`、`SignerDomain.cs` |
| hook | `contracts/plugins/hooks/` —— `DailyLimitHook`、`TokenRestrictedHook`、`WhitelistHook`、`NeoDIDCredentialHook`、退役的 `MultiHook`（安装被拒）、共享 `HookAuthority.cs` |
| recovery 拆分 | `contracts/plugins/recovery/ActionSessionValidator.cs`（validator 模块）与 `contracts/plugins/recovery/SocialRecoveryService.*.cs`（服务合约）；各自附带 canonical profile |
| profile 事实源 | 每个模块同目录的 `<Name>.profile.json`，字面量以 `ModuleProfileJson` 嵌入源码，由 `scripts/sync-module-profiles.mjs` 保持同步（构建前运行 `--check`） |
| 构建布局 | 已退役的 custom 构建输出 `contracts/bin/public`（核心、服务、mock）、`bin/public/validators`、`bin/public/hooks`；原生核由 MSBuild 构建到各项目自己的 `bin/Release/net10.0/`，`scripts/build_native_modules.py` 把六个 native-profile 模块写到它的 `--output` |

### 16.2 原生 kernel（#40，与 #29 共享修改批次）

| 规范章节 | 原生版需创建/修改的文件 |
| --- | --- |
| 常量 | 消费 `SmartAccountModuleProtocol.cs`（本批产出；随后运行 `scripts/sync_native_smartaccount.py` 物化 neo-native-core 副本） |
| §4/§5 envelope/摘要 | `SmartAccountProtocol.cs`（v4 域、13 字段序列化）、`SmartAccountEnvelope.cs`（13 字段操作） |
| §6 nonce | `SmartAccountProtocol.cs` + nonce 存储 partial（0x56/0x5C；与旧 0x20 合并） |
| §7 状态 | `SmartAccountRecords.cs`（新 0x51 记录与其 codec；旧 14-slot decoder 仅保留用于 迁移） |
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

---

> 附录（Appendix: Module developer guide，模块开发者指南）仅提供英文，见 [SA-MODULE-PROTOCOL.md](SA-MODULE-PROTOCOL.md) 文末。

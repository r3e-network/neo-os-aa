# AA 提案历史核查与整合方案

核查日期：2026-09-17。依据 neo-project/proposals 的 PR 正文、diff、讨论及状态，以及 neo-os-aa 当前源码。此文件为本地修订建议，不改变任何 PR 状态，也不代表社区共识。

## 1. 已存在的提案

| 编号 | 标题 | 当前状态 | 处理建议 |
|---|---|---|---|
| [#165](https://github.com/neo-project/proposals/pull/165) | New Proposal: add meta transaction proposal | Closed，未合并 | 保留历史动机，不复用 EVM 风格的执行/编码假设 |
| [#218](https://github.com/neo-project/proposals/pull/218) | Draft: Contract-based Verification Script Standard | Open | 保持通用底层；不要加入 AA 状态机和固定 verify 方法要求 |
| [#219](https://github.com/neo-project/proposals/pull/219) | Draft: Transferable Abstract Account Standard | Closed，未合并 | 仅作为未来控制权转移扩展的历史参考 |
| [#220](https://github.com/neo-project/proposals/pull/220) | Draft: Abstract Account Metadata Standard | Closed，未合并 | 作为可选展示层扩展，不能构成授权依据 |
| [#221](https://github.com/neo-project/proposals/pull/221) | Draft: Abstract Account Entry Contract and Custom Verifier Standard | Closed，未合并 | 当前 AA 协议最直接的前身，优先以其为修订基础 |
| [#242](https://github.com/neo-project/proposals/issues/242) | Proposal: Neo Native Account Abstraction (AA) Standard | Open issue | 用作当前整合讨论入口，而不是第二份互相竞争的接口标准 |

#219、#220、#221 均由 Jim8y 于 2026-05-09 关闭，不能将 Closed 解释为已经合并或社区正式否决。

## 2. 必须回应的旧反馈

- #165：讨论指出该设计使用过多 EVM 概念，未充分建模 Neo N3 的 witness 与跨合约调用；作者关闭时也要求从 N3 特有的签名与验证需求重新出发。
- #218：审阅要求标准仅规定通用 contract-based verification scripts；不应固定方法名为 verify，不应限制为一个 accountId 参数，允许 invocation script 提供动态签名数据。
- #219：Erik Zhang 建议需要 AccountManagement native contract；Roman Khimov 认为普通合约已经可以实现，并质疑统一 owner 的含义。二者是不同意见，不是共识。
- #221：审阅质疑为什么标准 witnesses 不够。作者关闭时保留 #218 作为较窄的活跃互操作讨论。

新稿应说明其价值是共享操作编码、生命周期及工具互操作，而不是声称 Neo 原来无法实现合约账户。

## 3. 建议的分层

1. #218：可静态识别的 witness verification script，通用底层。
2. 修订 #221：AA 操作协议、账户标识、verifier/hook、nonce、恢复与执行语义。
3. #220 的展示元数据、#219 的控制权转移、赞助机制：独立可选扩展。
4. AccountManagement 原生合约：单独的节点实现与共识激活方案；不能把现有普通合约部署直接称为原生合约实现。

未分配 NEP 编号的 PR/issue 用链接标明关系，不将 PR 号填为 Requires/Replaces 的 NEP 编号。

## 4. #221 到当前协议的具体迁移

| 旧接口/假设 | 当前协议修订方向 |
|---|---|
| executeUnifiedByAddress(account,target,method,args) 为规范入口 | executeUserOp(accountId,op)；executeUserOps 为批量入口 |
| ByteString accountId，地址即公共身份 | 区分 20 字节 accountId、core hash、由验证脚本派生的资产地址；说明 ABI Hash160 与原始字节/显示 hex 的转换 |
| verifier.verify(accountId) | validateSignature(accountId,op)，只读授权检查 |
| verifyMetaTx(accountId,signerHashes) | 明确认证上下文和完整操作承诺；不能将调用者提供的 signer 列表直接视为已认证身份 |
| entry policy 与 verifier 只有概念分离 | 明确 validateSignature → nonce → preExecute → target → postExecute 的顺序及失败语义 |
| 未定义统一重放状态 | 定义 channel=nonce>>64、sequence=nonce & (2^64-1)，并补充数值边界、耗尽行为和编码向量 |
| 未明确恢复/控制权 | 分别定义执行权限、backup-owner 配置权限、平台 registrar 权限、核心升级权限 |

## 5. 当前 #242 应先纠正的内容

### 原生合约与普通合约不是同义词

现有 UnifiedSmartWalletV3 是可部署、可升级的普通合约。若选择真正的节点原生 AccountManagement，需要规定原生合约标识/地址、激活高度或硬分叉、跨客户端确定性、存储规则、资源/GAS 计量及迁移机制。

因此原生合约版不能继续声称“不修改协议规则、无需共识激活”，也不能沿用 Runtime.Transaction.Sender 成为部署 admin、NEF update 等普通合约治理规则作为原生合约的规范治理。

### 与 #218 的地址兼容性

#218 要求 ReadOnly call flags。当前 Proxy.cs 的固定脚本使用 PUSH15（All）。修改 flags 会改变 verification script 字节，进而改变资产地址。可以定义新的 #218-compatible profile，但必须明确其与旧地址不兼容，不可宣称是无迁移成本的替换。

### 已确认的源码描述偏差

- Events.cs 的 moduleType 为字符串 "verifier" / "hook"，不是 0 / 1。
- Execution.cs 在配置 verifier 时无条件调用 verifier.postExecute；当前接口应要求实现该方法（允许 no-op），不能同时写“可选”且无条件调用。
- Accounts.cs 在哈希后还 ReverseBytes，再转 UInt160；#242 的账户派生公式没有完整说明该步骤及原始字节与显示形式的区别。应给出逐字节向量，不能仅写一个含糊的 reverse 公式。
- #220 的 accountURI(account) 与当前 getMetadataUri(accountId) 不是相同接口，必须显式定义适配与标识转换。
- #219 将 ownerOf(NEP-11 token) 定义为唯一控制者；当前市场托管/控制权变更并不等于该模型，不能宣称符合 #219。

### 安全及可用性表述边界

- 升级权限意味着未来可改变验证规则；不能因“当前需 verifier 签名”而淡化 admin 的长期控制权。
- 配置时间锁、逃生时间锁与插件升级延迟应整体分析，不承诺任何情况下都能在升级前安全退出。
- Verification trigger 的 witness 检查与 Application trigger 的操作授权必须分别定义，避免把应用执行中的临时状态当作预验证时已存在的状态。
- 任意 target 返回 false 不必然使 Neo VM FAULT。规范应区分 VM 成功、业务结果、hook 的结果断言，以及应用状态回滚与交易手续费。
- 普通 executeUserOp 的代理脚本规则不能自动推出 executeSponsoredUserOp 路径兼容；赞助包装路径需要明确规则与向量。
- 现有部署和局部测试是工程证据，不是“原生合约已实现”或“规范完整性已证明”。

## 6. 可直接用于 #242 的英文关联说明草案

> This discussion revisits the earlier AA entry-contract draft (#221), rather than proposing a competing replacement for the generic verification-script draft (#218). Drafts #219 and #220 address optional ownership-transfer and presentation metadata concerns; neither is a prerequisite for basic AA execution. The earlier meta-transaction discussion (#165) also informs the requirement to model Neo N3 witness and invocation semantics explicitly.
>
> The proposed AA profile should specify operation encoding, replay protection, verifier/hook lifecycle, recovery authority and execution outcomes above the generic witness layer. It must not narrow #218 to a fixed method name, a single argument, or an empty invocation script.
>
> A node-native AccountManagement contract is a separate deployment and consensus choice. The existing UnifiedSmartWalletV3 is an ordinary deployed contract and is design input, not an implementation of a new native contract. A native implementation requires an explicit activation, identity, fee, governance and migration specification.
>
> Compatibility gaps to resolve include ReadOnly versus All call flags in the verification script (which changes account addresses), accountId byte-order test vectors, legacy entrypoint migration, and the distinction between VM success and application-level success. Module type identifiers in the current implementation are strings, and verifier postExecute is required by its execution path.

## 7. 执行建议

先在 #242 加上前身链接、上述纠错与分层说明，再以 #221 的修订稿承载完整接口定义。是否重开 #221，应先征询原审阅者，避免在未回应旧意见时直接重开。

若最终坚持节点原生 AccountManagement，应以新原生合约规范作为主文，并引用 #221 为历史接口草案，而不是将旧普通合约 NEF/管理员更新接口直接复制进去。

本轮只生成此对照稿；未评论、修改、重开或关闭任何远端 issue/PR。

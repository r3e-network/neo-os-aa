# Neo N3 Smart Account 架构

当前 `main` 分支是**策略管控**的 V3 架构，核心是 `SmartAccount` 合约。

> 中文版本与 `docs/architecture.md` 同构。若两者冲突，以英文版本为准。

## 1. 组件图

```mermaid
flowchart LR
  User[用户 / 运营者]
  Frontend[前端工作台]
  Wallets[Neo 钱包 / EVM 钱包 / Web3Auth]
  Drafts[本地存储 / Supabase]
  Relay[可选中继]
  Core[SmartAccount 核心]
  Verifier[验证器插件]
  Hook[钩子插件]
  Paymaster[SAPaymaster]
  Target[目标合约]

  User --> Frontend
  Frontend --> Wallets
  Frontend --> Drafts
  Frontend --> Relay
  Frontend --> Core
  Relay --> Core
  Core --> Verifier
  Core --> Hook
  Core --> Target
  Core --> Paymaster
  Paymaster -->|GAS| Relay
```

## 2. 账户模型

V3 是 `accountId` 优先的模型。

- 每个账户由确定性的 20 字节 `accountId` 作为键。
- 对外 Neo 地址由 `verify(accountId)` 脚本加主合约哈希在本地推导。
- 链上状态保存：
  - `verifier`
  - `hook`
  - `backupOwner`
  - `escapeTimelock`
  - `escapeTriggeredAt`
  - nonce 通道

核心钱包不再以管理员 / 经理 / dome 状态作为主要授权面。

## 3. 验证流水线

```mermaid
flowchart TD
  Start[交易到达 Neo 节点] --> Verify[节点触发 verify(accountId)]
  Verify --> Context[核心检查当前验证上下文]
  Context --> Allowed{目标是否符合预期?}
  Allowed -- 否 --> Reject1[拒绝意外的见证使用]
  Allowed -- 是 --> Execute[executeUserOp(accountId, op)]
  Execute --> Auth{验证器插件通过，或备份所有者见证通过?}
  Auth -- 否 --> Reject2[拒绝未授权操作]
  Auth -- 是 --> Nonce[消耗 nonce 并校验 deadline]
  Nonce --> Hooks[执行前后钩子]
  Hooks --> Return[返回结果]
```

## 4. 应用执行流水线

```mermaid
flowchart TD
  Entry[executeUserOp / executeSponsoredUserOp] --> Load[载入 V3 账户状态]
  Load --> PM{有 Paymaster?}
  PM -- 是 --> PMValidate[可选：中继通过 validatePaymasterOp 预检]
  PM -- 否 --> Auth
  PMValidate --> Auth[校验验证器或备份所有者]
  Auth --> Pre[preExecute 钩子]
  Pre --> Call[调用目标合约]
  Call --> Post[postExecute 钩子]
  Post --> Settle{有 Paymaster?}
  Settle -- 是 --> PMSettle[Paymaster 结清报销，把 GAS 付给中继]
  Settle -- 否 --> Done[返回结果]
  PMSettle --> Done
```

V3 核心刻意保持精简：授权委托给验证器插件，策略委托给钩子插件，核心只负责 nonce 消耗、恢复状态与执行上下文。

## 5. 授权模式

- 备份所有者原生见证
- Web3Auth / EIP-712 验证器
- TEE / WebAuthn / SessionKey / MultiSig / ZKEmail 验证器插件
- 由自定义钩子中介的策略检查

## 6. 合约文件地图

| 文件 | 职责 |
| --- | --- |
| `contracts/custom/SmartAccount.cs` | 核心 V3 账户状态、`verify`、`executeUserOp`、nonce 处理、备份所有者逃生、钩子 / 验证器配置 |
| `contracts/plugins/verifiers/Web3AuthVerifier.cs` | EIP-712 `UserOperation` 验证 |
| `contracts/plugins/verifiers/TEEVerifier.cs` | TEE 签名授权 |
| `contracts/plugins/verifiers/WebAuthnVerifier.cs` | Passkey / WebAuthn 授权 |
| `contracts/plugins/verifiers/SessionKeyVerifier.cs` | 短期委托密钥 |
| `contracts/plugins/verifiers/MultiSigVerifier.cs` | 插件化多签 |
| `contracts/plugins/verifiers/ZKEmailVerifier.cs` | 基于邮箱的授权扩展 |
| `contracts/plugins/hooks/*.cs` | 可选策略，如每日限额、代币限制、凭证门控 |
| `contracts/custom/paymaster/Paymaster.cs` | 赞助 / 免 Gas 交易的链上 Paymaster（GAS 存款、策略、结算） |
| `contracts/custom/paymaster/PaymasterAuthority.cs` | Paymaster 管理与核心授权校验 |

## 7. 模块生命周期

V3 现在有两层生命周期信号：

- 保留的兼容事件，仍按验证器或钩子分别定义；
- 以及通用的模块生命周期，把验证器与钩子视为一等模块。

通用生命周期是：

- **安装**：首次绑定验证器或钩子时发出 `ModuleInstalled`
- **替换**：经时间锁的替换先发出 `ModuleUpdateInitiated`，随后发出 `ModuleUpdateConfirmed`
- **移除**：替换为 `UInt160.Zero`（零地址）、市场结算清理，或逃生驱动的清理发出 `ModuleRemoved`
- **取消**：中止待生效的验证器或钩子轮换发出 `ModuleUpdateCancelled`

这既让旧索引器继续工作，也让新工具只需消费一套一致的生命周期模型。

## 8. 恢复模型

V3 的恢复是显式的：

1. `initiateEscape(accountId)` 启动备份所有者时间锁。
2. `finalizeEscape(accountId, newVerifier)` 在延迟结束后轮换验证器。
3. 任何一次成功的常规执行都会清除进行中的逃生流程。

这让恢复过程可审计，同时不会把庞大的角色图重新引入核心钱包。

## 9. Paymaster（赞助交易）

`SAPaymaster` 合约在 Neo N3 上实现无信任的免 Gas 执行：

1. **存款：** 赞助方通过 NEP-17 转账把 GAS 发给 Paymaster。
2. **策略：** 赞助方调用 `setPolicy(accountId, targetContract, method, maxPerOp, dailyBudget, totalBudget, validUntil)`。用 `accountId` 为零表示赞助任意账户的全局策略。
3. **执行：** 中继在 SA 核心上调用 `executeSponsoredUserOp(accountId, op, paymaster, sponsor, reimbursementAmount)`。
4. **结算：** 核心校验策略、执行用户操作，然后调用 `paymaster.settleReimbursement()`，原子性地从赞助方存款中扣除并把 GAS 转给中继。

对于带费用的交易，实际结算额是
`min(reimbursementAmount, 系统费 + 网络费)`。`maxPerOp` 限制的是这个结算额，而不是完整交易费用；只要请求的报销额符合策略，更大的交易费仍可通过。每日与总额预算按已解析策略作用域统计结算额，包括全局策略的共享作用域。违反策略会使整个调用失败。零费用 RPC 估算则把请求的报销额当作保守上限，因此标准费用估算仍然可用；中继应保留系统费余量。

Paymaster 从不对执行进行授权——它只在验证器与钩子已经批准操作之后为中继出资。

## 10. 安全不变量

1. `verify(accountId)` 只在预期的 `executeUserOp` 上下文中有效。
2. nonce 由核心钱包消耗，而不是验证器插件。
3. 验证器插件不能绕过钩子或目标合约策略。
4. 备份所有者恢复受时间锁约束。
5. 新集成一律面向 `executeUserOp`；V1/V2 的 `executeUnified` 与 `executeUnifiedByAddress` 已被移除，不存在于任何已部署清单与合约源码中，因此命名它们的交易会在验证阶段失败。
6. 只有当调用者是已授权的 SA 核心合约时，Paymaster 结算才会成功。
7. Paymaster 先扣减赞助方存款，再向中继转账 GAS（检查-生效-交互）。

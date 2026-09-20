# 快速参考

## 全仓本地验证

```bash
./scripts/verify_repo.sh

# 发布级跨仓库身份内核门（必须存在 neo-os-services 真实工件）：
NEOOS_REQUIRE_SERVICES_ARTIFACTS=1 ./scripts/verify_repo.sh --contracts-only

# 可选的形式化验证门（Coq/Z3/TLC）与私链验证（neoxp）：
./scripts/verify_repo.sh --contracts-only --formal --neoexpress
```

## 仅前端

```bash
cd frontend && npm test
cd frontend && npm run build
```

## 仅 SDK

```bash
cd sdk/js && npm test
```



## SDK API 参考

### 赞助执行（Paymaster）

```javascript
// 查询赞助商余额
const balance = await client.querySponsorBalance(paymasterHash, sponsorAddress);

// 提交前验证（中继预检）
const ok = await client.validatePaymasterOp({
  paymasterHash, sponsorAddress, accountAddress,
  targetContract, method, reimbursementAmount
});

// 构建赞助执行载荷
const payload = client.createSponsoredUserOpPayload({
  accountScriptHash, userOp, paymasterHash,
  sponsorAddress, reimbursementAmount
});

// 构建赞助批量载荷
const batchPayload = client.createSponsoredBatchPayload({
  accountScriptHash, userOps, paymasterHash,
  sponsorAddress, reimbursementAmount
});
```

### Paymaster 合约方法（链上）

| 方法 | 访问权限 | 用途 |
| --- | --- | --- |
| `OnNEP17Payment` | GAS 转账 | 接受赞助商存款 |
| `WithdrawDeposit(amount)` | 赞助商见证 | 提取多余 GAS |
| `SetPolicy(accountId, target, method, maxPerOp, dailyBudget, totalBudget, validUntil)` | 赞助商见证 | 创建/更新赞助策略 |
| `RevokePolicy(accountId)` | 赞助商见证 | 移除策略 + 清除计数器 |
| `ValidatePaymasterOp(sponsor, accountId, target, method, amount)` | 安全（任何人） | 只读预检查询 |
| `SettleReimbursement(sponsor, accountId, target, method, relay, amount)` | 仅 AA 核心 | 执行后原子结算 |
| `GetSponsorDeposit(sponsor)` | 安全 | 查询存款余额 |
| `GetPolicy(sponsor, accountId)` | 安全 | 查询策略详情 |
| `GetDailySpent(sponsor, accountId)` | 安全 | 查询 24 小时花费 |
| `GetTotalSpent(sponsor, accountId)` | 安全 | 查询生命周期花费 |

## 核心文档

- `docs/HOW_IT_WORKS.zh-CN.md`
- `docs/WORKFLOWS.zh-CN.md`
- `docs/DATA_FLOW.zh-CN.md`
- `docs/architecture.zh-CN.md`

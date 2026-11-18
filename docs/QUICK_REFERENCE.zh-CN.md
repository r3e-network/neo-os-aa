# 快速参考

> 中文版本与 `docs/QUICK_REFERENCE.md` 同构。若两者冲突，以英文版本为准。

## 本地核心验证

```bash
./scripts/verify_repo.sh

# 发布级跨仓库身份内核门禁：
NEOOS_REQUIRE_SERVICES_ARTIFACTS=1 ./scripts/verify_repo.sh --contracts-only

# 可选的形式化门禁（Coq/Z3/TLC）与私有链验证（neoxp）：
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

### 账户生命周期

```javascript
const accountIdHash = client.deriveRegistrationAccountIdHash({
  verifierContractHash,
  verifierParamsHex,
  hookContractHash,
  backupOwnerAddress,
  escapeTimelock: 7 * 24 * 60 * 60,
});

const payload = client.createAccountPayload({
  verifierContractHash,
  verifierParamsHex,
  hookContractHash,
  backupOwnerAddress,
  escapeTimelock: 7 * 24 * 60 * 60,
});

const state = await client.getAccountState(accountIdHash);
```

已部署核心上的 `registerAccounts` 在一笔交易中注册多个账户；SDK 没有批量载荷构造器，因此按账户分别构造 `createAccountPayload`，再通过该入口提交。

### 已移除的 V2 接口

V1/V2 的角色模型已不存在。V3 账户没有管理员、经理或阈值状态，SDK 只保留抛出 `LEGACY_V3_REMOVED` 的移除存根：

- `client.getAccountsByAdmin()`、`client.getAccountsByManager()` —— V3 已移除：无参数，总是抛出 `LEGACY_V3_REMOVED`；请改用 `getAccountState(accountIdHash)` 逐账户读取。
- `client.getAccountAddressesByAdmin()`、`client.getAccountAddressesByManager()` —— 同样原因在 V3 移除。
- `client.createAccountBatchPayload(...)`、`client.getAdmins(...)`、`client.getAdminThreshold(...)`、`client.getManagers(...)` —— 本 SDK 中从未存在的已移除名称。
- `client.getManagerThreshold(...)`、`client.executePayload(...)`、`client.executeUnifiedByAddressPayload(...)` —— 本 SDK 中从未存在的已移除名称；当前构造器是 `createAccountPayload` 与 `UserOperationBuilder`。

### 执行

V3 通过 `executeUserOp(accountId, op)` 执行（批量时为 `executeUserOps(accountId, ops)`）；`executeUnified` / `executeUnifiedByAddress` 包装已被移除，在任何已部署清单与合约源码中都不存在。用 SDK 的 `UserOperationBuilder` 构造操作，并按 V3 布局签名类型化数据：

```javascript
const { createUserOpBuilder, buildV3UserOperationTypedData } = require('./sdk/js/src');

const userOp = createUserOpBuilder()
  .setAccountId(accountIdHash)
  .setTarget(targetContract)
  .setMethod('transfer')
  .setArgs([{ type: 'Hash160', value: recipient }, { type: 'Integer', value: '100000000' }])
  .build();

const typedData = buildV3UserOperationTypedData(userOp);
```

### 赞助执行（Paymaster）

```javascript
// 查询赞助方余额
const balance = await client.querySponsorBalance(paymasterHash, sponsorAddress);

// 提交前校验（中继预检）
const ok = await client.validatePaymasterOp({
  paymasterHash, sponsorAddress, accountAddress,
  targetContract, method, reimbursementAmount
});

// 构造赞助执行载荷
const payload = client.createSponsoredUserOpPayload({
  accountScriptHash, userOp, paymasterHash,
  sponsorAddress, reimbursementAmount
});

// 构造赞助批量载荷
const batchPayload = client.createSponsoredBatchPayload({
  accountScriptHash, userOps, paymasterHash,
  sponsorAddress, reimbursementAmount
});
```

### Paymaster 合约方法（链上）

| 方法 | 访问权限 | 用途 |
| --- | --- | --- |
| `onNEP17Payment` | GAS 转账 | 接收赞助方存款 |
| `withdrawDeposit(amount)` | 赞助方见证 | 提取多余 GAS |
| `setPolicy` | 赞助方见证 | 创建 / 更新赞助策略 |
| `revokePolicy(accountId)` | 赞助方见证 | 删除策略并清空计数器 |
| `validatePaymasterOp` | 安全（任何人） | 只读预检 |
| `settleReimbursement` | 仅 SA 核心 | 执行后的原子结算 |
| `getSponsorDeposit(sponsor)` | 安全 | 查询存款余额 |
| `getPolicy` | 安全 | 查询策略详情 |
| `getDailySpent` | 安全 | 查询 24 小时支出 |
| `getTotalSpent` | 安全 | 查询生命周期支出 |

上表中的名称与 `contracts/build/SAPaymaster.manifest.json` 的导出拼写完全一致；Neo ABI 名称区分大小写。

## 权威文档

- `docs/HOW_IT_WORKS.md`
- `docs/WORKFLOWS.md`
- `docs/DATA_FLOW.md`
- `docs/architecture.md`

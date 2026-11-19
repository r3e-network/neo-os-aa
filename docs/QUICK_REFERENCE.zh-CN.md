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

下列代码均为 v4 客户端（自定义内核用 `sdk/js/src/index.js`，原生内核用共享的
`nativeSmartAccountClient.mjs`）。两者驱动同一个 13 字段操作与同一套 `SA_*` 词汇。v3 调用
（`registerAccount`、`createAccountPayload`、`getVerifier`、`updateHook`）无法解析：不存在别名。

### 账户生命周期

v4 身份只在创建时提交一次：`accountId = hash160('aa524704' || custody || salt)`。盐是 1..128
字节的公开唯一性输入，恢复时间锁为 7..90 天，按毫秒传入。

```javascript
const { createSmartAccountClient } = require('./sdk/js/src');

const client = await createSmartAccountClient({ rpcUrl, contractHash, networkMagic });
await client.discover(); // 固定 protocolVersion 与 implementationId

const identity = client.deriveIdentity({ custodyAddress: custody, salt });

// createAccount(Hash160 accountId, Hash160 custody, ByteArray salt,
//               Integer recoveryTimelockMs, Array actions)
const plan = client.buildCreateAccountScript({
  custodyAddress: custody,
  salt,
  recoveryTimelockMs: 30 * 86_400_000,
});

const state = await client.getAccount(identity.accountId);
```

创建调用携带派生 id、托管地址、盐与时间锁；创建时不选择任何验证器或钩子。`state` 返回控制记录
（托管、恢复权限方与时间锁、权限 epoch、配置 nonce、钩子顺序修订号）、已安装模块与待确认的配置意图。

### 模块与配置意图

模块在创建之后安装。配置变更先提案，成熟 24 小时后才可确认或取消；在确认之前账户不会发生任何变化。

```javascript
const propose = client.buildConfigurationScript({
  kind: 'propose',
  accountId: identity.accountId,
  // [1, moduleTypeCode, moduleHash, profileDigest, initData]
  actions: [installAction],
  readSet: [],
});

const confirm = client.buildConfigurationScript({
  kind: 'confirm',
  accountId: identity.accountId,
  intentId: intent.intentId,
});
```

`getModules(accountId, 'validator' | 'hook', { cursor, limit })` 分页读取已安装实例，
`getModule(accountId, moduleId)` 读取单个实例，`getPendingConfiguration(accountId)` 返回意图、
成熟时间与动作摘要。每个模块只暴露自身的只读方法（`getModuleProfile`、`getConfig`、
`getSessionKey`、`getThreshold`、`getPublicKey`、`getDailyLimit` 等），因为生命周期回调由核心合约持有。

### 执行

单个操作使用 `executeUserOp(accountId, op)`，批量使用 `executeUserOps(accountId, ops)`。操作就是
v4 的 13 字段数组：版本、目标、方法、参数、nonce、nonce 子键、截止时间、验证器 id、凭证代数、
权限 epoch、配置 nonce、签名、钩子证明。按核心校验的类型化数据签名：

```javascript
const operation = {
  targetContract,
  method: 'transfer',
  args: [{ type: 'Hash160', value: recipient }, { type: 'Integer', value: '100000000' }],
  nonce,
  nonceSubkey,
  deadline,
  validatorId: 1,
  credentialGeneration: 1,
  authorityEpoch,
  configurationNonce,
  signature,
  hookProofs: [],
};

const typedData = buildUserOperationTypedData({
  chainId,
  verifyingContract: proxyAddress,
  accountId,
  coreContractHash,
  validatorId: operation.validatorId,
  targetContract: operation.targetContract,
  method: operation.method,
  argsHashHex,
  nonce: operation.nonce,
  deadline: operation.deadline,
  operationDigest,
});
```

### 赞助执行（Paymaster）

赞助保持 v4 操作不变：赞助方付费，账户仍用自己的验证器签名授权操作。若批量中各操作的目标合约或
方法不一致，客户端会拒绝构造，因为核心对整个信封只结算一次报销。

```javascript
const plan = client.buildSponsoredExecutionScript({
  accountId,
  operations: [operation], // 1..32，同一目标合约与方法
  paymaster: paymasterHash,
  sponsor: sponsorAddress,
  reimbursementAmount: '1000000', // 必须为正
});
```

单笔时 `plan.method` 为 `executeSponsoredUserOp`，批量时为 `executeSponsoredUserOps`。存款、策略与
计数器都在 Paymaster 合约上：

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

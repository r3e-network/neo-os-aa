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
（托管、恢复权限方与时间锁、权限 epoch、配置 nonce、钩子顺序修订号）。描述符仍保留的恢复槽位
报告其非活动值：恢复生命周期属于模块，因此读者不会把用于 ABI 稳定性的槽位误认为待执行的移交。

### 模块

模块在注册时可以原子安装，也可以通过 `installModule(accountId, moduleType, moduleContractHash,
initData)` 与 `removeModule(accountId, moduleId, deInitData)` 在之后安装。两者都接受托管见证或已安装
验证器实例的见证，且都会推进配置 nonce。核心不保留提案窗口：需要成熟 24 小时的变更属于治理模块的
合约，由该模块通过这两个方法提交成熟后的调用。

```javascript
// moduleTypeCode 是 v4 的安装代码：验证器（1）或钩子（4）。核心读取模块自身的 profile，
// 因此公开入口不携带摘要。
const install = client.buildAccountActionScript({
  method: 'installModule',
  accountId: identity.accountId,
  args: [moduleTypeCode, moduleContractHash, initData],
});
```

`getModules(accountId, 'validator' | 'hook', { cursor, limit })` 分页读取已安装实例，
`getModule(accountId, moduleId)` 读取单个实例。`isModuleInstalled` 无需分页即可回答准入问题，
`getAuthorizedModuleId` 报告核心为某一阶段路由到的实例。钩子顺序由已安装的钩子实例与描述符
发布的 `hookOrderRevision` 推导，因为调用钩子的编排器是模块。每个模块也只暴露自身的只读方法
（`getModuleProfile`、`getConfig`、`getSessionKey`、`getThreshold`、`getPublicKey`、
`getDailyLimit` 等），因为生命周期回调由核心合约持有。

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

## 权威文档

- `docs/HOW_IT_WORKS.md`
- `docs/WORKFLOWS.md`
- `docs/DATA_FLOW.md`
- `docs/architecture.md`

# 用户指南

本指南是 `docs/HOW_IT_WORKS.md` 的实用、面向用户版配套文档。

> 中文版本与 `docs/USER_GUIDE.md` 同构。若两者冲突，以英文版本为准。

## 适合谁阅读

- 准备交易的运营者
- 审阅并批准草稿的签名人
- 想快速理解界面流程的开发者

## 快速路径

1. 打开首页工作台
2. 载入智能账户
3. 选择预设或编写自定义调用
4. 持久化草稿
5. 分享对应作用域的链接
6. 收集签名
7. 需要时执行中继预检
8. 通过钱包或中继广播

## 角色

### 只读审阅者

- 使用公开共享链接
- 可以查看草稿，但不能修改

### 协作者 / 签名人

- 使用协作者链接
- 可以添加签名或批准
- 不能执行仅限运营者的中继或广播操作

### 运营者

- 使用运营链接
- 可以执行中继检查、追加回执、轮换链接并提交交易

## 账户发现

### 找到你控制的账户

V3 没有管理员、经理或阈值状态，也没有反向索引：该 V1/V2 角色模型已被移除。被移除的 `getAccountsByAdmin` / `getAccountsByManager` 读取只作为抛出 `LEGACY_V3_REMOVED` 的 SDK 存根存在，且没有任何已部署清单导出它们。用 `getAccountState(accountHashOrAddress)` 读取你已知的账户：

**通过 SDK：**

```javascript
const client = new SmartAccountClient(rpcUrl, masterContractHash);

const state = await client.getAccountState(accountIdHash);
```

**适用场景：**

- 资产盘点：对你持有 id 或地址的每个账户逐个读取
- 权限审计：检查账户实际拥有的验证器、钩子与备份所有者

## 批量创建账户

### 高效创建多个账户

`registerAccounts(accountIds, verifier, verifierParamsList, hookId, backupOwner, escapeTimelock)` 在一笔交易中注册多个账户。每个账户获得相同的验证器、钩子与备份所有者；V3 没有共享的管理员 / 经理治理（该 V1/V2 模型已移除），且注册要求 `backupOwner` 参数的见证，而不是交易发送者的见证。

**通过 SDK：**

```javascript
// 每个账户一个载荷：SDK 没有批量载荷构造器
const payload = client.createAccountPayload({
  verifierContractHash,
  verifierParamsHex,
  hookContractHash,
  backupOwnerAddress,
  escapeTimelock: 7 * 24 * 60 * 60,
});

// 与合约 computeRegistrationAccountId 相同的推导
const accountId = client.deriveRegistrationAccountIdHash({
  verifierContractHash,
  verifierParamsHex,
  hookContractHash,
  backupOwnerAddress,
  escapeTimelock: 7 * 24 * 60 * 60,
});
// 通过 registerAccounts 提交这些 account id
```

**关键行为：**

- 注册要求备份所有者的见证（`contracts/custom/SmartAccount.Accounts.cs:75`）
- 每个账户自带验证器、钩子与备份所有者；没有共享治理状态
- 单笔交易降低费用
- 原子操作：全部创建成功，或全部失败

**适用场景：**

- 团队入驻：为团队成员以相同配置注册多个账户
- 项目搭建：一起注册开发 / 预发 / 生产账户
- 服务账户：以原子方式逐次注册一组账户

## 推荐参考

- `docs/HOW_IT_WORKS.md`
- `docs/WORKFLOWS.md`
- `docs/DATA_FLOW.md`
- `contracts/plugins/recovery/TESTNET_VALIDATION_2026-03-09.md`
- `docs/MORPHEUS_PRIVATE_ACTIONS.md`

## 通过 `.matrix` 加载

如果你更容易记住 `.matrix` 名称而不是 SA 地址，可以在载入框中输入域名。前端会把域名解析为控制钱包地址。V3 没有管理员或经理角色查询，因此域名本身不会列出绑定其下的 SA 账户：逐个用 `getAccountState(accountHashOrAddress)` 读取。命名了已移除的 `getAccountAddressesByAdmin` / `getAccountAddressesByManager` 读取的 V2 账户发现助手已被删除，前端没有任何路径再指向这些读取。

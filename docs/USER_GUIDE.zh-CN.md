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
3. 选择模块读取或编写自定义调用
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

v4 不保留反向索引，也没有角色状态：不存在管理员、经理或共享阈值账户，因此链上没有任何东西会列出某个钱包控制的账户。身份是推导出来的，不是注册登记的：`accountId = hash160('aa524704' || custody || salt)`。请持久化每一个盐，因为盐是这段原像中链上唯一无法归还的部分。

用 `getAccount(accountId)` 读取你已知的账户。控制记录会回答托管地址、恢复权限方与时间锁、权限 epoch、配置 nonce、钩子顺序修订号、已安装模块以及待确认的配置意图。

**通过 SDK：**

```javascript
const { createSmartAccountClient } = require('./sdk/js/src');

const client = await createSmartAccountClient({ rpcUrl, contractHash, networkMagic });
await client.discover();

const identity = client.deriveIdentity({ custodyAddress: custody, salt });
const state = await client.getAccount(identity.accountId);
const validators = await client.getModules(identity.accountId, 'validator');
```

**适用场景：**

- 资产盘点：用托管地址与盐重新推导每个账户，再逐个读取
- 权限审计：列出已安装的验证器与钩子模块，并用 `getModule(accountId, moduleId)` 读取每个实例

## 批量创建账户

### 在一笔交易中创建多个账户

`createAccounts(Hash160[] accountIds, Hash160 custody, ByteArray[] salts, Integer recoveryTimelockMs)` 在一笔交易中最多创建 64 个账户；JS 客户端的 `buildCreateAccountsScript` 每次调用接受 1..32 个盐。所有账户共享托管地址与恢复时间锁；恢复权限方本身是在之后通过 `setRecoveryPolicy` 配置意图设定的。

**通过 SDK：**

```javascript
const plan = client.buildCreateAccountsScript({
  custodyAddress: custody,
  salts: [saltA, saltB],
  recoveryTimelockMs: 30 * 86_400_000,
});
```

**关键行为：**

- 托管地址必须见证该交易；每个 account id 必须等于 `hash160('aa524704' || custody || salt)`，否则调用会故障
- 时间锁为 `0` 时选择 7 天下限；接受的范围是 7..90 天，以毫秒计
- 批量是原子的：要么全部账户创建成功，要么全部失败
- 创建时不选择任何验证器或钩子。模块在之后通过配置意图安装，并且有 24 小时成熟期；只有单账户的 `createAccount` 调用可以原子地携带初始安装动作

**适用场景：**

- 团队入驻：在一个托管见证下创建多个账户
- 项目搭建：一起创建开发 / 预发 / 生产账户
- 服务账户：以原子方式逐次创建一组账户

## 推荐参考

- `docs/HOW_IT_WORKS.md`
- `docs/WORKFLOWS.md`
- `docs/DATA_FLOW.md`
- `docs/SA-MODULE-PROTOCOL.md`
- `docs/MORPHEUS_PRIVATE_ACTIONS.md`

## 通过 `.matrix` 加载

如果你更容易记住 `.matrix` 名称而不是 SA 地址，可以在载入框中输入域名。前端会把域名解析为控制钱包地址。域名本身不会列出该钱包控制的账户，因为 v4 不保留反向索引：请用托管地址与盐重新推导每个账户，再用 `getAccount(accountId)` 读取。

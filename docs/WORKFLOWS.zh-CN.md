# 工作流生命周期

抽象账户的典型使用流程如下：

1. 加载抽象账户
2. 组合 AA 包装操作
3. 持久化草稿
4. 通过协作者链接收集签名
5. 通过操作员链接执行预检、广播与链接轮换

## 关键执行入口

- `executeUserOp(accountId, op)`：原生钱包客户端路径；批量使用 `executeUserOps(accountId, ops)`
- `executeUserOp`：EVM 元交易 / 中继路径
- 旧包装器 `executeUnified` 与 `executeUnifiedByAddress` 已从 V3 中移除，不存在于任何已部署 manifest 或合约源码中

## 协作草稿范围

- **分享链接**：只读
- **协作者链接**：仅签名
- **操作员链接**：预检、广播、回执、轮换

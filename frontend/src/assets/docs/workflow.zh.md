# 工作流生命周期

智能账户的典型使用流程如下：

1. 从 `accountId` 哈希加载账户，或先用托管脚本哈希与盐创建账户
2. 组合一个规范化的 13 字段操作（或不超过 32 个操作的批量）
3. 持久化草稿
4. 通过协作者链接收集签名
5. 通过操作员链接执行预检、广播与链接轮换

## 关键执行入口

- `executeUserOp(accountId, op)`：原生钱包客户端路径；批量使用 `executeUserOps(accountId, ops)`
- 只读预览使用 `validateUserOp`，它执行同一条验证路径但不写状态
- 配置变更通过 `proposeConfiguration` / `confirmConfiguration`，24 小时后成熟，成熟后 7 天过期
- 旧包装器 `executeUnified` 与 `executeUnifiedByAddress` 已移除，不再兼容，也不存在于任何已部署 manifest 或合约源码中

## 广播前应确认

- 账户、目标合约、方法与参数是否正确
- `authority epoch` 与配置 nonce 是否仍与草稿一致（冻结、恢复、结算或配置变更都会使其失效）
- 阈值策略路由时，签名进度是否达到阈值
- 提交的是原始交易字节还是中继就绪调用

## 协作草稿范围

- **分享链接**：只读
- **协作者链接**：仅签名
- **操作员链接**：预检、广播、回执、轮换

共享草稿只保留最近 **100 条活动记录** 与 **12 条提交回执**；未配置 Supabase 时回退到浏览器本地 `localStorage`。

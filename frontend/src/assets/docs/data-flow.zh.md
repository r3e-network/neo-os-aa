# 数据流与存储

Supabase 中保存的是协作草稿与前端辅助元数据，而真正的授权、模块实例与策略仍在链上主合约中。

## 草稿记录包含什么

- `account`
- `operation_body`
- `transaction_body`
- `signer_requirements`
- `signatures`
- `metadata.activity`
- `metadata.submissionReceipts`
- `metadata.relayPreflight`

## 链接与权限

- `share_slug`：公开只读
- `collaboration_slug`：签名范围
- `operator_slug`：操作员范围

## 链上存储布局

每个键都是「1 字节前缀 ‖ 20 字节 accountId ‖ 定长大端后缀」，两个内核使用相同的 0x50–0x5F 字节：

- `0x51`：账户控制记录（状态、托管、恢复权限、epoch、配置 nonce、时限、修订号）
- `0x52` / `0x53`：模块实例记录与其类型索引
- `0x54`：钩子顺序列表与其修订号
- `0x55` / `0x5E`：待定配置意图及其有界索引
- `0x56`：nonce 通道游标
- `0x57`：内置消息签名主体与阈值
- `0x5B`：阈值成员列表与策略承诺
- `0x5D`：市场托管锁与挂牌绑定

早期前缀仅作为迁移输入读取，退役的授权前缀永久保留、不再重新分配。

## 数据边界

- 操作员动作通过服务端签名变更执行
- 协作者无法伪造中继或广播类活动记录
- 前端活动与回执历史采用有界保留策略（最近 100 条活动、12 条提交回执）
- 链上状态始终是授权与执行的最终权威

# SA 迁移 Manifest —— 旧版 → 协议 v4（设计）

本文件规定**迁移 manifest**：规范化、可导出的逐账户分类记录，用于把既有 Neo Smart
Account（SA）账户从旧单槽模型（普通版五字段 `0x01` AccountState / 原生版 14-slot
Array）迁移到共同模块协议版本 4（`docs/SA-MODULE-PROTOCOL.md`）。

状态：**已交付设计 + manifest schema + 幂等规则；迁移执行器属于后续批次。**
重部署决策已确认：新核心/Market/Paymaster 以新名（`SmartAccount`、
`SAAddressMarket`、`SAPaymaster`）部署到新地址；旧核心（主网
`0x0268a387…`，测试网 `0xdbf38e7b…`）走迁移，不做原址升级。因此原址升级的
“保留 manifest.name / coreHash”身份约束不适用于*新*部署；旧合约冻结为只读导出源。

## 1. 导出流程（设计报告 §4.3）

1. 动迁前重新扫描两网：每个账户、每条旧前缀行、部署工件。扫描产出 manifest。
2. 逐账户导出：旧状态、根模块、children、阈值配置、hook 顺序、冻结/逃生状态、
   nonce 游标、Market 标记、插件代码身份。
3. 分类（§2）。未知/无法解析的插件 ⇒ `MigrationRequired`，绝不猜测。
4. 新核心先部署；绝不在一笔交易里遍历主网 53 / 测试网 407 个账户。
5. 曾有插件的旧账户在新核心上进入 `MigrationRequired` 状态：执行与消息授权被拒；
   查询、冻结与 callback-free 恢复仍可达。无静默 owner fallback。
6. owner 提交迁移意图（24 h，即正常配置时间锁），载明确的新模块、实例、阈值与
   hook 顺序；custody 确认。
7. 导入经新 `onInstall` 生命周期执行已批准的精确配置；MultiHook 按旧正序展开；
   MultiSig 阈值保留为核心持有的政策。
8. 验证成功后账户原子切换为 `Active`；manifest 摘要与旧状态摘要记入 `0x5A`。
9. 迁移后复扫两网：地址、权限、nonce、锁与结果。

## 2. 分类

每账户恰好一个主类：

| 类 | 含义 | 默认路径 |
| --- | --- | --- |
| `no-plugin` | 零 verifier、零 hook、无任何政策行（旧 hook 非零*不是*“无政策”） | 有界 materialize 到 Active |
| `scalar-plugin` | 一个 verifier 且/或一个 hook，无 children | 直接安装改名后的模块 |
| `multihook` | MultiHook 根 + 0–8 个子 hook | 子 hook 按旧正序展开进核心 `hookOrder`；MultiHook 本身不再安装 |
| `multisig` | MultiSigVerifier 根（≤10 子项，阈值） | 核心持有阈值政策；成员以 `thresholdMemberEligible` validator 安装；成员顺序保留 |
| `unknown-plugin` | 根/子项合约哈希不在已批准 v4 模块集内 | `MigrationRequired`；不做投机映射 |
| `owner-only` | 旧永久 owner-only 账户（0x22 语义） | 迁移但 owner-only 标志存入 0x51 并继续约束该账户 |
| `market-locked` | 导出时有活跃 escrow/listing 标记（0x06/0x07/0x1D） | 迁移账户；0x5D 记录绑定；Market settle/cancel 复验代际；owner 逃生只写 0x59 |
| `recovery-pending` | 导出时有 pending escape/恢复 | 先在旧核心完成或取消再重导出；新核心绝不延续旧 pending |

旧 pending 配置/调用**不是**授权源：仅作为证据导出并丢弃。

## 3. Manifest 格式

每网络一个 JSON 文档（canonical JSON：键排序、无多余空白；其 SHA-256 即
`manifestDigest`）。Schema 骨架：
`tests/fixtures/sa-module-protocol/migration-manifest.template.json`。

```json
{
  "manifestVersion": 1,
  "protocolVersion": 4,
  "network": 860833102,
  "legacyCoreHash": "…",
  "newCoreHash": "…",
  "exportedAt": 1765000000000,
  "scan": {
    "accounts": 407,
    "legacyPrefixRows": { "0x01": 407, "0x12": 84, "0x1C": 3 },
    "artifactDigest": "…"
  },
  "accounts": [
    {
      "accountId": "…",
      "accountAddress": "…",
      "classification": "multisig",
      "legacyState": {
        "verifier": "…", "hook": "…", "backupOwner": "…",
        "escapeTimelock": 86400, "escapeTriggeredAt": 0,
        "frozen": false, "ownerOnly": false,
        "pendingConfig": null, "pendingCalls": []
      },
      "legacyModules": [
        { "role": "verifier-root", "contractHash": "…",
          "contractId": 42, "updateCounter": 1, "nefSha256": "…",
          "children": [ { "contractHash": "…", "type": "verifier" } ] }
      ],
      "legacyThreshold": { "members": 10, "value": 3 },
      "legacyHookOrder": ["childHashA", "childHashB"],
      "legacyNonces": [ { "channel": "…", "cursor": 7 } ],
      "marketLock": { "listingId": 5, "escrowContract": "…" },
      "targetState": {
        "modules": [
          { "moduleId": 1, "type": 1, "contractHash": "…",
            "credentialGeneration": 1,
            "source": "legacy-verifier-root" }
        ],
        "hookOrder": [1],
        "thresholdPolicies": [
          { "policyId": 2, "threshold": 3, "memberIds": [1,2,3] }
        ],
        "recoveryTimelockMs": 604800000,
        "defaultPolicy": { "operation": "builtin", "message": "builtin" }
      },
      "idempotencyKey": "network:accountId:manifestDigest"
    }
  ]
}
```

字段规则：

- `legacyModules[].children` 列出子模块登记（0x23/0x24 根）—— 仅证据；children
  绝不作为独立安装迁移。
- `targetState` 是分类器计算的*建议* v4 状态；owner 可在 24 h 意图窗口内修订；
  确认绑定最终精确动作摘要。
- `targetState` 的 `moduleIds` 在新核心上从 1 起确定性分配（先 verifier 根、再
  按旧序 children、再按 hookOrder 的 hooks、最后政策成员）。
- 每个导入实例 `credentialGeneration` 从 1 开始；旧代数/nonce 历史*不*带入新
  实例的凭证空间。
- `legacyNonces` 只服务于协议 §6 的单调合并规则：新游标 =
  `max(旧 channel 游标, 新 0x56 值)`，绝不降低。
- `classification: unknown-plugin` 的账户 `targetState` 为 `null`，另附 `required`
  块列出 owner 必须决定的事项。

## 4. 幂等要求

- 重复提交同一 `(accountId, manifestDigest)` 迁移意图为 no-op（不是错误、不是
  二次安装）。
- manifest 摘要在导入时存入 `0x5A`；同账户后续意图必须引用它。中途被中断（交易
  FAULT）的导入不留下任何部分状态（交易原子性），账户保持 `MigrationRequired`；
  重试整意图重跑。
- 一旦 `Active`，重复导入被拒绝 —— 除非同时引用已记录摘要*且*动作集为空（证明
  是 no-op）；否则 `SA_MIGRATION_REQUIRED` 式守卫会把它当作普通配置处理。
- 迁移绝不删除旧数据：0x01 行（普通版）与原生 14-slot 记录留在其合约上作为历史
  证据；新核心只在 0x5A 记录失效声明（0x12/0x1C）与摘要。
- 旧签名、旧 pending 意图、0x12 行与 0x1C 行绝不在新核心上成为授权输入
  （协议 §7.4）。
- 有状态额度/限额历史（DailyLimitHook 等）连同计数器导入；导入失败保持
  `MigrationRequired` —— 历史绝不静默清零；owner 可另行显式选择延迟重置。
- 合约 custody 的消息主体在迁移设置中需 owner 显式授权 —— 绝不从 custody 地址
  推断。

## 5. 验收证据（每账户）

1. 旧导出行与迁移时的链上回读一致。
2. 新账户状态与 `targetState` 完全一致（模块数、id、顺序、阈值、代数）。
3. 新核心 `authorityEpoch`/`configurationNonce` ≥ 旧导出值（有定义处）；nonce
   游标不降。
4. 旧式签名/pending 对新核心的重放尝试失败（回归 fixture，协议 §16.3）。
5. 迁移后两网复扫一致。

这些将成为
`tests/fixtures/sa-module-protocol/golden-vectors/migration.template.json`
的 golden fixture 条目（kernel 批次 39/40 填入期望输出）。

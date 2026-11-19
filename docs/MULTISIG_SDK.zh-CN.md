# 阈值 SDK 与前端会话

> 中文版本与 `docs/MULTISIG_SDK.md` 同构。若两者冲突，以英文版本为准。

v4 没有 MultiSig 根，也没有验证器子项。阈值是安装在账户上的验证器模块之上的一层策略：成员就是同一个账户的模块 id，每个成员各自持有自己的凭证代数，而操作只携带一个装配好的签名字段。`shared/multiSigCore.mjs` 是唯一实现；JS SDK（`createThresholdClient`）与前端（`createThresholdSession`）只是把它绑定到某个客户端与某个 RPC。

1. 成员来自核心。`prepareMembers` 读取每个成员的模块描述符——是否已安装、`thresholdMemberEligible`，以及当前的 `credentialGeneration`——并返回每个成员必须签名的 §5 成员摘要。调用方自报的代数从不被信任：过期的代数会产出一个被核心以 `SA_CREDENTIAL_STALE` 拒绝的摘要。
2. 装配是显式的。`assembleSignature({ members })` 序列化 `[moduleId, 64 字节签名]` 对，`assembleOperationSignature({ operationDigest, members })` 返回 `{ signatureHex, members }`，其中 `signatureHex` 就是 13 字段操作的字段 11。
3. 策略本身就是配置。成员与阈值由配置意图中的 `setThresholdPolicy` 动作设定——`[7, policyId, threshold, memberIds[], active]`——因此生效前有 24 小时成熟期。`policyId = 0` 从与模块实例相同的单调分配器取一个新 id，所以策略 id 永远不会与模块 id 冲突。停用策略不携带成员，并释放这些成员以便卸载。

```js
const { createThresholdClient } = require('smart-account');

const threshold = createThresholdClient({ client });
const prepared = await threshold.prepareMembers({
  accountId,
  operationDigest,
  memberIds: [1, 2, 3],
});
// 每个成员用自己的验证器密钥签名 prepared[i].digest。
const signatureHex = threshold.assembleSignature({
  members: [{ moduleId: 1, signature }, { moduleId: 2, signature }],
});
```

前端会话（`frontend/src/features/operations/multiSig.js`）只通过调用方指定的那一个核心读取，因此一个会话不可能混用两个网络的值：

```js
import { createThresholdSession } from './features/operations/multiSig.js';

const session = createThresholdSession({ rpcUrl });
const prepared = await session.prepareMembers({
  networkMagic,
  coreContractHash,
  accountId,
  operation,
  memberModuleIds: [1, 2],
});
// `preview` 重新读取核心的校验结果；`readProxyHash` 读取账户代理。
// 每一次读取都走会话被指定的那个核心哈希。
```

阈值计的是验证器实例，而不是独立的密钥或人。不同模块可以共享凭据或控制方，因此一次成功的法定人数并不建立签名方独立性。

## 配置成员

成员配置就是普通的模块配置：对验证器实例调用 `configure` 需要在配置意图中携带 `configureModule` 动作，因此它与其它任何意图一样走 24 小时成熟期，且模块无法配置自身。轮换凭证则是即时的：`revokeCredentials(accountId, moduleId)` 是托管方授权的核心动作，会当场提升该实例的代数，这也是为什么绑定旧代数的签名在它执行的那一刻起就不再有效。

核心没有暴露读取策略的方法。策略通过 `ThresholdPolicySet` 通知（`accountId`、`policyId`、`threshold`、`memberIds`）可观测，每个成员实例则通过 `getModule` 可观测——描述符携带 `credentialGeneration` 与 `thresholdMemberEligible`，正是成员摘要绑定的那两个值。要读取尚未生效的意图及其成熟时间与动作摘要，请用 `getPendingConfiguration`，并在确认前把该摘要与你实际提案的意图比对；仅有一条待生效记录并不能证明它携带你期望的变更。

## 证据与边界

`MultiSigSdkVectorTests.cs` 运行真实的 JS 序列化器，把其字节与 VM 的 `StdLib.Serialize` 比对，拒绝错位与重复的成员条目，并针对一次真实的核心操作演练阈值路由。序列化器上限为 10 个成员与 65,535 字节总量；空十六进制是 ByteString，与 null 不同。

SDK 单元测试覆盖成员摘要、代数绑定、畸形签名与装配顺序。前端测试校验 RPC Array 与 base64 ByteArray 的传输编码。本工作不引入任何新的通用“多签已完成”徽标。

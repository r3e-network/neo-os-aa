# 动作身份登记与会话

> 中文版本与 `docs/action-sessions.md` 同构。若两者冲突，以英文版本为准。

SocialRecoveryVerifier 的动作会话使用一套独立的、由所有者登记的身份集合。恢复因子绝不会被复制进去。初始所有者仍要针对已固定核心的备份所有者注册表认证 `setupRecovery`。后续登记使用验证器的**当前所有者**，包括经阈值 / 时间锁恢复更换后的所有者；它不会替代旧的核心备份所有者。

所有者显式调用 `setActionIdentity(accountId, masterNullifier, enabled)`。32 字节的 master nullifier 是既有的、由 DID 推导的身份根；该交易授予独立的动作用途。仅凭提供方登录或 DID 绑定响应，并不授予该用途。界面的登记 / 撤销按钮只在被点击时才请求常规的所有者钱包交易。恢复仍通过其既有的恢复票据、阈值与时间锁路径保持无所有者参与。动作成员资格既不计为恢复批准，也不绕过恢复。

源码读取函数 `SocialRecoveryVerifier.GetActionAuthorizationEpoch(accountId)` 返回持久的、单调递增的整数。新的登记 / 移除、全部撤销、会话撤销、共享信任配置变更、恢复终结、清理与初始化都会推进它。清理会删除授权 / 会话授权，但**保留**该 epoch。新增身份不会移除其他已登记身份；它会使上一 epoch 的未决票据与会话失效。对已存在身份的空操作登记不会推进 epoch。身份列表上限为 16 项。整数耗尽会原子出错；epoch 绝不回绕或重置为零。

## 线上的合约约定

- 编码：`neo_n3_action_v4`；既有的两个选择器名称 `callback_encoding` 与 `result_encoding` 都会到达同一个签发守卫。冲突值会失败。
- 动作 ID 保留精确的 `sa_proxy:` 公式，绑定网络文本、原始 core/account/executor 字节、会话 nonce 与到期时间。
- 摘要：`SHA256(UTF8("neodid-sa-action-v3") || LP(network) || rawCore20 || rawAccount20 || rawVerifier20 || LP(accountText) || rawExecutor20 || LP(actionId) || LP(expiryDecimal) || actionNullifier32 || masterNullifier32 || LP(authorizationEpochDecimal))`。`LP` 是一个 UTF-8 字节计数字节，其后紧跟那些确切的 UTF-8 字节（最多 255 字节）。不要裁剪不透明的签名文本、规范化 Unicode，或在摘要中反转原始 UInt160 字节。
- Oracle 数据包：ASCII `4|base64(master32)|epochDecimal|base64(actionNullifier32)|base64(signature64)`。恰好五个字段；epoch 是正数的规范十进制。DID 所有者源导出其编码器。恢复数据包 v3 及其摘要域保持不变。
- 手动录入：`submitActionTicket(accountId, executor, actionId, expiresAt, masterNullifier, authorizationEpoch, actionNullifier, verificationSignature)`。手动与 Oracle 路径共享激活当前的成员资格 / epoch 守卫，随后是既有的上下文 / 签名 / 到期 / 重放检查与原子会话 / nonce 写入。Oracle 请求会单独保留其原始 epoch，因此迟到的响应无法借用更晚的登记代际。

签发方在 TEE 内认证提供方 UID，并从既有的服务器盐值推导同一个 master nullifier。服务器持有的读取器必须在一个连贯状态下证明：已配置的规范核心 → 已安装验证器 → 当前动作授权、确切账户 / 上下文、epoch 与会话 nonce。未知、缺失、FAULT 或不连贯的读取会在任何托管签名之前失败。调用方的 RPC URL、所有者字符串、提交的授权或有效 JWT 本身都无法提供该权限。动作车道不会继承恢复提供方的覆盖配置。

## 活跃会话的所有者重新授权

当某个会话的授权行因 epoch 推进而失效时，其会话执行分支会返回 false，直到当前所有者显式调用 `reauthorizeActiveActionSession(accountId, expectedExecutor, expectedActionId, expectedExpiresAt, expectedActionNullifier)`，或授权一个新的会话。该方法在记录同意之前比对确切展示的元组；并发替换无法获得意外批准。常规的当前所有者执行仍然可用。重新授权不会登记身份，也不会授予创建后续会话的许可。epoch 变化同样会使这项会话专属同意失效。

请保留盐值与稳定的身份根。既有用户用所有者钱包登记动作用途；他们不会在 NeoDIDRegistry 中重新注册已消耗的 nullifier。部署需要重新构建的工件，以及显式的消费方 / 签发方 / Services 组合方案；源码变更与模拟控件不能建立编译或生产就绪。

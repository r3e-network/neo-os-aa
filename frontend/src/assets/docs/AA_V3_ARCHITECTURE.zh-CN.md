# Neo N3 抽象账户 V3 历史架构说明

> 本文是 V3 设计阶段的历史说明，不是当前部署或协议采纳证明。当前运行时行为、
> 普通用户合约的能力边界、正式验证收据和发布状态以
> [`docs/AA-SYSTEM-STATUS.md`](AA-SYSTEM-STATUS.md)、
> [`docs/ORDINARY_ACCOUNT_WORKSPACE.md`](ORDINARY_ACCOUNT_WORKSPACE.md)、
> [`docs/AA-FORMAL-VERIFICATION.md`](AA-FORMAL-VERIFICATION.md) 以及对应的
> `implementations/*/profile.json` 为准。本文中的方案、示例和产品设想不能替代
> 当前 ABI、字节码、链上回读或原生 AccountManagement 的协议激活。

当前普通合约的源码检查已通过；公共回调资源隔离、候选源码升级、部署等价性和
原生协议激活仍有待验证，不能据此宣布协议整体 GO。

## 历史设计与当前实现的区别

历史方案希望组合社交身份、不同曲线的签名、链下策略和代付，降低 Neo N3
账户使用门槛。以下说明按当前普通合约源码更正旧设计；不证明某一公共部署
已经包含最新源码，也不表示链下身份、TEE 服务或钱包兼容性已经通过验收。

### 账户与状态

普通注册的 accountId 由注册域、BackupOwner、验证器、初始化参数、Hook 和恢复
等待期确定，不使用任意随机 salt。平台账号另有 registrar 控制的绑定和稳定
标识路径。accountId 用于核心管理；资产接收地址是核心派生的 proxy script hash，
两者不能混用。

每个账号不需要单独部署合约，但注册、存储和执行仍消耗手续费。核心保存账号
配置、各通道 nonce、待处理配置、恢复、市场托管和授权上下文等状态。验证器和
Hook 也保存公钥、会话、预算或策略等逐账号状态；它们不是无状态纯计算插件。
当前入口接受有界的目标合约、方法和参数，不提供任意 NeoVM 字节码执行入口。

nonce 的唯一执行规则是 `0 <= nonce < 2^255`：高 191 位为通道，低 64 位为序列。
每个通道从序列零独立递增，序列耗尽后不能在同一通道继续执行；没有按数值切换
的 UUID、随机盐或 bitmap 模式。成功交易原子消耗 nonce，交易失败回滚状态。

### 插件与升级

普通账号的 BackupOwner 以 Neo 见证授权配置。首次安装空槽位可立即生效；替换
已有验证器或 Hook 先提案，等待 24 小时后确认，也可取消。核心合约可以升级：
管理员必须先固定 NEF 与 manifest 摘要，等待至少七天，再提交匹配的 artifact。
插件也有独立管理与升级权限；配置前应审阅权限、依赖和清理行为。

当前候选源码的平台 BackupOwner 轮换采用七天提案、确认与取消流程，确认还要求
新所有者见证；旧公共 artifact 的立即轮换行为不能当作这一候选流程的部署证明。

### 身份与签名能力

- Web3AuthVerifier 验证其特定域和编码的 secp256k1 操作签名。普通 UserOperation
  使用 64 字节 `r || s`；消息验证适配器另接受 64 或 65 字节签名。社交登录和
  DID 映射是独立集成，不能由一个有效操作签名推断用户身份或凭证真实性。
- TEEVerifier 仅验证已配置 P-256 公钥对 AA payload 的签名，不在链上核实
  远程证明、飞地厂商、硬件持钥、隐私或链下策略执行。它们需要独立链下证据。
- WebAuthnVerifier 当前是裸 P-256 签名验证器，不检查 WebAuthn challenge、
  rpIdHash、origin、authenticatorData 标志或签名计数器。不能宣称已有完整
  Passkey、FaceID/指纹或浏览器来源绑定；普通 WebAuthn assertion 也不能直接
  当作相同 payload 的签名。
- ZKEmailVerifier 明确拒绝操作，尚无真实邮件证明验证。邮件恢复、DKIM 和
  链上隐藏邮件内容是未实现的设计目标。
- SessionKeyVerifier、SubscriptionVerifier 和策略 Hook 的权限及计量以各自
  实现为准；不能把临时登录解释为自动授予会话权限或无限制、无风险使用。
- MultiSigVerifier 与 MultiHook 有配置和依赖限制；同名插件并不自动表示可组合。
  当前普通 Web3Auth、TEE、WebAuthn 验证器不宣称 composition 支持，不能以
  “EVM + Passkey + TEE”示例推断这种组合已经可用。

### 代付与调用资源

链上 AAPaymaster 保存 GAS 存款和赞助策略。中继先支付交易费用；普通 sponsored
入口执行账号操作后，在同一交易中结算报销，检查目标/方法、有效期、预算和
存款，并将报销额限制在交易实际费用内。结算失败会回滚操作状态，但已上链的
失败交易仍可能消耗中继手续费。Morpheus 链下预授权和模拟是额外提交检查，
不是链上结算的替代品。“用户免 Gas”只表示他人付费，不表示交易免费。

公共普通合约没有 verifier/Hook 的独立子调用 gas 预算。私有 PLATFORM 构建的
扩展 syscall、原生 AccountManagement 的预算或抽象 formal 模型不能关闭这个
公共门禁；资助任意未经审阅插件的操作仍是 NO-GO。

### 备用恢复

BackupOwner 可发起 `initiateEscape(accountId)`，等待账号配置的 7–90 天后显式
调用 `finalizeEscape(accountId, newVerifier)`；可选带初始化参数的重载，或以零
验证器恢复为 BackupOwner 授权。发起冷却为一小时，成功完成恢复会清除冷却标记。
到期不自动完成恢复。

恢复期间，仅成功且携带当前 BackupOwner 见证的操作可取消逃生；验证器签名
单独不能取消。丢失唯一备用密钥时，本路径不能替代其见证。完成恢复要清理旧
验证器和 Hook；故障或拒绝 `clearAccount` 的旧插件可能阻止完成。交易回滚是
状态完整性保障，不是无条件恢复或资产可用性保证。

### 使用与验收

按[普通账户工作台](ORDINARY_ACCOUNT_WORKSPACE.md)创建和治理账号，保存 accountId、
派生收款地址、BackupOwner 与恢复安排。提交后等待链上成功执行，钱包返回 txid
不等于成功。替换插件前审阅目标和参数；旧部署无法完整读取待处理项时不要盲目确认。

产品方案如链下自动交易、最大回撤、完整 Passkey、邮件恢复与身份凭证组合须逐项
实现和验收。当前 source 测试、候选 artifact、公共部署与独立回读分别构成证据，
不能用历史示例或局部通过结果宣布协议整体 GO。

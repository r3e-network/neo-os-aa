# 🚀 Neo N3 终极账户抽象 (AA) 与可信身份架构设计蓝图 V3

## 一、 系统宏观定位 (System Positioning)
本架构不仅是一个智能钱包底座，而是一个 **“多维身份与可信执行的统一聚合网关”**。
通过 Neo N3 的底层魔法，将异构身份（Web2 社交账号、Web3 DID）、异构签名（EVM、Passkey）与高隐私的计算环境（TEE）统一路由，实现**无私钥、无Gas、无感知的跨链级 Web3 体验**。

---

## 二、 核心生态矩阵 (The Ecosystem Matrix)

整个架构分为五大核心层域：

### 1. 多维身份层 (Identity & DID Layer)
解决“我是谁”的问题。该层不在链上做强绑定，而是通过密码学证明，将不同生态的身份映射到 Neo N3 的虚拟账户 (`AccountId`) 上。
* **NeoDID 集成**：将用户的 Neo N3 `AccountId` 与 W3C 标准的 `did:neo:xxx` 绑定。允许在账户状态中存储 DID 文档解析器的哈希，实现链上信誉、SBT（灵魂绑定代币）和 KYC 凭证的直接挂载。
* **Web2 身份映射**：通过 Web3Auth (MPC 机制) 或 OAuth，将 Twitter/Google 等身份对应到特定的 EVM 或 Passkey 公钥。
* **联邦身份证明 (Federated Proofs)**：无论是跨链地址还是社交媒体句柄，最终都收敛为一对可验证的公私钥体系，并以此控制 AA 账户。

### 2. 链下可信执行与代付层 (Off-chain Trusted & Relayer Layer)
解决“谁来证明、谁来付钱”的问题。
* **Morpheus TEE 节点 (可信执行环境)**：
  * **隐私策略计算**：用户的复杂“死人开关”条件（比如：检查某 API 确认我 180 天未活跃）或高频自动交易意图，均在 TEE 的 Intel SGX/TDX 飞地内运算。
  * **硬件级签名**：TEE 确认条件满足后，使用其硬件私钥签发指令。这意味着最复杂的逻辑不再需要消耗昂贵的链上 GAS。
* **Session Key 颁发者**：用户登录后，TEE 或前端签发一个高频临时会话密钥（限定 1 小时内在某全链游戏中无限砍怪）。
* **Bundler & Paymaster (中继与代付)**：
  * 官方或第三方运营的节点。它们接收用户的 `UserOperation`（含各类签名），将其打包成标准 N3 交易。
  * **Paymaster 逻辑**：如果该操作属于“官方空投”或“白名单 DApp 交互”，Bundler 直接使用自身账户的 GAS 为用户代付，实现完全免 Gas 的极致体验。

### 3. 核心网关引擎 (Core AA Gateway)
系统的心脏，唯一存储状态的 Neo N3 合约。采用**全局单例 (Global Singleton)** 模式，用户**零部署成本**。
* **虚拟账户 (Zero-Deployment Account)**：通过 Neo N3 独有的动态脚本和 `VerifyContext` 上下文锁机制，为每个用户生成一个可收款、能通过 `CheckWitness` 鉴权，但无需真实部署的虚拟地址。
* **状态极简存储**：仅存储该账户的 `Verifier ID`、`Hook ID` 和 L1 逃生舱状态。
* **混合防重放路由**：根据 Nonce 的大小，智能判断采用常规递增队列（适用于 DeFi）还是随机盐 Bitmap（适用于 TEE 高频并发）。
* **意图引擎 (Intent & Batch)**：支持单次调用、数组批处理，乃至直接下发一段包含逻辑的 NeoVM 字节码。

### 4. 异构鉴权插件生态 (Verifier Plugins)
解决“如何验证签名”的问题。验证器决定了“谁有权动用金库”。它们是预部署的**无状态 (Stateless)** 纯计算单例合约。作为系统的基石，我们提供了以下 7 个核心 Verifier 供灵活组合：
* **Web3Auth / EIP-712 Verifier (流量漏斗)**：
  * N3 上目前最杀手级的插件。
  * 直接接收以太坊标准的 EIP-712 Typed Data Hash 和 `v, r, s` 签名。
  * 内部使用 N3 底层的 `CryptoLib.VerifyWithECDsa`（针对 secp256k1 曲线）和自定义的 Keccak256，完美还原以太坊验签。使得 MetaMask 用户能无缝操控 N3 资产。
* **TEE / AI Agent Verifier (隐私与自动化中心)**：
  * 绑定特定的硬件公钥。只要 `UserOperation` 带有 TEE 节点的签名，即认为通过（因为复杂的商业逻辑已经在 TEE 内完成了预审）。
* **Session Key Verifier (高频交互利器)**：
  * 为短暂、高频的交互（如全链游戏、高频交易）提供临时授权密钥，支持细粒度的权限范围与过期时间设定。
* **WebAuthn / Passkey Verifier (原生生物识别)**：
  * 利用 `secp256r1` 曲线验证硬件支持的生物识别签名（如 iOS FaceID、Android 指纹、YubiKey）。
  * 实现标准移动设备上无密码、硬件级安全的登录体验。
* **ZK-Email Verifier (零知识邮件证明)**：
  * 验证基于标准 DKIM 邮件签名生成的零知识证明。
  * 允许用户仅通过发送电子邮件来恢复账户、批准大额交易或执行操作，且不在链上暴露邮件内容。
* **Multi-Sig / Threshold Verifier (异构多签阈值)**：
  * 支持复杂的异构阈值签名方案（例如：2/3 多签，需要一个 EVM 签名、一个 Passkey 和一个 TEE 签名）。
  * 非常适合 DAO 金库或高安全性的机构托管需求。
* **Time-based / Subscription Verifier (自动订阅付费)**：
  * 为定期付款和类似 SaaS 的订阅模型提供支持。
  * 允许预授权的代理在预定时间间隔内提取特定金额的资金，无需用户在线。

**内置冷钱包降级方案 (Built-in cold wallet fallback)**：
* 原生降级方案现已作为网关内置功能。当未设置外部 Verifier 时（Verifier 为 `UInt160.Zero`），退化为仅检查 `Runtime.CheckWitness`。这给传统的 N3 软硬件冷钱包留有后路，确保底层资产的绝对控制权且节省 GAS（无需额外跨合约调用）。

### 5. 策略与风控插件生态 (Hook / Middleware Plugins)
解决“能不能执行”的问题。Hook 决定了“这笔钱能怎么花”。执行操作前/后置的业务规则挂载点。包含 5 个核心 Hook：
* **MultiHook**：允许组合多个 Hook，实现复杂的混合风控策略（如同时要求白名单和限额）。
* **DailyLimitHook**：单日大额转账风控。
* **WhitelistHook**：锁定账户只能与受信任的智能合约交互。
* **TokenRestrictedHook**：限制账户只能操作特定种类的代币（如只能转账某种游戏币）。
* **NeoDIDCredentialHook**：执行某些特定 DeFi 操作前，验证账户是否在链上的 `NeoDIDRegistry` 中拥有匹配且处于激活状态的 NeoDID 绑定。

### 6. 用户可组合的杀手级解决方案 ("Lego" 架构实践)
通过 Verifier 与 Hook 的乐高式组合，V3 架构能够原生支持多种极具商业价值的账户模型：

* **方案 A：Web2 傻瓜式无感账户（默认配置）**
  * **组合**：Web3Auth Verifier + 空 Hook
  * **场景**：降低 Web3 门槛，用户只需 Web2 社交方式登录即可生成账户，没有任何转账限制，享受极简体验。
* **方案 B：“熊市囤币”定投金库（组合风控）**
  * **组合**：内置冷钱包降级方案 + DailyLimitHook + WhitelistHook (通过 MultiHook 组合)
  * **场景**：使用极致安全的硬件冷钱包作为控制权，同时限制每天只能转出少量资金，且只能与特定的定投或 DeFi 质押合约交互。
* **方案 C：AI 托管量化基金（意图驱动）**
  * **组合**：TEE / AI Agent Verifier + Max Drawdown Hook (或 NeoDIDCredentialHook / Custom Hook)
  * **场景**：将资金委托给运行在 TEE 内的 AI 代理，AI 根据市场信号自动交易，但通过 Hook 严格限制最大回撤（Max Drawdown）或只能参与通过 KYC 的合规池。
* **方案 D：全链游戏/电竞战队打金号**
  * **组合**：Session Key Verifier + TokenRestrictedHook
  * **场景**：游戏公会为代练玩家颁发 Session Key，限制其只能在游戏内高频操作并只能转移游戏内产生的打金代币，无法触碰金库的主力资产。

---

## 三、 极致安全架构：L1 原生逃生舱 (Escape Hatch)

考虑到 TEE 宕机、MPC 节点失效或 Web2 服务商倒闭的极端情况，必须保留非托管的底线。
本架构彻底抛弃了易遭攻击且极度耗费 GAS 的 Oracle 死人开关，改用**时间锁抢占模型**：

1. **绑定备份 (Setup)**：用户在 TEE/Web3Auth 中设定一个物理冷钱包地址（N3 原生地址）作为 `BackupOwner`，并设定 30 天的 `Timelock`。
2. **触发挂失 (Initiate)**：若 TEE/Web2 挂了，用户用冷钱包向网关发起 `InitiateEscape`，链上开始 30 天倒计时。
3. **防盗拦截 (Cancel)**：进行中的逃生倒计时**不会**被日常活动静默自动取消——那种设计会让触发恶意挂失的攻击者无限期冻结倒计时。链上逻辑（`UnifiedSmartWallet.Execution.cs`）中，只有由 `BackupOwner` 本人授权的操作才能取消挂起的逃生（`Only backup owner can cancel escape`），确保用户始终握有控制权，攻击者的企图随倒计时终结而破灭。若冷钱包被盗、黑客触发挂失，用户会在手机 App 收到警报，并可用自己仍掌控的密钥，以一笔备份所有者授权的操作取消该挂起逃生。
4. **主权接管 (Finalize)**：若逃生窗口期满且未发生备份所有者授权的取消，冷钱包直接获得最高权限，重置整个 AA 账户的 Verifier 插件，实现绝对的 L1 资产主权。

---

## 四、 核心工作流：多维协议的完美融合 (End-to-End Flow)

这里以**“Web2 玩家通过 TEE 代发，免 Gas 游玩 N3 全链游戏”**为例，展示各组件如何如齿轮般咬合：

**阶段 1：身份建立与授权 (NeoDID + Web3Auth + TEE)**
1. 用户在前端使用 Google 登录 (Web3Auth)，生成以太坊 EIP-712 密钥对。
2. 前端请求 NeoDID 注册服务，将该以太坊公钥与 `did:neo:xxx` 建立关联，并获取到对应的 N3 虚拟账户地址 (`AccountId`)。
3. 用户签署一份 EIP-712 授权：“我允许 TEE 节点 0xABC 在未来 24 小时内，每天最多动用 100 GAS 用于游戏”。

**阶段 2：高频游戏动作 (TEE + Salt Nonce)**
1. 玩家在游戏中点击“攻击”。
2. 请求发往 TEE 节点。TEE 节点在内存飞地中核对：授权有效、未超时、未超额。
3. TEE 节点使用自身的硬件私钥，构造一个 `UserOperation`，签发交易。
4. **关键优化**：为了防止高频点击导致 Nonce 冲突，TEE 在 `UserOp` 中填入 UUID 作为 **Salt Nonce**。

**阶段 3：免 Gas 上链 (Bundler + Paymaster)**
1. TEE 将签名打包给游戏的官方 Bundler。
2. Bundler 作为 N3 的真正发起方，自己支付 N3 的 NetworkFee/SystemFee，将 TEE 签名的操作推入 AA 网关。

**阶段 4：极简路由与执行 (AA Gateway + Hooks)**
1. **查验重放**：AA 网关检查该 UUID Salt 未被使用，随后标记为已使用。
2. **短路鉴权**：AA 网关将数据直接路由给 `TEE Verifier` 插件，硬件验签秒过。
3. **安全拦截**：AA 网关检查当前未处于 `Escape Hatch`（逃生舱）锁定状态。
4. **策略钩子**：调用 `NeoDID Credential Hook` 确保玩家信誉分正常。
5. **代理伪装**：挂载 `VerifyContext` 锁，动态调用目标游戏合约。
6. **成功**：游戏合约反向 `CheckWitness` 虚拟地址成功，记录玩家状态。

---

## 五、 架构定调：为什么这是 N3 的终极答案？

1. **融合而非排斥**：通过 `EIP-712 Verifier`，完美吸纳了以太坊生态的开发者和现有钱包工具链；通过 `TEE Verifier`，将复杂的业务逻辑（时间、限额、多签阈值）转移到链下，保持链上底座的绝对精简。
2. **N3 底层压榨**：极致利用了 NeoVM 的 `VerifyContext` 和动态脚本，实现了真正的**零部署费虚拟地址**。彻底解决了以太坊 ERC-4337 饱受诟病的 Proxy 部署成本过高问题。
3. **真正的模块化 (Modular Smart Accounts)**：主合约永不升级。无论是接入新的身份标准（如未来的 Apple Passkey），还是接入更复杂的 DID 风控逻辑，只需新增几百行代码的无状态插件合约并挂载即可。

这不仅是一个智能钱包，这是为 Neo N3 打造的**全景式可信交互网关基础设施**。

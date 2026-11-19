# Morpheus 私密操作与 NeoDID 绑定（V4 架构）

> 中文版本与 `MORPHEUS_PRIVATE_ACTIONS.md` 同构。若两者冲突，以英文版本为准。

在 v4 智能账户架构下，内核保持精简：授权与策略都是通过配置意图安装的**模块实例**（`validator` 与 `hook`），恢复则由已安装的 `SocialRecoveryService` 代理，而不是绑定字段。Neo 智能账户系统仍然与 **Morpheus TEE 环境** 无缝集成，以启用私密操作 (Private Actions)、会话密钥 (Session Keys) 和 NeoDID 绑定。

## 工作原理

Morpheus 提供了一个基于 AWS Nitro Enclaves 的**可信执行环境 (TEE)**。这个链下安全飞地充当共同签名者或策略执行者，而不会将逻辑暴露给公共链；账户通过 `TeeKeyValidator` 模块验证飞地证明。

该过程完全通过 `TeeKeyValidator` 模块、`NeoDIDCredentialHook` 和链上的 `NeoDIDRegistry` 完成。

### 1. 通过 Web3Auth 绑定 NeoDID
用户可以将他们的 NeoDID 绑定到智能账户。这允许用户通过 Web3Auth 通过他们的社交账户（Google、Discord 等）授权操作，Web3Auth 解析为 NeoDID 签名。

- **前端:** 用户通过 Web3Auth 进行身份验证。
- **飞地 (Enclave):** Morpheus 飞地验证 Web3Auth 令牌并签署授权有效负载。
- **合约:** Oracle / NeoDID 流程先把绑定写入 `NeoDIDRegistry`，`NeoDIDCredentialHook` 再读取该注册表并校验目标操作所需的绑定是否处于激活状态。

### 2. 私密操作与隐私策略
对于那些不应在链上公开可见的策略（例如，每日限额、白名单地址或条件逻辑）：

1. 用户定义其策略并将其私密地存储在 Morpheus TEE 节点内。
2. 当用户希望执行操作时，他们将意图发送到 TEE 节点。
3. TEE 节点评估私密策略。
4. 如果获得批准，TEE 节点将签署有界 nonce 域中的通道和严格下一个序列，或直接签署交易哈希。
5. 在允许操作继续之前，N3 上的 `TeeKeyValidator` 模块会验证飞地的硬件级签名。

### 3. 会话密钥 (Session Keys)
会话密钥允许应用程序代表用户提交操作，而无需每次都提示输入签名，其受 TEE 执行的限制的约束。

- 生成临时密钥对，并作为 `SessionKeyValidator` 实例安装。
- TEE 签署将临时密钥绑定到特定限制（例如，时间、代币数量）的证书。
- `SessionKeyValidator` 实例检查证书，只要满足会话约束就处理操作。

## 验证流程 (V4)
1. **准备:** 客户端构建操作（13 字段 v4 意图）并收集标准 N3/EVM 签名。
2. **TEE 签名:** 客户端请求 Morpheus 飞地评估隐私策略。飞地返回一个 `ActionTicket`。
3. **执行:** 提交操作。账户按模块顺序运行已安装的验证器，`TeeKeyValidator` 对飞地的签名进行身份验证，从而验证了链下私密规则。

通过将策略逻辑保留在 TEE 内部并只在链上安装验证器模块，v4 内核显著降低了 Gas 成本和部署复杂性，同时保留了强大的隐私和 NeoDID 支持。

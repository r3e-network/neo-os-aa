# 插件开发者安全指南

> 中文版本与 `docs/PLUGIN_DEVELOPER_GUIDE.md` 同构。若两者冲突，以英文版本为准。

## 概要

本指南面向为 Neo N3 Smart Account 生态构建 Verifier 或 Hook 插件的开发者。它涵盖插件开发的安全最佳实践、常见漏洞与必需接口。

**目标读者：** 智能合约开发者
**前置要求：** 熟悉 Neo N3、C# 与密码学原语
**安全状态：** 插件要进入经核验的生态，必须遵循这些准则。

---

## 0. 快速开始：从模板到已绑定插件

最快的正确路径是复制一个模板，而不是从空文件开始：

```text
contracts/plugins/templates/verifier/   minimal verifier (single-key secp256r1 authorization)
contracts/plugins/templates/hook/       minimal hook (fail-closed per-account target gate)
```

每个模板都针对随附插件所用的同一共享层编译
（verifier 用 `VerifierAuthority` / `VerifierPayload` / `VerifierModels` / `SignerDomain`，
hook 用 `HookAuthority`），暴露核心绑定期门禁所要求的精确 ABI，
并接好带时间锁的治理轨道（自升级、admin 轮换、核心重指向）。复制目录、重命名类与
`DisplayName`、替换被标记的策略方法，然后编译。分步演练与五个容易踩坑的规则见
[`contracts/plugins/templates/README.md`](../contracts/plugins/templates/README.md)。

`node scripts/check_plugin_templates.mjs` 会重新编译两个模板，并断言
其 manifest 仍满足绑定 ABI；仓库验证门禁在每次合约构建时运行它，
因此任何会破坏新插件的共享层改动都会先在这里失败。

---

## 1. 插件架构概览

### 1.1 两类插件

| 类型 | 职责 | 安全关注点 | 示例 |
| --- | --- | --- | --- |
| **Verifier** | "谁被授权？" | Web3Auth、TEE、WebAuthn、SessionKey |
| **Hook** | "允许做什么？" | Whitelist、DailyLimit、TokenRestricted |

### 1.2 插件存储以账户为作用域

```csharp
// GOOD: Stateless plugin
public static ByteString GetPublicKey(UInt160 accountId)
{
    byte[] key = Helper.Concat(Prefix_PubKey, (byte[])accountId);
    return Storage.Get(Storage.CurrentContext, key) ?? (ByteString)"";
}

// BAD: Stateful plugin with admin keys
private static readonly byte[] Prefix_Admin = new byte[] { 0xFF };
public static void SetAdmin(UInt160 newAdmin)
{
    // Never allow admin keys in plugins!
}
```

**规则：** 插件可以保留以账户为作用域的策略状态，但不得拥有
独立的 admin 密钥或特权可升级性。所有配置都经由 SA 核心合约流转，
且每个存储键都必须以账户标识作为命名空间。

---

## 2. Verifier 插件安全

### 2.1 必需接口

```csharp
public interface IVerifier
{
    // Capability marker; the SA core also checks the deployed manifest.
    bool SupportsV3();

    // Called by the SA core during validation
    bool ValidateSignature(UInt160 accountId, UserOperation op);

    // Called after target execution; implement as a no-op when unused.
    void postExecute(UInt160 accountId, UserOperation op, object result);

    // Mandatory lifecycle cleanup before a verifier is detached or an SA shell
    // is transferred. A fault must abort the enclosing transition.
    void clearAccount(UInt160 accountId);

    // Optional: Get exact payload bytes for signing
    ByteString GetPayload(UInt160 accountId, UInt160 targetContract,
        string method, object[] args, BigInteger nonce, BigInteger deadline);
}
```

绑定在两层都是 fail-closed。`supportsV3/0` 必须是 safe 的 Boolean
方法并返回 `true`，且部署的 manifest 必须暴露精确的
verifier 签名 `validateSignature(Hash160, Any) -> Boolean`、
`postExecute(Hash160, Any, Any) -> Void` 与
`clearAccount(Hash160) -> Void`。仅有标记、陈旧或类型错误的 verifier
会在其地址被写入存储之前被拒绝。hooks 受类似的
精确签名约束：`preExecute(Hash160, Array) -> Void`、
`postExecute(Hash160, Array, Any) -> Void` 与
`clearAccount(Hash160) -> Void`。manifest 存在只证明可调用面；
它并不证明方法的密码学或存储语义，因此新模块仍需
经审计的实现与具体的运行时/精化证据。`MultiSigVerifier`
与 `MultiHook` 对其配置的子模块施加同样的 manifest/部署预检。
两者都是复合模块，都会被作为子节点拒绝，并发布 safe 的
`supportsComposition() -> Boolean` 标记；核心拥有的依赖注册表只保留
叶节点子模块，并在替换或移除时执行其清理。这些检查
是 ABI/拓扑/生命周期守卫，而不是密码学独立性或任意
未来插件存储语义的证明。

### 2.2 Verifier 安全检查清单

| 检查 | 原因 | 实现 |
| --- | --- | --- |
| **payload 中的网络 ID** | 防止跨链重放 | 在哈希中包含 `Runtime.GetNetwork()` |
| **payload 中的账户 ID** | 防止账户混淆 | 在哈希中包含 `accountId` |
| **payload 中的 Deadline** | 防止旧签名被使用 | 在哈希中包含 `deadline` |
| **无副作用** | 校验必须是只读的 | 在适用处使用 `CallFlags.ReadOnly` |
| **有界 gas** | *(关键)* 防止 DoS | 匹配的私有 SA 工件使用 `System.Contract.CallWithGasLimit` 处理 verifier 与 hook 回调；ordinary 派生模块继承该回调的祖先预算。native 激活与公开部署仍是独立门禁。 |
| **签名长度检查** | 防止畸形输入 | 断言 `signature.Length == expected` |
| **只返回布尔值** | 校验模式 | 正常拒绝时不要抛异常 |
| **无状态变更** | 纯校验 | 绝不在 `validateSignature` 中写存储 |

### 2.3 常见漏洞

下面的 `PG-*` 标识是本指南的插件开发检查清单。项目的
漏洞台账是另一个命名空间，拥有自己的 `VULN-001` 至 `VULN-006`，位于
`docs/SECURITY_MODEL.md` 第 6.1 节；不要把 `PG-*` 条目当作台账条目。

#### PG-01：缺失网络 ID

**严重度：** 关键

```csharp
// VULNERABLE: Cross-chain replay possible
byte[] payload = Helper.Concat(accountId, targetContract, method, args, nonce, deadline);

// SECURE: Network ID prevents replay
byte[] payload = Helper.Concat(
    ToUint256Word((BigInteger)Runtime.GetNetwork()),  // <-- Required
    accountId, targetContract, method, args, nonce, deadline
);
```

#### PG-02：校验中的可变状态

**严重度：** 高

```csharp
// VULNERABLE: State change during validation
public static bool ValidateSignature(UInt160 accountId, UserOperation op)
{
    Storage.Put(Storage.CurrentContext, "lastValidated", Runtime.Time); // BAD!
    return CryptoLib.Verify(...);
}

// SECURE: Pure validation
public static bool ValidateSignature(UInt160 accountId, UserOperation op)
{
    return CryptoLib.Verify(...);
}
```

#### PG-03：无界 gas 消耗

**严重度：** 关键

```csharp
// VULNERABLE: DoS vector
public static bool ValidateSignature(UInt160 accountId, UserOperation op)
{
    // Loop can consume arbitrary gas
    for (int i = 0; i < op.Args.Length; i++)
    {
        HeavyCryptoOperation(op.Args[i]);
    }
    return true;
}

// REDUCED INPUT RISK ONLY: Bound iterations and reject oversized inputs.
// This does not replace a platform-enforced child budget.
public static bool ValidateSignature(UInt160 accountId, UserOperation op)
{
    ExecutionEngine.Assert(op.Args.Length <= 100, "Too many args");
    for (int i = 0; i < op.Args.Length; i++)
    {
        HeavyCryptoOperation(op.Args[i]);
    }
    return true;
}
```

#### PG-04：通过长度扩展伪造签名

**严重度：** 关键

```csharp
// VULNERABLE: Accepts any signature length
public static bool ValidateSignature(UInt160 accountId, UserOperation op)
{
    ByteString sig = op.Signature;
    // Missing length check!
    return CryptoLib.Verify(payload, pubKey, sig);
}

// SECURE: Enforce exact length
public static bool ValidateSignature(UInt160 accountId, UserOperation op)
{
    ByteString sig = op.Signature;
    ExecutionEngine.Assert(sig.Length == 64, "Invalid signature length");
    return CryptoLib.Verify(payload, pubKey, sig);
}
```

---

## 3. Hook 插件安全

### 3.1 必需接口

```csharp
public interface IHook
{
    // Capability marker; the SA core also checks the deployed manifest.
    bool SupportsV3();

    // Called before execution (can reject)
    void preExecute(UInt160 accountId, object[] opParams);

    // Called after execution (cleanup/logging)
    void postExecute(UInt160 accountId, object[] opParams, object result);

    // Mandatory lifecycle cleanup before removal or shell transfer.
    void clearAccount(UInt160 accountId);
}
```

上面的草图刻意使用部署时的拼写，因为这些就是 SA
核心调用的名字：你的插件部署的 manifest 必须导出它们，而按
草图方式声明的方法恰好导出该名字。合约构建使用 `nccs` 编译，它
会把每个导出成员的首字母小写化，因此一个声明了同样
三个回调 PreExecute、PostExecute 与 ClearAccount 的 hook 合约部署后的名字相同——
该规则对已经是小写的声明保持不变。该规则在
`neo-os-contracts` 的 `contracts/README.md` 中面向合约作者声明（"The deployed spelling of an exported member"）；
在文档中写 C# 拼写，是在声明一个部署并不携带的名字。

`opParams` ABI 是规范的，且在 `preExecute` 与 `postExecute` 中完全相同：

```text
opParams = [TargetContract, Method, Args, Nonce, Deadline, Signature]
```

账户 id 作为第一个回调参数单独传入。核心不得把不透明的
`UserOperation` 对象放在 `opParams` 位置：随附的 hooks 检查
`opParams[0]`/`[1]`/`[2]` 作为 target、method 与参数数组。Hook 实现必须把
该元组视为已签名的操作，且不得从任何独立的调用方控制值变更或重构授权。
核心的运行时套件通过真实 NeoVM 回调路径验证了正向 target
路径与未列入 target 的拒绝。

`clearAccount(accountId)` 是 verifier 与 hook 插件共同必需的
生命周期方法。它必须删除插件拥有的每个以账户为作用域的键，且
必须在内部清理失败时 fault。对于插件从未配置过的账户，它还必须
是幂等的，因为核心在每次
轮换时都会调用它。省略该方法的插件不仅是"不干净"：核心
对缺失方法的调用会不可捕获地 fault，因此绑定到该插件的每个账户
都被锁死（无法轮换 verifier、无法最终化逃生、无法
市场出售）。按账户托管用户资金的插件（例如恢复 verifier 的预言机额度）
必须在 `clearAccount` 中把它们归还给账户所有者，而不是让它们成为孤儿。

**转移来源是代理地址，绝不是账户 id。** 虚拟 SA 账户把资产存放在核心派生的代理脚本哈希
（`getProxyScriptHash(accountId)`）上，且在 `executeUserOp` 期间，该地址是代币
`CheckWitness` 唯一接受的 `from`。任何 pin、计量或列入允许列表转移来源的
verifier 或 hook，都必须与该地址比较
（`Contract.Call(core, "getProxyScriptHash", CallFlags.ReadOnly, accountId)`），
并声明 `ContractPermission("*", "getProxyScriptHash")`。与 `accountId` 比较，
授权的是永远无法移动资金的转移，计量的是永远为零的
余额。SA 核心把清理 fault 视为失败的
外层转换；它不得吞掉该 fault 并把可能脏的账户外壳交给
买方或替换模块。这对已知插件是 fail-closed，
但不证明任意未来合约没有无关存储。

**你在插件内部检查的 witness 需要一个能到达该插件的签名者作用域。**
Verifier 与 hook 作为来自核心的嵌套调用执行，因此插件中的 `Runtime.CheckWitness`
只能看到作用域覆盖该插件合约的签名者。作用域为
`CalledByEntry` 的签名者核心可见，但插件看不到：`SubscriptionVerifier`
以 "merchant authorization required" 拒绝这类商户拉取，一旦
商户用能到达该 verifier 的作用域签名就接受。为你的插件检查的每个 witness
记录所需作用域，并优先使用命名该插件的 `CustomContracts`，
而不是 `Global`。

### 3.2 Hook 安全检查清单

| 检查 | 原因 | 实现 |
| --- | --- | --- |
| **权限校验** | 防止未授权配置 | 配置经由 SA 核心到达 hook，随附 hooks 以其存储的 `authorizedCore` 为门禁（`HookAuthority.ValidateAdminCaller`）；核心的读取方法是 `canConfigureHook(accountId, hookHash)` |
| **调用者校验** | 确保调用方是 SA 核心 | hook 把调用核心与其存储的 `authorizedCore` 比对；核心的读取方法是 `canExecuteHook(accountId, hookHash, …)` |
| **拒绝时 revert** | 原子拒绝模式 | 抛出 `ExecutionEngine.Assert` |
| **pre 中无外部调用** | 防止重入 | 只检查参数 |
| **谨慎的 post 逻辑** | post 中不做校验 | 只做清理/记录 |
| **状态一致性** | 幂等操作 | 处理重入/超时 |
| **clearAccount** | 移除时清理 | 删除账户的所有存储 |

### 3.3 常见漏洞

#### PG-05：preExecute 中的重入

**严重度：** 高

```csharp
// VULNERABLE: Can call back into the SA
public static void preExecute(UInt160 accountId, object[] opParams)
{
    // Check limit in storage
    BigInteger spent = GetSpent(accountId);
    if (spent + amount > limit) return;

    // Call external contract (DANGEROUS!)
    Contract.Call(opParams[0], "doSomething", CallFlags.All, ...);

    // Attacker re-enters with same operation!
}

// SECURE: No external calls in preExecute
public static void preExecute(UInt160 accountId, object[] opParams)
{
    BigInteger spent = GetSpent(accountId);
    if (spent + amount > limit)
    {
        ExecutionEngine.Assert(false, "Limit exceeded");
    }
    // Store for postExecute to consume
    Storage.Put(..., spent + amount);
}

public static void postExecute(UInt160 accountId, object[] opParams, object result)
{
    if (!DidExecutionSucceed(result)) return;

    BigInteger pending = GetPending(accountId);
    Storage.Put(..., 0); // Consume
}
```

#### PG-06：postExecute 中的双花

**严重度：** 高

```csharp
// VULNERABLE: Not checking if already consumed
public static void postExecute(UInt160 accountId, object[] opParams, object result)
{
    // Attacker calls postExecute twice!
    BigInteger current = GetSpent(accountId);
    Storage.Put(..., current + amount);
}

// SECURE: Use idempotent operations
public static void postExecute(UInt160 accountId, object[] opParams, object result)
{
    if (!DidExecutionSucceed(result)) return;

    byte[] pendingKey = GetPendingKey(accountId);
    ByteString? pending = Storage.Get(Storage.CurrentContext, pendingKey);

    ExecutionEngine.Assert(pending != null, "Already consumed");

    BigInteger amount = (BigInteger)pending;
    Storage.Delete(Storage.CurrentContext, pendingKey);

    BigInteger current = GetSpent(accountId);
    Storage.Put(..., current + amount);
}
```

#### PG-07：错误的结果处理

**严重度：** 中

```csharp
// VULNERABLE: Falsy results treated as success
public static void postExecute(UInt160 accountId, object[] opParams, object result)
{
    // result = 0 means failure, but we still spend!
    Storage.Put(..., GetSpent(accountId) + amount);
}

// SECURE: Check for actual success
private static bool DidExecutionSucceed(object result)
{
    if (result is bool asBool) return asBool;
    if (result is BigInteger asInt) return asInt != 0;
    if (result is ByteString asStr) return asStr.Length > 0;
    return true;
}

public static void postExecute(UInt160 accountId, object[] opParams, object result)
{
    if (!DidExecutionSucceed(result)) return;
    Storage.Put(..., GetSpent(accountId) + amount);
}
```

---

## 4. 配置安全

### 4.1 使用 VerifierAuthority

```csharp
// REQUIRED for all verifiers
public static void SetPublicKey(UInt160 accountId, ByteString pubKey)
{
    VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
    // ... actual storage ...
}
```

### 4.2 使用 HookAuthority

```csharp
// REQUIRED for all hooks
public static void preExecute(UInt160 accountId, object[] opParams)
{
    HookAuthority.ValidateExecutionCaller(accountId,
        Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
    // ... actual logic ...
}
```

### 4.3 常见配置错误

| 配置错误 | 风险 | 修复 |
| --- | --- | --- |
| **跳过权限检查** | 未授权配置 | 始终调用 `ValidateConfigCaller` |
| **直接访问存储** | 绕过核心合约 | 只访问带 `Prefix_*` 前缀的键 |
| **可变校验** | 绕过时间锁 | 绝不在没有核心的情况下让校验可升级 |
| **跨账户共享状态** | 跨账户泄漏 | 始终以 `accountId` 为前缀 |

---

## 5. 密码学最佳实践

### 5.1 规范 payload 编码

```csharp
// GOOD: Unambiguous encoding
private static byte[] BuildPayload(...)
{
    return Helper.Concat(
        ToUint256Word(network),
        Helper.Concat(
            accountId,  // Fixed 20 bytes
            ToLengthPrefixed(method)  // Length + bytes
        )
    );
}

// BAD: Ambiguous concatenation
private static byte[] BuildPayload(...)
{
    return Helper.Concat(accountId, method, args); // Collision possible!
}
```

### 5.2 哈希函数选择

| 用例 | 哈希函数 | 说明 |
| --- | --- | --- |
| **Neo 原生签名** | SHA256 | 通过 `CryptoLib` |
| **EVM 兼容** | Keccak256 | 通过 `NativeCryptoLib.Keccak256` |
| **payload 绑定** | 两者皆可 | 与 verifier 的签名算法匹配 |

### 5.3 公钥校验

```csharp
// GOOD: Explicit validation
public static void SetPublicKey(UInt160 accountId, ByteString pubKey)
{
    VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);

    // Check length (secp256k1 uncompressed = 65, compressed = 33)
    ExecutionEngine.Assert(
        pubKey.Length == 65 || pubKey.Length == 33,
        "Invalid public key length"
    );

    // Check valid point
    ECPoint? point = TryParseECPoint(pubKey);
    ExecutionEngine.Assert(point != null && point.IsValid, "Invalid public key");

    Storage.Put(..., pubKey);
}
```

---

## 6. 测试与审计清单

### 6.1 提交前

- [ ] 所有权限检查齐备（`ValidateConfigCaller`、`ValidateExecutionCaller`）
- [ ] 无可变的全局状态（无 admin 密钥）
- [ ] 所有 payload 哈希都包含网络 ID
- [ ] 所有 payload 哈希都包含账户 ID
- [ ] 所有 payload 哈希都包含 Deadline
- [ ] 强制签名长度
- [ ] 循环/递归有 gas 边界
- [ ] `preExecute` 中无外部调用
- [ ] `postExecute` 操作幂等
- [ ] `clearAccount` 删除所有存储前缀

### 6.2 安全测试

```bash
# Test 1: Replay protection
# Submit same operation twice - should fail on second attempt

# Test 2: Cross-chain replay
# Sign on mainnet, submit to testnet - should fail

# Test 3: Signature forgery
# Modify signature bytes - should fail

# Test 4: Gas DoS
# Pass large arrays - should reject or be bounded

# Test 5: Reentrancy
# Hook that calls the SA - should be rejected
```

### 6.3 审计要求

要进入官方插件列表，请提供：

1. **源码审阅** —— 完整的代码库访问
2. **测试覆盖** —— 单元 + 集成测试
3. **形式验证** —— （可选）数学证明
4. **Gas 分析** —— 最坏情况 gas 消耗
5. **第三方审计** —— （建议）独立审阅

---

## 7. 部署清单

- [ ] 合约 manifest 包含所需权限
- [ ] `ContractPermission("*", "canConfigureVerifier")`（verifiers）
- [ ] `ContractPermission("*", "canExecuteHook")`（hooks）
- [ ] 视图函数带 `Safe` 属性
- [ ] 状态变更发出事件
- [ ] 清晰记录安全假设
- [ ] 完成测试网验证
- [ ] 发布源码
- [ ] 地址在生态中注册

---

## 8. 资源

- **安全模型：** `docs/SECURITY_MODEL.md`
- **以太坊对比：** `docs/ETHEREUM_AA_COMPARISON.md`
- **协议覆盖：** `docs/PROTOCOL_COMPLETENESS_AUDIT.md`
- **核心合约：** `contracts/custom/SmartAccount.cs`
- **Verifier 示例：**
  - `contracts/plugins/verifiers/Web3AuthVerifier.cs`
  - `contracts/plugins/verifiers/WebAuthnVerifier.cs`
  - `contracts/plugins/verifiers/SessionKeyVerifier.cs`
- **Hook 示例：**
  - `contracts/plugins/hooks/WhitelistHook.cs`
  - `contracts/plugins/hooks/DailyLimitHook.cs`
  - `contracts/plugins/hooks/MultiHook.cs`

---

## 9. 报告安全问题

发现既有插件中的漏洞？请报告至：

1. **关键/高：** 邮件 `security@smart-account.org`
2. **中/低：** 在 GitHub 提 issue 并加 `[security]` 标签

请包含：
- 受影响的插件版本
- 漏洞描述
- 利用场景
- 建议的修复
- 概念验证（可选但有帮助）

---

## 10. 小结：设计即安全

| 原则 | 实现 |
| --- | --- |
| **最小权限** | 插件只访问账户专属状态 |
| **纵深防御** | 核心 → Verifier → Hook 分层 |
| **Fail Closed** | 拒绝未授权，而不是放行 |
| **机制经济性** | 最小 gas，无多余检查 |
| **开放验证** | 签名逻辑可审计 |
| **无秘密** | 所有状态都在链上 |

遵循这些原则，你的插件将成为 Neo Smart Account 生态中安全、可审计的组件。

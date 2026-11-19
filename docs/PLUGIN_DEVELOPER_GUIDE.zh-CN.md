# 模块开发者安全指南

> 中文版本与 `docs/PLUGIN_DEVELOPER_GUIDE.md` 同构。若两者冲突，以英文版本为准。

## 概要

本指南面向为 Neo N3 Smart Account 生态构建协议 v4 validator 或 hook 模块的开发者。它涵盖模块开发的安全最佳实践、常见漏洞，以及核心在安装与调用时强制校验的接口。

**目标读者：** 智能合约开发者
**前置要求：** 熟悉 Neo N3、C# 与密码学原语
**安全状态：** 插件要进入经核验的生态，必须遵循这些准则。

---

## 0. 快速开始：从模板到已绑定插件

最快的正确路径是复制一个模板，而不是从空文件开始：

```text
contracts/plugins/templates/validator/  minimal validator (single-key secp256r1 authorization)
contracts/plugins/templates/hook/       minimal hook (fail-closed per-instance target gate)
```

每个模板都针对随附模块所用的同一共享层编译
（validator 用 `ValidatorAuthority` / `ValidatorPayload` / `ValidatorModels` / `SignerDomain`，
hook 用 `HookAuthority`），暴露核心绑定期门禁所要求的精确 ABI，
并接好带时间锁的治理轨道（自升级、admin 轮换、核心重指向）。复制目录、重命名类、
`DisplayName` 与 `ModuleProfileJson`、替换被标记的策略方法，然后编译。分步演练与六个容易踩坑的规则见
[`contracts/plugins/templates/README.md`](../contracts/plugins/templates/README.md)。

`node scripts/check_plugin_templates.mjs` 会重新编译两个模板，并断言
其 manifest 仍满足绑定 ABI；仓库验证门禁在每次合约构建时运行它，
因此任何会破坏新插件的共享层改动都会先在这里失败。

---

## 1. 插件架构概览

### 1.1 两类插件

| 类型 | 职责 | 安全关注点 | 示例 |
| --- | --- | --- | --- |
| **Validator** | "谁被授权？" | NeoWitness、MultiSig、SessionKey、P256、Web3Auth、TeeKey、DelegatedIdentity |
| **Hook** | "允许做什么？" | Whitelist、DailyLimit、TokenRestricted、NeoDIDCredential |

两个角色都以实例形式安装：每次安装由核心分配 `moduleId`，同一份模块合约可以在一个账户上服务多个实例。组合由核心拥有——对 validator 实例施加阈值策略、对 hook 实例施加 `hookOrder`——模块之间从不互相调用。

### 1.2 模块存储以实例为作用域

```csharp
// GOOD: Stateless module
public static ByteString GetPublicKey(UInt160 accountId, BigInteger moduleId)
{
    byte[] key = ValidatorAuthority.InstanceKey(Prefix_PubKey, accountId, moduleId);
    return Storage.Get(Storage.CurrentContext, key) ?? (ByteString)"";
}

// BAD: Stateful module with admin keys
private static readonly byte[] Prefix_Admin = new byte[] { 0xFF };
public static void SetAdmin(UInt160 newAdmin)
{
    // Never allow admin keys in plugins!
}
```

**规则：** 模块可以保留以实例为作用域的策略状态，但不得拥有
独立的 admin 密钥或特权可升级性。每个键都从
`InstanceKey(prefix, accountId, moduleId)` 派生，因为同一模块在一个账户上可能安装多次；
`OnUninstall` 通过 `DeleteInstancePrefix(prefix, accountId, moduleId)` 删除每个前缀。
所有配置都经由 SA 核心的配置意图流转。

---

## 2. Validator 模块安全

### 2.1 必需接口

```csharp
// 每个可安装模块（validator 或 hook）都导出这套生命周期接口。
public interface IModuleLifecycle
{
    // 规范化的无空白 profile JSON；其 SHA-256 就是核心在安装时
    // 重新计算并绑定的 profile 摘要（规范 §12）。
    string GetModuleProfile();

    void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData);
    void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData);
    void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] deInitData);
}

public interface IValidatorModule : IModuleLifecycle
{
    // 对核心的规范 13 字段视图做只读授权。
    bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation);

    // 可选的执行后处理，仅作用于本实例；未使用时为空操作。
    void OnUserOpComplete(UInt160 accountId, object[] operation, object result);

    // 仅当 profile 声明 messageCapability 时导出。
    object[] GetSignerDomains(UInt160 accountId, BigInteger moduleId);
}

public interface IHookModule : IModuleLifecycle
{
    // 在目标执行前运行；返回至多 512 字节的 hook 数据。
    ByteString PreCheck(UInt160 accountId, object[] operation);

    // 执行后接收同一实例的 hook 数据。
    void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData);
}
```

绑定在三层都是 fail-closed。`getModuleProfile/0` 必须是 safe 的 String
方法，其规范字节的哈希等于核心存储的 profile 摘要；部署的 manifest 必须暴露
生命周期回调 `onInstall(Hash160, Integer, Integer, Array)`、
`configure(Hash160, Integer, Integer, Array)` 与 `onUninstall(Hash160, Integer, Integer, Array)`，
并暴露其所声明角色的回调对——validator 为
`validateUserOp(Hash160, ByteString, Array) -> Boolean` 与 `onUserOpComplete(Hash160, Array, Any)`，
hook 为 `preCheck(Hash160, Array) -> ByteString` 与
`postCheck(Hash160, Array, Any, ByteString)`。声明越界回调、或 profile
无法被核心重新哈希的模块，会在安装之前被拒绝。manifest 存在只证明可调用面；
它并不证明方法的密码学或存储语义，因此新模块仍需
经审计的实现与具体的运行时/精化证据。组合由核心拥有：
协议 v4 用核心阈值策略取代了复合 verifier、用 `hookOrder` 取代了复合 hook，
因此 `MultiSigValidator` 只校验一个已配置的子签名者，而
`MultiHook` 拒绝新安装。这些检查是 ABI/profile/生命周期守卫，而不是密码学独立性或任意
未来模块存储语义的证明。

### 2.2 Verifier 安全检查清单

| 检查 | 原因 | 实现 |
| --- | --- | --- |
| **域中的网络 ID** | 防止跨链重放 | 签名 `ValidatorPayload.SigningDigest`，它绑定核心操作摘要及其网络域 |
| **域中的账户 ID** | 防止账户混淆 | 同一辅助函数绑定 `accountId`、`moduleId` 与凭据代号 |
| **操作中的 Deadline** | 防止旧签名被使用 | `operation[6]` 已被核心摘要覆盖；策略有时窗要求时再与 `Runtime.Time` 比较 |
| **无副作用** | 校验必须是只读的 | 在适用处使用 `CallFlags.ReadOnly` |
| **有界 gas** | *(关键)* 防止 DoS | 匹配的私有 SA 工件使用 `System.Contract.CallWithGasLimit` 处理 validator 与 hook 回调；公开profile 派生模块继承该回调的祖先预算。native 激活与公开部署仍是独立门禁。 |
| **签名长度检查** | 防止畸形输入 | 断言 `((ByteString)operation[11]).Length` 等于期望长度 |
| **只返回布尔值** | 校验模式 | 正常拒绝时不要抛异常 |
| **无状态变更** | 纯校验 | 绝不在 `validateUserOp` 中写存储 |

### 2.3 常见漏洞

下面的 `PG-*` 标识是本指南的插件开发检查清单。项目的
漏洞台账是另一个命名空间，拥有自己的 `VULN-001` 至 `VULN-006`，位于
`docs/SECURITY_MODEL.md` 第 6.1 节；不要把 `PG-*` 条目当作台账条目。

#### PG-01：缺失网络 ID

**严重度：** 关键

```csharp
// VULNERABLE: 自建摘要遗漏了网络域与实例
byte[] payload = Helper.Concat(accountId, targetContract, method, args, nonce, deadline);

// SECURE: 签名共享绑定，它携带网络域、核心操作摘要、
// 规范 13 字段视图与模块实例。
ByteString digest = ValidatorPayload.SigningDigest(accountId, operationDigest, operation, moduleId);
```

#### PG-02：校验中的可变状态

**严重度：** 高

```csharp
// VULNERABLE: State change during validation
public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
{
    Storage.Put(Storage.CurrentContext, "lastValidated", Runtime.Time); // BAD!
    return CryptoLib.Verify(...);
}

// SECURE: Pure validation
public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
{
    return CryptoLib.Verify(...);
}
```

#### PG-03：无界 gas 消耗

**严重度：** 关键

```csharp
// VULNERABLE: DoS vector
public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
{
    // Loop can consume arbitrary gas
    for (int i = 0; i < operation.Length; i++)
    {
        HeavyCryptoOperation(operation[i]);
    }
    return true;
}

// REDUCED INPUT RISK ONLY: Bound iterations and reject oversized inputs.
// This does not replace a platform-enforced child budget.
public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
{
    ExecutionEngine.Assert(operation.Length == 13, "Non-canonical operation");
    object[] args = (object[])operation[3];
    ExecutionEngine.Assert(args.Length <= 64, "Too many args");
    for (int i = 0; i < args.Length; i++)
    {
        HeavyCryptoOperation(args[i]);
    }
    return true;
}
```

#### PG-04：通过长度扩展伪造签名

**严重度：** 关键

```csharp
// VULNERABLE: Accepts any signature length
public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
{
    ByteString sig = (ByteString)operation[11];
    // Missing length check!
    return CryptoLib.Verify(payload, pubKey, sig);
}

// SECURE: Enforce exact length
public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
{
    ByteString sig = (ByteString)operation[11];
    ExecutionEngine.Assert(sig.Length == 64, "Invalid signature length");
    return CryptoLib.Verify(payload, pubKey, sig);
}
```

---

## 3. Hook 插件安全

### 3.1 必需接口

```csharp
public interface IHookModule : IModuleLifecycle
{
    // 在目标执行前运行，可以拒绝；返回至多 512 字节。
    ByteString PreCheck(UInt160 accountId, object[] operation);

    // 执行后为同一实例运行；接收它自己的 hookData。
    void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData);
}
```

上面的草图刻意使用部署时的拼写，因为这些就是 SA
核心调用的名字：你的模块部署的 manifest 必须导出它们，而按
草图方式声明的方法恰好导出该名字。合约构建使用 `nccs` 编译，它
会把每个导出成员的首字母小写化，因此一个声明了同样
回调 PreCheck、PostCheck、OnInstall、Configure 与 OnUninstall 的 hook 合约部署后的名字相同——
该规则对已经是小写的声明保持不变。该规则在
`neo-os-contracts` 的 `contracts/README.md` 中面向合约作者声明（"The deployed spelling of an exported member"）；
在文档中写 C# 拼写，是在声明一个部署并不携带的名字。

两个回调都接收核心的规范 13 字段操作视图（见
[`docs/SA-MODULE-PROTOCOL.md`](SA-MODULE-PROTOCOL.md) 第 4.1 节），从不是调用方提供的元组：
`operation[1]` 是 target、`[2]` 是 method、`[3]` 是参数数组、`[12]` 是 hook 证明。
`preCheck` 返回它自己的 `postCheck` 所需字节（或空 `ByteString`），核心在同一次执行中
把它们回传给**同一实例**；hook 从不从调用方控制的值重构状态，返回超过 512 字节
会被拒绝。核心的运行时套件通过真实 NeoVM 回调路径验证了正向 target
路径与未列入 target 的拒绝。

`onUninstall(accountId, moduleId, generation, deInitData)` 是 validator 与 hook 模块共同必需的
生命周期方法。它必须删除模块拥有的每个以实例为作用域的键
（按前缀调用 `HookAuthority.DeleteInstancePrefix` 或 `ValidatorAuthority.DeleteInstancePrefix`），
且必须在内部清理失败时 fault。对于模块从未配置过的实例，它还必须
是幂等的，因为核心在每次卸载时都会调用它。省略该方法
的模块永远无法安装：核心的安装门禁会校验完整的生命周期 ABI。按实例托管用户资金的模块
（例如恢复服务的额度）必须在 `onUninstall` 中把它们归还给账户所有者，而不是让它们成为孤儿。

**转移来源是代理地址，绝不是账户 id。** 虚拟 SA 账户把资产存放在核心派生的代理脚本哈希
（`getProxyScriptHash(accountId)`）上，且在 `executeUserOp` 期间，该地址是代币
`CheckWitness` 唯一接受的 `from`。任何 pin、计量或列入允许列表转移来源的
validator 或 hook，都必须与该地址比较
（`Contract.Call(core, "getProxyScriptHash", CallFlags.ReadOnly, accountId)`），
并声明 `ContractPermission("*", "getProxyScriptHash")`。与 `accountId` 比较，
授权的是永远无法移动资金的转移，计量的是永远为零的
余额。SA 核心把清理 fault 视为失败的
外层转换；它不得吞掉该 fault 并把可能脏的账户外壳交给
买方或替换模块。这对已知插件是 fail-closed，
但不证明任意未来合约没有无关存储。

**你在模块内部检查的 witness 需要一个能到达该模块的签名者作用域。**
Validator 与 hook 作为来自核心的嵌套调用执行，因此模块中的 `Runtime.CheckWitness`
只能看到作用域覆盖该模块合约的签名者。作用域为
`CalledByEntry` 的签名者核心可见，但模块看不到：`SubscriptionValidator`
以 "merchant authorization required" 拒绝这类商户拉取，一旦
商户用能到达该 validator 的作用域签名就接受。为你的模块检查的每个 witness
记录所需作用域，并优先使用命名该模块的 `CustomContracts`，
而不是 `Global`。

### 3.2 Hook 安全检查清单

| 检查 | 原因 | 实现 |
| --- | --- | --- |
| **权限校验** | 防止未授权配置 | 每个回调开头调用 `HookAuthority.RequireLifecycle(accountId, moduleId)`；核心记录写入阶段，`getAuthorizedModuleId(accountId, phase)` 解析实例 |
| **调用者校验** | 确保调用方是 SA 核心 | `RequirePreCheck` / `RequirePostCheck` 同样拒绝任何非匹配阶段的非核心调用方 |
| **拒绝时 revert** | 原子拒绝模式 | 抛出 `ExecutionEngine.Assert` |
| **pre 中无外部调用** | 防止重入 | 只检查操作视图 |
| **谨慎的 post 逻辑** | post 中不做校验 | 只做清理/记录 |
| **状态一致性** | 幂等操作 | 处理重入/超时 |
| **onUninstall** | 移除时清理 | 对每个实例前缀调用 `DeleteInstancePrefix` |

### 3.3 常见漏洞

#### PG-05：preCheck 中的重入

**严重度：** 高

```csharp
// VULNERABLE: Can call back into the SA
public static ByteString PreCheck(UInt160 accountId, object[] operation)
{
    HookAuthority.RequirePreCheck(accountId, operation);

    // Check limit in storage
    BigInteger spent = GetSpent(accountId);
    if (spent + amount > limit) return (ByteString)new byte[0];

    // Call external contract (DANGEROUS!)
    Contract.Call((UInt160)operation[1], "doSomething", CallFlags.All, ...);

    // Attacker re-enters with same operation!
}

// SECURE: No external calls in preCheck
public static ByteString PreCheck(UInt160 accountId, object[] operation)
{
    HookAuthority.RequirePreCheck(accountId, operation);

    BigInteger spent = GetSpent(accountId);
    if (spent + amount > limit)
    {
        ExecutionEngine.Assert(false, "Limit exceeded");
    }
    Storage.Put(..., spent + amount);
    return (ByteString)new byte[0];
}

public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
{
    HookAuthority.RequirePostCheck(accountId, operation);
    if (!DidExecutionSucceed(result)) return;

    BigInteger pending = GetPending(accountId);
    Storage.Put(..., 0); // Consume
}
```

#### PG-06：postCheck 中的双花

**严重度：** 高

```csharp
// VULNERABLE: Not checking if already consumed
public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
{
    // Attacker calls postCheck twice!
    BigInteger current = GetSpent(accountId);
    Storage.Put(..., current + amount);
}

// SECURE: Use idempotent operations keyed by the instance
public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
{
    HookAuthority.RequirePostCheck(accountId, operation);
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
public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
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

public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
{
    if (!DidExecutionSucceed(result)) return;
    Storage.Put(..., GetSpent(accountId) + amount);
}
```

---

## 4. 配置安全

### 4.1 使用 ValidatorAuthority

```csharp
// REQUIRED at the head of every exported callback
public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData)
{
    ValidatorAuthority.RequireLifecycle(accountId, moduleId);
    // ... actual storage, keyed by InstanceKey(prefix, accountId, moduleId) ...
}

public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
{
    BigInteger moduleId = ValidatorAuthority.RequireValidation(accountId, operation);
    // ... authorize against the stored credential ...
}
```

`RequireLifecycle` 与 `RequireValidation` 从核心记录的写入阶段读取模块 id；绝不接受调用方传入的模块 id。

### 4.2 使用 HookAuthority

```csharp
// REQUIRED for both hook callbacks
public static ByteString PreCheck(UInt160 accountId, object[] operation)
{
    HookAuthority.RequirePreCheck(accountId, operation);
    // ... actual logic ...
    return (ByteString)new byte[0];
}

public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
{
    HookAuthority.RequirePostCheck(accountId, operation);
    // ... actual cleanup ...
}
```

### 4.3 常见配置错误

| 配置错误 | 风险 | 修复 |
| --- | --- | --- |
| **跳过权限检查** | 未授权配置 | 每个回调开头调用 `RequireLifecycle` / `RequirePreCheck` / `RequirePostCheck` |
| **直接访问存储** | 绕过核心合约 | 只访问带 `Prefix_*` 前缀的键 |
| **可变校验** | 绕过时间锁 | 绝不在没有核心配置意图的情况下让校验可升级 |
| **跨实例共享状态** | 跨实例泄漏 | 始终从 `InstanceKey(prefix, accountId, moduleId)` 派生键 |

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
| **payload 绑定** | 两者皆可 | 与 validator 的签名算法匹配 |

### 5.3 公钥校验

```csharp
// GOOD: Explicit validation
public static void SetPublicKey(UInt160 accountId, BigInteger moduleId, ByteString pubKey)
{
    ValidatorAuthority.RequireLifecycle(accountId, moduleId);

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

- [ ] 所有权限检查齐备（`RequireLifecycle`、`RequireValidation`、`RequirePreCheck`、`RequirePostCheck`）
- [ ] 无可变的全局状态（无 admin 密钥）
- [ ] 规范 `getModuleProfile()` 与发布的 `<Name>.profile.json` 一致
- [ ] 操作摘要通过 `ValidatorPayload.SigningDigest` 签名（网络、账户、实例、代号）
- [ ] 策略需要时，Deadline 与 nonce 窗口按 `Runtime.Time` 校验
- [ ] 强制签名长度
- [ ] 循环/递归有 gas 边界
- [ ] `preCheck` 中无外部调用
- [ ] `postCheck` 操作幂等
- [ ] `onUninstall` 删除每个实例前缀且幂等

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
- [ ] `ContractPermission("*", "getAuthorizedModuleId")`（validators 与 hooks）
- [ ] 模块需要解析实例或代理地址时，加入 `ContractPermission("*", "getModule")` 与 `getProxyScriptHash`
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
- **模块协议：** [`docs/SA-MODULE-PROTOCOL.md`](SA-MODULE-PROTOCOL.md)
- **模板：** [`contracts/plugins/templates/README.md`](../contracts/plugins/templates/README.md)
- **核心合约：** `contracts/custom/SmartAccount.cs`
- **Validator 示例：**
  - `contracts/plugins/validators/NeoWitnessValidator.cs`
  - `contracts/plugins/validators/MultiSigValidator.cs`
  - `contracts/plugins/validators/SessionKeyValidator.cs`
- **Hook 示例：**
  - `contracts/plugins/hooks/WhitelistHook.cs`
  - `contracts/plugins/hooks/DailyLimitHook.cs`
  - `contracts/plugins/hooks/MultiHook.cs`（拒绝新安装，保留作迁移取证）

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
| **纵深防御** | 核心 → validator → hook 分层 |
| **Fail Closed** | 拒绝未授权，而不是放行 |
| **机制经济性** | 最小 gas，无多余检查 |
| **开放验证** | 签名逻辑可审计 |
| **无秘密** | 所有状态都在链上 |

遵循这些原则，你的模块将成为 Neo Smart Account 生态中安全、可审计的组件。

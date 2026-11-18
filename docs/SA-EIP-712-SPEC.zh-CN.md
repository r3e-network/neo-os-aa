# EIP-712 类型化数据规范

> 中文版本与 `docs/SA-EIP-712-SPEC.md` 同构。若两者冲突，以英文版本为准。

本页是 V3 验证器在链上哈希并校验的 EIP-712 风格签名面的规范参考。字节层面的唯一事实来源是
`contracts/plugins/verifiers/Web3AuthVerifier.cs`；SDK 在 `shared/metaTxCore.mjs`（类型化数据形状）与
`sdk/js/src/metaTx.js`（字节精确的 payload 构造）中镜像它。凡本布局刻意偏离严格 EIP-712 之处，
都列在 [与严格 EIP-712 的偏离](#与严格-eip-712-的偏离) 一节。

## 域分隔符

类型字符串：

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
```

| 字段 | 取值 |
| --- | --- |
| `name` | `"Neo Smart Account"`（已部署验证器实际哈希的线格式常量；在 SA 协议字符串切换中从 `"Neo N3 Abstract Account"` 改为现值——切换前的旧域签名在本次切换时截止失效） |
| `version` | `"1"` |
| `chainId` | Neo 网络魔数（`Runtime.GetNetwork()`），例如主网 `860833102` |
| `verifyingContract` | **验证器**合约哈希（执行 `validateSignature` 的合约），20 字节 |

编码（`Web3AuthVerifier.BuildDomainSeparator`）：

```
domainSeparator = keccak256(
    EIP712_DOMAIN_TYPE_HASH ||
    keccak256("Neo Smart Account") ||
    keccak256("1") ||
    ToUint256Word(chainId) ||          // 32 字节大端字
    ToAddressWord(verifyingContract)   // 12 个零字节 || 20 字节大端
)
```

`EIP712_DOMAIN_TYPE_HASH` 为
`keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`
= `8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f`。

## UserOperation 结构体

类型字符串（V3）：

```
UserOperation(bytes20 accountId,bytes20 coreContract,address targetContract,string method,bytes32 argsHash,uint256 nonce,uint256 deadline)
```

`USER_OPERATION_TYPE_HASH` =
`keccak256("UserOperation(bytes20 accountId,bytes20 coreContract,address targetContract,string method,bytes32 argsHash,uint256 nonce,uint256 deadline)")`
= `577a3a6bd91683e300e814cd25ff6247ab7ca273ddd0153a99919d72ddf9fa04`。

字段编码（`Web3AuthVerifier.BuildMetaTxStructHash`）：

| 字段 | 字编码 |
| --- | --- |
| `accountId` | `ToBytes20Word`：20 字节哈希按**大端显示顺序**，**右**侧补 12 个零字节 |
| `coreContract` | 同一个 `ToBytes20Word`，作用于已授权的 SA 核心哈希（验证器所绑定的核心） |
| `targetContract` | `ToAddressWord`：12 个零字节后接 20 字节大端（标准 `address` 补位） |
| `method` | `keccak256(utf8(method))`——与 EIP-712 的 `string` 编码一致 |
| `argsHash` | 由核心计算的 `keccak256(StdLib.Serialize(op.Args))`（`computeArgsHash`）；该序列化是 NeoVM 的二进制栈项格式，不是 EVM ABI |
| `nonce` | `uint256` 大端 32 字节字 |
| `deadline` | `uint256` 大端 32 字节字（Neo `Runtime.Time` 毫秒） |

```
structHash = keccak256(
    USER_OPERATION_TYPE_HASH ||
    ToBytes20Word(accountId) ||
    ToBytes20Word(coreContract) ||
    ToAddressWord(targetContract) ||
    keccak256(utf8(method)) ||
    argsHash ||
    ToUint256Word(nonce) ||
    ToUint256Word(deadline)
)
```

## 签名 payload 与签名

```
payload = 0x19 || 0x01 || domainSeparator || structHash   // 66 bytes
digest  = keccak256(payload)
```

- 该 digest 以 **secp256k1 ECDSA** 签名；**没有 EIP-191 个人消息前缀**——`0x1901` 前缀就是唯一的信封。
- 链上签名是紧凑的 64 字节 `r || s` 形式（不含 `v`）。
  `Web3AuthVerifier.validateSignature` 断言长度恰为 64 字节。
- `nonce` 与 `deadline` 必须满足 `0 <= value < 2^255`（NeoVM 有符号
  `Integer` 的定义域）；SDK 构造器拒绝超出定义域的值。
- 账户 id 与注册绑定：`computeRegistrationAccountId`
  承诺了验证器、其参数、钩子、备份所有者以及逃生时间锁，因此为某一配置签出的签名
  无法被重放到另一配置上。

## 与严格 EIP-712 的偏离

1. `bytes20` 不是 EIP-712 的原子类型。本布局把它当作 32 字节字，其中 20 个哈希字节按大端
   **右**侧补零；而 EIP-712 的 `address` 是左侧补零。只有 `accountId` 与
   `coreContract` 使用它；`targetContract` 遵循标准的左补零
   `address` 编码。
2. `argsHash` 承诺的是参数列表的 NeoVM `StdLib.Serialize` 字节形式。跨语言签名方必须逐字节
   复现该序列化，或直接向核心读取 `computeArgsHash` 的结果。
3. `chainId` 承载的是 Neo **网络魔数**，不是 EVM 链 id。

这些偏离是刻意保留的：payload 在同一条链的 VM 内生成并校验，钱包侧签名由下面的字节精确
构造器提供，而不是由通用 EIP-712 实现提供。

## SDK 构造器

- `buildV3UserOperationTypedData(options)` —— 面向钱包与展示层的类型化数据
  （domain + types + message），对应上面的布局。
- `buildContractCompatibleDomainSeparator(network, verifyingContract)` ——
  字节精确的域分隔符。
- `buildContractCompatibleStructHash(options)` —— 字节精确的结构体哈希，
  包含 `bytes20` 右补零与 `StdLib.Serialize` 参数哈希。
- `buildWeb3AuthSigningPayload(options)` —— 完整的 66 字节
  `0x1901` 信封 payload，可直接交给原始 secp256k1 签名器。
- `SmartAccountClient.computeArgsHash(args)` —— 向核心索取规范
  `argsHash`，而不是在客户端重新实现序列化。

黄金向量测试（`sdk/js/tests/flow.unit.test.js`，即 "EIP-712 typed
data hash matches expected test vector"）端到端钉住了这一字节布局。

# 方法级精化

> 中文版本与 `docs/SA-METHOD-REFINEMENT.md` 同构。若两者冲突，以英文版本为准。

本文件收纳custom SmartAccount 候选的全部方法级精化泳道。它取代此前并列在 `docs/` 中的十三份泳道
文档，下面每条泳道的文字都未改动：只是标题层级下移了一级，使十三段彼此独立的论证读起来像一份
有序文档。

**各泳道不可相加。** 每条泳道都声明自己的作用域、自己的固定输入以及它留下未闭合的义务；一条
泳道中的回执永远不能清偿另一条，而共享的被导入声明也不得相加，仿佛每份回执都包含彼此不相交的
证明。此处没有任何内容认证整份合约、ApplicationEngine 组合、公开协议激活或部署。
[实现门禁](SA-IMPLEMENTATION-REFINEMENT.md)与[入口点闭合门禁](SA-ENTRYPOINT-CLOSURE.md)拥有这些
决定。

## 泳道

| # | 泳道 | 它确立什么 |
| ---: | --- | --- |
| 1 | [整 helper 精化清单](#whole-helper-refinement-inventory) | 工件身份、完整的 116 条指令表与固定的 ApplicationEngine 边界。仅结构性记账。 |
| 2 | [完整 helper 源码投影](#full-helper-source-projection) | 完整的类型化 Roslyn 树被翻译成证书所消费的语句／表达式语言。 |
| 3 | [完整报销 helper 参考精化](#complete-reimbursement-helper-reference-refinement) | 完整类型化源码方法体与一个逐字节解码的参考 VM 就单个 helper 的比较。 |
| 4 | [完整报销 helper 运行时检查](#complete-reimbursement-helper-runtime-checks) | 原始私有 helper 在固定引擎中执行：存储、编解码、故障与回滚。 |
| 5 | [预留算术精化](#reservation-arithmetic-refinement) | 正性、可表示的预留更新与协议费用上限；记录零费用溢出的分歧。 |
| 6 | [数值强制转换精化](#numeric-coercion-refinement) | GetInteger 解码及其取值关系，包含 Boolean 与 ByteString 输入。 |
| 7 | [ApplicationEngine 费用语义](#applicationengine-fee-semantics) | 固定 Neo 提交中完整的 AddFee(BigInteger, bool) 方法体。 |
| 8 | [公开纯方法参考精化](#public-pure-method-reference-refinement) | 三个公开纯方法体在声明的参考语义下获得证书。 |
| 9 | [公开受赞助入口运行时精化](#public-sponsored-entry-runtime-refinement) | 两个公开受赞助入口点在基础 ApplicationEngine 中端到端执行。 |
| 10 | [系统调用准入：`System.Contract.Call` 与 `CALLT`](#syscall-admission-systemcontractcall-and-callt) | System.Contract.Call 与 CALLT 准入，直到 CallContractInternal 参数元组。 |
| 11 | [interop 参数转换（内核检查，第十九号门禁作用域）](#interop-argument-conversion-kernel-checked-nineteenth-gate-scope) | 调用方的栈窗口变成被调用者的参数帧，经内核检查。 |
| 12 | [interop 描述符计费与窗口效应](#interop-descriptor-charge-and-window-effect) | 描述符计费及其窗口效应，即转换泳道向后排除的部分。 |
| 13 | [异常身份与可捕获性](#exception-identity-and-catchability) | 哪个异常到达谁，而不是“某条路径会抛出”这种赤裸断言。 |

## 整 helper 精化清单

这是一份结构性清单与实现计划。它不证明任何 VM、ApplicationEngine、编译器、存储或整方法语义。
当前算术证书仍是区域证书；它无法确立整方法证书。

### 当前工件摘要（2026-11-19）

当前 SmartAccount v4 NEF 为
`2887bad34ab763cc8fb1de789997e3c3b331fc7de6ef42f44b095131529cfefb`，script SHA256 为
`6eef7f70838b1bb3b8bed9a6a515152a6b0d86a102a11ba489d74c422cbf715f`。其
`CapReimbursementToActualCost` helper 是完整区间 `[36048,36329)`：281 字节、116 条指令、52 个
不同操作码名称——与 2026-11-17 工件逐字节相同，只是整体后移了 17,148 字节。initializer 是
`[43470,44187)`：717 字节、236 条指令。该 helper 读取静态槽 58；initializer 在 44026 处用
`PUSHDATA1 21`、在 44029 处用 `CONVERT Buffer`、在 44031 处用 `STSFLD 58` 写入报销键。当前
编译器工件有 81 个 ABI 条目。

只有 36048 处的 `INITSLOT` 没有精确的声明源码点；其余 115 条指令都有显式的 debug 源码点。可选的
现有算术证书主张 22 条指令，因此该方法还有 94 条指令未被该证书归集。这些都是声明覆盖的计数，
不是证明接受。

36059 与 36313 处的两条 `LDSFLD` 使用静态索引 58，名称 `Prefix_TransactionReimbursement`。在本
helper 之外，初始化是 `44026: 0c0121`（PUSHDATA1 包含 `21`）、`44029: db30`（CONVERT 为
Buffer）、`44031: 673a`（STSFLD 58）。（清理前的构建 `6c347dac…` 形状相同，`INITSLOT` 在 13557、
`LDSFLD` 位置在 13568/13822、initializer 指令在 25432/25435/25437、静态索引为 34；2026-11-16
设计阶段遗留清理移动了偏移与槽。）因此，helper 入口状态规范必须把槽 58 绑定到 `Buffer([0x21])`，
并确立初始化已经运行。那三条 initializer 指令不属于这 116 条指令的 helper。

### 历史候选与作用域

下面的详细表格记录更早的 2026-10-13 候选及其 `[13557,13838)` 布局。它作为历史清单泳道的溯源保留；
其偏移与槽 34 不得套用到当前工件上。

公开custom 候选 NEF 的 SHA256 为
`4e5c8ae0c4b9722ae19e099303b6a61786de97cc4844abbc1ad458c3a76ce198`。其经复核的 debug 映射
在闭区间 **13557–13837** 标识 `CapReimbursementToActualCost(BigInteger)`：**281 字节、116 条
指令、52 个不同操作码**。全部 116 条指令列在下面，包括前缀、断言故障路径、预留更新、序列化、
存储写入与返回。debug／源码身份与源码位置是已绑定的导出器证据，不是编译器精化定理。

当前算术证明覆盖 `[13667,13689)`。其完整的未覆盖前缀为 `[13557,13667)`，后缀为 `[13689,13838)`。
对被主张区域的结构性记账必须同时暴露两者。`method_inventory.py` 独立解码原始 script 字节，并
拒绝不完整的 debug 边界、伪造的指令元数据、无效源码点、重叠区间，以及被当作整方法证据提交的
算术证书。其输出始终保留 `implementationVerified=false` 与 `wholeMethodVerified=false`。

CLI 先把清单绑定到实际 NEF、manifest、输入哈希与当前源码成员，并在写出报告前再次检查它们。它
还会记录并检查清单工具、独立解码器与绑定解析器的哈希。其可选的证书记账会检查精确的方法／工件
身份与指令边界，但不认证也不证明该证书。即便所主张的区间覆盖了每一个字节，那仍然是结构性记账。
未来的整 helper 检查器必须提供自己经复核的语义接受路径。

```sh
python3 formal/refinement/method_inventory.py \
  --inventory /path/to/fresh/inventory.json \
  --certificate /path/to/arithmetic/proof.json \
  --json-report /path/to/method-inventory.json
```

### 解释器与对应关系的拆分

1. **VM 控制与数据操作。** 用 `INITSLOT`、静态字段、Null/ByteString/Array/Struct 值、PACK、
   栈重排、字段变更、相等、条件／无条件分支、ABORTMSG 与 RET 扩展现有算术语义。保留实际的 pc、
   槽计数、栈顺序、类型／索引故障、对象别名与帧条件；不要用它的源码公式替换该方法。
2. **显式环境结果。** 为七个 SYSCALL 位置与两个原生 CALLT 位置给出成功／故障关系。把重复的
   script 容器读取绑定到同一笔交易，并把索引 38 处的静态字段绑定到已初始化的报销键。陈述
   已部署合约／上下文与 ReadStates/WriteStates/AllowCall 假设。把缺失存储的建模与反序列化、
   以及交易哈希相同／不同的路径分开建模。
3. **全部 helper 路径。** 针对显式的双字段已存储预算不变量为全部 116 条指令出具证书，或把值模型
   扩展到其他反序列化形状及其类型／索引故障。包含序列化之前的 settled<=0 ABORTMSG 与预留溢出；
   仅凭算术证明不能确立这些路径。观察返回的结算值以及存储在正确合约／键下的序列化预算，且成功
   路径上其他状态不变。
4. **ApplicationEngine 组合。** 把环境关系连接到固定的处理器实现、原生派发、转换、费用收取、
   合约权限、分叉选择、快照归属与回滚。helper-under-environment 定理与这种对应关系不同，也与
   完整的交易／调用方精化不同。不要把任一部分层标记为完整实现验证。

### 固定的普通 ApplicationEngine 边界

目标 Neo 核心：[`d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d`](https://github.com/neo-project/neo/tree/d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d)；Neo VM：[`004cd6070a940405818d9357638277dd44407e2e`](https://github.com/neo-project/neo-vm/tree/004cd6070a940405818d9357638277dd44407e2e)。这些是公开custom 轨道，与原生 SA 分叉不同。下面的源码哈希证明的是本计划所检视的文件，不是其运行时行为的证明。

| 边界 | 固定的实现与义务 |
| --- | --- |
| 运行时容器 | `ApplicationEngine.Runtime.cs:207` 要求一个 IInteroperable 容器。`Transaction.cs:427` 要求一个签名者并返回 `[Hash,Version,Nonce,Sender,SystemFee,NetworkFee,ValidUntilBlock,Script]`；helper 索引 0、4、5 必须匹配这些字段。 |
| 存储上下文／读取 | `ApplicationEngine.Storage.cs:102` 要求一个已部署的当前合约；上下文携带其合约 ID。`Get:153` 读取 `(context.Id,key)`，缺失时返回 null。 |
| 存储写入 | `Put:228` 检查 key<=64 字节、value<=65535 字节与可写上下文；按大小收取存储费用并改变当前快照。在最终值写入之前建模费用失败。 |
| CALLT | `ApplicationEngine.cs:490` 校验 ReadStates\|AllowCall、token 与参数个数；`CallContractInternal:579` 解析 hash／方法／ABI、策略、权限、标志交集与返回形状。两个实际 token 都请求 All 标志；实际生效的标志仍取决于上下文。 |
| StdLib | `Native/StdLib.cs:35,41` 委托给带引擎限制的 BinarySerializer。原生派发还会检查激活／标志、转换参数并收取原生费用（`NativeContract.cs:445`）。两个原生处理器仍属外部对应关系义务。 |
| 编解码保真 | `BinarySerializer.cs:56,80,198` 除原始值外还处理 Array、Struct 与 Map。反序列化不要求读取器到达其输入末尾；严格的规范／无尾随字节模型会比该处理器更强。序列化拒绝不支持的值、重复的复合引用以及超出大小／条目上限的情况。 |
| 费用与失败 | `ApplicationEngine.cs:991,1005` 校验系统调用标志、收取系统调用／操作码费用并转换值。`ContextUnloaded:661` 只在没有未捕获异常时提交跨合约快照。应用交易回滚与调用方可见的失败仍需要外层组合，即便本 helper 没有 TRY/CALLA。 |

| 固定的核心文件 | SHA256 |
| --- | --- |
| `src/Neo/SmartContract/ApplicationEngine.cs` | `97b08bfe754bc51ed8418316b45d3805dccff76ef51fbd43ac9b663eacb4d5eb` |
| `src/Neo/SmartContract/ApplicationEngine.Runtime.cs` | `b0f4fa6316d796e0b0aa1406a696395669311d5382600f3f83bad966c6d429e9` |
| `src/Neo/SmartContract/ApplicationEngine.Storage.cs` | `adeb3ce69a7d04a3015de35884c0f0c6203ef2dfbfbe8056395f074d69e04083` |
| `src/Neo/SmartContract/ApplicationEngine.Contract.cs` | `8958efff155cb407fef140dea11a516b9f08ab10feecf1b3c39d986d79801a96` |
| `src/Neo/SmartContract/ApplicationEngine.Helper.cs` | `70b3b6bf41cad318e8346c71a3f7b70d1054e44cb029f499ff9feab86d2dded9` |
| `src/Neo/SmartContract/Native/StdLib.cs` | `510dbd32f7896e99b0953096b6bc1df64fabfbee952ff4dc9f186789f084be05` |
| `src/Neo/SmartContract/BinarySerializer.cs` | `d74462dce89437070ca67deca40ba40de1e3a335f8a63726e5420ffb846ff150` |
| `src/Neo/Network/P2P/Payloads/Transaction.cs` | `4b527ca5e6a47b3852cbbd44aec256025011aad14b3e0154b01aa4e5b1acc41d` |
| `src/Neo/SmartContract/ExecutionContextState.cs` | `d08d47dc43f00070b5a2248556efa8afc7ff5f24db2d96d9a8712101eaa925d8` |
| `src/Neo/SmartContract/StorageContext.cs` | `29dea6ee1be9e95b61420d351929643aa9e63ae112af9acfcb12bbd59ff4d164` |
| `src/Neo/SmartContract/Native/NativeContract.cs` | `3ceb1bd9c78e0683b81b2833e0c544a7a3b77778fb44676ec4cc9f76d863fcbf` |

### 完整指令与源码点清单

偏移是绝对 script 位置；方法结束为开区间 13838。`d17` 是 `SmartAccount.Paymaster.cs`；d5/d6/d7/d15
是固定的框架文件 `Services/Runtime.cs`、`Services/Storage.cs`、`Native/StdLib.cs` 与 `UInt256.cs`。
只显示精确声明的源码点；`—` 表示未映射，不伪造最近行关联。相对目标由原始解码器独立检查。本方法
中没有内部 CALL/CALL_L、间接 CALLA 或显式 TRY 处理器。CALLT/SYSCALL 的顺序落入是声明的继续执行，
并不保证处理器成功返回。

| pc | 完整指令字节 | 操作码 | 非顺序落入的边／环境效应 | 精确源码点 |
| ---: | --- | --- | --- | --- |
| 13557 | `570801` | INITSLOT | — | — |
| 13560 | `412d510830` | SYSCALL | System.Runtime.GetScriptContainer | d5:51:14–51:58 |
| 13565 | `10` | PUSH0 | — | d17:55:39–55:63 |
| 13566 | `ce` | PICKITEM | — | d17:55:39–55:63 |
| 13567 | `70` | STLOC0 | — | d17:55:21–55:63 |
| 13568 | `5f22` | LDSFLD | — | d17:56:68–56:99 |
| 13570 | `419bf667ce` | SYSCALL | System.Storage.GetContext | d6:27:14–27:50 |
| 13575 | `41925de831` | SYSCALL | System.Storage.Get | d6:51:10–51:39 |
| 13580 | `71` | STLOC1 | — | d17:56:25–56:100 |
| 13581 | `69` | LDLOC1 | — | d17:57:47–57:51 |
| 13582 | `0b` | PUSHNULL | — | d17:57:55–57:59 |
| 13583 | `97` | EQUAL | — | d17:57:47–57:59 |
| 13584 | `2629` | JMPIFNOT | branch→13625 | d17:57:47–59:69 |
| 13586 | `10` | PUSH0 | — | d17:28:42–28:43 |
| 13587 | `0c200000000000000000000000000000000000000000000000000000000000000000` | PUSHDATA1 | — | d15:20:46–20:140 |
| 13621 | `12` | PUSH2 | — | d17:58:19–58:49 |
| 13622 | `c0` | PACK | — | d17:58:19–58:49 |
| 13623 | `2206` | JMP | branch→13629 | d17:57:47–59:69 |
| 13625 | `69` | LDLOC1 | — | d17:59:64–59:68 |
| 13626 | `370400` | CALLT | CALLT 4 StdLib.deserialize | d7:19:6–19:60 |
| 13629 | `72` | STLOC2 | — | d17:57:38–59:69 |
| 13630 | `6a` | LDLOC2 | — | d17:60:17–60:23 |
| 13631 | `10` | PUSH0 | — | d17:60:17–60:39 |
| 13632 | `ce` | PICKITEM | — | d17:60:17–60:39 |
| 13633 | `68` | LDLOC0 | — | d17:60:43–60:58 |
| 13634 | `98` | NOTEQUAL | — | d17:60:17–60:58 |
| 13635 | `2610` | JMPIFNOT | branch→13651 | d17:60:13–64:14 |
| 13637 | `68` | LDLOC0 | — | d17:62:42–62:57 |
| 13638 | `4a` | DUP | — | d17:62:17–62:57 |
| 13639 | `6a` | LDLOC2 | — | d17:62:17–62:23 |
| 13640 | `10` | PUSH0 | — | d17:62:17–62:57 |
| 13641 | `51` | ROT | — | d17:62:17–62:57 |
| 13642 | `d0` | SETITEM | — | d17:62:17–62:57 |
| 13643 | `45` | DROP | — | d17:62:17–62:57 |
| 13644 | `10` | PUSH0 | — | d17:63:35–63:36 |
| 13645 | `4a` | DUP | — | d17:63:17–63:36 |
| 13646 | `6a` | LDLOC2 | — | d17:63:17–63:23 |
| 13647 | `11` | PUSH1 | — | d17:63:17–63:36 |
| 13648 | `51` | ROT | — | d17:63:17–63:36 |
| 13649 | `d0` | SETITEM | — | d17:63:17–63:36 |
| 13650 | `45` | DROP | — | d17:63:17–63:36 |
| 13651 | `412d510830` | SYSCALL | System.Runtime.GetScriptContainer | d5:51:14–51:58 |
| 13656 | `14` | PUSH4 | — | d17:65:49–65:78 |
| 13657 | `ce` | PICKITEM | — | d17:65:49–65:78 |
| 13658 | `412d510830` | SYSCALL | System.Runtime.GetScriptContainer | d5:51:14–51:58 |
| 13663 | `15` | PUSH5 | — | d17:65:93–65:123 |
| 13664 | `ce` | PICKITEM | — | d17:65:93–65:123 |
| 13665 | `9e` | ADD | — | d17:65:37–65:123 |
| 13666 | `73` | STLOC3 | — | d17:65:24–65:123 |
| 13667 | `11` | PUSH1 | — | d17:66:41–66:42 |
| 13668 | `11` | PUSH1 | — | d17:66:72–66:73 |
| 13669 | `6b` | LDLOC3 | — | d17:66:60–66:70 |
| 13670 | `b9` | MIN | — | d17:66:45–66:74 |
| 13671 | `9f` | SUB | — | d17:66:41–66:74 |
| 13672 | `74` | STLOC4 | — | d17:66:24–66:74 |
| 13673 | `10` | PUSH0 | — | d17:67:75–67:76 |
| 13674 | `6b` | LDLOC3 | — | d17:67:45–67:55 |
| 13675 | `6a` | LDLOC2 | — | d17:67:58–67:64 |
| 13676 | `11` | PUSH1 | — | d17:67:58–67:73 |
| 13677 | `ce` | PICKITEM | — | d17:67:58–67:73 |
| 13678 | `9f` | SUB | — | d17:67:45–67:73 |
| 13679 | `ba` | MAX | — | d17:67:30–67:77 |
| 13680 | `6c` | LDLOC4 | — | d17:67:80–67:94 |
| 13681 | `78` | LDARG0 | — | d17:67:97–67:106 |
| 13682 | `a0` | MUL | — | d17:67:80–67:106 |
| 13683 | `9e` | ADD | — | d17:67:30–67:106 |
| 13684 | `75` | STLOC5 | — | d17:67:24–67:106 |
| 13685 | `6d` | LDLOC5 | — | d17:68:60–68:63 |
| 13686 | `78` | LDARG0 | — | d17:68:49–68:58 |
| 13687 | `b9` | MIN | — | d17:68:34–68:64 |
| 13688 | `76` | STLOC6 | — | d17:68:24–68:64 |
| 13689 | `6e` | LDLOC6 | — | d17:69:36–69:43 |
| 13690 | `10` | PUSH0 | — | d17:69:46–69:47 |
| 13691 | `b7` | GT | — | d17:69:36–69:47 |
| 13692 | `242a` | JMPIF | branch→13734 | d17:69:13–69:89 |
| 13694 | `0c255265696d62757273656d656e7420657863656564732061637475616c2067617320636f7374` | PUSHDATA1 | — | d17:69:49–69:88 |
| 13733 | `e0` | ABORTMSG | — | d17:69:13–69:89 |
| 13734 | `11` | PUSH1 | — | d17:81:34–81:48 |
| 13735 | `01fe00` | PUSHINT16 | — | d17:81:52–81:55 |
| 13738 | `a8` | SHL | — | d17:81:34–81:55 |
| 13739 | `11` | PUSH1 | — | d17:81:59–81:60 |
| 13740 | `9f` | SUB | — | d17:81:33–81:60 |
| 13741 | `11` | PUSH1 | — | d17:81:65–81:79 |
| 13742 | `01fe00` | PUSHINT16 | — | d17:81:83–81:86 |
| 13745 | `a8` | SHL | — | d17:81:65–81:86 |
| 13746 | `9e` | ADD | — | d17:81:32–81:87 |
| 13747 | `7707` | STLOC | — | d17:81:24–81:87 |
| 13749 | `6a` | LDLOC2 | — | d17:82:36–82:42 |
| 13750 | `11` | PUSH1 | — | d17:82:36–82:51 |
| 13751 | `ce` | PICKITEM | — | d17:82:36–82:51 |
| 13752 | `6f07` | LDLOC | — | d17:82:55–82:60 |
| 13754 | `6e` | LDLOC6 | — | d17:82:63–82:70 |
| 13755 | `9f` | SUB | — | d17:82:55–82:70 |
| 13756 | `b6` | LE | — | d17:82:36–82:70 |
| 13757 | `2432` | JMPIF | branch→13807 | d17:82:13–83:65 |
| 13759 | `0c2d5265696d62757273656d656e7420627564676574206578636565647320564d20696e7465676572206c696d6974` | PUSHDATA1 | — | d17:83:17–83:64 |
| 13806 | `e0` | ABORTMSG | — | d17:82:13–83:65 |
| 13807 | `6a` | LDLOC2 | — | d17:84:13–84:19 |
| 13808 | `4a` | DUP | — | d17:84:13–84:39 |
| 13809 | `11` | PUSH1 | — | d17:84:13–84:39 |
| 13810 | `ce` | PICKITEM | — | d17:84:13–84:39 |
| 13811 | `6e` | LDLOC6 | — | d17:84:32–84:39 |
| 13812 | `9e` | ADD | — | d17:84:13–84:39 |
| 13813 | `4e` | TUCK | — | d17:84:13–84:39 |
| 13814 | `11` | PUSH1 | — | d17:84:13–84:39 |
| 13815 | `50` | SWAP | — | d17:84:13–84:39 |
| 13816 | `d0` | SETITEM | — | d17:84:13–84:39 |
| 13817 | `45` | DROP | — | d17:84:13–84:39 |
| 13818 | `6a` | LDLOC2 | — | d17:85:99–85:105 |
| 13819 | `370300` | CALLT | CALLT 3 StdLib.serialize | d7:19:6–19:60 |
| 13822 | `5f22` | LDSFLD | — | d17:85:49–85:80 |
| 13824 | `419bf667ce` | SYSCALL | System.Storage.GetContext | d6:27:14–27:50 |
| 13829 | `41e63f1884` | SYSCALL | System.Storage.Put | d6:91:10–91:39 |
| 13834 | `6e` | LDLOC6 | — | d17:86:20–86:27 |
| 13835 | `2202` | JMP | branch→13837 | d17:86:13–86:28 |
| 13837 | `40` | RET | — | d17:87:9–87:10 |

## 完整 helper 源码投影

报销 helper 证书需要完整源码方法体、构造函数初始化器与存储键初始化器。只挑出三个算术表达式无法
归集被改变的守卫、重置、赋值、序列化或返回。`formal/refinement/method_source.py` 把完整的类型化
Roslyn 树翻译成 `CapMethodVm.v` 中独立的语句／表达式语言。

该投影只支持此处所需的、具体且显式检查过的 Neo 框架内建。它保留语句与参数的求值顺序、全部字段
写入、条件、断言与返回值。它把条件式预算初始化器降为一个 if，每个分支各有一条局部赋值。复合
字段加法读取该字段，并发出一次加法后跟一次字段写入。BigInteger 表达式保留无界的源码算术；目标
整数边界另行对证书的准入域证明。

该源码语言是声明的 Neo 框架合约解释，而不是任意的 CLR 对象执行。ByteString/UInt256 值表示不可变
字节值；记录字段具有其导出布局；框架的存储、交易与编解码调用具有显式效应契约。引用类型转换要求
声明的良构记录关系。这些前端／框架对应关系仍属具名义务，而不是 Coq 源码解释器的结果。无效的
编解码对象、真实的 initializer 执行、资源以及真实的 ApplicationEngine 都不由源码投影提供。

每个节点的类型、已解析成员／运算符、转换标志、语义元数据与有序子节点都会被检查。导出的集合
元数据把字段初始化器绑定到符号，并让被忽略的维度／参数、局部列表与参数位置可被检视。未知构造与
无法解释的元数据都是错误。新增一个受支持的语句会改变投影出的程序；它永远不会被静默省略。新的
投影器不替代此前的算术证书或其历史证据。

公开的 Python API 是 `project_method(inventory)`，返回可 JSON 序列化的源码程序、局部／类型绑定、
记录布局与字面存储键。`render_program(projection)` 渲染对应的 Coq `list Stmt`。输入清单哈希由外层
全新门禁检查；投影器不会把调用方提供的 JSON 树变成对 C# 解析器的独立证明。

投影在 helper 树与 initializer 清单上是线性的。不支持的输入会在生成任何证书之前抛出
`SourceProjectionError`。回归套件会突变类型、被调用者、源码常量、写入顺序、守卫、构造函数／键
绑定与隐藏的集合元数据。不需要改动任何生产合约、存储模式或部署。

框架交易类型通过固定的框架引用提供，而不是导出为仓库记录声明。其 `Hash`、`SystemFee` 与
`NetworkFee` 字段是位于 0、4、5 位置的具名方言内建。每次使用都必须携带精确解析的字段 ID 与声明
类型。投影把该外部契约与不可变字节比较、32 字节零哈希、Array/Struct 记录关系、原生编解码效应以及
Buffer 值的存储键一起记录。这些契约参与投影摘要。用户定义的报销记录单独处理：其精确字段顺序／
类型、合成的构造函数与两个符号绑定的字段初始化器都从导出的源码检查。

键的初始化器被当作带显式一维大小与有序字节元素的类型化数组分配来遍历。维度与元素集合必须完整；
手工补全的固定样例不会被接受为真实导出。`InitializedFields` 集合标识每个初始化器的字段，与它的
行号或相邻文本无关。

`fixtures/cap-method-source.json` 包含一次真实导出的未修改子集。其记录的清单摘要标识源码树的来源；
固定样例测试本身不认证实时的 C# 输入。外层全新门禁认证那些输入。语义对照会改动受支持的源码算术、
守卫、返回变量、构造函数常量与语句顺序，并要求生成的 Coq 程序随之改变。结构性对照拒绝
缺失／多余的子节点、未解析的元数据、误导性集合、错误类型、被调用者、转换标志、字段布局与构造函数
绑定。投影器在选择语义之前从不把其源码程序与 NEF 比较。

被检查的固定样例取自清单 SHA-256
`65a73399659594d72b8ae063f14fc64ed18120719111165b69f03785f81d7195`。它的 14 条顶层语句与
八个类型化局部变量产生源码投影
`11f8b6974dd5278de323078483fd2d0312a4c6d028465831e83e0cfd96c2af31`。专门的源码投影套件
有 15 个通过测试，包括最初缺少模块的红色运行，以及随后被拒绝的不完整数组元数据与畸形语义容器
对照。该结果确立了受检查的前端投影与突变敏感性；Coq 证书仍必须消费渲染出的源码程序，并证明它
与独立解码字节的关系。

## 完整报销 helper 参考精化

证书覆盖 `CapReimbursementToActualCost` 在 `[36048,36329)` 的全部 **281 字节／116 条指令／52 个
操作码名称**。它把从类型化源码清单独立投影出的完整 14 语句源码程序，与一个解码真实 NEF 字节的
可执行参考 VM 相比较。没有任何预期结算值被传给原生调用预言机，也没有任何值被用来替代一条字节码
指令。

全称结果包括存储加载分支、新记录构造、两条交易哈希分支、费用算术、防止累加离开有符号范围的头寸
守卫、拒绝、别名预留变更、序列化、存储写入与返回。独立的分类引理确立预期返回或拒绝、存储快照与
效应轨迹。最终定理在其合法输入域上同时排除意外故障与燃料耗尽；两次失败执行相等无法确立这一点。

### 量化域与结果

输入包括一个合法的 32 字节交易哈希、两个非负的有符号 64 位费用、一个正的有符号 256 位请求，以及
要么没有已存储账本、要么是良构的双字段 Array/Struct 账本。其字段是一个合法的 32 字节哈希与一个
非负的有符号 256 位预留。方法入口帧提供一个参数，以及一个静态环境，其中槽 38 等于
`Buffer[0x21]`。LDSFLD 在该环境中执行查找。

设 `r` 为哈希匹配时的已存储预留（否则为零），`c` 为两项费用之和，`q` 为请求。独立的观察契约在
零费用估算时结算 `q`，否则结算 `min(q, max(c-r, 0))`。正结算存储当前哈希与 `r + settled`；非正
结算在序列化或写入之前中止。满足 `r >= c` 的已付费账本被包含在内并全部拒绝。该域不施加 `r <= c`。

零费用估算还要求 `r + q < 2^255`。helper 在累加之前就域最大值断言该头寸，因此一个另行经内核检查
的真实字节例子显示：工件以余量消息拒绝，而不是在溢出的加法上故障；投影源码也在同一断言上拒绝。
源码 BigInteger 算术保持无界：该守卫是 helper 所检查的前置条件，而不是对源码算术语义的改变。

### 源码与环境契约

该源码语言是 **Neo 框架合约方言**，不是任意 CLR 执行。ByteString/UInt256 相等表示不可变字节值
相等；源码的对象转换不确立 CLR 引用身份等价。记录类型转换、框架交易投影、零 UInt256、存储前缀与
编解码都是显式的方言／内建契约。源码投影器检查每一条语句与每个导出语义集合，并且在构造源码程序
时不查阅目标 NEF。Roslyn／导出器与源码投影的正确性仍留在可信计算基中。

数组与结构体拥有堆身份。DUP、加载与字段写入保留别名。Serialize 读取当前堆对象；Deserialize 从
其输入快照分配。两个记录字段都是标量值，因此该模型不给出嵌套 Struct 的克隆定理。结构化线格式值
代表一种编解码关系；它们不是 Neo 二进制序列化器、反序列化器或编组（marshalling）的证明。持久化的
类型化账本不变量必须由调用方与存储生产者确立。其他形状（包括 Map）在该定理之外；该定理不主张
所有这类真实引擎输入都会故障。

被观察的效应序列包括 Storage.Get、可选的 Deserialize、对结果快照的 Serialize，以及对该快照的
Storage.Put。三次 GetScriptContainer 调用与两次 GetContext 调用被建模为纯、稳定、不故障的 getter。
它们的诊断调用次数在 Python 中测试，但在被证明的轨迹中被投影掉。这允许编译器围绕序列化重排一次
纯上下文读取。gas、调用权限、存储上限、资源失败、回调与交易回滚都是外部义务。该 helper 定理不
证明 `_initialize` 建立了静态槽 38。

### 验证与负向对照

用以下命令运行可移植的固定样例与执行测试：

```sh
python3 -m unittest discover -s formal/refinement -p test_method_proofs.py -v
```

固定样例测试从归档的 script／token 数据与取自该候选的 68 字节头部恢复精确的原始 NEF，然后要求其
原始完整 SHA-256。它不使用任何先前的检出、SDK／包缓存或构建输出。独立的仅源码固定样例提供更新的
语义集合。此装配仅用于测试；它不编译替代合约。生产证书需要一份完整的新导出器清单，并重新检查每个
当前输入文件：

```sh
python3 formal/refinement/method_proofs.py \
  --inventory /path/to/fresh-inventory.json \
  --output-dir /tmp/aa-cap-method-proof \
  --json-report /tmp/aa-cap-method-proof.json \
  --controls
```

接受流程用 `coqc` 编译、用 `coqchk` 检查，并为每个具名模型／证书声明打印假设，要求精确的闭合
计数。回执绑定 NEF、完整 script、完整方法、源码树／投影、证明证书、模型与 Python 工具。输入与
工具在对照之后再次检查。独立 CLI 在任何工作开始前用失败回执覆盖旧的成功回执，并在任何错误上保留
失败。

六个语义对照先编译有效的突变定义，然后要求内核证书拒绝：MIN 改成 MAX、断言分支反转、预留写入后
留下重复值、源码返回改为零、初始源码预留改为一，以及删除源码断言。语法错误、缺失工具与超时不算
语义拒绝。执行测试还覆盖全部 116 个真实指令偏移在整个用例集合中的每一个。

回执使用 `scope: complete-helper-reference-refinement` 与 `fullImplementationVerified: false`。
这是在所述契约下的完整私有 helper 参考证明。它不证明真实 ApplicationEngine、原生二进制编解码、
gas 记账、编译器正确性、调用方组合，也不证明 **109 个公开 ABI 入口点**中的任何一个，它们都在本
证书之外。

## 完整报销 helper 运行时检查

这些测试在经复核的custom NEF 中执行原始私有 `CapReimbursementToActualCost` 方法，从 PC 36048 直到
PC 36328 的 RET。它们把 22 条指令的算术检查扩展到交易字段、初始存储、默认记录构造、交易哈希重置、
真实原生反序列化／序列化、断言、堆更新与 Storage.Put。它们是具体的运行时对应证据，不是全称翻译
证书，也不是公开部署批准。

### 入口与工件身份

测试部署未改动的候选 NEF／manifest，并使用公开固定的 `ApplicationEngine.LoadContract` API，配一个
仅测试用的方法描述符，指向原始私有方法 PC。该 API 执行原始 `_initialize`，它必须把静态槽 58 建立
为存储键字节 `0x21`。该描述符不会被加入 manifest。原始字节码、token 与原生调用都被执行；没有源码
替代物、复制来的算术 script 或替代原生编解码器。这个私有方法接缝不证明两个公开入口点守卫及其完整
调用方路径。

NEF SHA256：`2887bad34ab763cc8fb1de789997e3c3b331fc7de6ef42f44b095131529cfefb`。
Manifest SHA256：`f44cddebab7ecc5e35a66b5cb28fb0dbe1f2c224bc139e95ce41d6606431476f`。
Script SHA256：`6eef7f70838b1bb3b8bed9a6a515152a6b0d86a102a11ba489d74c422cbf715f`。
本文件中的每个偏移都位于 `[36048,36329)` 内，即该 helper 当前 281 字节、116 条指令的区间。当前
构建包含 VM 整数余量守卫与扩展后的 helper 帧；更早的 208 字节／96 条指令候选是历史记录，不是本文
档所固定的工件。更早的修订固定过 NEF
`083ed325f9bdaa6b223662042f32d29f398ba055f507bbdde46daf8113c47f2a` / manifest
`e79fa04969ef3f0bdd6b9df6afe41acdd19767968575ea38c1cd011ee97e5156`（改名之前），以及 NEF
`6c347dac40bd562edda3216e40c7007fad3a2bb24020013e730c58bd4ceed1c3` / manifest
`8b6bd9623ab4ed293ad9b6fda27402aaf3100d0b2a9d5c44658edb7e83fb0c29`（2026-10-30 的构建，
被 2026-11-16 遗留兼容性清理取代）；两者都不是本文档所固定的工件。运行时包仍是
Neo/Neo.VM/Neo.SmartContract.Testing 3.10.1，由现有项目锁定。相关源码提交为 Neo
`d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d`、VM
`004cd6070a940405818d9357638277dd44407e2e`，以及 testing
`37c03d3e7db8d125efb968a1f1da455f3d205b26`。

### 用例与独立预言机

对良构的账本状态，预言机就是协议规则：仅当交易相同时保留预留，否则重置为零；对正费用结算
`min(requested, max(cost-reserved,0))`；对零费用估算结算请求值；非正结算中止。运行时必须序列化
更新后的哈希与预留，并返回结算金额。该预言机不是对方法无分支操作码序列的翻译。

用例覆盖存储缺失、相同／新交易、正费用、费用耗尽、零费用估算、有符号边界与预留溢出。一笔真实
解析的交易允许非负费用，其总和至多为 `long.MaxValue`；helper 运行时检查不证明发送方资金、见证、
共识接受、GAS 燃烧或真实区块持久化。测试宿主独立分配执行 GAS，以便零费用 RPC 风格的容器也能执行
该方法。

请求的 Integer、Boolean、ByteString、Buffer 与 Null 输入都对照真实引擎测试。ABI 的 Integer 元数据
不强制该标签。ByteString 与 Boolean 的数值强制转换在为正时被接受；Buffer／Null 的 GetInteger 故障
不得被静默归类为等价字节／零。

注入的 Array/Struct/Map 记录、多余／缺失字段、无效字节、错误标签与负预留会探测真实的反序列化与堆
行为。除被标识为正常记录者外，这类状态明确在预期可达账本不变量之外。被接受的修复或反例本身不会
确立一个可达的生产缺陷。

### 持久化与失败边界

包装器创建真实的固定 ApplicationEngine，使用其自己克隆的交易快照，并仅在 HALT 时提交，与固定的
原生区块应用持久化策略一致。它不为该方法调用使用 TestingApplicationEngine：TestEngine.Fee 别名到
Transaction.NetworkFee，否则会在分配宿主 GAS 的同时改变费用／哈希输入。成功的 helper 可能先把其
子快照提交到待定父缓存中。随后的一次父级 ABORTMSG 仍会阻止该缓存到达原始已提交快照。测试区分
待定写入、子调用效应与外层快照持久化；它们不会把三者都称为同一种回滚。原生区块路径同样只提交
成功的应用快照，但 OnPersist 燃烧的交易费用在应用回滚之外。

畸形数据、非正结算、算术溢出、只读调用标志与不足的执行 GAS 必须故障且不提交新预算。估算用例还
需要一个可表示的合计预留；头寸分支比较 `reserved <= (2^255-1) - settled`，并在违反时以自己的
ABORTMSG 在 19149 拒绝，因此 `reserved+settled >= 2^255` 是合约拒绝，而不是从 19155 的 ADD 逃逸
出来的 CLR 整数大小异常。这 73 字节的守卫之所以存在，正是因为累加器的 ADD 否则会在认证算术区域
之外溢出。此处不主张任何通用的零估算完成保证。

### 接受与维护

先写用例，再写测试执行 helper，并保留首次失败的运行。然后用精确工件运行新的方法套件，并把日志
保存在仓库之外。本工作不包含任何生产源码／工件更新、对现有七项测试的编辑、主网／测试网调用或
部署。形式化证书必须另行确立源码域守卫、编解码／堆假设、静态初始化、宿主效应、gas 与存储精化，
之后才能主张整方法验证。

### 观察到的本地证据

新的专门套件 38/38 通过，无跳过用例。最初的方法运行器运行是 31/31 失败；后来两个原始 CONVERT 用例
也在其运行器存在之前被记录为失败。原有的七项算术运行时测试未被本泳道编辑或重跑。

十二个请求标签用例包括补齐的正值 `[7,0]`、补齐的负值 `[ff,ff]`、有符号 32 字节最小／最大值，以及
33 字节的零／负编码。正的 ByteString 与 Boolean 值执行；false／负值／Null／Buffer 或超长数值输入
按实际指令所述故障。单独的原始检查区分显式 `CONVERT(Integer)`：Buffer 可以转换为 Integer，而
Null 仍为 Null；两者都不会让原始 helper 隐式执行那次转换。

成功调用断言真实已初始化的静态槽 38 是一个包含 `21` 的 Buffer。存储探测保留 Array/Struct/Map 标签、
在 ADD 之后把被强制转换的标量预留字段归一化为 Integer、保留多余字段，并演示一个缺少预留键的哈希
不匹配 Map 可以通过 SETITEM 修复。注入的负预留可以产生高于已付费用的支付报价：这显示了可达账本
不变量的重要性，而不是一个被证明可达的生产漏洞。规范产出的记录仍是带 32 字节哈希与非负 Integer
预留的双字段 Array。

在 helper 成功返回之后，随后的一次父级 ABORTMSG 会让新预算在待定父缓存中可见，但原始已提交测试
存储仍保留旧字节。零费用成功用例只提交到这个隔离的测试存储以供回读；真实 RPC 估算通常会丢弃其
执行快照。宿主 Block 携带固定样例的索引／时间／nonce，而不校验链头；签名、发送方费用余额与
OnPersist 都不执行。

日志与 TRX 回执位于仓库之外的宿主临时目录，并记录那条精确的专门命令。这些有限观察不能替代任何
未闭合的内核证明、环境假设或完整公开入口点证书。

## 预留算术精化

### 当前算术结果

`formal/refinement/coq/ReservationArithmetic.v` 包含 24 个闭合声明。专门的宿主运行器把它与来自
`IntegerSemantics`、`CapArithmetic` 以及真实的现有 `CustomSponsorship` 的 29 个被导入声明一起
编译，审计每个 `Print Assumptions`，并用 `coqchk` 重新检查全部四个已编译模块。两个运行器测试与
六个定义有效、证明被拒的语义对照通过。这些是算术／协议结果；`suffixBytecodeVerified`、
`fullHelperVerified` 与 `fullImplementationVerified` 保持 false。

公开的组合接口为 `checked_update_success_iff`、`checked_update_nonpositive_fault`、
`checked_update_overflow_fault`、`paid_reservation_success_iff_remaining`、
`paid_reservation_result_bound`、`estimation_success_iff_representable`、
`estimation_overflow_fault`、`bounded_reserve_refines_protocol_when_sum_fits` 与
`same_transaction_iteration_preserves_fee_bound`。其中
`estimation_overflow_protocol_disagrees` 定理明确阻止把可表示成功的结果扩展成一个未证明的
源码／目标故障主张。

### 预期陈述

用预留的正费用守卫、其 VM 整数余量守卫与有符号 256 位加法扩展现有费用区域证明。经复核的当前custom
NEF 在 `[17860,17882)` 包含费用区域，在 `[17882,18011)` 包含随后的守卫／更新后缀。该后缀把
local6 与零比较，成功时从 17885 分支到 17927，否则在 17926 执行 `ABORTMSG`。成功路径从 17927 起
把 `vmMax = 2^254 - 1 + 2^254` 物化到 local7，然后在 17950 附近的头寸分支把预算 field1 与
`vmMax - local6` 比较，并在剩余头寸会被超出时于 17999 中止。越过守卫后它读取预算 field1，在 18005
加上 local6，并在 18009 用 `SETITEM`、随后在 18010 用 `DROP` 更新那个共享记录。端点把该记录加载到
求值栈上，位置为 18011；从 18012 开始的序列化与存储随后进行，不属于本后缀。

头寸守卫是关于**剩余**预算的源码级断言，不是受检查加法。它在 `budget[1] > vmMax - local6` 时以
`Reimbursement budget exceeds VM integer limit` 中止，因此对已准入输入，18005 处的 `ADD` 不可能
离开 VM 有符号范围；下面的算术层仍然建模守卫缺失的情形，这就是估算溢出容差被收窄而不是被删除的
原因。

第一层定理将在 Integer 类型值上执行守卫与受检查加法。其结果区分成功的新预留额度、零费用拒绝与
有符号整数溢出。它将导入现有的 `CustomSponsorship.charge`、`reserve` 与 `reserve_many`，而不是
重新定义它们的协议含义。

对一笔正费用的已付费交易，假定 `0 < cost < 2^255`、`0 < requested < 2^255` 且
`0 <= reserved <= cost`。成功恰好发生在 `reserved < cost` 时；更新后的预留至多为交易费用并保持
可表示。费用耗尽会拒绝，且不产生已准入的成功状态。迭代同一交易上的成功预留保持该上限。

对零费用 RPC 估算，假定可表示的非负 reserved 与可表示的正请求。报价等于请求。预留恰好当
`reserved + requested < 2^255` 时成功；否则未受检查的加法会故障。特别地，
`reserved = 2^255-1` 与 `requested = 1` 在旧费用区域中成功，而现在会被 17999 处的头寸守卫拒绝，
早于 18005 的 `ADD` 执行。算术层把无守卫的受检查加法结果保留为该守卫所排除的情形；它不主张目标
在那里故障。

这是目标的 Integer 行为。CLR `BigInteger` 加法与被导入的抽象 `reserve` 是无界的；它们允许那个
数学和。一个独立的反例定理记录了这种分歧。此处没有定理把 CLR 加法变成受检查算术，也没有主张在
后续序列化中源码／目标的故障轨迹相同。成功域的组合需要一个可表示的和，以及一套独立的源码／原生
效应语义，才能得到完整 C# 结果。

### 条件式整 helper 计划

整 helper 定理需要针对真实字节与状态效应的独立证书。该后缀需要字节寻址的控制流、真实分支操作数、
栈重排、可变 Array/Struct 身份与别名、`PICKITEM` 与 `SETITEM`。值拷贝记录语义不够：local2 中持有的
记录必须观察到通过其栈引用执行的写入。

该方法更早的指令必须确立类型化账本记录、交易哈希比较／重置、非负外层费用与区域入口不变量。它更
晚的指令必须精化序列化、存储上下文、单一 prefix0x21 写入、返回值与可观察交易故障。成功的封装交易
必须在外部回调之前使预留额度可见；交易回滚与 GAS 需要匹配的宿主语义。这些义务没有一项能从源码哈希
或样本执行推出。

因此计划的组合是：真实费用证书、真实守卫／更新证书、账本／源码投影，然后是整 helper 效应与调用方
确立。只有在其精确的内核检查证书存在之后，一层才可被报告为闭合。仅凭全称算术引理不能认证该后缀
的字节、存储效应、完整 helper 或全部公开入口点。

### 验证与对照

专门的 Coq 与 Python 证明文件将不触碰旧费用门禁。测试以一次被捕获的失败运行开始。Coq 编译、闭合
假设审计与 `coqchk` 必须真实，并在工具缺失时失败。定义有效的语义对照将改动正性守卫、预留加法、
溢出拒绝、交易账本作用域与迭代。证明输入、依赖与生成的证书从被编译的精确字节哈希，并在验证之后
再次检查。

## 数值强制转换精化

本工作把参考模型扩展到仅 Integer 标签算术输入之外。它面向 NeoVM 3.10.1，源码提交
`004cd6070a940405818d9357638277dd44407e2e`。它不修改生产合约、编译器或现有算术证书。对新
模型的内核检查并不确立运行时实现了它；这种对应关系在独立确立之前仍是显式义务。

算术操作码调用 `StackItem.GetInteger()`。固定的实现接受 Integer 值、作为零或一的 Boolean 值，以及
至多 32 字节、按有符号小端二补码解释的 ByteString 载荷。空载荷表示零。在有符号范围之内，冗余的
正或负符号字节被接受；规范编码不是准入规则。见
[ByteString.GetInteger](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/ByteString.cs)
与 [Integer 构造](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/Integer.cs)。

Buffer 没有 GetInteger 重写，因此算术会拒绝它，尽管其单独的 `ConvertTo(Integer)` 实现接受至多
32 字节的载荷。Null 同样拒绝 GetInteger，但 `ConvertTo(Integer)` 返回原始的 Null，而不是数值零。
其他不支持的类型标签会拒绝 GetInteger。这些彼此分离的路径在模型中必须保持分离。见
[Buffer](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/Buffer.cs)、
[Null](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/Null.cs)
与[基类强制转换](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/StackItem.cs)。

`NumericCoercions.v` 在字节列表上定义一个可执行解码器，并定义一个独立的数值类型。它与类型化源码
BigInteger 的关系是“等于解码后的整数”，而不是 VM 标签的相等。物理字节限制在 0..255。成功的数值
保持在 `[-2^255, 2^255)`；超长载荷、不支持的标签与不可表示的 Integer 构造都会拒绝。证明覆盖解码
算法、范围、符号扩展与取值关系。它们不证明 ABI 参数准入、gas、堆身份、序列化、交易费用或 .NET
BigInteger 的实现。

用以下命令运行独立门禁：

```sh
python3 -m unittest formal/refinement/test_numeric_proofs.py
python3 formal/refinement/numeric_proofs.py --output-dir /tmp/aa-numeric-proof \
  --json-report /tmp/aa-numeric-proof.json
```

该门禁调用 `coqc` 与 `coqchk`，并要求每个被报告的声明都没有假设。语义负向对照在保持合法 Coq 语法
的前提下改变定义；每个对照都必须在其仅定义版本编译之后使某个定理失败。在此模型被显式组合进它们
之前，所有既有的精化门禁保持其原始作用域。

`numeric_proofs.py` 校验 13 个固定的运行时类型源码文件。默认使用
`/tmp/aa-pinned-neovm-numeric-004cd607`，只从固定官方提交下载缺失文件。用 `--source-cache` 指定
另一个准备好的缓存；被改变的缓存字节会失败，而不是被静默刷新。回执的作用域为
`numeric-coercions`、`vmCorrespondenceProven: false` 与 `fullImplementationVerified: false`。
宿主向量预言机只是测试比较；内核证明使用独立定义的解码算法。

## ApplicationEngine 费用语义

本泳道检查来自 Neo 提交 `d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d` 的完整 `AddFee(BigInteger, bool)`
方法体。一个小的拒绝式源码前端把它的语句、分支顺序、赋值与异常消息投影进一个独立解释的 Coq 程序。
生成的证书必须对每个输入证明该程序与费用规范一致，包括负费用、白名单上下文、恰好预算的成功与超
预算的失败。

该规范在 GAS 不足时保留已更新的费用计数器。它不抹除更早的存储写入。交易与上下文快照是另一项义务。
负输入在白名单豁免之前被拒绝。内部计数器是以 picoGAS 计量的数学整数；因子应用使用实际声明的
`FeeFactor`，而不是默认为 datoshi 单位。

轨迹模型在效应之前检查费用。其擦除定理指出：一个具有非负费用与足够总预算的轨迹，执行的效应与
不计量的轨迹相同。耗尽的轨迹在失败事件的效应之前停止。这还不是“完整合约会发出该轨迹”或“该轨迹
计价覆盖每个操作码、系统调用与原生费用”的定理。

源码词法／解析器、Coq 打印、C# BigInteger 实现与上下文 getter 解释仍属受信任部分。内核检查证明的
是投影出的程序，而不是任意 C# 解析或 .NET 实现。源码哈希绑定输入，但不解除这个语义信任边界。真实
引擎的指令调度、策略配置、价格表、原生动态费用、资源上限与完整的 ApplicationEngine 对应关系仍是
独立工作。

验证要求正向的 `coqc` 与 `coqchk`、对每个声明的假设检查，以及改变算术、分支顺序或严格预算比较的
有效程序突变。语法错误与超时不算证明拒绝。

## 公开纯方法参考精化

本泳道在声明的参考语义下为custom 候选中的三个公开 ABI 方法出具完整方法体证书。它独立投影其类型化
源码、解码其精确 NEF 字节，并对源码结果、终止行为与帧保持做内核检查。它不认证 ApplicationEngine、
ABI 派发、gas 或公开部署。全部 109 个 ABI 条目对完整实现接受仍然未证明。

| 公开方法 | 精确字节区间，结束为开 | 字节／指令数 |
| --- | --- | --- |
| `getAccountImplementationId/0` | `[22447,22480)` | 33 / 3 |
| `supportsExecutionMode/1` | `[22480,22531)` | 51 / 18 |
| `supportsModuleType/1` | `[22531,22580)` | 49 / 18 |

仅源码前端读取 `inventory.source`；它从不查阅字节码、偏移或预期目标结果。它检查完整的 MethodBody、
Block 与 Return、参数类型、相等与短路 OR 元数据，以及每个常量。实现 ID 的类型化常量字段与字段引用
常量必须一致。NEF 把这个常量内联编译：这些方法体都不加载静态状态。其帧定理对任意既有堆、存储与
静态值进行量化，但不证明外层 `_initialize` 或调用方对参数的准入。

源码方言把字符串解释为字节值，源码常量按 UTF-8 编码，并保留 null。这是 Neo 合约方言定理，不是任意
CLR 对象身份的保持，也不是完整 .NET 字符串实现。相等比较字节内容；条件 OR 短路。能力方法报告的是
受支持的字符串，不是修改单个账户配置的权限。

成功的源码域准入 null 以及 0..255、长度至多 65,536 的物理 ByteString 字节。这显式反映了固定的 VM
的[最大可比较大小](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/ExecutionEngineLimits.cs)
与 [ByteString 比较守卫](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/ByteString.cs)。
它不假定 ABI 的 String 声明会校验运行时标签或 UTF-8。在参考语义中，null 与不匹配的字节串返回
false；其他被建模的值标签在这些字符串比较中也返回 false。超长 ByteString 会故障，缺失参数在
INITSLOT 处故障。具体的 StackItem 到参考值对应、派发与资源准入仍是运行时义务。

生成的证书把这些陈述分开：

- 全称执行分类区分 HALT 与 FAULT，并排除超时、继续与中止。它保留堆、存储、效应与静态值。
- 准入源码域定理把带预算的相等与独立源码求值连接起来；组合定理在 HALT 时返回源码值。
- 成功返回使求值栈与局部变量保持为空，并把原始输入作为该方法的参数帧保留。超长故障另行保留环境；
  它们不会被折叠为一个 false 结果。
- 公开解码器在冻结的 helper 解码器上增加 PUSHT。一个受检查的子集定理保持既有解码，另一个子集定理
  在比较守卫成立时保持既有 VM 步进。

新的宿主回执检查 66 个闭合声明：40 个本地／生成，26 个从 IntegerSemantics、CapArithmetic 与
CapMethodVm 导入。八个真实的类型化源码、字节字面量与有效分支突变拥有被接受的定义模块与被拒绝的
语义反例证明。这些共享声明不得作为互不相交的证明加入历史泳道总数。该结果是参考方法体精化；
`fullImplementationVerified` 与 `vmCorrespondenceProven` 保持 false。

在仓库根目录、使用经审计的 .NET/NCCS 与 Coq/Rocq 工具运行：

```sh
python3 -m unittest formal/refinement/test_public_source.py \
  formal/refinement/test_public_pure_proofs.py
python3 formal/refinement/public_pure_proofs.py \
  --inventory /path/to/fresh/inventory.json \
  --output-dir /tmp/sa-public-pure-proof \
  --json-report /tmp/sa-public-pure-proof.json
```

输出目录必须是新的或空的。CLI 总是运行语义对照，在工作前写出失败回执，并且只有在 coqc、coqchk、
每次 Print Assumptions 审计以及最终的输入／模型／工具检查全部通过之后才把它替换为成功回执。失败会
覆盖旧的成功回执；其原因与内核日志仍然可用。回执绑定源码输入、源码树／投影、完整 NEF 与 script、
每个完整方法、模型、证明配方与证书。

请把 `referenceVerifiedEntrypoints` 读作三个经参考认证的方法体，而不是三个被完全接受的实现。见
[实现边界](SA-IMPLEMENTATION-REFINEMENT.md)、[入口点闭合门禁](SA-ENTRYPOINT-CLOSURE.md)以及单独的
[公开运行时检查](#public-sponsored-entry-runtime-refinement)。

## 公开受赞助入口运行时精化

本套件用基础 Neo ApplicationEngine 3.10.1，通过其原始公开的 `executeSponsoredUserOp` 与
`executeSponsoredUserOps` ABI 执行未改动的候选 NEF。它保留注册、原生 owner 见证检查、操作校验、
nonce／加锁、真实 SAPaymaster 策略与 GAS 结算。其目的是为形式化桥提供独立的有限运行时证据，而不是
全称的编译器／VM 精化证明。

测试在 paymaster 发现与目标回调之前，观察真实核心在键 `0x21` 上的单一序列化报销记录。两个公开调用
共享一个交易费用预算；不同账户的嵌套必须看到外层预留；同账户嵌套必须因真实账户锁而失败。随后的
校验、结算、父 script、只读与 gas 失败必须保留原始已提交的账户、赞助方与中继状态。

装配使用现有的 RuntimeFixture 部署／账户／策略设施。被测的公开调用使用带独立托管 GAS 额度的真实
基础 ApplicationEngine；TestEngine.Fee 无法提供该额度，因为它会改变 Transaction.NetworkFee。交易
签名者作用域由测试装置提供，见证不做密码学校验。一个仅测试用的对抗性目标可以调用原始公开 ABI；它
从不替代核心校验、私有 helper 执行或真实 paymaster。

每次调用使用一个克隆的应用快照。成功的跨合约帧按固定引擎提交到其父级。测试装置只在 HALT 时提交外层
交易缓存，并在 FAULT 时丢弃它。因此外层中止之后仍可能存在待定父写入，而它不会到达原始存储。这是与
原生应用执行一致的显式托管策略；它不执行区块持久化、发送方资金检查、见证校验或原生费用燃烧。零费用
向量代表 RPC 估算。

原生 StdLib 序列化／反序列化向量固定 Array/Struct 标签与有符号整数的线格式长度／填充。预期字节独立
于宿主序列化器固定，然后与真实原生执行比较。线格式填充的往返在观察到的地方被规范化。回执包含工件与
运行时身份。

运行 `dotnet test tests/SmartAccount.Contracts.Tests --filter
FullyQualifiedName~ImplementationRefinementPublicRuntimeTests`。这个仅测试的新增不需要任何部署、ABI
迁移或生产源码改动。2026-10-13 的测量结果：**12/12 PASS，零跳过**。最初测试先行的 RED 是 12/12。
编解码用例检查 **33 个精确原生向量**：20 个位于有符号整数边界的 Array/Struct 记录、四个整数归一化
向量，以及九个成帧／标签探测。整数零为 `2100`；`210100` 归一化为 `2100`。`21020700` 归一化为
`210107`，`2102ffff` 归一化为 `2101ff`。Buffer 哈希字段保留标签 `30`；ByteString 哈希字段保留标签
`28`。原生反序列化接受被测试的非最小 uint16/32/64 容器计数、uint16 字节／整数长度、正符号填充与尾随
字节。重新序列化会发出最小成帧并丢弃尾随后缀。负向账本向量描述编解码行为；它们不确立报销不变量或
可达生产状态。

一次成功的单次调用在真实 paymaster 发现、目标执行与结算处暴露 3 GAS 的预留。单次加批量先暴露 3 再
暴露 5 GAS，并推进三个 nonce。不同账户嵌套预留 3 再 5 GAS，并发出 2 再 3 GAS 的结算；同账户嵌套达到
5 GAS 的预留，但真实账户锁中止整个调用。随后的上限、nonce 与真实策略失败，以及一次显式的外层
ABORTMSG，都让原始赞助方存款、中继 GAS、nonce、支出计数器与账本保持不变。它们的父应用缓存保留第一个
成功子调用的 3 GAS 账本，这正说明为什么需要仅 HALT 的外层持久化。首次调用的重入故障不保留任何父
账本。ReadOnly 在真实禁止的系统调用处、在回调之前失败；托管 GAS=1 在第一次计费处失败
（`FeeConsumed=30` datoshi），因此该用例是早期的燃气不足探测，而不是 Storage.Put 之后失败的证明。

回执生成在 `Path.GetTempPath()` 之下（macOS 使用 `/var/folders/…` 目录）。本次运行在此处复制并回读了
持久证据：

- `<tmp>/sa-public-runtime-results/public-final.trx`
- `<tmp>/sa-public-final.log`
- `<tmp>/sa-public-red.log`
- `<tmp>/sa-public-native-codec-vectors.json`，SHA256
  `38cef261e60b5bf08ca11209991e657d919988e40ac5095043dea2e55c116bdd`
- `<tmp>/sa-public-runtime-evidence/`，11 份逐调用 JSON 回执，含费用字段、独立托管额度、实际
  FeeConsumed、回调与已提交／待定账本。

所有公开执行都使用未改动的原始 NEF 与 ABI 描述符。固定的工件身份为：

| 工件 | NEF SHA256 | Manifest SHA256 |
| --- | --- | --- |
| SmartAccountV3 | `4e5c8ae0c4b9722ae19e099303b6a61786de97cc4844abbc1ad458c3a76ce198` | `f7203fd84f6d132119df839a13249d73e4fe67644ca7a2e1c4ad6b9a1f6b21ed` |
| SAPaymaster | `c29738ab55d59c28608a6a646e5f36c4746d4158fccbde54079f11c2865d285a` | `49a51b95c284db4f7971b0f049f8e3e208f6a1f0b3cdce8631bcb6fd73ce0a54` |
| MockTransferTarget | `97d853d1f076abda4a1d6e44aa88ebdca01d390594a77ae03df2e164a7e181c0` | `3760aefced22c045b98414368e4c3eac5a6d9dc866a1b6f017c49c01518d401c` |

SmartAccountV3 那一行在表格写下时指的是当前工件。在上述带日期的路径被捕获之后，它移动了三次：改名为
`SmartAccountV3` 使 script 缩短 10 字节（`083ed325…` / `e79fa049…` → `be43cd05…` / `35fbb188…`），
helper 的 VM 整数余量断言随后使它增长 73 字节，2026-11-16 的设计阶段遗留兼容性清理又改变了一次，
v4 模块协议再次移动了它（当前 NEF `2887bad3…`，manifest `f44cddeb…`）。五形状 helper gas 运行时
捕获已于 2026-11-19 针对该 v4 工件重新生成（`formal/refinement/fixtures/helper-gas-runtime-live-
receipts.json.gz`），因此该捕获是当前的。上面其余行与逐次调用回执仍描述更早的构建，在为当前 NEF
引用之前必须重新生成。SAPaymaster 与 MockTransferTarget 未受上述改动影响，其行是当前的。

MockTransferTarget 明确是一个编译出的测试目标，不是生产 token。内存中的嵌套对手也是仅测试用的。
真实的 GAS 报销使用原生 token。被加载的 Neo 与 Neo.VM 程序集都是 3.10.1.0，其 InformationalVersion
源码提交分别为 `d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d` 与
`004cd6070a940405818d9357638277dd44407e2e`。测试在两者被加载文件的哈希上失败关闭：Neo
`cb1b4db8076847dc23fda920ded773adaeeda07895effd350d2d8a99595a7f3a`、Neo.VM
`cea00a147add3c672bb23ffb5d98a4b1f31da135272efc258fee8fb7805bbfe9`。这些是有界的运行时交叉检查；
不主张编译器级等价、任意回调、生产钱包签名者作用域集成或公链接受。

## 系统调用准入：`System.Contract.Call` 与 `CALLT`

`formal/refinement/coq/EntryDispatch.v` 把自己的入口边界声明为“interop 准入与参数转换之后”。本泳道
恰好覆盖那个被排除的前缀。它是源码信任路线的第一个单元：证明固定 C# 前端的决定，并止于一个既有的
内核检查精化已经开始之处。

此处没有任何内容把 `fullyClosed` 从零推开，原因与 `SA-ENTRYPOINT-CLOSURE.md` 中记录的一致：一个
闭合入口点还需要 ApplicationEngine 派发、gas／异常／交易组合以及编译器对应关系，而它们都不在本
泳道中。

### 固定输入

neo `d10e9cee`，neo-vm `004cd607`：

| 文件 | 原因 |
| --- | --- |
| `ApplicationEngine.Contract.cs` | `System.Contract.Call` 的注册与 `CallContract` |
| `ApplicationEngine.cs` | `OnSysCall`、`ValidateCallFlags`、`OnCallT`、五参数的 `CallContractInternal`、`Register` |
| `CallFlags.cs` | 四个位值与三个复合值 |
| `InteropDescriptor.cs` | `RequiredCallFlags` 与 `Parameters => Handler.GetParameters()` |
| `MethodToken.cs` | token 字段与 `Deserialize` 守卫 |
| `EvaluationStack.cs` | `Pop` |

### 投影推导而非断言的内容

内核消费的记录不是手写的；每个字段都从源码文本读出：

- `interop_pop_count = 4` 与 `interop_flag_slot = 2` 来自 `nameof(CallContract)` 所指声明的参数列表，
  因为 `InteropDescriptor.Parameters` 就是 `Handler.GetParameters()`。
- `interop_required_flags = 5` 是 `Register` 的第四个参数对照枚举自身复合定义求值的结果；`OnSysCall`
  正是把它传给 `ValidateCallFlags`。
- `token_required_flags = 5` 是 `OnCallT` 自己的 `ValidateCallFlags` 参数。
- `call_all_flags = 15` 是 `(callFlags & ~X) != 0` 的右操作数。
- 布尔字段表示哪些语句存在。

改变其中任一源码表达式都会改变投影：`narrow-call-flags` 把 `~CallFlags.All` 换成
`~CallFlags.ReadOnly`，推导值变成 5，而无需查阅任何表格。

### 两类守卫

只有移除后会改变结果或交接值的守卫才是模型字段。四个固定的守卫属于理由精化：被调用合约缺失、ABI
方法缺失、CALLT 的 token 索引越界（无守卫的数组读取会抛出）以及 CALLT 参数个数超过栈（无守卫的
`Pop` 会抛出）。无守卫的代码在同一输入上同样故障，因此其中一个的突变体保持相同的准入结果，什么也
证明不了。它们被建模为无条件故障，并被有意排除在 13 个语义对照之外。

两条真正不同的地方：

| | `System.Contract.Call` | `CALLT` |
| --- | --- | --- |
| 调用方标志闸门 | `ReadStates \| AllowCall`，位于 `OnSysCall` | `ReadStates \| AllowCall`，位于 `OnCallT` |
| 下划线检查 | `CallContract`，在弹栈之后 | 不重复——`MethodToken.Deserialize` 已拒绝 |
| `~CallFlags.All` 范围检查 | `CallContract` | 不重复——`Deserialize` 已拒绝 |
| `callFlags` 来源 | 第三个弹出的栈值 | `token.CallFlags` |
| 被调用者参数 | 转换后的 `Array` 载荷，不透明 | 被弹出的窗口 |
| `IsDynamicCall` | 调用之后置为 `true` | 不触碰 |

最后两行是实质性的。`OnCallT` 原样转移调用方顶部的 `n` 元窗口——`pop_window` 的升序弹出加上
`CallContractInternal` 的降序压入即为恒等——因此把本文件与 `EntryDispatch.v` 组合，得到的被调用者栈
是调用方栈的一段连续、有序前缀。`System.Contract.Call` 没有这条性质：它的被调用者参数向量是一个
栈项载荷，这就是模型把它作为不透明输入携带、而不是假装它是一个窗口的原因。

顺序是被证明而不是假定的：`OnSysCall` 在调用 `CallContract` 之前校验调用方标志并弹出每个处理器
参数，因此栈耗尽会先故障，下划线拒绝根本不可达；而缺少 `ReadStates | AllowCall` 的调用方也永远不会
到达那里。

### 这次运行产出什么

`formal/refinement/syscall_dispatch_proofs.py`：

- 35 个模型声明、11 个证书声明、46 个闭合假设，`coqchk -silent` 干净，没有 `Axioms:` 行。
- 13 个语义对照，每个区分字段一个：每个突变体的原始行为都无法编译，而 `<>` 反例既能编译又通过
  `coqchk`。
- `implementationVerified`、`fullImplementationVerified`、`sourceFrontendVerified` 与
  `vmCorrespondenceProven` 全部保持 `false`。

### 本层仍未闭合

- `AddFee`、gas 计量与每一种资源异常。没有建模任何费用。计费本身现在由
  [描述符计费泳道](#interop-descriptor-charge-and-window-effect)单独覆盖：它与标志检查和第一次弹栈的
  顺序、一次性因子、白名单绕过与严格上限比较。`BigInteger` 算术与异常身份在那里也仍未闭合。
- `Convert` 与 `Array` 载荷；interop 被调用者参数向量是一个输入，不是推导值。
- 异常身份。每个 `Rejected` 构造都是一次故障，但它表现为 `InvalidOperationException`、
  `ArgumentException`、`ArgumentOutOfRangeException`、`FormatException` 还是
  `IndexOutOfRangeException` 未被建模——这正是上面四个仅含理由的守卫无法被区分的原因。
- 合约解析、manifest／ABI 读取、NEF 加载时的 `MethodToken` 反序列化、策略白名单与调用计数。
- 受信任的 C# 抽取与编译器／CLR 对应关系。

### 登记为第十七号门禁作用域

> 前向：把窗口变成处理器参数的那次转换由第十九号作用域 `interop-argument-conversion` 覆盖——见
> [interop 参数转换](#interop-argument-conversion-kernel-checked-nineteenth-gate-scope)。本层在
> 那次转换之前收取的固定价格由第二十号作用域 `interop-descriptor-charge-order` 覆盖——见
> [interop 描述符计费与窗口效应](#interop-descriptor-charge-and-window-effect)。本泳道交接
> **进入**的帧由第十八号作用域 `contract-internal-handoff-and-frame-construction` 覆盖——见
> `docs/SA-CONTRACT-HANDOFF.md`。

该泳道在 `formal/refinement/closure.py` 中登记为 `syscall-dispatch`。由于门禁现在持有本层分类法的
自有复核副本，削弱此处的一个常量不再削弱门禁：泳道报告、其重新生成检查与 `join_scopes` 仍会彼此
一致。

门禁在通用连接之外还做：

- `join_scopes` 把回执的 `program`、`handlerParameters`、`tokenFields`、对照名称列表（有序）以及
  前置条件／未证明／TCB 文本与 `closure.py` 自己的 `SYSCALL_DISPATCH_*` 常量比较，并要求
  `implementationVerified` 与四个作用域标志存在且为 `false`。
- `validate_provenance` 重新哈希 `source-projection.json`，重读其
  `scope`/`entryBoundary`/`program`/`handlerParameters`/`tokenFields` 与域，对照
  `kernelDeclarations` 检查证书的声明清单，并重读 `model.log`/`certificate.log` 以确认每个声明各打印
  一次 `Closed under the global context`，且没有 `Axioms:` 行。
- `main` 从新捕获的固定源码重新生成证书字节与整个对照清单，并与回执比较。

该泳道有意**不**在 `ARTIFACT_LANES` 中：它对已部署合约不作任何主张，因此要求 `nefSha256` 匹配会是
错误的。
如果门禁的副本与本泳道的常量发生分歧，`test_syscall_dispatch_source.test_gate_pins_agree_with_this_lane`
会立即失败，因此这种分歧在一秒内被捕获，而不是在一次完整门禁运行之后。

## interop 参数转换（内核检查，第十九号门禁作用域）

**状态：已登记为第十九号闭合作用域**（`interop-argument-conversion`）。`InteropConvert.v` 是一个
内核检查的模型，`InteropConvertArtifact.v` 是一份绑定到投影记录的证书，18 个语义对照各复核一个
已固定的决策。以上任何一项都没有闭合某个入口点：本泳道止于转换后的参数向量，在处理器方法体运行
之前。`implementationVerified` 与 `fullImplementationVerified` 保持 `false`。

### 为什么需要这一层

`syscall-dispatch` 泳道（[系统调用准入](#syscall-admission-systemcontractcall-and-callt)）覆盖准入，
止于 `CallContractInternal` 参数元组；`contract-handoff` 泳道（`docs/SA-CONTRACT-HANDOFF.md`）从
被调用者内部开始。二者之间正是它们都排除的那一步：`OnSysCall` 把调用方的栈窗口变成被调用处理器的
参数，每个声明参数一次 `Convert(Pop(), ...)`。

### 固定输入（neo `d10e9cee`，neo-vm `004cd607`）

| 键 | 声明 |
| --- | --- |
| `core/engine` | `OnSysCall`、`Convert(object?)`、`Convert(StackItem, InteropParameterDescriptor)` |
| `core/contract` | `CallContract` 声明，读取其四个参数 |
| `core/interop-parameter` | `InteropParameterDescriptor`（`IsArray` 成员、转换器表、构造函数） |
| `vm/limits` | `ExecutionEngineLimits.MaxStackSize` |

来自固定 tarball 的 `ApplicationEngine.cs` 与入口派发泳道所固定的副本逐字节相同，其余三个文件正是
由此在固定之前获得认证的。

### 投影推导而非断言的内容

- `counted_branch_max_length` 由初始化器表达式**求值**得到（`2 * 1024 = 2048`），因此被放宽的上限
  无法悄然通过。
- `array_branch_excludes_byte_element` 从 `IsArray` 声明本身读出
  （`Type.IsArray && Type.GetElementType() != typeof(byte)`），不是复述。
- `argument_count` 是固定 `CallContract` 声明的元数，四个参数类型与名称随它一起出现在
  `parameters` 中。
- 三条转换器键控事实（`array_element_converter_from_element_type`、
  `enum_converter_from_underlying_type`、`identity_converter_for_plain_array`）从构造函数分支与
  转换器表读出，不是假定。

### 两类守卫

**仅含理由、从不突变。** 移除它们仍在同一输入上故障，因此突变体会保持相同结果，什么也证明不了：

| 守卫 | 为什么移除后仍会故障 |
| --- | --- |
| `ValidateCallFlags(descriptor.RequiredCallFlags)` | 同一次调用已带着这些标志被派发器准入，因此调用无法带着守卫会拒绝的字到达此处 |
| `descriptor.Validate(item)` | 该窗口内每个可达描述符都是用校验器构建的，而转换器会立即对同一项重新检查 |

### 内核证明了什么

十九个字段事实（每个投影字段一个定理）加三十个结构定理。其中承重的：

| 定理 | 主张 |
| --- | --- |
| `the_vector_has_one_slot_per_declared_argument` | 无论分支如何，参数向量恰好每个声明参数一个槽 |
| `conversion_never_grows_the_window` | 转换一个参数从不向窗口增加元素 |
| `the_window_shrinks_by_the_arity` | 每个参数一次弹出时，窗口至少收缩元数那么多 |
| `byte_element_leaves_the_array_branch` | 字节元素离开数组分支，且仅因为该字段如此声明 |
| `byte_array_arguments_differ_across_the_branch` | 同一个字节数组参数在一侧转换为字节跨度、在另一侧转换为数组，因此排除是可观察的 |
| `counted_length_above_the_limit_faults` | 严格高于上限的计数长度会故障 |
| `counted_length_at_the_limit_is_accepted` | 上限本身被接受——比较是 `>`，不是 `>=` |
| `counted_length_one_above_the_limit_faults` | 上限的后继值故障，从另一侧固定边界 |
| `counted_branch_takes_exactly_the_count` | 计数分支恰好转换被告知的前缀 |
| `counted_items_stay_when_the_pop_is_dropped` | 去掉弹栈会把被计数项留在调用方窗口上 |
| `a_null_argument_faults_when_the_check_is_on` / `a_nullable_argument_accepts_null` / `a_stack_item_argument_accepts_null` | null 守卫是三个条件的合取，任一单独条件都能破坏它 |
| `a_null_payload_element_faults` / `a_null_counted_element_faults` | 两个数组分支都拒绝 null 元素，且计数分支从调用方窗口读取它 |
| `an_unknown_type_goes_to_the_interface` / `dropping_the_interface_flag_leaves_no_converter` | 未命名类型通过接口转换器到达；去掉该标志则完全没有转换器 |
| `a_void_return_pushes_nothing` / `a_value_return_pushes_one_item` | 返回压栈以处理器返回类型为条件 |
| `returned_nulls_are_dropped` | `OfType<object>()` 丢弃返回数组中的 null 元素 |

每个声明都是 `Closed under the global context`；`coqchk -silent` 通过；模型中不出现
`Admitted`、`Axiom`、`Abort` 或 `Parameter`。

### 十八个对照

每个对照对固定源码做一次文本突变，且每个都必须改变**恰好一个**投影字段。十九个字段中有十八个如此
覆盖；元数是有意的例外（见下）。

| 对照 | 它移动的字段 |
| --- | --- |
| `read-arg-count-from-the-stack` | `argument_count_from_descriptor` |
| `pop-twice-per-parameter` | `pops_one_item_per_parameter` |
| `fill-parameters-backwards` | `pop_order_is_reversed` |
| `push-void-return` | `return_pushes_only_for_nonvoid_handler` |
| `keep-null-return-elements` | `return_payload_drops_nulls` |
| `include-byte-arrays` | `array_branch_excludes_byte_element` |
| `convert-elements-with-the-array-converter` | `array_element_converter_from_element_type` |
| `convert-enums-as-integers` | `enum_converter_from_underlying_type` |
| `unknown-types-are-not-interfaces` | `unknown_type_is_interface` |
| `copy-plain-array-elements` | `identity_converter_for_plain_array` |
| `payload-length-is-not-the-item-count` | `payload_branch_length_is_item_count` |
| `fill-payload-elements-backwards` | `payload_branch_fills_in_index_order` |
| `fill-counted-elements-backwards` | `counted_branch_fills_in_index_order` |
| `keep-the-counted-items-on-the-stack` | `counted_branch_pops_the_count` |
| `weaken-the-stack-size-limit` | `counted_branch_max_length` |
| `allow-a-null-argument` | `null_argument_rejected` |
| `allow-a-null-payload-element` | `null_element_rejected_in_payload_branch` |
| `allow-a-null-counted-element` | `null_element_rejected_in_counted_branch` |

对每个对照，泳道写出三个文件：`Definitions.v`（突变记录，必须能编译）、`OriginalBehavior.v`（对
突变体断言的经复核观察，必须**编译失败**）与 `Counterexample.v`（其否定，必须编译并通过 `coqchk`）。

### 内核或测试逼出的三件事

- **`left` 是保留字。** `left` 与 `right` 是 `sumbool` 的构造子，因此绑定为 `Some (values, left)` 的
  记录投影会被解析为不施加任何参数的构造子。所有这类绑定器都改用 `remaining`。
- **`andb` 链只在其第一个参数上归约。** 因此 null 守卫写成把项测试放在最外层的形式。这与固定源码
  是同一个合取；选择该顺序是为了让非 null 项无需查询描述符就使守卫为 `false`，这正是“null 参数
  故障”定理能靠计算闭合的原因。
- **Python 中 `1 == True`。** 一个布尔槽持有整数的程序记录，会把数值字面量渲染进 `bool` 槽。因此
  `program_expression` 拒绝布尔字段中的非 `bool` 与数值字段中的非 `int`，而门禁用 `literal_equal`
  比较记录，它同时比较类型与值。

### 仍未闭合

- 逐类型转换器函数、它们对 `BigInteger` 的收窄以及它们可能抛出的每个 `FormatException`；此处只把
  它们的结果作为输入。
- 处理器方法体、它的返回值与它的继续执行。
- gas 计量与描述符计价；此处只记录该窗口内**缺少**加费步骤。计费本身由
  [描述符计费泳道](#interop-descriptor-charge-and-window-effect)覆盖，它拥有顺序、因子身份与费用上限。
- 引用计数、`Convert(object?)` 添加的可处置对象，以及调用方与处理器之间的载荷别名。
- 受信任的 C# 抽取与编译器／CLR 对应关系；全部 109 个公开入口点。

### 如何运行

```
AA_INTEROP_CONVERSION_SOURCE_MIRROR=<4 pinned .cs files> \
python3 formal/refinement/interop_convert_proofs.py \
  --output-dir /tmp/interop/out --json-report /tmp/interop/result.json
```

没有镜像时，泳道从 `codeload.github.com` 下载，并且仍须哈希到相同的固定字节。门禁自己运行该泳道
时会继承同一个变量。

## interop 描述符计费与窗口效应

这是第二十个被选中的作用域。它覆盖 [interop 转换](#interop-argument-conversion-kernel-checked-nineteenth-gate-scope)
泳道向后排除的内容：该泳道的前置条件说描述符价格“已被收取”，其未闭合列表承认只记录了窗口内
**缺少**加费步骤。本泳道从固定的 C# 中读出计费本身，并止于参数窗口效应。

**状态。** `implementationVerified` 与 `fullImplementationVerified` 保持 `false`。本作用域不闭合
入口点，也不建模转换、处理器方法体或费用因子是如何获得的。

### 固定输入

| 键 | 文件 | 固定值 |
| --- | --- | --- |
| `core/engine` | `src/Neo/SmartContract/ApplicationEngine.cs` | `97b08bfe…`，位于 `d10e9ce` |
| `core/descriptor` | `src/Neo/SmartContract/InteropDescriptor.cs` | `84c7d8cc…`，位于 `d10e9ce` |

两个固定值都已被 `syscall-dispatch` 泳道复核过，因此这些哈希不是新证据；投影在每次运行时重新检查
它们。

### 源码说了什么

```csharp
protected virtual void OnSysCall(InteropDescriptor descriptor)
{
    ValidateCallFlags(descriptor.RequiredCallFlags);
    AddFee(descriptor.FixedPrice * _execFeeFactor, false);
    object?[] parameters = new object?[descriptor.Parameters.Count];
    for (int i = 0; i < parameters.Length; i++)
        parameters[i] = Convert(Pop(), descriptor.Parameters[i]);
    object? returnValue = descriptor.Handler.Invoke(this, parameters);
    ...
}
```

以及 `AddFee` 本身：

```csharp
if (gas < 0) throw new InvalidOperationException("AddFee can't be negative.");
if (CurrentContext?.GetState<ExecutionContextState>()?.WhiteListed == true) return;
if (applyFactor) { gas *= FeeFactor; }
_feeConsumed = _feeConsumed + gas;
if (_feeConsumed > _feeAmount) throw new InvalidOperationException("Insufficient GAS.");
```

### 投影出的记录

十五个字段，全部从上面的文本推导而非复述。顺序是首要字段：它通过在归一化 `OnSysCall` 方法体中定位
六个锚点并排序读出，因此移动任何语句都会改变它。

| 字段 | 读取自 |
| --- | --- |
| `step_order` | 六个锚点，按位置排序 |
| `charge_reads_the_declared_price` | 计费调用中的 `descriptor.FixedPrice` |
| `charge_uses_the_exec_factor` | 计费调用中的 `_execFeeFactor` |
| `charge_skips_the_inner_factor` | 计费调用的第二个参数是 `false` |
| `vector_length_from_descriptor` | `new object?[descriptor.Parameters.Count]` |
| `pops_one_item_per_parameter` | `Convert(Pop(), descriptor.Parameters[i])` |
| `arity_from_the_handler_signature` | `Parameters => … Handler.GetParameters() …` |
| `declared_price_type_is_long` | `public long FixedPrice { get; init; }` |
| `declared_price_may_be_zero` | 该成员自己的文档注释 |
| `negative_fee_is_rejected` | `if (gas < 0)` 及其抛出 |
| `whitelist_bypasses_the_charge` | 白名单 `return` 位于计数器之前 |
| `factor_applied_only_when_requested` | `if (applyFactor) { gas *= FeeFactor; }` |
| `consumed_incremented_before_the_limit_check` | 计数器索引 < 上限检查索引 |
| `limit_check_is_strict` | `if (_feeConsumed > _feeAmount)` |
| `no_fee_inside_the_conversion_window` | 两个 `Convert` 方法体中都没有 `AddFee` |

`reasonOnlyGuards` 列出两个被读取但不突变的事实：价格成员的身份与费用因子的来源。

### 内核证明了什么

| 定理 | 主张 |
| --- | --- |
| `the_charge_sits_between_the_flag_check_and_the_conversion` | 经复核的顺序，三条关系同时成立 |
| `a_rejected_call_charges_nothing_when_the_flag_check_comes_first` | 标志拒绝支付 0 |
| `a_rejected_call_pays_when_the_charge_comes_first` | 顺序移动后同一次调用支付全价 |
| `the_charge_is_paid_before_the_first_pop` | 任何转换故障仍会留下已收费用 |
| `a_conversion_fault_does_not_refund_the_charge` | 故障与成功收取相同金额 |
| `a_conversion_fault_pops_only_the_converted_prefix` | 弹出数 = `min (S k) arity` |
| `a_fee_shortfall_pops_nothing` | 被拒绝的计费不弹出任何东西 |
| `the_charge_does_not_depend_on_the_arity` | 两种元数，一次计费 |
| `a_whitelisted_context_pays_nothing` / `…_still_pops` | 绕过跳过费用，不跳过工作 |
| `the_factor_is_applied_once_on_the_reviewed_record` | `3 × 5 = 15` |
| `asking_for_the_factor_twice_would_charge_seventy_five` | `15 × 5 = 75` |
| `dropping_the_inner_branch_also_doubles_the_charge` | 从另一个方向得到同样的 75 |
| `a_zero_price_charges_nothing` | 零 `FixedPrice` 在此点免费 |
| `the_long_declaration_holds_a_price_above_the_int_range` | `3e9` 能放进 `long`，放不进 `int` |
| `a_zero_price_is_legitimate_on_the_reviewed_record` | 零是声明值，不是错误 |
| `a_negative_fee_is_rejected` | `-1` 边界 |
| `the_limit_accepts_a_call_landing_exactly_on_it` | 严格 `>`，因此相等可以 |
| `a_call_that_overruns_the_limit_is_refused` | `3 + 3 > 5` |
| `checking_the_limit_before_counting_would_accept_the_overrun` | 计数器顺序很关键 |
| `the_conversion_window_adds_no_fee` | 窗口费用为 0 |

35 个模型声明，全部 `Closed under the global context`，无公理。

### 语义对照

十六个，每个突变体一个，每个恰好移动一个投影字段（`argument_count` 在此没有对应物；每个字段都是
可变的）。其中两个移动顺序：

| 对照 | 移动的字段 |
| --- | --- |
| `charge-before-the-flag-check` | `step_order` |
| `charge-after-the-conversion-loop` | `step_order` |
| `charge-reads-another-price-member` | `charge_reads_the_declared_price` |
| `charge-multiplies-by-the-base-factor` | `charge_uses_the_exec_factor` |
| `ask-add-fee-to-apply-the-factor-again` | `charge_skips_the_inner_factor` |
| `size-the-vector-from-a-constant` | `vector_length_from_descriptor` |
| `convert-every-parameter-from-the-first-descriptor` | `pops_one_item_per_parameter` |
| `take-the-arity-from-an-empty-signature` | `arity_from_the_handler_signature` |
| `narrow-the-declared-price-to-int` | `declared_price_type_is_long` |
| `declare-the-price-always-nonzero` | `declared_price_may_be_zero` |
| `accept-a-negative-fee` | `negative_fee_is_rejected` |
| `charge-a-whitelisted-context` | `whitelist_bypasses_the_charge` |
| `always-apply-the-factor-branch` | `factor_applied_only_when_requested` |
| `check-the-limit-before-counting-the-charge` | `consumed_incremented_before_the_limit_check` |
| `reject-a-call-at-exactly-the-limit` | `limit_check_is_strict` |
| `charge-a-fee-inside-the-conversion-window` | `no_fee_inside_the_conversion_window` |

每个对照编译其 `Definitions.v`，然后在 `OriginalBehavior.v` 中断言经复核的观察——该文件必须失败
——并在 `Counterexample.v` 中断言否定，后者必须通过 `coqchk`。一个仍然证明经复核取值的对照，就意味着
该字段是装饰性的。

### 本泳道逼出的三件事

1. **`_execFeeFactor` 已经携带费用小数位。** 该字段构造为 `policyFactor * FeeFactor`
   （`// Add fee decimals`），这就是计费传入 `applyFactor: false` 的原因。传入 `true` 会把因子平方；
   `charge_skips_the_inner_factor` 字段及其对照正是为此存在。
2. **计费有意在窗口之外。** 转换故障会中止该帧，但费用已经被计入，因此不会退还。把 `AddFee` 调用
   移到循环之后正是顺序字段所禁止的 bug，而 `charge-after-the-conversion-loop` 对照显示：移动之后
   故障时计费降到 0。
3. **连接必须一致的是 `Fields` 的极性，而不是字段名。** 初稿把 Coq 字段命名为 `fp_apply_factor`
   （true = 双倍计费），而投影把同一事实命名为 `charge_apply_factor`（true = 源码传入 `false`）。
   证书以 `Unable to unify "canonical_fee" with "actual_program"` 失败。现在两侧的字段都是
   `fp_skips_the_inner_factor`，因此 `true` 在各处含义一致。

### 仍未闭合

- `_feeConsumed + gas` 在 `BigInteger` 宽度上的算术，以及被拒绝的计费表现为 `OutOfGas` 还是通用的
  无效操作。到底是哪个异常、以及抛出时有什么到达合约与宿主，现在是它自己的作用域：
  [异常身份](#exception-identity-and-catchability)。
- `_execFeeFactor` 在每条分叉路径上如何获得（`policy` 读取、pico 因子、硬编码默认值）；只记录了
  成员身份。
- 哪些描述符声明零 `FixedPrice`；本泳道只证明该声明允许零。
- 转换、处理器方法体及其返回值——它们仍在
  [interop 参数转换](#interop-argument-conversion-kernel-checked-nineteenth-gate-scope)中。
- 受信任的 C# 抽取与编译器／CLR 对应关系；全部 109 个公开入口点。

### 如何运行

```sh
python3 formal/refinement/interop_fee_proofs.py \
  --output-dir /tmp/sa-interop-fee \
  --json-report /tmp/sa-interop-fee/report.json
```

把 `AA_INTEROP_CHARGE_SOURCE_MIRROR` 设为一个包含 `core-engine.cs` 与 `core-descriptor.cs` 的目录即可
离线工作；镜像字节必须哈希到相同的固定值，因此它无法洗白不同的工件。

## 异常身份与可捕获性

这是第二十一个被选中的作用域。有四条泳道说“它会抛出”，却没有记录**哪个**异常到达谁：gas 泳道拒绝
一次计费，系统调用泳道拒绝一次准入，合约交接泳道拒绝一次调用，转换泳道拒绝一个参数。它们都把拒绝
记录为布尔结果，把异常的身份留作未闭合。本泳道从固定的 C# 中读出暴露机制，并止于故障状态效应。

**状态。** `implementationVerified` 与 `fullImplementationVerified` 保持 `false`。本作用域不闭合
入口点，不建模指令语义，也不建模 TRY 栈协议或任何交易组合。

### 固定输入

| 键 | 仓库 | 文件 | 固定值 |
| --- | --- | --- | --- |
| `vm/engine` | `neo-vm` | `src/Neo.VM/ExecutionEngine.cs` | `ea906436…`，位于 `004cd60` |
| `vm/control` | `neo-vm` | `src/Neo.VM/JumpTable/JumpTable.Control.cs` | `a0ac51ff…`，位于 `004cd60` |
| `vm/limits` | `neo-vm` | `src/Neo.VM/ExecutionEngineLimits.cs` | `b8353f47…`，位于 `004cd60` |
| `vm/catchable` | `neo-vm` | `src/Neo.VM/CatchableException.cs` | `c6fbc18f…`，位于 `004cd60` |
| `vm/unhandled` | `neo-vm` | `src/Neo.VM/VMUnhandledException.cs` | `71cd4912…`，位于 `004cd60` |
| `core/engine` | `neo` | `src/Neo/SmartContract/ApplicationEngine.cs` | `97b08bfe…`，位于 `d10e9ce` |

`vm/control` 与 `vm/limits` 已被 `runtime` 与 `interop-conversion` 泳道复核，`core/engine` 已被另外
六条泳道复核，因此这三个哈希不是新证据；两个异常类与 VM 引擎文件是新的。投影在每次运行时重新检查
全部六个。

### 源码说了什么

指令回合只把操作码处理器包在一个带类型、带守卫的 catch 中：

```csharp
try
{
    JumpTable[instruction.OpCode](this, instruction);
}
catch (CatchableException ex) when (Limits.CatchEngineExceptions)
{
    JumpTable.ExecuteThrow(this, ex.Message);
}
PostExecuteInstruction(instruction);
if (!isJumping && currentInstruction != null)
    context.InstructionPointer += instruction.Size;
isJumping = false;
```

而外层处理器是无类型的，因此守卫未准入的一切都落到那里：

```csharp
catch (Exception e)
{
    OnFault(e);
}
```

`CatchableException` 直接派生自 `Exception`，这正是使被守卫子句变窄的原因：一个
`InvalidOperationException` 不是 `CatchableException`，因此永远无法进入带类型的处理器。带类型处理器
交出的是**消息**：

```csharp
public virtual void ExecuteThrow(ExecutionEngine engine, StackItem? ex)
{
    engine.UncaughtException = ex;
    ...
            engine.Push(engine.UncaughtException!);
            executionContext.InstructionPointer = tryContext.CatchPointer;
            engine.UncaughtException = null;
    ...
    throw new VMUnhandledException(engine.UncaughtException!);
}
```

`VMUnhandledException` 把被抛出的 `StackItem` 包在 `ExceptionObject` 中，引擎在宿主侧记录该异常
对象并清空通知集合：

```csharp
protected override void OnFault(Exception ex)
{
    FaultException = ex;
    notifications = null;
    base.OnFault(ex);
}
```

### 投影出的记录

十六个字段，每个从固定文本推导，每个可独立突变。`step_order` 是一个字段而不是复述：
`guarded-catch` 锚定在 `ExecuteThrow` 调用上，`fault-handler` 锚定在 `OnFault` 调用上，因此移动任一
块都会改写顺序。

| 字段 | 源码事实 |
| --- | --- |
| `step_order` | `read-instruction` → `guarded-catch` → `post-hook` → `advance-pointer` → `fault-handler` |
| `catch_names_the_catchable_type` | 被守卫子句命名 `CatchableException` |
| `catch_is_guarded_by_the_limit` | 该子句携带 `when (Limits.CatchEngineExceptions)` |
| `the_generic_handler_is_untyped` | 外层子句是 `catch (Exception e)` |
| `the_caught_value_is_the_message` | 被守卫处理器是用 `ex.Message` 调用的 |
| `the_fault_sets_the_state` | `OnFault` 赋值 `State = VMState.FAULT` |
| `the_thrown_value_is_recorded_at_entry` | `ExecuteThrow` 开头就存储其参数 |
| `a_handler_clears_the_recorded_value` | 被执行的处理器清除 `UncaughtException` |
| `the_handler_receives_the_thrown_value` | 被执行的处理器压入那个已存储值 |
| `the_walk_skips_the_finally_and_consumed_catch` | 遍历跳过 `Finally` 与已耗尽的 `Catch` |
| `an_absent_handler_wraps_the_value` | 遍历以抛出 `VMUnhandledException` 结束 |
| `a_dedicated_catchable_type_exists` | `CatchableException` 已声明并派生自 `Exception` |
| `the_wrapper_keeps_the_thrown_object` | 包装器保留 `ExceptionObject` |
| `the_engine_records_the_fault` | `ApplicationEngine.OnFault` 存储 `FaultException` |
| `the_engine_clears_the_notifications` | 同一个重写清除 `notifications` |
| `the_limit_defaults_to_catching` | `CatchEngineExceptions` 声明 `= true` |

### 内核证明了什么

`coq/ExceptionIdentity.v` 闭合 29 个声明；生成的证书再加 30 个，得到 `closedAssumptionCount = 59`。
没有 `Axiom`、没有 `Admitted`、没有 `Parameter`——证书上的 `coqchk -silent` 退出码为 0，两份日志每个
声明各有一条 `Closed under the global context`，且没有 `Axioms:` 行。

| 定理 | 它确立了什么 |
| --- | --- |
| `the_reviewed_order_puts_the_catch_before_the_fault_handler` | 记录的顺序至少允许捕获 |
| `a_fault_first_record_admits_nothing` | 重排后的表无法捕获，无论类型怎么声明 |
| `an_uncatchable_exception_is_never_admitted` | 对每个记录与上限，准入都是 `false` |
| `an_uncatchable_exception_never_reaches_a_handler` | 它永远不会有处理器运行 |
| `an_unguarded_record_catches_with_the_limit_off` | 上限之所以有意义，仅因为守卫存在 |
| `a_misnamed_catch_record_admits_nothing` | 子句自身的类型是承重的 |
| `a_caught_turn_receives_the_message` | 合约得到的是消息 |
| `handing_over_the_object_would_break_the_message_guarantee` | 压入 `ex` 而不是 `ex.Message` 是可观察的 |
| `failures_the_engine_does_not_catch_are_indistinguishable` | 身份在故障路径上被抹除 |
| `a_caught_turn_is_not_a_fault` | 被执行的处理器让该回合继续运行 |
| `a_faulted_turn_skips_the_pointer_advance` | 故障结束该回合 |
| `the_fault_path_always_clears_the_notifications` | 每次故障都丢失通知集合 |
| `a_caught_throw_leaves_the_notifications_alone` | 而每次被捕获的抛出都保留它 |
| `the_wrapper_and_the_original_are_never_both_recorded` | 宿主恰好看到两者之一 |
| `a_caught_turn_records_no_wrapper` / `…_no_exception_at_all` | 被捕获的抛出两者都不记录 |
| `a_wrapper_that_drops_the_object_leaves_the_host_with_a_shell` | 包装器的载荷是承重的 |
| `an_unrecorded_engine_leaves_the_host_with_no_exception` | `FaultException` 是唯一的宿主记录 |
| `an_engine_that_skips_the_fault_assignment_loses_the_fault_state` | 状态赋值是承重的 |
| `an_engine_that_keeps_the_notifications_leaks_them_on_a_fault` | 清空同样承重 |
| `swapping_the_hook_and_the_pointer_advance_keeps_the_catch_first` | 该交换在顺序上可见，但在准入上不可见 |

### 四条路径并排

| 抛出类 | 上限 | 处理器 | 合约看到 | 宿主记录 | 通知 |
| --- | --- | --- | --- | --- | --- |
| `CatchableException` | `true` | 存在 | `ByteString(message)` | 无 | 保留 |
| `CatchableException` | `true` | 缺失 | 无 | `VMUnhandledException` | 清空 |
| `CatchableException` | `false` | 任一 | 无 | 异常本身 | 清空 |
| 其他任何类型 | 任一 | 任一 | 无 | 异常本身 | 清空 |

第一行是合约唯一能观察到某些内容的行，而它观察到的是一个字符串。第三行与第四行有意完全相同：引擎
不捕获的异常，其类型完全不可观察，这正是模型没有该字段的原因。

### 十六个对照

每个对照针对一个被改变的源码事实重新编译模型，必须无法证明经复核的行为，并且必须证明反例。每个
突变恰好移动一个投影字段，十六个对照覆盖全部十六个字段。

| 对照 | 它移动的字段 |
| --- | --- |
| `drop-the-limit-guard` | `catch_is_guarded_by_the_limit` |
| `name-the-base-type-in-the-guarded-clause` | `catch_names_the_catchable_type` |
| `throw-the-exception-object-instead-of-its-message` | `the_caught_value_is_the_message` |
| `make-the-outer-handler-typed` | `the_generic_handler_is_untyped` |
| `fault-without-setting-the-state` | `the_fault_sets_the_state` |
| `skip-recording-the-thrown-value` | `the_thrown_value_is_recorded_at_entry` |
| `never-clear-the-recorded-value` | `a_handler_clears_the_recorded_value` |
| `push-a-null-instead-of-the-thrown-value` | `the_handler_receives_the_thrown_value` |
| `treat-the-finally-frame-as-a-catch` | `the_walk_skips_the_finally_and_consumed_catch` |
| `let-the-unhandled-value-escape-unwrapped` | `an_absent_handler_wraps_the_value` |
| `give-the-catchable-exception-no-dedicated-type` | `a_dedicated_catchable_type_exists` |
| `drop-the-wrapped-object` | `the_wrapper_keeps_the_thrown_object` |
| `fault-without-recording-the-exception` | `the_engine_records_the_fault` |
| `keep-the-notifications-on-fault` | `the_engine_clears_the_notifications` |
| `default-the-limit-to-off` | `the_limit_defaults_to_catching` |
| `swap-the-hook-and-the-pointer-advance` | `step_order` |

### 本泳道逼出的三件事

**分词器没有 `#` token，因此固定的引擎无法被原样读取。** `ExecutionEngine.cs` 携带两个向控制台打印
的 `VMPERF` 区域。它们不赋值任何状态，却位于本泳道所读的两个方法体之内。因此泳道在投影前丢弃
预处理器**行**，并对原始字节做哈希：固定值仍覆盖整个文件，只是投影跳过了共享分词器无法表达的指令
语法。这记录在泳道的 `tcb` 中，而不是藏在某个 helper 里。

**守卫与合取项不是一回事。** `admits` 的第一版把 `guard` 乘进 `limit`。这读起来自然，但是错误的：
当守卫**缺失**时，准入随后仍要求 `limit` 成立，于是去掉守卫会让一切变得不可捕获。正确的读法是蕴含
——守卫存在则蕴含上限必须准入；守卫缺失则蕴含上限无关。`an_unguarded_record_catches_with_the_limit_off`
就是把这一点钉死的测试，而丢弃守卫的突变正是那种在错误读法下会悄然通过的对照。

**有一个投影字段是冗余的，必须删除。** `guarded_handler_precedes_the_generic_one` 看起来像真事实，
但每一个能移动它的突变也会移动 `step_order`，因此它永远无法被单字段对照隔离。`step_order` 已经
包含 `guarded-catch` 在 `fault-handler` 之前，因此该字段被删除，而不是留在未覆盖状态。泳道现在
恰好每个字段一个对照、每个对照一个字段。

### 仍未闭合

- 每个具体引擎操作抛出哪种具体异常类型。本泳道记录 catch 子句的身份与暴露规则，而不是每个操作码的
  抛出位置。
- 是否有任何宿主会以 `CatchEngineExceptions` 关闭的状态构造引擎。只记录了声明的默认值与守卫位置。
- 故障消息文本以及由它派生的任何客户端可见诊断。
- 故障之后账本与存储效应的回滚，以及决定故障执行是被提交还是被丢弃的交易组合——
  `GAS_RESOURCE_EXCEPTION_AND_TRANSACTION_COMPOSITION` 的剩余部分。
- 受信任的 C# 抽取与编译器／CLR 对应关系；全部 109 个公开入口点。

### 如何运行

```sh
cd formal/refinement
python3 -m unittest test_exception_identity_source       # 25 tests
python3 exception_identity_proofs.py \
    --output-dir /tmp/exid --json-report /tmp/exid/exception-identity-proof.json
```

一次完整运行约需两分半：两遍 `coqc` 加减 `coqchk`（模型与证书各一遍），然后每个对照四条内核命令。

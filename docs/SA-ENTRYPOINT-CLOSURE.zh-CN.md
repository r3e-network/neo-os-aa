# 公开入口点闭合清单

> 中文版本与 `docs/SA-ENTRYPOINT-CLOSURE.md` 同构。若两者冲突，以英文版本为准。

本清单是一次独立的结构性检查，既不是语义定理，也不是发布证书。每一个 manifest 条目都必须
保留其完整的入口点义务，即使它的方法体已经拥有独立检查过的证书。

工具把类型化源码导出、manifest 描述符与精确的 NEF 指令绑定起来，然后覆盖全部字节区间、
静态与间接调用、外部处理器以及调用图环。结构性可达包括 manifest 根、initializer 入口、
分支／顺序落入／处理器边、直接调用，以及每一个被 `PUSHA` 取过地址的位置。未解析的 `CALLA`
会阻止得出“不可达”的结论。不可达只表示在这个显式图中不存在路径，并不表示语义上的死代码。
隐式异常流、VM gas 与 ApplicationEngine 效应仍属各自独立的义务。

用以下命令运行对抗性测试：

```sh
python3 -m unittest discover -s formal/refinement -p test_entrypoint_inventory.py -v
```

遗漏的边、被替换成有效值的入口偏移、缺失的源码输入归属、指令宽度／操作码伪造以及凭空
构造的间接目标，都必须失败关闭。

实际命令还会在归集之前与之后检查全部输入哈希和当前编译输入归属。它用现有的严格校验器
重新打开 NEF 与 manifest，并检查每条指令各字段的独立解码，包括操作数字节、指令长度与边。
内存内的构建器只用于已经绑定的数据和固定样例；工件证据请使用 CLI：

```sh
python3 formal/refinement/entrypoint_inventory.py \
  --inventory "$AA_CURRENT_INVENTORY" \
  --json-report /tmp/aa-entrypoint-closure-current.json
```

当前工件身份为 NEF SHA256
`9f714866c5ba1b6cf31d63036d9805d73058055f325fd412e303356534ba2f76`
（script `909ba759b66a4d84a4bd2aa2a2a78ef611c8b27e834b460a90f8ff83d387e1cd`，
manifest `a6533d47d4a72c3c8159923ce54cb136ab02acb0e9a8c5f24cf75bd4ea838e31`），
对应清单 SHA256
`65a73399659594d72b8ae063f14fc64ed18120719111165b69f03785f81d7195`。
其目标是普通 Neo 3.10.1 源码提交
`d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d` 与 Neo.VM 源码提交
`004cd6070a940405818d9357638277dd44407e2e`。

清单 SHA256 刻意**不**用作工件身份：当工件逐字节相同时，它在重新构建之间并不稳定，因为
`sourceMap.debug.document-root` 会记录每次构建的导出目录
（`…/T/sa-refinement-export-<random-hex>/contracts`）。`nef.sha256`、
`nef.scriptSha256`、`manifest.sha256`、`tokens`、`instructions` 与
`debug.methods` 保持逐字节相同；只有被记录的构建路径（以及一条
`compiler.loadedAssemblies` 记录）发生移动。判断两次构建是否为同一工件时，应比较这些
字段，而不是清单摘要。

当前结果归集了 109 个 manifest 条目、197 个字节方法、953 个类型化源码方法、371 个导出的
源码 initializer，以及全部 10,594 条指令／30,678 个 script 字节。197 个 debug 身份全部
唯一匹配到类型化方法的显示名，108 个有源码支撑的 ABI 描述符匹配其 manifest 描述符。剩下
那个 manifest 条目 `_initialize/0` 没有类型化／debug 方法映射，它的精确区间是
`[29996,30678)`：682 字节、182 条指令，且仍未被源码绑定。

图中有 426 个直接调用点、625 个外部效应点（77 个 token 调用与 548 个系统调用）、20 个
局部控制流环分量、1 个调用递归分量，没有 `CALLA`，也没有 `PUSHA`。位于源码／debug 方法
区间之外的 1,118 个字节被保留在 41 个生成／未映射区间中。initializer 归集了 682 个结构
可达字节；另外 40 个区间中的 436 个字节，从保守根集合出发沿显式解码边没有路径可达。它们
被标记为 `structurallyUnreachable`，且 `semanticDead:false`。未来一旦出现间接调用，这个
结论即失效。本结果不对外部宿主绕过正常 manifest 派发规则所引入的执行作出任何断言。

历史工件 NEF
`4e5c8ae0c4b9722ae19e099303b6a61786de97cc4844abbc1ad458c3a76ce198`
（`[13557,13838)` helper，slot 34，100 个条目）与
`6c347dac40bd562edda3216e40c7007fad3a2bb24020013e730c58bd4ceed1c3`
（`[17762,18043)` helper，slot 38，105 个条目）都是历史记录。它们的布局、slot 与计数
不得套用到当前工件上。

源码图与字节图是彼此独立的：源码图记录已绑定的方法、构造函数、运算符与转换引用、
属性／字段引用、源码循环以及未导出的元数据。编译器内联或内建指令降级不能成为把这两个图
等同起来的理由。缺失的外部源码方法与未导出元数据保持未闭合。每个 ABI 闭包包含其方法体／
被调用者的字节区间、传递引用的源码成员以及公共的 initializer 依赖。完整计数仍为
`fullUnprovedCount:109`。外部／静态／间接效应按完整方法体加 initializer 作用域分别上报；
独立的 `body*` 与 `initialization*` 字段保留其来源，避免仅选中纯方法体时掩盖了公共初始化
效应。

清单包含完整的字节语义与故障、源码对应关系、源码元数据缺口、属性／字段解释、循环／递归
不变量、外部处理器规范、间接目标解析、调用／返回帧、类型化 ABI 转换、初始化、编译器
对应关系、VM／ApplicationEngine 对应关系、gas／资源以及交易状态／回滚。它不消费任何证明
回执，也不把其中任何一项义务标记为闭合。`bodyScopedEvidence` 是一个独立字段，初始为空。
修改标志位或附加一份 helper／区域回执，都不能把本工具变成完整的证书校验器。

[SA-CLOSURE-GATE.md](SA-CLOSURE-GATE.md) 中的聚合门禁会报告其选定泳道精化了哪些入口方法体，
按互不重叠的 `entrypointCoverage` 桶划分：`fullyClosed`、`bodyLevelRefined` 与
`dispatchLevelOnly`。这些桶只描述门禁自身选定的作用域。本清单仍然要求每个 manifest 条目
保留其全部义务，当前 `fullUnprovedCount` 为 `109`。

自动选出的首批公开候选为：

| ABI 入口 | 精确方法体区间 | 字节／指令数 | 尚缺的方法体工作 |
| --- | --- | --- | --- |
| `getAccountImplementationId/0` | `[22447,22480)` | 33 / 3 | 源码字符串／ABI 观察以及 VM 方法体定理 |
| `supportsExecutionMode/1` | `[22480,22531)` | 51 / 18 | 布尔 `PUSHT`、字符串比较的边界／故障以及源码投影 |
| `supportsModuleType/1` | `[22531,22580)` | 49 / 18 | 同样的要求 |

三者都没有静态字段、外部效应、内部调用或调用图环。它们的方法体证明单独在
[SA-METHOD-REFINEMENT.md](SA-METHOD-REFINEMENT.md#public-pure-method-reference-refinement)
中展开。它们的完整入口点依赖在本清单中仍然未闭合。

自动选择还找出七个没有显式外部效应或调用图环的私有源码 helper。当前 `CapMethodVm.v`
解码文本识别 `BuildHookOperationParams` 的全部字节操作码，区间 `[15136,15160)`，24 字节／
21 条指令，源码位于 `SmartAccount.Execution.cs:298–309`。这是下一个最小的有用纯 helper
候选：它使用现有的参数／堆／帧操作码，从一个 `UserOperation` 与调用方参数构造打包的
参数数组。仅凭解码器的文本识别不能证明它的取值、别名、故障、源码投影或通用帧行为。

| 其他 helper | 区间 | 字节／指令数 | 当前 CapMethodVm 解码文本缺失的操作码 |
| --- | --- | --- | --- |
| `UInt32ToLittleEndianBytes` | `[293,404)` | 111 / 71 | AND, JMPGE, JMPLE, NEWBUFFER, PUSHINT8, SHR |
| `ValidateAccountId` | `[6155,6234)` | 79 / 27 | ISTYPE, NUMEQUAL, PUSHF, PUSHINT8, SIZE |
| `AssertTargetIsNotProtocolOwned` | `[13687,14021)` | 334 / 32 | 无 |
| `IsUnsignedIntegerWithinBytes` | `[14377,14594)` | 217 / 101 | AND, CONVERT, DEC, JMPGE, JMPLE, JMP_L, LT, PUSHF, PUSHINT32/64, PUSHT, SIZE |
| `ValidatePlatformAccountBinding` | `[20225,20317)` | 92 / 24 | PUSHF, SIZE |
| `DataPushInstructionSize` | `[27609,29009)` | 1400 / 568 | AND, GE, JMPGE, JMPIFNOT_L, JMPLE, JMP_L, PUSHF, PUSHINT8/32/64, PUSHT |

机器画像由当前参考解码器文本推导得到，对它固定该模型的哈希，并明确上报其有限作用域。
它不是受支持的指令语义证明。独立的公开纯方法模型扩展了 `PUSHT`；本清单不会悄悄地把该
扩展视为 `CapMethodVm` 的一部分。

唯一另一个没有静态字段效应或环的公开候选是 `computeArgsHash/1`，区间
`[23686,23739)`，53 字节／13 条指令，源码位于 `SmartAccount.State.cs:274–283`。它需要
`StdLib.serialize` 与 `System.Contract.Call` 处理器对应关系，因此被归类为需要外部环境
规范。方法名或表面上的源码纯度都不能消除这些真实的字节依赖。

## 引擎对这个图的说法

上面的一切都从解码后的 script 计算得出。可达性是关于本工具所建图中路径的断言，而直到最近，
工具之外的任何东西都从未真正走过其中一条路径。

`formal/refinement/dispatch_footprint.py` 会走。导出器把固定的 NEF 部署进真实的
`ApplicationEngine`，按 manifest 声明的参数个数逐个以名称调用每个 ABI 方法，并记录引擎在
合约内部执行过的每一条指令偏移——按运行的 script 哈希归属，而不是按栈深度归属，因此
原生合约的偏移不会被记到本合约名下。随后本模块用 Neo.VM 3.10.1 的 `nef_decode` 表把同一份
script 字节再解码一次，并对这一对结果提出四个问题：

| 问题 | 结果（第 31 号门禁） |
| --- | --- |
| dump 中的 script 是否解码到两份文档共同主张的 sha256 | 25,620 字节、8,833 条指令 |
| 每个已执行偏移是否都是指令起点 | 1,661 个不同偏移中 0 个未知 |
| 200 个归集字节区间是否划分了 script 并拥有全部已执行偏移 | 无空洞、无重叠、0 个无主 |
| 实际进入的字节方法是否属于 `byteDependencyStarts ∪ initializationDependencyStarts` 可达集合 | 315 个在内，0 个在外 |

第四行是唯一必须成立的方向，也正是本清单的 `byteDependencyStarts` 一直在主张的内容。
闭包在 98 次派发调用中列出 657 个成员；其中 342 个可达但从未进入。这是预期行为而非缺陷
——一次零参数调用只取走 may 集合中的一条路径——回执会打印这个数字，而不是默默要求一个
它随后必须解释掉的等号。

它**不**做的事：不把闭包验证为完备，因为每个入口点只观察到一条路径；不测试任何依赖参数
的分支；对已执行指令计算了什么一无所知。`fullyClosed` 保持 `0`，
`fullImplementationVerified` 保持 `false`。

同一份 dump 还回答了派发问题的否定一半，这是上面所有数字都回答不了的：引擎会怎样处理
manifest 没有描述的调用。在当前重测中，195 个探测的参数个数与该名字的任何重载声明都不符，
全部 195 个都在本合约执行任何一条指令之前被 `ContractManagement` 拒绝——
`Method "computeRegistrationAccountId" with 4 parameter(s) doesn't exist in the contract`，
并给出 `entered: false` 与十几步执行，而不是对照组的二百步。那个无人声明的名字同样被拒绝。
而 `finalizeEscape` **确实**声明了的两个参数个数，各进入不同的偏移 10988 与 11000，这是
本工件上唯一能演示（而非仅仅读出）名称加元数选择的地方。另有 91 个参数形状是 manifest
声称不可能到达的，却在边界处全部被接受：84 个在合约内部失败，7 个成功返回，可见声明的
参数类型只是给工具看的文档，而不是准入规则——记录为 `shapeEnforcedAtBoundary: false`，
而不是记为工件缺陷。

### 同一张图，带参数

`formal/refinement/abi_scenario.py` 发送真实取值而不是零。经过复核的场景文件声明一串有序
调用——方法、字面参数、签名者、执行时的区块时间、调用落在哪个合约上、该调用期望的结束
方式，以及某个结果必须等于的先前参数——同一个引擎在一次部署上依次执行它们，因此一次写入
和紧随其后的读取都留在记录上。共驱动四个文件。第一个在单一区块时间上做二十九次调用，
构建账户、注册账户、通过它写入再读回。第二个在九个声明的区块时间上做五十三次调用，驱动
时间锁：四对调用使用相同的调用与相同参数，一次在边界前一毫秒、一次恰好在边界上，先故障
而后停机。第三个做六十二次调用，在账户旁部署四个真实插件合约并调用它们——此处的限制是
结构性的而非时间性的，因为验证器方法体没有验证器就无法运行，而准入检查读取的是已部署的
manifest 而不是源码文件。其中十个步骤落在插件上，其声明的返回类型从该插件自己的 manifest
读出。第四个做八十四次调用，部署的是**另一方**而不是插件：平台注册通道与市场托管都断言其
调用方是合约，因此注册服务合约本身、一个转发器与一个 paymaster 被安装进去，账户自身受
注册门禁与市场门禁约束的入口在这些之后运行。在固定的工件上合计：228 次调用，186 次停机
与 42 次故障，且故障原因与文件预测一致；228 帧全部与按操作码表编写的编码器逐字节一致；
228 次全部落在声明的时刻与签名者上；三十八条读取链接逐字节成立；每一个声明的整数、布尔
与数组长度都匹配。

在此门禁上次测量的 105 条目工件上，有两个条目声明的返回类型——`Any` 与 `Array`——只由
在零参数下必定故障的方法声明，因此任何零参数面都永远无法应用其映射；五个面的并集覆盖了
全部八种声明返回类型，门禁在其实现之前拒绝通过。那是八种返回类型，不是八种行为。同一次
测量把 105 个条目分解为：89 个由四个文件中的某个步骤按名调用，8 个在调用方之后执行并由
其改变的状态作证（两处平台注册、owner 轮换与三次托管状态迁移），5 个通过面向插件的回调
路径到达，3 个声明为未到达：`_deploy/2` 与 `_initialize/0`——`System.Contract.Call` 因
其名字以下划线开头而根本拒绝调用——以及 `rotatePlatformAccountOwner/3`，一个只有一行的
别名，mock 调用的是它的目标。当前工件带有 109 个条目；闭合运行会针对它重新测量这份分解，
而不是继承 105 条目的划分。在当前工件上重测：88 个条目由四个文件中的某个步骤按名调用
（其中包括 `finalizeEscape` 的两个元数），6 个在调用方之后执行并由其改变的状态作证——
注册器之后的两处平台注册与 owner 轮换应用，市场之后的三次托管迁移——1 个通过插件回调
到达（`clearHookDependencies/1`，`MultiHook` 的 `clearAccount` 无条件调用它），14 个声明
为未到达：两个引擎入口点，以及十二个没有场景驱动的运维条目（冻结生命周期、依赖写入者、
子 hook 转发器、模拟读取与四次安全读取；对应关系文档列出了它们）。匹配的形状仍然不能说明
它携带了哪个取值。边界对是关于时间的同类陈述——回执显示测试装置处于两个时刻且结束方式
不同，但对链上会盖上什么时间戳不作断言。当前场景还驱动了修正后的注册器取消路径：
`cancelPlatformRegistrar` 在配置的时间锁完成，并发出 32 字节的
`PlatformRegistrarCancelled` 事件。此前的 34 字节事件名是合约缺陷；在当前工件与场景中
已不复存在。

第 35 号门禁是携带第三个文件的那一轮运行。它快照了 121 个工具文件，运行 26 个作业且无一
返回非零，并返回 `NO-GO`，`fullUnprovedCount 100`，四项义务全部未闭合。插件面读到 62 帧
全部逐字节一致，62 次全部落在声明的区块时间与签名者上，52 次停机与 10 次故障均符合声明
原因，16 条读取链接全部成立，四个插件按声明的签名者从声明的字节部署到声明的地址，十个
步骤落在插件上，十六个突变全部被捕获（`bced9fbd…`）。在它之前存在的两个面都改动了回执
哈希——`7b58876f…` 与 `33093cac…`——而第一个场景自身的 sha256 仍为 `ecd68d8e…`，派发面
（`24aac44d…`）与足迹面（`48556e2a…`）完全没有移动。

第 36 号门禁是携带第四个文件的那一轮运行。它快照 128 个工具文件（比第 35 号门禁多出第四个
场景与六个工件），运行 27 个作业且无一非零，注册器面读到 82 帧全部逐字节一致，82 次全部
落在声明的时刻与签名者上，65 次停机与 17 次故障符合声明原因，10 条读取链接全部成立，
六个模块按声明的签名者从声明的字节部署到声明的地址，十六个步骤落在其中一个上，十六个
突变全部被捕获（`c2ad13ef…`）。其他一切都没有移动：第一个场景的回执仍是 `7b58876f…`，
时间窗面为 `33093cac…`，插件面为 `bced9fbd…`，派发面为 `24aac44d…`，足迹面为
`48556e2a…`——这正是三个旧文件旁边新增一个文件时应有的样子，也正是账户字节发生变化时
不可能呈现的样子。它仍然返回 `NO-GO`：`fullUnprovedCount 100`、`verifiedEntrypoints []`、
四项义务全部未闭合。

2026-11-16 修订：四个场景文件重新基于重建后的核心工件（部署账户
`0x4560a7a7346fad0826fb5d5ef9fdaff55a0fa294`），注册器文件现在部署
AAPlatformRegistrar 服务合约本身而不是已删除的 mock，并且 2026-11-13 安全整改改变了源码的
四个调用方／插件工件已重建并重新固定。重测的各面——29、53、62 与 84 帧，全部一致——记录在
闭合门禁文档的当日修订中；上面的门禁运行段落保留为其所描述运行的原始记录。


## 为什么更多方法体证明无法推动 `fullyClosed`

`entrypoint_coverage` 对当前构建报告 `fullyClosed: 0`，并在自己的注记中说明：方法体级精化
是一个严格子作用域，而每个已精化的入口仍然背负 ApplicationEngine、编译器对应关系、gas、
异常与交易组合等义务。因此增加方法体——这个诱人的下一步，也正是本文档各表所讨论的内容
——只会抬高 `bodyLevelRefined`，而让 `fullyClosed` 保持为零。真正需要移动的那个数字由闭合
结果中四项未闭合义务决定，而不是由精化了多少入口方法体决定。

于是剩下两条自洽的路线，它们主张的内容并不相同：

- **路线 A（信任源码）。** 增加一个经过验证的 C#→NEF 前端，使
  `SOURCE_FRONTEND_AND_COMPILER_CORRESPONDENCE` 得以闭合，然后精化 ApplicationEngine 派发
  以及 gas／异常／交易层。这就是今天 `implementationVerified` 的含义，而它是研究级工作量：
  为编译器接受的那部分 C# 给出语义，再加上代码生成。
- **路线 B（信任字节码）。** 从主张中剔除编译器义务，改为针对全部 109 个入口点，从 NEF
  字节与经复核的 debug 映射出发证明精化。现有泳道已经按这种方式工作——它们解码固定的
  script，从不信任源码来获得语义——因此这条路靠重复推进而不是靠新理论。它对源码给出的是
  一个**更弱**的陈述（字节码匹配某份规范；从 C# 到这些字节的映射被假定），而对工件给出的
  是一个更强的陈述。

两条路线都不是当前证据可以取巧跳过的，而切换到路线 B 改变了证书所断言的内容，因此
`SA-FORMAL-VERIFICATION.md` 中的边界文字与本门禁的 `boundary` 字符串必须随之移动。在这个
决定被记录下来之前，无论再增加多少方法体工作，诚实的状态都停在 `NO-GO` 与
`fullyClosed: 0`。

### 十四个只读条目并不是廉价的胜利

用存储 getter 泳道自己的固定模型（`storage_getter_proofs.render_vm_program`，并准入固定的
`StdLib.deserialize` token）渲染每个剩余的只读区域，十四个全部失败关闭，而失败的原因比
结论本身更重要：

- 有五个调用多于一个 helper，停在 `CALL/CALL_L target N is not the
  pinned shared callee`：`isOwnerOnlyRecovery` 调用三个（`GetAccountState`
  `3471`、`HasOwnerOnlyRecovery` `3603`、`ValidateAccountId` `6155`）；
  `isAccountFrozen`（`HasAccountFrozen` `3654`、`ValidateAccountId`）、
  `isMarketEscrowActive`（`GetMarketEscrowContract` `3764`、
  `GetMarketEscrowListingId` `3830`）、`getNonce`（`ValidateAccountId`、
  `IsUnsignedIntegerWithinBytes` `14377`）与 `isValidSignature`
  （`ModuleExposesSafeMethod` `1756`、`GetAccountState`）各调用两个。该泳道对每个 getter
  只绑定一个共享被调用者，因此它们需要多被调用者组合才能写下任何证明——这是结构扩展，
  不是再加一行表格。
- `isModuleInstalled` 与多被调用者的 `isValidSignature` 还会读取
  `LDARG2`/`LDARG1`，超出固定的单操作数被调用者参数绑定，因此该绑定必须与组合工作一起
  放宽。
- `getPendingVerifierUpdate`、`getPendingHookUpdate` 与
  `getPlatformAccountBinding` 因 `INITSLOT` 形状超出固定的帧布局而失败——这是帧形状扩展，
  不是新语义。
- `isUserOpExecutionActive` 发出了一对固定 GetContext/StorageGet 之外的系统调用；
  `getProxyScriptHash` 调用 CryptoLib 的 `sha256` token，而该泳道只固定了
  `StdLib.deserialize` 的 token 身份。各需要再固定一个外部身份，而不是新模型。
- `isMarketService` 因 `PUSHT` 失败，固定模型不渲染它。
- `getAccountImplementationId` 是一个三条指令的跳转 thunk，自身没有 `INITSLOT`；它的方法体
  属于公开纯方法泳道。
- `getAccountIdByProxy` 因 `Expected exactly one cast width witness` 失败：其可空
  `UInt160` 读取同时带有 `DUP / ISNULL / SIZE / JMPEQ / THROW` 守卫与类型转换，因此
  `direct` 族的单见证假设覆盖不了它。它还需要内联的键拼接，以及容忍一个前置的
  `ExecutionEngine.Assert`。

因此这些只读条目是：一次多被调用者扩展、一次被调用者参数放宽、两个额外固定的外部身份，以及
若干帧／类型转换见证形状，而不是十四个彼此独立的一行改动。任何安排这项工作的计划，都应
把泳道工作排在前面，把入口工作排在后面。

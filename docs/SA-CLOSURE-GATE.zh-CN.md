# 集成的精化闭合门禁

> 中文版本与 `docs/SA-CLOSURE-GATE.md` 同构。若两者冲突，以英文版本为准。

这是对已限界证明的一次全新编排与身份连接。它不会仅因为若干内核接受了各自的模型，就认证完整的
协议闭合。所有公开入口都保留未闭合的运行时／前端／组合义务；方法体证书与私有 helper 证书保持
彼此独立。

默认命令用现有的四泳道校验器构建一份新清单，然后运行额外的限界证明器及其负向对照。当前门禁
选择二十二个独立作用域。缺失回执、错误作用域、混用的 NEF／helper 身份、源码／模型漂移以及
不完整的对照都会失败关闭。独立的证明泳道同时最多运行两个。每次调用都保留其命令、日志与回执。

```sh
python3 formal/refinement/closure.py \
  --output-dir /tmp/aa-integrated-closure-fresh \
  --timeout-seconds 5400 \
  --helper-gas-runtime-receipts /path/to/reviewed-five-shape-receipts
```

退出码 `2` 表示所选限界检查全部通过，但完整实现精化仍然是 `NO-GO`。退出码 `1` 表示某项所选检查
失败、证据缺失或身份漂移。`--allow-partial` 把退出码 `2` 变成 `0`，同时保留 `status:NO-GO`、
`implementationVerified:false`、空的 `verifiedEntrypoints` 以及完整的公开入口点未证明计数。它
从不会放松任何一项所选证明、身份连接或负向对照。

上述预算按共享宿主而非高性能宿主设定。`context_proofs.py` 与 `composition_proofs.py` 中的内核
上限各是一个模块常量（`KERNEL_TIMEOUT = 3600`）；旧值分别为 1800 与 600，而在 2026-10-20，
一次负载均值 136 的运行在 `context` 于 1800.08 秒、`composition` 于 649.7 秒处失败，此时还没有
任何一项限界检查给出不同意见。在通过的那次运行中，这两个作业分别耗时 2292 秒与 1198 秒。此处
的超时是失败关闭的环境故障——它从来不是关于合约的证据，而提高上限也不会削弱检查，因为内核
仍然必须接受该证明。

每次成功运行还会在 `result.json` 中发布一个 `frontendCorrespondence` 块。它从泳道刚刚下载的
固定 C# 源码（位于 `*/source` 下）重新计算，把共享的 tokenizer 与 body slicer 与一个不共享任何
代码的第二读取器相比较：归一化文本、token 序列与逐方法方法体。一致并不主张该文法已被证明，也
不推动 `implementationVerified`——它测量一个语料并为它命名。不一致会使本次运行失败，空语料会
被拒绝而不是上报为一致。第五个面把同一语料与导出器已经携带的 Microsoft C# 词法分析器比较：
整文件连接可能不同（会被记录，并附偏移），但泳道定位到的每一个片段都必须通过词法器的视野，而
一份没有词法面的回执等同于完全没有一致。第六个面评判这个评判者：一个严格读取器——插值空洞
读作单个 token、`#if` 条件被求值而不是丢弃——必须在每个文件上复现词法器的连接，之后才允许
记录整文件分歧；任何唯一锚点都不得在它下面移动；前端出现差异的文件集合是一个冻结常量
（`KNOWN_FRONT_END_GAPS`），这样新缺陷无法悄悄到来，而修复后的缺陷必须被有意退役。该列表现在
是**空的**：各泳道共享一个扫描器而不是每个模块一个正则表达式，因此插值空洞按编译器的方式读取，
前端在语料中的每个文件上都复现词法器。落在某个泳道从中切出方法体的文件上的分歧会直接使运行
失败：方法体正是读取字段的来源，而 `slicedGaps` 从泳道模块重新计算，而不是凭记忆保留。第七个面
去掉了锚点面所需的十字符下限：字段用 `needle in text` 或 `text.count(needle) == 1` 读取，而
needle 常常比十字符更短，因此泳道模块投影函数中每一个非空字面量都会被交给两个读取器——以相同
方式接受、以相同方式连接，并在每个语料文件中被找到相同的次数。空的 needle 面会被拒绝，而不是
上报为一致。见 `SA-FRONTEND-CORRESPONDENCE.md`。

同一次运行还会发布一个 `abiDispatch` 块，它关于字节而非文本。导出器的第二种模式把固定的 NEF
部署进真实的 `ApplicationEngine`——Neo 3.9.1，即编译器自带的程序集——按 manifest 声明的参数个
数逐个以名称调用每个 ABI 方法，并对该调用单步执行。回执按方法记录引擎进入的偏移、声明的入口点
是否被执行、最终状态与故障、系统调用序列，以及调用留在栈上的值的形状。门禁要求全部 109 个条目
都对照清单所信任的同一份 manifest 测量；其中 107 个派发到其声明的偏移；`_deploy` 与
`_initialize` 按名调用时被拒绝；每个已完成的调用都对照声明的返回类型判定——一个属于映射后栈类型
的结果，`Hash160`/`Hash256`/`PublicKey`/`Signature` 还要有精确宽度，且故障不留下任何残留。null
返回值满足声明的引用类型并单独计数，因为 manifest 没有可空性信息，而 null 不适用任何规则；
在声明为值类型的位置出现 null 则是失败。每次运行都必须捕获对 dump 的十种突变，因此零问题的回执
不可能来自一个什么都不比较的面；引擎错误、触及步数上限、无法解析的系统调用、形状错误的结果，
或绑定到另一份 manifest 的 dump，都会使运行失败。

该块还携带派发规则的另一半：408 个针对 manifest 未描述调用的探测，门禁要求这个探测**集合**正是
manifest 所蕴含的那一个——每个方法的参数个数减一与加一、减去同级重载已声明的个数、为每个非
`Any` 首参数加一个形状探测、再加一个未声明的名字。缺失、重复或重新标注的探测都会失败。每个
元数探测都必须以引擎自己的消息被拒绝（`Method "…" with N parameter(s) doesn't exist in the
contract`），并且完全没有进入任何被调用者帧；`finalizeEscape` 声明的两个参数个数必须落在两个不同
的偏移上，这正是使“名称加元数选择”成为测量的原因；拒绝消息来自被调用者而非边界时失败。形状
错误的参数是门禁**不**要求被拒绝的唯一一项，因为它确实没有被拒绝：在该引擎上 94 个进入被调用者，
87 个在其中失败、7 个成功返回，因此回执携带 `shapeEnforcedAtBoundary: false`，门禁把它读作一次
测量，而不是因为引擎从未拥有的规则去判一个正确工件失败。每次运行都必须捕获探测的七种突变。

它还会发布一个 `dispatchFootprint` 块，这是派发之下的那一层。落在正确偏移上并不能说明那里运行的
方法体，因此同一份 dump 现在按方法携带引擎在合约内部执行过的指令偏移集合、script 字节，以及每个
帧深度的 script 哈希。第二个读取器用仓库自己的独立解码器解码这些字节，并把结果与
`entrypoint_inventory` 的静态模型对照：已执行偏移必须是该 script 的指令起点；其中每一个都必须
恰好落在一个划分了 script 的清单字节区间内；实际进入的字节方法必须属于该入口依赖图可达的那些。
最后一条是必须成立的方向。可达性是一个 may 集合，因此它列出而零参数调用从未进入的成员会被计数
并打印——在本工件上是 996 个中的 634 个——并且从不被读作分歧。每次运行都必须在测量与模型两侧
捕获八种突变；无法构造的突变记为 skipped 并使运行失败，而不是缩小自检。该面不比较任何取值，
因此它对 67 个在零参数下故障的方法一无所知。

`abiScenario` 块是再下一层，也是目前唯一发送真实取值的一层。
`formal/refinement/scenarios/aa-account-roundtrip.json` 声明 29 次调用——字面参数、具名签名者、
每次调用期望的结束方式，以及某个结果必须等于的先前参数——导出器在一次部署上按序运行它们。门禁
要求：场景的 sha256 与部署地址必须是回执中的那些；全部 29 帧必须与此处按操作码表编写的编码器
逐字节一致；全部 29 次调用都按场景所述结束；四个预期故障都携带声明的原因；每个停机调用都有形状
判定；每个声明的整数、布尔与数组长度都匹配；全部五条读取链接逐字节成立；没有任何步骤读取一个
已故障的调用。必须捕获场景与 dump 两侧的十一种突变。非空性下限——至少一次停机、至少一次故障、
多于一个方法、至少一条读取链接、每次停机一次形状检查——使空场景或单调用场景无法通过与真实场景
相同的检查。

第二个块 `abiScenarioWindows` 用相同的检查运行
`formal/refinement/scenarios/aa-account-windows.json`。它存在的原因是：本合约中的每一处延时都是
与 `Runtime.Time` 的比较，而单一声明的区块时间只能触及每个比较的拒绝侧。该文件的每一步都声明其
运行的区块时间——九个不同时刻，分别放在边界前一毫秒与恰好在边界上——并且文件中包含四对相同调用、
相同参数、两个时刻、不同结束的调用。因此门禁为它再加一条规则：当一个场景声明多于一个区块时间时，
它必须包含至少一个结束取决于其运行时刻的调用。一个被声明却未被测量的维度，否则就会被回执计为
已覆盖。两个场景是彼此独立的要求——一个文件的通过不能代替另一个——各自携带自己的非空性下限与
自己的 13 种突变，其中两种是此处新增的：一次在另一时刻运行的调用，以及一次由另一账户签名的调用。

第三个块 `abiScenarioPlugins` 用相同检查加一条额外检查运行
`formal/refinement/scenarios/aa-account-plugins.json`。它存在的原因是：此处的限制是结构性的而非
时间性的：没有验证器，验证器方法体就无法运行，而 `AssertV3Verifier` 读取的是**已部署合约的
manifest** 而不是源码文件。前两个文件中没有任何东西能到达 `AssertV3Verifier`、`callVerifier`、
`callHook`、`isModuleInstalled` 或任何待定模块 getter，因为要到达它们，同一引擎中必须存在一个插件
合约。该文件声明四个插件——同一个验证器字节的两份副本，部署签名者不同，加上两个不同的 hook——
门禁增加一个模块问题：对每个声明的插件，引擎部署的地址必须等于声明的地址；它部署的字节必须哈希
到场景所指的文件（从快照读取，而不是从 dump 中取）；部署签名者必须匹配，因为已部署合约的地址是
NEF、manifest 名称**与**签名者的函数，三者中两者相符而第三者不符等于什么也没说。dump 报告而
场景未声明的插件会失败，其地址、字节或签名者发生移动的插件也会失败。针对插件的步骤要对照**该
插件自己的** manifest 测量——`authorizedCore` 的声明返回类型属于验证器的 ABI，从账户的 manifest
中读它就是在断言错误的工件。该文件的非空性下限要求至少有一个步骤落在插件上，并且存在多于一个
不同目标，因此一个声明了工件却在那里什么也没测量的文件无法通过。

那些工件是带有记录推导过程的固定输入，不是证明。`formal/refinement/plugins/provenance.json` 指明
编译器（`nccs 3.9.1`，因为 NEF 头部写明了它，且其代码生成决定字节）、每个项目文件、喂给它的
每个源码文件，以及全部十二个工件的 sha256；`formal/refinement/plugins/build-plugins.sh` 是记录的
构建步骤，若重建结果与这些哈希不符则以非零退出。这与 `contracts/bin/public` 对主合约的既有地位完全
相同，并不是在主张这些插件正确。

第四个块 `abiScenarioRegistrar` 用相同检查运行
`formal/refinement/scenarios/aa-account-registrar.json`。它的理由既不是时间也不是准入，而是
**谁在调用**：平台注册通道把 `Runtime.CallingScriptHash` 与账户记录的注册器比较，市场托管则与
市场比较，因此任何针对账户的步骤都无法运行其中任何一个。该文件安装另一方——SAPlatformRegistrar
服务合约本身，通过它自己的 `setAuthorizedCore` 指回账户并作为自己的 admin 驱动；一个持有全权
许可的转发器，使市场自身的 cancel 与 settle 能以合约身份到达；以及一个 paymaster——并且模块问题
被应用到它部署的全部六个工件，包括三个调用方，因为关于谁调用了账户的主张就是关于工件的主张。
同样的非空性下限适用，因此一个声明了调用方却从未通过其中任何一个调用的文件无法通过。

该文件驱动的条目录中，有六个在账户内部执行而没有步骤落在它们上面：两处平台注册、平台 owner 轮换
应用，以及三次托管迁移，它们通过调用方到达，并由其改变的状态作证——一个通过其代理索引解析的
账户 id、一个已移动到轮换新 owner 的备份 owner、一个先存在而后被清除的挂单 id。回执把这些与由
步骤按名调用的条目分开计数，下面的数字指明了哪些是哪些。十四个条目声明为未到达，不计入覆盖：
`_deploy/2` 与 `_initialize/0`——`System.Contract.Call` 因其名字以下划线开头而拒绝调用（本次运行
记录宿主自己的消息）——以及十二个没有任何场景步骤驱动的运维条目：冻结生命周期
（`freezeAccount/1`、`unfreezeAccount/1`、`isAccountFrozen/1`）、依赖写入者
（`setHookDependencies/2`、`setVerifierDependencies/2`、`clearVerifierDependencies/1`）、子 hook
转发器 `callHookChild/4`、模拟读取 `simulateValidation/2`，以及读取 `describeAccount/1`、
`getPlatformAccountBinding/1`、`isMarketService/1` 与 `isUserOpExecutionActive/0`。

`cancelPlatformRegistrar` 在当前工件中是一次成功的对照。该调用等待其时间锁，删除待定注册器状态，
并发出 32 字节的 `PlatformRegistrarCancelled` 事件。此前的 34 字节事件名已被纠正；场景现在要求
`HALT`，而不是固定一个宿主故障。


三个返回面随后被连接起来而不是分别阅读：派发面所练习的类型与各场景面所练习的类型的并集，必须
覆盖每一个声明返回类型。在固定的工件上，仅派发面就会留下 `Any` 与 `Array` 未覆盖，因为声明它们
的每个方法在零参数下都会故障；第一个场景到达两者，第二个以真实参数而非零长度到达 `ByteArray`，
而 `returnTypesUnexercised` 只有作为那个并集才为空。没有任何面自己的列表是空的，这正是要点：
一个面的缺口不会被另一个面的成功掩盖。

当前工件于 2026-11-17 在没有公开网络的情况下重测。其派发面读到 109/109 个方法、107 个进入偏移、
两个保留名被拒绝、42 个已完成返回形状匹配、67 次零参数故障、408 个边界探测（202/202 元数拒绝、
两个重载探测落在其声明同级上、94 个类型探测中 87 个在被调用者内部故障、7 个成功返回），并且全部
十七项自检都拒绝了。其足迹面读到 30,678 字节、10,594 条指令、238 个区间、996 方法闭包内 362 个
已进入的字节方法、634 个可达但未进入，未知、无主、闭包外或缺失入口的偏移均为零。外部 script 的
偏移与本合约的足迹分开计数；回执记录了 887 个这样的偏移，并且不把它们当作本合约拥有指令。四个
场景文件合计读到 228 次调用、186 次停机、42 个预期故障、38 条读取链接、十个已部署模块工件、28 个
模块步骤、24 个区块时间与 14 个时间敏感对。这些测量使 `fullUnprovedCount` 保持 109、
`implementationVerified` 保持 false。四个对应场景回执哈希为 `081104cc…`（roundtrip）、
`76814f19…`（windows）、`20660340…`（plugins）与 `be1ec7b9…`（registrar）。派发与足迹回执哈希
为 `f75e1226…` 与 `20833d64…`。

本次修订的最终集成运行记录在
[`sa-closure-gate-20261117.json`](reports/sa-closure-gate-20261117.json)。它选择了二十二个作用域，
快照了 130 个工具文件、263 个输入哈希、129 个项目输入哈希与 24 个原始回执哈希，执行了 27 条命令
记录，无非零退出且无超时。结果仍为 `NO-GO`，`selectedScopeStatus: PASS`、
`fullUnprovedCount: 109`、`verifiedEntrypoints: []`、`fullImplementationVerified: false`；当前
入口点划分为 0 个完全闭合、34 个方法体级精化、75 个仅派发级。结果、命令与快照哈希分别为
`d68e2ce1…`、`310d48f7…` 与 `a60cdca7…`。这是当前的闭合状态；第 33–37 号门禁中的
`fullUnprovedCount: 100` 值是历史快照，不得读作本次修订的计数。

携带这些数字的那次运行是第 33 号门禁。它快照了 112 个工具文件，运行 24 个命令作业，无一非零
或超时，并返回 `NO-GO`——`selectedScopeStatus PASS`、`fullUnprovedCount 100`、
`verifiedEntrypoints []`、`fullImplementationVerified false`，同样四项义务未闭合。在该回执中，
派发面读到 `returnsChecked 39`、`returnsMatch 39`、`nullReturns 0`、`resultTypeMismatch 0`、
`declaredTypesUnexercised ['Any','Array']`，十种突变全部被捕获（`24aac44d…`）；场景面读到 30/30
帧、26 次停机、4 个预期故障、`declaredReturnChecked 26`、`Matched 23`、`Null 3`、
`Mismatch 0`、`linksChecked 5 == linksMatched 5`、`linksToFaultedStep 0`、
`distinctMethods 27`、`declaredTypesUnexercised ['ByteArray']`，十一种突变全部被捕获
（`1b757ffe…`）；足迹面的回执哈希在相邻两次运行中都保持 `48556e2a…`，这正是那两个面共享的
重构没有触及它的证据。

第 34 号门禁加入第二个场景。它快照了 113 个工具文件，运行 25 个命令作业，无一非零或超时，并返回
同样的 `NO-GO`，同样四项义务未闭合。`abiScenarioWindows` 读到 53/53 帧逐字节一致、53/53 落在
其声明的区块时间与签名者上、42 次停机与 11 次故障均符合声明原因、
`declaredReturnChecked 42 == Matched 42` 且 `Null 0`、`Mismatch 0`、
`linksChecked 6 == linksMatched 6`、`linksToFaultedStep 0`、`distinctMethods 33`、
`distinctTimestamps 9`，在名为 `confirm-admin-transfer`、`initiate-escape`、`finalize-escape`
与 `finalize-to-owner-batch` 的步骤上有 `timeSensitivePairs 4`，十三种突变全部被捕获
（`1411ecce…`）。同一份回执中有三个事实比计数更有价值：第一个场景的**场景 sha 未变**，仍为
`ecd68d8e…`，而其回执哈希移动到 `4593d9c5…`（面增加了两个问题，输入没有移动）；派发面的回执
哈希完全没有移动（`24aac44d…`）；足迹面的同样没有移动（`48556e2a…`）。每个场景自己的
`declaredTypesUnexercised` 仍非空——第一个为 `['ByteArray']`，第二个为 `['Any','Array']`——
而正是三个面的并集覆盖了全部八种声明返回类型。

关于第 34 号门禁首次尝试的一点说明，因为它是记录的一部分：它退出码为 1 而不是 2。`context` 泳道
在每子进程上限处被杀——1800 秒，即默认值，而该 Coq 泳道在本宿主的负载下会超出它，在第 33 号门禁
中已耗时 37 分钟。那是设得过低的资源上限，不是失败的证明；门禁在到达 ABI 各面之前就停止了，因此
新层在门禁内仍未被测量。以 `--timeout-seconds 5400` 重跑产出了上面的回执。没有任何证明为了得到
它而被放松。

关于第 35 号门禁首次尝试的一点说明，原因相同。它同样退出码 1 而不是 2，原因也再次出在编排而不是
证明：全部 21 个命令作业都以退出码 0 完成且无超时，插件场景的 dump 已经在磁盘上，含 62 个步骤、
四个模块，以及正确的地址与工件哈希。失败来自一项新检查：快照中的插件字节必须是回执所指的字节。
回执按场景声明的路径记录每个工件——`../plugins/X.nef`——而该路径相对于**场景文件自己的目录**，
导出器与该面都是这样读的。该检查却按包根解析它，去找
`snapshot/formal/refinement/../plugins/X.nef`，并抛出 `FileNotFoundError`。修正为按场景目录解析，
并且修正是对照第 35 号门禁自己的快照而不是源码树验证的：八个工件全部存在、八个哈希全部匹配、
该面仍然一致、十六种突变全部被捕获。该检查是被加宽而不是放松——它现在既校验每个插件的 NEF 也
校验其 manifest，并在哈希之前断言文件存在。没有任何证明为了得到它而被放松。

第 35 号门禁的第二次尝试被手动放弃，而不是任其失败。开始两分钟后，为上述路径规则补了一个回归
测试——这意味着门禁的结束漂移检查（把每个原始输入与开始时取的快照重新哈希）会在一小时后报告
`original input drift`，并丢掉整次运行。运行被停止，测试跑到全绿（188），源码被冻结，然后才再次
启动门禁。由此留下的规则是：先加测试，再启动门禁。

第三次尝试通过，随后又跑了第四次，以使回执证明的是实际交付的代码树。两次之间，docstring 中的一个
词被修正了：`abi_scenario.py` 说它的自检有十五种突变，而实际有十六种。这次编辑可以证明是惰性的
——用编辑后的源码对第三次尝试自己的 dump 重新计算三个场景面，逐字节复现了 `7b58876f…`、
`33093cac…` 与 `bced9fbd…`，十六种突变仍全部被捕获——但代码树已不再匹配第三次尝试所取的快照，
而一份证明着没人发布的代码树的回执，价值低于一份证明着实际发布内容的回执。因此代码树被冻结在
`5488c3b8…` 并再次运行门禁。五个回执哈希全部回来完全相同，26 个作业再次全部以零退出，源码树现在
与门禁快照逐文件一致。本节报告的数字来自那次最终运行。

第 35 号门禁加入第三个场景。它快照了 121 个工具文件，运行 26 个命令作业，无一非零或超时，并返回
同样的 `NO-GO`，同样四项义务未闭合且 `fullUnprovedCount 100`。（两个计数分别从 `snapshot.json`
与 `result.json` 读出：快照总数包含合约 NEF 与 manifest、`CustomSponsorship.v` 以及五份 helper
gas 运行时回执，其中 113 个位于 `formal/refinement` 下；作业数是 `commands` 块，它比
`commands.json` 大五，因为该文件只记录被捕获的泳道。弄错任一个都会误报本次运行覆盖了什么。）
`abiScenarioPlugins` 读到 62/62 帧逐字节一致、62/62 落在其声明的区块时间与签名者上、52 次停机与
10 次故障符合声明原因、`declaredReturnChecked 52 == Matched 52` 且 `Null 0`、`Mismatch 0`、
`linksChecked 16 == linksMatched 16`、`linksToFaultedStep 0`、`distinctMethods 27`、
`distinctTargets 5`、`distinctTimestamps 9`、`timeSensitivePairs 5`，且模块问题成立：声明四个插件、
部署四个、四个地址匹配、八个工件哈希匹配（每个插件的 NEF 与其 manifest）、四个签名者匹配、十个
步骤落在插件上，十六种突变全部被捕获（`bced9fbd…`）。在它之前存在的两份场景回执都移动了——
`abiScenario` 到 `7b58876f…`、`abiScenarioWindows` 到 `33093cac…`——因为该面增加了一个问题与一种
突变，而第一个场景的**场景 sha 仍未变**，为 `ecd68d8e…`，这正是输入没有移动的证据。派发面的回执
哈希完全没有移动（`24aac44d…`），足迹面的也没有（`48556e2a…`）。当时存在的四个面的并集覆盖了全部
八种声明返回类型，而每个面都保留了自己非空的缺口：派发面 `['Any','Array']`、第一个场景
`['ByteArray']`、第二个 `['Any','Array']`、第三个 `['String']`。现在有五个面，第四个场景把
`['Array','String']` 加入该列表——并集仍然覆盖全部八种类型，每个面仍然各有各的缺口，这正是要求
并集而不是要求任何一个面的列表的意义。

第 36 号门禁加入第四个场景。它快照了 128 个工具文件——第 35 号门禁看到的 121 个，加上新场景文件
与三个调用方侧插件的六个工件——并运行 27 个命令作业，无一非零、无一超时。结论不变：`NO-GO`、
`selectedScopeStatus PASS`、二十二个作用域、`abiEntryCount 100`、`fullUnprovedCount 100`、
`verifiedEntrypoints []`、`fullImplementationVerified false`。所有已存在的回执也不变：
`abiScenario 7b58876f…`、`abiScenarioWindows 33093cac…`、`abiScenarioPlugins bced9fbd…`、
`abiDispatch 24aac44d…` 与 `dispatchFootprint 48556e2a…` 都与第 35 号门禁返回的逐字节相同，
我们由此知道新增场景没有触碰它未选中的任何内容。只有新面移动：`abiScenarioRegistrar` 读到
`c2ad13ef…`，来自 82/82 帧逐字节一致、82/82 落在其声明的区块时间与签名者上、65 次停机与 17 次
故障全部携带声明原因、65 个声明返回匹配且无 null 无错配、`linksChecked 10 == linksMatched 10`、
`linksToFaultedStep 0`、`distinctMethods 44`、`distinctTargets 6`，声明六个模块、部署六个、六个
地址匹配、十二个工件哈希匹配、六个签名者匹配、16 个步骤落在模块上、`distinctTimestamps 5`、
`timeSensitivePairs 5`、十六种突变全部被捕获、`problems []`。四个文件合计为 227 次声明调用
（30 + 53 + 62 + 82）、42 个声明故障、38 条读取链接成立、十次模块部署与 19 个不同区块时间——
那是并集而不是求和：两个文件复用了同一个边界时刻。

那次运行花了三次尝试，而前两次不是代码失败。第一次返回 `GATE36_EXIT=1` 并给出
`one or more fresh proof/control subprocesses failed`；八个取源码泳道中有七个死于
`Tunnel connection failed: 502 Bad Gateway`，一个死于 `read operation timed out`。代码树中
没有任何错误——只是从这里无法到达上游主机。修正方法是把每个泳道的 `AA_*_SOURCE_MIRROR` 指向
第 35 号门禁已经捕获在 `/tmp/gate35d/<lane>/source` 下的字节。镜像不是豁免：每个被镜像的文件
仍然必须哈希到泳道声明的同一固定值，运行在接受文件之前仍会重新计算每个哈希。提供镜像后，
第二次尝试返回 `GATE36B_EXIT=2`、`NO-GO` 且 `PASS`，27 个作业全零。

第 37 号门禁是携带第六个问题的那次运行。没有选中任何新内容——探测代码位于 `AbiDispatch.cs` 与
`abi_dispatch.py`，两者都已在快照中——因此快照仍是 128 个文件，作业数仍是 27，结论仍是同样的
`NO-GO` 且 `PASS`、`fullUnprovedCount 100`、`verifiedEntrypoints []`，四项义务全部未闭合。恰好有
一份回执移动：`abiDispatch` 从 `24aac44d…` 到 `f9429279…`，因为 dump 增加了 `boundary` 块
（schema v3），而该面增加了第六个问题与七种突变。它旁边的一切都保持住了：`dispatchFootprint
48556e2a…`、词法面 `93ad5822…` 以及全部四份场景回执（`7b58876f…`、`33093cac…`、`bced9fbd…`、
`c2ad13ef…`）都与第 36 号门禁返回的逐字节相同。这正是对一项所选测量的改动应有的样子，也正是对
工件的改动所不可能呈现的样子。新面读到 374 个探测，对应 manifest 蕴含的 374 个；100 个对照中
98 个进入其声明偏移、2 个保留名被拒绝；185/185 个元数探测被 `ContractManagement` 拒绝且
`entered: false`；两个 `finalizeEscape` 元数分别落在 8514 与 8526；未声明的名字被拒绝；86/86 个
形状错误的参数被接受——79 个在合约内部失败、7 个成功返回——记录为 `shapeEnforcedAtBoundary:
false`，而不是记为工件失败。`problems []`，十七种突变全部被捕获。此后代码树又对照本次运行自己的
记录重新哈希：128 个工具文件、254 个输入与 120 个项目输入，全部相同，无缺失。

2026-11-16 修订，用本机上的固定导出器测量而非完整门禁运行：四个场景文件重新基于重建后的核心
工件，其部署地址为 `0x4560a7a7346fad0826fb5d5ef9fdaff55a0fa294`——这是重建后的 NEF、manifest
名称与未变部署签名者的纯函数——每一个 script 帧与内嵌字面量都随之移动。roundtrip 文件去掉了
`getPendingPlatformAccountOwnerRotation` 读取（轮换记账移入注册器服务时被移除），现在驱动 29 次
调用。注册器文件部署 SAPlatformRegistrar 服务合约本身以替代已删除的 mock——通过它自己的
`setAuthorizedCore` 指回账户、作为自己的 admin 驱动，并获得强化后的托管所要求的核心
`SetMarketService` 注册——现在运行 84 次调用。2026-11-13 安全整改改变了源码的四个调用方／插件
工件，已用固定编译器从这些源码重建，`provenance.json` 重新固定到新字节，`build-plugins.sh`
逐字节复现全部十二个工件；模块地址随之移动，由模块地址推导的账户 id 也随之移动。重测的各面
全部一致：`abiScenario` 场景 `d5ab5b55…`（29/29 帧）、`abiScenarioWindows` `867d3d07…`（53/53）、
`abiScenarioPlugins` `9d16c9b2…`（62/62，四个模块匹配）、`abiScenarioRegistrar` `960b72eb…`
（84/84，六个模块匹配、十一条读取链接、十八个步骤落在模块上）。本段之上的门禁运行数字——条目计数
与更早的回执固定值——描述的是更早的工件，作为历史记录保留；下一次完整闭合运行会重新推导它们。

那次运行之后记录了两件事，两者都没有改变任何被测量的字节。本文件与两篇姊妹文档中的叙述文字均从
上面的回执重写，而在信任其中任何内容之前，代码树又对照门禁自己的记录重新哈希：全部 128 个工具
快照文件、全部 254 个输入文件与全部 120 个项目输入文件都回来与 `result.json` 中的值相同，无缺失、
无错配。因此该运行证明的是交付的代码树而不是更早的一个，而重跑只能表明它可以复现——重新哈希显示
的是更强的东西：回执说的就是这些字节。这些叙述文件被有意排除在全部三个集合之外——泳道中没有任何
东西读取 `.md`——这就是为什么重写不可能移动回执，也是为什么这项检查仍被执行而不是被假定。值得与
“先加测试”一起记录的教训是：一个会访问网络的门禁可能因与代码无关的原因失败，而诚实的回应是让
网络变得无关，而不是放松检查。

工具首先快照被调用泳道的 Python 导入／字面资源、导出器源项目成员（排除生成的 `bin/obj` 文件）、
被引用的 Coq 模型、固定样例以及被导入的 `CustomSponsorship.v`。对每个被捕获的输入，一次读取
同时提供哈希与复制的可执行字节。复制的验证器与复制的证明器从这个快照运行。源码根与生产
NEF／manifest 保持为当前仓库输入；新建的导出器记录与严格验证器检查它们的精确哈希。工具在写出
成功的限界结果之前，会重复源码成员、清单／回执字节以及原始／复制工具与模型两侧的检查。未被选中的
无关证明泳道文件不会改变这个依赖集合。被选中的动态加载器必须暴露字面依赖名，或在门禁中添加显式
声明；不支持隐式未声明的动态代码。证据输出必须是 `formal/refinement` 之外的新目录或空目录。

基础验证器提供算术、数值、预留与整 helper 的正向证明。数值与整 helper 对照在基础命令中运行；
算术对照通过现有捕获的 Python API 运行；预留对照单独运行，因为其 CLI 返回仅含对照的回执。两份
仅含对照的回执都不会被表现为额外的内核定理。后续泳道为：

| 泳道 | 接受的作用域 | 必需的依赖 |
| --- | --- | --- |
| Context | `complete-helper-context-and-initializer-reference-refinement` | 同一份全新 NEF／script、initializer 与完整的 helper／调用方上下文证书 |
| Initializer 源码 | `source-to-complete-initializer-reference-refinement` | 同一 initializer、源码投影、字段计数与捕获的模型 |
| 组合 | `caller-ledger-composition` | 精确的全新 helper 证书与方法哈希 |
| 公开纯方法 | `public-pure-reference-refinement` | 精确的全新 ABI 描述符、完整方法字节与类型化投影 |
| 公开安全入口帧 | `custom-safe-public-abi-entry-frame-source-bridge` | 完全相同的三个公开纯方法描述符与 initializer；固定的普通 Core／VM 源码、严格源码投影与全新证书 |
| 系统调用准入桥 | `system-contract-call-and-callt-admission-bridge` | 固定的 neo `System.Contract.Call` 注册与 `CallContract`/`OnCallT`/`OnSysCall` 源码、推导出的准入记录与全新证书；只交接给 `CallContractInternal` |
| 合约内部交接 | `contract-internal-handoff-and-frame-construction` | 固定的 neo `CallContractInternal`/`LoadContract`/`LoadScript`/`GetMethod`/`CanCall`/`IsBlocked` 与 neo-vm `ExecutionContext.Clone` 源码、推导出的交接记录与全新证书；止于构造出的帧，在被调用者执行之前 |
| interop 转换 | `interop-argument-conversion` | 固定的 neo `OnSysCall`/两个 `Convert` 重载/`InteropParameterDescriptor`/`CallContract` 声明与 neo-vm `ExecutionEngineLimits.MaxStackSize`、推导出的转换记录与全新证书；止于转换后的参数向量，在处理器方法体运行之前 |
| interop 描述符计费 | `interop-descriptor-charge-order` | 固定的 neo `OnSysCall`/`AddFee` 方法体与 `InteropDescriptor` 声明、推导出的计费记录与全新证书；止于参数窗口效应，在任何参数被弹出之前 |
| 异常身份 | `exception-identity-and-catchability` | 六个固定的 neo／neo-vm 声明（指令循环、抛出遍历、两个故障钩子、可捕获类与上限记录）、推导出的暴露记录与全新证书；止于故障状态效应，在指令语义或交易层之前 |
| 加载准入 | `load-time-manifest-and-token-admission` | 五个固定的核心声明（nef、方法 token、manifest、ABI、方法描述符）、推导出的 24 槽声明记录与全新证书；止于加载器返回的值，在部署、gas 或权限判定之前 |
| 私有 hook 视图 | 无（已退役） | v3 的 `private-hook-params-reference-refinement` 泳道为已退役的 `BuildHookOperationParams` 构造器出具证书，而 v4 删除了该构造器。`hook_params_source` 现在只做源码级投影，绑定 v4 的 `BuildCanonicalOperationView`（13 个协议字段按顺序，参数与 hook 证明两处深拷贝）；没有任何 Coq 产物对 `CallHookPreCheck`／`CallHookPostCheck` 建模，也不闭合任何公开入口 |
| 运行时源码桥 | `runtime-instruction-source-bridge` | 固定的 VM 源码提交与源码推导证书 |
| 运行时集合桥 | `runtime-collection-source-bridge` | 固定的 VM 处理器与证书；RET/SIZE/ISTYPE/CONVERT 仍为显式的部分投影 |
| Codec | `ledger-codec` | 捕获的模型与固定的原生源码身份 |
| Gas | `source-derived-add-fee-and-metered-traces` | 固定的 Neo 生产 AddFee 源码与生成的投影 |
| Helper gas | `exact-CFG-parameterized-helper-price-bound` | 同一份全新 NEF／helper、固定的价格表与五份实际运行时 trace 回执 |
| 存储 getter | `storage-getter-source-refinement` | 完全相同的 NEF／script、精确 ABI 描述符与方法体区域、固定的只读 getter 清单、三个共享私有被调用者以及它自己的源码／字节码对照 |

每条泳道都要求正向内核结果与真实的语义对照。定义或源码编译必须成功，之后才允许拒绝对应定理；
超时、进程信号与缺失对照细节都不够。门禁把组合泳道的 `semanticControls` 用作单一对照回执：
摘要记录已编译的定义、每个被拒绝的突变体及其正向内核拒绝退出码。仅有突变体名称列表不构成证据。
真实组合 CLI 回执通过连接所使用的同一个对照校验器测试，包括畸形与不完整的负向对照。门禁检查
模型／输入哈希、生成的证书文件与源码投影字节。它从同一份全新清单独立重新生成 helper、上下文、
initializer 源码、公开纯方法、私有 hook 与安全入口帧的证书数据，并拒绝任何错配。运行时操作码
列表与排除项必须与实际哈希过的源码投影一致；声明必须与生成的证书一致。四个集合部分投影拥有
独立的固定分类法，因此删除一个部分标签不能把它提升为完整操作码证明。共享的官方源码 URL 必须在
各泳道之间携带相同的固定哈希。

安全入口帧泳道从 interop 准入与参数转换之后的 `CallContract` 开始。其源码绑定的参考证书覆盖对
公开纯方法泳道已选中的三个相同描述符的精确名称／元数选择与安全调用帧构造。它不执行 initializer
或公开方法体，也不证明之前的 SYSCALL 标志、费用、转换或弹栈操作。门禁连接原始清单哈希、
NEF／script／manifest 身份、精确 ABI 描述符、方法区间与哈希、initializer 描述符与区间、固定的
Core 与 VM 源码文件、生成的投影与证书字节。它从同一份清单与保存的源码字节独立重新生成该证书；
回执中被复制的标志不能替代这项检查。对照要求已编译的定义与正向内核拒绝退出码，突变体名称唯一，
且没有超时或进程信号。通用 initializer 投影必须等于对 `_initialize/0` 的 ABI 查找；生成的工件
证书为实际 manifest 证明该查找。该泳道编译突变的 Coq 源码投影；它不用 CLR 编译或执行突变的 C#。
门禁要求全部十二个对照、它们各自经内核检查的反例、精确的生成证明文件与命令日志，并从固定源码
重新生成每个突变投影与证书。所需的对照清单还包含一个针对源码循环的通用双参数反向压栈反例。
三个实际选中的描述符有零个或一个参数；该通用对照不会扩大它们的工件作用域。

该泳道清偿的是一项限界准入／帧构造子义务。其受信任的限界源码前端、显式前置条件与剩余义务保留在
集成结果中。该域要求固定派发目标且不覆盖行为、禁用诊断、非干扰的外部操作；仅凭成功的外部调用
不能确立这些条件。它保持 `sourceFrontendVerified:false`、`applicationEngineVerified:false` 与
`vmCorrespondenceProven:false`；全部 109 个 ABI 条目仍缺少完整实现证明。ABI 准入不确立字节码
重定位、initializer 执行／返回、调用方继续执行、gas／资源、故障、交易回滚或完整的源码到运行时
对应关系。

系统调用准入桥恰好覆盖上一段排除的那一层。它固定 neo 的 `System.Contract.Call` 注册与
`OnSysCall`、`CallContract`、`OnCallT` 和 `MethodToken` 源码，从这些声明推导准入记录而不是复述
它，并止于 `CallContractInternal` 的参数元组。门禁持有该记录、处理器参数列表、方法 token 字段、
十三个语义对照以及前置条件／未证明／TCB 文本的自有复核副本，因此某条泳道即使把常量连同自己的
回执和重新生成检查一起削弱，仍然会失败。栈窗口与 `Array` 载荷被保持区分：`CALLT` 交出有序的栈
前缀，而 `System.Contract.Call` 交出转换后的数组。`AddFee`/gas、`Convert`、异常身份、存储已准入
manifest 的部署路径以及 C# 到编译器的对应关系仍然未闭合，该泳道保持
`sourceFrontendVerified:false`、`applicationEngineVerified:false` 与
`vmCorrespondenceProven:false`。

合约内部交接覆盖系统调用泳道**交接给**的那一层：第二个 `CallContractInternal` 重载与
`LoadContract` 构建的帧，包括 initializer 帧。它固定九个声明，从它们推导全部十八个交接字段，并止于
被调用者的第一条指令，因此不闭合任何入口点。门禁持有该记录、二十一个语义对照、四个仅含理由的
守卫以及前置条件／未证明／TCB 文本的自有复核副本。两个顺序被证明而不是被描述：调用计数器在
blocked／未授权门禁**之后**、在元数与返回类型检查**之前**递增；调用方标志的交集同时用请求的标志
与调用方自己的标志约束被调用者字。`AddFee`/gas、资源上限、异常身份、存储与 manifest 读取、
`EvaluationStack`／静态共享与 `LoadScript` 内的 `Dispose` 顺序，以及 C# 到编译器的对应关系仍然
未闭合，该泳道保持 `sourceFrontendVerified:false`、`applicationEngineVerified:false` 与
`vmCorrespondenceProven:false`。

interop 转换覆盖两条泳道之间的那一步：`OnSysCall` 把调用方的栈窗口变成被调用处理器的参数。它固定
四个声明，从它们推导全部十九个转换字段，并止于转换后的参数向量，因此同样不闭合任何入口点。门禁
持有该记录、十八个语义对照、两个仅含理由的守卫、声明的 `CallContract` 参数列表以及前置条件／
未证明／TCB 文本的自有复核副本。关于计数分支有两个被证明而不是被描述的事实：它的长度检查对
`MaxStackSize` 是严格 `>`（上限本身能转换，其后续值故障）；被计数的元素与调用方参数取自同一个
窗口，因此去掉弹栈会把它们留在栈上。`MaxStackSize` 本身从 initializer 表达式求值，而不是复述。
逐类型转换器、处理器方法体、gas、引用计数与 C# 到编译器的对应关系仍然未闭合，该泳道保持
`sourceFrontendVerified:false`、`applicationEngineVerified:false` 与
`vmCorrespondenceProven:false`。

interop 描述符计费覆盖该泳道向后排除的内容：它的前置条件假定价格“已经被收取”，其未闭合列表承认
只记录了窗口内**缺少**加费步骤这一点。该泳道固定 `OnSysCall` 与 `AddFee` 方法体以及
`InteropDescriptor` 声明，从它们推导十五个字段，并止于窗口效应。六条语句的顺序本身就是一个字段，
通过在归一化方法体中排序锚点读出，因此移动一条语句会改变记录而不是悄然通过。被证明的是：被
`ValidateCallFlags` 拒绝的调用分文不付，**因为**标志检查位于计费之前；计费在第一次弹栈之前就固定，
因此转换故障不会退还它；被拒绝的计费不弹出任何东西；白名单上下文跳过费用但不跳过工作；因子恰好
应用一次，因为 `_execFeeFactor` 已携带费用小数位而计费传入 `applyFactor:false`。十六个语义对照，
每个突变体一个，每个恰好移动一个字段。`BigInteger` 宽度上的费用算术、哪些描述符声明零价格、转换
本身以及 C# 到编译器的对应关系仍然未闭合；异常身份移到它自己的作用域，见下文。

异常身份作用域覆盖上述泳道留作布尔值的那种身份：上面每条泳道都把拒绝记录为一个结果标志，因此
没有一条说明哪个异常到达合约、哪个到达宿主，以及二者的差别。该泳道固定六个声明——VM 指令循环、
抛出遍历、两个 `OnFault` 钩子、专用可捕获类以及守护其子句的上限记录——并从它们推导十六个字段。
有两个事实使该记录具有承重作用而非描述性：被守卫处理器所收到的是 `ex.Message`，一个字符串，因此
合约永远看不到类型；被守卫的子句命名 `CatchableException`，而外层子句是 `catch (Exception e)`，
因此不可捕获的失败根本无法被捕获。内核证明四条路径在两个可观察通道上是不同的；关闭上限会移除
可捕获性；去掉守卫会使上限变得无关；无类型的外层子句会吞掉一切；每次故障都会清空通知集合，而任何
被捕获的抛出都不会；引擎不捕获的两次失败无法区分——这正是该记录没有“抛出类型”字段的原因。
十六个语义对照，每个字段一个。指令语义、TRY 栈协议、故障消息文本、效应回滚以及消费故障的交易
组合仍然未闭合。

加载准入作用域覆盖上面每条派发泳道**之后**才开始的内容：那些必须已经被接受、否则调用根本无法
解析的 manifest 与 nef-token 声明。它固定五个核心声明——nef 读取器、方法 token、manifest、ABI 与
方法描述符——并从它们推导二十四个槽：一份有序读取列表、二十个布尔与三个声明上限。两个面被保持
区分而不是合并：`admitted` 只查询守卫列表，而三个包含式上限（token 数组、token 名称、manifest
长度）由 `loads` 消费，因此一个声明可以通过每一个守卫却仍然因过长而被拒绝。读取顺序是一个字段，
通过对在每个突变体下都存活的锚点排序读出，因此移动一次 `reader.Read*` 调用会改变记录；校验和既
在最后又是可选的，这就是结构性拒绝总是先于完整性检查的原因。该泳道还记录 ABI 本身携带的不对称：
精确解析以 `(name, arity)` 为键，而通配查找忽略元数；manifest 对分组、标准、权限主体与信任去重，
但不对方法签名去重——因此重复的签名会被准入，而正是精确元数表让它变得无法解析，这一点留在未闭合
列表上，而不是被建模为一次抛出。二十七个语义对照，每个恰好移动一个槽并覆盖全部槽。部署路径、
每条拒绝消息、gas、通配读取器与 C# 到编译器的对应关系仍然未闭合，该泳道保持
`sourceFrontendVerified:false`、`applicationEngineVerified:false`、
`vmCorrespondenceProven:false` 与 `deploymentPathVerified:false`。

codec 的类型化原生 C# 子层为其已解析的序列化／反序列化 AST 与双字段往返携带六个经内核检查的
声明。它们的合法输入域、规范成帧、固定上限与显式的 VM／.NET 原语契约被记录为一个独立作用域。
门禁连接三份子集证书、源码模型与正向对照基线，并要求有效的源码突变体使原始全称断言失败。这个
限界内核结果保留 `fullSourceSimulationProven:false` 与 `runtimeSourceSimulationProven:false`。
宿主 codec 运行器使用 .NET 完成其类型化导出；仅含 Coq 的镜像必须在该整套 Python 运行器之外
单独复核生成的模型／证书。

可以选择一个可选的 native-vector 连接：

```sh
python3 formal/refinement/closure.py \
  --output-dir /tmp/aa-integrated-closure-with-vectors \
  --timeout-seconds 5400 \
  --helper-gas-runtime-receipts /path/to/reviewed-five-shape-receipts \
  --native-vectors path/to/reviewed-native-codec-vectors.json
```

所提供的向量字节本身也会被快照。这会重新检查一份有限的具体原生对应证书及其损坏字节对照；它不会
重跑原生运行时，也不证明通用的序列化器／VM 模拟。未提供该选项时，此项证据明确为 `NOT_SELECTED`。

helper gas 回执在精确独立枚举的 helper CFG 上证明一个参数化上限，并连接五份经复核的运行时 trace。
这些具体检查不闭合通用的实际 ApplicationEngine 计价、调度、资源安全或调用方可达性。本地默认 trace
目录为 `/tmp/aa-gas-runtime-evidence`；在其他宿主上请使用显式 CLI 选项。缺失所选的 trace 回执会
失败，而不是静默跳过该作用域。

被选中的回执必须固定其他泳道正在证明的工件，而不只是任何看起来合理的 trace：`crosscheck_runtime`
会以 `Runtime artifact mismatch` 拒绝 `nefSha256` 或 `manifestSha256` 与固定工件不同的回执。正是
这项检查让该泳道在合约改名使 2026-10-13 的捕获失效之后继续失败关闭，也在 2026-11-16 设计阶段
遗留兼容性清理改变custom 核心工件之后再次如此；每一次该泳道都保持红色，直到生产测试针对全新工件
重跑（归档捕获仍固定 NEF `9f714866…`；当前工件为 `2887bad3…`，因此在新捕获产生之前该泳道为红）。
经复核的五形状捕获以
`formal/refinement/fixtures/helper-gas-runtime-live-receipts.json.gz` 归档在仓库内（SHA256
`6d141d14…`）；被取代的改名之前捕获保存在它旁边，其拒绝由 `ArchivedReceiptStalenessTests` 断言。
因此，把该泳道重新指向新工件需要新的捕获，绝不能靠编辑哈希。

入口点派发泳道从 `raw.githubusercontent.com` 下载其固定的 Neo 核心源码，并且只有在文件的 SHA256
等于固定 Core 提交所记录哈希时才准入该文件。运行之间不缓存任何内容，因为该泳道的输出目录必须为空
且源码缓存就在其中。因此一次传输超时会在任何证明工作发生之前中止泳道，所以下载现在只对传输错误
重试，使用有界超时序列 `(30, 45, 60, 90)` 秒。HTTP 状态会被报告且不重试，序列耗尽会重新抛出最后
一次传输错误，而下载的字节仍会被拒绝，除非它们精确匹配固定哈希——重试改变的是韧性，永远不是
证据强度。

对于完全无法完成该下载的宿主，`AA_ENTRY_DISPATCH_SOURCE_MIRROR` 指向一个目录，内含先前抓取的
`<key>.cs` 文件（`key` 为固定源码键，把 `/` 换成 `-`）。被镜像的文件按与下载完全相同的规则准入：
它必须哈希到固定的 SHA256，否则泳道以 `Offline mirror source mismatch` 失败。证据是固定值而不是
传输，因此镜像无法洗白另一个工件；该变量只是替代停滞的网络，而网络是环境故障而不是关于源码的
事实。未设置该变量时，泳道总是下载。

存储 getter 泳道证书把固定的**只读** ABI 条目绑定到其精确 manifest 描述符与字节区域，在内核中证明
每个方法体的源码语义，并额外为每个区域携带一份 trace 级字节码证书：被解码区域的每个可达行为类
都与源码层结果一致，其中的程序、槽目标、调用与返回帧、被调用者参数绑定、系统调用弹栈顺序与类型
转换宽度都从被解码区域字节渲染。`StdLib.Deserialize` 保持为一个固定的 NEF token 索引，其行为是
一个全称量化的预言机，因此该泳道自己的 `vmCorrespondenceProven` 限于那个 trace 模型。门禁要求该
泳道的 `referenceVerifiedEntrypoints` 保持为空，其 `fullUnprovedEntrypointCount` 等于整份 manifest
计数，因此这份方法体证书永远不能被读作闭合的公开入口点。它按名称、区域与投影类型固定
`closure.STORAGE_GETTER_SHARED_CALLEES` 中列出的三个共享私有被调用者（账户状态读取器、市场托管
owner 取消读取器与待定模块调用读取器），把每个 getter 的 ABI 描述符、区域字节与 trace 覆盖类
连接到全新清单，并要求两个层级都有经内核拒绝的语义对照：源码层对照改变每个托管 getter 的存储前缀
或默认绑定，字节码层对照构成一个非空、名称唯一的名单，其中每个对照都绑定到一个已验证的 getter，
并携带一个被接受的未突变孪生体与一次正向内核拒绝。每个写出的模块都通过哈希其字节并重新解析其声明
清单被连接，而合成后的证书字节从全新清单独立重新生成；仅有回执永远不能替代那次重新生成。

`result.json` 还携带一个互不重叠的 `entrypointCoverage` 分解。只有 `fullyClosed` 会把入口点从
`unprovedEntrypoints` 中移除；`bodyLevelRefined` 计入自身方法体拥有经内核检查精化的条目（公开纯
方法泳道的参考条目加上存储 getter 泳道的已追踪区域），`dispatchLevelOnly` 计入其余条目。这些桶
恰好划分 manifest，而对未知条目的精化主张或由两条泳道共享的条目会失败关闭。该分解是对所选作用域
的描述性记账；它不改变 `status:NO-GO`、`verifiedEntrypoints` 或整合约未证明计数。

`result.json` 保留每条泳道的作用域、对照、源码／模型身份、已确立事实、排除项与声明清单。被导入的
声明不在泳道之间相加。`commands.json`、逐泳道日志、原始回执、生成的工件、`snapshot.json` 与
`entrypoint-inventory.json` 仍然可供独立复核。入口点清单见
[SA-ENTRYPOINT-CLOSURE.md](SA-ENTRYPOINT-CLOSURE.md)。

连接函数是对刚执行结果的内部检查；它不是用于认证任意用户提供回执 JSON 的 API。CLI 不接受用旧
证明回执替代新的调用。

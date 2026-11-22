# SA 形式验证

> 中文版本与 `docs/SA-FORMAL-VERIFICATION.md` 同构。若两者冲突，以英文版本为准。

## 状态

### fixture 刷新（2026-11-21）

2026-11-21 的 v4 规范一致性重建再次改动了 custom 核心（凭据代次从 1 起、核心级单一重入排斥、每个可写回调后与提交前的代码绑定连续性、`NefSha256` 统一为 `SHA256(NEF)`），因此工件身份移动到 NEF `397f96ab…` ／ manifest `4939cf01…`，script 为 44,833 字节。`formal/refinement/` 中的每条泳道常量、fixture 与回执都从这些字节重新导出：helper 仍是逐字节相同的 281 字节／116 条指令／52 个 opcode 的程序，整体平移 +272 到 `[36586,36867)`；initializer 为 `[44047,44833)`，786 字节／245 条指令；计费区间为 `[36696,36718)`；报销 `Storage.Put` 在 `36858`；initializer 的静态控制是 `PUSHDATA1` 数据字节 `44605` 与 `STSFLD` 槽操作数 `44609`。五形状 helper-gas 运行时捕获由其生产者测试重新捕获，而非编辑。有一条泳道控制需要重新锚定而不是平移：`gas_trace_proofs` 的哈希相等分支变异体原钉 PC 36126，该地址在移动后已不落在受限 helper 内的任何指令上（这是一个会抛出而不是拒绝的潜在缺陷），现锚定到复核过的 `36664` 分支，边为 `36666` ／ `36680`。刷新后的回执（`formal/refinement/fixtures/current-method-proof/method-proof.json`，SHA-256 `a4bd1854…`）对 `[36586,36867)` 记录 `kernelChecked: true`、`referenceRefinementVerified: true` 与 `fullImplementationVerified: false`，方法 `9aec81b7…`、证书 `f339b6ec…`、`CapMethodVm` 模型 `5ac5fa2c…`；111 条闭合假设全部枚举，6/6 条语义控制在 Rocq 9.0.1 上均被拒绝。重新锚定后该泳道的套件结果：`test_gas_trace` 22/22，`test_method_proofs` + `test_initializer_proofs` 32/32，`test_composition_proofs` + `test_context_proofs` + `test_public_pure_proofs` + `test_gas_proofs` 28/28。该作用域仍是有界的 helper／参考精化，不是整个实现的证明；initializer 的 `CapContext` 对 `UInt64Mask` 静态槽的覆盖缺口仍由 Task 26 处理。

### fixture 刷新（2026-11-16）

2026-11-16 的设计阶段遗留兼容性清理改动了custom 核心源码（移除了遗留存储前缀回退、轮换迁移面与依赖
回填；恢复验证器的 v3 action ticket 被删除，`submitActionTicketV4` 重命名为
`submitActionTicket`）。`formal/refinement/fixtures/` 下的精化 fixture 已针对清理后的候选重新
蒸馏：RefinementExport 清单重新运行，`cap-method-source.json`、`initializer-source.json` 与
`current-initializer-source.json` 重新蒸馏，current-method-proof 回执针对新的内核重新生成，
方法／上下文泳道常量重新固定，五形状 helper-gas 运行时捕获针对新工件（NEF `9f714866…`、
manifest `a6533d47…`）重新生成。2026-11-19 的 v4 重建再次移动了工件，
NEF 变为 `2887bad3…` ／ manifest 变为 `f44cddeb…`；本文档列出的每条泳道常量、fixture 与回执都已
针对该工件重新固定或重新蒸馏，唯独归档的 helper-gas 运行时捕获仍然固定 `9f714866…`，因此在新捕获
产生之前保持失败关闭。2026-11-20 的重建再次移动了工件，NEF 变为 `27e28aa0…` ／ manifest 变为
`f0c6467b…`。该 pin 是从 live 字节重新锚定的，五形状 helper-gas 运行时捕获用其生产者测试重新捕获、
而非编辑，因此 the archived method-refinement record (removed from the tree) 中的泳道常量与 `formal/refinement/fixtures/` 下的回执都
命名这个工件。有两处模型绑定没有随这次移动而保留：报销键是静态槽 58（槽 38 现在是 `UInt64Mask`），
编解码 token 是 `deserialize` 2 / `serialize` 3（而非 3 / 4）。两者均已在 `formal/refinement/` 中
修正，并已在 Coq 8.18 主机上针对本工件重新检查。刷新后的回执
（`formal/refinement/fixtures/current-method-proof/method-proof.json`，SHA-256
`98711714…`）对 helper `[36314,36595)`（281 字节 / 116 条指令）记录
`kernelChecked: true`、`referenceRefinementVerified: true` 与
`fullImplementationVerified: false`，方法 `9aec81b7…`、证书 `f339b6ec…`、`CapMethodVm` 模型
`5ac5fa2c…`；`coqc` 与 `coqchk -silent` 干净，111 条闭合假设全部枚举，5/5 组合测试通过。该
作用域仍是有界的 helper／参考精化，不是整个实现的证明。initializer 的 `CapContext` 仍未覆盖建立
v4 `UInt64Mask` 静态槽的 `PUSHINT8`/`SHL`/`SUB` 写入，该泳道由 Task 26 处理中、尚未闭环。归档的
改名前捕获按设计继续失败关闭。被退役的清理前 getter 形状已不复存在：`storage_getter_source.py`
不再携带 `legacy_symbol` / `inline-fallback` 形式，该泳道的源码级语义控制现在改为前缀／默认绑定
变异体，遗留的读取顺序控制已从泳道、闭合门禁与回归套件中移除。

### 当前私有验证刷新（2026-10-31）

当前 SmartAccount／native-core 源码快照通过了固定的 Docker 形式门禁。回执
`docs/reports/sa-formal-gate-20261031.json` 记录：29 个 Coq 模块、554 条闭合声明、311 个被拒绝
的 Coq 变异体、四个被拒绝的 TLC 变异体（语义变异体合计 315 个）、61,460 个 TLC 不同状态，以及
7/7 个 SMT 义务。形式化 runner 的回归套件在当前工作树上独立通过 72/72 个测试。.NET 合约套件独立
通过 571/571 个测试，无失败、无跳过。

门禁报告 `modelChecksPassed: true` 与 `implementationVerified: false`。其作用域是被复核的抽象协议
与原生状态模型；它不主张完整的 C# 到 NEF 再到 NeoVM 的精化、完整的 NeoVM／ApplicationEngine
语义、密码学健全性、完整的 WitnessRule 解码／求值，或任意插件的活性。已提交的回执与
`formal/.runs/docker/result.json` 处的 Docker 运行输出逐字节相同。

当前源码构建的 NeoExpress 权威验证记录在
`docs/reports/smartaccount-native-source-runtime-20261031-final/` 下。其聚合回执与全部五份矩阵回执
都报告 `PASS`：原生服务生命周期、签名代理与原子回滚、配置根变更、权威恢复，以及激活边界验证。
运行时文件映射在各矩阵前后保持一致，所有自有节点均已停止，`publicNetworksTouched` 为 `false`。
聚合回执刻意报告 `fullProtocolConformanceVerified: false`：这些是有界的私有链检查，并不主张覆盖
每一种可能的插件、证明系统或生产部署。

同一个最终源码构建的运行时还针对扩展原生矩阵运行过，记录在
`docs/reports/smartaccount-native-extended-matrix-20261031-final/index.json`。该回执对 MultiSig
组合、DailyLimit 记账、SessionKey 执行、会话作用域准入与 TokenRestrictedHook 策略均报告 `PASS`；
六个打包原生 profile 在两次使用固定 `nccs` 3.9.1 的可复现构建之后，也通过了当前的 profile 打包
检查。这些回执绑定到当前源码构建的 runner 与模块构建回执，报告 `publicNetworksTouched: false`，
并保留相同的有界范围：仅限随附场景与持久化私有链回读。它们不证明密码学健全性、MultiSig 私钥
独立性、任意插件活性、完整的 NeoVM／编译器精化，或公开部署一致性。

当前原生权威准入 profile 仍是 ABI 2。最终源码构建的 runner 回执是
`docs/reports/smartaccount-native-runner-build-20261031.json`。它绑定核心
`0b81b25601ba7e2ec0b0d9b9cb0ab79ed809af03`、两次逐字节相同的干净构建、104 个运行时文件与 50
个依赖包。更早的 2026-10-30 模块与 runner 回执仍是其所记录源码集的历史证据，不得用作当前溯源。

另外，custom SA 协议套件用同一源码构建的 NeoExpress 运行时端到端重跑了一遍。当前回执
`docs/reports/sa-neoexpress-validation-20261031.json` 报告 `PASS`，并且对该私有链具备发布证据
资格：25 个部署工件（24 个本地工件加同仓的 `NeoDIDRegistry`）、15 个场景、135 笔持久化交易
（132 笔 HALT、3 笔 FAULT）、48 个预期负例（其中 45 个在持久化之前被拒绝）、132 条链上断言，
以及 25 份逐字节相同的 RPC NEF 回读，校验和一致、manifest 语义相等。
`docs/reports/sa-private-artifact-provenance-20261031.json` 处的源码到工件到链的联结把全部 80 个
当前发布工件与一次全新构建比较，并把 24 个本地工件联结到其部署字节。该运行报告
`publicNetworksTouched: false`，不确立公开部署或公开工件一致性。

平台账户所有者轮换场景使用最终源码构建的运行时，验证了延迟 registrar 激活、陌生人对取消的拒绝、
当前所有者的取消、提前确认的拒绝、缺少拟议新所有者见证的确认的拒绝、提议与取消事件、轮换后
所有者的持久化、待处理记录的清除，以及代理地址的保持。这是针对随附源码的私有链证据；公开 ABI
迁移与公开部署回读仍待完成。

该回执现在还包含 `Web3AuthVerifier` 的真实临时 secp256k1 路径：使用 65 字节未压缩公钥的账户注册、
一次成功的 EIP-712 风格 UserOperation、使用未变 nonce 的重定向与外来密钥拒绝，以及在 65 字节可恢复
形式与 64 字节 EIP-2098 紧凑形式下对直接 32 字节 ERC-1271 摘要的验证，并带一个不同摘要的负例。
这走的是随附的 NeoVM／CryptoLib 路径，不是托管的 Web3Auth OAuth 仪式。Web3Auth ERC-1271
直接摘要路径要求 `HF_Huyao` 或更高。Huyao 之前的兼容实现不强制规范的 `r`/`s` 边界，处于受复核
部署 profile 之外。

NeoExpress 回执同样与源码运行时绑定：它记录 PASS 源码构建回执的哈希、三个源码提交、执行前后都
匹配的 104 文件运行时映射、`neoxp.dll` 的哈希与包装器的哈希，同时显式设置
`pathsIncluded: false`。这把链上运行绑定到受复核的 runner 构建，而不公开主机路径。

2026-10-31 在主机侧执行
`python3 -m unittest discover -s formal/refinement -p 'test_*.py'` 的发现式运行完成了 790 个
测试，其中 50 个环境门控跳过，无失败。跳过不计为证明，且该发现式运行不替代故障即闭合的闭合
门禁，也不移动 `implementationVerified`。

剩余边界是明确的：custom 公开 profile 仍通过 `System.Contract.Call` 调用验证器，没有独立的子调用 gas
上限。公开部署与公开工件一致性不在本次仅限私有的运行范围内。形式化与运行时证据也仍保留下文
所述的密码学、完整 WitnessRule 与 NeoVM、编译器／精化、密钥独立性以及任意插件清理边界。本次
刷新没有使用任何公开网络。

### 分层实现精化（2026-10-13）

[实现门禁](SA-IMPLEMENTATION-REFINEMENT.md)现在默认请求四条证明泳道：原始算术区域、
`数值强制转换`、
`预留算术`，以及
`完整报销 helper 参考精化`。
最后一条泳道使用`类型化源码投影`与
`完整指令清单`。
`固定引擎运行时检查`提供
独立的有限证据，包括存储与故障行为。这些泳道单独都不验证整份合约或公开协议激活。

在仓库根目录用一个新的或空的输出目录运行默认门禁：

```sh
python3 formal/refinement/verify.py --timeout-seconds 1800 --output-dir /tmp/sa-refinement-evidence
```

新的集成报告 `reports/sa-method-refinement-20261013.md`（未包含在本检出中）及其逐泳道回执记录了
完整 helper 的十项通用结果与两个具体例子，共 103 条经假设审计的声明（包含被导入的定义与证明）。
下文的历史算术与协议模型回执保留各自原本的作用域，不得相加来推断更大的实现定理。
`--arithmetic-only` 显式选择历史局部泳道。`--allow-partial` 只接受经检查的部分作用域，并让
`implementationVerified: false` 保持不变；这两个选项都不会绕过工具或证明失败。

完整 helper 的源码定理使用一种声明的 Neo 框架合约方言：交易哈希是按内容比较的不可变字节值，而
可变预留记录保留堆别名。这不是关于任意 CLR 引用身份的定理。编译器／框架对应关系、良构的可达
存储、调用方守卫、真实原生序列化、ApplicationEngine 效果与资源故障仍是分开的义务。在把引用
定理解读为实施接受之前，请参阅
[方言与身份边界](SA-IMPLEMENTATION-REFINEMENT.md#neo-contract-dialect-and-object-identity)。

**完整实现精化仍是 NO-GO。** 这些 helper 泳道尚未认证任何完整的公开入口点。成功的部分默认运行
仍返回退出码 `2`（除非用 `--allow-partial` 显式请求），并保留为假的实现状态。

### 历史算术区域证书（2026-10-13）

单独的[实现精化门禁](SA-IMPLEMENTATION-REFINEMENT.md)现在把类型化 Roslyn 操作、逐字节相同的
NCCS 重建、完整的 100 项 manifest 与独立解码的候选 NEF 绑定到一份实际的 Coq 证书上。已证明区域
是 PC `[13667,13689)` 处的报销算术：22 条原始指令，带 signed-256 边界、类型化入口条件、结果
相等、参数／局部帧保持，以及与既有 `CustomSponsorship.charge` 定义的相等。

主机 Rocq 9.2 与固定容器中的 Coq 8.18 独立接受同一份生成的证书，并用 `coqchk` 复检。
各自检查 **38 条闭合声明**：23 条新增／本地声明与 15 条被导入的协议声明。不要把 38 加到历史
490 的计数上，后者已包含那 15 条。这是抹去 gas 的 Integer 类型引用语义定理；实际的 NeoVM 执行
由七个运行时测试单独检查，并未对所有状态证明等价。

**完整实现精化仍是 NO-GO。** 没有任何完整的公开入口点被证明。源码／调试提取、入口状态建立与
数值标签强制转换、存储／序列化、异常与交易回滚、外部调用／重入、gas／资源故障以及
ApplicationEngine 对应关系，对这份历史证书而言仍然开放。其仅算术门禁返回退出码 `2` 与
`implementationVerified: false`；`--allow-partial` 保留该为假状态，同时只接受显式划定作用域的
算术区域。带日期的精化报告 `reports/aa-implementation-refinement-20261013.md`（未包含在本检出中）
包含确切的工件、命令、控制与剩余方法义务。

### 历史源码候选的主机闭合（2026-10-13）

冻结的custom 源码候选快照通过了主机模型门禁：**29 个 Coq 模块、490 条闭合声明、287 个被拒绝的语义
变异体**（283 个 Coq 与四个 TLA）、**61,460 个 TLC 不同状态**，以及**七个 SMT 义务与七个控制**。
门禁在验证前后各检查 59 个 SA 源码输入与 310 个 native-core 源码输入。runner 回归套件通过 68 个
测试。受跟踪的回执是 `reports/sa-formal-ordinary-closure-20261013.json`（未包含在本检出中；
SHA-256 `7ad982a403b7c2b953c946f49ce42fe544be1b87fa3fbdd668078623070bc5b9`）；它与
`formal/.runs/ordinary-closure-final-r3-20261013/result.json` 逐字节相同。主机使用 Rocq 9.2、
Z3 5.1.0、OpenJDK 26.0.2.1，以及 SHA-256 为
`7beec0f04818732a62fa193731711a99aa4f11279499b2360a7d156c519ea78d` 的受复核 TLA jar。

这使 **已声明的custom 协议抽象与受复核的源码快照检查为 GO**：治理授权与延迟、累积交易赞助预留、
以及仅所有者可执行的永久恢复都在其中。`implementationVerified` 仍为 **false**。源码片段检查与
模型证明不确立 C# 到 NEF 再到 NeoVM 的精化、全入口点存储语义、密码学、完整费用记账、任意插件
活性，或公开激活。

独立的固定容器门禁也用 Coq 8.18.0、Z3 4.8.12 与 OpenJDK 21.0.12.1 通过了同一份源码／模型快照，
包括全部 68 个 runner 回归测试。容器回执是
`reports/sa-formal-ordinary-closure-docker-20261013.json`（未包含在本检出中；SHA-256
`283e7517b9c113fb829f4735206da2c882e84be8065ffbeae09ed8259bc9289e`）。其源码、native-core、
模型工件、profile 与证明结果映射与主机回执相等。它运行不可变镜像
`sha256:49175ab91d07c3446004b93c667b581d34c1702b61cc1d937c8218f439b00941`，并使用同一个确切的
TLA jar 固定值。镜像构建通过既有的 `TLA_JAR_URL` 参数与一个临时 localhost 服务器使用了受复核的
缓存 `/tmp/tla2tools.jar`，该服务器在构建后已停止。当时默认的 GitHub release URL 提供的字节不同，
未通过未改动的 SHA-256 守卫；本次运行不主张从那个可变 URL 成功重建。Dockerfile 与包装器都未
被修改以绕过该固定值。2026-10-30 的刷新复核了官方 `fc6878c6...` 资产摘要，更新了声明的固定值并
重建镜像；这不会追溯改变历史回执。构建输入与原生合约清理的证据是
`reports/sa-formal-container-build-20261013.json`（未包含在本检出中；SHA-256
`d17b6b6d61568bdad038adf19baa3615d7fce00f1fad9fa9de82cda1e9891a8c`）。第一次容器尝试暴露了
不同模型中同名变异体之间的 scratch 路径冲突；runner 现在按模块为证据建立命名空间，完整重跑通过。
两个环境都报告 `modelChecksPassed: true` 与 `implementationVerified: false`。

每份回执都绑定到其所记录的源码、模型、profile 与工具版本。上面主机与容器回执除 `toolVersions`
之外字段完全相同；其不同的 Java、Coq/Rocq 与 Z3 版本标识的是彼此独立的验证运行，而不是可互换的
回执字节。仅有声明、变异体或状态计数相等并不确立快照相等。比较运行时请使用所记录的输入哈希与
证明结果，并保留每份回执原本的工具版本。

### 先前的主机快照（2026-10-13）

先前那份custom 治理源码与模型快照通过了主机形式门禁：**27 个 Coq 模块、460 条闭合声明、258 个被
拒绝的语义变异体、61,460 个 TLC 不同状态、六个 SMT 义务与六个控制**，native core 名册按 310 个
确切源码文件检查。受跟踪的custom 治理回执是 `reports/sa-formal-ordinary-go-20261013.json`（未包含在
本检出中）（SHA-256 `a5becc179de6d55bf688dcede42b402ad4018a69ea061d16179e7ac89cdfae21`）。
该验证运行还写出 `formal/.runs/ordinary-go-20261013/result.json`；受跟踪的副本保留在该检查点
验证过的源码／模型身份。它不认证后续的赞助或仅所有者恢复改动。它使用 OpenJDK 26.0.2.1 运行。
更早的回执 `formal/.runs/final-20261013-platform/result.json`（SHA-256
`f1b0f876b9219bf4cab19f3da6beeaaed8ef50756564eb9e52b75389b7dcf887`）覆盖前一份模型／源码
快照，并使用 OpenJDK 17.0.20.1 运行；只把它作为那份历史快照与工具链的证据保留。它不认证更晚的
源码／模型快照或其 Java 运行时。形式模型门禁对其声明的抽象为 **GO**。它刻意保留
`implementationVerified: false`：这些模型不证明 C# 到 NEF 再到 NeoVM 的精化、完整 VM 费用记账、
任意插件活性，或公开部署等价性。在这个更早的检查点 Docker 门禁尚未运行，因为本地 Colima 守护
进程不可用。更晚的独立容器运行记录在上面的当前源码候选主机闭合中；它认证那份更晚的固定快照，
而不追溯改变这份历史回执。

custom 公开 profile 还保留两条协议级 NO-GO 边界：`public` 回调使用标准 `System.Contract.Call`
而没有隔离的子调用预算；固定的公开 ABI 仍暴露即时的平台账户备份所有者轮换。源码候选现在包含
带新所有者见证的两阶段提议／确认／取消路径，但闭合公开边界需要从固定的 90 条目工件迁移到受复核
的源码候选 ABI、升级工件并进行公开回读；本仓库不会基于静态测试把它重新标记为已闭合。

custom 源码候选现在有显式的 Coq 治理模型（`CustomGovernance.v`），覆盖 registrar 与所有者授权、
重复的待处理提议、七天确认延迟、新所有者见证、逃逸与托管排除、取消、边界清理，以及失败转移的
原子性。这是一个有界的状态机对应模型；它不证明存储序列化、C# 到 NEF／NeoVM 精化，或公开部署。

当前治理模型使用毫秒级 `Z` 值与确切的 604,800,000 ms 延迟。runner 重新计算固定的 C# 延迟
表达式并比较该值，同时固定逃逸与市场结算清理的源码。所有者取消要求当前所有者的见证，且独立于
调用脚本。自然数所有者 ID 抽象非零身份；有效的 UInt160 值与匹配的账户绑定是该投影的前提条件。
治理失败证明保持治理记录不变，而该记录不建模 nonce 存储。它们不证明当前所有者对 registrar 提议
的同意。

`CustomSponsorship.v` 为每个核心建模一本账本，且交易在账户、赞助方、paymaster、单次调用、批量
与嵌套执行之间共享。预留先于外部回调发生；重复的成功预留之和最多为包含它的正交易费用。有一个
定理把抽象收费与无分支源码表达式联系起来。零费用 RPC 估算保留请求的报价，并且没有持久化费用
上限的主张。交易哈希身份、费用、已存储账本完整性、包含它的交易的回滚，以及实际 token 结算仍是
实施对应义务。

`CustomRecovery.v` 建模源码候选的无回调恢复，直至不可逆的仅所有者锁存。它证明了对旧插件结果
的独立性、成熟度／见证／锁／托管守卫、根／上下文／意图的脱离、保留的身份与 nonce 投影、重复
恢复的拒绝，以及恢复后非零根安装的拒绝。它没有重新打开插件权威的转移，也不主张原生权威纪元语义。
具体存储清理、全入口点强制与见证有效性需要匹配的源码复核与 VM 测试。不可逆性限于本版本所建模的
转移；管理性代码升级与未来协议版本在该主张之外。

### ABI 2 收敛边界

活动的原生目标是 SmartAccount ABI 2，身份派生版本 1、授权／账户记录版本 2，并有独立的权威纪元
与配置 nonce。原生恢复撤销旧的模块代际而无需外部清理。六个原生模块使用纪元作用域状态。普通
`public` 与私有 `PLATFORM` 源码作为独立 profile 保留；原生主张必须绑定外部 Neo core 源码，
而不是旧的已部署核心原型。

未发布的 ABI 2 profile 现在要求每个模块都具有确切的 profile 指纹与严格的验证器组合标记。其原生
复合模型使用瞬态三字段回执、首阈值选择、至多三个子项／两个批准／两个阈值／三个签名者域、每次
操作全新的所有权、全活跃绑定检查，以及前／后策略相等。公开的 `MultiSigPolicy.v` 十字段／重复
验证模型只适用于 `public` 与 `PLATFORM`；`NativeCompositePhase.v` 覆盖独立的原生回执设计。Session 的
纪元作用域前缀 `0x05` 存储确定性的签名者域配置，前缀 `0x06` 保存独立更新的最后使用时间；两者都
不存储持久批准。两个模型都不证明字节复制、哈希、密码学、实现精化或 gas 可行性。

冻结的复合 profile 在 2026-10-09 通过了其完整主机门禁：**26 个 Coq 模块、443 条闭合声明、247 个
被拒绝的语义变异体**（243 个 Coq 与四个 TLA）、**61,460 个 TLC 不同状态**，以及六个 SMT 义务与
六个控制。门禁在证明前后各检查 55 个 SA 输入与 310 个外部核心输入。`NativeCompositePhase.v`
贡献 45 条闭合声明与 31 个定义有效、证明被拒的变异体。确切结果是
[`sa-native-composite-final-formal-20261009.json`](reports/sa-native-composite-final-formal-20261009.json)。
其 profile 指纹是
`4201b02f571b7415121467d67343a8189b8070ad795a82424c0403782d22b1b4`。runner 回归套件通过 60 个
测试；profile／向量测试通过 16 个。

两次完整的源码运行时构建从核心 `ff422d940a4722c361c32398c6f28c00fb7f0693`、node
`fa35e69af130661e2ac60bffd43eb6c6c78aa7d5` 与 Express
`da143f8643ebca7841cc7f56e4e3e00293819fbc` 产出了相同的 104 文件输出、50 个依赖归档与项目锁
映射。六个原生模块重建为 13 个打包文件；80 个 public/PLATFORM 工件与全新构建匹配，公开合约套件
通过 396/396，零跳过且带必需的 NeoDID 工件。这些构建／证明结果汇总在
[`sa-native-composite-final-build-proof-20261009.json`](reports/sa-native-composite-final-build-proof-20261009.json)。
最终的原生私有链与 SDK 集成回执仍是分开的门禁；更早的运行时回执不认证这个 profile。

前一份 ABI 2 快照的主机门禁在 2026-10-08 通过：**26 个 Coq 模块、409 条闭合声明、222 个被拒绝
的语义变异体**（218 个 Coq 与四个 TLA）、61,460 个 TLC 不同状态，以及六个 SMT 义务与六个控制。
所有变异体都先通过定义编译，然后在相关证明或不变量上失败。门禁固定 55 个 SA 输入与 309 个外部
native core 源码文件，并在验证之后再次检查。门禁回归套件通过 57 个测试；profile／向量套件通过
12 个。确切的模型／源码／工具哈希与 profile 适用性见
[`sa-native-abi2-formal-20261008.json`](reports/sa-native-abi2-formal-20261008.json)。

`NativeAuthorityEpoch.v` 为受检查计数器、无回调恢复、命名空间分离与四参数执行承诺贡献 44 条
闭合声明与 22 个变异体。域哈希、确切字节键与 VM 交易见证行为仍是源码／运行时对应义务。普通
TLC 与 SMT 检查保留其 public/private 合约作用域。形式模型仍是手写的抽象，而不是 C#／VM／NEF
精化或部署证明；因此结果保留 `implementationVerified: false`。下文计数标识产生它们的带日期快照；
仅凭 ABI 2 标签并不确立与这个修订过、未发布 profile 的兼容性。模块／构建与原生链回执是分开的
证据；通过的证明不能替代重放。

### 有界配置后置条件

原生确认边界必须在回调执行之后重新准入所选子项及其绑定的根。一个具体回归复现了子配置摧毁其根
却仍返回 HALT 的情况。修复后的路径在提交之前重新检查根。`NativeLifecycle.v` 建模对应的双绑定
后置条件与全有或全无的快照选择：缺失或改变的绑定选择原始快照，而不是暂存的回调写入。观察到的
绑定身份与整快照回滚仍是抽象输入；这不是哈希、ContractManagement 或 C# 回调精化的证明。私有回执
`docs/reports/sa-neoexpress-native-configuration-20261006.json` 记录十笔签名配置交易与两次注册，
包括两笔持久化的根摧毁 FAULT，以及相同根下的良性控制。

`formal/` 下仓库本地的形式工件是下文故障即闭合门禁的输入；同仓的本地
`neo-os-formal-verification` 工作区携带并行的验证集合。

### 历史原生 ABI 1 证据

下文历史章节中提到的回执是其所述运行的带日期记录。2026-10-05..08 的大多数回执从未属于本检出，
因此引用只是指出记录，而不是你在这里能打开的文件；当前固定的集合列在
[INDEX.md](INDEX.md#evidence-receipts)。它们都不是当前树的证据。

历史故障即闭合的 SA 本地主机门禁在 2026-10-08 通过：**25 个 Coq 模块、360 条经假设审计的闭合
声明，以及 198 个被拒绝的语义变异体**（194 个 Coq 与四个 TLA 变异体）。TLC 探索了 61,460 个
不同状态，全部六个 SMT 义务与六个控制通过，runner 套件通过 **52/52**。历史回执是
`docs/reports/sa-formal-gate-native-multisig-20261008.json`。该门禁固定 23 个源码文件，包括确切的
原生模块权威守卫、选定的模块 profile 与会话时钟／载荷适配器。入口引理同时要求固定的原生合约
身份与经认证的阶段授予；匹配的正向控制排除了始终拒绝的实现。源码固定仍是手工对应检查，不是
编译器或回调精化证明。

`NativeCompositePhase.v` 为分开的验证入口与再验证后入口增加十一条声明与六个变异体。原始验证入口
仍拒绝阶段后授予；额外的只读入口要求确切的 postExecute 授予。两个已授权入口应用相同的叶子策略。
非布尔回复不是投票，抽象的后置计划保持已配置名册的成员性与唯一性。授予真实性、返回值与运行时
派发仍是抽象输入，不是精化定理。模块 profile 定义在
`docs/proposals/SMARTACCOUNT-NATIVE-MULTISIG.md`。

`NativeSessionPolicy.v` 有二十三条声明与十九个变异体，涉及带上限授权、确切扣款、失败目标回滚与
依赖触发器的时钟选择。该时钟在 Verification 中选择持久化账本时间戳，在 Application 中选择持久化
时间戳；账本时间缺失时故障即闭合。签名有效性、作用域、时间戳与转账形状仍是抽象输入。这些证明
不机械验证 CryptoLib、NeoVM 或 C# 适配器。生命周期扩展证明轮换时的支出保持、冷却拒绝、不同的
撤销／清理效果，以及两侧的零金额上限边界。一个具体的私有链回归发现：原生源码在降低上限之后
跳过了零金额的累积上限检查。原生验证与 postExecute 路径现在也对零金额应用该检查。一个特定变异
恢复了那处绕过，并被证明门禁拒绝。旧 profile 分支未变。这些是模型与运行时证据，不是把两者连接
起来的机器检查证明。

`NativeSessionScope.v` 增加二十二条声明与十八个变异体，涉及零上限授权、通配目标绑定、配置准入、
无上限结果语义、带上限扣款与密钥复用边界。它不替换带上限的生命周期模型。签名有效性、完成性、
密钥身份、nonce 时效与过期是抽象谓词，不是密码学或引擎证明。其叶子策略反例在固定签名／域谓词的
前提下记录了历史 ABI 1 的密钥复用风险。ABI 2 在配置与恢复时改变授权域；`NativeAuthorityEpoch.v`
建模对这些陈旧签名的拒绝。两个抽象单独都不能证明其 VM 组合。

历史 ABI 1 证据记录为 `docs/reports/sa-native-session-scope-validation-20261007.json`：两条私有链，
各自有 44 笔持久化矩阵交易（27 笔 HALT、17 笔预期 FAULT）、五次见证准入拒绝与两次注册。确切的
原始存储与全部授予事件字段都被比较。一次零上限的假 GAS 转账完成并消耗 nonce 而不支出；目标
FAULT 会回滚。通配授予允许读取方法与整笔余额的 GAS 转账，但仍拒绝另一个目标。相同的保留签名字节
在密钥被替换或撤销时拒绝，随后在显式重新授予后成功；已消耗的 nonce 仍被拒绝。这些观察只适用于
那份历史 ABI 1 源码／工件／回执集合，不适用于当前 ABI 2 协议。所引用的原始回执不在当前检出中；
在重放或复用那些观察之前，必须恢复其确切的源码与工件身份。对 ABI 2，`NativeAuthorityEpoch.v`
单独建模配置或恢复改变授权域之后对陈旧签名的拒绝。该模型不替代当前的运行时签名证据，也不把历史
回执重新绑定到当前工件。历史验证中没有生产合约或原生工件发生变化。

`NativeDailyPolicy.v` 有二十四条声明与十五个变异体，涉及固定窗口锚定／过期、带上限的正净流出记账、
与布尔假返回的独立性、滚动窗口纳入／过期，以及五十条记录的界。扫描证明把单次求和／计数等同于
过滤后的历史，在剪枝下保持每条存活记录，并为准入追加之后的计数给出界。余额解码器拒绝负
Integer、其他类型与查询故障；无效观察会中止增量，而不是替换为零。四个变异恢复强制转换或回退
行为，必须被拒绝。把具体 VM 值与故障映射到抽象回复构造子仍是外部对应义务。余额、时间戳与交易级
回滚是模型输入，不是被证明的 token 或 VM 行为。原生 DailyLimitHook 使用资产代理、独立的阶段授予
与无条件的净流出计量。一次私有 fail-first 运行复现了假 GAS 返回之后遗留的快照；修复后的 profile
清除该快照，同时保留零流出计数器。移动的固定窗口锚点被模型与私有时间平移矩阵分别拒绝。两个测试
都不证明任意 token 的余额诚实性，也不证明对每种可能配置 token 集合都足够的回调 gas。

后来的容量运行在第二十一条存活 GAS 记录处复现了回调 gas 耗尽，早于声明的五十条记录上限。原生
分支现在每次回调一次遍历计算滚动求和／计数，并在执行后遍历期间剪枝过期记录。它既不提高原生
2.5 GAS 回调预算，也不丢弃存活历史。对抗矩阵还使用一个故意不合规的诊断 token，它改变余额并返回
false，另加一次被拒绝的嵌套 GAS 转账来验证确切目标的见证隔离。该修复的实测范围见
`docs/reports/sa-native-daily-capacity-validation-20261007.json`；token 诚实性与完整编译器精化仍是
假设，而不是扫描证明的推论。

当前余额观察扩展记录在 `docs/reports/sa-native-daily-balance-validation-20261007.json`。两条独立
私有链各自通过 116 笔矩阵交易（87 笔 HALT、29 笔预期 FAULT）加两次注册。负 Integer、ByteString、
Boolean、Null 与 Array 回复在策略测试之前直接从编译后的 fixture 观察到。这五个案例、查询故障与
回调预算耗尽，在目标之前与目标写入之后都被拒绝。oracle 比较原始 token 存储、nonce、策略状态与
账户隔离，而不是敌意的 balanceOf 结果。延迟移除耗 gas 的 token 限制成功，随后一次真实 GAS 转账
成功。容量、过期与六前缀清理也被重放。本扩展中没有生产合约或原生工件发生变化。先前一次 fixture
运行因返回值计数不匹配而失败，而不是产生预期的负值；那份失败回执被保留，且不计为策略证据。确切
的 getter 检查现在防止了那种假阳性场景。这些实测路径不证明任意查询行为或 VM 精化。

原生 TokenRestrictedHook profile 增加独立的阶段授予、代理资产查询、确切的非负 Integer 观察、缺失
快照拒绝，以及两个账户作用域前缀的清理。`NativeRestrictedPolicy.v` 增加十五条声明与八个变异体，
涉及直接目标拒绝、逐 token 准入、与结果无关的净流出拒绝、移除与清理。解码、token 诚实性、存储
枚举与原子 VM 回滚仍是应对应输入。抽象清理定理不确立任意插件清理。

两条独立私有链各自通过 64 笔矩阵交易（35 笔 HALT 与 29 笔预期 FAULT）加两次注册。一个故意委派
的诊断路由器在不继承代理见证的情况下移动实际测试 token 余额；即便路由器返回 false，postExecute
也拒绝流出。零净移动与流入成功。七个畸形／失败查询案例在两个阶段都拒绝；原始 token 存储、nonce
与 hook 状态回滚。延迟移除耗 gas 的 token 允许后续一次真实 GAS 转账。两个已配置 token 在完整账户
清理之前被演练。新的原生构建逐字节保留先前四个 profile 的八个 NEF／manifest 文件；遗留 profile
工件保持不变。当前证据与显式未闭合义务记录在
`docs/reports/sa-native-restricted-validation-20261008.json`。同一份五 profile 构建还用于全新的
DailyLimitHook、带上限 SessionKey、无上限 SessionKey 与原生见证／白名单回归。在六条一次性链上，
361 笔持久化矩阵交易产生 214 笔 HALT 与 147 笔预期 FAULT；12 次注册与 14 次见证准入拒绝单独计数。
缺失快照拒绝在源码中有守卫并在形式模型中建模，但在这些链上未被直接注入故障。

更早的逐字节不变探针记录在 `docs/reports/sa-native-nef-probe-validation-20261008.json`。两个独立
构建的主机探针各自执行 156 个案例（122 笔 HALT、34 笔预期 FAULT）。在经认证的 postExecute 边界
移除缺失快照并被拒绝；整个父存储保持不变。故意陈旧的快照被配置与清理移除，且不删除另一个账户的
状态。十二个余额向量包含每种已定义的 VM 栈项类型，并有分开的零、正、负 Integer 案例。这些是
代表性取值，不是穷尽的值、大小或序列化证明。时间锁管理、错误见证、不匹配的升级哈希与同工件更新
也被执行。主机交易未签名；它们不替代真实见证的 NeoExpress 测试。额外一次私有重放通过 64 笔
持久化案例。

阶段扩展记录在 `docs/reports/sa-native-nef-phases-validation-20261008.json`。两次干净构建各自运行
230 次调用（177 笔 HALT 与 53 笔预期 FAULT）。全部十二个余额代表现在在两个阶段都被演练。一个
诊断 token 先返回有效的正 Integer；随后在原生 postExecute 边界的主机侧存储模式变更会选择每种回复
类型。无效类型、负 Integer 与正流出之后的零，都以不同的预期原因拒绝。每笔被拒绝的交易都丢弃注入
的模式写入、nonce 变更与瞬态 hook 快照。随后一次有效执行成功。四次没有阶段授予的直接
callback／配置调用被拒绝，四次主机注入的畸形回调 Array 也是如此。这些注入测试防御路径；它们不
主张原生合约会发出畸形操作。

对整个 1,076 条指令的生产 NEF 的当前覆盖是 **900 条被尝试指令（83.64%）** 与 **182 条已完成
条件边中的 124 条（68.13%）**，高于更早阶段前探针的 890/1076 与 119/182。未访问的管理与防御
代码保留在分母中。收集器检查两个分支方向、完成前故障与每个条件操作码；它在下一指令处观察 fall-through，
而不是在 post hook 中过早观察。探针可执行文件本身逐字节复现。这既不是 C# 源码行覆盖，也不是
已完成的覆盖率门禁，且不机械验证编译器或完整 VM 对应关系。原生工件未变。

主机 TLC 二进制发生了变化，因为先前的本地 jar 不可用。替代品的 SHA-256 与 GitHub 公布的资产摘要
匹配；溯源记录在 `docs/reports/sa-formal-tool-provenance-20261007.json`。上游 `v1.8.0` 资产是可变
的。这是一次新的主机工具链运行，不是对更早容器工具链的重放，Docker 固定值也没有被悄悄更新。

作用域包括有界 MultiSig、授权、证明／证明绑定、故障感知的 WitnessRule 求值器精化、ABI 投影、
NeoVM 调用／续延子集、签名者域分离、签名者独立性于清理反模型、带符号 Integer／nonce 算术、
影子游标、抽象原生生命周期权威、原生派发激活／费用守卫，以及账户／阶段／帧的调用隔离。这些是
声明的抽象义务，不是完整的 NeoVM 或 C# 到 NEF 精化。其余非公开证明边界记录在
`docs/reports/sa-open-formal-boundaries-20261007.json`。

更早的原生集成工作树报告了一个已注册的 SmartAccount 实现，包括生命周期、延迟模块配置、依赖清理、
有界回调、确切的代理 Verification 与目标帧见证强制。那些结果属于那份历史源码／工件快照，不是
当前的原生合约回读。该快照的原生合约回执是
`docs/reports/sa-neoexpress-native-contract-after-configuration-20261006.json`；它是有界持久化生命
周期证据，不是完整原生一致性。源码／工件哈希与当前 node 套件结果记录在原生集成工作树的
`docs/reports/smartaccount-native-source-runtime-validation-20261006.json`。更早的仅组件回执仍是
历史证据，不是当前原生合约状态。签名代理回执
`docs/reports/sa-neoexpress-native-proxy-20261006.json` 增加六笔持久化交易（两笔预期 FAULT）与三次
准入拒绝，并带确切的见证／脚本与资产余额回读。原生 raw-call 桥覆盖为 100% 行／分支；原生合约
入口／执行覆盖同样为 100% 行／分支，模块管理为 100% 行、98.46% 分支。全部十个新的原生／组件
文件与插桩新增的引擎行都满足 90% 门禁。这不证明所有对抗路径或完整协议一致性。
`docs/reports/sa-neoexpress-native-recovery-20261006.json` 记录 25 笔持久化恢复／授权交易
（15 笔 HALT、10 笔预期 FAULT）与一次额外注册，带实际的单／联合 P-256 见证与完整的账户／游标
回读。这些是运行时检查，不是新的密码学或 WitnessRule 证明。

原生集成运行时现在由源码构建，而不是程序集叠加。最初的两目录离线构建与一次固定回执的两目录重放，
从 611 个源码文件与 50 个外部包归档编译十一个项目；全部 104 个运行时文件逐字节匹配。见
`docs/reports/sa-neoexpress-source-build-final-20261006.json` 与
`docs/reports/sa-neoexpress-source-build-replay-20261006.json`。确切重建的 core／VM 程序集也通过
全部 1,702 个 node 测试。原生合约、签名代理、配置、恢复与四个当前激活案例在同一运行时上再次
通过，且每个矩阵前后都完成运行时文件验证：
`docs/reports/sa-neoexpress-source-runtime-final-20261006/summary.json`。原始 raw 回执与带溯源注释
的副本分开保留。本次构建验证步骤中没有生产 C# 或形式模型发生变化。其 72 个脚本测试包括失败、
中断、recipe／依赖与运行时漂移控制。可复现性不是编译器精化证明、完整插件矩阵，也不是当前外部
依赖安全审计。

最后一次成功的固定容器运行覆盖更早的快照：17 个 Coq 模块、95 个被拒绝的语义变异体与 40 个
runner 测试。其回执是 `docs/reports/sa-formal-gate-20261006-native-integer.json`。更新的影子游标、
生命周期、派发、调用、会话与日限额改动只有 **主机证据**：Desktop 与 Colima 上下文都未返回成功的
有界守护进程探测。当前状态是 `HOST_PASS_CONTAINER_UNAVAILABLE`；更早的容器 PASS 不会复用于已
变化的模型字节。

### 历史custom 合约证据

历史故障即闭合的 SA 本地门禁在 2026-09-21 通过：**5 个 Coq 模块、72 条闭合声明、30 个被拒绝的
语义变异体、61,460 个 TLC 不同状态，以及 6 个 SMT 义务与 6 个控制**。主机运行与缓存基础镜像
Docker BuildKit 阶段中的同一份源码快照都通过；runner 回归套件 **20/20 OK**。这验证的是所声明的
抽象模型与算术义务，并不主张某个已部署 NEF 已被完整形式验证。

2026-10-08 的主机门禁通过 **5 个 Coq 模块、77 条闭合声明、32 个被拒绝的语义变异体、61,460 个
TLC 不同状态、6 个 SMT 义务与 6 个控制**，runner 测试 **23/23**。确切的源码／模型／工具哈希与
版本记录在 [`sa-formal-gate-20261008.json`](reports/sa-formal-gate-20261008.json)。Docker 门禁
未重跑；其固定值未变。

2026-10-08 的源码把 `public` 与私有 `PLATFORM` 执行分开。源码锁与每一条新的门禁结果都包含
`runtimeProfiles` 与 `modelProfiles`；runner 拒绝缺失或改变的作用域元数据。`VerifierGasBudget.v`
只适用于有界 `PLATFORM` 与原生回调。`public` 使用标准 `System.Contract.Call`，并且**没有**逐验证器
的子调用 gas 预算。`ProxyWitnessScript.v` 只建模custom public/private 直接调用解析器。原生特有的
生命周期、注册表、见证与模块模型标记为 `native`；只有共享的有界 MultiSig 策略抽象跨越全部
profile。custom 执行／逃逸模型、TLC 状态机与 uint256/paymaster SMT 文件仍属 public/private 合约
作用域。原生整数、生命周期与派发义务使用专门的原生模型。任何作用域标签都不确立源码／VM 精化或
部署一致性。

原生源码对应关系包含一份单独提供的 core 检出。`--native-core-root`（或
`NEOOS_NATIVE_CORE_SOURCE`）对完整门禁是必需的。其受复核的源码名册与哈希在证明前后都被检查；
缺失文件、多余文件、改变的字节或缺失溯源都会被拒绝。custom SmartAccount 合约源码从不被用作原生
SmartAccount core 源码的替代。`NativeAuthorityEpoch.v` 检查独立的有界计数器、无回调恢复、被撤销
的根／依赖／待处理意图、未变的身份／nonce／冻结状态、抽象的代际隔离与陈旧域拒绝。四参数的原生
执行信封在未签名交易中承诺两个计数器；其守卫适用于托管回退与原生交易见证，也适用于操作签名
验证器。即便见证证据谓词为真，该模型也拒绝旧的二参数元数与陈旧的显式计数器。命名空间为空要求
不向未来代际写入；字节编码与每个模块的独占使用需要独立的源码与运行时验证。下文的历史私有回执
不验证已改变的公开工件或当前源码；请针对正在复核的确切候选重跑门禁与字节码／运行时测试。

在形式验证工作区运行：

```sh
./verify.sh
./verify.sh --report
python3 audit-coverage.py --check-ledger
```

对于带源码哈希固定与语义变异测试的 SA 仓库本地门禁：

```sh
python3 formal/verify.py --native-core-root /path/to/reviewed/neo
python3 -m unittest discover -s formal -p 'test_*.py'
```

或者通过仓库入口点：

```sh
NEOOS_REQUIRE_FORMAL=1 ./scripts/verify_repo.sh --contracts-only
```

私有链验证是同一入口点的独立选择步骤（`--neoexpress` 或 `NEOOS_REQUIRE_NEOEXPRESS=1`）；它需要
`neoxp` 工具与 `openssl`，把每个工件部署到全新的 NeoExpress 链，用真实交易驱动协议，并通过
JSON-RPC 回读每份合约。

本地门禁在检查之前作废任何先前结果，拒绝源码哈希漂移，要求真实的 Coq/Z3/TLC 执行，检查最终
TLC 状态计数与动作覆盖，拒绝仅语法层面的变异体，并把工具／工件哈希记录在被忽略的 `formal/.runs/`
下。

门禁需要 Coq 8.16 或更高（包含 Rocq 9；模型使用可移植的 `From Coq` 导入路径，Rocq 9 接受它但会
给出弃用警告）、Z3、一个 JDK 与 `tla2tools.jar`。在 macOS 上 `/usr/bin/java` 是一个无法运行 TLC
的桩；runner 会跳过它并探测常见的 JDK 位置，或显式设置 `JAVA_BIN`。`TLA_JAR` 覆盖默认的
`~/tools/tla/tla2tools.jar`。没有主机工具链时，改用固定的环境运行：

```sh
formal/verify-in-docker.sh
```

它会构建 `formal/Dockerfile`（Ubuntu 24.04、Coq 8.18、Z3、OpenJDK、按固定 SHA-256 校验的 TLA+
工具 jar），并在其中运行门禁与 runner 的回归测试。先前 2026-10-06 的运行在固定的 `linux/arm64`
镜像中通过：17 个模块、95 个语义变异体、61,460 个 TLC 状态、6/6 个 SMT 义务以及 **40/40 OK** 的
runner 测试。其原始结果保留在 `formal/.runs/docker-20261006-native-integer-v1` 下；更早的
2026-09-21 结果仅为历史。如果 Docker 注入了 localhost 代理，包装器接受
`AA_FORMAL_HTTP_PROXY` 与 `AA_FORMAL_HTTPS_PROXY`，以显式传入主机可达的构建代理。兼容性主张
（模型只使用 Coq 8.16 以来就存在的 `List`、`Bool`、`PeanoNat`、`ZArith` 与 `Lia` 引理）已针对
那些更早的模型字节在 Rocq 9.2 与 Coq 8.18 上演练。最新的影子游标、生命周期、派发、调用、会话与
日限额增项目前只有主机证据。当前主机 TLC jar 在
`docs/reports/sa-formal-tool-provenance-20261007.json` 中有独立溯源；可变的上游资产已不再匹配保留
的 Docker 固定值。主机 PASS 不确立当前容器 recipe 的成功构建或运行。

**CI 状态：** `.github/workflows/ci.yml` 运行 `scripts/verify_repo.sh`，而后者除非提供 `--formal`
或 `NEOOS_REQUIRE_FORMAL=1`，否则不运行形式门禁，且 CI 镜像既不提供 Rocq 9 也不提供 TLA 工具。
因此该门禁是本地／发布义务，`verify_repo.sh` 在跳过时打印显式的 `formal gate: NOT RUN` 行，使这一
缺口在每份 CI 日志中可见，而不是被绿色运行所暗示。

## ABI 投影接受义务

结构性 ABI 证书必须比较完整描述符（方法名、有序参数类型、返回类型与 safe 标志），而不只是计数
或单方向的成员性。期望的核心表面是声明的公开 C# 表面，加上恰好一个编译器生成的 `_initialize`
描述符，零参数、`Void` 返回、`safe = false`。方法顺序无关紧要；派发键 `(name, arity)` 在两侧都
必须唯一。每个期望方法都必须出现，每个 manifest 方法都必须被期望。仅基数相等无法确立这一点：
一个重复方法可以替换一个缺失方法。

`AbiManifestProjection.v` 建模这种与方法顺序无关的有限检查。其描述符包含有序参数类型列表，显式
元数必须等于这些列表的长度。经内核检查的负向控制拒绝改类型、参数重排、不一致元数与非空
initializer 参数。类型标识符是抽象的；它们与具体 C# 及 manifest 类型的对应仍是外部义务。运行时
回归必须拒绝缺失、多余、重复、改类型与改标志的方法，同时接受重排的描述符。偏移针对严格的 NEF
解码器单独检查。该检查对有限 ABI 名册具有二次列表匹配成本；它既不改变链上行为也不改变工件格式，
且无需部署或迁移。其证明只涉及 ABI 对应关系，不涉及已编译指令的行为。

已注册的 `NeoVmContinuationSemantics.v` 模型拒绝零与超大回调上限，并原子地收取当前预算与每个祖先
的预算。有界返回恢复已扣款的父级；普通 CALL、CALLT 与 `LoadScript` 帧共享同一条预算链。
父 100／子 10／收取 3 的回归以 97 返回，并准入后续 20 的兄弟预算。该模型把 `_initialize` 视为
每次加载的上下文，建模保存的返回地址，故障即闭合地应用分叉门禁，并在不回退已消耗 gas 的情况下
回滚存储。显式收费抽象掉了操作码价格、交易费用与运行时调度。这些是有界语义义务；它们不构成
完整的 NeoVM／ApplicationEngine 或编译器精化证明。

SMT nonce 模型检查与整个可执行 nonce 域的相等性，其正向控制在零与 `2^255 - 1` 处使用同一个接受
谓词。可执行回归变异体覆盖全拒绝、缺失边界值与域外准入；从不调用该接受谓词的独立 SAT 例子不足以
作为接受集非空的证据。这些修正后的模型取代历史 2026-10-13 回执中对应的模型字节；那份回执不是这些
修订的证据。

运行时套件还针对故障感知的引用关系，在读取状态权限与调用深度 0 到 2 上，对固定的 1,032 案例有限
见证条件树语料做差分检查。这加强了具体实现对应关系，但仍是有界测试证据，而不是机械化的
`ApplicationEngine` 精化。

## SA 工件

### 证据验证要求

重建证书必须把 scratch 构建哈希标注为 `fresh_artifact_sha256`，把本地候选哈希标注为
`release_artifact_sha256`，比较失败时也要如此。两份完整映射（包含 manifest 与重复的插件输出
路径）必须彼此一致，并与当前发布目录一致，溯源联结才接受 PASS 回执。仅有布尔 PASS 字段不是字节
相等的证据。缺失文件、多余文件、矛盾的判定与改变的字节都必须故障即闭合。这些是对本地文件的线性
时间完整性检查，不是编译器证明或签名证明的替代。

核心 ABI 对应测试把公开静态 C# 方法签名与 safe 标志同 NEF manifest 比较，排除 CLR 事件访问器，
并显式包含生成的 `_initialize` 方法。这只是结构性测试；它不确立指令级等价。验证器域重放测试必须
包含使用同一密钥的正向控制：拒绝每个签名不足以作为域分离的证据。

### 见证求值器对应关系

解析器到求值器的证明义务是从被接受的 condition 推导出足够的求值燃料，而不是要求外部提供
`Enough` 证书。对建模的深度上限三与扇出上限十六，`F(0) = 1` 与 `F(d + 1) = 17 + F(d)` 给出
condition 的保守界 52，规则遍历则为 `52 + length(rules)`。该燃料是模型的终止度量，不是 NeoVM
指令或 GAS。门禁必须拒绝解析器边界或燃料递推的改变；证明这些边界并不认证具体的二进制／JSON
解析器或编译器。

私有工件溯源检查器必须先用 NEF 框架解析，再把其 script 作为回读证据：所有字段都必须在校验和
之前适配，保留字节必须为零，可变长度与 token 字段必须有效，script 必须非空，且必须恰好剩下四个
校验和字节。仅有哈希匹配不是有效 NEF 的证明。这些结构检查仍与指令解码、ABI 检查与编译器精化
分开。

布尔 WitnessRule 模型只在允许 group-state 读取时描述求值。故障感知扩展必须区分返回 `false` 的
condition 与求值故障：`Group` 与 `CalledByGroup` 要求 `ReadStates`，在没有调用合约时也是如此。
`Not` 必须保留故障；`And`、`Or` 与首匹配规则循环必须保留 Neo 的从左到右短路行为。较晚的 allow
规则不得掩盖较早 condition 的故障。

对应义务是显式的。`WitnessRuleRefinement.v` 现在为其解析器谓词接受的每棵树构造性地推导燃料证书。
condition 与规则列表的精化定理只要求解析器可准入性与 `ReadStates`，而不是外部的 `Enough` 假设。
两个模型解析器谓词由 runner 回归测试比较，以拒绝形状漂移。另有五个语义变异体覆盖扇出、非空性、
深度、规则 condition 深度与燃料不足。具体引擎测试覆盖两种权限设置、全部 condition 种类、无调用方
案例、入口／直接／深层调用上下文，以及显式规则之前的作用域扩张。二进制／JSON 解析器回归演练空、
单子、十六子与十七子复合，外加一个全宽三层树及其最后一个后代中禁止的第四层。这闭合了声明的结构
求值器精化；它仍不同于机械化解码器或完整 `ApplicationEngine` 精化、交易签名验证、已验证的
manifest-group 签名，或整个 NeoVM。

`formal/` 下 SA 仓库本地的副本是 `formal/verify.py` 编译、模型检查并做变异测试的工件；同仓工作区
在 `verified/` 下携带相同模型，供其自己的 `verify.sh` 使用。

| 工件 | 作用域 |
|---|---|
| `formal/coq/SmartAccountAA.v`（同仓：`verified/coq/`） | 针对授权、确切通道 nonce 使用、回滚、重入、逃逸所有者门控、仅成功状态转移，以及“缺失的 hook／验证器不能让回调阶段失败”这一规则的闭合 Coq 证明 |
| `formal/coq/MultiSigPolicy.v` | **仅公开 V3/PLATFORM：** 有界十字段配置、确切签名基数与阈值支持；子项身份是抽象的 |
| `formal/coq/CustomGovernance.v` | **公开 V3/PLATFORM 源码候选：** 独立于调用方的所有者见证取消、确切毫秒延迟、待处理轮换与回滚；绑定／身份有效性是前提 |
| `formal/coq/CustomSponsorship.v` | **公开 V3/PLATFORM 源码候选：** 交易级累积预留上限、请求界、零费用估算控制与失败回滚；没有存储／费用／VM 精化 |
| `formal/coq/CustomRecovery.v` | **公开 V3/PLATFORM 源码候选：** 无回调恢复与不可逆的仅所有者锁存，并带投影的身份／nonce 保持；没有存储或全入口点精化 |
| `formal/coq/NativeCompositePhase.v` | **仅原生 ABI 2：** 首阈值选择、单操作回执所有权与丢弃、已批准子项授予、全活跃固定，以及 3/2/2/3 界下的前／后策略相等；没有字节复制、哈希、密码学或 gas 可行性精化 |
| `formal/coq/ProxyWitnessScript.v` | 代理见证交易脚本解析器的字节级模型（`ScriptIsSingleExecuteCall`、`ScriptPrefixIsDataPushes`、`DataPushInstructionSize`）：被接受的脚本是一段 data-push 行走，恰好落在期望的直接 `executeUserOp`/`executeUserOps` 调用及其双参数 pack 上，该行走中的每个指令起点都是 data-push 操作码（因此核心调用之前没有 SYSCALL/CALL/JMP/TRY），接受会绑定账户 id 与核心哈希，规范形状可达，而前导非 push 操作码、外来账户 id、越界 CallFlags push 与尾随指令都会被拒绝 |
| `formal/coq/CallbackPluginTopology.v` | 六字段 hook 回调元组、已配置与缺失回调阶段、成功／回调顺序、CalledByEntry/Custom 目标绑定，以及故障即闭合的插件清理／轮换的闭合抽象对应模型；它不是 NeoVM 派发或任意插件存储的证明。它固定的元组即 `BuildHookOperationParams(UserOperation, object[])` 产出的那一个，而该构造器在 v4 中不存在：v4 的 hook 是经由 `CallHookPreCheck` ／ `CallHookPostCheck` 触达的模块回调，目前没有任何 Coq 产物对其建模 |
| `formal/coq/VerifierGasBudget.v` | **仅有界 PLATFORM／原生 profile：** 有界回调收费的闭合抽象模型：每次收费在变更之前检查回调与全部祖先预算，耗尽具有原子性，嵌套回调无法逃出祖先上限；不适用于 `public` |
| `formal/coq/AuthorizationEvidence.v` | 针对密码学、原生见证、证明与证明证据的闭合协议级绑定与重放模型；原始有效性是显式 oracle，因此这不是 ECDSA、见证规则求值、证明或 ZK 健全性的证明 |
| `formal/coq/AttestationProofBinding.v` | 证明与零知识证据的闭合协议信封模型：账户、目标、nonce、发行方、度量承诺、非零 nullifier 与单次使用绑定；原始密码学与证明有效性仍是显式 oracle 输入 |
| `formal/coq/WitnessRuleSemantics.v` | Neo 首匹配规则决策、默认拒绝、allow/deny 优先级、入口／直接子项作用域、condition 组合，以及解析器深度／子项限制的闭合有界模型；它不是 `ApplicationEngine` 或 group-key 密码学的精化证明 |
| `formal/coq/WitnessRuleFaultSemantics.v` | `ReadStates` 故障、从左到右 And/Or 短路、经 `Not` 的故障传播与首匹配故障行为的闭合燃料有界模型；具体引擎测试覆盖对应的权限与作用域路径 |
| `formal/coq/WitnessRuleRefinement.v` | 从解析器可准入的故障感知 condition／规则求值到可读权限下布尔模型的闭合精化；统一的燃料证书是推导出来的而不是外部提供的，且不精化二进制／JSON 解码器或完整 `ApplicationEngine` |
| `formal/coq/NeoVmCallSubset.v` | 代理相关 push/PACK/contract-call/RET 子集的闭合有界转移形状模型；它拒绝不安全前缀、截断尾部与尾随指令，但不是完整的 NeoVM 或 `ApplicationEngine` 语义 |
| `formal/coq/NativeAuthorityEpoch.v` | 原生 ABI 2 对受检查独立计数器、无回调恢复、被撤销的根／依赖／待处理意图、代际隔离与陈旧签名域的抽象；排除 VM／字节键精化，并假设不向未来代际写入 |
| `formal/coq/NeoVmContinuationSemantics.v` | 回调上限准入、CALLT/RET 续延、`LoadScript` 预算继承、每次加载初始化、分叉门控、祖先收费与仅存储回滚的闭合有界模型；它不是完整 VM 或编译器精化证明 |
| `formal/coq/AbiManifestProjection.v` | 闭合的有限、顺序无关 ABI 投影模型，要求确切的源码／manifest 覆盖、唯一的 `(name, arity)` 派发键、参数／返回／safe 相等，以及生成的 initializer |
| `formal/coq/SignerDomainSeparation.v` | 要求确切授权域与载荷相等的闭合绑定模型；它拒绝跨域重放，但不证明私钥独立性或原始密码学健全性 |
| `formal/coq/SignerIndependence.v` | 闭合的有限反模型，表明不同的公开签名者域并不蕴含私钥独立性；这是显式的信任边界证明，不是密钥生成证明 |
| `formal/coq/PluginLifecycle.v` | **仅原生 profile：** 闭合的有限反模型，表明生命周期 ABI 并不蕴含对任意未来插件存储的完整清理，外加针对已认证清理函数的条件定理；custom V3 生命周期主张仍是运行时／工件证据 |
| `formal/tla/SmartAccountAA.tla`（同仓：`verified/tla/`） | Begin／成功／失败／Tick 转移的有限状态机探索 |
| `formal/tla/SmartAccountAA.cfg` | TLC 边界与安全不变量 |
| `formal/smt/aa_core.smt2`（同仓：`verified/smt/`） | Nonce 算术、游标推进、回滚等式、报销上限与预算算术 |
| 同仓的 `reports/sa-formal-20260918/README.md` | 人类可读的结果与边界报告 |
| `formal/verify.py` | 带源码固定与语义变异体的 SA 本地故障即闭合 runner |
| `formal/Dockerfile`、`formal/verify-in-docker.sh` | 固定的 Ubuntu 24.04 环境（Coq 8.18、Z3、OpenJDK、按 SHA-256 固定的 TLA+ 工具 jar），使独立复核者无需主机工具链即可运行同一门禁 |
| `formal/test_verify.py` | Runner／解析器的故障即闭合回归测试 |
| `formal/source-lock.json` | 受复核的源码快照哈希；不是证明佐证 |

### 重命名与余量断言之后的源码固定刷新

`formal/source-lock.json` 当前固定 56 个源码文件。下文的历史重命名刷新固定了 59 个源码文件。其中
35 个固定值相对工作树已经陈旧，`formal/verify.py` 在运行任何 Coq 或 TLC 泳道之前就以
`Source drift: Directory.Build.props` 故障即闭合。只有在把 35 个逐一分类之后才刷新了固定值：

- **31 个文件只是重命名。** 在此前固定的内容中把 `SmartAccount` / `UnifiedSmartWallet` /
  `abstract-account` 替换为 `SmartAccount` / `smart-account`，即可逐字节复现当前文件，因此对应
  陈述未变。
- **`SmartAccount.Paymaster.cs` (retired custom kernel)** 增加了 73 字节的 VM 整数余量断言（`vmMax` 加上
  `budget.Reserved <= vmMax - settled`）。该断言位于完整上下文证书所建模的 helper 内部；精化泳道
  证明该守卫在合法域上成功（`legal_update_fits`、`vm_leb_margin_of_fits`），所以固定的对应关系
  对新文本仍然成立。
- **`SmartAccount.State.cs` (retired custom kernel)** 只改变 `AccountImplementationId` 字符串常量，没有可执行
  逻辑。
- **`formal/verify.py` 与 `scripts/verify_repo.sh`** 携带相同的重命名，以及针对被重命名模型的
  变异体表条目；该差异既不增加也不删除任何 `require(...)` 调用，因此没有放宽门禁断言。

本次刷新针对受复核的字节重新佐证了手工对应快照。它没有清偿任何未闭合义务，也没有改变任何证明：
上文列出的公开、运行时、gas 与 ABI 精化边界仍然开放，`implementationVerified` 保持 false。

### 见证条件深度对应关系

解析器深度预算计入每个 condition 节点，包括叶子。在预算三处，`Not(Not(Boolean))` 有效，而
`Not(Not(Not(Boolean)))` 无效。二进制与 JSON 解析都在预算为零时拒绝任何节点。模型必须在按
condition 种类派发之前应用该检查，而不只是在经 `Not`、`And` 或 `Or` 下降时才检查。运行时回归
向量在该边界及其之外覆盖两个解析器，形式变异门禁必须拒绝移除零深度守卫。这是有界的解析器形状
对应关系，不是完整交易解码或密码学的证明。

当前基于 `master-n3` 的 Neo 有界调用核心分支也通过了完整的 1,453 个测试的 `Neo.UnitTests` 套件，
包括 26 个 `WitnessCondition` 测试与 150 个 `ApplicationEngine`／interop 测试，覆盖调用方上下文、
调用权限、有界回调、Huyao 计价与 RET 记账路径。只读结果记录在
`docs/reports/sa-neo-core-semantic-validation-20261006.json`；这些测试加强了实施证据，但不替代
缺失的机械化完整语义或编译器精化证明。

## 安全边界

### 验证器资源边界状态

私有 `PLATFORM` 源码分支与 `contracts/bin/platform` 核心通过
`System.Contract.CallWithGasLimit` 调用验证器，回调预算为 1,000,000,000 datoshi（10 GAS）。公开
`contracts/bin/public` 使用标准 `System.Contract.Call`：验证是只读的，执行后记账保留写访问，两个回调
都没有隔离子调用预算。输入边界、交易总 gas 上限与模块准入都不能提供缺失的公开运行时能力。

历史匹配的 Neo core/DevPack 运行时在 `HF_Iara` 处激活该私有系统调用；普通嵌套调用与有界后代消耗
祖先链，白名单收费无法绕过它。隔离核心通过 9/9 个定向向量与 1,435/1,435 个完整单元测试。一条
全新的私有 NeoExpress 链在第 0 块激活该分叉，把对抗性的耗 gas 验证器驱动到
`Contract call gas limit exceeded`，确认 nonce 回滚，并以逐字节相同的 NEF script 与匹配的
manifest 回读全部 25 个部署工件。这只对匹配的私人工件闭合 VULN-001；没有执行任何公开激活或部署。
当前回执是 `docs/reports/sa-platform-gas-cap-20260921.json` 与
`docs/reports/sa-neoexpress-gas-cap-20260921.json`。

原生 ABI 2 在源码构建的 SmartAccount 运行时上另行把验证器回调固定为 100,000,000 datoshi，把
hook／维护回调固定为 250,000,000 datoshi。有界 gas 模型使用抽象预算参数；它不确立完整 VM 费用
记账。

这些模型不证明密码学、具体的见证规则解析器或 `ApplicationEngine` 实现、完整 Neo VM 语义、C# 到
NEF 回调精化、会话生命周期、paymaster 策略解析，或 C# 到 NEF／已部署字节码的等价性。
`NeoVmCallSubset.v` 与 `NeoVmContinuationSemantics.v` 只闭合与代理及 SmartAccount 回调边界相关的
有界转移与回调预算义务；它们刻意不被呈现为完整 VM 语义。源码到工件证书另行闭合私人工件的重建
溯源与字节漂移，但不闭合编译器正确性。

MultiSig 模型另行证明有限策略层：非空、至多十、非零／不同的子项标识符、阈值边界、确切签名数组
基数、阈值支持，以及为已批准子集保持不同的签名者域投影。具体 profile 现在从每个协议定义的叶子
获得规范的 32 字节签名者域承诺，在配置时拒绝重复承诺，并在验证与子项执行后之前重新检查它们。
这为那些 profile 闭合了意外的已配置密钥复用。它不证明私钥独立性、密码学正确性、见证规则求值、
任意第三方插件的诚实行为，或完整子调用精化。运行时套件在 2-of-2/1-of-2/原生见证向量之外增加域
复用负例与配置后复验向量；这些仍是有界 VM 证据，而不是完整 NeoVM 或密码学证明。策略模型也证明
其抽象的回调后名册是唯一、已配置且受阈值支持的；这仍与具体回调精化分开。
原生侧的 threshold-policy 源码守卫及其有界配置／接受模型已于 2026-11-22 从本地门禁退役：
阈值策略所有权已迁出原生内核、移至用户空间 `contracts/modules/ThresholdPolicyModule`，
原生内核不再声明、存储或执行阈值、成员集或批准计数。抽象的 `MultiSigPolicy.v` Coq 模型
仍仅作为 public/platform 的编译与变异证据；门禁不再主张任何活的原生 threshold-policy 源码对应。

对于已部署的custom public/PLATFORM profile：

清理模型证明故障即闭合的状态转移，而不是恢复可用性：`finalizeEscape` 仍依赖旧验证器与 hook 的
成功清理。2026-10-08 的源码在这些回调之前验证替换验证器，但没有引入紧急脱离，也不保证越过恶意
旧模块取得进展。`CallVerifierChild` 及其显式的 `getChildVerifierConfig` 能力不存在于已部署核心
manifest（`contracts/build/SmartAccount.manifest.json`）中，尽管它们记录在源码快照中并在 NeoVM
中测试过；两者都在当前抽象模型之外。那些模型不证明这条新路径的子配置 ABI、核心／拓扑绑定、
待处理调用序列化或时间锁强制。项目文件与 profile 构建 recipe 也被固定，因此改变源码选择会使快照
失效。哈希固定不是这些实现属性的证明。MultiSig 模型另行只证明有限策略层：非空、至多十、非零／
不同的子项标识符、阈值边界、确切签名数组基数与阈值支持。它不证明子项标识符代表独立密钥、子验证器
在验证与执行后之间保持一致，或序列化与子调用在 gas 耗尽下安全。运行时套件增加负向配置向量与
2-of-2/1-of-2/原生见证向量；这些仍是有界 VM 证据，而不是完整 NeoVM 或密码学证明。策略模型也
证明其抽象的回调后名册是唯一、已配置且受阈值支持的；这仍与具体回调精化分开。其列表与回调字段是
抽象值。防止子项篡改另一子项参数或结果的具体保护取决于实现的深快照与 NeoVM 回归向量；模型不证明
序列化或引用隔离行为。`MultiHook` 对每个叶子 post-hook 应用相同的结果快照边界，一个专门的 NeoVM
向量验证一个 hook 无法改变下一个 hook 观察到的业务结果；这仍是运行时证据，不是形式序列化或回调
精化证明。本地运行时套件确实检查了具体的会话密钥顺序规则：`clearSessionKey` 执行之后，后续
`validateSignature` 因没有活动密钥而故障，且清除会发出 `SessionKeyRevoked`。这不会取消一笔已更早
排定的交易，也不提供内存池失效。

协议边界现在在实现与提案中都是显式的：非零有效目标、方法长度 1--128 个 UTF-8 字节、参数个数
至多 64、规范参数序列化至多 4096 字节、签名至多 1024 字节、非空批量至多 32 个操作，以及位于非负
signed-256 位域（`0 <= value < 2^255`）的 nonce／截止时间。因此一个可执行 nonce 有 191 个通道位，
而不是 192 个。当前custom 源码对 `getNonce` 读取应用相同的 signed-VM 边界。一个历史已部署的基础工件
在重新发布之前可能仍准入更宽的 unsigned-192 位查询范围；这不会让那些上半通道变为可执行，也不是
原生 profile 一致性。原生编解码器拒绝位于或高于 `2^191` 的通道。

custom 执行模型把回调谓词的作用域限定在已配置模块上：缺失的 hook 或验证器没有能够拒绝操作的
回调阶段，而已安装模块必须正常返回。这在抽象模型中闭合了此前隐含的 `hookInstalled` 状态。回调
非干扰性、回调存储隔离，以及这些谓词到具体 NeoVM 故障的对应关系仍是分开的运行时义务。

SA 核心拒绝负值与超宽值，而 VM 本身把 Integer 限制为带符号 32 字节表示。更早的文档错误地把一个
数学上的 unsigned-256 模型提升为确切的 VM 域对应关系。`NativeIntegerDomain.v` 现在证明可表示范围、
191/64 位分解与组合、固定宽度键的高位不变量，以及无回绕的 `2^64` 耗尽哨兵。同一模型现在还证明
影子游标通道隔离与即时重放拒绝，并有正向的顺序／交错通道例子与负向的空隙／耗尽例子。全部 24 条
声明都是闭合的，七个语义变异体被拒绝。该算术模型不证明 VM 构造子、序列化器或 C# 到 NEF 编译器
正确。

本地运行时对应套件也是有界证据：十四个测试通过，涉及假返回消耗、重放／空隙拒绝、目标故障回滚、
批量回滚、重入回滚、操作形状边界与高通道 nonce 路由、畸形字段拒绝、nonce 查询边界与最大批量。
它只执行本地编译的 NEF；它本身不确立已部署字节码一致性。新的 node 测试独立确认 `2^255 - 1` 可
表示、`2^255` 被 Integer 构造与脚本生成同时拒绝，且原有的身份／签名向量未变。五次全新的私有
NeoExpress `StdLib.deserialize` 模拟确认了带符号表示边界与可表示的耗尽哨兵；其回执是
`docs/reports/sa-neoexpress-native-integer-domain-20261006.json`。它们是 RPC 模拟，不是持久化的
SmartAccount 操作，也不是原生 `SmartAccount` 存在的证据。

原生信封组件只解析有界惰性 initializer，验证每个操作，并要求与固定的
native/account/method/flags/syscall 后缀逐字节规范重编码。它保留 Boolean 与 Struct 类型，并在返回
操作之前对其快照。104 个聚焦 node 测试包括 96 个生成的 VM 比较与 512 个确定性字节变异，以及
截断、替换、深度、大小与影子游标案例。三个独立编码的 fixture 同时匹配 node 构造器／解析器与私有
NeoExpress 序列化。三个语义等价但非规范的 initializer 在 NeoExpress 中成功执行，并被 node 解析器
测试分别拒绝。私有回执是 `docs/reports/sa-neoexpress-native-envelope-20261006.json`。这些是有界
运行时检查，不是机械化的解析器／VM 精化或原生合约测试。

具体运行时边界现在还有额外的有界证据：代理见证套件拒绝错误账户调用与单核心调用形状周围的非数据
指令，一次真实的 `WhitelistHook` VM 执行确认规范回调元组
`[TargetContract, Method, Args, Nonce, Deadline, Signature]` 到达 hook 路径。未列出的目标在目标派发
之前故障，nonce 保持不变。这些向量演练了受检查的 NeoVM 实现；它们不是对所有见证条件、脚本解析器、
VM 或任意插件行为的形式证明。同一套件在 nonce 消耗或外部派发之前拒绝超大验证器签名与超大参数
数组。这些边界降低输入放大风险，但不替代不可绕过的逐验证器 gas 预算。

代理见证交易脚本形状现在由闭合的 Coq 模型覆盖，而不只是运行时向量。`formal/coq/ProxyWitnessScript.v`
建模解析器的操作码表、PUSHDATA 长度解码、越界检查、尾部布局与 CallFlags push 范围，并证明任何被
接受的脚本都是一段 data-push 指令行走，恰好落在给定账户 id 与核心哈希的期望核心调用上；该行走中
没有任何指令起点是 SYSCALL 或任何其他非 push 操作码；接受会唯一绑定账户 id 与核心哈希。该模型
只允许两个直接入口点：`executeUserOp`/`executeUserOps` 要求 `PUSH2 PACK`。两个受赞助方法名都被
显式拒绝，包括正确打包的五参数信封与双参数伪装。这些负例被编译并经过假设审计；它们保持了“受
赞助结算回调尚未被授权复用代理见证”这一边界。八个语义变异体（丢弃前缀行走、账户或核心绑定、
flags 范围、方法／元数绑定、放宽入口点白名单、移除系统调用尾部，或把未知操作码当作 push）都被
拒绝。它不证明 NeoVM 自身的指令解码、见证规则求值、签名者作用域语义或 C# 到 NEF 精化，且字节
范围 0..255 是从 C# 类型假设的。

另外三条运行时边界现在由真实 NeoVM 向量而不是散文固定。第一，备份所有者的
`forceCancelMarketEscrow` 与市场驱动的 `cancelMarketEscrow` 先通过
`ContractManagement.GetContract` 对市场做预检，只在 manifest 声明该方法时才调用 `abandonListing`；
没有该方法的市场（由一个能布置托管但不暴露 `abandonListing` 的合约建模）不再让逃逸故障，抛出
异常的市场也被容忍。在自身 `abandonListing` 内部中止的市场仍在此保证之外，因为 NeoVM 不提供
`ASSERT`/`ABORT` 的可捕获形式；这样的市场已经对被托管账户拥有无条件结算权威。第二，
`SocialRecoveryVerifier` 实现了强制的 `clearAccount` 生命周期方法：离开它之后的
`confirmVerifierUpdate` 与 `finalizeEscape` 现在成功，账户作用域的恢复记录被清除，任何专门预留的
oracle GAS 退还恢复所有者；记录为已部署到公开网络的恢复验证器工件早于该方法。第三，
`SubscriptionVerifier` 要求转账来源是核心派生的代理资产地址；来源为 `accountId`（永远不可能持有
余额）的拉取会被拒绝。核心自身的模型不受影响：市场托管与插件生命周期在抽象执行边界之外，且固定
的源码哈希未变。

MultiSig 扩展之前的本地 SA 运行时套件通过 **257/257**。单独的会话密钥回归证明先清除再验证的失败
与 `SessionKeyRevoked(accountId)` 通知。核心与会话密钥 profile 的两次独立 `nccs` 3.9.1 编译逐字节
相同；源码／工件哈希与显式的公开部署一致性状态记录在
`docs/reports/sa-protocol-security-build-20260918.json`。对已知规范 TestNet/MainNet 哈希的只读检查
发现了不同的 NEF script；当前工件尚未公开部署。

在提供同仓 NeoDIDRegistry 工件时，历史原生原型合约运行是 **368 通过、0 失败、0 跳过**；在独立
检出中是 **366 通过、0 失败、2 跳过**。它是在添加 MultiSig 配置、故障即闭合清理、见证形状、hook
回调 ABI、输入形状边界、市场逃逸预检、恢复验证器清理、订阅转账来源、Studio 源码镜像、模块生命
周期 ABI、MultiSig 子项预检与 MultiHook 子项预检向量之后得到的。模块绑定现在针对完整 V3 生命
周期表面对已部署 manifest 做预检，包括确切的参数／返回类型与安全的布尔 `supportsV3` 与
`supportsComposition` 标记；仅有标记或类型错误的验证器或 hook 会在其地址被存储之前拒绝。MultiSig
与 MultiHook 是显式复合体，不能作为子项嵌套。核心拥有的依赖注册表记录叶子子项，在替换之前清除
被移除的子项，并在最终移除之前清除全部已注册叶子；子项故障会回滚包含它的改动。这些是 ABI／部署
与生命周期边界保证，不是“所声明的子方法在密码学上独立”或“任意未来插件具有正确存储语义”的证明。
两个独立检出跳过项是未提供同仓工件时的跨仓库 DID 案例；带该工件的必需 NeoExpress 运行记录在
下文。深度一拓扑定理证明一个被接受的随附复合体只有叶子子项，因此对该 profile 排除了递归组合与
环；它不证明任意未来插件的行为。形式门禁本身在 2026-10-06 针对最新源码固定值重跑：17 个 Coq
模块，包括故障感知 WitnessRule 语义及其构造性结构精化、确切 ABI 投影、有界回调续延语义、确切的
签名者域／载荷绑定、显式的签名者独立性与未来插件清理反模型、有界 MultiSig、授权、证明／证明信封、
WitnessRule 与 NeoVM 调用／返回子集模型、带符号 Integer／nonce 算术、源码快照门禁，以及 98 个被
拒绝的语义变异体；其 runner 回归套件为 41/41。当前主机回执显式保留不可用的容器重跑，是
`docs/reports/sa-formal-gate-20261006-native-envelope.json`。runner 自己解析可用的 Java 运行时
（显式 `JAVA_BIN` 被逐字尊重；否则用 `-version` 探测 `JAVA_HOME`、macOS 定位器、Homebrew OpenJDK
keg 与 `PATH`，并跳过 macOS 启动桩），因此在装有 JDK 的机器上，早先由该桩导致的 `UNAVAILABLE`
复验判定不再复现。更早一次针对修复后核心、MultiSigVerifier 与 MultiHook 的私有 NeoExpress 定向
部署，通过 RPC 匹配了每份本地 NEF script 与 manifest；见历史记录
`docs/reports/sa-neoexpress-readback-20260920-current.json`。这只是本地链回读。只读的公开比较发现
已知规范 TestNet/MainNet 工件与当前本地工件不同；部署当前工件仍是单独的、需审批的门控操作。

2026-10-06 的一次完整私有链验证（`scripts/neoexpress_validate.py`，通过
`scripts/verify_repo.sh --neoexpress` 选择加入）把全部 24 个 `contracts/bin/public` 工件加同仓
`NeoDIDRegistry` 工件（共 25 次部署）部署到全新的单节点 NeoExpress 链，用 106 笔 HALT 与 2 笔
FAULT 的持久化交易驱动 14 个场景（38 个预期负例，其中 36 个为预检拒绝），检查 84 条链上断言，
推进 5,619,600 秒模拟区块时间，并通过 JSON-RPC 以逐字节相同的 NEF script、匹配的校验和与语义
相等的 manifest 回读全部 25 个部署工件。DID 工件还与其同仓构建逐字节比较，并用于代理见证场景。
回执是 `docs/reports/sa-neoexpress-validation-20261006.json`。这些场景覆盖原生备份所有者执行及其
nonce 通道、重放、见证、截止时间与大小边界；带冷却与时间锁的逃逸通道；白名单 hook 回调元组；
对每个插件的生命周期 ABI 预检；有界对抗性 hook 与验证器回调；带真实 P-256 签名的仅中继会话密钥
提交；裸 P-256 WebAuthn 与 TEE 载荷向量、委派 ZkLogin 提供方／nullifier 绑定，以及故障即闭合的
禁用 ZKEmail 证明处理；受赞助结算，其私有提交前估算与持久化 gas 精确到 datoshi；恢复验证器轮换
及清理与 oracle 信用退还；MultiSig 与 MultiHook 子项预检、仅叶子组合与分离清理；一次市场出售、
一次所有者逃逸与一个静默市场；来自代理资产地址的订阅拉取；以及一笔手工构造、P-256 签名的交易，
携带真实代理验证脚本与 `WitnessRules` 签名者，它消耗了一张 NeoDID action ticket，并证明了重放与
重定向拒绝。更早的私有链迭代发现了单元套件未发现的三个缺陷：报销上限最初让提交前估算容器故障；
第一个修复把系统费低估了其提前返回所跳过的指令；商户拉取需要一个能到达验证器的签名者作用域
（见 `SECURITY_MODEL.md`）。最新回执记录修正后的实现，包括独立有界的验证器与 hook 回调，且仍是
本地链证据；它不确立公开部署一致性。

自动门禁在 2026-10-05 用已安装的 NeoExpress 3.10.1.18 runner 重试过。那次不兼容的尝试保留为
`docs/reports/sa-neoexpress-validation-20261005-unmatched-runner.json`，但不是发布证据：它缺少有界
调用系统调用，并针对 `System.Contract.CallWithGasLimit` 的 interop 哈希以 `KeyNotFoundException`
故障。随后用匹配的私有 NeoExpress 3.10.1.20+59ee6e2d43 构建重跑了完整运行。它通过全部 14 个
场景，那次带日期运行的发布合格回执是
`docs/reports/sa-neoexpress-validation-20261006.json`；该 runner 的等价回调故障措辞由验证器归一化，
并未放宽任何其他预期故障匹配。

作为独立的运行时检查，同一 14 个场景在 2026-10-06 用本地构建的 NeoExpress runner（来自提交
`da143f8643ebca7841cc7f56e4e3e00293819fbc`，链接到匹配的私有 Neo、RPC-server 与 DBFT 包）重跑。
该 runner 执行全部 25 次部署、持久化 108 笔交易、完成 84 条断言，并通过 JSON-RPC 回读全部 25 份
合约，`releaseEvidenceEligible: true`。该 runner 需要针对当前 Neo 持久化 `Find(..., skip)` 与 NeoVM
`PostExecuteInstruction(..., RunStats)` 签名的临时兼容适配器；这些适配器不被呈现为上游 NeoExpress
的改动。溯源与完整回执记录在 `docs/reports/sa-neoexpress-runner-provenance-20261006.json` 与
`docs/reports/sa-neoexpress-validation-20261006-custom-did.json`。

又一次解析器审计运行在全新的私有链上使用同一个已验证 runner 二进制：25 次部署、14 个场景、108 笔
持久化交易、84 条断言，以及 25 次成功的工件回读。加固后的溯源检查器把该运行联结到未改变的 76 文件
重建证书，并验证全部 38 个本地 NEF 框架。见
`docs/reports/sa-neoexpress-validation-20261006-parser-audit.json` 与
`docs/reports/sa-private-artifact-provenance-20261006-parser-audit.json`。检查器此前在原始校验和
匹配时接受非零保留字段、校验和之前的额外字节以及高位掩码的 magic 字节。负例优先的回归现在拒绝
这些情况；五个匹配案例在真实 Neo `NefFile` 解析器中也会失败。这修复的是一个证据工具缺口，而不是
已确立的已部署合约利用。溯源套件通过 34/34 个测试，组合脚本套件通过 79/79。完整 Neo core 套件也
重跑通过 1,453 项。详细作用域与源码哈希在 `docs/reports/sa-parser-audit-20261006.json`。

当前 SA 解决方案测试运行在提供同仓工件时通过 **571/571**。在独立检出中它通过 **569/571**，并
显式跳过两个 DID 案例；两种模式刻意保持不同。

历史 2026-09-21 的独立检出（没有同仓 `NeoDIDRegistry` 工件）通过 **290/292**，并把恰好两个跨
仓库 DID 案例记录为显式跳过；它不把这些案例计为通过。更早的 289/291 结果是历史性的，来自新增
零费用估算回归测试之前。

历史 2026-09-21 的源码到工件重放用匹配的私有编译器独立编译 scratch 树，并把 **76/76** 个
NEF／manifest 文件与 `contracts/bin/public` 逐字节比较；没有工件缺失或漂移。历史 `contracts/build`
树仍是被显式报告的溯源锚点，而不是期望匹配项。见
`docs/reports/sa-artifact-reproducibility-20261006.json`。

该回执现在包含针对 `contracts/` 下全部 **74** 个 C# 与项目输入的源码到工件证书、仓库相对源码哈希、
`nccs` 版本、确切的编译 recipe，以及每个工件的新建／发布哈希。这是对私人工件的实用溯源与重建漂移
闭合；它不是机械化的编译器正确性定理或完整 NeoVM 精化证明。该证书到私有 NeoExpress 部署与
JSON-RPC 回读的只读联结记录在 `docs/reports/sa-private-artifact-provenance-20261006.json`；同一
联结现在在 `verify_repo.sh --neoexpress` 之后自动运行，并先为该次运行重新生成带日期的重建证书。
联结在接受证书之前重新计算当前 `contracts/` 源码快照，因此陈旧的重建回执会故障即闭合，而不是被
悄悄附着到新的源码树上。

`tests/SmartAccount.Contracts.Tests/AAArtifactStructureRuntimeTests.cs` 中的工件结构回归门禁用 Neo
严格的 `Script` 解码器加载全部 **38** 个 NEF／manifest 对。ABI 入口点必须在方法名与参数个数上
唯一，匹配 Neo 的派发键（而不是按参数或返回类型），并且必须解析到真实的指令边界。负向 fixture
演练同元数碰撞、操作数偏移、截断指令与校验和破坏。这些是可执行的结构检查，不是编译器证书、
完整 NeoVM 执行语义的证明，或源码到字节码的精化定理。

两个 SA 到 DID 的跨合约案例需要同仓 `NeoDIDRegistry` 构建工件。它们在当前门控运行中通过，条件是
`NEOOS_REQUIRE_SERVICES_ARTIFACTS=1` 与匹配的 `NEOOS_SERVICES_CONTRACT_BUILD` 目录。没有该工件的
独立检出正确地把这两个案例报告为跳过而不是通过；当前回执记录两种模式。

公开一致性状态强于一个未验证标签：对已知规范 TestNet 与 MainNet 哈希的只读 RPC 回读返回了不同于
当前本地工件的 NEF script。当前工件未被公开部署，也没有尝试签名或广播。这记录在
`docs/reports/sa-public-readback-20260920.json`。

先前的 **272/272** NeoExpress 回执仅作为历史证据保留在
`docs/reports/sa-neoexpress-readback-20260919.json`。

### 原生生命周期权威模型

`NativeLifecycle.v` 还针对当前／待处理托管与恢复四个槽位投影权威准入。每个非零的下一状态权威都
必须在已注册代理集合之外；不在先前接受集合中的地址需要见证。待处理提升保留先前的同意，而移除后
重新引入则需要再次同意。未来代理的拒绝以该地址未通过实际见证验证为条件；见证健全性、哈希分离、
存储溯源与共享的原生读取／保存实现仍是外部对应义务。仅靠无状态的 `SmartAccountState` 变换不能
强制这条运行时守卫。

`NativeLifecycle.v` 检查原生账户记录转移所使用的权威守卫与配置 nonce 失效：仅 Active 可配置、
待处理托管恢复期间排除配置、严格的托管取消成熟度、联合解冻授权，以及在受检查纪元递增时清除每个
待处理意图。它把地址、见证与存储建模为抽象事实。它不证明 `CheckWitness`、序列化、回调清理、账本
回滚，或 C# 组件与模型之间的对应关系。SmartAccount 原生合约集成与私有链激活仍属必需。

更早的生命周期主机快照记录在
`docs/reports/sa-formal-gate-20261006-native-lifecycle.json`：18 个模块、223 条闭合声明、105 个被
拒绝的语义变异体、61,460 个不同 TLC 状态、六个 SMT 义务与六个控制；runner 有 42 个通过的测试。
在该检查点，可访问守护进程上固定的容器镜像不可用，因此那份带日期快照没有容器 PASS。状态章节中
的当前容器回执包含该模型；更早的回执仍是历史。

`docs/reports/sa-neoexpress-native-state-20261006.json` 记录八次私有状态 initializer／序列化往返。
它们使用一个没有原生 SmartAccount 合约的 node，且没有持久化任何应用交易；这是状态编解码兼容性
证据，不是生命周期执行证据。

### 原生回调派发边界

`NativeDispatch.v` 使用已配置高度与持久化或账本索引建模 SmartAccount 激活、原生调用方与权限守卫，
以及恢复的原生派发费用与返回子指令白名单策略之间的区别。它针对一个具体的运行时回归：在不存在
持久化区块时，未来激活键并不等价于激活。费用模型假设已经计算出非负费用；既有的有界预算模型覆盖
祖先记账。它不证明应用引擎 C# 精化、完整调度或完整原生合约行为。

带日期的原生派发主机回执是 `docs/reports/sa-formal-gate-20261006-native-dispatch.json`：19 个模块、
236 条闭合声明、112 个被拒绝的语义变异体、61,460 个不同 TLC 状态与 43 个通过的 runner 测试。
其固定容器重跑在该检查点不可用；状态章节中的当前容器回执包含该模型，但不提升更早的证据。

`docs/reports/sa-neoexpress-native-activation-20261006.json` 记录一个私有 Verification 触发回归：
历史运行时在未来激活高度下仍接受了有界系统调用，而修正后的运行时拒绝它。缺失激活会拒绝，显式
激活则允许。部署了一个小的普通诊断合约并回读其 script／manifest；这不是原生 SmartAccount 的激活，
也不是对新的内部原生派发 helper 的链上调用。

#### 复现私有激活回归

`scripts/neoexpress_activation_validate.py` 接受一个包含 `neoxp.dll` 及其依赖的本地 NeoExpress
运行时目录。它用选定的本地 `dotnet` 可执行文件调用那个确切的程序集，在执行前后对运行时哈希，并
创建一次性单节点链。它不接受远程 RPC 端点或既有链文件。一个可选的历史运行时可复现最初未来高度
Verification 触发的缺陷。

```sh
python3 scripts/neoexpress_activation_validate.py \
  --runtime "$CURRENT_PRIVATE_RUNTIME" \
  --historical-runtime "$HISTORICAL_PRIVATE_RUNTIME" \
  --output activation-receipt.json
python3 -m unittest discover -s scripts -p 'test_neoexpress_activation_validate.py'
```

验证器部署一个普通诊断合约，检查其 NEF script、校验和与 manifest 回读，并针对省略、未来与活动
配置运行实际的 RPC Verification 与 Application 模拟。它还使用每个 Application 请求两侧的账本读取
观察一个实时的非零激活边界。边界探测比较 Application 执行高度，即最新持久化账本索引之后的下一块，
因为 `invokecontractverify` RPC 没有持久化区块参数，无法选择证明非零分叉高度所需的区块上下文。
跨越区块变化的样本会被丢弃；`height - 1` 与 `height` 两个执行高度都必须观察到。超时是失败，不是
拒绝的证据。默认超时容纳十五秒区块，因为运行中协议的区块策略可能覆盖 runner 的一秒提示。生成的
回执标记为 `evidenceKind: "syscall-smoke"` 与 `nativeActivationClaim: false`；它只是有界调用系统调用
门禁的证据，不是原生 `SmartAccount` 激活或生命周期一致性的证据。

任何链启动之前都会作废先前的 PASS，因此中断不会留下陈旧的成功能证。回执区分持久化诊断部署与
模拟，并记录运行时哈希，而不含钱包材料或绝对本地路径。失败留下非 PASS 回执，自有节点在
`finally` 块中停止。该验证器与其探针都不注册 SmartAccount、验证其完整生命周期，或确立编译器
精化定理。

### 原生调用权威边界

`NativeInvocation.v` 证明账户／阶段分离、帧敏感的根准入、直接子项委派、目标／模块分离、撤销，
以及保留原始见证检查的要求。它把帧 token、部署与调用方事实视为抽象输入。其十八条声明与十三个
语义变异体还覆盖已激活原生合约哈希见证的拒绝、激活前的遗留行为，以及代理见证合取。它们不证明
ApplicationEngine 如何提供这些抽象事实。单独的原生集成现在在运行时强制这些边界；这不是机械化的
模型到代码精化。

原生调用组件有十五个聚焦测试，包括两种收费机制下的真实 VM 嵌套调用与 LoadScript 观察。一个最初
失败的测试确立：即便待处理的原生续延无法运行其 finally 块，引擎 FAULT 也必须撤销锁与授予；
OnFault 现在执行该撤销。原生工作树的
`docs/reports/smartaccount-invocation-validation-20261006.json` 记录完整套件、覆盖率、已编译变异与
伴随回执的哈希。

该 profile 现在还显式要求：除正常的签名者／WitnessRule 检查之外，已注册代理的应用见证接受必须
被约束到确切授权的目标调用。Global 作用域或对同一合约哈希的重复调用都不能替代该授予。两个安全的
上下文查询现在与 `CheckWitnessInternal` 守卫一起在原生集成中实现。更早的仅组件私有激活回执
`docs/reports/sa-neoexpress-activation-after-context-20261006.json` 只是用更新后的运行时程序集重跑
有界调用激活回归；不得把它解读为原生调用上下文生命周期测试。

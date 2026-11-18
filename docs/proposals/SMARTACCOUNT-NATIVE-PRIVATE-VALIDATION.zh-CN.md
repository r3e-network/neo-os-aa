# 原生 SmartAccount 私有链验证

> 中文版本与 `docs/proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.md` 同构。若两者冲突，以英文版本为准。

## 当前 ABI 2 验收边界

当前运行必须绑定已评审的 ABI 2 core/RPC 源码与当前的 native-v2 模块构建回执。执行使用四个参数：`(accountId, operationOrBatch, expectedAuthorityEpoch, expectedConfigurationNonce)`。两个计数器都必须与 14 字段账户记录一致；先前的两参数入口点会被拒绝。该承诺属于未签名交易的一部分，包括托管回退与原生交易见证授权。自动费用准备需要 RPC 的 `minimumrequiredfee`；在针对较旧节点准备时可以提供显式的 SystemFee 预算。最终的已签名交易预检仍需要完整的原生费用/准入结果，并校验字节完全相同。

恢复测试必须在状态转换过程中保留实际的已签名字节，在 Verification 与 Application 中拒绝过期计数器，并验证重新安装的模块无法读取先前的 `0xA2` 账户/authorityEpoch 命名空间。新签名/配置提供正向对照。回执必须区分内存池拒绝、已准入 FAULT 与已持久化 HALT，并比较实际的账户、nonce、模块存储与资产增量。下文的历史 ABI 1 与中间 ABI 2 回执不为已变更的最终源码确立验收。

当前本地权威准入修订仍为 ABI 2，使用摘要 `ae557647b63789c7af0a8c7816dc90d5c0d7e65afb78ce3c669de9a01ce3c91a`。该指纹现在绑定对新引入的非零权威地址的同意，以及对当前与待定权威槽中已注册原生代理的拒绝。当前验证必须重建运行时、使用该摘要重新打包模块，并验证已部署字节。较旧的 ABI 2 摘要不能标识该修订。历史回执保留其原始值，不能替代这一新的构建与回读证据。

## 历史源码构建的 NeoExpress 权威验证（2026-10-30）

2026-10-30 的权威准入修订被重建为完整的源码构建 NeoExpress 运行时。中间回执已在文档清理中退役；下文的 2026-10-31 最终回执在同一轨道上取代它们。较早的失败 runner 尝试仍记录在其日志中，且不被用作该修订的溯源。

聚合回执是 2026-10-31 最终的 [`summary.json`](../reports/smartaccount-native-source-runtime-20261031-final/summary.json)。其状态为 `PASS`，五个矩阵全部通过：原生服务生命周期、签名代理与原子回滚、配置根变更、权威恢复，以及激活边界验证。各单独回执保留在聚合回执旁边。每个矩阵前后运行时文件映射一致，所有自有 NeoExpress 节点均已停止，且未触碰任何公共网络。

该证据是有界的。它针对所列场景演练源码构建的私有运行时与持久化 RPC 回读；它不证明完整协议符合性、任意未来插件清理、密码学或证明可靠性、完整 NeoVM 语义、编译器精化、公开部署或公共工件一致性。因此聚合回执保持 `fullProtocolConformanceVerified` 为 `false`。

## 最终源码构建运行时验证（2026-10-31）

最终的原生身份与分派修订绑定 core `0b81b25601ba7e2ec0b0d9b9cb0ab79ed809af03`、node `b6bbeaf7deb8e2d821cd6f1ae8cbdb24117d5605` 与 NeoExpress `59ee6e2d4315133a4521aed600dbe74f5b8ad307`。两次独立的干净构建产出相同的 104 个运行时文件与 50 个依赖包。源码构建回执为 [`smartaccount-native-runner-build-20261031.json`](../reports/smartaccount-native-runner-build-20261031.json)，SHA-256 为 `d0c764fc2cc16f8671b4b3bc6548005a5b7a14eee9a1c8f339fd7b2f387f719d`。它记录 `runtimeByteIdentical: true`、`sourceInputsUnchanged: true`、`compilerRefinementProven: false` 与 `publicNetworksTouched: false`。

聚合源码运行时回执为 [`summary.json`](../reports/smartaccount-native-source-runtime-20261031-final/summary.json)。全部五个矩阵针对该确切运行时通过：原生服务生命周期、签名代理与原子回滚、配置根变更、权威恢复，以及激活边界验证。每个矩阵前后运行时文件映射一致，每个自有节点均已停止，且聚合回执保持 `fullProtocolConformanceVerified: false`。

这仅在当前溯源意义上取代 2026-10-30 权威回执。较早回执仍作为其所记录源码集的历史证据。最终运行在 `0x398dc3f0227d7efac5533ed5ce9937390c158084` 处演练重命名后的 `SmartAccount` 原生合约，配置档摘要为 `ae557647b63789c7af0a8c7816dc90d5c0d7e65afb78ce3c669de9a01ce3c91a`。它不确立公开部署一致性、完整协议符合性、编译器或 NeoVM 精化、密码学可靠性、任意插件活性、托管式 Web3Auth 仪式，或 MultiSig 私钥独立性。

最终扩展矩阵由 [`index.json`](../reports/smartaccount-native-extended-matrix-20261031-final/index.json) 索引。在最终原生身份变更后，六个原生模块使用固定的 `nccs` 3.9.1 重建了两次。模块回执为 [`smartaccount-native-module-build-20261031-final.json`](../reports/smartaccount-native-module-build-20261031-final.json)；它固定了 30 个仓库输入、13 个打包工件、当前配置档摘要，以及与此前原生运行相同的编译器与框架归档。

全部五个扩展矩阵针对最终运行时与模块构建通过：

- MultiSig 组合：87 次持久化执行；
- SessionKey 执行：53 次持久化执行；
- SessionScope：46 次持久化执行；
- DailyLimit 固定与滚动记账：116 次持久化执行；以及
- TokenRestrictedHook 策略：64 次持久化执行。

每个回执记录 `publicNetworksTouched: false`、`runtimeFilesMatched: true`、`ownedNodesStopped: true`，以及相同的源码构建与模块构建回执哈希。各作用域仍是场景特定的。DailyLimit 不确立任意代币的诚实性或完整编译器精化；TokenRestrictedHook 使用仅用于测试的 router 委托；SessionKey 与 SessionScope 不确立密码学或编译器可靠性；MultiSig 不确立私钥独立性或任意拓扑。

## 历史扩展原生矩阵（2026-10-30）

较早的扩展源码构建矩阵由 2026-10-31 最终的 [`index.json`](../reports/smartaccount-native-extended-matrix-20261031-final/index.json) 索引。它记录了五个额外私有 NeoExpress 场景的 `PASS`：

- 使用真实 P-256 与原生见证的 MultiSig 组合；
- DailyLimit 固定与滚动记账、前缀清理与回滚；
- 使用真实 P-256 签名、原生 GAS 转账与纪元清理的 SessionKey 执行；
- 零上限、精确方法、通配、重新授予与保留签名的会话作用域规则；以及
- 直接与间接受限代币策略、敌意查询与回滚。

随附的打包回执覆盖六个已交付原生配置档：`NeoNativeVerifier`、`WhitelistHook`、`SessionKeyVerifier`、`DailyLimitHook`、`TokenRestrictedHook` 与 `MultiSigVerifier`。每个矩阵都绑定到该修订的源码构建 runner 与模块构建回执，保持运行时文件一致性，停止其自有节点，并记录 `publicNetworksTouched: false`。这是针对原生协议边界的场景证据。它不封闭密码学正确性、任意插件活性、完整 NeoVM 语义、C# 到 NEF 精化、MultiSig 私钥独立性或公开部署一致性。

## 历史 2026-10-09 组合配置档证据

最终的 2026-10-09 组合配置档运行时固定 core `ff422d940a4722c361c32398c6f28c00fb7f0693`、node `fa35e69af130661e2ac60bffd43eb6c6c78aa7d5` 与配置档摘要 `4201b02f571b7415121467d67343a8189b8070ad795a82424c0403782d22b1b4`。其两次完整源码构建（314 个 core、123 个 node 与 182 个 Express 输入；104 个相同运行时文件与 50 个依赖归档）见 [`sa-native-composite-final-runner-build-20261009.json`](../reports/sa-native-composite-final-runner-build-20261009.json)，该日期的模块、公共工件与模型证据见 [`sa-native-composite-final-build-proof-20261009.json`](../reports/sa-native-composite-final-build-proof-20261009.json)。那些源码身份主张适用于其记录的输入集，而非当前权威准入修订。

该日期修订的执行证据是分离的：[`sa-native-final-private-runtime-20261009.json`](../reports/sa-native-final-private-runtime-20261009.json) 记录十套件私有矩阵、选定的生产者字节与保留限制；[`sa-native-final-sdk-runtime-20261009.json`](../reports/sa-native-final-sdk-runtime-20261009.json) 记录实际的 SDK 签名交易矩阵。[收敛报告](../reports/sa-native-convergence-20261009.md) 索引了最终验证与剩余上游激活边界。

独立的 `scripts/neoexpress_activation_validate.py` 回执使用 `evidenceKind: "syscall-smoke"` 与 `nativeActivationClaim: false`。它只部署一个普通诊断合约，以演练 `System.Contract.CallWithGasLimit` 激活边界、拒绝路径与预算耗尽行为。它不激活、调用或为 `SmartAccount` 原生合约确立符合性。原生合约生命周期证据由下文独立的原生合约 harness 产出，并仍受配置档、节点、上游评审与网络激活门禁约束。

## 历史中间 ABI 2 构建

较早的 ABI 2 源码 runner 于 2026-10-08 由其当时已评审的生产源码重建了两次。全部 104 个运行时文件、50 个依赖归档与生成的锁映射一致。源码图包含 313 个 core、122 个 node 与 182 个 Express 输入。确切哈希见 [`sa-native-abi2-runner-build-20261008.json`](../reports/sa-native-abi2-runner-build-20261008.json)；[`sa-native-abi2-build-convergence-20261008.json`](../reports/sa-native-abi2-build-convergence-20261008.json) 联接模块、运行时、公共配置档与模型回执。最终的 node 格式化提交发生在构建快照之后；回读报告记录其新 HEAD，同时保留原始构建元数据与匹配的源码哈希。构建可复现性本身不构成原生链通过。

2026-10-09 的 RPC 兼容性重建把能力读取器加入源码图：313 个 core、**123 个 node** 与 182 个 Express 输入。两次独立构建再次匹配全部 104 个运行时文件与 50 个依赖归档。原生 RPC 输出保留确切的 `minimumrequiredfee`；缺少该能力的已发布 core 会省略该字段。自动 SDK 费用准备需要该字段；显式 SystemFee 准备与强制的最终已签名交易预检是分离的。该中间回执早于最终组合/密钥规范化实现，属历史记录。该中间运行时见 [`sa-native-abi2-runner-build-20261009.json`](../reports/sa-native-abi2-runner-build-20261009.json)，其源码/构建与双通道 RPC 测试证据见 [`sa-native-abi2-rpc-runtime-20261009.json`](../reports/sa-native-abi2-rpc-runtime-20261009.json)。较早的 runner 回执仍是该日期的快照，不得替代这些已变更的源码。

## 历史原生模块配置档

真实模块矩阵入口为 `scripts/neoexpress_native_modules_validate.py`。它使用源码构建的 runner 回执，以及单独复现的原生 NeoNativeVerifier/WhitelistHook 工件，而非接受型诊断模块。原生清单 ABI 与 `hasModuleContext` 阶段不会被放宽以准入旧版工件。打包说明见 `SMARTACCOUNT-NATIVE-MODULE-PROFILES.md`。

历史 ABI 1 运行持久化了两条登记与 29 笔签名矩阵交易：11 次 HALT 与 18 次预期 FAULT。它检查实际的 2-of-2 见证授权、缺失共同签名方、错误的见证作用域、一天的配置成熟期、默认拒绝许可名单、直接入口拒绝、回调/目标帧分离、账户隔离、根移除时清理与托管回退。每笔矩阵交易都有区块包含、确切的脚本/签名方/见证回读，以及对完整账户记录、操作游标、两个待定调用意图与选定策略 getter 的检查。FAULT 必须保留这些观测且不发出通知。这不是对每个任意插件存储键的主张。

每个模块 RPC NEF 的每个字段，包括方法令牌与编译器/源码元数据，都会被重新序列化并与本地 NEF 字节比较。打包清单按结构比较。完整 runner 目录与模块构建固定值都会被检查，独立重放使用新链与新密钥。该 2026-10-06 运行的最终与重放回执文件不在此检出中，因此它们仅为历史标识符，不被用作当前证据。当前源码构建回执列于上文的 2026-10-30 一节。

这确立了所测试的双配置档兼容性，而非每个验证器/钩子、私钥独立性、完整密码学可靠性或编译器精化。较早的诊断 harness 作用域与证据在下文保持分离。

原生合约 harness 在新建的一次性 NeoExpress 链的首个区块之前激活 `HF_SmartAccountV1`。它绝不接受远程端点或既有钱包/链。钱包材料保留在临时链目录中，不写入回执。RPC 仅限回环，其网络 magic 必须与所创建的链匹配。

这与有界调用诊断探针不同：SmartAccount 原生合约 harness 要求已部署的原生 `SmartAccount`，校验其清单身份、ABI/版本/摘要，并提交实际的登记、操作、延迟恢复地址轮换与冻结交易。交易回执从持久化应用日志读取；预期的预检失败被单独标注。已部署见证诊断还通过持久化 UserOperation 提供正向托管见证对照与负向原生合约哈希见证对照。其 NEF 脚本、校验和与清单必须与 RPC 回读按字节/结构匹配。节点启动后，最终账户与 nonce 状态通过 RPC 独立读取。记录的运行时程序集哈希必须保持不变。harness 故意加入 10 GAS 的私有交易封套。因此其记录的系统费不是优化后的产品费用估计；实际消耗的 GAS 单独记录。人为封套绝不是公开转账。

预期序列：登记 -> 执行 -> 拒绝重放 -> 提议守护者 -> 拒绝未成熟激活 -> 推进本地时间 -> 激活守护者 -> 冻结 -> 拒绝执行 -> 守护者解冻（需要两个权威）。首个 harness 修订测试冻结与拒绝；联合见证解冻、真实代理签名、插件符合性与完整原生覆盖仍是独立门禁。没有任何通过回执意味着所有原生配置档符合性场景都已完备。

输出在链操作开始前被覆写为 RUNNING；异常会产生 FAIL，附带经净化的阶段/类型，绝不保留先前的 PASS。自有节点在 finally 块中停止。运行时文件缺失、原生身份/ABI 不匹配、网络错误、nonce/状态不匹配，或交易缺少预期事件，都必须失败关闭。原生运行时溯源是显式的本地程序集覆盖层，而非对可复现重建 NeoExpress 分发的声明。

使用本地准备好的运行时运行：

```sh
python3 scripts/neoexpress_native_service_validate.py --runtime /path/to/runtime --output /path/to/receipt.json
```

## 源码构建 runner 可复现性门禁

runner 构建门禁必须从显式本地源码快照编译 NeoExpress、原生 Neo core、RPC server、RPC client、MPT 库与 DBFT，而不是在既有 runner 中替换程序集。源码输入必须排除构建输出、钱包、私有配置与符号链接。每个被包含的文件与每个外部 NuGet 归档都以 SHA-256 标识。源码兼容性变更与确定性构建元数据是显式的配方输入；任何构建都不得静默复用旧的 SmartAccount 包或未记录的 DLL。

源码引用与确定性编译器设置通过 MSBuild 的显式 `CustomAfterMicrosoftCommonTargets` 入口导入。嵌套仓库的 `Directory.Build.targets` 保持生效，但不能隐藏该源码配方。一个真实的 MSBuild 求值回归会同时检查其保留的设置，以及用已评审源码项目替换二进制 Neo 引用。

两个独立的干净目录、包解压目录与离线还原必须产出完全相同的完整运行时文件映射，包括依赖、运行时配置、调试符号与原生库。不同路径在编译期被规范化，而不是通过编辑编译输出。缺失、新增或变更的文件会使门禁失败。源码快照必须在两次构建全程保持不变。失败的尝试必须替换任何先前的 PASS 回执。

包源仅限本地。可复现性覆盖固定的 SDK、宿主与依赖输入，不覆盖编译器的正确性或源码到 VM 的精化证明。最终运行时随后必须通过既有的一次性链原生验证，并记录其确切的程序集哈希。先前的覆盖层回执仍是历史证据，不得被重新标注为源码构建结果。

`neoexpress_source_validate.py` 在每个既有原生合约、代理、配置、恢复与激活验证器前后校验完整的双构建文件映射。它把每个原始回执原样保留为 `*.raw.json`；链接回执记录经校验的源码构建溯源，而不是较旧 harness 的固定覆盖层标签。VM 结果、交易与源码哈希必须与原始回执一致。缺少 PASS、自有节点未停止，或任何运行时漂移都会阻止聚合通过。激活重放仅使用当前运行时；历史回归不会被静默计入。

```sh
python3 scripts/neoexpress_reproducible_build.py \
  --core /path/to/native-core --node /path/to/neo-node \
  --express /path/to/neo-express --cache /path/to/local-nuget-cache \
  --work /path/to/new-build-directory --output /path/to/build-receipt.json
python3 scripts/neoexpress_source_validate.py \
  --runtime /path/to/new-build-directory/build-1/runtime \
  --build-receipt /path/to/build-receipt.json --output /path/to/new-receipt-directory
```

要复现已评审的构建，传入 `--expected` 及其构建回执，并使用不同的输出/工作路径。SDK、宿主架构、配方、兼容性补丁、源码快照、还原后的包归档字节、依赖锁与运行时文件映射都必须匹配。源码仓库是只读的；临时程序集覆盖层、先前的 `bin`/`obj` 内容与私有运行时包都不是构建输入。Git 版本与源码链接构建生成器被替换为显式版本元数据加回执源码身份，避免生成的工件中出现本地 Git 状态或路径。此离线构建禁用 NuGet 的在线公告查询；这不是当前的依赖漏洞审计。

原生集成仓库还保留 `docs/reports/smartaccount-source-runtime-tests.csproj`。在其测试树的一次性副本中，只用该配方替换单元测试项目，保留两个原始 `.editorconfig` 文件与 `tests/Directory.Build.props`/`AssemblyInfo.cs`。在离线还原与测试期间把 `SmartAccountRuntime` 设为已校验的运行时。该项目引用确切的重建 core 程序集，而不是重建它们。依赖版本来自四个 core 项目。在完整套件之后，把复制的测试输出 core/VM DLL 哈希与已校验运行时比较；仅套件通过并不能证明它加载了预期的运行时字节。不要改动原始测试源码、fixture 或断言配置。

## 签名代理与原子资产转移矩阵

`scripts/neoexpress_native_proxy_validate.py` 创建独立的一次性链。它独立于节点构造确切的原生验证脚本与规范操作应用封套。临时 P-256 钱包对 `networkMagic || SHA256(unsignedTransaction)` 签名。交易同时携带付款方的实际签名与账户代理的实际验证脚本；不存在 RPC 模拟的见证替换。

该矩阵用私有 GAS 为脚本地址提供资金，然后检查：

- 仅有托管签名方时，目标无法合成代理见证：GAS 转账返回 false，操作停止并消耗其 nonce。
- 具备允许作用域的有效代理见证转移真实 GAS；独立的余额增量、nonce 推进、Transfer 与 UserOpExecuted 事件一致。
- 拒绝型代理作用域返回 false 且不移动资产；验证器接受不等价于应用层见证授予。
- 中止的接收方回调产生持久化 FAULT，不提交操作 nonce、资产余额或通知。第二笔转账中止的批次也必须回滚第一笔转账及其事件。
- 重复的批次 nonce、非规范应用尾与无效付款方签名在持久化前被拒绝，并单独标注为准入失败。预期拒绝不计为持久化回滚证据。

回执校验检查确切的合约、交易哈希、原始应用脚本、签名方身份/作用域、区块包含、VM 结果/事件形状，以及通过回环 RPC 读取的余额/游标。诊断 NEF/清单字节必须与已部署回读一致。只能使用 harness 创建的子进程与临时钱包。缺失证据或意外的 RPC 结果失败关闭；不主张任何提供方证明或密码学可靠性证明。

RPC 交易回读还必须匹配调用与验证见证字节。中止接收方的余额在每个场景前后单独检查。准入原因是精确的，而非子串匹配：Neo 的依赖状态自定义见证失败返回 `Invalid`，而无效的标准 P-256 签名返回 `InvalidSignature`。费用不足拒绝与传输错误都不能满足任一对照。被拒绝的哈希必须不出现在内存池与交易回读中；对照之后被接受的规范批次，在同一已出资账户、运行时与 nonce 状态下提供正向对照。

原始交易使用故意保守的仅私有费用封套。回执把已付费用与实际消耗 GAS 分开。这既不是生产费用估计，也不是公链交易配方。

## 配置根变更回归

`scripts/neoexpress_native_configuration_validate.py` 为两种角色部署诊断组合根与叶子模块。破坏性叶子写入存储标记，调用根故意暴露的 destroy 方法并返回 false。其成熟配置作为实际签名交易提交，不经过 RPC 预检过滤。对于根准入检查，它必须持久化为 FAULT，无通知、纪元/意图/名册不变、子标记缺失，且原始根 NEF/清单仍存在。同一根下的良性叶子随后必须成功配置，并提交其 false 返回、标记、纪元与清理登记。这些 fixture 测试原生边界，而非任意插件的安全性或完整语义。所有工件与钱包都是一次性的，所有 RPC 流量仅限回环。

## 恢复权威与联合见证矩阵

`scripts/neoexpress_native_recovery_validate.py` 使用四个分别生成、已出资的私有链 P-256 钱包：托管、恢复、替换托管与中立费用支付方。交易携带实际标准见证脚本与签名。模拟、`ManualWitness` 或仅提供的 RPC 签名方列表都不满足该门禁。

该矩阵验证未授权冻结、恢复权威授权的冻结、解冻时任一单一签名方被拒绝，以及成功的联合解冻。冻结与解冻必须推进 configurationNonce 并使待定意图失效；authorityEpoch 是分离的，仅在恢复时推进。当托管恢复待定时，可变配置被拒绝；Active 账户仍可执行已授权操作。若必须停止执行，恢复权威可以单独冻结。托管取消只允许在成熟前，而恢复权威可在成熟后取消。

经过新一轮延迟后，中立支付方执行恢复，无需旧或新托管方对该激活签名。此后旧托管见证必须失败；新托管见证必须成功执行。账户 ID、代理地址、授权域与操作 nonce 历史都保持不变。重新冻结与联合解冻使用替换托管，而非退役密钥。每个结果都被持久化，包含确切的原始交易/见证回读、预期事件/结果、完整账户记录比较与独立 nonce 回读。预期 FAULT 必须使完整账户/游标记录与通知保持不变。

# SmartAccount 本地验收，2026-11-24

[当前 20 个模块的完整接口复验](module-removal/modules-compiled.log)：从源码编译并在本地 NeoVM 部署，每个声明 getter 的精确字节和 manifest 均与标准匹配；18 个启用模块另行通过空数组卸载。[两个开发模板](module-removal/templates.log)复用第三方模块的同一检查器。[钱包模块工作区](module-removal/wallet-tests.log)44 项通过，含初始配置的地址字节顺序、大整数、布尔与嵌套数组。普通收款与转账不依赖安装模块。

[存储整数的查询证明](stored-integers/result.json)分别绑定远端 90 入口 NEF 和归档 100 入口 NEF。每个产物的 `getMarketEscrowListingId`、`getAdminTransferAvailableAt` 和 `getPlatformRegistrarAvailableAt` 均通过 Rocq 内核复验。另有每个产物 42 次实际引擎调用：`01 00` 读为 1，33 字节在整数转换处失败，合法的 32 字节整数加延时溢出则在加法处失败。修正前的存储 getter 收据不能作为这些数值语义的证据。复验命令为 `python3 formal/refinement/ordinary_stored_integers.py`。这些定理以成功建帧和模型中的存储读取为前提，不含任意 GAS、回滚和 VM 对应；完整入口计数不变。

[模块卸载复验](module-removal/uninstall-compiled.log)：在与安装收据中 SHA-256 相同的 20 对 NEF 和 manifest 上，18 个可安装模块均接受空数组卸载。白名单对照为两个账户配置相同实例编号与目标；卸载一个账户后，仅该账户的许可被清除。两个禁用模块不进入卸载用例。探针通过测试核心执行回调，不证明任意状态下能完成清理，也不代表公网激活。[当前策略模型](module-removal/result.json)已重新绑定本轮修改的规范。

[模块 NEP 和安装参数收据](module-install-forms/conformance.json)：20 个具名模块均有机器可读安装格式，其中 18 个启用、2 个必须拒绝安装。使用两份独立的账户状态分别测试带配置安装和已安装实例配置，避免把会话密钥 24 小时轮换限制误判为格式不合规。20 个编译产物的声明均在 NeoVM 比对；20 条命令、20 个错误参数数量和 14 个错误数值类型用例通过。6 个原生绑定模块的打包字节另行核对。模块探针使用测试核心，不能证明治理授权或任意第三方模块的行为。

[原生测试](module-install-forms/native.trx) 1,739 项通过。原生摘要查询现在与执行入口同样拒绝超过 16,384 字节的带签名操作。此前测试中，16,385 字节查询返回 HALT；修复后返回 FAULT，恰好到上限仍返回 32 字节摘要。[策略模型收据](module-install-forms/result.json)包含源码与生成副本同步核验，固定 76 份当前源码/规范和 309 份原生代码文件；27 项声明通过、34 个变异被拒绝。旧的原生生成副本不能复用该收据。



现行[核心 NEP](../../proposals/nep-smartaccount-entry-verifier.mediawiki)与原生核心均使用 **13 字段** UserOperation；此前草稿写为 6 字段，无法供钱包发送。公共接口和具名模块草案均引用这一种编码。检查器对比核心 NEP、英文规范 §4.1 与原生 `Op…` 索引；交换 nonce 与 nonceSubkey 的对照会失败。[原生协议测试](core-nep-protocol.trx) 65 项通过，含短/长数组、非法类型、非规范钩子证明和公开向量。当前[策略模型收据](core-nep-model/result.json)绑定核心和模块规范，27 项声明通过，34 个变异被拒绝。此结果不是端到端精化。

普通合约构建须分别验收。2026-11-24 拉取的远端主分支 `66b1715894f1eb38354ccc02f6cbdeb1c29911aa` 中，`contracts/build/SmartAccount.nef` 对应 90 个 ABI 条目。[分发证书](main-entry/result.json)核对所有 90 个条目的名称、参数数量、偏移和普通调用准入；不含方法体。以下两个产物的三个查询方法体相同，但初始化器不同，不能共用阈值：

| 构建 | 初始化器指令数 | 读取实现标识需预留 | 查询执行模式或模块类别需预留 |
| --- | ---: | ---: | ---: |
| [远端 90 入口普通合约](main-query-references/result.json) | 161 | 65 | 66 |
| [归档 100 入口普通合约](ordinary-query-references/result.json) | 170 | 68 | 69 |

“预留”是目标初始化器第一条指令前的引用容量，基数已经包含实参。它直接影响嵌套调用能否返回；不是 GAS，也不是要钱包设置的参数。每份证书从各自的原始字节解码并合成初始化器和方法体；每个构建做 60 次直接 NeoVM 执行和 60 次已部署本地 ApplicationEngine 调用，核对指令位置、计数、返回值与首个失败原因。65,537 字节输入即使有足够引用空间也在 EQUAL 因比较上限失败。复验 `python3 formal/refinement/ordinary_query_references.py`（先更新 `origin/main`；若远端产物变更，摘要绑定会拒绝沿用旧证书）。证明以成功建帧及没有其他故障干扰为前提；它不证明任意交易的费用或回滚，也不增加 100 入口完整证明的计数。

[跨语言模块声明向量](../../../tests/fixtures/sa-module-protocol/module-profile-vectors.json)共 9 条；Python 发布前检查和[原生安装测试](module-admission/module-discovery-vectors.trx)读取同一文件，4 条接受并核对摘要、5 条拒绝。修正了 Python 将 U+001C 误作空白而拒绝有效声明的差异。两个禁用模块在具名清单中均可由钱包直接识别，未更改链上格式。

[共享初始化器的引用容量证明](ordinary-initializer-references/result.json)：98 个普通入口的同一段 170 条指令，在 Coq 值模型中从归档 NEF 原始字节逐条解码，得到完整引用计数序列。第一次峰值在初始化器偏移 246，需 68 个额外引用；返回时只剩 67 个。锁定的 NeoVM 默认上限 2,048，入口可已有至多 1,980 个引用。[264 次真实 VM 执行](ordinary-initializer-references/runtime.json)核对每次执行的全部计数，包含所有 98 个普通入口恰够和差一个的边界。复验：`python3 formal/refinement/ordinary_initializer_references.py`。定理只解决新初始化帧执行指令后的引用容量，不证明建帧、方法体、费用、回滚或任意 VM 状态的普遍对应。完整入口仍为 0/100。

[模块配置复验](module-wire-types/vm-summary.txt)：原日限额模块在安装时接受了字节串编码的整数（[修正前输出](module-wire-types/before-types.log)）。现行模块在配置日限额、会话授权、见证门限时按 NEP 检查整数和布尔类型。本地 NeoVM 核对了 20 个模块 getter、20 个合法配置命令和 20 个错误参数数量；7 个数值字段各经安装及配置两条路径验证错误类型均被拒绝。6 个原生模块[各自构建两次](module-wire-types/typed-build.json)，[逐包部署验证](module-wire-types/typed-packages.log)。另行运行的[原生核心回归](module-wire-types/native.trx)通过 1,737 项，该套件加载其指定的标准模块夹具，并未对六个包逐一执行全部行为测试。

[订阅账期证明收据](subscription-model/result.json)：在非负 Unix 秒和正周期下，首次扣款的时间条件为当前秒数至少等于周期。已有成功扣款后，下次可扣款的第一个整秒恰为新旧两个账期结束时间的较大值。[13 项订阅 NeoVM 回归](module-wire-types/subscription.trx)包括不互为倍数的周期和边界前 1 毫秒。当前策略模型合计 27 项声明，34 个语义变异均被拒绝；该定理不证明链上时间来源、见证、存储、转账或字节码与模型的对应。
六个绑定原生核心的模块经过单独的[双构建复验](native-nep/module-build.json)。修正前打包器错误要求 manifest 使用 VM 栈类型 `ByteString`，导致编译器生成的 `validateUserOp` 无法打包。修正后两次构建的模块字节一致；按[打包清单](native-nep/native-profile-packaging.json)核对六对 NEF 和 manifest，具名 ABI 与部署后的声明字节全部匹配。使用 `python3 scripts/check_module_neps.py --native-packages DIR` 可在打包输出目录复验。[更新后的策略收据](native-nep/result.json)仍只证明模型，不增加完整入口计数。

模块 NEP 本轮复验：20 个具名模块均重新编译，20 份 manifest 与 ABI 附录一致。部署到本地 NeoVM 后，20 个 getter 均返回预期的声明字节；配置探针接受 20 种规定命令，拒绝对应的 20 个参数数量错误用例。以上是接口及具体调用的证据。[本轮策略模型收据](gate-recheck/result.json)覆盖 24 个声明、30 个被拒绝的变异，并记录 68 个模型相关源码指纹和 309 个 Neo Core 源码指纹；`implementationVerified` 仍为 `false`。下文保留的旧收据仅用于对应构建。

[方法固定费用实测](ordinary-pure/runtime-fees-fixed.json)：通过本地 Policy 合约给三个查询入口分别登记 0、12,345、54,321 datoshi。普通调用方仍支付入栈和系统调用费用，进入目标时支付一次登记金额，初始化器和方法体不再逐指令收费。登记零费用的实现标识查询总计仍为 984,030 datoshi。固定费用不改变比较超限时的失败结果。复验用 presence-probe 的 `--pure-fees-fixed` 生成上述收据，再运行 `python3 formal/refinement/ordinary_pure_fees.py`。该校验器核对四种计费配置共 368 次调用。[预算定理](../../../formal/refinement/coq/PathFee.v)证明上述收费顺序的预算阈值。

[嵌套固定费用样本](ordinary-pure/nested-fees.json)使用归档合约和绑定 Neo Core 提交 `d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d` 的本地引擎，分别测试父、子方法各自有无固定费用的四种组合。每组以充足、精确和少一 datoshi 的预算执行，共 12 次，均符合预期；成功调用均执行了目标初始化器与方法体共 173 条指令并返回父方法。[帧费用模型](../../../formal/refinement/coq/FrameFee.v)证明有限嵌套调用中按模型建帧、克隆、登记与弹栈时的收费序列和预算条件，已运行 `coqc` 与 `coqchk`。模型依赖建帧、克隆共享状态及费用事件对应真实引擎的前提，样本不能证明 CLR、NeoVM 和模型的普遍对应，也不增加完整入口证明计数。复验命令为 `dotnet run --project formal/refinement/presence-probe -p:RestoreLockedMode=true -- docs/reports/smartaccount-current-20261124/ordinary-entry/input/UnifiedSmartWalletV3.nef docs/reports/smartaccount-current-20261124/ordinary-entry/input/UnifiedSmartWalletV3.manifest.json docs/reports/smartaccount-current-20261124/ordinary-pure/nested-fees.json --nested-fees`。

远端 `origin/main` 提交 `66b1715894f1eb38354ccc02f6cbdeb1c29911aa` 的 `contracts/build/SmartAccount.manifest.json` 含 90 个 ABI 条目。下述 100 入口收据只绑定本报告 `ordinary-entry/input` 中的 NEF 和 manifest，不能用作远端 90 入口产物的证明。

[区块回滚收据](ordinary-pure/block-rollback.json)：在独立内存链部署归档 NEF 后，Neo Core 实际持久化了三个测试区块。每笔交易先转入 GAS 并在交易内断言余额，再调用查询方法。同一区块的后续交易读取前一笔成功交易的余额，拒绝看到失败交易的转入。三个区块的最终余额分别为 8、16、24 个最小 GAS 单位；13 笔查询交易中有 6 次成功，3 次调用方主动中止、2 次调用方拒绝返回值、2 次方法内比较超限。区块导入跳过入网验证；不证明费用回滚或公共网络行为。复验命令：`dotnet run --project formal/refinement/presence-probe -p:RestoreLockedMode=true -- docs/reports/smartaccount-current-20261124/ordinary-entry/input/UnifiedSmartWalletV3.nef docs/reports/smartaccount-current-20261124/ordinary-entry/input/UnifiedSmartWalletV3.manifest.json docs/reports/smartaccount-current-20261124/ordinary-pure/block-rollback.json --block-rollback`。

**账本状态对应仍未通过。** 在上述 13 笔交易中，按哈希读回交易和区块高度均正确，但 `Ledger.GetTransactionState` 的 `State` 全部为 `NONE`，既未反映成功也未反映失败。收据分列执行事件、账本读数和区块提交后的余额。这是锁定的本地 Neo Core 测试结果，尚未核实公共节点。当前 SDK 检查应用日志的 `HALT`；不得把交易已入块当作执行成功。

[同一提交的构建对照](ordinary-pure/ledger-readback.json)定位到 `LedgerContract.OnPersistAsync`：它在运行应用前用 `StorageItem.FromReplica` 把初值为 `NONE` 的事务状态复制进账本。随后 `Blockchain.Persist` 更新执行列表里的对象，未将结果写回账本副本。[候选修正](../../../formal/refinement/ledger-readback/candidate.patch)在本区块所有应用执行结束后、PostPersist 前，把最终状态写回区块快照。对相同交易，原版读回 13 个 `NONE`，修正版读回 6 个 `HALT`、7 个 `FAULT`；交易哈希、执行事件、失败原因、消耗和三次区块余额均与原始运行一致。复验：`python3 formal/refinement/ledger-readback/compare.py /path/to/neo`，该检出须含提交 `d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d`。候选补丁改变账本状态，仅供隔离链验证，未接入 AA 构建或公共网络，未回填历史区块。

[Coq 模型](../../../formal/refinement/coq/BlockRollback.v)的两条定理覆盖任意前后交易序列：在私有应用状态于成功时提交、失败时丢弃的假设下，后续交易分别从已提交的新状态或原状态继续。已用 `coqc` 和 `coqchk` 核验。模型不包含持久化存储实现、费用或事件编码；它和运行样本都不增加完整证明的入口计数。

[调用栈深度证明](ordinary-entry/depth.json)核对 NeoVM 与 Neo Core 的建帧源码，并由 Coq 证明：通过普通调用准入后，若当前调用深度为 d，上限为 L，则装入方法与初始化器两帧的容量条件恰为 d + 2 ≤ L。没有空位时第一帧即被拒绝；恰好一个空位时仅装入方法帧，尚未执行目标字节码。[真实引擎 199 次检查](ordinary-entry/depth-runtime.json)在预先构造的调用栈中，对全部 98 个普通入口逐个核对这两个拒绝位置，另对三个只读入口验证恰够两帧时的正常结果。构造的调用栈不是链上可达性证明。用 `--entry-depth` 运行 presence-probe 生成运行收据，再运行 `python3 formal/refinement/ordinary_depth_proofs.py`。本项不证明方法体内嵌套调用、其他资源限制、费用或回滚。

[治理与标准模块生命周期复验](governance-lifecycle.trx)：33 项标准模块集成用例全部通过，零跳过。新增用例先确认自定义消息签名名单，再提出尚未确认的名单变更。卸载治理模块后，签名查询仍返回原名单、门限和版本；重新安装得到不同实例编号，旧提案无法确认。另有删除和篡改已确认正文的两种用例：查询失败，但预设延时恢复仍可完成。这组运行不代替全合约入口证明。

普通用户合约的 100 个 ABI 条目对应 99 个不同名称，`finalizeEscape` 有 2 参数和 3 参数两个重载。[分发证书](ordinary-entry/result.json)已覆盖任意未声明的参数数量，以及两个保留名称 `_deploy`、`_initialize` 的外部普通调用。该结论针对参数转换后的分发模型。[实际引擎](ordinary-entry/runtime.json)遍历 0 至 7 个参数的拒绝情形，694 次均得到预期错误，没有目标合约指令或通知；正确的只读对照执行了 183 条目标指令。部署和系统内部调用保留方法的行为不属于这个拒绝结论。

收款地址的[计费证书](receiving-address/fees/result.json)针对单次规范查询：在固定指令价格、无费用豁免且无其他故障时，需要 67,611 × 整数费率个最小 GAS 单位；缺少读取权限时，原生方法费尚未收取，已发生的费用为 34,843 × 费率。[真实引擎](receiving-address/fees/fees.trx)在本地费率 30 时核对了 20 个预算边界，另验零 ID 及权限拒绝。

启用 Huyao 后，设 p 为节点的整数 pico 费率，标准调用路径的最低预算为 ceil(65,551,523 × p / 10,000,000) 个最小 GAS 单位。向上取整发生在累计费用上。本地 p = 300,000，最低预算为 1,966,546；实测涵盖 22 个预算，包括每个正收费点的累计预算及其前一个单位。定理假设计价系数、单元素 PACK 的执行统计与实际 VM 一致，宿主算术不溢出且无费用豁免或其他故障。这不是转账费用或公共网络报价。[实际调用字节和费用](receiving-address/fees/fees.json)可用以下命令与对应 DLL 一并复验：

```sh
python3 formal/refinement/native_address_fees.py --assembly contracts/native/bin/Release/net10.0/Neo.dll --fees docs/reports/smartaccount-current-20261124/receiving-address/fees/fees.json --dispatch docs/reports/smartaccount-current-20261124/native-signatures/dispatch-signatures.json --output /tmp/sa-address-fee-check
```

收款地址的[符号证明](receiving-address/ReceivingAddress.v)覆盖任意长度为 20 的账户字节串：生成的脚本为协议规定的 60 字节，从偏移 2 可还原全部 20 字节，所以不同 ID 的验证脚本必然不同。模型拒绝空引用和全零 ID，对非零 ID 返回规定脚本的哈希。该性质不主张哈希无碰撞。证明绑定[当前 DLL 中八个方法的指令、调用目标和异常处理范围](receiving-address/methods.json)；从 CIL 到模型的转换经人工审阅，底层编码、UInt160、Hash160 和宿主执行仍是前提。[复验收据](receiving-address/result.json)记录 6 个定理通过内核复验以及 4 个改错对照遭拒。仓库根目录复验命令：

```sh
python3 formal/refinement/native_address_proofs.py --assembly contracts/native/bin/Release/net10.0/Neo.dll --vectors docs/reports/smartaccount-current-20261124/receiving-address/address-vectors.json --output /tmp/smartaccount-address-proof
```

收款地址按原生核心固定的 `ReadOnly (5)` 生成验证脚本。钱包、SDK 和代理见证共用同一实现；非标准标志、零账户 ID 不能生成收款地址。执行交易仍用 `All (15)`。本地 [ApplicationEngine 收据](receiving-address/address.trx)覆盖 160 个单位置位 ID 及其逐位补码：在无签名、尚未注册的状态下，320 个有效 ID 均返回预期地址，零 ID 被拒绝。运行 `node scripts/check_native_receiving_addresses.cjs docs/reports/smartaccount-current-20261124/receiving-address/address-vectors.json` 可将[同一 DLL 导出的脚本及地址](receiving-address/address-vectors.json)逐项与 SDK 比对。这是运行时边界样本，不是对全部 160 位输入、GAS 或整个入口的形式化证明。

[原生方法签名证书](native-signatures/result.json)核对全部 29 个入口：从实际 DLL 的处理函数取参数，检查执行引擎或存储快照的注入，再将分发器剩余的 65 个参数位置逐项映射到钱包 manifest 的类型与顺序。29 个返回类型也逐一匹配，包括异步方法的返回类型。证书通过 Coq 内核复验，8 个改错对照均失败。可复核[运行时签名导出](native-signatures/dispatch-signatures.json)、[证书源码](native-signatures/NativeDispatch.v)和[引擎收据](native-signatures/handler-signatures.trx)。这项检查针对声明的类型；未证明具体 VM 值的转换、处理函数语义、GAS 或回滚。

当前构建补全了安装检查的反向约束：四参数 `configure` 必须出现在生命周期声明中；其他参数数量的同名方法不算配置回调。核心与发布工具采用同一规则。20 个模块重编后 manifest 和 NeoVM getter 均匹配；[56 项安装、授权与标准模块用例](module-configuration/configure.trx)通过，含四个配置声明与方法参数数量的组合。此 DLL 的 [29 入口分发证书](module-configuration/dispatch-arity/result.json)现逐项核对参数数量，故意改错一个参数数量会被拒绝。[两个发现入口的编译方法体证书](module-configuration/native-discovery/result.json)与[真实调用收据](module-configuration/current-wire.trx)来自同一构建；[策略模型](module-configuration/policy-model.json)也已复验。这里没有证明参数值转换、其余方法体、费用或回滚。下方较早收据保留其原有构建指纹。

原生安装入口现按模块 NEP 检查 UTF-8 声明、能力字段、角色和回调列表，以及声明的配置方法签名。9 组不合规声明均未产生安装事件，随后安装合规模块取得实例编号 1。[原生与 Core 全套回归](module-admission/admission.trx) 1,730 项通过；重新编译六个标准模块并校验指纹后，[安装与标准模块复验](module-admission/fresh-modules.trx) 41 项通过。[当前策略模型](module-admission/result.json) 通过 24 个声明及 30 个变异检查。安装检查与模型复验均不构成完整入口精化证明。

当前候选原生核心的[分发表证书](native-dispatch/result.json)覆盖 29/29 个 ABI 入口。对实际生成的 203 字节脚本，逐项核对入口位置、版本字节、CallNative 指令位置、返回指令、CLR 处理函数及基础费用字段，再对 16 种权限掩码逐项验证（464 种组合）。[真实引擎测试](native-discovery/dispatch.trx)运行了其中权限不足的全部 311 种组合，均由原生权限检查拒绝且无通知。其余 153 种仅通过本层权限判定，能否执行取决于方法内的账户状态、签名和业务条件。证书未把分发元数据中的基础 CPU 费用当作整笔调用的 GAS 费用，也不证明 CLR、动态调用参数转换、方法体或失败回滚。

当前原生核心的两个发现入口已有[编译方法体返回值证书](native-discovery/result.json)。`getAccountImplementationId` 返回字符串 `NativeSmartAccount`；`getProtocolInfo` 返回只包含协议编号 4 的 Neo 数组。Coq 内核检查读取的是 DLL 中的 CIL 字节和解析后的元数据引用；整数转栈项、单元素集合和数组构造依赖明确的库语义及分配成功前提。三种改错（身份、编号、构造函数映射）均未通过。该 DLL 与[真实调用测试](native-discovery/native-wire.trx)加载的 DLL 字节相同；无签名者、16 种请求权限下的 32 次调用均按预期返回，未产生通知。以上不能替代原生分发、CLR/JIT、费用、故障路径和公共网络激活证明。

**当前候选原生核心**从实际 DLL 生成的 [manifest](../../../tests/fixtures/native-smartaccount.manifest.json) 含 29 个公开方法和 17 个事件。远端 main 核对为 `66b1715`，这里测试的是其上的本地修正。已复现并修正 SDK 与钱包发现流程漏掉 `ModuleInstanceConfigured` 后拒绝正确核心的问题。SDK 172 项、前端账户 42 项、原生 manifest 实物比对 1 项、当前形式化源码锁 2 项本地通过。中英文第 18 章按同一编译产物逐字段核对。接口一致性不等于方法体、费用、回滚或运行时精化；原生实现仍未获完整证明。

**下面的 100 入口和初始化器 GAS 数据属于指定普通合约的独立验收**，不构成上述原生核心的入口数、费用或优化依据。

[三个普通查询入口的费用证书](ordinary-presence-fees/result.json)按实际调用脚本、NEF 和锁定的 Neo Core 指令及系统调用价格，独立计算每次成功读取的 191 条指令。调用脚本、初始化器和方法体分别为 34,842、381,537、43,131 个基础计价单位，总计 459,510；初始化器占约 83%。[计费定理](ordinary-presence-fees/PresenceFeeArtifact.v)覆盖这条路径上任意非负整费率和预算，依赖非白名单、无其他故障等前提。价格投影和路径提取在 Coq 内核之外。真实引擎收据现已从下述 93 次扩展到 1,224 次：本地费率 30 时，每个实际指令位置、执行前费用、最终费用以及停止原因均已独立核对，包含每个不同累计费用及少一个单位的预算。它不是任意调用脚本或公共网络费率的证明。

普通合约的三个存储存在性查询（`isExecutionActive`、`hasPendingVerifierUpdate`、`hasPendingHookUpdate`）按部署合约 ID、存储前缀和账户取值：键存在但值为空时返回真，已删除的键不能被底层旧值恢复。[方法体与存储模型收据](ordinary-presence/result.json)绑定到 Neo Core 提交 `d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d` 的系统调用注册、处理函数与 DataCache 读取分支。缓存的逻辑可见值和物理缓存填充是两回事；底层读取、键相等性、VM 值转换和不干扰的读取回调仍是前提。

[真实 ApplicationEngine 收据](ordinary-presence/runtime.json)记录部署后经 `System.Contract.Call` 的 93 次调用，覆盖此前 27 次检查。45 次检查覆盖三个入口、五种存储情形（缺失、空值、非空值、底层命中、缓存删除）及三个 GAS 预算边界。另 48 次逐入口遍历四位调用权限组合：有 ReadStates 的 24 次成功；其余 24 次均在 GetContext 被拒，未收取该系统调用的固定费用。读权限拒绝前已经执行的指令仍会收费。成功路径的 GetContext 和 Get 在本机配置下分别收取 480 和 983,040 个最小费用单位，总调用消耗 13,785,300；这些数值不是公共网络报价。相同键在其他合约命名空间、不同前缀与不同账户的干扰项也纳入每次测试。完整入口数不因这些运行样本而增加。

模块标准：[公共接口](../../proposals/nep-smartaccount-module-interface.mediawiki)、[具名条款](../../proposals/nep-smartaccount-module-profiles.mediawiki)、[逐模块 ABI](../../proposals/smartaccount-module-abis.md)。20 个模块用 nccs 3.9.1 重新编译，manifest 和附录逐项一致。这个结果验证发布接口形状，不验证任意操作下的行为。

100 入口目标的共用初始化器另有[参考语义收据](ordinary-initializer/result.json)和[真实 NeoVM 收据](ordinary-initializer/runtime.json)。参考语义涵盖 170 条指令、全部 53 个静态槽、两个新数组、原参数栈和已有堆对象；参考模型把字节缓冲区按值表示。VM 3.10.1 在 98 个普通入口的样本帧逐一执行到原始 RET，检查返回位置、参数对象、共享静态槽的值和类型。故意改变一个字节及颠倒一个数组分别在预期槽位被拒绝。该探针从已构造的方法帧开始，不执行方法体，也不验证费用或失败回滚。

指定的 100 项普通合约 ABI 已完成[普通调用权限与建帧的逐项证书](ordinary-entry/OrdinaryEntryArtifact.v)和[内核复核收据](ordinary-entry/result.json)。该证明直接读取目标 NEF 与 manifest：55 个 safe 方法、43 个需要调用方权限的方法，以及拒绝普通调用的两个保留入口。核心的权限查询结果作为输入；证明止于首条指令执行前，不证明特殊部署、初始化器执行、方法体、GAS 或失败回滚。完整入口证明仍为 0/100。此收据针对指定普通合约，与下方原生合约的回归结果分开计算。

同一归档 NEF 的三个查询（`getAccountImplementationId`、`supportsExecutionMode`、`supportsModuleType`）另有[初始化器、方法体和正常返回栈收据](ordinary-pure/result.json)和[17 次真实引擎调用](ordinary-pure/runtime.json)。从仓库根运行 `python3 formal/refinement/ordinary_pure_proofs.py` 可重建参考语义证书。源码预期取自归档的 C#，字节取自上述 NEF。成功时结果压在调用方原栈之上，原有各项顺序不变；方法体未正常返回时，没有正常结果。该模型假设快照提交、引用清理以及回调成功且不干扰栈，不证明费用、资源上限或异常回滚。

[返回路径源码核对](ordinary-pure/return-source.json)固定了 RET、CopyTo 和两层 ContextUnloaded 所在源码的完整哈希，并逐项核对栈操作顺序；这不是 C# 到模型的机械精化证明。[单独的调用方栈探针](ordinary-pure/returns.json)为调用方预放一个整数和同一数组的两个引用，在初始化器与方法 RET 前后核对栈项的对象身份。15 次成功调用均从预期位置继续；两个 65,537 字节输入停在方法内的首个 EQUAL，不进入调用方后续指令。重跑时使用 `dotnet run --project formal/refinement/presence-probe -- <NEF> <manifest> <output.json> --pure-returns`；独立核对源码使用 `python3 formal/refinement/ordinary_return_source.py --output <output.json>`。

[查询费用证书](ordinary-pure/fees.json)覆盖这三个方法。[三个整次调用预算定理](ordinary-pure/PureFees.v)按参数长度选取规范的入栈指令，将调用准备、系统调用、170 条初始化指令、实际经过的方法分支和成功返回时的调用方 RET 合并。对任意已准入的字节串、价格因子和预算，全部费用能够结清，当且仅当预算达到该路径的总价。付清费用不保证成功：超过 65,536 字节时，首次比较收费后仍会失败。上述费用是指定调用脚本的模型结果，不是任意用户交易的 GAS 报价。

[92 次引擎调用](ordinary-pure/runtime-fees.json)覆盖 23 个输入，每个输入分别使用充足、恰足、少一和零预算，按指令核对位置、操作码及累计费用。两个能力查询均覆盖 255、256、65,535、65,536 和 65,537 字节。用上段引擎命令的 `--pure-fees` 生成 `ordinary-pure/runtime-fees.json`，再运行 `python3 formal/refinement/ordinary_pure_fees.py` 复核证书。模型以规范调用脚本、锁定价格表及无其他资源故障为条件；任意外层交易、整数溢出、费用豁免、字节码到实际 VM 的普遍对应仍未证明。

[非整数费率的另 92 次执行](ordinary-pure/runtime-fees-pico.json)在隔离快照中将 Faun 的策略费率设为 300,001 picoGAS/价格单位，与默认的 300,000 对照。引擎先累计 picoGAS，再按 10,000 picoGAS = 1 datoshi 向上取整。三条 `*_pico_budget` 定理证明，对于指定脚本，预算覆盖全部收费当且仅当它不小于总 picoGAS 换算后的整数金额；没有逐条取整。例：查询实现标识所需预算为 12,430,482 datoshi，少 1 即因费用不足失败。复验时另用 `--pure-fees-pico` 生成 `ordinary-pure/runtime-fees-pico.json`，再运行同一 Python 校验器；它核对两组共 184 次执行的逐指令读数。收据未覆盖引擎在公开费用读数超出 Int64 时的回退分支。

[最高策略费率的 92 次执行](ordinary-pure/runtime-fees-max.json)用 `--pure-fees-max` 生成；三组运行合计 276 次。三条 `*_readback` 定理覆盖提前耗尽预算的最后一次收费：从零开始，规范调用脚本读取实现标识最多消耗 41,434,800 datoshi，两个能力查询均不超过 42,066,300 datoshi。因此，在锁定策略允许的费率范围内，这三条路径不会触发 Int64 读数回退。若执行前已有费用，充分条件是此前实际累计的 picoGAS 加上对应上界（换为 picoGAS）不超过 `Int64.MaxValue × 10000`。这是已提取收费序列的结论，不覆盖任意外层脚本产生的其他费用，也不是费用报价。

治理配置回调修正后的本地结果：[完整原生测试 1,719 项通过，零跳过](governed-config-native.log)；[当前 Coq 收据：24 个声明，30 个变异均拒绝](governed-config-formal.json)。新的参数指纹是 `0cab62cf2a69b5682bf0d976406ddce15d7afbd67db4c1bc4e4950cf180a6dd0`。成熟提案的动作 3 由核心分发；运行时验证直接调用和提前确认均拒绝，后续配置失败时先前写入回滚。模型证明覆盖任意已暂存动作前缀后的失败；实现与 VM 的普遍精化仍未闭合。

以下表格记录的是同日修正前的源码快照，不能用作上述指纹的验收收据。

自定义消息签名名单和强制多签成员表存放在已确认政策的标准治理模块。一个账户在一个模块内每类最多一条记录。普通账户不需要安装该模块。核心绑定模块存储编号和策略摘要，继续执行支出门限；预设延时恢复不依赖旧名单仍然可读。

| 检验 | 本机结果 |
| --- | --- |
| 原生合约、标准模块与 Neo Core 回归 | [1,717 项通过，零跳过](owned.trx) |
| 强制支出策略丢失后，托管人仍被约束，到期后恢复 | [单独复验通过](owned-loss.trx) |
| 当前形式化策略模型 | [22 个声明，30 个变异全部拒绝](result.json)，复核 68 个源码指纹 |
| 当前协议参数指纹 | `b24f9df284802353549eacced020b0b6afa594e2f69bcac596df3ae83d3a6c2b` |

完整回归采用最终治理 NEF `684e5048a3e06c9f0807585b80417c254fdd90c9c07c1f40058b5e52b0f9908f` 与 manifest `359d6cbf72219c90806a46fd77fb598c23ee3f12d03ea0c90280273d4312b471`（SHA-256）。开发中较早的一次并行运行读取了前后两个不同构建的模块，发生 13 项失败；未使用该运行作为最终验收。

100 入口证明绑定本地归档构建的[manifest](ordinary-entry/input/UnifiedSmartWalletV3.manifest.json)（SHA-256 `e79fa04969ef3f0bdd6b9df6afe41acdd19767968575ea38c1cd011ee97e5156`）与[NEF](ordinary-entry/input/UnifiedSmartWalletV3.nef)（`083ed325f9bdaa6b223662042f32d29f398ba055f507bbdde46daf8113c47f2a`），两份归档镜像的字节一致。`git show 1371a54:contracts/build/UnifiedSmartWalletV3.manifest.json` 对应 90 个条目；该目录中 manifest 的 SHA-256 是 `24c4710a8ac00a3df236d2a08509726dbe2745174abf833dd52e26d89b03b1b4`，NEF 是 `c634ab9821c83bdb53b342d64359183cff2b917ac2dc5bdd9b57613494d09b4b`。两者不能互换。完整证明仍为 0/100，收据保留 `implementationVerified=false`。

模块 NEP 单独复验：按[中文索引](../../proposals/SMARTACCOUNT-MODULE-NEPS.zh-CN.md)核对 20 个具名模块。运行 `python3 scripts/check_module_neps.py --compiler nccs --vm-getters`，20 份编译 manifest 与 ABI 附录一致，20 个部署到本地 NeoVM 的合约均返回了预期的声明字节。错误摘要的对照检查被拒绝。订阅模块最后一次输入类型修正后，单独重验其编译 ABI、getter 和 10 项行为用例，全部通过。行为用例使用测试核心，覆盖账期边界、取消重建、ID 长度、金额与周期类型和商户授权；不证明公共网络接纳或全协议精化。复验步骤见仓库 CI 的 `Verify subscription module behavior in NeoVM`。独立的原生模块生命周期探针 8 项通过。

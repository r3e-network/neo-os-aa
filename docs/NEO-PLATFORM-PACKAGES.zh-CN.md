# Neo 平台包与 verifier gas syscall（R-11 / N-DEP-1）

> 中文版本与 `docs/NEO-PLATFORM-PACKAGES.md` 同构。若两者冲突，以英文版本为准。

2026-10-08 状态：公开合约配置及其测试使用发布在 nuget.org 上的固定版本包。
公开的 verifier 执行与私有回调 gas 隔离是两个不同的配置，各有独立的工件目录与证据
（[SA-REPRODUCIBLE-BUILD.md](SA-REPRODUCIBLE-BUILD.md)）。

## 历史私有运行时复验（2026-10-06）

已安装的公开 `neoxp` runner 仍与 SmartAccount 工件不兼容：当 VM 解析
`System.Contract.CallWithGasLimit` 的 interop 哈希时，一次全新运行会 fault。这是
runner/runtime 不匹配，而不是回调上限可选的证据；该失败回执与发布证据分开保留在
`docs/reports/sa-neoexpress-validation-20261006-v2.json`。

随后用一份独立的本地 NeoExpress 构建（链接到匹配的私有 Neo 运行时
包）对该工件快照进行了运行。它部署了 25 个合约，
完成了全部 14 个场景且无跳过场景，持久化了 108 笔交易，
并回读了全部 25 对 NEF/manifest。该历史快照的回执是
`docs/reports/sa-neoexpress-validation-20261006-custom-did.json`；runner 源码、
包哈希与临时的 API-adapter 边界记录在
`docs/reports/sa-neoexpress-runner-provenance-20261006.json`。

这闭合了匹配运行时的私有 NeoExpress 执行/回读证据。它不改变让私有
包可复现地提供给干净 CI 这一独立的 owner 动作，也不确立公开
网络激活或部署一致性。

2026-09-28 的历史状态：**已知为红，需要 owner 动作。** 干净的 CI runner 无法还原
`contracts/Directory.Build.props` 固定的那些包，因此合约构建、合约
测试与 deploy-tool 测试都不在 CI 中运行。`.github/workflows/ci.yml` 中的
`Check pinned Neo platform packages` 步骤（以及 `scripts/verify_repo.sh` 中的第一个合约门禁）
运行 `scripts/check_neo_platform_packages.mjs`，它在数秒内以下面的 owner
动作停止，而不是在构建深处抛出一个裸的 `NU1102`。

## 运行时配置

| 配置 | 工件目录 | Verifier 回调 | 运行时要求 |
| --- | --- | --- | --- |
| 公开 `v3` | `contracts/bin/v3` | 标准 `System.Contract.Call`；校验只读，执行后记账保留写权限 | 已发布的 Neo 运行时；没有隔离的 verifier 子 gas 预算 |
| Native ABI 2 | 显式的 native-module 构建输出 | SmartAccount 有界原生回调：verifier 1 GAS，hook/maintenance 2.5 GAS | 源码构建的 native 合约、`HF_SmartAccountV1`、ABI 2 metadata 与 epoch 感知模块 |
| 私有 `PLATFORM` | `contracts/bin/platform` | `System.Contract.CallWithGasLimit`，每个 verifier 回调 10 GAS | 匹配的私有运行时与激活；无法在普通公开节点上运行 |

`bash contracts/compile.sh` 用固定版本的已发布编译器与
框架构建公开 `v3` 与私有 `PLATFORM` 配置。脚本只在执行源码的一次性副本中定义 `PLATFORM`；
`--platform` 只构建私有核心。公开的 deploy/upgrade 辅助脚本选择 `bin/v3`。
双配置可复现性门禁会比较两个输出目录；仅有字节一致
并不确立运行时支持或部署一致性。

对于私有 NeoExpress 验证，`scripts/neoexpress_validate.py` 从
`bin/platform` 部署核心、从 `bin/v3` 部署模块，并记录每次部署的配置。
provenance join 独立选择同一配置；公开核心的回执不能
与有界回调证据 join。把 `NEOOS_NEOXP` 设置为一个源码构建的 runner，它在
`HF_SmartAccountV1` 下注册 `System.Contract.CallWithGasLimit`；已发布的普通 `neoxp`
不满足该运行时要求。

对于发布级的 runner provenance，传入
`--runtime-build-receipt <PASS-runner-build.json> --runtime-dir <complete-runtime-dir>`。
验证器调用 `dotnet <runtime-dir>/neoxp.dll`，在链运行前后校验回执中的完整
runtime 文件映射，并只在 NeoExpress 回执中记录构建回执、
`neoxp.dll`、runtime 文件数与 wrapper 哈希。证据中不写入任何宿主
路径。

Native 模块由 `scripts/build_native_modules.py` 单独构建。它的
六个项目遵循同一份根 `Directory.Build.props`、`nuget.config` 与
经审阅的逐项目锁；锁缺失或改变即为构建失败。
打包器要求 `native-v2`、精确的 Array 回调、ABI 2 metadata 以及显式的
`getAuthorityEpoch` 权限。SessionKeyVerifier 还要求固定 native 合约上有显式的
`canonicalP256PublicKey` 权限。每个模块都声明精确的参数
指纹以及布尔型的 verifier-composition 标记；复合 verifier 必须
暴露额外的回执校验与执行后回调。它记录原始/预处理源码以及两种
原始/打包工件字节，然后比较两次独立的 scratch 构建。
在构建前运行 `node scripts/check_neo_platform_packages.mjs --include-native` 覆盖全部
36 个项目，包括两个仅测试用的 epoch 探针项目与两个源码运行时
探针宿主。运行时宿主不使用任何 NuGet 包：其
已提交的锁必须包含空的 net10.0 依赖图，且其 Neo
程序集必须来自经显式验证的源码构建运行时。Native
runner provenance 必须独立 pin
经审阅的 core 与 node/RPC 源码；公开编译成功并不确立
native 激活或费用估算兼容性。

四个 verifier 路径测试
（`ExecuteUserOp_VerifierPath_AcceptsValidSessionSignatureWithoutOwnerWitness`、
`ExecuteUserOp_VerifierPath_RejectsTamperedSessionSignature`、
`ExecuteUserOp_RecoveryVerifier_EnforcesOwnerAndCoreContext` 以及
`ExecuteUserOp_ActiveEscape_OnlyBackupOwnerWitnessMayExecute`）在已发布的
TestEngine 上运行，没有 private-syscall 跳过。`CompiledCoreSyscallTests` 检查实际的
NEF：公开核心不包含该私有 syscall，而独立的 `PLATFORM` 核心
保留两个有界 verifier 回调。`tests/localchain/test_public_profile.py`
在一次性已发布 NeoExpress 上演练一次公开的 verifier 签名操作。

私有配置以 `[Syscall]` 声明该 syscall，因为固定的已发布
框架不暴露它。这使它能够编译，但不代表能在缺少该
interop 的运行时上执行。下面这条历史的私有 Neo 3.10.1.1 构建在 `HF_Iara` 之后注册它。
历史 gas-cap 回执只适用于其确切的私有 runtime/source/artifact
快照。抽象的 `VerifierGasBudget.v` 义务只适用于有界的 `PLATFORM` 与 native 回调；公开配置没有
这样的子预算，公开的任意模块赞助仍是独立的资源
与准入策略问题。公开激活是平台决策。

## 历史公开部署观察

已部署的 SA 核心不依赖上述任何内容。2026-09-28 的公开 JSON-RPC 读取：

| 网络 | SA core | NEF 校验和 | 编译器 | `CallWithGasLimit` syscall |
| --- | --- | --- | --- | --- |
| MainNet | `0x0268a387913b250166ddec032b03332690a1ef78` | 2035992441 | Neo.Compiler.CSharp 3.9.1 | 缺失 |
| TestNet | `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2` | 2785794149 | Neo.Compiler.CSharp 3.9.1 | 缺失 |

MainNet 核心可由公开包复现：用公开框架 3.9.1 与 `nccs` 3.9.1 在干净缓存下
编译提交 `4149496`（gas cap 之前的源码），得到校验和为 2035992441 的
`SmartAccountV3.nef`，与链上及
`contracts/build/SmartAccountV3.nef` 逐字节一致。当前源码还有额外的合约改动与独立的运行时配置；
当前的公开部署一致性需要一次新的源码/工件/RPC 比较。

## 历史私有包

以下归档用于 2026-09-21 的私有 gas-cap 验证。它们
不是公开 verifier 测试所必需的，也不是编译任一当前配置所必需的。执行 `PLATFORM`
回调需要私有运行时；这些归档哈希描述的是历史测试环境，
不是新的运行时发布。默认的 `nuget.config` 或 CI 中没有任何内容选择这些归档。
它们的受审计字节：

| 包 | 版本 | `.nupkg` 的 SHA-256 | 公开？ |
| --- | --- | --- | --- |
| Neo.SmartContract.Framework | 3.10.2-CI00384 | `172597b180f6ae9d93c1901bec11d8f2ce76b46c465a2dd3552ae876e5421d65` | 否 |
| Neo.SmartContract.Testing | 3.10.2-CI00384 | `92a06b27548c10da98c54043ff4dfd5eaf6c1b74df4fc707b6e7cc67c7b9ce6a` | 否 |
| Neo.Disassembler.CSharp | 3.10.2-CI00384 | `9ee27bb5b372bba07ef0872ca22ab4700be0c3dc87deb5cbc1ada9a895901f21` | 否 |
| Neo | 3.10.1.1 | `4218a38a767d8c9c0d8bfbd6cc91c9bd13f9d298c816dd72366a3f3735960d49` | 否 |
| Neo.Extensions | 3.10.1.1 | `93e296fe0773db0ddaeb4f0a9d9174555f65ae17560497e72e8f4a692ffe500d` | 否 |
| Neo.IO | 3.10.1.1 | `b1bba7f6aad5275f05ac13f4356c56caaac5866318ef87b30cd14d8ed3a2dcf7` | 否 |
| Neo.Json | 3.10.1.1 | `0275990e41fe6fb6163183ceb5b151a62a16219294852569d1b85a8ef7f4fa63` | 否 |
| Neo.VM | 3.10.2-CI00384 | `84bd08d291362cfaf85697f0fb14666719d3443f2f71c39c8de1b9184c20820e` | Neo MyGet feed 上的上游 nightly |

framework 与 testing 的哈希等于 `docs/reports/sa-platform-gas-cap-20260921.json` 中的对应值。
与已发布的 3.10.1 框架相比，私有版本新增了 `Contract.CallWithGasLimit`，缺少
`AccessControl` 与 `Ownable2Step`，其余差异仅在注释以及
`Nep11Token.Burn` 的错误路径（比较于 2026-10-04）。

2026-10-04 的 provenance 审阅发现，nuspec 命名的
`neo-project/neo-devpack-dotnet@34255c4` 与 `neo-project/neo@8461a72`，而这两个
提交都不包含 `CallWithGasLimit`；被测改动是叠加在这些
提交之上的。因此那些历史归档标签并不能证明完整源码。
在保留历史回执时，请保留它们的精确字节。任何新的私有
运行时发布都必须指明其完整的已提交源码、可复现的包哈希、
激活配置与运行时测试；不要把这些哈希复用于重新构建的归档。

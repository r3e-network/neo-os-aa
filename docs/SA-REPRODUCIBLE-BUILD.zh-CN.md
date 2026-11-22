# SA 合约：从已发布包可复现构建

> 中文版本与 `docs/SA-REPRODUCIBLE-BUILD.md` 同构。若两者冲突，以英文版本为准。

包基线建立于 2026-10-04（审计发现 R-11 / N-DEP-1，计划项 P1-C-AAV4-BUILD）。SA 合约及其测试
还原所用的每一个包都发布在 nuget.org 上，工具链被固定，因此第二位构建者会得到相同的 NEF 与
manifest 字节。

## 被固定的内容

| 项 | 固定值 | 位置 |
| --- | --- | --- |
| `Neo.SmartContract.Framework`、`Neo.SmartContract.Testing` | 3.10.1 | `Directory.Build.props`（`NeoSmartContractFrameworkVersion`） |
| 它们引入的 Neo 包 | `Neo`、`Neo.Extensions`、`Neo.IO`、`Neo.Json`、`Neo.VM`、`Neo.Disassembler.CSharp` 3.10.1；`Neo.Cryptography.BLS12_381` 3.9.0 | `contracts/neo-platform-packages.json`（每个包的 SHA-512） |
| 其他每个包（MSTest、Akka 等） | 解析出的版本与内容哈希 | 每个在范围内的项目都有已提交锁文件；默认范围是原生清单（六个原生模块、两个仅测试用的 epoch 探测项目，以及两个 NuGet 依赖锁为空的运行时探测宿主） |
| 包源 | 仅 nuget.org，每个包 id 都映射到它 | `nuget.config` |
| 编译器 | `Neo.Compiler.CSharp` 3.9.1（`nccs`） | `.github/workflows/ci.yml`；已安装的包会与 `contracts/neo-platform-packages.json` 核对 |
| SDK | .NET 10（`net10.0`） | `ci.yml` 中的 `actions/setup-dotnet` |

还原以锁定模式运行，`dotnet` 侧与 `nccs` 按项目运行的还原都是如此：任何会改变锁文件的解析
都以 `NU1004` 失败，任何字节与锁不符的包都以 `NU1403` 失败。

## 还原、构建、测试

```bash
dotnet tool install -g neo.compiler.csharp --version 3.9.1
node scripts/check_neo_platform_packages.mjs                  # pins, lock files, locked restore, package hashes
node scripts/check_neo_platform_packages.mjs --compiler-only  # the installed nccs is the pinned package
dotnet build SmartAccount.sln -c Release                      # 仅含原生的解决方案：固定原核、六个模块、探测宿主
dotnet test tests/SmartAccount.Native.Tests/SmartAccount.Tests.csproj -c Release
```

`SmartAccount.sln` 是原生构建入口：它包含原生核叠加项目（`contracts/native/Neo.csproj`）、
六个 native-profile 模块、原生单元测试与探测宿主，不包含任何 custom 项目。构建它需要一个
已审阅的原核检出目录；用 `NEOOS_NATIVE_CORE_SOURCE` 指向它（默认同级的 `../neo-native-core`）。

`./scripts/verify_repo.sh --contracts-only` 运行原生构建与单元测试轨；MSBuild 把原生核写入各项目
自己的 `bin/Release/net10.0/`。要证明一次干净还原，请先把 `NUGET_PACKAGES` 指向一个空目录。

### 选择验证画像

`./scripts/verify_repo.sh --profile native` 是默认值，也是唯一画像。它运行原生包锁、
协议与运行器守卫、仅含原生的解决方案构建与单元测试、原生模块 epoch VM 回归以及原生浏览器
覆盖，且不读取已退役 custom 树的任何内容。`--contracts-only`、`--frontend-only` 与
`--sdk-only` 仍然用于选择要验证的组件。共享的确定性前端／SDK 单元测试照常运行；它们不需要
原生节点。

每个被选中的命令都是强制的，其失败会终止门禁。原生 epoch 固定样例是模块级 VM 证据；独立的
`native-profile.yml` 工作流额外构建固定的原核并执行原生 VM 矩阵。两条命令都不确立公开激活
或全链准入。

主 CI 工作流还会在安装前端依赖与 Playwright 之后，以一个独立的必需步骤运行原生浏览器固定样例。
它复用这些安装，不重复前端构建或完整单元测试套件。该工作流没有路径过滤，因此原生 UI、共享
代码、SDK 与前端测试的改动都会选中浏览器门禁，而无需原生节点。

`--formal` 显式加入聚合形式化检查及其源码锁要求。`--skip-e2e` 跳过一次性链支路，但保留全部
离线门禁。`NEOOS_NEOXP`（否则 `NEOXP`、PATH 或用户工具目录）选择已发布的运行器；该路径
不启用任何私有分叉。

原生侧的溯源合并由 `scripts/native_epoch_probe.py` 与 `scripts/neoexpress_native_*_validate.py`
套件完成：它们把重建工件与当前源码快照、模块 NEF 哈希、校验和、完整 manifest 与 RPC script
回读绑定起来。这是经过测量的子集，不是对整个模块目录或公开部署的证明。原生全链验证遵循其
单独的文档化运行器。可选的已选中检查在未被选中时保留其显式的 NOT RUN 消息。

## 复现

### 原生构建产物

原生核是唯一的构建目标。`dotnet build SmartAccount.sln` 针对固定的原核检出目录编译叠加核心
（`contracts/native/SmartAccount/`），`scripts/build_native_modules.py` 在锁定还原策略下用两棵
独立的 scratch 树复现六个 `SMARTACCOUNT_NATIVE` 模块，并把它们写入调用方指定的 `--output` 目录。
`scripts/native_epoch_probe.py` 在公开 VM 中运行这些工件，并把回执写到它自己的 `--output`。两者都没有
默认目录，`contracts/bin/native` 也不是任何脚本的目标。

已退役 custom 轨的 `public` 与 `platform` 画像（`contracts/bin/public`、`contracts/bin/platform`）
属于归档工件，且从未被跟踪：`bin/` 在忽略列表中，干净检出中两者都不存在。它们的 `compile.sh` 配方与所
构建的用户合约项目在仓库转为 native-only 时被移除。
下文记录的摘要作为历史回执保留，仓库中没有任何东西重建它们，且
`scripts/check-artifact-reproducibility.mjs` 拒绝重放已删除的配方。不要部署这些工件，也不要把
它们记录的字节当作当前的原生证据。

作为记录：已退役的公开画像使用已发布的 `System.Contract.Call`，校验只读、`postCheck` 记账可写，
且不对验证器 gas 设上限；已退役的私有 `PLATFORM` 画像使用 `System.Contract.CallWithGasLimit`。
生命周期 ABI 准入从来不是验证器信任或资源策略：公开中继在赞助前仍必须自行施加经复核的模块策略、
模拟与有限交易费用上限，无限制的受赞助准入仍然不安全。`contracts/build` 仍是历史已部署工件固定样例。

### 公开验证器发布选择

`scripts/deploy_latest_sa_validators.js` 与其他公开部署脚本一样，通过同一个受限工件路径 helper，从
`contracts/bin/public/validators/` 选择 SessionKeyValidator，从 `contracts/bin/public/` 选择
SocialRecoveryService。若那对经复核的公开 NEF／manifest 缺失，它必须失败；它绝不能回退到历史
`contracts/build` 固定样例或私有／原生画像。被选中的 manifest 必须匹配预期的模块名、版本与
账户 ID ABI。在现有的授权核心绑定检查能够成功之前，部署回读必须匹配被选中的 NEF script 与完整
manifest。

发布前请重建并复核这对公开工件。离线加载器测试覆盖路径选择并拒绝缺失或不匹配的对；它们既不会
广播交易，也不确立公开部署的一致性。

### 两次构建对比

下文证书所用的两次构建重放依赖 `contracts/compile.sh`，而该脚本已随 custom 轨一起删除。因此
`scripts/check-artifact-reproducibility.mjs` 会直接失败关闭，而不是重放仓库中已不存在的配方；
记录的摘要作为历史回执保留。原生替代方案是 `scripts/build_native_modules.py`：它在两棵位于不同
临时路径的独立 scratch 树中构建六个 `SMARTACCOUNT_NATIVE` 模块，除非每个 NEF 与 manifest 的摘要
都一致，否则失败：

```bash
python3 scripts/build_native_modules.py --contracts contracts \
  --compiler "$NCCS_BIN" --cache "$NUGET_PACKAGES" \
  --output <新目录> --receipt <receipt.json>
```

它不会仅凭可复现性推断运行时兼容性。以下段落记录已退役 custom 画像的重放及其归档证书。

2026-10-08 的重放匹配 **80/80** 个文件：`bin/public` 下 **78** 个、`bin/platform` 下
**2** 个，无漂移、无缺失。原生集成源码的精确摘要与画像结论见
[`sa-native-abi2-public-platform-reproducibility-20261008.json`](reports/sa-native-abi2-public-platform-reproducibility-20261008.json)。
2026-10-31 的当前源码重放同样匹配 **80/80** 个文件，画像划分仍是 **78 + 2**，无漂移、无缺失。
其证书为
[`sa-artifact-reproducibility-20261031.json`](reports/sa-artifact-reproducibility-20261031.json)；
私有链的连接结果为
[`sa-private-artifact-provenance-20261031.json`](reports/sa-private-artifact-provenance-20261031.json)。
2026-11-13 对抽取后代码树（注册器迁移、市场托管与 paymaster 结算拆分、受备份 owner 门禁的冻结面）
的重放同样匹配，无漂移、无缺失；其证书——其中文本输入摘要在 LF 上归一化，使 Windows
`core.autocrlf` 检出测量到与 Linux CI 相同的字节——为
[`sa-artifact-reproducibility-20261113.json`](reports/sa-artifact-reproducibility-20261113.json)，
它所认证的候选／公开 ABI 差异为
[`sa-ordinary-candidate-compatibility-20261113.json`](reports/sa-ordinary-candidate-compatibility-20261113.json)。
2026-11-16 对设计阶段遗留兼容性清理（移除存储回退、一次性轮换迁移与 v3 恢复票据；候选 ABI 现在
为 109 个方法）的重放同样匹配，无漂移、无缺失；其证书为
[`sa-artifact-reproducibility-20261116.json`](reports/sa-artifact-reproducibility-20261116.json)，
该证书在孤儿文件 `tests/mocks/packages.PlatformRegistrarMock.lock.json` 离开代码树后于当日
重新生成（132 个源码输入；清理提交的回执此前早生成了 `SmartAccount.MarketEscrow.cs` 的一次修订，
本次重新生成也一并纠正），它所认证的候选／公开 ABI 差异为
[`sa-ordinary-candidate-compatibility-20261116.json`](reports/sa-ordinary-candidate-compatibility-20261116.json)。
2026-11-20 对 v4 代次与主体 provenance 修订（21 字节主体行旁的 22 字节 provenance 标记、
custody 派生的主体轮换、核心内部的路由代次解析）的重放同样匹配，无漂移、无缺失：共比对
**66** 个工件，`bin/public` **64** 个、`bin/platform` **2** 个，覆盖 **174** 个源码输入。
`tests/mocks` 下六套新的 mock 合约/工程/lock 三元组（GasBurningHook、GasBurningValidator、
MockDivisibleNep11Token、MockNep11Token、MockNep17Token、MockNepPaymentReceiver）天然在清单
之内，因为 `SOURCE_ROOTS` 是整目录复制 `tests/mocks`，而不是按显式文件列表。证书为
[`sa-artifact-reproducibility-20261120.json`](reports/sa-artifact-reproducibility-20261120.json)，
它认证的两对核心工件是：

| 画像 | `SmartAccount.nef` SHA-256 | `SmartAccount.manifest.json` SHA-256 |
| --- | --- | --- |
| `bin/public` | `27e28aa06068d0d9898a6dcf3d703d7561e05e2e12d4a8bd8202ae7abdc654e1` | `f0c6467b05004fdbedc0a9b8f6368ab29a30e84a6b38ece56219a6913282bd23` |
| `bin/platform` | `60f17dfd0a19b40076b0a72577ed29ea6d480e8bbe73b2a37dc207c08a1b4048` | `61900e8a80a8fc8cd3b3fb4698050f53e7dd18ee64da13bc4ab2f1cfc20cd55c` |

同一次运行的私有链回执为
[`sa-custom-source-chain-20261120.json`](reports/sa-custom-source-chain-20261120.json)
（28/28 项验收检查通过，九个工件均从刚编译出的 public 画像部署）与
[`sa-custom-runtime-provenance-20261120.json`](reports/sa-custom-runtime-provenance-20261120.json)
（把该回执与上述证书连接，源码快照 `164c58a3…`）。它们只为其点名的源码与工件作证，
不为公网部署作证：本次运行不写入任何链上状态，`tracked_tree_drift` 仍列出
`contracts/build`，因为该树被刻意钉在已部署的主网字节码上。工件身份刷新不是验收事件
——它只说当前源码编译出什么。
2026-11-21 对规范一致性变更（凭据代次从 1 起、核心级重入排斥、每个可写回调后与提交前的代码
绑定连续性、`NefSha256` 采用 `SHA256(NEF)`）的重放同样匹配，无漂移、无缺失：共比对 **66** 个
工件，`bin/public` **64** 个、`bin/platform` **2** 个，覆盖 **174** 个源码输入，两个画像均报告
`matches_fresh_build: true`，且 `chain_writes_performed: false`。其证书为
[`sa-artifact-reproducibility-20261121.json`](reports/sa-artifact-reproducibility-20261121.json)，
它认证的两对核心工件是：

| 画像 | `SmartAccount.nef` SHA-256 | `SmartAccount.manifest.json` SHA-256 |
| --- | --- | --- |
| `bin/public` | `397f96ab1997dcd8aad6455a797a569dfff2789c4ffff4dbfcab4ff590d553bf` | `4939cf01fb812fff5fb83fc4edd71205041d9a91201390ff9f21716692c23470` |
| `bin/platform` | `7d5fad653060bbe6dca63bc14dc7be8097e138c46956c23c787cba2fe604fdd8` | `296a3ad498dd4a553e1aa91449817b6eab3b4814cf3c15fe3830fe004f6b7550` |

该次重放中两个画像都移动了：`PLATFORM` 画像编译同一批 custom 源码，因此带有同一批协议变更。
`contracts/build` 仍是被刻意钉住的主网部署锚，并如实报告为漂移。
连接后的 NeoExpress 回执绑定到一次经复核的源码运行时构建（`sourceRuntime`）：其 104 文件映射、
源码构建回执、`neoxp.dll` 与包装器哈希在私有运行前后各检查一次，回执中排除了宿主路径。
NEF 不携带源码路径或 URL，其头部的编译器字符串为 `Neo.Compiler.CSharp 3.9.1+5fa9566e...`，因此
字节只取决于源码、固定的包与固定的编译器。

### 原生 ABI 2 模块

六个 `SMARTACCOUNT_NATIVE` 模块由 `scripts/build_native_modules.py` 单独构建并打包。它们的已提交
锁使用同样已发布的 Framework 3.10.1，每个打包后的 manifest 都要求原生 ABI 2 授权服务。两次
干净构建匹配了全部六个 NEF、六个打包 manifest 与打包证书；当前的输入／输出映射见
[`sa-native-abi2-module-build-20261008.json`](reports/sa-native-abi2-module-build-20261008.json)。
回执同时标识原始源码与显式的原生预处理配方。这些模块依赖 SmartAccount，不是 `public` 工件。

原生节点／NeoExpress 运行时有一套独立的源码构建与私有链门禁，记录在
[原生验证](proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.md)中。模块可复现性与仅测试用的公开
VM epoch 探测都不确立原生链行为或公开激活。

2026-10-08 合并前的历史参考摘要（SHA-256；它们不是当前源码的固定值，每次合约或固定值变更后都
需要新的复现报告）：

| 画像／工件 | SHA-256 |
| --- | --- |
| `v3/SmartAccountV3.nef` | `63d33c11d9fe89d7386ec3d96d8a8e79680be432d7ccd01ee17e704e8cced245` |
| `v3/SmartAccountV3.manifest.json` | `b72317b021775187f55ed7851cdc268a63b3598153235cf02df3307007fd1546` |
| `platform/SmartAccountV3.nef` | `088f9157bb1c5f1217d29e49f6177f9da5a370fa671941da2c6bb216959bbc94` |
| `platform/SmartAccountV3.manifest.json` | `9db29a5f9c3d2b38e16daa61a1ea9bbee3227d5cbf81026e23ce88d81420c44d` |

`docs/reports/sa-published-build-reproducibility-20261004.json` 列出 2026-10-04 构建写出的 76 个
文件（24 个合约；验证器与 hook 各写两遍）。在长度分别为 118 与 165 个字符的路径上，各自使用
空的 NuGet 缓存做两次干净导出，产出了完全相同的字节，且无警告。

## 这些字节是什么，不是什么

- 历史 2026-10-04 工件与私有的框架构建（`3.10.2-CI00384`）在系统调用声明移入合约之前的源码上
  为全部 24 个合约产出的字节完全相同，因此固定值移动时合约行为与 ABI 并未改变。
- 它们**不是**部署在主网或测试网上的字节。那些核心由更早的源码编译，早于验证器 gas 上限与
  后续改动，因此当前 NEF 与已部署的不同。SA 核心的“已部署与源码”对照证据是另一项独立任务。
- 历史 2026-10-04 核心发出的是 `SYSCALL System.Contract.CallWithGasLimit`。现在只有私有 PLATFORM
  画像会发出它；公开画像的四个回调测试在没有跳过守卫的情况下运行。
- 3.10.1 是固定的已发布框架。历史对比发现 3.10.0 给出相同的字节。3.9.1 及更早版本把
  `ContractManagement.Update` 绑定到双参数的原生重载而不是三参数重载（方法 token 不同、代码少
  一个字节），因此之后每个方法偏移都会移动，构建也就不同。

## 如何升级

1. 修改 `Directory.Build.props` 中的 `NeoSmartContractFrameworkVersion`，或
   `tests/SmartAccount.Contracts.Tests/SmartAccount.Contracts.Tests.csproj` 中的其他包版本。
2. 更新每个锁文件：`for p in $(find contracts tests -name '*.csproj'); do dotnet restore "$p" --force-evaluate; done`。
   锁定模式在缺少 `--force-evaluate` 时拒绝这样做，而 CI 从不传递它。
3. 运行 `node scripts/check_neo_platform_packages.mjs`。它会列出内容哈希与已审计值不同的每个 Neo
   包，以及 manifest 不认识的任何 Neo 包。把 id、版本与内容哈希（即 `packages.lock.json` 中的那个）
   写入 `contracts/neo-platform-packages.json`，并附上全局包目录中 `.nupkg` 的 SHA-256，同时设置
   `frameworkVersion`。
4. 用固定的编译器编译，并把摘要与之前的比较。若字节改变，请变更说明中写明，并替换
   `docs/reports/` 中的回执。
5. 若要更换编译器，请修改 `ci.yml` 中的 `nccs` 版本与 manifest 中的 `compiler` 条目：已安装
   `.nupkg` 的 `sha256`，以及其 `.nupkg.metadata` 中 `contentHash` 的 `sha512`。

一个改变版本却没有重新生成锁文件（对 Neo 包还包括 manifest）的 Dependabot NuGet 拉取请求会使
门禁失败；请在其分支上执行步骤 2 与 3。

原生私有链的使用方会用当前画像参数字节及其规范摘要、描述符与打包配方来校验打包画像证书。它们
还会用该描述符校验每个打包模块的精确能力元数据与生命周期 ABI。仅凭工件哈希匹配，不足以准入
一个更早的原生 ABI 2 画像。


## 冻结的原生复合画像（2026-10-09）

最终的构建／证明检查点把画像
`4201b02f571b7415121467d67343a8189b8070ad795a82424c0403782d22b1b4` 绑定到核心／节点／Express
提交与完整源码映射，见
[`sa-native-composite-final-build-proof-20261009.json`](reports/sa-native-composite-final-build-proof-20261009.json)。
两棵独立复制的源码树产出了相同的 104 个文件的运行时、50 个依赖归档与锁映射。六个原生模块独立
复现了它们的 12 个 NEF／manifest 文件与打包证书。使用方针对全部 13 个打包文件重新校验了当前
参数字节、画像摘要、描述符、配方、能力元数据与生命周期 ABI。

custom `public` 与 `PLATFORM` 输出在全部 80 个工件上仍保持逐字节相同。最终公开运行时回归通过 396 个
测试且无跳过；所需的外部 NeoDID 工件已提供。早前的 `sa-native-abi2-runner-build-20261009.json`
与 `sa-native-abi2-rpc-runtime-20261009.json` 描述的是中间源码快照，不是最终的复合构建。私有链／
SDK 回执另行确立集成行为；这些构建结果不确立公开网络上的激活，也不确立编译器正确性。

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
| 其他每个包（MSTest、Akka 等） | 解析出的版本与内容哈希 | 28 个公开项目的已提交锁文件；`--include-native` 检查全部 38 个，含六个原生模块、两个仅测试用的 epoch 探测项目，以及两个 NuGet 依赖锁为空的运行时探测宿主 |
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
bash contracts/compile.sh                                     # every contract into contracts/bin/public
dotnet test SmartAccount.sln -c Release
```

`./scripts/verify_repo.sh --contracts-only` 会运行同样的步骤，外加部署工具测试与格式检查。
要证明一次干净还原，请先把 `NUGET_PACKAGES` 指向一个空目录。

### 选择验证画像

`./scripts/verify_repo.sh --profile custom` 是默认值。它运行公开合约构建与测试、部署工具回归、
前端检查与 SDK 检查，但不还原原生探测项目，也不构建原生 epoch VM 固定样例。
`--contracts-only`、`--frontend-only` 与 `--sdk-only` 仍然用于选择要验证的组件。共享的确定性
前端／SDK 单元测试保留在两个画像中；它们不需要原生节点。

`--profile native` 选择原生包锁、协议与运行器守卫、原生模块 epoch VM 回归以及原生浏览器覆盖。
`--profile all` 同时运行两个画像。每个被选中的命令都是强制的，其失败会终止门禁。原生 epoch
固定样例是模块级 VM 证据；独立的 `native-profile.yml` 工作流额外构建固定的原核并执行原生 VM
矩阵。两条命令都不确立公开激活或全链准入。

主 CI 工作流还会在安装前端依赖与 Playwright 之后，以一个独立的必需步骤运行原生浏览器固定样例。
它复用这些安装，不重复前端构建或完整单元测试套件。该工作流没有路径过滤，因此原生 UI、共享
代码、SDK 与前端测试的改动都会选中浏览器门禁，而无需原生节点。

`--formal` 显式加入聚合形式化检查及其源码锁要求。`--neoexpress` 在一次性发布的 NeoExpress 链上
选择公开 profile 当前源码验收，适用于 `custom` 或 `all`。它先重建两个工件画像，然后把
`contracts/bin/public` 交给 `tests/localchain/run.py --variant source`。`NEOOS_NEOXP`（否则
`NEOXP`、PATH 或用户工具目录）选择已发布的运行器；该路径不启用任何私有分叉。

`scripts/check-custom-runtime-provenance.mjs` 把重建证书与当前源码快照、九个已部署模块的精确
NEF 哈希、校验和、完整 manifest 与 RPC script 回读连接起来。它复用源码套件已有的验收预言机。
这是经过测量的子集，不是对整个模块目录或公开部署的证明。独立的
`scripts/neoexpress_validate.py` 与 `verify-private-artifact-provenance.mjs` 仍然是私有 PLATFORM
的全模块矩阵。该未被选中的矩阵上报为 NOT RUN，并且不增加custom 门禁。原生全链验证遵循其单独的
文档化运行器。可选的已选中检查在未被选中时保留其显式的 NOT RUN 消息。

## 复现

### 公开与私有画像

`contracts/bin/public` 中的默认核心使用已发布的 `System.Contract.Call`：签名验证为只读，而验证器的
钩子的 `postCheck` 保留写权限用于记账。它不发出任何 `System.Contract.CallWithGasLimit`。模块回调测试运行在已发布的 TestEngine 上；`tests/localchain/test_public_profile.py` 在一次性发布的
neoxp 上执行一次已签名操作。

`bash contracts/compile.sh` 还会在 `contracts/bin/platform` 中单独构建私有核心。若只想构建该画像，
运行 `bash contracts/compile.sh --platform`。固定的 nccs 3.9.1 会忽略 MSBuild 的
`DefineConstants`，因此脚本会在执行源码的临时副本前加上 `#define PLATFORM`，之后删除该副本。
私有核心保留两个 10 GAS 上限回调，并在运行时要求私有核心系统调用；不要把该工件部署到公开网络。

公开画像不对验证器 gas 设上限。生命周期 ABI 准入不是验证器信任策略或资源策略。公开中继在赞助
之前必须自行施加经复核的模块策略、模拟与有限交易费用上限；这些控制不确立协议级子预算。无限制
的受赞助准入仍然不安全。`contracts/build` 仍然是历史已部署工件固定样例。公开部署／升级 helper
选择 `contracts/bin/public`，并拒绝逃逸出该目录的路径；`contracts/bin/platform` 永远不是公开发布源。

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

```bash
for dir in "$A" "$B/deeper"; do          # two different absolute paths
  mkdir -p "$dir" && git archive <commit> | tar -x -C "$dir" && (cd "$dir" && bash contracts/compile.sh) &&
    (cd "$dir/contracts/bin" && find . \( -name '*.nef' -o -name '*.manifest.json' \) | sort | xargs shasum -a 256) > "$dir.sha256"
done
diff "$A.sha256" "$B/deeper.sha256" && echo reproduced
```

`node scripts/check-artifact-reproducibility.mjs` 在临时副本中重放规范的 `contracts/compile.sh`，
并比较 **两个**画像：`contracts/bin/public` 与 `contracts/bin/platform`，各自给出独立的画像结论。
任一画像缺失核心、目录为空、出现多余工件或字节漂移，门禁都会失败。它不会仅凭可复现性推断
运行时兼容性。2026-10-08 的重放匹配 **80/80** 个文件：`bin/public` 下 **78** 个、`bin/platform` 下
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

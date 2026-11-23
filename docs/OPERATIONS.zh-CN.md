# 运维手册

> 中文版本与 `docs/OPERATIONS.md` 同构。若两者冲突，以英文版本为准。

本手册面向节点运维、发布工程师与校验人员：在线测试网校验与已发布 SA 锚点只读主网校验的 runbook、新前端构建部署后的冒烟清单，以及已记录的本地性能基线。

## 目录

1. [验证 runbook（测试网 + 主网）](#1-验证-runbook测试网--主网)
2. [部署后冒烟测试](#2-部署后冒烟测试)
3. [性能基线](#3-性能基线)

## 1. 验证 runbook（测试网 + 主网）

本章同时覆盖在线的测试网校验与已发布 SA 锚点的只读主网校验。

### 快速上手

在任何真实的校验运行之前，先检查计划和环境是否就绪：

```bash
cd sdk/js
cp .env.example .env
# 填入 TEST_WIF 或 NEO_TESTNET_WIF（有余额的测试网账户）
npm run testnet:validate:dry-run
```

干跑会打印计划执行的校验阶段，在缺少必需环境变量时把该阶段标记为 `blocked`，
并列出会被跳过的可选阶段，不会广播任何交易。

干跑结果没有问题后，再执行真实的校验套件：

```bash
npm run testnet:validate
```

RPC 端点固定方式（`TESTNET_RPC_URL` / `TESTNET_RPC_URLS`）、阶段列表和各阶段命令，
见下方测试网 runbook 与根目录 `README.md` 的 "Live Testnet Validation" 一节。

### 测试网验证 runbook

本 runbook 按最安全的推荐顺序执行当前的 v4 SDK 测试网验证脚本，遇到第一个失败即停止。

#### 必需环境

- `TEST_WIF` 或 `NEO_TESTNET_WIF`，设置为一个专用的、有余额的 Neo 测试网账户

paymaster 策略探针是唯一不需要钱包的阶段：它校验的是绑定在已部署内核上的链下允许列表，因此需要 `SA_CORE_HASH_TESTNET`（已部署的 v4 内核）与 `PAYMASTER_ACCOUNT_ID`（该内核派生的账户）。缺少这两项时套件跳过该阶段，而不是失败。

#### 可选环境

- `SA_VALIDATION_RUN_ID`：命名一次套件运行；此后所有阶段共享派生的 `sa-v4-<run id>` 部署标签
- `SA_VALIDATION_DEPLOY_TAG`：直接覆盖该标签
- `SA_MATRIX_SCENARIOS`：以逗号分隔的场景名列表，将 plugin matrix 收窄到指定场景（场景名见 `tests/testnet_plugin_matrix.js` 文件头部）
- `SA_MAX_SYSTEM_FEE` / `SA_MAX_NETWORK_FEE` / `SA_MAX_TOTAL_FEE`：收紧 SDK 在签名前执行的费用上限（默认 `50000000` / `5000000` / `55000000`）
- `TESTNET_RPC_URL`：强制指定一个 Neo N3 测试网 RPC
- `TESTNET_RPC_URLS`：以逗号或空白分隔的 Neo N3 测试网 RPC 候选列表；未设置时，验证器会自动探测官方公共种子 `seed1` 至 `seed5.neo.org:20332`，然后回退到 `https://testnet1.neo.coz.io:443`
- `MORPHEUS_RUNTIME_TOKEN`（首选），或 `PHALA_API_TOKEN` / `PHALA_SHARED_SECRET`，用于启用在线 Morpheus paymaster 中继验证器
- `MORPHEUS_TESTNET_RUNTIME_URL` 或 `MORPHEUS_RUNTIME_URL`，用于覆盖默认的 Morpheus 测试网运行时 URL；否则验证器使用 `https://oracle.meshmini.app/testnet/paymaster/authorize`
- `MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH`，用于直接从本地检出运行 Morpheus paymaster worker handler，例如 `/home/neo/git/neo-morpheus-oracle/workers/phala-worker/src/worker.js`
- `MORPHEUS_PAYMASTER_APP_ID`，若 paymaster 验证器应指向非默认的 CVM app
- `PAYMASTER_ACCOUNT_ID`，若希望在固定的、已在允许列表中的账户上重放，而不是从 `TEST_WIF` 派生 bootstrap 账户
- `SKIP_PAYMASTER_ALLOWLIST_UPDATE=1`，若已手工把该账户加入 Morpheus worker 的允许列表
- `PHALA_SSH_RETRIES`，用于调整 paymaster 验证器的 CVM 桥接重试次数
- `PHALA_CLI`，用于覆盖 Phala CLI 的启动命令。未设置时，验证器优先使用全局 `phala` 二进制，否则回退到 `npx --yes phala`。

如果公共 `paymaster/authorize` 端点返回 `401` 或 `403`，或者在拿到 HTTP 响应之前直接请求就失败，链下验证器会在 CLI 可用时自动改走 `phala` / `npx phala` 的远程 worker 路径重试。需要确定性的本地验证时，设置 `MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH`；此时验证器在本地执行 worker handler，但仍把中继交易提交到 Neo N3 测试网。

#### 试运行

在 `sdk/js` 下打印计划执行的命令，不广播任何内容：

```bash
./run_testnet_validation_suite.sh --dry-run
```

干跑在缺少必需变量时把阶段标记为 `blocked`，在可选阶段无法运行时标记为 `skip`，因此它打印的计划就是实跑可执行的计划。

#### 实际执行

在 `sdk/js` 下运行完整的有序套件：

```bash
./run_testnet_validation_suite.sh
```

套件会写出 `docs/reports/sa-testnet-validation-suite.latest.json` 与 `docs/TESTNET_VALIDATION_SUMMARY.md`，两者都记录运行 id、部署标签与受测内核。

#### v4 部署模型

内核与它安装的模块都以规范 manifest 名称部署。两项协议校验使这一点成为强制要求：SDK 客户端只接管 manifest 名称为 `SmartAccount` 的合约；内核在绑定模块时比较 profile 的 `contractName` 与已部署的 manifest 名称（`docs/SA-MODULE-PROTOCOL.md` 第 7.3 节），不匹配时以 `SA_MODULE_CODE_BINDING_MISMATCH` 拒绝。运行标签会重命名 manifest 并同时破坏这两项校验，因此只有非模块合约（paymaster、地址市场、测试探针）带每次运行的标签后缀。由于给定内核的规范哈希是固定的，重跑会复用链上已有的合约，而不必为重复部署付费。

#### 有序脚本

1. `tests/testnet_smoke.js`
2. `tests/testnet_plugin_matrix.js`
3. `tests/testnet_market_escrow.js`
4. `tests/testnet_paymaster_onchain.mjs`
5. `tests/testnet_paymaster_policy.mjs`，当存在 paymaster 运行时令牌、`SA_CORE_HASH_TESTNET` 与 `PAYMASTER_ACCOUNT_ID` 时
6. `tests/testnet_paymaster_relay.mjs`，当 `MORPHEUS_RUNTIME_TOKEN` 或 `PHALA_API_TOKEN` 存在时

#### 单条命令

```bash
npm run testnet:validate:smoke
npm run testnet:validate:plugin-matrix
npm run testnet:validate:market
npm run testnet:validate:paymaster-onchain
npm run testnet:validate:paymaster-policy
npm run testnet:validate:paymaster
npm run testnet:validate:report
```

#### 安全须知

- runner 遇到第一个失败即停止。
- 若干脚本会部署合约或广播真实的测试网交易，并改变链上状态。
- 测试网验证器有意忽略通用的 `NEO_RPC_URL`；只使用 `TESTNET_RPC_URL` / `TESTNET_RPC_URLS`。每个在线脚本在广播前都会校验 Neo N3 测试网的 network magic。
- plugin matrix 部署 v4 内核以及它要演练的 validator 与 hook 模块，全部使用规范名称，并在 `docs/reports/` 下记录 JSON 报告。
- paymaster 策略验证器会覆盖显式拒绝路径，例如错误的 `dapp_id`、错误的 `account_id`、错误的 `target_contract`、错误的 `method`、缺失的 `operation_hash`，以及超出限额的 gas。
- paymaster 验证器可以复用固定的允许列表账户，也可以注册新账户并在线更新 worker 允许列表。
- 公共 paymaster 端点允许实施托管方的反滥用控制。本地 handler 验证证明策略逻辑与中继接线，且不削弱该生产边界。
- 在跑完整套件之前，优先使用一次性测试密钥，以及全新的或可重置的测试网环境。
- 在相同链上状态上重复运行套件可能改变结果，因为 nonce、verifier 密钥、允许列表与余额都会向前推进。

### 主网只读校验

本 runbook 在不广播任何交易的前提下，校验已发布的 Neo N3 主网 SA 锚点。

在 `sdk/js` 中运行：

```bash
npm run mainnet:validate:readonly
```

该校验器检查：

- 生成的 Morpheus 主网注册表具有期望的网络 magic
- 公开的主网运行时目录与状态端点可访问且运行正常
- 主网 SA 核心、Web3Auth 验证器、会话密钥验证器与社交恢复验证器合约均已部署
- 每个已部署清单都暴露已发布架构所需的读 / 写入口点

最新报告写入 `docs/reports/sa-mainnet-readonly.latest.json`。

## 2. 部署后冒烟测试

在部署新的前端构建之后立即使用本清单。

### 目标

确认最新部署的前端确实在生效、不是陈旧的，并且关键的 wallet、原生工作台、docs 与运营流程仍然可用。

### 1. 版本与缓存检查

- 确认已部署的 revision 就是目标提交。
- 确认 CDN / 托管缓存已刷新。
- 部署后对浏览器做一次强制刷新。
- 若仍出现陈旧的 bundle，清除站点数据后重新加载。

### 2. 浏览器控制台检查

在开启 DevTools 的情况下打开站点，确认：

- 没有 `t is not a function` 报错
- 安装 NEOLine 后没有 `No supported Neo wallet provider detected in browser.` 报错
- 首次加载页面时没有意外的 Vue 渲染错误

### 3. Wallet 检测

在安装 NEOLine 的情况下，确认前端能检测到 module 形式的 provider，例如：

- `window.NEOLineN3.N3`
- `window.NEOLine.NEO`

然后：

- 点击 Neo wallet 连接操作
- 确认出现 wallet 提示或账户响应
- 确认 UI 反映了已连接的 wallet 状态

### 4. 原生工作台检查

打开原生账户工作台，确认它的每个 tab 都渲染无异常：

- 账户与恢复
- 创建账户
- 模块
- 原生操作

预期结果：

- tab 标签与面板正常渲染
- 在加载账户后，模块 tab 能列出该账户已安装的验证器与钩子模块
- 控制台不出现 `t is not a function` 报错

### 5. 运营流程检查

确认主要前端流程仍可渲染：

- 首页 operations workspace 可加载
- Load Account 面板可渲染
- Compose / signature / broadcast 区块可渲染
- Docs 页面可打开
- 存在草稿或 tx 路由时，交易信息页面可渲染

### 6. 中继与提交检查

若环境中启用了中继：

- 确认 relay preflight UI 仍可渲染
- 确认 operator 操作在加载时不会立即失败
- 确认 UI 中不出现新的 5xx 或格式错误的报错信息

### 7. 通过标准

满足以下条件时，本次部署通过冒烟测试：

- 目标构建已生效
- 核心页面的控制台没有运行时异常
- 受支持 provider 的 wallet 检测可用
- 原生工作台的各 tab 渲染正确
- 运营页面保持可用

### 8. 冒烟测试失败时

收集并上报：

- 已部署的 commit SHA
- 从 DevTools network 面板读取到的已加载资源文件名
- 控制台报错的完整原文
- 浏览器与扩展的版本
- 托管平台或 CDN 的细节

## 3. 性能基线

性能结论只适用于固定的运行时、编译后的模块字节、费率表
与工作负载。本地 VM 基准测量的是执行成本与延迟；它
不测量公网吞吐、共识、交易传播、wallet
签名、网络费用或确认延迟。

### 目标与保持的行为

既有的[模块预算回执](reports/sa-native-multisig-budget-20261009.json)
记录了一个最大参数的 `SSN` 名单，槽位为 `110`：其执行后
回调消耗未变的 100,000,000-datoshi 限额中的 95,694,229 datoshi。
这在记录的定价下留下 4,305,771 datoshi，即 4.305771% 的余量。
该历史回执保持不可变。

该优化把 `MultiSigVerifier.ReadSignerDomainSets` 中的 32 次迭代 owned-byte 拷贝
替换为一次新的区间拷贝。有三个子域时，两个执行后策略承诺会执行六次这样的拷贝。
域长度、重复检查、子顺序、quorum 选择、回调
权限，以及子执行前后的策略承诺都保持不变。
不改变任何回调限额、模块版本、授权规则或费率表。
新的编译字节具有新的工件身份；已部署的模块不会
自动获得该改动。

固定版本的框架把 `Helper.Range` 映射到 VM 的 `SUBSTR` 指令。既有的
`NeoNativeVerifier.GetSignerDomains` 使用同一操作提取
owned 的 32 字节域。区间从零开始，且在既有输入检查之后长度仍精确为
32。

### 复现契约

用 `scripts/build_native_modules.py` 分别构建基线模块与候选模块，
使用相同的编译器、包缓存、
仓库还原策略与不可变运行时。每次构建都会把全部受支持
模块编译两次并检查逐字节复现。保留两份构建回执；
绝不覆盖历史回执，也不把更新的源码 pin 替换进去。

对每个工件目录以 Release 配置运行 `tests/NativeMultiSigProbe`。
custom 验收模式检查真实的模块 NEF、实际的代理
Verification、两个回调预算、基本与最大参数、畸形
证明、quorum 不足、重复身份、阶段拒绝与原子
回滚。其交易签名器是合成的，并使用内存存储。

对每个源码快照，构建到新的输出目录：

```sh
python3 scripts/build_native_modules.py \
  --contracts "$SOURCE_ROOT/contracts" \
  --compiler "$NATIVE_COMPILER" --cache "$NATIVE_PACKAGE_CACHE" \
  --output "$MODULE_OUTPUT" --receipt "$MODULE_BUILD_RECEIPT"
```

然后对每个模块输出运行相同的基准源码与运行时：

```sh
dotnet run --project tests/NativeMultiSigProbe/NativeMultiSigProbe.csproj \
  --configuration Release \
  -p:NativeRuntimeDirectory="$NATIVE_RUNTIME" \
  -p:UseArtifactsOutput=true -p:ArtifactsPath="$PROBE_BUILD_OUTPUT" \
  -p:UseSharedCompilation=false -- "$MODULE_OUTPUT" \
  --benchmark --warmup 5 --samples 30
```

使用运行时构建回执记录的 SDK 版本。把构建日志
与输出的 JSON 回执分开；构建失败不是基准结果。

可选的可重复基准先做 warmup 迭代，然后从相同的克隆起始状态
取被测样本。账户 nonce、链时间、操作
字节与策略保持固定。setup、编译、签名、诊断与
存储枚举都在被测执行区间之外。回执
保留原始样本、样本数、运行时与模块哈希、宿主信息、
实际消耗与最低准入费用。最近秩 p50 与 p95 描述
该宿主与工作负载；样本数偏低不能确立稳定的尾部。

状态测量统计执行前后的逻辑键数与序列化的键/值字节。
它们不是物理数据库大小或长期节点增长。
被拒绝的用例必须使已提交状态保持不变。成功的样本暴露
其暂定写入增量，同时丢弃克隆快照，以便下一个
样本从相同状态开始。诊断性的回调成本采集与计时
分离，因此指令追踪不会抬高报告的延迟。

比较必须拒绝不同的运行时哈希、定价、场景参数
或基准源码。只有预期的模块工件可以不同。基线与
自身比较必须使严格改进门禁失败；候选必须
保留全部功能控制，并降低目标执行后回调成本。

```sh
python3 scripts/native_budget_benchmark.py compare \
  "$BASELINE_BENCHMARK" "$CANDIDATE_BENCHMARK" \
  --allow-artifact-change MultiSigVerifier.nef \
  --allow-artifact-change MultiSigVerifier.manifest.json \
  --require-improvement --output "$BENCHMARK_COMPARISON"
```

### 记录的本地比较 — 2026-10-09

[比较回执](reports/native-domain-copy-20261009/comparison.json)
保留两组原始样本以及全部 18 个场景比较。每个版本
对每个场景使用五次 warmup 与 30 个被测样本，共计 540 个被测样本。
宿主为 Arm64 上的 macOS 15.7.7，.NET 10.0.11，以 SDK 10.0.400 在
Release 配置下构建。[验证回执](reports/native-domain-copy-20261009/validation.json)
绑定源码改动、构建回执、运行时身份、比较器与测试。

对于最大参数 `SSN/110` 用例：

| 测量 | 基线 | 区间拷贝 |
| --- | ---: | ---: |
| 执行后回调，GAS | 0.95694229 | 0.95454583 |
| 回调余量 | 4.305771% | 4.545417% |
| 校验回调，GAS | 0.67864018 | 0.67744195 |
| 应用消耗，GAS | 1.89940410 | 1.89580941 |
| 最低准入费用，GAS | 1.89940410 | 1.89702613 |
| 本地执行 p50，ms | 9.413208 | 7.895625 |
| 本地执行 p95，ms | 11.443416 | 10.976542 |
| 逻辑操作增长 | 3 键 / 200 字节 | 3 键 / 200 字节 |

确定性的执行后节省为 239,646 datoshi，即该
回调先前消耗的 0.2504%。预算仍接近其上限；这一
微小改动并不确立广泛的效率，也不确立未来
模块改动所需的足够余量。NEF 中减少的 75 字节也把该 fixture 的
起始逻辑存储减少 75 字节。它不改变该操作的存储
增长。

时间分位数描述的是这些运行。基线与候选在同一宿主上
顺序运行；调度、并发工作与运行时 warmup 可能影响
差值。它们不构成任何延迟改进阈值或公网结论。

在每个场景运行内部的重复之间，操作与签名字节保持固定。
基线与候选配置相同的场景与签名密钥，但
分别生成签名；回执并不证明这两次运行之间签名或
交易脚本字节完全相同。比较的是它们记录的形状、语义
与确定性费用结果。这是把计时差异视为观察性的另一个理由。

两次模块构建都复现了两次。基线模块工件与
历史最终模块回执精确一致。本次运行使用单独 pin 的源码构建
运行时，其程序集哈希与历史预算探针不同；它在同一运行时下
重新测量两个版本，并复现了历史目标
成本。[运行时构建回执](reports/native-domain-copy-20261009/runner-build.json)
与每个基准加载的程序集哈希保留了这一区别。

全部 20 个功能控制仍然存在，包括两个跨方案签名器域
用例。[custom 验收回执](reports/native-domain-copy-20261009/candidate-acceptance.json)
也通过既有的身份与有限场景验证器。严格
改进检查拒绝基线与自身比较，并接受
候选。比较器的 15 个单元测试覆盖畸形或不匹配的回执、
状态影响、分位数与改进门禁。

### Native Boolean 结果比较 — 2026-10-09

这个有界的仅 native 候选针对复合执行后回调的
结果快照。精确的 VM Boolean 是不可变的，因此每个通过的子调用都可以
收到原始 Boolean 值，包括 `false`。其他所有结果类型
仍走既有的序列化与独立反序列化
路径：null、Integer、ByteString、Buffer、Array、Struct 与 Map 都没有捷径。
不支持或循环的结果图仍必须在任何子 post 调用之前失败。
每个子调用的操作参数仍是独立的深拷贝。

该候选位于 `SMARTACCOUNT_NATIVE` 之内；custom 合约路径
不变。它保留两处新的策略承诺、当前的域与
权限读取、阶段与代码检查，以及原子回滚。它不包含
任何预算、费率表、模块版本或存储格式的改动。

新的比较在同一固定运行时下重跑全部 18 个场景，每个版本
五次 warmup 与 30 个被测样本。对于最大参数
`SSN/110`：

| 测量 | 区间拷贝基线 | Boolean 结果候选 |
| --- | ---: | ---: |
| 执行后回调，GAS | 0.95454583 | 0.91399672 |
| 回调余量 | 4.545417% | 8.600328% |
| 校验回调，GAS | 0.67744195 | 0.67744195 |
| 应用消耗，GAS | 1.89580941 | 1.85526030 |
| 最低准入费用，GAS | 1.89702613 | 1.89702613 |
| 本地执行 p50，ms | 8.723583 | 8.767458 |
| 本地执行 p95，ms | 10.680916 | 10.651084 |
| 逻辑操作增长 | 3 键 / 200 字节 | 3 键 / 200 字节 |

执行后回调节省 4,054,911 datoshi，即 4.248%。最低准入费用
保持不变，因为它包含有界回调预留；更低的
消耗并不意味着准入所需费用预算等量下降。
候选 NEF 大了 19 字节，使该 fixture 的
起始逻辑存储增加 19 字节。计时测量没有显示一致的
延迟改进，并保留了上文所述的顺序运行与签名字节
限制。

native 构建复现两次。默认的 20 个控制仍然存在，且
一次指令诊断把每个回调的计费与其记录的
预算对齐。其 Boolean 结果路径从一次结果序列化与两次
结果反序列化变为零次；参数拷贝保持不变。独立的
模块测试覆盖 Boolean true/false 传播、列出的每一种非 Boolean 类型、
在子调用之间以及与原始值隔离的可变结果，以及在
任何子 post 调用之前拒绝不支持或循环的结果并回滚存储。
这些所有权测试在公开 VM 中使用宽松的测试服务；它们
并不确立 native 合约授权。

新的原始样本、构建与语义回执作为独立的审阅
工件保留。更早提交的回执仍是历史证据。候选 NEF
在单独的 native 交付之前仍位于公开构建目录之外；
禁用 `SMARTACCOUNT_NATIVE` 的custom 合约源码在本次改动前后
完全一致。

### 进一步的测量边界

独立的 SDK runtime runner 可以用真实签名测量环回交易提交与
确认。它的一秒私有链出块间隔与
500 毫秒回执轮询间隔是该环境的一部分。这类
测量必须区分准备、签名、提交与确认，并
记录系统费用与网络费用。它无法确立公网容量。

长期存储增长、争用、持续节点负载以及多种宿主
架构需要单独的实验。通过本地预算与计时
比较只确立在记录输入下的被测优化。

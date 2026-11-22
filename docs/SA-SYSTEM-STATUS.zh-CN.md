# Smart Account 能力边界

这是一份源码层面的集成指南。一个已配置的地址、一次成功的构建，或一份历史部署回执，都不能证明公开合约包含当前实现。为用户启用任何能力之前，请校验确切的 NEF、清单、网络与核心绑定。

> 中文版本与 `docs/SA-SYSTEM-STATUS.md` 同构。若两者冲突，以英文版本为准。

## 交付优先级

已部署合约实现为 NeoOS 在当前公开运行时上服务。原生实现与协议评审并行推进，各自拥有独立的发布门禁。两条路径互不等待，且一条路径的证据不能为另一条路径建立运行时保证。参见[实现策略](SA-IMPLEMENTATION-STRATEGY.md)。

## 运行时配置

| 配置 | 实现边界 | 部署要求 |
| --- | --- | --- |
| `public` | 标准 `System.Contract.Call`；账户 nonce、验证器模块与钩子、执行在同一笔交易中完成 | 已发布的 Neo 运行时；当前核心与匹配的模块工件 |
| 私有 `PLATFORM` | 增加有界的模块子调用 | 具备对应私有系统调用的运行时；不能靠选择某个公开 RPC 地址来部署 |
| 原生 SmartAccount | ABI 2 `SmartAccount`，独立推导身份，按 epoch 划分模块，有界回调 | 对应的 Neo 核心实现与硬分叉激活；公开 v4 部署不会激活它 |

公开配置没有按子项的模块 Gas 预算。中继与赞助方必须限制交易费用，并审阅所选模块及其可变子配置。私有配置的证明不能闭合这一公开运行时限制。

## 原生账户工作流

原生 ABI 2 实现具备独立的托管恢复、权限 epoch 模块存储、执行中显式的 epoch / 配置承诺、有界回调、受支持签名形态的见证费用估算，以及已签名交易预览。参见[原生架构](NATIVE_SYSTEM_ARCHITECTURE.md)、[SDK](NATIVE_SDK.md) 与[工作台](NATIVE_ACCOUNT_WORKSPACE.md)。它需要匹配的原生运行时与激活；公开 v4 部署不是原生可用性的证据。

源码托管：本仓库的 `contracts/native/SmartAccount/` 是原生 `SmartAccount` 合约唯一可编辑副本（真实源码）；[原生 VM 工作流](../.github/workflows/native-profile.yml) 使用的、按 SHA 固定的 Neo 核心检出版本携带这些文件的生成副本，该工作流在任何构建或测试之前运行 `scripts/sync_native_smartaccount.py --check`，因此漂移、缺失或未纳管的副本会在此失败。该固定版本现已记录重新生成的标记提交。这一“真实源码 / 同步”结构及其 CI 门禁属于仓库机制，不会改变下文列出的外部激活、验收与回读边界。

发现流程绑定[当前配置参数](proposals/smartaccount-native-profile-v2-parameters.json)及其摘要，而不仅仅是 `getVersion() == 2`。身份推导仍是版本 1；授权与精确的 14 字段账户记录是版本 2。执行接收四个参数，包括当前权限 epoch 与配置 nonce。原生复合限额为三个子模块、两个批准 / 阈值与三个聚合签名域。验证器回调预算为 1 GAS；钩子与维护各 2.5 GAS。这些边界并不保证最大批次能满足网络的全局验证预算。

## 公开 v4 账户与运营工作流

| 能力 | 受支持的合约行为 | 剩余边界 |
| --- | --- | --- |
| 账户身份 | 从所选核心读取账户 ID、推导代理与已安装的验证器模块；不匹配即拒绝 | 旧账户的反向索引可能不可用，需要显式账户 ID |
| 共享草稿 | 执行已暂存的、一致的带签名调用 | 协作者记录与界面签名计数不能建立链上授权 |
| 多签 | 针对同一操作的链上有序子证明，各子签名域独立 | 阈值统计的是验证器模块，不能证明是独立的人或独立托管 |
| 会话转账 | 精确的 NEP-17 参数、代理作为发送方、非负金额、布尔成功 | 代币声明的金额不能度量任意的额外余额损失 |
| 每日限额 | 固定窗口记账与实际净扣减，包含返回 false 或零的目标 | 代币 `balanceOf` 是信任依赖；这不是按资产的通用余额预言机 |
| 订阅转账 | 正数金额且 NEP-17 结果成功后才消耗周期 | 通用非转账目标保留其文档化的返回语义 |
| 直接代理转账 | 推导见证、核心作用域回读与显式有界费用预留 | 中继模式与管理员配置的作用域；普通钱包调用 API 无法添加该见证 |
| 赞助执行 | 每个核心内共享按交易报销上限的策略校验结算 | 拒绝赞助代理见证；任意结算不得继承代理资产权限 |
| 运营密钥恢复 | 浏览器密钥持久存储与口令加密备份 | 导入需要草稿中已固定的公钥；仅凭链接无法替换它 |
| 备份所有者逃生 | 时间锁与所有者见证；常规清理式终结，或无需回调的永久仅所有者恢复 | 仅所有者恢复不可撤销且无法重装模块；托管、外部批准与模块持有的资金仍相互独立 |

## 模块名称不等于完整产品保证

- `P256Validator` 只验证其文档化的 P-256 证明格式。它本身不是包含 origin、RP ID 与认证器数据校验的完整 WebAuthn 仪式。
- `TeeKeyValidator` 信任其注册的签名密钥。仅有有效签名，并不能建立某个具体 enclave 的证明。
- `ZKEmailVerifier` 已禁用且无法安装（`getModuleProfile()` 不声明任何能力，核心会拒绝安装）；不要把它作为可用的账户选项提供。
- `DelegatedIdentityValidator` 使用其文档化的委托签名路径；不要把它描述为本地验证的通用零知识登录证明。
- 社交恢复的模块所有者与核心备份所有者是两份独立状态。更新其中一个，不是另一个也改变的证据。

## 验证与发布

对原生合约构建、前端、浏览器、SDK 消费方与依赖审计，运行 `scripts/verify_repo.sh --profile native`；native 是默认值，也是唯一的实现画像。按各自所需的工具运行形式化与私有链门禁，并检查其记录的作用域与跳过的检查。原生核构建到各项目自己的 `bin/Release/net10.0/`；模块与 epoch 探测回执则写入 `--output` 指向的目录。

独立的[原生 VM 工作流](../.github/workflows/native-profile.yml) 构建一个经评审的不可变核心提交与两份相同的原生模块副本，然后用真实的原生 VM 检查完整的实测复合场景矩阵。它拒绝缺失、重复、未知、失败或超预算的用例；合成交易签名人使这成为宿主测试，而不是内存池或出块确认。原生门禁中的 NativeEpochProbe 使用仅用于测试的 SmartAccount ABI 夹具，属于不同的测试边界。协议 v4 把模块改名为 validator，并把配置移到 `configure` 生命周期回调。该探针现在驱动这套回调：
对原生 profile 构建的每个模块执行安装、配置、按阶段校验与卸载，并断言固定核心调用方校验、
`(accountId, moduleId)` 实例存储，以及 `0xA2` 权威纪元布局已退役。全节点 SDK / 私有链回执仍另行处理。历史报告保留它们当时测试的提交与字节；后续的测试专用核心提交不会改变其中记录的生产运行时身份。

公开推广之前，请把每个已部署工件与授权绑定同经评审的源码比对；在目标运行时上演练账户创建、配置、转账、失败回滚、恢复与费用结算。用户钱包签名与公开链部署是两个独立的运营步骤。

## 当前源码：无回调的托管权恢复

`beginRecovery(accountId, newCustody)` 记录一条待生效的托管权轮换，在账户的
`recoveryTimelockMs`（7-90 天，创建时固定）之后到期；`cancelRecovery` 删除记录，
`executeRecovery` 在到期后无需许可即应用它。执行阶段不调用任何 validator、hook、Market 或 Oracle：
它清扫全部模块实例、阈值策略、hook 顺序、消息主体集合、待处理意图、nonce 通道与待处理迁移状态，
把托管权轮换到已批准的地址，清空恢复授权方，重新启用内置授权并推进 authority epoch、
configuration nonce 与控制修订号。`getRecoveryStatus` 以
`[exists, initiatedAt, matureAt, authorityEpochAtInit, newCustody]` 回读待处理记录。

恢复保留身份、资产地址与执行 nonce 历史，但它不是清除旧插件存储、退还插件持有资金、
撤销代币授权、结算进行中的市场托管或移除独立合约升级管理员的承诺。
这些属于源码候选能力；集成方必须先发现所选部署的 ABI 并读取链上状态，才能对外暴露它们。

## 当前源码：平台服务、冻结与发现读取

已提交的custom 源码候选把平台服务从核心中抽出：市场托管结算（`abandonListing`）位于 `SAAddressMarket`，Paymaster 报销（`settleReimbursement`）位于 `SAPaymaster`，平台账户注册与所有者轮换时间锁位于独立的 `SAPlatformRegistrar`（the retired custom treeregistrar/`）。在 2026-11-13 安全修复之上，该候选新增了备份所有者门控的冻结面（`freezeAccount` / `unfreezeAccount` / `isAccountFrozen`），它不属于已固定的公开工件。

2026-11-16 的 Ethereum-AA 对齐修订在该候选之上新增两个安全读取：`describeAccount(accountId)` 聚合完整账户描述符（ERC-7579 风格的能力发现）；`simulateValidation(accountId, op)` ——以 ERC-4337 的 EntryPoint 命名，便于 4337 工具找到熟悉的入口——是非故障的执行检查预检（不含签名与钩子执行），同时报告托管闩锁与原生备份所有者见证。同一修订让 `SessionKeyValidator` 在模块初始化数据中接受版本 0x01 的初始密钥数据块，使会话密钥账户在第一天即可使用；之后的密钥变更需要通过新的配置意图，并各自受 24 小时成熟期与七天过期窗口约束。SDK 暴露 `describeAccount` / `simulateValidation` / `buildSessionKeyInstallCommand`，以及 ERC-4337 形态（`toErc4337UserOperation`、`estimateUserOperationGas`）与 ERC-7715 形态（`buildSessionKeyPermission`）的适配器；类型化数据签名布局见 [SA-EIP-712-SPEC.md](SA-EIP-712-SPEC.md)。

使候选达到 81 条 ABI，对比已固定公开工件的 90 条。

公开部署仍然运行 90 方法的工件，因此抽取、冻结、发现与首日会话密钥这些面仍是源码候选能力，处在未变的“需要升级”边界之后：必须完成受治理的升级与独立回读，任何部署才能声称拥有它们。目前的本地证据仍限于源码层面——合约测试覆盖了抽出的服务 ABI 与冻结面，候选 NEF / 清单哈希已重新固定——而新的 NeoExpress 回执、工件可复现性证书、CI 车道与公开链回读仍是未闭合的证据门禁。

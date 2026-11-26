# Neo SmartAccount

SmartAccount 是 Neo N3 的账户抽象协议，尚未发布。仓库只维护当前原生实现，钱包用户也不需要选择协议版本。[English](README.md)

阅读[模块协议](docs/SA-MODULE-PROTOCOL.zh-CN.md)和[当前协议参数](docs/proposals/smartaccount-native-profile-parameters.json)即可开始集成。[原生实现清单](contracts/native/profile.json)列出了实现位置及尚未通过的验收项。

钱包连接节点、核对网络和 SmartAccount 接口后才开放操作。基础账户使用托管地址授权；验证器、钩子和恢复策略都按需启用。协议给出的数量是上限，不是开户步骤，也不是用户每次要支付的费用。

## 文档地图

| 任务 | 入口 |
| --- | --- |
| 核对共识实现 | [原生核心](contracts/native/README.md) |
| 配置签名、恢复或治理 | [标准模块](contracts/modules/README.md) |
| 开发钱包或应用 | [SDK](docs/SDK.zh-CN.md) · [钱包工作台](frontend/src/features/native/) |
| 验证实现 | [验收项](contracts/native/profile.json) · [形式化检查](formal/verify.py) |

## 快速开始

钱包开发：在 `frontend` 中执行 `npm ci` 与 `npm run build`。原生开发请看[构建说明](contracts/native/README.md)，其中列出 `dotnet test` 的调用方式与所需的 Core 路径。

首选的本地验证入口是 `./scripts/verify_repo.sh`。合约检查需要把 `NEOOS_NATIVE_CORE_SOURCE` 指向经过审查的 Neo Core 检出，然后运行 `./scripts/verify_repo.sh --profile native --contracts-only`。钱包客户端检查在 `sdk/js` 中执行 `npm test`。Core 与编译器要求见[原生构建说明](contracts/native/README.md)。本地测试和策略证明不能替代公共网络激活，也不能证明实现完全正确。

交易受策略门控：一次成功的校验预览只是一次读取，既不是签名，也不是执行会成功的承诺。模块生命周期及其授权检查在[模块协议](docs/SA-MODULE-PROTOCOL.zh-CN.md)中规定。中继的信任边界很简单：中继可以提交已签名交易，但不能替账户为该操作授权。

钱包工具使用的外部服务有各自的 [Morpheus 注册表](docs/engineering/MORPHEUS-REGISTRY.md)。这些地址不是 SmartAccount 协议部署。

共享草稿元数据刻意设有上限：前端为每份草稿保留最近 100 条活动记录与最近 12 条提交回执，使长期协作记录不会无限增长。

### 部署清单

钱包配置以 `frontend/.env.example` 为准。

- 按文件名顺序应用 `supabase/migrations/` 中的每一个文件（`20260308_home_operations_workspace.sql` 至 `20261118_rename_aa_to_sa.sql`）。不要只挑单个文件应用：这条迁移链的设计目标是整体重放，但目前没有任何自动化重放证明它确实能重放成功（见下文关于 CI 的一条）。
- 把 `supabase/migrations/20260327_security_hardening.sql` 视为必需：它移除了宽松的 `aa_account_metadata` RLS 策略，撤销了对 `aa_transaction_drafts` 的直接表访问，并修复了追加签名的竞态。
- 把 `supabase/migrations/20260611_draft_metadata_hardening.sql` 视为必需：它让其余的草稿元数据写入方对丢失更新加锁，限制匿名 `create_sa_draft` payload（64 KiB 上限、数组上限、入站活动 / 回执裁剪），并撤销 anon 对内部 activity-scope 辅助函数的执行权限。
- 把 `supabase/migrations/20261118_rename_aa_to_sa.sql` 视为必需：它把 `aa_transaction_drafts` / `aa_account_metadata` 两张表以及每一个 `aa_` 草稿函数、触发器、索引和读取策略改名为 `sa_` 名称，并用 `sa_` 引用重新下发留存的 plpgsql 函数体（这些函数体在执行时才解析表名与函数名，所以只改名会让每个草稿 RPC 在运行时全部失效），因此在它之后所有表与 RPC 引用都必须使用 `sa_` 拼写。
- 迁移链是为 CI 重放设计的，但它的门禁 `.github/workflows/supabase-migrations.yml.disabled` 自 2026-09-27 起处于停用状态（运行成本决定；数据库操作由人工执行）。在它重新启用之前（只需去掉 `.disabled` 后缀，因为工作流文件、迁移文件与 `supabase/tests/replay_assertions.sql` 仍然彼此匹配），修改迁移后请自行在一个临时 Postgres 16 上按文件名顺序重放每一个文件，然后运行 `supabase/tests/replay_assertions.sql` 来验证。
- 设置 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_ANON_KEY`，用于浏览器端的匿名草稿持久化。
- 只读审阅使用普通草稿 URL，收集签名使用协作者链接，中继检查、广播及其他仅运营者动作使用运营者链接。签名方链接不能追加运营者级别的中继或广播活动记录。
- 签名方链接泄露时使用“轮换协作者链接”动作；如果要在不重建草稿的情况下让运营者专用 URL 失效，请轮换运营者链接。
- 启用中继提交流程之前，先设置 `VITE_SA_RELAY_URL`、`VITE_SA_RELAY_RPC_URL` 与服务器端的 `SA_RELAY_WIF`。
- 设置仅服务器端的 `SUPABASE_SERVICE_ROLE_KEY`，使 `frontend/api/draft-operator.js` 可以接受带签名的运营者变更请求，用于状态变更、中继预检持久化、提交回执与链接轮换。
- 优先使用服务器端的 `SA_RELAY_RPC_URL`，把 `SA_RELAY_ALLOWED_HASH` 钉在目标 SA 合约上，并保持 `SA_RELAY_ALLOW_RAW_FORWARD` 关闭，除非你确实希望中继路由转发已签名的原始交易。
- 如果希望交易回执与时间线动作打开你偏好的区块浏览器，请设置 `VITE_SA_EXPLORER_BASE_URL`。
- 共享草稿元数据预期只保留最近 100 条活动记录与最近 12 条提交回执。

## 前端安全状态

仓库验证门禁要求前端与 JavaScript SDK 两边的**生产依赖中 0 个 high / critical 漏洞**。

前端仍为正在使用的 NeoDID / Web3Auth 登录流程保留上游的 Web3Auth / Torus 依赖链。两种前端审计模式都只接受 Elliptic 公告 `GHSA-848j-6mx2-7j84` 与 deepmerge 公告 `GHSA-gcqx-w48m-w2h4`，各自严重度至多为 low，包括经由依赖包传播的发现。任何包上的新公告、任何严重度上升，以及畸形或不完整的审计报告都会让门禁失败。这些遗留公告没有已修复的版本；通过门禁不等于零漏洞。暴露面与升级约束见[依赖安全评估](docs/SECURITY.zh-CN.md#附录-b前端依赖安全评估)。SDK 另行运行仅针对生产依赖的审计，使其较小的依赖面不会悄悄回退。

# 仓库组织

> 中文版本与 `docs/ORGANIZATION.md` 同构。若两者冲突，以英文版本为准。

更新至 2026-10-13 的 ordinary/native 布局。更早的 2026-09-27 组织快照已随部署前的
兼容面一并删除，因此本文件是唯一被跟踪的布局声明；当前布局与归属规则如下。

## 用途

neo-os-aa 是 NeoOS 的账户抽象（account abstraction）仓库。它包含用于创建和使用
Smart Accounts 的 Neo N3 SA 合约、前端工具与 SDK 面。

## 权限边界

- 本仓库**拥有**：SA 用户操作、verifier 与 hook 插件绑定、
  恢复策略、paymaster 策略、SA 合约行为，以及 SA 专属的
  前端与 SDK 集成。
- 本仓库**从不拥有**：DID 资格或身份签发、网络身份
  选择、签名器托管、目录发布、MiniApp 产品行为，或
  生产部署状态。

## 目录结构

    implementations/ordinary/ user-contract 交付配置与入口
    implementations/native/   native ABI 2 提交配置与入口
    .github/                 CI 工作流
    contracts/               Neo N3 SA 合约源码
    formal/                  形式验证输入与检查
    frontend/                SA 应用与服务端路由
    sdk/                     SA SDK 面
    shared/                  共享的 SA 类型与辅助函数
    supabase/                SA 数据库迁移
    tests/                   测试套件
    scripts/                 仓库工具
    docs/                    项目文档
    SmartAccount.sln .NET 解决方案
    README.md                公开项目与边界文档

`implementations/ordinary/` 与 `implementations/native/` 是同一分支上的两个
实现入口。它们通过 `profile.json` 有意指向既有的、构建兼容的源码位置；源码
文件不重复。ordinary 配置是当前 user-contract 的交付路径。native 配置包含为
标准提交准备的 native 模块、SDK 与 UI 配置，而共识层的
`SmartAccount` 服务仍保留在对应的 Neo core 仓库中。

## 文件组织规则

- 合约源码与合约专属检查保留在 contracts/ 下。
- 第三方插件起点保留在 contracts/templates/ 下；模板针对
  共享插件层（contracts/verifiers/Verifier*.cs、
  contracts/hooks/HookAuthority.cs）编译，scripts/check_plugin_templates.mjs 使
  其 manifest 与核心的绑定期 ABI 门禁保持一致。
- 使用 `implementations/ordinary/profile.json` 与
  `implementations/native/profile.json` 选择实现配置；
  不要从部署标签或共享的工件目录推断配置身份。
- 仅 native 使用的模块与客户端代码保留在
  `implementations/native/profile.json` 列出的 native 根目录下；ordinary 源码不得通过导入
  native 入口来证明 native 已激活。
- 前端路由、UI 与前端配置保留在 frontend/ 下。
- SA 客户端类型与构建器保留在 sdk/ 与 shared/ 下。
- 形式证据与验证输入保留在 formal/ 下。
- 数据库迁移保留在 supabase/migrations/ 下，并且只
  通过仓库记载的迁移流程应用。
- 不要提交凭据、本地环境文件、构建产物，或
  与本项目无关的 MiniGame 内容。

## 跨仓库依赖

- neo-os-contracts 拥有 platform/app/Oracle 合约源码，而本仓库
  拥有 SA 合约源码。SA 消费经过审阅的工件与接口。
- neo-os-devpack 提供带版本的 SDK 包；消费方使用审阅过的 pin，
  而不是复制其实现。
- neo-os-workspace 与 neo-os-admin 分别拥有工作区注册表与发布/目录
  发布；SA 集成不转移这些权限。

- neo-os-web 拥有当前架构契约，直到记载的 v2
  采纳完成。neo-os-services 是公共 Morpheus
  registry、公共 runtime catalog 以及机密信封输入的来源，SA
  通过 `scripts/lib/morpheus-canonical-sync.mjs` 与之同步。
- neo-os-did 拥有 DID 身份与资格；SA 可以消费经过验证的
  资格证明，但不做身份决策。
- neo-os-services 在仓库契约要求之处提供
  服务侧集成与生成的 registry 输入。
- contracts/neo-platform-packages.json 记录合约构建的包
  来源。包可用性是构建环境的前置条件；本
  仓库对 SA 合约源码保持权威，不把
  合约权限分配给其他仓库。

## 维护准则

1. 让新的集成经由集中式的 SA 操作与校验
   面，从而保持授权与执行分离。
2. 把中继与 paymaster 路径保持为便利或资金
   层；它们不得取代链上授权。
3. 提交前运行受影响的合约、前端、形式化、迁移与测试检查。
4. 审阅生成的合约工件与部署引用，确认其与
   源码精确一致。
5. 使用约定式提交，并把生产、链与云写入排除在
   仓库验证之外。

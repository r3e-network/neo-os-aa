# 仓库组织

> 中文版本与 `docs/ORGANIZATION.md` 同构。若两者冲突，以英文版本为准。

2026-11-18 更新为三目录合约布局（`contracts/custom`、`contracts/native`、
`contracts/plugins`），它取代了 2026-10-13 的 `implementations/` 入口。更早的
2026-09-27 组织快照已随部署前的兼容面一并删除，因此本文件是唯一被跟踪的布局声明；
当前布局与归属规则如下。

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

    contracts/               Neo N3 SA 合约源码
      custom/                user-contract（ordinary）实现
        market/              SAAddressMarket 托管合约
        paymaster/           SAPaymaster 合约
        registrar/           SAPlatformRegistrar 合约
      native/                native ABI 2 实现
        SmartAccount/        共识 SmartAccount 服务的真源
        Runtime/             与其一同编译的运行时叠加
      plugins/               两个实现共用的插件合约
        verifiers/           verifier 插件
        hooks/               hook 插件
        recovery/            社交恢复 verifier
        templates/           第三方插件起点
        native-profile/      共用插件的 native 配置构建
      build/                 公开部署的固定工件
      compile.sh             把全部合约构建到 contracts/bin/（已忽略）
    tests/                   测试套件
      mocks/                 测试套件部署的 mock 合约
    formal/                  形式验证输入与检查
    frontend/                SA 应用与服务端路由
    sdk/                     SA SDK 面
    shared/                  共享的 SA 类型与辅助函数
    supabase/                SA 数据库迁移
    scripts/                 仓库工具
    docs/                    项目文档
    .github/                 CI 工作流
    SmartAccount.sln         .NET 解决方案
    README.md                公开项目与边界文档

`contracts/custom/` 与 `contracts/native/` 存放同一分支上的两个实现；
`contracts/plugins/` 存放两者都会绑定的 verifier 与 hook 合约。每个实现目录带有一份
`profile.json`，记录其源码根、工件与验证命令；源码文件不重复。ordinary 配置
（`contracts/custom/`）是当前 user-contract 的交付路径。native 配置
（`contracts/native/`）存放为标准提交准备的共识 `SmartAccount` 服务真源；对应的
Neo core 仓库携带由它生成的副本，并拥有 native VM 的强制执行。

## 文件组织规则

- 合约源码与合约专属检查保留在 contracts/ 下，且只属于 custom/、native/ 或
  plugins/ 其中之一。只有一个实现使用的合约归该实现；两个实现都能绑定的插件归
  plugins/。
- mock 与探针合约保留在 tests/mocks/ 下；它们是测试夹具，不属于任何一个实现。
- 第三方插件起点保留在 contracts/plugins/templates/ 下；模板针对
  共享插件层（contracts/plugins/verifiers/Verifier*.cs、
  contracts/plugins/hooks/HookAuthority.cs）编译，scripts/check_plugin_templates.mjs 使
  其 manifest 与核心的绑定期 ABI 门禁保持一致。
- 使用 `contracts/custom/profile.json` 与
  `contracts/native/profile.json` 选择实现配置；
  不要从部署标签或共享的工件目录推断配置身份。
- 仅 native 使用的模块与客户端代码保留在
  `contracts/native/profile.json` 列出的 native 根目录下；ordinary 源码不得通过导入
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

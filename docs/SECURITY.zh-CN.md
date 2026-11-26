# Neo N3 Smart Account 安全模型

本书陈述原生 `SmartAccount` 协议服务及账户所安装模块的安全模型。内容派生自
[v4.1 IDL](proposals/smartaccount-v4.1.idl.json)、[SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md) 与
[SA-MODULE-PROTOCOL.zh-CN.md](SA-MODULE-PROTOCOL.zh-CN.md)；本书与它们冲突时，以它们为准。
协议尚未发布，也没有任何网络激活，因此这里没有任何关于公开网络的陈述。

## 目录

1. [范围与权限](#范围与权限)
2. [信任边界](#信任边界)
3. [身份与账户状态](#身份与账户状态)
4. [执行安全](#执行安全)
5. [配置与治理](#配置与治理)
6. [紧急遏制](#紧急遏制)
7. [恢复](#恢复)
8. [费用与失败语义](#费用与失败语义)
9. [模块信任假设](#模块信任假设)
10. [未决边界](#未决边界)

## 范围与权限

原生合约是一个闭合的 26 方法 ABI。核心拥有身份与资金地址、操作编码与摘要、nonce 通道、单路由执行、带代码绑定的模块注册表、
冻结与凭据撤销，以及受限的 `resetAccount` 落地入口。模块拥有塑造策略的一切：治理意图、阈值名单、消息签名、hook 顺序与恢复策略。
任何模块都不扩展原生 ABI。

本书中的每一项权限都是核心或标准模块的同意检查。SDK、RPC 节点、中继或用户界面可以构造、模拟或提交交易，但都不能授予合约拒绝的权限。

## 信任边界

| 层 | 信任它负责 | 不信任它负责 |
| --- | --- | --- |
| Neo N3 | 出块时间、witness 作用域规则、合约状态与 `Runtime.CheckWitness` | 账户策略 |
| 原生核心 | 准入、nonce 消耗、路由、代码绑定、模块注册表 | 判断一个操作是否出于用户意愿 |
| 已安装模块 | 授权、hook、治理延迟、恢复策略 | 扩展 ABI 或绕过核心 |
| RPC 节点与 SDK | 发现、构造、模拟 | 对资金或配置的权限 |
| 费用支付方 | 为交易付费 | 任何账户权限 |

## 身份与账户状态

账户就是它的 `accountId`，由托管与盐推导。托管地址与恢复地址是权限方，不是身份：更换托管不改变账户 ID 与资金地址。盐必须由持有人保存。

控制记录保存状态、托管、权限 epoch、配置 nonce、两个内置授权开关、必需的 validator 与控制修订号。已注册账户处于 Active 或 Frozen。
冻结、解冻与恢复推进权限 epoch；每个落地的配置批次与每次推进计数器的状态迁移推进配置 nonce。签名、意图与恢复请求都绑定其创建时的计数器，
计数器变化后即失效。

## 执行安全

- **每笔交易一个操作。** `executeUserOp(accountId, operation)` 是唯一的执行入口，没有批量入口，也没有赞助入口。
- **准入不是授权。** 代理见证调用 `verify(accountId)`，它只检查调用者是代理且不是支付方、账户处于 Active、交易脚本恰好是对该账户的一次
  `executeUserOp` 调用，以及截止时间、权限 epoch、配置 nonce 与 nonce 是当前的。它不验证任何签名，处于单个 witness 可用的 1.5 GAS 之内。
- **授权只发生一次**，在 `executeUserOp` 内部：被路由到的 validator 或内置托管签名为确切的 13 字段操作授权，nonce 被消耗，pre-hook 正序执行，
  目标被调用，post-hook 在同一快照上逆序执行。回调的参数与结果是各自独立的副本。
- **一切都被绑定。** 操作及其摘要绑定网络、原生合约、账户、nonce 通道、截止时间、validator 编号、其凭据代数、权限 epoch 与配置 nonce。
- **代码被绑定。** 安装时记录模块的合约哈希、NEF 摘要、profile 摘要、合约编号与更新计数；每次回调前后与提交前重新核对。
  被更新、销毁或重建的合约会被拒绝。
- **作用域很窄。** 代理见证只授予预期的目标帧；后代调用无法访问账户资产，账户代理永远不能作为费用支付方。
- **阈值由核心计数。** 复合 validator 在名单顺序中选择最先达到法定人数的有效子项；核心从不读取名单、权重或法定人数，
  只有被选中的子项获得执行后权限。

无效签名会通过 witness，并在执行时出错且不改变任何状态；费用被消耗。发送前先模拟。

## 配置与治理

- **注册**要求托管见证。其动作只能是安装，至多 16 个，原子生效。
- **之后的一切变更都是** governance 模块上的意图：`proposeConfiguration`、24 小时成熟、在 7 天窗口内 `confirmConfiguration`，
  至多 16 个待生效意图，每个 16 个动作。提出、确认与撤销未过期的意图都要求托管见证；调用这些入口的已安装 validator 不是治理见证。
  任何人都可以清理已过期的意图。
- **核心只接受一个写入者。** 安装、移除、配置、内置授权变更与解冻，只能由账户已安装且代码绑定的 governance 实例到达核心。
  仅由托管签名的直接调用会以 `SA_UNAUTHORIZED` 失败。
- **每个落地批次恰好推进一次配置 nonce。**
- **Frozen 账户只接受一种意图。** 处于 Frozen 时，只有解冻意图可以被提出、确认或撤销。
- **强制支出是路由规则。** 钉住必需的 validator 后，每个操作都要经过该 validator。这不是控制权转移：托管可以经 24 小时治理路径解除，或走恢复。

## 紧急遏制

| 动作 | 谁 | 效果 |
| --- | --- | --- |
| `freezeAccount` | 托管见证，账户处于 Active | 立即生效；推进权限 epoch，待生效意图与恢复请求随之失效 |
| `revokeModuleCredentials` | 托管见证或 governance 实例，账户处于 Active | 立即生效；推进该 validator 的凭据代数，上一代凭据下的每个签名都失败 |
| 解冻 | 治理意图 | 24 小时之后，7 天之内 |

延迟移除不是紧急控制。需要立即遏制并更换托管时，先冻结，确认 Frozen，再发起恢复请求。

## 恢复

恢复是恢复席位的状态，账户在创建时不携带任何恢复延迟。席位策略为 `[guardians[], threshold, timelockMs, authority]`：
1 至 10 位守护者，阈值至少为 1，延迟 7 至 90 天。

| 步骤 | 谁 | 规则 |
| --- | --- | --- |
| `beginRecovery(accountId, newCustody)` | 托管、已配置的恢复权限方或守护者法定人数；指定新托管时该托管也须见证 | 账户处于 Active 或 Frozen；只能有一条待生效请求；计时永不重置 |
| `cancelRecovery(accountId)` | 同样的权限方 | 直到请求被执行 |
| `executeRecovery(accountId)` | 任何人 | 到期之后，且权限 epoch、配置 nonce、策略修订号与摘要均未改变 |

执行无需许可且不调用任何回调。核心的 `resetAccount` 只接受已安装且代码绑定的恢复席位：它在不调用 validator 或 hook 的情况下
移除全部模块实例与 nonce 游标，在请求指定了新托管时替换托管，清除必需的 validator，重新启用内置授权，让账户回到 Active，
并推进权限 epoch、配置 nonce 与控制修订号。随后席位在同一笔交易中把账户的模块集合作为一次仅安装的组合重装
（恢复席位与具备治理能力的 validator 优先，至多 16 个实例），并删除自己的策略，因此守护者、阈值与延迟必须重新配置。
一笔结束时仍未安装具备治理能力的 validator 的重置交易整体失败。

若旧托管密钥可能已泄露，请先冻结：仅提出恢复并不会冻结 Active 账户。恢复不是退还模块持有资金或撤销外部授权的承诺。

## 费用与失败语义

账户不能支付费用；由外部支付方在分别核对系统、网络与总费用上限后签署完整交易。声明的 `SystemFee` 是唯一的执行上限，网络将其全额消耗，
因此被打包的交易即使 Application 出错仍会向支付方收费。目标返回 Boolean `false` 是业务结果，不是故障。交易 ID 只代表提交：
确认需要回读确切的交易及其应用结果。

## 模块信任假设

模块的 profile 是准入兼容性检查，不是其字节码行为与描述一致的证明。安装一个 validator 就是授予它对操作的权限；
具备治理能力的 validator 可以重新配置账户；恢复席位可以重置账户；hook 可以拒绝每一个操作。只安装针对其角色经过审阅的代码。
标准模块包括 NeoWitnessValidator、SessionKeyValidator、MultiSigValidator、SigningModule、ThresholdPolicyModule、GovernanceModule、
RecoveryModule，以及白名单、日限额与代币限制 hook。

同一把 P-256 密钥同时作为会话密钥与标准 Neo 签名者只产生一票，而不是两票。不同的密钥不能证明是不同的人，任意验证脚本也说明不了谁控制它。

## 未决边界

- **批量账户。** `createAccounts` 的条目不安装任何模块，而核心不接受没有 governance 实例的后续安装，因此这类账户无法获得模块。
  是去掉批量入口，还是允许一次由托管见证的首次安装，仍是未决的设计决定。
- **恢复组合。** 重置后的重装至多 16 个实例；超出该上限的实例不会被重装。
- **证据。** 单元测试、本地 NeoVM 运行与有界形式模型只覆盖它们所指明的源码树，不建立完整的编译器细化、密码学可靠性或公开网络上的行为。

## 附录 B：前端依赖安全评估

2026-11-16 对本仓库的每一个 manifest 生态重新审阅：
`npm audit` 对 `sdk/js` 报告 0 个发现，
`dotnet list package --vulnerable --include-transitive` 对
全部 43 个 .NET 项目（合约、hooks、verifiers、native core、探针与测试
fixture）报告 0 个发现。前端仍为 22 个生产依赖 / 27 个总受影响包，
全部为 low，且都归结为下面两条已审阅的公告；两个审计门禁均通过。
`@web3auth/modal` 11.4.3 被重新评估为升级路径：其
已发布 manifest 仍直接依赖 `deepmerge ^4.3.1`，因此该大版本
迁移不会消除任一上游公告，Web3Auth 10.x 系列加上
本次审阅策略仍是正确的姿态。GitHub 网页 UI 上的 Dependabot 告警数
滞后于已合并状态；上述本地门禁才是事实来源。

审阅于 2026-10-30。前端剩余的 low 严重度审计条目
来自两条上游公告——Elliptic 与 deepmerge——包括传播到
依赖包的发现。它们是已知的上游风险，而不是
零漏洞结果。当前生产审计报告 22 个受影响
包，均为 low；完整依赖树报告 27 个，在下面的 Vite 与 qs 补丁之后
没有 moderate、high 或 critical 发现。

### 已打补丁的渲染器

- DOMPurify 固定为 **3.4.16**，修复了
  [GHSA-p98j-92pf-mc4p](https://github.com/cure53/DOMPurify/security/advisories/GHSA-p98j-92pf-mc4p)
  与 [GHSA-6688-9rhm-gjv2](https://github.com/cure53/DOMPurify/security/advisories/GHSA-6688-9rhm-gjv2)。
  这两条都涉及 `IN_PLACE` 消毒。经审阅的 Mermaid 代码消毒
  的是序列化后的 SVG 字符串，且应用没有启用 `IN_PLACE`。
- Mermaid 的 KaTeX 依赖被覆盖为 **0.18.2**，修复
  [GHSA-238p-pmpm-9mq7](https://github.com/KaTeX/KaTeX/security/advisories/GHSA-238p-pmpm-9mq7)。
  该缺陷需要预先存在的原型污染，或对渲染器
  选项原型的控制；它本身并不引入原型污染。
  该限定范围的覆盖跨越了 Mermaid 声明的 `^0.16.47` 范围。应用
  通过 Mermaid 使用稳定的 `renderToString` API，并有 Chromium 覆盖
  flowchart、时序图、分式、平方根、恶意 HTML、
  JavaScript 链接以及继承的 `trust` 选项。参见
  [KaTeX API](https://katex.org/docs/api) 与
  [0.18.2 发布说明](https://github.com/KaTeX/KaTeX/releases/tag/v0.18.2)。

文档渲染器由 `DocsView.vue` 惰性加载；文档内容
来自仓库固定的 loader 注册表。Mermaid 与 KaTeX 在
依赖清单中列为开发依赖，但会随浏览器 chunk 发布，因此仅做
生产依赖审计是不够的。两个依赖作用域都会被检查。

### 剩余的 Elliptic 风险

[GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84)
影响 Elliptic 直至 6.6.1。审阅时，6.6.1 是已发布的最新
版本，公告也未列出已修复版本。上游的
[签名截断报告](https://github.com/indutny/elliptic/issues/321)
描述了对某些曲线/摘要组合的不正确处理，以及对
攻击者自选 prehash 的担忧。这里并未演示针对本应用的密钥
泄露利用；这也不构成该依赖安全的证据。

Elliptic 由活跃的 Web3Auth/Torus 依赖树使用。在所检查的
已安装代码中，Torus 的 metadata 签名使用 secp256k1 与 32 字节 Keccak 摘要，
且 `@toruslabs/eccrypto` 对该曲线最多接受 32 字节消息。其他
传递路径包括 Starkware/XRPL 支持与 `crypto-browserify`
polyfill。不能仅因为应用当前暴露了身份登录流程，就宣称
这些分支全都无害或不可达。

native 工作区没有直接导入 Web3Auth modal 运行时。
`didService` 只在初始化身份客户端时导入它；身份
重连是使用 `useDidConnection` 的视图中的另一个可能触发点。
在 chunk 边界修复之前，一次全新的生产环境 `/native` 访问仍会加载
一个 3.17 MB、包含 Elliptic 的共享身份 chunk：手工分组把
Ethers 与 Vite 的 preload 辅助函数拉进了该延迟 chunk。构建现在保持
手工分组显式，并让身份依赖树保留自动的
chunk 边界。Chromium 验证了普通路由（包括注册后的 `/native`）
在身份初始化之前不会请求任何包含 Elliptic 的 chunk。它还会导入并
构造真实的打包 Web3Auth provider，因此保持延迟不会悄悄移除该功能。
实测的 native 路由 JavaScript 从 3,817,540 字节降至 663,165 字节（未压缩），
约 83%。这是加载边界，而不是对剩余公告的修复。
延迟的 provider 仍会产生超过未变的
3.5 MB 预算的构建体积警告；该警告未被抑制。native wallet 操作交给外部 wallet。native Node SDK
接受调用方提供的交易签名器，并用 Node crypto 校验其 P-256 签名。
这种分离并不消除前端的依赖风险。

升级 Web3Auth 到 11.4.2 **不是**对 Elliptic 的完整修复：已发布的
[`@web3auth/no-modal` 11.4.2 manifest](https://registry.npmjs.org/@web3auth/no-modal/11.4.2)
仍依赖 `ripple-keypairs ^1.3.1` 与 `xrpl ^2.14.0`；
[`ripple-keypairs` 1.4.0](https://registry.npmjs.org/ripple-keypairs/1.4.0)
仍依赖 Elliptic。尽管较新的 Torus crypto 包使用 Noble，把它们
强制置于较旧的调用方之下并不是经验证过的兼容替换。独立的
polyfill 路径也依然存在。本次改动不包含任何 Web3Auth 大版本迁移、
自定义密码学补丁，或审计建议的 polyfill 降级。

### 剩余的 deepmerge 风险

[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
影响 `deepmerge` 4.2.0 至 4.3.1。审阅时，4.3.1 是已发布的
最新版本，公告也未列出已修复版本。问题是通过
`mergeObject()` 在返回的对象图中进行原型投毒。

Deepmerge 由延迟的 Web3Auth/Torus 身份路径加载，用于
合并应用、dashboard 与登录配置。这是客户端本地
JavaScript：投毒成功只会影响加载了
攻击者控制值的那个页面，而不会影响其他源或 Neo 链。应用
不接受任意对象图作为身份配置，其 CSP
也不允许该依赖被无关脚本引入。这些
约束降低了暴露面，但并不能证明该依赖无害。强制
Web3Auth 降级不是可接受的修复，且在本次审阅时点不存在
兼容的已修复版本。

Vite 升级到 6.4.5 以修复 GHSA-8g5g-mxqh-grgj，qs 升级到 6.17.1 以修复
GHSA-6pq8-jhm2-2vcw。这两条公告在 moderate 严重度下都不被允许；两者都在
lockfile 中修复，而不是由审计策略接受。

### 审计策略与验证

`npm run audit:prod` 与 `npm run audit:all` 把每一条报告出的依赖
发现解析到其公告叶子。只有 **Elliptic 的 GHSA-848j-6mx2-7j84** 与
**deepmerge 的 GHSA-gcqx-w48m-w2h4**，且每条不超过 low 严重度，被
接受。不存在按包名或 moderate 严重度的例外。已知包上出现
新公告同样会失败。非法 JSON、registry 错误对象、
缺失或未知的严重度、不完整的报告、不一致的计数，以及
未解析的公告路径，都会 fail closed。

门禁要求一份新鲜的、成功的 npm audit 报告。当存在兼容的上游修复时，
例外必须被移除；扩大被接受的公告集合
需要单独的审阅。审计门禁通过并不代表协议、
部署或签名安全。

在 `frontend/` 下复现这一聚焦验证：

```sh
npm ci
node --test tests/frontendAuditPolicy.test.js tests/frontendAuditBaseline.test.js
npm run audit:prod
npm run audit:all
npm run test:docs-security:browser
npm run test:bundle:browser
```

仓库的前端验证命令也包含这个浏览器安全
测试，与生产构建、单元测试以及既有浏览器测试并列。

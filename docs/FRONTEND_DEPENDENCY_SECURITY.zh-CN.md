# 前端依赖安全评估

> 中文版本与 `docs/FRONTEND_DEPENDENCY_SECURITY.md` 同构。若两者冲突，以英文版本为准。

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

## 已打补丁的渲染器

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

## 剩余的 Elliptic 风险

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

## 剩余的 deepmerge 风险

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

## 审计策略与验证

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

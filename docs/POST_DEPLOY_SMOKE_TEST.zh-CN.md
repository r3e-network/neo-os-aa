# 部署后冒烟测试

> 中文版本与 `docs/POST_DEPLOY_SMOKE_TEST.md` 同构。若两者冲突，以英文版本为准。

在部署新的前端构建之后立即使用本清单。

## 目标

确认最新部署的前端确实在生效、不是陈旧的，并且关键的 wallet、studio、docs 与运营流程仍然可用。

## 1. 版本与缓存检查

- 确认已部署的 revision 就是目标提交。
- 确认 CDN / 托管缓存已刷新。
- 部署后对浏览器做一次强制刷新。
- 若仍出现陈旧的 bundle，清除站点数据后重新加载。

## 2. 浏览器控制台检查

在开启 DevTools 的情况下打开站点，确认：

- 没有 `t is not a function` 报错
- 安装 NEOLine 后没有 `No supported Neo wallet provider detected in browser.` 报错
- 首次加载页面时没有意外的 Vue 渲染错误

## 3. Wallet 检测

在安装 NEOLine 的情况下，确认前端能检测到 module 形式的 provider，例如：

- `window.NEOLineN3.N3`
- `window.NEOLine.NEO`

然后：

- 点击 Neo wallet 连接操作
- 确认出现 wallet 提示或账户响应
- 确认 UI 反映了已连接的 wallet 状态

## 4. Studio 检查

依次打开每个 studio 面板，确认渲染无异常：

- Create Account
- Studio Sidebar
- Manage Governance
- Permissions & Limits

预期结果：

- 面板标题与标签正常渲染
- 控制台不出现 `t is not a function` 报错

## 5. 运营流程检查

确认主要前端流程仍可渲染：

- 首页 operations workspace 可加载
- Load Account 面板可渲染
- Compose / signature / broadcast 区块可渲染
- Docs 页面可打开
- 存在草稿或 tx 路由时，交易信息页面可渲染

## 6. 中继与提交检查

若环境中启用了中继：

- 确认 relay preflight UI 仍可渲染
- 确认 operator 操作在加载时不会立即失败
- 确认 UI 中不出现新的 5xx 或格式错误的报错信息

## 7. 通过标准

满足以下条件时，本次部署通过冒烟测试：

- 目标构建已生效
- 核心页面的控制台没有运行时异常
- 受支持 provider 的 wallet 检测可用
- studio 面板渲染正确
- 运营页面保持可用

## 8. 冒烟测试失败时

收集并上报：

- 已部署的 commit SHA
- 从 DevTools network 面板读取到的已加载资源文件名
- 控制台报错的完整原文
- 浏览器与扩展的版本
- 托管平台或 CDN 的细节

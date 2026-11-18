# 主网只读校验

> 中文版本与 `docs/mainnet-validation-runbook.md` 同构。若两者冲突，以英文版本为准。

本运行手册在不广播任何交易的前提下，校验已发布的 Neo N3 主网 SA 锚点。

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

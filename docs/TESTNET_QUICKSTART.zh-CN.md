# 测试网快速上手

> 中文版本与 `docs/TESTNET_QUICKSTART.md` 同构。若两者冲突，以英文版本为准。

在任何真实的校验运行之前，先检查计划和环境是否就绪：

```bash
cd sdk/js
cp .env.example .env
# 填入 TEST_WIF（有余额的测试网账户）
npm run testnet:validate:dry-run
```

干跑会打印计划执行的校验阶段，以及哪些可选阶段会因为缺少环境变量而被跳过，
不会广播任何交易。

干跑结果没有问题后，再执行真实的校验套件：

```bash
npm run testnet:validate
```

RPC 端点固定方式（`TESTNET_RPC_URL` / `TESTNET_RPC_URLS`）、阶段列表和各阶段命令，
见根目录 `README.md` 的 "Live Testnet Validation" 一节。

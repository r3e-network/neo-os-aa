# Neo SmartAccount

SmartAccount 是 Neo N3 的账户抽象协议，尚未发布。仓库只维护当前原生实现，没有要迁移的已发布账户，钱包用户也不需要选择协议版本。[English](README.md)

阅读[模块协议](docs/SA-MODULE-PROTOCOL.zh-CN.md)和[当前协议参数](docs/proposals/smartaccount-native-profile-parameters.json)即可开始集成。[原生实现清单](contracts/native/profile.json)列出了实现位置及尚未通过的验收项。

钱包连接节点、核对网络和 SmartAccount 接口后才开放操作。基础账户使用托管地址授权；验证器、钩子和恢复策略都按需启用。协议给出的数量是上限，不是开户步骤，也不是用户每次要支付的费用。

| 任务 | 入口 |
| --- | --- |
| 核对共识实现 | [原生核心](contracts/native/README.md) |
| 配置签名、恢复或治理 | [标准模块](contracts/modules/README.md) |
| 开发钱包或应用 | [SDK](docs/SDK.zh-CN.md) · [钱包工作台](frontend/src/features/native/) |
| 验证实现 | [验收项](contracts/native/profile.json) · [形式化检查](formal/verify.py) |

本地验证：将 `NEOOS_NATIVE_CORE_SOURCE` 指向经过审查的 Neo Core 检出，执行 `./scripts/verify_repo.sh --profile native --contracts-only`。SDK 测试在 `sdk/js` 目录执行 `npm test`。本地测试和策略证明不能替代完整实现证明或公共网络激活。

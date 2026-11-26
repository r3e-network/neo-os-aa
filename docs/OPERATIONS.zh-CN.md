# 运维手册

协议处于设计阶段，没有任何公开部署。本书中的每个流程都在本地源码树、本地构建或私有链上运行。一次通过的本地运行只是它所指明的源码与工件的证据，仅此而已。

## 目录

1. [本地验证](#本地验证)
2. [生成与钉住的文件](#生成与钉住的文件)
3. [证据规则](#证据规则)

## 本地验证

除非另行指明目录，均在仓库根目录运行。触及所列输入的变更必须让对应的检查保持通过。

| 检查 | 命令 | 覆盖范围 |
| --- | --- | --- |
| 核心单元测试（`neo-native-core`） | `dotnet test tests/Neo.UnitTests --filter "FullyQualifiedName~SmartAccount"` | 编译后的原生合约及其标准模块 |
| 原生 profile CI | `python scripts/test_native_profile_ci.py` | profile 参数、fixture manifest 与核心副本对照 IDL |
| 模块接口检查 | `python scripts/check_module_neps.py` | 具名模块接口对照 NEP 草案 |
| 仓库检查 | `bash scripts/verify_repo.sh` | 格式、打包与合约测试套件 |
| JS SDK | `cd sdk/js && npm test` | 客户端编码、路由与 ABI 守卫 |
| 前端与文档 | `cd frontend && npm test` | 工作台、生成的帮助页面与文档守卫 |
| 形式验证（WSL） | `python3 formal/verify.py` | 有界模型与源码锁 |

## 生成与钉住的文件

- **Fixture manifest。** `tests/fixtures/native-smartaccount.manifest.json` 必须等于核心输出的 manifest。重新生成的方法：
  在运行核心 `UT_SmartAccount` 测试时设置 `SMARTACCOUNT_MANIFEST_FIXTURE=<输出路径>`，然后以 LF 换行把文件复制到
  `neo-os-aa` 与 `neo-native-core` 两处。
- **客户端镜像。** `frontend/src/shared/nativeSmartAccountClient.mjs` 是 `shared/nativeSmartAccountClient.mjs` 的逐字节副本。
- **帮助页面。** `frontend/src/assets/docs/` 下的页面由 `docs/` 中的书籍生成。编辑书籍后运行 `node scripts/sync-frontend-docs.mjs`；
  `--check` 在副本过期时失败。
- **协议参数摘要。** 修改 `docs/proposals/smartaccount-native-profile-parameters.json` 会改变参数摘要。需要在核心合约、其核心副本、IDL、
  两份客户端副本、fixture manifest 与 `formal/source-lock.json` 中重新钉住，然后重新生成 fixture。
- **源码锁。** `formal/source-lock.json` 钉住经过审阅的源码。被钉住的文件发生变化时需要重新钉住，并同步更新钉住该锁内容摘要的文档守卫。

## 证据规则

- 回执指明它所测量的提交、工件与运行时，它绝不是对之后源码树的陈述。
- 返回交易 ID 只代表已提交。确认需要回读交易及其应用结果。
- 本地或私有链上的运行不能证明公开网络上的任何行为，而当前没有配置任何公开网络。

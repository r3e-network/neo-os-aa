# neo-os-sa 在 NeoOS 架构中的位置

> 中文版本与 `docs/NEOOS_ARCHITECTURE.md` 同构。若两者冲突，以英文版本为准。

本文件只是指针，不是权威来源。有约束力的绑定是根目录 `README.md` 的 `Architecture authority`
一节，它在 `neo-os-web/docs/workspace/neoos-target-architecture.v1.json` 中声明，
并由 `neo-os-web` 里的 `npm run check:architecture-sources` 检查。拟议的后继版本是
`neoos-target-architecture.v2.json`（状态 `PROPOSED`），由 `npm run check:architecture:v2` 检查；
其设计文档是 `neo-os/claudedocs/NEOOS-TARGET-ARCHITECTURE-V2-20260921.md`。

## v1 绑定（已强制执行）

| 组件 | 平面 | 发布的接口 |
| --- | --- | --- |
| `protocol-sa-core` | 协议平面 | 接口：SmartAccountV3、UserOperation、SAAuthorization |

## v2 绑定（拟议）

仓库所在层：`L1`（链协议）。

| 组件 | 层 | 归属 |
| --- | --- | --- |
| `C03` account | L1 | 拥有：SmartAccount 核心、验证器、钩子、paymaster… | 不得拥有：did-eligibility、network-identity、signer-selection |

### 已声明的迁出项

| 路径 | 去向 |
| --- | --- |
| `sdk/js` | C10 |
| `frontend` | C23 |
| `frontend/api` | C14 |
| `supabase/migrations` | C14 |

这里不对部署或生产状态作任何断言。状态由工具生成，从不手写：
见 `neo-os-web/docs/workspace/ARCHITECTURE-STATUS.generated.md`。

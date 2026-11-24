# SmartAccount 模块标准接入说明

基础账户收款、转账不需要安装模块。下面两份 NEP 是本仓库的未编号草案。第一份约定核心如何调用模块；第二份约定一个具名模块对用户承诺什么。英文草案为规范文本。

钱包确认单次模块安装时，应从对应交易的应用日志取得实际分配的整数 ID；返回 `true` 不能当作安装成功。发起恢复返回正整数请求编号，只代表请求已建立。取消或执行恢复的接口没有返回值，动态调用会在栈上留下一个 VM 空值。日志同时报告 `HALT` 和异常，或者返回值类型、数量不符时，钱包不能显示成功。

正常卸载任一启用的具名模块时，钱包调用 `removeModule(accountId, moduleId, [])`。最后传空数组，无需让用户填写命令、存储键或重新提供安装参数。卸载回调失败时，不能显示“已移除”。已启用强制多签的账户仍受原权限约束；预设延时恢复走单独的重置流程。

写模块时，`onInstall`、`configure`、`onUninstall` 回调的第三个参数都是模块类型（验证器 1、钩子 4、恢复 5）。ABI 附录逐字保留编译产物的参数名；即使这个位置标为 `generation`，值也不会随凭据撤销而改变。需要凭据代次时，应从核心查询当前实例的 `credentialGeneration`。

| 我在做什么 | 看哪里 |
| --- | --- |
| 开发新模块，确定角色、声明格式、必需回调和参数顺序 | [公共接口 NEP](nep-smartaccount-module-interface.mediawiki) |
| 接入一个已有模块，了解授权范围、配置命令和拒绝条件 | [具名模块 NEP](nep-smartaccount-module-profiles.mediawiki)，按合约名查找 |
| 查实际方法名、参数类型、返回值、safe 标志和声明摘要 | [逐模块 ABI](smartaccount-module-abis.md)，每个模块一节 |
| 让 SDK 或 CI 读取某个具名模块必须提供的接口 | [具名接口清单](smartaccount-named-module-interfaces.json)，按模块名取出声明要求和专用方法 |
| 实现操作编码、签名摘要、调用阶段、费用和回滚 | [账户模块协议](../SA-MODULE-PROTOCOL.zh-CN.md) |

| 用途 | 对应的具名条款 |
| --- | --- |
| 账户配置、延时恢复、钩子顺序、消息签名策略、强制多签策略 | [GovernanceModule](nep-smartaccount-module-profiles.mediawiki#GovernanceModule)、[RecoveryModule](nep-smartaccount-module-profiles.mediawiki#RecoveryModule)、[HookOrchestratorModule](nep-smartaccount-module-profiles.mediawiki#HookOrchestratorModule)、[SigningModule](nep-smartaccount-module-profiles.mediawiki#SigningModule)、[ThresholdPolicyModule](nep-smartaccount-module-profiles.mediawiki#ThresholdPolicyModule) |
| 多签成员、链上见证、P-256 密钥、TEE 密钥 | [MultiSigValidator](nep-smartaccount-module-profiles.mediawiki#MultiSigValidator)、[NeoWitnessValidator](nep-smartaccount-module-profiles.mediawiki#NeoWitnessValidator)、[P256Validator](nep-smartaccount-module-profiles.mediawiki#P256Validator)、[TeeKeyValidator](nep-smartaccount-module-profiles.mediawiki#TeeKeyValidator) |
| 委托身份、Web3Auth、会话密钥、订阅、恢复操作会话 | [DelegatedIdentityValidator](nep-smartaccount-module-profiles.mediawiki#DelegatedIdentityValidator)、[Web3AuthValidator](nep-smartaccount-module-profiles.mediawiki#Web3AuthValidator)、[SessionKeyValidator](nep-smartaccount-module-profiles.mediawiki#SessionKeyValidator)、[SubscriptionValidator](nep-smartaccount-module-profiles.mediawiki#SubscriptionValidator)、[ActionSessionValidator](nep-smartaccount-module-profiles.mediawiki#ActionSessionValidator) |
| 目标白名单、每日支出限额、代币限制、身份凭据要求 | [WhitelistHook](nep-smartaccount-module-profiles.mediawiki#WhitelistHook)、[DailyLimitHook](nep-smartaccount-module-profiles.mediawiki#DailyLimitHook)、[TokenRestrictedHook](nep-smartaccount-module-profiles.mediawiki#TokenRestrictedHook)、[NeoDIDCredentialHook](nep-smartaccount-module-profiles.mediawiki#NeoDIDCredentialHook) |
| 已禁用，钱包不得作为可用功能展示 | [ZKEmailVerifier](nep-smartaccount-module-profiles.mediawiki#ZKEmailVerifier)、[MultiHook](nep-smartaccount-module-profiles.mediawiki#MultiHook) |

例如，要限制一天内能花多少代币，选 DailyLimitHook；要让多签约束托管人，则需要强制支出策略和不同的成员，单独装一个 MultiSigValidator 并不会建立多签。ActionSessionValidator 可以验证操作，却不能执行 RecoveryModule 的延时账户重置。

钱包可直接读取具名清单的布尔字段 `disabled`：为 true 时不得作为可用功能展示。false 只表示条款未禁用，不能据此信任某个部署或授予支出权。此字段不进入链上声明或其摘要。

上表列的是模块身份。六个绑定原生核心的构建复用各自同名模块的条款，不另设标准。开发模板是示例，SocialRecoveryService 是外部服务，两者都不是供钱包安装的具名模块。第三方模块可以只实现公共接口；如果声称兼容某个具名模块，还须满足该模块的行为条款。[开发模板说明](../../contracts/plugins/templates/README.md)给出了对自己编译的产物进行检查的命令。

消息签名与支出多签是两套权限。查询消息签名名单时，未知账户返回空数组；已注册但从未设置名单的账户返回托管人、门限 1 和版本 1；已确认名单丢失或摘要不符时查询失败，钱包不能据此显示“已恢复单签”。卸载治理模块只清理待处理提案，已确认的名单保持有效。恢复必须走预设延时席位，不依赖读取旧名单。

订阅模块只允许指定商户按配置的代币和金额上限收款。账期从 Unix 纪元起按固定秒数划分。修改周期或取消后用同一 ID 重建时，包含上次成功扣款的旧账期、新账期都结束才能再扣款。举例来说，改成每分钟扣款不会让尚未结束的小时账期提前到期。钱包传入原始订阅 ID（1 至 255 字节），不用自行哈希。

**编写自己的模块：** 编辑器可关联[模块声明 JSON Schema](smartaccount-module-profile.schema.json)，在部署前提示缺少字段、角色与回调不匹配等问题。不要把 `$schema` 写进声明。它只检查解析后的数据，重复键、非规范编码和实际部署身份仍需下面的字节和 ABI 检查。

**验证自己的模块：** 用 NEP 的规范编码生成 profile，把其 UTF-8 原始字节（没有行尾换行）作为 `getModuleProfile()` 的返回值。[最小示例](../../tests/fixtures/sa-module-protocol/module-profile.template.json)展示字段。编译后运行：

```sh
python3 scripts/check_module_neps.py --profile MyModule.profile.json --manifest MyModule.manifest.json
```

不同语言实现可以用[声明字节测试向量](../../tests/fixtures/sa-module-protocol/module-profile-vectors.json)核对编码。取每条记录的 `profileText` 字符串，直接用 UTF-8 编码并计算 SHA-256，随后检查是否应该接受。用例覆盖中文名称、必需和多余的转义、重复字段及末尾换行。

这个命令只检查声明和 manifest 接口。发布前，加上 `--nef MyModule.nef`：工具会在独立的本地 NeoVM 部署该文件，以只读权限调用 `getModuleProfile()`，逐字节比对返回值和声明。部署参数是 SmartAccount 核心地址的原始字节；有其他部署前置条件的模块需要在自己的环境复验。两种检查均不证明授权、费用、失败回滚或节点接纳。

如果你的合约实现某个具名模块，再指定标准里的模块名。例如，自己的每日限额合约可以叫 MyLimit：

```sh
python3 scripts/check_module_neps.py --profile MyLimit.profile.json --manifest MyLimit.manifest.json --nef MyLimit.nef --named-profile DailyLimitHook
```

清单中每个专用方法按「参数类型列表、返回类型、safe 标志」排列。例如，DailyLimitHook 必须提供只读的 `getDailyLimit(Hash160,Integer,Hash160) -> Integer`。合约缺少这个查询，即使公共钩子都存在，也不能通过具名检查。钱包仍须核对安装实例的代码绑定；此选项不会给同名合约授予权限。

钱包从每个条目的 `installData` 确定安装参数。它是工具用的清单，不是链上字段。治理、恢复、消息名单和强制多签策略模块只收空数组 `[]`。钩子编排模块还可收 `[[2,5]]` 这样的嵌套数组，两个整数必须恰好是核心当前的钩子顺序；这不会改变顺序。其余可用模块也可以在安装时传一条配置命令，例如白名单模块直接收 `["allowTarget", target]`，不要再包一层数组。两个禁用条目的 `installData` 为空列表，表示连空参数也不能安装。

配置数组从命令名开始，然后按清单的 `commands` 顺序追加各参数的值。整数和布尔值必须使用对应的 VM 类型。例如，日限额值用 Integer，是否启用滚动窗口用 Boolean；不能用字节串代替限额，或用数字 1 代替 true。安装时的初始配置也遵守此规则。例如，会话密钥的到期时间用 Unix 毫秒时间戳，最后一个参数是描述文字；订阅的扣款间隔用秒。日限额以代币最小单位计，填 0 会清除限额和用量记录，不能用来禁止支出。

维护仓库内置模块时，用项目锁定的 nccs 运行 `python3 scripts/check_module_neps.py --compiler nccs --vm-getters --vm-commands`。它会编译模块，在本地 NeoVM 比对实际声明，逐条执行标准配置命令并验证多传参数会被拒绝。测试核心提供调用方、执行阶段与凭据代次；该测试不验证治理授权和原生节点接纳。有意更改 ABI 时加 `--write-abi` 生成附录，再审阅差异。

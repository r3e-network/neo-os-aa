# 合约内部交接（内核检查通过，第十八号门禁作用域）

> 中文版本与 `docs/SA-CONTRACT-HANDOFF.md` 同构。若两者冲突，以英文版本为准。

**状态：已登记为第十八号闭合作用域**
（`contract-internal-handoff-and-frame-construction`）。`ContractHandoff.v` 是一个
内核检查通过的模型，`ContractHandoffArtifact.v` 是一份绑定到投影记录上的证书，21 个
语义控制各复核一个已固定的决策。以上任何一项都没有闭合某个入口点：本作用域止于
`LoadContract` 返回的上下文，在 callee 执行之前。`implementationVerified` 与
`fullImplementationVerified` 保持为 `false`。

> 反向衔接：把调用方的栈窗口变成本次调用参数的步骤属于第十九号作用域
> `interop-argument-conversion`，见
> [SA-METHOD-REFINEMENT.md](SA-METHOD-REFINEMENT.md#interop-argument-conversion-kernel-checked-nineteenth-gate-scope)。

## 为什么需要这一层

`formal/coq/EntryDispatch.v` 声明它的入口位于 interop 准入与参数转换*之后*。
`syscall-dispatch` 作用域
（[SA-METHOD-REFINEMENT.md](SA-METHOD-REFINEMENT.md#syscall-admission-systemcontractcall-and-callt)）覆盖准入，并止于
`CallContractInternal` 的参数元组。本作用域从这里开始：第二个
`CallContractInternal` 重载，以及 `LoadContract` 构造的帧。它止于构造完成的上下文，
在 callee 的任何指令执行之前。

## 固定输入（neo `d10e9cee`，neo-vm `004cd607`）

| 键 | 声明 |
| --- | --- |
| `core/engine` | `CallContractInternal`（两个重载）、`LoadContract`、`LoadScript` |
| `core/abi` | `ContractAbi.GetMethod(name, pcount)` |
| `core/basic` | `ContractBasicMethod.Initialize`、`InitializePCount` |
| `core/flags` | `CallFlags` 成员 |
| `core/method` | `ContractMethodDescriptor.ReturnType/Offset/Safe` |
| `core/contract-state` | `ContractState.CanCall` |
| `core/policy` | `PolicyContract.IsBlocked` |
| `vm/context` | `ExecutionContext.Clone(int)` |
| `vm/stack` | `EvaluationStack` |

来自固定 tarball 的 `ApplicationEngine.cs` 与入口调度作用域所固定的副本逐字节一致，
另外四个 neo 文件正是通过这一点在下定于此之前完成认证的。

## 投影推导而非断言的内容

- `safe_mask_drops` 从掩码表达式读出，并直接对 `CallFlags`
  声明求值：`WriteStates | AllowNotify = 10`。掩码放宽或收窄都无法通过。
- `increment_step` 从 `TryGetValue` 分支读出，并要求 `else` 分支与之相符
  （空计数器给出 `= 1`），因此"两种情况都加一"是被检查的，不是被假设的。
- `initializer_name_is_canonical` 与 `initializer_pcount` 来自
  `ContractBasicMethod`，而不是来自调用点。
- `lookup_is_arity_keyed` 来自 `GetMethod` 中的字典构造
  `(p.Name, p.Parameters.Length)`。

## 两类守卫

**仅理由型，从不变异。** 删掉它们在同一输入上仍然故障，因此变异体会得到相同结果、什么也证明不了：

| 守卫 | 为什么删掉后仍然故障 |
| --- | --- |
| `contract is null` | 下一条语句解引用 `contract` |
| `md is null` | 下一条语句解引用 `md` |
| `args.Count != method.Parameters.Length` | 三个可达调用方都是经 `GetMethod(name, args.Length)` 到达该重载的，而该查找以 `(Name, Parameters.Length)` 为键，所以相等关系本就成立 |
| `hasReturnValue ^ (ReturnType != Void)` | 每个可达调用方都从同一份 ABI 描述符推导出 `hasReturnValue` |

后两条才是有意思的：在全部三个调用点（`CallContract`、`OnCallT`、`CallFromNativeContractAsync`）
上它们都*不可达*，因此被建模为无条件故障，而不是可变谓词。

**可判别型，需要变异。** 21 个控制，每个只改一个投影字段，覆盖全部 18 个派生字段：

`drop-blocked-gate`、`mask-nothing`、`mask-read-states`、`mask-everything`、
`drop-authorization-gate`、`authorize-the-callee`、`increment-twice`、
`skip-increment`、`hand-off-raw-flags`、`drop-calling-context`、
`drop-whitelisted-fee`、`whitelist-keeps-flag-false`、`push-in-order`、
`swap-rvcount`、`zero-offset`、`share-the-contract`、`drop-initializer-frame`、
`drop-snapshot-clone`、`lookup-by-name-only`、`initializer-pcount-one`、
`initializer-renamed`。

## 内核证明了什么

`formal/refinement/coq/ContractHandoff.v` —— 42 个闭合声明，全部
`Closed under the global context`，`coqchk -silent` 干净：

| 分组 | 声明 |
| --- | --- |
| 拒绝顺序 | `blocked_rejects`、`unauthorized_rejects`、`arity_mismatch_never_accepts`、`arity_precedes_return`、`return_mismatch_rejects`、`authorization_precedes_arity`、`blocked_precedes_authorization` |
| 计数器位置 | `blocked_counter_is_untouched`、`unauthorized_counter_is_untouched`、`arity_rejection_after_the_increment`、`return_rejection_after_the_increment`、`accepted_counter_is_incremented` |
| 接受 | `accepted_frame_records_the_call`、`safe_method_skips_authorization` |
| 标志代数 | `handed_flags_are_the_intersection`、`handed_flags_do_not_exceed_the_caller`、`raw_handoff_can_exceed_the_caller`、`mask_removes_the_projected_bits` |
| 帧内容 | `rvcount_is_zero_for_void`、`rvcount_is_one_for_non_void`、`swapped_projection_inverts_the_void_case`、`offset_is_the_method_offset`、`contract_fields_are_copied`、`snapshot_cache_is_cloned`、`calling_context_points_at_the_caller`、`stack_is_the_reverse_of_the_argument_vector`、`reverse_preserves_the_argument_count`、`whitelisted_fee_is_charged`、`no_whitelist_no_fee` |
| 初始化帧 | `initializer_adds_one_frame`、`no_frame_without_the_lookup`，以及四个分量定理 |

`ContractHandoffArtifact.v` —— 19 个声明：投影记录等于
`canonical_handoff`，派生常量（`safe_mask_drops = 10%N`、
`increment_step = 1`、`initializer_pcount = 0`，以及名称 / 参数个数 / 标志 / 帧的
输入），以及把同一批拒绝、接受与帧定理实例化到源码实际产生的记录上，
而不是实例化到人工复核过的字面量上。

关于编码有两点值得写下来，因为二者都由内核发现，而不是靠阅读发现：

- `Bool.eqb` 只匹配第一个参数，因此对未知的 `b`，`Bool.eqb b b`
  不会归约；在返回类型守卫可以被消解之前，需要先引入 `eqb_diag`。
- `initializer_lookup_succeeds` 中的 `andb` 链在某个变量上左阻塞，
  因此 `andb X false` 不会归约。`no_frame_without_the_lookup` 做了那一次
  本会被四个分量定理各自重复的 case 拆分。

第三点由测试发现：Python 中 `1 == True`，因此投影记录不仅要按值比较，
还要按类型比较（`closure.py` 中的 `literal_equal`，以及渲染器中的
`NUMERIC_FIELDS`）。一个存放 `1` 的布尔槽位是另一条记录，不是被复核的那条。

## 本层记录的事实

- 计数器在参数个数检查与返回类型检查**之前**递增，因此因这两者之一被拒绝的
  调用已经消耗了一个计数槽位；被拦截的调用与未授权的调用则没有。
- `flags & callingFlags` 在 `LoadContract` 调用处生效，因此 callee 的
  `CallFlags` 同时受请求字与调用方自身字约束。
  `CallContract` 交付的 `md.ReturnType != Void` 来自同一描述符，而 `OnCallT`
  交付的是 token 的 `HasReturnValue`。
- `LoadContract` 把合约字段复制进一个新的 `ContractState`，并克隆快照缓存；
  `ExecutionContext.Clone` 共享*shared states*对象，因此 `_initialize` 帧看到的是
  同一个 `ExecutionContextState`。
- `rvcount` 在 `Void` 时恰为 `0`，否则为 `1`；初始位置是
  `method.Offset`，参数向量按逆序压栈。

## 仍然开放

- `AddFee`、gas、资源上限与所有异常类型；`Rejected`
  构造子是故障，不是 .NET 异常身份。
- `IsBlocked`、`IsWhitelistFeeContract`、`GetContract` 以及 manifest / ABI
  加载背后的存储读取；只把它们的答案作为输入。
- `LoadScript` / `CreateContext` 内部的栈与静态字段共享、引用计数与 `Dispose`
  顺序。
- 可信 C# 抽取以及编译器 / CLR 对应关系；构造出的上下文内部的实际执行；全部 109 个公开入口点。

## 运行方式

```sh
# 仅投影。
AA_CONTRACT_HANDOFF_SOURCE_MIRROR=/path/to/pinned/cs \
python3 -c "import contract_handoff_source as s; print(s.project_production('/tmp/handoff')['program'])"

# 模型、证书与全部 21 个控制。
AA_CONTRACT_HANDOFF_SOURCE_MIRROR=/path/to/pinned/cs \
python3 contract_handoff_proofs.py --output-dir /tmp/handoff/out \
    --json-report /tmp/handoff/report.json
```

镜像只承担传输：其字节必须哈希到与在线下载相同的固定值。

<template>
  <div class="native-workspace" :aria-busy="busy">
    <header class="native-heading">
      <div>
        <p class="eyebrow">NEO · NATIVE ABI 4</p>
        <h1>{{ L("Native accounts", "原生智能账户") }}</h1>
        <p>
          {{
            L(
              "Stable identity. Module-level policy. Verifiable recovery.",
              "稳定身份，延迟配置，可验证的恢复路径。",
            )
          }}
        </p>
      </div>
      <span class="pill" :class="{ verified: profile }">{{
        profile
          ? L(
              "Protocol v4 profile matched · " + profile.implementationId,
              "v4 协议配置匹配 · " + profile.implementationId,
            )
          : L("Read only · not verified", "只读 · 尚未验证")
      }}</span>
    </header>
    <section class="card endpoint-card" aria-labelledby="node-title">
      <h2 id="node-title">1. {{ L("Verify the network", "验证网络") }}</h2>
      <p>
        {{
          L(
            "This node must answer protocol v4, the full native ABI and the shipped implementation id. A v3 kernel cannot activate this workspace.",
            "当前节点必须返回 v4 协议、完整原生 ABI 与已发布实现 ID。v3 内核无法启用本工作区。",
          )
        }}
      </p>
      <div class="endpoint-fields">
        <label
          >{{ L("RPC endpoint", "RPC 节点")
          }}<input
            v-model.trim="endpoint"
            data-testid="native-endpoint"
            type="url"
            autocomplete="off"
            spellcheck="false" /></label
        ><label
          >{{ L("Expected network magic", "预期网络 Magic")
          }}<input
            v-model.trim="network"
            data-testid="native-network"
            inputmode="numeric" /></label
        ><button :disabled="busy || !endpoint || !network" @click="connectNode">
          {{ L("Verify node", "验证节点") }}
        </button>
      </div>
      <p v-if="profile" class="small mono">
        SmartAccount · protocol {{ profile.protocolVersion }} · network
        {{ profile.networkMagic }}<br />{{ profile.implementationId }}<br />0x{{
          profile.contract
        }}
      </p>
      <p v-else class="callout">
        {{
          L(
            "Registration and wallet hand-off are disabled until native discovery succeeds.",
            "在原生能力验证成功前，注册和钱包提交保持禁用。",
          )
        }}
      </p>
    </section>
    <div v-if="error" role="alert" class="notice error">{{ error }}</div>
    <div v-if="notice" role="status" class="notice success">{{ notice }}</div>
    <p v-if="busy" role="status">
      {{ L("Checking native state…", "正在检查原生状态…") }}
    </p>
    <details class="card receipt-restore" data-testid="native-receipt-restore">
      <summary>{{ L("Restore a transaction receipt", "恢复交易回执查询") }}</summary>
      <p>{{ L("After a page refresh, import the original reviewed request and signed transaction to check that exact transaction, including after expiry or execution. This read-only path cannot sign, preflight or broadcast a transaction.", "刷新页面后，可导入原审核请求和已签交易，查询同一笔交易；交易过期或已执行后仍可查询。此入口仅供只读确认，不能签名、预检或广播交易。") }}</p>
      <label>{{ L("Archived reviewed request", "原审核请求文件") }}<input type="file" accept="application/json,.json" :disabled="busy" @change="readReceiptFile('review', $event)" /></label>
      <p v-if="receiptFiles.reviewName" class="small">{{ receiptFiles.reviewName }}</p>
      <label>{{ L("Signed transaction for receipt", "用于查询回执的已签交易文件") }}<input type="file" accept="application/json,.json" :disabled="busy" @change="readReceiptFile('artifact', $event)" /></label>
      <p v-if="receiptFiles.artifactName" class="small">{{ receiptFiles.artifactName }}</p>
      <button class="secondary" :disabled="busy || !profile || !receiptFiles.review || !receiptFiles.artifact" @click="restoreReceipt">{{ L("Verify receipt files", "核对回执文件") }}</button>
      <template v-if="restoredTransaction">
        <p class="mono">{{ restoredTransaction.txid }}</p>
        <p>{{ L("Original signed bytes and network verified. Confirmation checks this exact transaction only.", "已核对原已签字节和网络，确认仅针对这笔精确交易。") }}</p>
        <button class="secondary" :disabled="busy" @click="confirmRestoredReceipt">{{ L("Check restored receipt", "检查恢复的回执") }}</button>
      </template>
    </details>
    <nav class="tabs" :aria-label="L('Native account tasks', '原生账户任务')">
      <button
        v-for="item in tabs"
        :key="item.id"
        :aria-pressed="tab === item.id"
        @click="tab = item.id"
      >
        {{ L(item.en, item.zh) }}
      </button>
    </nav>
    <div class="columns">
      <section class="card task-card">
        <template v-if="tab === 'account'">
          <h2>2. {{ L("Load and manage", "加载与管理") }}</h2>
          <label
            >{{
              L(
                "Account ID (identity, not the funding address)",
                "账户 ID（身份标识，不是收款地址）",
              )
            }}<input
              v-model.trim="accountId"
              data-testid="native-account-id"
              spellcheck="false"
              placeholder="0x…"
          /></label>
          <div class="actions">
            <button
              :disabled="!profile || busy || !accountId"
              @click="loadAccount"
            >
              {{ L("Load account", "加载账户") }}</button
            ><label class="file-button"
              >{{ L("Import recovery descriptor", "导入恢复信息")
              }}<input
                type="file"
                accept="application/json,.json"
                @change="importDescriptor"
            /></label>
          </div>
          <p class="small">
            {{
              L(
                "The descriptor restores discovery. Back up custody and recovery wallet keys separately.",
                "恢复信息用于找回账户；托管和恢复钱包私钥需要单独备份。",
              )
            }}
          </p>
          <template v-if="snapshot">
            <div class="account-summary" data-testid="native-account-summary">
              <div class="summary-top">
                <strong>{{ snapshot.account.statusName }}</strong
                ><span
                  >Epoch {{ snapshot.account.authorityEpoch }} · Config
                  {{ snapshot.account.configurationNonce }}</span
                >
              </div>
              <dl>
                <dt>{{ L("Identity", "身份标识") }}</dt>
                <dd class="mono">0x{{ snapshot.account.accountId }}</dd>
                <dt>{{ L("Funding address", "收款地址") }}</dt>
                <dd class="mono">
                  {{ addressOf(snapshot.account.accountAddress) }}<br />0x{{
                    snapshot.account.accountAddress
                  }}
                </dd>
                <dt>{{ L("Custody", "托管权限") }}</dt>
                <dd class="mono">0x{{ snapshot.account.custodyAddress }}</dd>
                <dt>{{ L("Recovery authority", "恢复权限") }}</dt>
                <dd class="mono">
                  {{
                    snapshot.account.recoveryAuthority === ZERO_HASH
                      ? L("Not configured", "未配置")
                      : "0x" + snapshot.account.recoveryAuthority
                  }}
                </dd>
                <dt>{{ L("Recovery timelock", "恢复延迟") }}</dt>
                <dd>{{ timelockText(snapshot.account.recoveryTimelockMs) }}</dd>
                <dt>{{ L("Modules", "模块") }}</dt>
                <dd data-testid="native-module-counts">
                  {{ snapshot.modules.validators.length }}
                  {{ L("validators", "验证模块") }} ·
                  {{ snapshot.modules.hooks.length }}
                  {{ L("hooks", "策略模块") }}
                </dd>
                <dt>{{ L("Hook order", "策略顺序") }}</dt>
                <dd>{{ hookOrderText }}</dd>
                <dt>{{ L("Built-in route", "内置通道") }}</dt>
                <dd>
                  {{ L("operations", "操作") }}
                  {{
                    snapshot.account.defaultOperationAuthorization
                      ? L("on", "开")
                      : L("off", "关")
                  }}
                  · {{ L("messages", "消息") }}
                  {{
                    snapshot.account.defaultMessageAuthorization
                      ? L("on", "开")
                      : L("off", "关")
                  }}
                </dd>
                <dt>{{ L("Chain time", "链上时间") }}</dt>
                <dd>{{ time(snapshot.chainTime) }}</dd>
                <template v-if="snapshot.account.pendingRecovery">
                  <dt>{{ L("Pending recovery", "待生效恢复") }}</dt>
                  <dd class="mono">
                    0x{{ snapshot.account.pendingRecovery.newCustody }}<br />{{
                      time(snapshot.account.pendingRecovery.matureAt)
                    }}
                  </dd>
                </template>
              </dl>
            </div>
            <p class="small">
              {{ L("State and maturity use the chain time shown above. Refresh after waiting or submitting a transaction; this page does not advance maturity using your device clock.", "状态和到期判断使用上方链上时间。等待或提交交易后请刷新；本页不会按设备时钟推算到期。") }}
            </p>
            <button class="secondary" :disabled="busy || !profile" @click="loadAccount">
              {{ L("Refresh account and chain time", "刷新账户与链上时间") }}
            </button>
            <div v-if="snapshot.pending.length" class="callout" data-testid="native-pending-intents">
              <strong>{{ L("Pending configuration intents", "待生效配置意图") }}</strong>
              <p v-for="intent in snapshot.pending" :key="intent.intentId">
                #{{ intent.intentId }} · {{ L("matures", "成熟") }}
                {{ time(intent.matureAt) }} ·
                {{ intent.mature ? L("mature", "已成熟") : L("waiting", "等待中") }} ·
                {{
                  intent.expired
                    ? L("expired", "已过期")
                    : L("expires", "过期") + " " + time(intent.expiresAt)
                }}
              </p>
            </div>
            <h3>{{ L("Authority and recovery", "权限与恢复") }}</h3>
            <label
              >{{ L("Action", "操作")
              }}<select v-model="action" :aria-label="L('Action', '操作')">
                <option
                  v-for="item in NATIVE_ACTIONS"
                  :key="item.value"
                  :value="item.value"
                >
                  {{ item.label }}
                </option>
              </select></label
            >
            <p class="callout">{{ selectedAction.detail }}</p>
            <p v-if="action === 'freezeAccount'" class="callout" data-testid="native-freeze-risk">
              {{ L("Freezing advances the authority epoch: every pending signed operation and every pending configuration intent from before becomes invalid. Installed modules stay; custody can unfreeze through the custody route alone.", "冻结会推进权限代际：此前所有已签操作与待生效配置意图都会失效。已安装模块保留；托管方可通过托管通道单独解冻。") }}
            </p>
            <p v-if="action === 'executeRecovery'" class="small">
              {{ L("Completing recovery removes every module, pending intent and nonce cursor, advances the epoch and re-enables the built-in route. Any fee payer can submit it once mature.", "完成恢复会移除所有模块、待生效意图与 nonce 游标，推进权限代际并重新启用内置通道。成熟后任何付费者都可提交。") }}
            </p>
            <label v-if="selectedAction.recipient">{{ L("New custody (leave blank to retain custody)", "新托管地址（留空保留原托管方）") }}
              <input v-model.trim="actionAddress" spellcheck="false" placeholder="0x…" />
            </label>
            <label v-if="selectedAction.address"
              >{{ L("Recovery wallet address / script hash", "恢复钱包地址 / 脚本哈希") }}<input
                v-model.trim="actionAddress"
                spellcheck="false"
                placeholder="0x…"
            /></label>
            <label v-if="selectedAction.address">{{ L("Recovery delay (days)", "恢复延迟（天）") }}
              <input :placeholder="L('Keep current delay', '保留现有延迟')" v-model.number="policyDays" type="number" min="7" max="90" step="1" />
            </label>
            <p v-if="selectedAction.address" class="small">{{ L("Changing the recovery wallet requires signatures from both custody and the new wallet.", "更换恢复钱包需要托管方和新恢复钱包共同签署。") }}</p>
            <p v-if="actionBlocked" class="small">{{ actionBlocked }}</p>
            <button
              :disabled="
                busy ||
                !profile ||
                !!actionBlocked ||
                (selectedAction.address && !actionAddress)
              "
              @click="reviewAction"
            >
              {{ L("Review account action", "审核账户操作") }}
            </button>
            <p class="small">
              {{
                L(
                  "A pending recovery keeps the current custody in control until it is completed, so custody can still cancel it. Freezing is immediate containment; recovery is the delayed path for lost custody.",
                  "待生效恢复在完成前仍由当前托管方掌控，因此托管方仍可取消。冻结是即时控制手段；恢复是丢失托管权限后的延迟路径。",
                )
              }}
            </p>
          </template>
        </template>
        <template v-else-if="tab === 'create'">
          <h2>2. {{ L("Create an account", "创建账户") }}</h2>
          <p>
            {{
              L(
                "v4 identity is custody + salt. Registration may install the first validator atomically; every later module change is installModule or removeModule inside a signed script.",
                "v4 身份由托管地址与随机盐确定。注册可原子安装首个验证模块；之后每次模块变更都是已签名脚本里的 installModule 与 removeModule。",
              )
            }}
          </p>
          <label
            >{{
              L(
                "Custody Neo address / script hash",
                "托管 Neo 地址 / 脚本哈希",
              )
            }}<input
              v-model.trim="registration.custodyAddress"
              data-testid="native-custody"
              spellcheck="false"
              placeholder="N… or 0x…" /></label
          ><label
            >{{ L("Recovery timelock (days, 7–90)", "恢复延迟（天，7–90）") }}<input
              v-model.trim="registration.recoveryTimelockDays"
              data-testid="native-timelock"
              inputmode="numeric"
          /></label>
          <p class="small">
            {{
              L(
                "After creation, install a recovery seat and use Set recovery authority. Both custody and the new recovery wallet must approve.",
                "创建后，安装恢复模块，再选择设置恢复权限。托管钱包与新恢复钱包必须共同签署。",
              )
            }}
          </p><label
            >{{
              L(
                "Account salt (1–128 bytes, public)",
                "账户随机盐（1–128 字节，公开信息）",
              )
            }}<input
              v-model.trim="registration.salt"
              data-testid="native-salt"
              spellcheck="false" /></label
          ><button class="secondary" :disabled="busy" @click="generateSalt">
            {{ L("Generate new salt", "生成新的随机盐") }}
          </button>
          <details data-testid="native-initial-install">
            <summary>{{ L("Install the first validator atomically", "原子安装首个验证模块") }}</summary>
            <label>{{ L("Module contract hash", "模块合约哈希") }}<input v-model.trim="initialInstall.contractHash" spellcheck="false" placeholder="0x…" /></label>
            <label>{{ L("Module profile digest (32 bytes)", "模块配置摘要（32 字节）") }}<input v-model.trim="initialInstall.profileDigest" spellcheck="false" /></label>
            <label>{{ L("Module type", "模块类型") }}<select v-model="initialInstall.moduleType" :aria-label="L('Module type', '模块类型')">
              <option value="validator">{{ L("Validator", "验证模块") }}</option>
              <option value="hook">{{ L("Hook", "策略模块") }}</option>
              <option value="recovery">{{ L("Recovery seat", "恢复模块") }}</option>
            </select></label>
            <p class="small">{{ L("The built-in custody route stays active when you install a module. Review the installed validator before explicitly disabling that route.", "安装模块不会关闭内置托管通道。只有在核实新的验证模块后，才应显式关闭该通道。") }}</p>
          </details>
          <div v-if="derived" class="account-summary">
            <dl>
              <dt>{{ L("Account ID", "账户 ID") }}</dt>
              <dd class="mono">0x{{ derived.accountId }}</dd>
              <dt>{{ L("Funding address", "收款地址") }}</dt>
              <dd class="mono">
                {{ addressOf(derived.accountAddress) }}<br />0x{{
                  derived.accountAddress
                }}
              </dd>
            </dl>
          </div>
          <div class="actions">
            <button
              :disabled="!profile || busy || !derived"
              @click="reviewRegistration"
            >
              {{ L("Review registration", "审核注册") }}</button
            ><button
              class="secondary"
              :disabled="!profile || !derived || busy"
              @click="exportDescriptor"
            >
              {{ L("Save recovery descriptor", "保存恢复信息") }}
            </button>
          </div>
        </template>
        <template v-else-if="tab === 'modules'">
          <h2>2. {{ L("Modules", "模块") }}</h2>
          <p v-if="!snapshot?.account">
            {{
              L(
                "Load an account to read its installed modules.",
                "请先加载账户以读取已安装模块。",
              )
            }}
          </p>
          <template v-else>
            <p class="small" data-testid="native-module-admin">
              {{
                L(
                  "The core executes exactly two module actions: installModule and uninstallModule. A change is one action inside a signed script. The core keeps no proposal window — a change that matures for 24 hours belongs to a governance module.",
                  "核心只执行两个模块动作：installModule 与 uninstallModule。一次变更就是已签名脚本里的一个动作。核心没有提案窗口——需要 24 小时成熟的变更属于治理模块。",
                )
              }}
            </p>
            <h3>{{ L("Installed modules", "已安装模块") }}</h3>
            <p v-if="!installedModules.length" class="small">
              {{ L("No module is installed on this account.", "该账户没有安装任何模块。") }}
            </p>
            <dl v-else data-testid="native-modules">
              <template v-for="entry in installedModules" :key="entry.moduleId">
                <dt>{{ L("Module", "模块") }} #{{ entry.moduleId }}</dt>
                <dd>
                  {{ entry.moduleTypeName ?? entry.moduleType }} ·
                  {{ entry.contractHash }}
                </dd>
              </template>
            </dl>
            <h3>{{ L("Build one module action", "构建一个模块动作") }}</h3>
            <label
              >{{ L("Action", "动作")
              }}<select
                v-model="moduleDraft.kind"
                :aria-label="L('Action', '动作')"
              >
                <option value="install">installModule</option>
                <option value="uninstall">removeModule</option>
              </select></label
            >
            <template v-if="moduleDraft.kind === 'install'">
              <label
                >{{ L("Module type", "模块类型")
                }}<select
                  v-model="moduleDraft.moduleType"
                  :aria-label="L('Module type', '模块类型')"
                >
                  <option value="validator">{{ L("validator (1)", "验证器（1）") }}</option>
                  <option value="hook">{{ L("hook (4)", "钩子（4）") }}</option>
                  <option value="recovery">{{ L("recovery (5)", "恢复（5）") }}</option>
                </select></label
              >
              <label
                >{{ L("Module contract hash", "模块合约哈希")
                }}<input
                  v-model.trim="moduleDraft.contractHash"
                  spellcheck="false"
                  placeholder="0x…"
              /></label>
              <label
                >{{ L("Profile digest (32 bytes)", "配置摘要（32 字节）")
                }}<input
                  v-model.trim="moduleDraft.profileDigest"
                  spellcheck="false"
              /></label>
              <label
                >{{ L("Install data (byte list)", "安装数据（字节列表）")
                }}<input v-model.trim="moduleDraft.initData" spellcheck="false"
              /></label>
            </template>
            <template v-else>
              <label
                >{{ L("Module id", "模块 ID")
                }}<input
                  v-model.trim="moduleDraft.moduleId"
                  inputmode="numeric"
              /></label>
              <label
                >{{ L("Uninstall data (byte list)", "卸载数据（字节列表）")
                }}<input v-model.trim="moduleDraft.deInitData" spellcheck="false"
              /></label>
            </template>
            <button
              class="secondary"
              :disabled="busy"
              data-testid="native-build-module-action"
              @click="reviewModuleAction"
            >
              {{ L("Build the action", "构建动作") }}
            </button>
            <div
              v-if="moduleReview"
              class="callout"
              data-testid="native-module-action"
            >
              <strong>{{ moduleReview.description }}</strong>
              <p class="small">
                {{
                  L(
                    "This is one action. The core refuses every other action code with SA_OPERATION_MALFORMED, so it is submitted inside a script the SDK builds.",
                    "这是一个动作。核心对其他每个动作码都以 SA_OPERATION_MALFORMED 拒绝，因此它被放进由 SDK 构建的脚本里提交。",
                  )
                }}
              </p>
            </div>
          </template>
        </template>
        <template v-else>
          <h2>2. {{ L("Prepare a native operation", "准备原生业务操作") }}</h2>
          <p>
            {{
              L(
                "A v4 user operation carries its nonce, subkey, deadline, validator, credential generation, authority epoch, configuration nonce, signature and hook proofs. The proxy witness is the only signer executeUserOp accepts.",
                "v4 用户操作包含 nonce、子键、截止时间、验证模块、凭据代际、权限代际、配置 nonce、签名与策略证明。executeUserOp 只接受代理 witness。",
              )
            }}
          </p>
          <button class="secondary" :disabled="!snapshot || busy" @click="fillEnvelope">
            {{ L("Fill the envelope skeleton from chain state", "按链上状态填充信封骨架") }}
          </button>
          <label
            >{{ L("Operations (JSON array, 1–32)", "操作（JSON 数组，1–32 个）")
            }}<textarea v-model="operation.operations" rows="14" spellcheck="false" />
          </label>
          <p class="small">
            {{
              L(
                "Each operation needs targetContract, method, args, nonce, nonceSubkey, deadline, validatorId, credentialGeneration, authorityEpoch, configurationNonce, signature and hookProofs. Types: Null, Boolean, Integer, ByteString (hex), Array, Struct.",
                "每个操作需要 targetContract、method、args、nonce、nonceSubkey、deadline、validatorId、credentialGeneration、authorityEpoch、configurationNonce、signature 与 hookProofs。类型：Null、Boolean、Integer、ByteString（十六进制）、Array、Struct。",
              )
            }}
          </p>
          <p class="callout">
            {{
              L(
                "Native sponsorship is unavailable. A fee payer needs GAS. Execution needs an exact-script wallet or the SDK with the proxy witness; ordinary wallet invoke cannot safely submit it.",
                "原生赞助付费不可用，付费者需要 GAS。执行必须使用支持精确脚本和代理见证的钱包或 SDK，普通钱包 invoke 无法安全提交。",
              )
            }}
          </p>
          <p class="small">
            {{
              L(
                "Bounds: 32 operations per envelope · 64 arguments · 4,096 serialized bytes · 8,192 proof bytes · depth 8 · deadline within 1 hour.",
                "边界：每个信封 32 个操作 · 64 个参数 · 序列化 4,096 字节 · 证明 8,192 字节 · 深度 8 · 截止时间 1 小时内。",
              )
            }}
          </p>
          <button
            :disabled="
              !profile ||
              !snapshot ||
              snapshot.account.statusName !== 'Active' ||
              busy
            "
            @click="reviewOperation"
          >
            {{ L("Preview exact envelope", "预览精确信封") }}
          </button>
        </template>
      </section>
      <aside class="card review-card" aria-labelledby="review-title">
        <h2 id="review-title">
          3. {{ L("Review and authorize", "审核与授权") }}
        </h2>
        <label
          >{{
            L(
              "Fee payer Neo address / script hash",
              "付费者 Neo 地址 / 脚本哈希",
            )
          }}<input
            v-model.trim="feePayer"
            spellcheck="false"
            placeholder="N… or 0x…"
        /></label>
        <label v-if="tab !== 'operation'"
          >{{ L("Signing path", "签名路径") }}
          <select
            v-model="signingPath"
            :aria-label="L('Signing path', '签名路径')"
          >
            <option value="wallet-invoke">
              {{ L("Wallet invoke · management", "钱包 invoke · 管理操作") }}
            </option>
            <option value="native-sdk">
              {{ L("Native SDK · exact script", "原生 SDK · 精确脚本") }}
            </option>
          </select>
        </label>
        <button class="secondary" :disabled="busy" @click="useWallet">
          {{ L("Use connected Neo wallet", "使用已连接的 Neo 钱包") }}
        </button>
        <p class="small">
          {{
            L(
              "The fee payer pays network and system fees. Confirm actual transaction fees in the wallet.",
              "所选钱包承担网络费和系统费，实际费用请在钱包确认页核对。",
            )
          }}
        </p>
        <template v-if="review"
          ><div class="review-heading">
            <strong>{{ review.plan.method || "executeUserOp" }}</strong
            ><span
              class="pill"
              :class="{ verified: !review.simulationError }"
              >{{ review.simulation.state }}</span
            >
          </div>
          <p>{{ review.description }}</p>
          <dl>
            <dt>{{ L("Signing path", "签名路径") }}</dt>
            <dd>{{ review.submission }}</dd>
            <dt>{{ L("Network / protocol", "网络 / 协议") }}</dt>
            <dd>
              {{ review.profile.networkMagic }} /
              v{{ review.profile.protocolVersion }}
            </dd>
            <dt>{{ L("Account ID", "账户 ID") }}</dt>
            <dd class="mono">0x{{ review.plan.accountId }}</dd>
            <template v-if="review.plan.targetContract">
              <dt>{{ L("Recovery module", "恢复模块") }}</dt>
              <dd class="mono">0x{{ review.plan.targetContract }}</dd>
            </template>
            <dt>{{ L("Fee payer", "付费者") }}</dt>
            <dd class="mono">0x{{ review.feePayer }}</dd>
            <template v-if="review.authority">
              <dt>{{ L("Authority", "授权方") }}</dt>
              <dd class="mono" data-testid="native-reviewed-authority">0x{{ review.authority }}</dd>
            </template>
            <template v-if="review.newCustody">
              <dt>{{ L("New custody", "新托管方") }}</dt>
              <dd class="mono">{{ review.newCustody === ZERO_HASH ? L("Keep current custody", "保留现有托管方") : "0x" + review.newCustody }}</dd>
            </template>
            <template v-if="review.intentId">
              <dt>{{ L("Intent", "意图") }}</dt>
              <dd data-testid="native-reviewed-intent">
                #{{ review.intentId }} ·
                {{ (review.intentActions ?? []).length }} {{ L("actions", "个操作") }}
              </dd>
            </template>
            <dt>{{ L("Required authorities", "所需权限") }}</dt>
            <dd class="mono" data-testid="native-required-authorities">
              {{
                review.requiredAuthorities
                  .map((h) => "0x" + h)
                  .join(", ") ||
                L(
                  "Permissionless executor / hook proof",
                  "任何执行者 / 钩子证明",
                )
              }}
            </dd>
            <dt>{{ L("Signer scopes", "签名范围") }}</dt>
            <dd class="mono">
              {{
                review.signers
                  .map(
                    (s) =>
                      s.account + " · " + s.scopes +
                      (s.allowedcontracts?.length
                        ? " · " + s.allowedcontracts.join(", ")
                        : ""),
                  )
                  .join(" / ")
              }}
            </dd>
            <dt>{{ L("Application consumption", "应用执行消耗") }}</dt>
            <dd data-testid="native-application-consumption">
              {{ formatGas(review.simulation.gasConsumed) }}
            </dd>
            <dt>{{ L("Minimum system fee budget", "最低系统费预算") }}</dt>
            <dd data-testid="native-minimum-system-fee">{{ formatGas(review.simulation.minimumRequiredFee) }}</dd>
            <dt>{{ L("Network fee", "网络费") }}</dt>
            <dd>{{ signedTransaction ? formatGas(signedTransaction.fees.network) : L("Not quoted; confirm in wallet or SDK", "尚未报价；请在钱包或 SDK 核对") }}</dd>
            <dt>{{ L("Script bytes", "脚本字节数") }}</dt>
            <dd>{{ review.plan.script.length / 2 }}</dd>
          </dl>
          <p class="small">{{ L("Consumption is not the admission budget or total transaction fee. Bounded module callbacks can require a larger system fee budget. Confirm final system and network fees before signing.", "执行消耗并非准入预算或交易总费用。有限额的模块回调可能要求更高系统费预算；签名前请核对最终系统费与网络费。") }}</p>
          <div v-if="review.plan.operations" class="small mono">
            <p v-for="(entry, index) in review.plan.operations" :key="index">
              {{ entry.method }} · 0x{{ entry.targetContract
              }}<br />Nonce {{ entry.nonce }} ·
              {{ time(entry.deadline) }}
            </p>
          </div>
          <div v-if="review.simulationError" role="alert" class="notice error">
            {{ review.simulationError }}
          </div>
          <details>
            <summary>
              {{
                L(
                  "Exact script, signer scopes and request",
                  "精确脚本、签名范围及请求",
                )
              }}
            </summary>
            <p class="small">
              {{ L("Simulation consumption", "模拟消耗") }}:
              {{ review.simulation.gasConsumed ?? "—" }} datoshi
            </p>
            <pre>{{ jsonText(review) }}</pre>
          </details>
          <label class="check"
            ><input v-model="accepted" type="checkbox" :disabled="busy" />{{
              L(
                "I reviewed the network, authority, target, scope and fee payer.",
                "我已核对网络、权限、目标、范围和付费者。",
              )
            }}</label
          >
          <label v-if="review.plan.method === 'freezeAccount'" class="check" data-testid="native-freeze-acknowledgement">
            <input v-model="freezeAccepted" type="checkbox" :disabled="busy" />
            {{ L("I understand freezing advances the authority epoch: every pending operation and pending configuration intent becomes invalid.", "我已了解冻结会推进权限代际：所有待生效操作与待生效配置意图都会失效。") }}
          </label>
          <div class="actions">
            <button
              :disabled="
                !accepted ||
                (review.plan.method === 'freezeAccount' && !freezeAccepted) ||
                busy ||
                !review.walletSupported ||
                !!review.simulationError ||
                submitted
              "
              @click="sendToWallet"
            >
              {{ L("Send to wallet for approval", "交给钱包确认") }}</button
            ><button
              class="secondary"
              :disabled="!accepted || (review.plan.method === 'freezeAccount' && !freezeAccepted) || busy"
              @click="exportRequest"
            >
              {{ L("Export reviewed request", "导出审核请求") }}
            </button>
          </div>
          <p v-if="!review.walletSupported" class="callout">
            {{
              L(
                "This plan needs the exact script the node simulated: a configuration intent, an execution envelope, a multi-authority action or a plan the owner pinned to the SDK. A wallet invoke would rebuild the call and lose that binding, so export the request and sign the exact transaction with the native SDK.",
                "此计划必须保留节点模拟的精确脚本：配置意图、执行信封、多权限操作，或所有者指定走 SDK 的计划。钱包 invoke 会重新组装调用并丢失这一绑定，请导出请求并使用原生 SDK 签署精确交易。",
              )
            }}
          </p>
          <section v-if="review.submission === 'native-sdk'" class="callout" data-testid="native-signed-import">
            <h3>{{ L("Import and submit a signed transaction", "导入并提交已签交易") }}</h3>
            <p>{{ L("Export this review, sign its exact transaction with your existing wallet through the native SDK, then exportSignedTransaction. Import that file here. Keys remain in your wallet; this page does not request them.", "请导出本次审核，使用现有钱包通过原生 SDK 签署精确交易，再调用 exportSignedTransaction 导出文件并在此导入。密钥保留在钱包中，本页不会索取。") }}</p>
            <p>{{ L("Set all three maximum fees before importing. These limits validate the signed fees; they do not change the transaction.", "导入前请明确三项费用上限。这些上限仅用于核对已签费用，不会修改交易。") }}</p>
            <label>{{ L("Maximum system fee (GAS)", "最高系统费（GAS）") }}<input v-model.trim="feeLimits.system" inputmode="decimal" :disabled="busy || signedAttempted" /></label>
            <label>{{ L("Maximum network fee (GAS)", "最高网络费（GAS）") }}<input v-model.trim="feeLimits.network" inputmode="decimal" :disabled="busy || signedAttempted" /></label>
            <label>{{ L("Maximum total fee (GAS)", "最高总费用（GAS）") }}<input v-model.trim="feeLimits.total" inputmode="decimal" :disabled="busy || signedAttempted" /></label>
            <label>{{ L("Import signed transaction file", "导入已签交易文件") }}<input type="file" accept="application/json,.json" :disabled="busy || signedAttempted" @change="importSignedTransaction" /></label>
            <p v-if="signedTransaction && signedFileName" class="small">{{ L("Imported", "已导入") }}: {{ signedFileName }}</p>
            <template v-if="signedTransaction">
              <dl>
                <dt>{{ L("Transaction hash", "交易哈希") }}</dt><dd class="mono">{{ signedTransaction.txid }}</dd>
                <dt>{{ L("Signed system fee", "已签系统费") }}</dt><dd>{{ formatGas(signedTransaction.fees.system) }}</dd>
                <dt>{{ L("Signed network fee", "已签网络费") }}</dt><dd>{{ formatGas(signedTransaction.fees.network) }}</dd>
                <dt>{{ L("Signed total fee", "已签总费用") }}</dt><dd>{{ formatGas(signedTransaction.fees.total) }}</dd>
                <dt>{{ L("Valid until block", "有效截止区块") }}</dt><dd>{{ signedTransaction.transaction.validUntilBlock }}</dd>
              </dl>
              <button class="secondary" :disabled="busy || signedAttempted" @click="preflightSignedTransaction">{{ L("Check signed transaction", "预检已签交易") }}</button>
              <p v-if="signedPreflight" data-testid="native-signed-preflight">{{ L("Signatures and execution passed at snapshot block", "签名与执行预检通过，快照区块") }} {{ signedPreflight.snapshot.height }}. {{ L("This is not chain confirmation. Submission checks again using fresh state.", "这不代表链上确认。提交前会使用最新状态再次预检。") }}</p>
              <label class="check"><input v-model="signedAccepted" type="checkbox" :disabled="busy || signedAttempted" />{{ L("I approve these exact signed fees and this transaction hash for broadcast.", "我同意广播此交易哈希对应的交易，并接受上述已签费用。") }}</label>
              <button :disabled="busy || signedAttempted || !signedPreflight || !signedAccepted || !accepted || (review.plan.method === 'freezeAccount' && !freezeAccepted)" @click="broadcastSignedTransaction">{{ L("Broadcast signed transaction", "广播已签交易") }}</button>
              <p v-if="signedAttempted">{{ L("Submission was attempted for this hash. Check confirmation; this page will not resend it automatically.", "已尝试提交此哈希对应的交易。请检查确认状态，本页不会自动重发。") }}</p>
              <button class="secondary" :disabled="busy" @click="confirmSignedTransaction">{{ L("Check imported transaction confirmation", "检查导入交易的确认状态") }}</button>
            </template>
          </section>
          <label
            >{{
              L(
                "Submitted transaction hash (optional)",
                "已提交交易哈希（可选）",
              )
            }}<input
              v-model.trim="txid"
              :disabled="busy"
              spellcheck="false" /></label
          ><button
            class="secondary"
            :disabled="busy || !txid"
            @click="confirmTransaction"
          >
            {{ L("Check chain confirmation", "检查链上确认") }}
          </button>
          <p class="small">
            {{
              L(
                "A wallet response is not confirmation. Check the exact script and application result on this node.",
                "钱包返回不代表链上成功。请检查当前节点上的精确脚本和执行结果。",
              )
            }}
          </p></template
        >
        <div v-else class="empty-review">
          <span aria-hidden="true">◎</span>
          <h3>{{ L("Your review appears here", "审核内容将显示在这里") }}</h3>
          <p>
            {{
              L(
                "Verify a node and preview a task. Loading and previewing never request a signature.",
                "验证节点并预览任务。加载和预览不会请求签名。",
              )
            }}
          </p>
        </div>
      </aside>
    </div>
  </div>
</template>
<script setup>
import {
  computed,
  onBeforeUnmount,
  reactive,
  ref,
  shallowRef,
  watch,
} from "vue";
import { useI18n } from "../../i18n/index.js";
import { RUNTIME_CONFIG } from "../../config/runtimeConfig.js";
import { walletService } from "../../services/walletService.js";
import { getAddressFromScriptHash } from "../../utils/neo.js";
import {
  createNativeWorkspace,
  createNativeWalletAdapter,
  nativeCodec,
  nativeAddress,
  nativeGasLimit,
  ZERO_HASH,
  NATIVE_ACTIONS,
  NATIVE_PROXY_CALL_FLAGS,
  MAX_OPERATIONS_PER_ENVELOPE,
  actionBlockReason,
  buildRecoveryDescriptor,
  readRecoveryDescriptor,
  describeConfigurationAction,
  installModuleAction,
  uninstallModuleAction,
  jsonText,
} from "./nativeWorkspace.js";
const { locale } = useI18n();
const L = (en, zh) => (locale.value === "zh-CN" ? zh : en);
const endpoint = ref(RUNTIME_CONFIG.rpcUrl),
  network = ref(String(RUNTIME_CONFIG.networkMagic)),
  profile = shallowRef(null),
  snapshot = shallowRef(null),
  inspected = shallowRef(null),
  review = shallowRef(null),
  signedTransaction = shallowRef(null),
  signedPreflight = shallowRef(null),
  restoredTransaction = shallowRef(null);
const tab = ref("account"),
  busy = ref(false),
  error = ref(""),
  notice = ref(""),
  accepted = ref(false),
  freezeAccepted = ref(false),
  signedAccepted = ref(false),
  signedAttempted = ref(false),
  signedFileName = ref(""),
  submitted = ref(false),
  txid = ref(""),
  feePayer = ref(""),
  signingPath = ref("wallet-invoke"),
  accountId = ref("");
const feeLimits = reactive({ system: "", network: "", total: "" });
const receiptFiles = reactive({ review: "", artifact: "", reviewName: "", artifactName: "" });
let signedInputVersion = 0;
const registration = reactive({
  custodyAddress: "",
  recoveryTimelockDays: "7",
  salt: "",
});
const initialInstall = reactive({
  moduleType: "validator",
  contractHash: "",
  profileDigest: "",
});
const draft = reactive({
  kind: "install",
  moduleType: "validator",
  contractHash: "",
  profileDigest: "",
  moduleId: "1",
  hookIds: "",
  policyId: "0",
  threshold: "2",
  memberIds: "",
  active: true,
  operationAuthorization: true,
  messageAuthorization: true,
  recoveryAuthority: "",
  timelockDays: "7",
  ownerOnly: false,
});
const draftActions = ref([]);
const operation = reactive({
  operations: "[]",
});
const action = ref("freezeAccount"),
  actionAddress = ref(""), policyDays = ref("");
const workspace = createNativeWorkspace({
  wallet: createNativeWalletAdapter(walletService),
});
const tabs = [
  { id: "account", en: "Account & recovery", zh: "账户与恢复" },
  { id: "create", en: "Create account", zh: "创建账户" },
  { id: "modules", en: "Modules", zh: "模块" },
  { id: "operation", en: "Native operation", zh: "原生操作" },
];
const selectedAction = computed(() =>
  NATIVE_ACTIONS.find((a) => a.value === action.value),
);
const actionBlocked = computed(() =>
  actionBlockReason(snapshot.value?.account, action.value),
);
const modules = computed(() =>
  snapshot.value
    ? [...snapshot.value.modules.validators, ...snapshot.value.modules.hooks]
    : [],
);
const hookOrderText = computed(() => {
  const ids = snapshot.value?.hookOrder.hookIds ?? [];
  return ids.length ? ids.join(" → ") : L("none", "无");
});
const derived = computed(() => {
  try {
    if (!profile.value) return null;
    return nativeCodec.deriveIdentity({
      custodyAddress: nativeAddress(registration.custodyAddress),
      salt: registration.salt,
      coreContractHash: profile.value.contract,
      callFlags: NATIVE_PROXY_CALL_FLAGS,
    });
  } catch {
    return null;
  }
});
function addressOf(hash) {
  try {
    return getAddressFromScriptHash(hash);
  } catch {
    return "";
  }
}
function timelockText(value) {
  const days = Number(value) / 86400000;
  if (!Number.isFinite(days)) return String(value) + " ms";
  return L(`${days} days`, `${days} 天`);
}
function formatGas(value) {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value))
    return L("Unavailable", "不可用");
  const amount = BigInt(value),
    whole = amount / 100000000n,
    fraction = (amount % 100000000n)
      .toString()
      .padStart(8, "0")
      .replace(/0+$/, "");
  return whole.toString() + (fraction ? "." + fraction : "") + " GAS";
}
function time(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n <= 8640000000000000
    ? new Date(n).toISOString()
    : String(value) + " ms";
}
function clearReview() {
  notice.value = "";
  review.value = null;
  workspace.clearReview();
  accepted.value = false;
  freezeAccepted.value = false;
  submitted.value = false;
  txid.value = "";
  clearSignedTransaction();
}
function clearSignedTransaction() {
  signedInputVersion++;
  workspace.clearImported();
  signedTransaction.value = null;
  signedPreflight.value = null;
  signedAccepted.value = false;
  signedAttempted.value = false;
  signedFileName.value = "";
}
watch(feeLimits, clearSignedTransaction, { flush: "sync" });
function invalidate() {
  workspace.invalidate();
  profile.value = null;
  snapshot.value = null;
  inspected.value = null;
  clearReview();
  restoredTransaction.value = null;
  notice.value = "";
}
watch([endpoint, network], invalidate, { flush: "sync" });
watch(
  txid,
  () => {
    notice.value = "";
  },
  { flush: "sync" },
);
watch(
  [
    () => ({ ...registration }),
    () => ({ ...initialInstall }),
    () => ({ ...draft }),
    draftActions,
    () => ({ ...operation }),
    action,
    actionAddress,
    policyDays,
    feePayer,
    signingPath,
    tab,
  ],
  clearReview,
  { flush: "sync" },
);
watch(action, () => { actionAddress.value = ""; policyDays.value = ""; }, { flush: "sync" });
watch(
  accountId,
  () => {
    snapshot.value = null;
    inspected.value = null;
    draftActions.value = [];
    clearReview();
  },
  { flush: "sync" },
);
function walletChanged() {
  invalidate();
  notice.value = L(
    "Wallet changed. Verify the node and review again.",
    "钱包已切换，请重新验证节点并审核。",
  );
}
const walletEvents = [
  "NEOLine.NEO.EVENT.ACCOUNT_CHANGED",
  "Neo.DapiProvider.ACCOUNT_CHANGED",
  "NEOLine.NEO.EVENT.NETWORK_CHANGED",
  "Neo.DapiProvider.NETWORK_CHANGED",
];
for (const event of walletEvents) window.addEventListener(event, walletChanged);
onBeforeUnmount(() => {
  for (const event of walletEvents)
    window.removeEventListener(event, walletChanged);
  workspace.invalidate();
});
async function run(fn) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
  } catch (e) {
    if (!workspace.profile) {
      profile.value = null;
      snapshot.value = null;
      inspected.value = null;
      restoredTransaction.value = null;
      workspace.clearArchived();
      clearReview();
    }
    error.value = String(e.message || "Request failed.").slice(0, 400);
  } finally {
    busy.value = false;
  }
}
async function connectNode() {
  await run(async () => {
    clearReview();
    snapshot.value = null;
    inspected.value = null;
    profile.value = null;
    restoredTransaction.value = null;
    profile.value = await workspace.connect({
      rpcUrl: endpoint.value,
      networkMagic: network.value,
    });
    notice.value = L(
      "Node answered the v4 native profile, ABI and implementation id.",
      "节点已返回 v4 原生配置、ABI 与实现 ID。",
    );
  });
}
async function loadAccount() {
  await run(async () => {
    clearReview();
    inspected.value = null;
    snapshot.value = await workspace.load(accountId.value);
    if (!feePayer.value) feePayer.value = snapshot.value.account.custodyAddress;
    notice.value = L(
      "Account loaded from the selected node.",
      "账户已从验证节点加载。",
    );
  });
}
function generateSalt() {
  registration.salt = nativeCodec.bytesToHex(
    crypto.getRandomValues(new Uint8Array(32)),
  );
}
generateSalt();
async function useWallet() {
  await run(async () => {
    await walletService.connect();
    const wallet = createNativeWalletAdapter(walletService);
    const actor = await wallet.account();
    const magic = await wallet.network();
    if (profile.value && magic !== profile.value.networkMagic)
      throw Error(
        L(
          "Wallet network does not match this node.",
          "钱包网络与当前节点不匹配。",
        ),
      );
    feePayer.value = actor;
    if (!registration.custodyAddress) registration.custodyAddress = actor;
    notice.value = L(
      "Live wallet identity checked. No transaction was signed.",
      "已读取钱包身份，未签署交易。",
    );
  });
}
function setReview(value) {
  clearSignedTransaction();
  review.value = value;
  accepted.value = false;
  freezeAccepted.value = false;
  submitted.value = false;
  txid.value = "";
}
async function reviewRegistration() {
  await run(async () => {
    const actions =
      initialInstall.contractHash && initialInstall.profileDigest
        ? [
            installModuleAction({
              moduleType: initialInstall.moduleType,
              contractHash: initialInstall.contractHash,
              profileDigest: initialInstall.profileDigest,
            }),
          ]
        : [];
    setReview(
      await workspace.registration({
        custodyAddress: registration.custodyAddress,
        salt: registration.salt,
        recoveryTimelockDays: registration.recoveryTimelockDays,
        actions,
        submission: signingPath.value,
        feePayer: feePayer.value,
      }),
    );
  });
}
async function reviewAction() {
  await run(async () =>
    setReview(
      await workspace.lifecycle({
        accountId: accountId.value,
        action: action.value,
        submission: signingPath.value,
        newCustody: selectedAction.value?.recipient ? actionAddress.value : undefined,
        recoveryAuthority: selectedAction.value?.address ? actionAddress.value : undefined,
        recoveryTimelockMs: selectedAction.value?.address && policyDays.value !== "" ? String(policyDays.value * 86400000) : undefined,
        feePayer: feePayer.value,
      }),
    ),
  );
}
const moduleDraft = reactive({
  kind: "install",
  moduleType: "validator",
  contractHash: "",
  profileDigest: "",
  initData: "",
  moduleId: "",
  deInitData: "",
});
const moduleReview = shallowRef(null);
const installedModules = computed(() => [
  ...(snapshot.value?.modules?.validators ?? []),
  ...(snapshot.value?.modules?.hooks ?? []),
  ...(snapshot.value?.modules?.recovery ?? []),
]);
const numberList = (text) => String(text).split(/[\s,]+/).filter(Boolean);
function buildModuleAction() {
  return moduleDraft.kind === "install"
    ? installModuleAction({
        moduleType: moduleDraft.moduleType,
        contractHash: moduleDraft.contractHash,
        profileDigest: moduleDraft.profileDigest,
        initData: numberList(moduleDraft.initData).map(Number),
      })
    : uninstallModuleAction({
        moduleId: moduleDraft.moduleId,
        deInitData: numberList(moduleDraft.deInitData).map(Number),
      });
}
function reviewModuleAction() {
  const action = buildModuleAction();
  moduleReview.value = {
    action,
    description: describeConfigurationAction(action),
  };
}
async function reviewOperation() {
  await run(async () => {
    let operations;
    try {
      operations = JSON.parse(operation.operations);
    } catch {
      throw Error(L("Operations must be a JSON array.", "操作必须是 JSON 数组。"));
    }
    if (
      !Array.isArray(operations) ||
      !operations.length ||
      operations.length > MAX_OPERATIONS_PER_ENVELOPE
    )
      throw Error(
        L(
          `An execution envelope carries 1 to ${MAX_OPERATIONS_PER_ENVELOPE} operations.`,
          `执行信封包含 1 到 ${MAX_OPERATIONS_PER_ENVELOPE} 个操作。`,
        ),
      );
    setReview(
      await workspace.operation({
        accountId: accountId.value,
        operations,
        feePayer: feePayer.value,
      }),
    );
  });
}
function fillEnvelope() {
  const account = snapshot.value?.account;
  if (!account) return;
  // Route the skeleton at a real validator when the account has one: the
  // instance's CredentialGeneration is published by getModule, so the draft
  // carries a reviewed value instead of a guess. With no installed validator
  // the built-in route is in use and its generation is the account's 0x57
  // SubjectRevision, which the kernel does not publish -- the field stays null
  // so the builder refuses the envelope until it is filled in.
  const validator = snapshot.value?.modules?.validators?.[0] ?? null;
  operation.operations = JSON.stringify(
    [
      {
        targetContract: "00".repeat(20),
        method: "transfer",
        args: [],
        nonce: "1",
        nonceSubkey: "00".repeat(32),
        deadline: String(snapshot.value.chainTime + 3600000),
        validatorId: validator ? String(validator.moduleId) : "0",
        credentialGeneration: validator
          ? String(validator.credentialGeneration)
          : null,
        authorityEpoch: account.authorityEpoch,
        configurationNonce: account.configurationNonce,
        signature: "",
        hookProofs: [],
      },
    ],
    null,
    2,
  );
  notice.value = validator
    ? L(
        "Skeleton filled with the live epoch, configuration nonce and the installed validator's credential generation. Replace the target, arguments, nonce and signature.",
        "已按实时权限代际、配置 nonce 与已安装验证器的凭证代际填充骨架。请替换目标、参数、nonce 与签名。",
      )
    : L(
        "Skeleton filled with the live epoch and configuration nonce. The built-in route's credential generation is the account SubjectRevision, which the kernel does not publish: read it from the account's 0x57 subject record and replace the null before signing.",
        "已按实时权限代际与配置 nonce 填充骨架。内置通道的凭证代际即账户 SubjectRevision，合约并不对外发布该值：请从账户 0x57 subject 记录读取后替换 null，再行签名。",
      );
}
function download(name, value) {
  const url = URL.createObjectURL(
    new Blob([jsonText(value)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportDescriptor() {
  run(async () => {
    const descriptor = buildRecoveryDescriptor({
      networkMagic: profile.value.networkMagic,
      contract: profile.value.contract,
      custodyAddress: registration.custodyAddress,
      salt: registration.salt,
      recoveryTimelockMs: String(
        Math.round(Number(registration.recoveryTimelockDays) * 86400000),
      ),
    });
    download(
      "neo-native-account-" + descriptor.accountId + ".json",
      descriptor,
    );
    notice.value = L(
      "Public descriptor saved. Back up wallet keys separately.",
      "公开恢复信息已保存，请另行备份钱包私钥。",
    );
  });
}
async function importDescriptor(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  await run(async () => {
    if (file.size > 16384) throw Error("Descriptor exceeds 16 KiB.");
    if (!profile.value)
      throw Error(
        L(
          "Verify the native node before importing a descriptor.",
          "请先验证原生节点，再导入恢复信息。",
        ),
      );
    const reviewedProfile = profile.value;
    const text = await file.text();
    if (profile.value !== reviewedProfile || !workspace.profile)
      throw Error(
        L(
          "Network changed during descriptor import. Select the file again after verification.",
          "导入过程中网络已改变，请验证后重新选择恢复文件。",
        ),
      );
    const descriptor = readRecoveryDescriptor(text, reviewedProfile);
    registration.custodyAddress = descriptor.custodyAddress;
    registration.salt = descriptor.salt;
    registration.recoveryTimelockDays = String(
      Number(descriptor.recoveryTimelockMs) / 86400000,
    );
    accountId.value = descriptor.accountId;
    notice.value = L(
      "Descriptor identity verified. Load the account; wallet keys are still required.",
      "恢复身份已验证。请加载账户，操作仍需要钱包私钥。",
    );
  });
}
async function sendToWallet() {
  await run(async () => {
    const result = await workspace.submit(review.value);
    submitted.value = true;
    txid.value = result.txid || result.tx || result.hash || "";
    notice.value = L(
      "Sent to wallet. Check chain confirmation before treating the change as complete.",
      "已交给钱包，请检查链上确认后再视为完成。",
    );
  });
}
async function exportRequest() {
  await run(async () => {
    download(
      "neo-native-reviewed-request.json",
      await workspace.exportReview(review.value),
    );
    notice.value = L(
      "Reviewed request exported. It is not a signed transaction.",
      "已导出审核请求，此文件不是已签名交易。",
    );
  });
}
async function confirmTransaction() {
  await run(async () => {
    await workspace.confirm(review.value, txid.value);
    notice.value = L(
      "Reviewed script and authorities confirmed with HALT. Reload the account for current state.",
      "审核的脚本与权限已确认且执行 HALT，请重新加载账户查看当前状态。",
    );
  });
}
async function importSignedTransaction(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  await run(async () => {
    clearSignedTransaction();
    if (file.size > 1048576) throw Error(L("Signed transaction file exceeds 1 MiB.", "已签交易文件超过 1 MiB。"));
    const current = review.value;
    const inputVersion = signedInputVersion;
    const caps = {
      maxSystemFee: nativeGasLimit(feeLimits.system),
      maxNetworkFee: nativeGasLimit(feeLimits.network),
      maxTotalFee: nativeGasLimit(feeLimits.total),
    };
    const text = await file.text();
    if (review.value !== current || inputVersion !== signedInputVersion) throw Error(L("Review or fee limits changed while reading the file. Import again.", "读取文件期间审核或费用上限已改变，请重新导入。"));
    signedTransaction.value = await workspace.importSigned(current, text, caps);
    signedFileName.value = file.name;
    notice.value = L("Signed bytes, signatures, network, authorities and fees match this review. Check the signed transaction before broadcasting.", "已签字节、签名、网络、权限和费用与本次审核匹配。广播前请预检已签交易。" );
  });
}
async function preflightSignedTransaction() {
  await run(async () => {
    signedPreflight.value = null;
    signedAccepted.value = false;
    signedPreflight.value = await workspace.preflightSigned(signedTransaction.value);
  });
}
async function broadcastSignedTransaction() {
  await run(async () => {
    const transaction = signedTransaction.value;
    try {
      await workspace.broadcastSigned(transaction);
      if (signedTransaction.value !== transaction) throw Object.assign(Error(L("Review changed after submission. Check transaction ", "提交后审核已改变，请检查交易 ") + transaction.txid), { submissionAttempted: true, txid: transaction.txid });
      signedAttempted.value = true;
      submitted.value = true;
      txid.value = transaction.txid;
      notice.value = L("Exact signed transaction submitted. Check its chain confirmation.", "已提交精确的已签交易，请检查链上确认。" );
    } catch (cause) {
      if (cause.submissionAttempted) {
        if (signedTransaction.value === transaction) {
          signedAttempted.value = true;
          submitted.value = true;
          txid.value = transaction.txid;
        }
        throw Error(L("Submission result is uncertain. Do not create a replacement yet; check transaction ", "提交结果尚不确定。请勿立即创建替代交易，先检查交易 ") + (cause.txid || transaction.txid));
      }
      throw cause;
    }
  });
}
async function confirmSignedTransaction() {
  await run(async () => {
    const receipt = await workspace.confirmSigned(signedTransaction.value);
    showSignedReceipt(receipt);
  });
}
function showSignedReceipt(receipt) {
  if (!receipt.confirmed) {
    notice.value = L("This transaction is not confirmed on the selected node yet.", "所选节点尚未确认此交易。");
  } else if (!receipt.succeeded) {
    throw Error(L("The exact transaction is confirmed but execution failed: ", "精确交易已上链，但执行失败：") + (receipt.failures?.join("; ") || receipt.exception || receipt.vmState));
  } else {
    notice.value = L("The exact signed bytes are confirmed and execution succeeded. Refresh the account for current state.", "精确的已签字节已确认且执行成功，请刷新账户查看当前状态。");
  }
}
async function readReceiptFile(kind, event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  await run(async () => {
    restoredTransaction.value = null;
    workspace.clearArchived();
    receiptFiles[kind] = "";
    receiptFiles[kind + "Name"] = "";
    if (file.size > 1048576) throw Error(L("Receipt file exceeds 1 MiB.", "回执文件超过 1 MiB。"));
    receiptFiles[kind] = await file.text();
    receiptFiles[kind + "Name"] = file.name;
  });
}
async function restoreReceipt() {
  await run(async () => {
    restoredTransaction.value = null;
    restoredTransaction.value = await workspace.restoreReceipt(receiptFiles.review, receiptFiles.artifact);
    notice.value = L("Receipt files verified for read-only confirmation. No transaction can be submitted from this import.", "回执文件已核对，仅可用于只读确认。此次导入无法提交交易。" );
  });
}
async function confirmRestoredReceipt() {
  await run(async () => showSignedReceipt(await workspace.confirmRestoredReceipt(restoredTransaction.value)));
}
</script>
<style scoped>
.native-workspace {
  max-width: 1240px;
  margin: auto;
  padding: 36px 24px 64px;
  color: #172033;
  font-size: 14px;
  line-height: 1.55;
}
.receipt-restore { margin-bottom: 24px; }
.native-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
  margin-bottom: 26px;
}
.native-heading h1 {
  font-size: 34px;
  font-weight: 700;
  letter-spacing: -0.04em;
  margin: 3px 0 8px;
}
.native-heading p {
  color: #58657b;
  margin: 0;
}
.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
}
.pill {
  display: inline-flex;
  border: 1px solid #d8dde5;
  background: #f3f5f8;
  padding: 5px 11px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
  color: #58657b;
}
.pill.verified {
  background: #e9f6ee;
  border-color: #b7d9c3;
  color: #24593a;
}
.card {
  border: 1px solid #dbe1ea;
  border-radius: 16px;
  padding: 24px;
  background: #fff;
  box-shadow: 0 2px 6px #14203604;
}
.card h2 {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.015em;
  margin: 0 0 10px;
}
.card h3 {
  font-size: 14px;
  font-weight: 700;
  margin: 22px 0 12px;
}
.card p {
  margin: 8px 0 16px;
  color: #59667b;
}
.endpoint-card {
  margin-bottom: 16px;
}
.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.endpoint-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 190px auto;
  gap: 14px;
  align-items: end;
}
.native-workspace label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  margin: 14px 0;
  color: #42516a;
}
.native-workspace input:not([type="checkbox"]):not([type="file"]),
.native-workspace select,
.native-workspace textarea {
  border: 1px solid #cbd5e1;
  background: #fff;
  color: #18253d;
  border-radius: 8px;
  padding: 10px 11px;
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
}
.native-workspace input:focus,
.native-workspace select:focus,
.native-workspace textarea:focus {
  outline: 2px solid #2157a8;
  outline-offset: 2px;
}
.native-workspace button,
.file-button {
  background: #172d4c;
  border: 1px solid #172d4c;
  border-radius: 8px;
  color: white;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: normal;
}
.native-workspace button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.native-workspace button:hover:enabled {
  filter: brightness(1.12);
}
.native-workspace button:focus-visible,
.file-button:focus-within {
  outline: 2px solid #2157a8;
  outline-offset: 3px;
}
.native-workspace button.secondary,
.file-button {
  color: #26446b;
  background: white;
  border-color: #cbd5e1;
}
.endpoint-fields button {
  margin-bottom: 14px;
}
.small {
  font-size: 11px;
  line-height: 1.6;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.callout {
  background: #f2f6fb;
  border-left: 3px solid #7790b2;
  border-radius: 0 7px 7px 0;
  padding: 12px 14px;
  font-size: 12px;
  color: #405773 !important;
}
.notice {
  padding: 12px 16px;
  border-radius: 9px;
  margin: 12px 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.notice.error {
  background: #fff1f0;
  border: 1px solid #e9b9b3;
  color: #8d2d28;
}
.notice.success {
  background: #edf8f0;
  border: 1px solid #c5dfce;
  color: #285d38;
}
.tabs {
  display: flex;
  gap: 6px;
  padding: 5px;
  background: #eaf0f6;
  border: 1px solid #dee6ef;
  border-radius: 10px;
  margin: 24px 0 18px;
  overflow-x: auto;
}
.tabs button {
  background: transparent;
  color: #4e6079;
  border: 0;
  flex: 1;
  white-space: nowrap;
}
.tabs button[aria-pressed="true"] {
  background: white;
  color: #172d4c;
  box-shadow: 0 1px 5px #1d3d6020;
}
.columns {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
  gap: 20px;
  align-items: start;
}
.card dl {
  display: grid;
  grid-template-columns: 135px minmax(0, 1fr);
  gap: 10px;
  font-size: 12px;
  margin: 14px 0;
}
.card dt {
  color: #66748a;
}
.card dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.account-summary {
  border: 1px solid #dce5ef;
  border-radius: 10px;
  background: #f8fafc;
  padding: 14px;
  margin: 20px 0;
}
.summary-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}
.summary-top strong {
  color: #235b3a;
}
.summary-top span {
  color: #67768b;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 18px 0;
}
.actions .file-button {
  margin: 0;
}
.file-button {
  position: relative;
  display: inline-flex !important;
  overflow: hidden;
}
.file-button input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  width: 100%;
}
.native-workspace label.check {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 10px;
  font-weight: 400;
  font-size: 12px;
}
.check input {
  width: 16px;
  height: 16px;
  flex: none;
  margin: 2px 0 0;
  accent-color: #244973;
}
.review-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 24px 0 10px;
}
.review-heading strong {
  font-family: ui-monospace, monospace;
  font-size: 15px;
  overflow-wrap: anywhere;
}
.empty-review {
  text-align: center;
  padding: 56px 22px;
  color: #789;
}
.empty-review span {
  font-size: 40px;
  color: #94a5bb;
}
.empty-review h3 {
  margin-top: 12px !important;
}
.empty-review p {
  font-size: 12px;
}
.native-workspace details {
  border: 1px solid #dbe1ea;
  border-radius: 8px;
  margin: 18px 0;
  padding: 12px;
  min-width: 0;
}
.native-workspace summary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
.native-workspace pre {
  font-size: 10px;
  line-height: 1.5;
  max-height: 330px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow: auto;
  margin-top: 12px;
  color: #42536b;
}
.review-card {
  position: sticky;
  top: 20px;
}
@media (max-width: 850px) {
  .columns {
    grid-template-columns: 1fr;
  }
  .review-card {
    position: static;
  }
  .endpoint-fields {
    grid-template-columns: 1fr 1fr;
  }
  .endpoint-fields label:first-child {
    grid-column: 1/-1;
  }
  .native-heading {
    flex-direction: column;
    gap: 14px;
  }
  .native-heading h1 {
    font-size: 28px;
  }
}
@media (max-width: 500px) {
  .native-workspace {
    padding: 24px 14px 40px;
  }
  .card {
    padding: 18px;
  }
  .form-row,
  .endpoint-fields {
    grid-template-columns: 1fr;
  }
  .endpoint-fields label:first-child {
    grid-column: auto;
  }
  .endpoint-fields button {
    margin-bottom: 4px;
  }
  .card dl {
    grid-template-columns: 1fr;
    gap: 4px;
  }
  .card dd {
    margin-bottom: 8px;
  }
  .tabs button {
    padding: 9px 12px;
    flex: none;
  }
  .summary-top {
    flex-direction: column;
  }
  .actions button {
    flex: 1;
  }
  .native-heading p {
    font-size: 13px;
  }
}
</style>

<template>
  <div class="native-workspace" :aria-busy="busy">
    <header class="native-heading">
      <div>
        <p class="eyebrow">NEO · NATIVE ABI 2</p>
        <h1>{{ L("Native accounts", "原生智能账户") }}</h1>
        <p>
          {{
            L(
              "Stable identity. Explicit authority. Verifiable recovery.",
              "稳定身份，明确权限，可验证的恢复路径。",
            )
          }}
        </p>
      </div>
      <span class="pill" :class="{ verified: profile }">{{
        profile
          ? L("Profile verified", "协议信息已核对")
          : L("Read only · not verified", "只读 · 尚未验证")
      }}</span>
    </header>
    <section class="card endpoint-card" aria-labelledby="node-title">
      <h2 id="node-title">1. {{ L("Verify the network", "验证网络") }}</h2>
      <p>
        {{
          L(
            "This exact node must prove native activation. Public V3 contracts cannot activate this workspace.",
            "当前节点必须证明原生服务已激活。公共 V3 合约无法启用本工作区。",
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
        AccountManagement · ABI {{ profile.abiVersion }} · Network
        {{ profile.networkMagic }}<br />{{ profile.profileParameterDigest }}
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
                <strong>{{ snapshot.account.status }}</strong
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
                <dt>{{ L("Recovery", "恢复权限") }}</dt>
                <dd class="mono">
                  {{
                    snapshot.account.recoveryAddress === ZERO_HASH
                      ? L("Not configured", "未配置")
                      : "0x" + snapshot.account.recoveryAddress
                  }}
                </dd>
                <dt>{{ L("Verifier", "验证插件") }}</dt>
                <dd class="mono">
                  {{
                    snapshot.account.verifier
                      ? "0x" + snapshot.account.verifier.contract
                      : L("Custody witness fallback", "托管钱包见证")
                  }}
                </dd>
                <dt>{{ L("Hook", "策略插件") }}</dt>
                <dd class="mono">
                  {{
                    snapshot.account.hook
                      ? "0x" + snapshot.account.hook.contract
                      : L("None", "无")
                  }}
                </dd>
                <dt>Nonce channel 0</dt>
                <dd>{{ snapshot.nonce }}</dd>
                <dt>{{ L("Chain time", "链上时间") }}</dt>
                <dd>{{ time(snapshot.chainTime) }}</dd>
              </dl>
            </div>
            <p class="small">
              {{ L("State and maturity use the chain time shown above. Refresh after waiting or submitting a transaction; this page does not advance maturity using your device clock.", "状态和到期判断使用上方链上时间。等待或提交交易后请刷新；本页不会按设备时钟推算到期。") }}
            </p>
            <button class="secondary" :disabled="busy || !profile" @click="loadAccount">
              {{ L("Refresh account and chain time", "刷新账户与链上时间") }}
            </button>
            <div v-if="pendingIntents.length" class="callout">
              <strong>{{ L("Pending changes", "待生效变更") }}</strong>
              <p v-for="intent in pendingIntents" :key="intent.key">
                {{ intent.key }}: {{ time(intent.matureAt) }} ·
                {{
                  BigInt(intent.matureAt) <= BigInt(snapshot.chainTime)
                    ? L(
                        "Separate activation transaction required",
                        "需要另发激活交易",
                      )
                    : L("Waiting for chain time", "等待链上时间")
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
            <div v-if="action === 'freeze' || action === 'unfreeze' || snapshot.account.status === 'Frozen'" class="callout" data-testid="native-freeze-risk">
              <strong>{{ snapshot.account.status === 'Frozen' ? L("What is needed to unfreeze", "解冻所需条件") : L("Before freezing: plan how to unfreeze", "冻结前：确认如何解冻") }}</strong>
              <p>{{ L("Unfreezing requires both of these authorities to sign the same transaction:", "解冻需要以下双方共同签署同一笔交易：") }}</p>
              <dl>
                <dt>{{ L("Current custody", "当前托管方") }}</dt>
                <dd class="mono">{{ addressOf(snapshot.account.custodyAddress) }}<br />0x{{ snapshot.account.custodyAddress }}</dd>
                <dt>{{ L("Current recovery authority", "当前恢复方") }}</dt>
                <dd class="mono">{{ snapshot.account.recoveryAddress === ZERO_HASH ? L("Not configured", "未配置") : addressOf(snapshot.account.recoveryAddress) }}<br v-if="snapshot.account.recoveryAddress !== ZERO_HASH" /><span v-if="snapshot.account.recoveryAddress !== ZERO_HASH">0x{{ snapshot.account.recoveryAddress }}</span></dd>
              </dl>
              <p>{{ L("If recovery can no longer sign while frozen, custody alone cannot unfreeze or replace recovery. Custody recovery keeps the same recovery authority and frozen status. Check that recovery can still sign and that both parties can cooperate before freezing.", "冻结期间若恢复方无法满足签名条件，托管方无法单独解冻或更换恢复方。托管恢复也会保留原恢复方和冻结状态。冻结前请确认恢复方仍能签名，并与托管方约定共同解冻。") }}</p>
              <p>{{ L("Recovery may use a standard Neo wallet with an m-of-n signature threshold. Keep enough independent signers available to meet that threshold; fewer cannot authorize recovery or unfreeze. This is separate from the account's MultiSigVerifier plugin.", "恢复方可以使用普通 Neo m-of-n 多签钱包。应保留足够的独立签名方以满足阈值；不足阈值时无法授权恢复或解冻。这与账户的 MultiSigVerifier 验证插件是不同机制。") }}</p>
              <p v-if="snapshot.account.status !== 'Frozen' && !snapshot.account.pendingRecovery">{{ L("If recovery access is at risk while the account is active, custody can propose a replacement recovery authority and activate it after 24 hours. Confirm that change before relying on it.", "账户正常且恢复权限可能丢失时，托管方可先提议更换恢复方，并在 24 小时后激活；请确认变更已上链后再依赖新恢复方。") }}</p>
              <template v-if="action === 'freeze'">
                <p>{{ L("Freezing clears pending verifier and hook replacements, recovery-authority replacement, custody recovery, and pending policy calls for both verifier and hook. Active module settings remain installed.", "冻结会清空待生效的验证插件更换、策略插件更换、恢复方更换、托管恢复，以及验证插件和策略插件两类待生效配置调用。当前模块配置仍保留。") }}</p>
                <p v-if="snapshot.account.pendingRecovery">{{ L("Your pending custody recovery will be cancelled. Starting it again requires a new proposal and a new 7-day delay.", "当前待生效的托管恢复会被取消。重新发起需要新的提议，并重新等待 7 天。") }}</p>
              </template>
            </div>
            <label v-if="selectedAction.address"
              >{{
                action === "proposeRecovery"
                  ? L(
                      "New custody Neo address / script hash",
                      "新托管 Neo 地址 / 脚本哈希",
                    )
                  : L(
                      "New Neo address / contract hash (zero removes optional role)",
                      "新 Neo 地址 / 合约哈希（全零移除可选角色）",
                    )
              }}<input
                v-model.trim="actionAddress"
                spellcheck="false"
                placeholder="0x…"
            /></label>
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
              {{ L("Review management action", "审核管理操作") }}
            </button>
            <p class="small">
              {{
                L(
                  "Recovery detaches old plugins without their callbacks; the funding address and frozen state stay unchanged. Recovery can freeze spending immediately. Unfreezing requires current custody and recovery cooperation. Lost custody access can be replaced through recovery; lost recovery signing access leaves no custody-only unfreeze.",
                  "恢复无需旧插件回调即可撤销其权限，收款地址和冻结状态保留。恢复方可立即冻结支出；解冻需要当前托管方与恢复方合作。托管权限丢失可通过恢复更换；恢复方无法签名时，托管方无法单独解冻。",
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
                "Start with custody witness. Add plugins later through delayed configuration.",
                "先使用托管钱包见证，后续通过延迟配置添加插件。",
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
            >{{
              L(
                "Independent recovery Neo address / script hash",
                "独立恢复 Neo 地址 / 脚本哈希",
              )
            }}<input
              v-model.trim="registration.recoveryAddress"
              data-testid="native-recovery"
              spellcheck="false"
              placeholder="N… or 0x…"
          /></label>
          <p class="small">
            {{
              L(
                "Use a separately controlled Neo wallet you can access. Recovery can freeze spending and replace custody after 7 days. Unfreezing needs both authorities, so preserve both signing paths and agree how to cooperate. An Ethereum-shaped hash does not prove Neo wallet control.",
                "请选择可实际使用、独立保管的 Neo 钱包。恢复方可以冻结支出，并在 7 天后更换托管方。解冻需要双方权限，请确保双方签名方式可用并约定协作方式。Ethereum 地址外形并不证明具备 Neo 钱包控制权。",
              )
            }}
          </p>
          <label v-if="!registration.recoveryAddress" class="check"
            ><input v-model="registration.allowNoRecovery" type="checkbox" />{{
              L(
                "I understand: without recovery, lost custody keys may permanently lock this account.",
                "我理解：没有恢复权限时，丢失托管私钥可能永久失去账户。",
              )
            }}</label
          ><label
            >{{
              L(
                "Account salt (32 bytes, public)",
                "账户随机盐（32 字节，公开信息）",
              )
            }}<input
              v-model.trim="registration.salt"
              data-testid="native-salt"
              spellcheck="false" /></label
          ><button class="secondary" :disabled="busy" @click="generateSalt">
            {{ L("Generate new salt", "生成新的随机盐") }}
          </button>
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
          <p class="callout">
            {{
              L(
                "No verifier or hook is installed at creation. Custody can authorize spending after confirmed registration.",
                "初始不安装验证或策略插件。注册链上确认后，托管钱包即可授权操作。",
              )
            }}
          </p>
          <div class="actions">
            <button
              :disabled="
                !profile ||
                busy ||
                !derived ||
                (!registration.recoveryAddress && !registration.allowNoRecovery)
              "
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
        <template v-else-if="tab === 'policy'">
          <h2>2. {{ L("Set bounded permissions", "设置受限权限") }}</h2>
          <p>
            {{
              L(
                "Load an account first. Inspect a pending verifier or hook policy, activate its exact call after maturity, or cancel it with custody authority.",
                "请先加载账户。查看待生效验证或策略模块配置，到期后提交相同调用激活，也可由托管方取消。",
              )
            }}
          </p>
          <label>
            {{ L("Module role", "模块角色") }}
            <select v-model="policy.role" :aria-label="L('Module role', '模块角色')">
              <option value="verifier">{{ L("Verifier", "验证模块") }}</option>
              <option value="hook">{{ L("Hook", "策略模块") }}</option>
            </select>
          </label>
          <button class="secondary" :disabled="!profile || !snapshot || busy" @click="refreshPolicy">
            {{ L("Refresh pending policy", "刷新待生效配置") }}
          </button>
          <div v-if="pendingPolicy" class="callout" data-testid="native-pending-policy">
            <p class="small">{{ L("Checked at chain time", "核对时的链上时间") }}: {{ time(pendingPolicy.chainTime) }}</p>
            <template v-if="pendingPolicy.pending">
              <dl>
                <dt>{{ L("Role / method", "角色 / 方法") }}</dt>
                <dd>{{ pendingPolicy.role }} / {{ pendingPolicy.pending.method }}</dd>
                <dt>{{ L("Root module", "根模块") }}</dt>
                <dd class="mono">0x{{ pendingPolicy.pending.root.contract }}</dd>
                <dt>{{ L("Selected module", "目标模块") }}</dt>
                <dd class="mono">0x{{ pendingPolicy.pending.selected.contract }}</dd>
                <dt>{{ L("Activation time", "可激活时间") }}</dt>
                <dd>{{ time(pendingPolicy.pending.matureAt) }}</dd>
              </dl>
              <p>{{ BigInt(pendingPolicy.pending.matureAt) <= BigInt(pendingPolicy.chainTime)
                ? L("Mature at the checked chain time. A separate custody-authorized activation transaction is required.", "核对时已到期，仍需由托管方另发激活交易。")
                : L("Waiting for chain time. Refresh before activating.", "等待链上时间到期，请在激活前刷新。") }}</p>
              <details>
                <summary>{{ L("Exact typed arguments, including account ID", "完整类型化参数（含账户 ID）") }}</summary>
                <pre>{{ jsonText(pendingPolicy.pending.invokedArguments) }}</pre>
              </details>
              <button class="secondary" :disabled="busy || !profile" @click="cancelPolicy">
                {{ L("Review policy cancellation", "审核取消配置") }}
              </button>
              <p class="small">{{ L("Cancellation checks this exact pending call again on chain before removing it. If another device changes it first, cancellation fails and the replacement stays pending. Active permissions stay unchanged.", "取消交易会在链上再次核对这笔待生效调用。若其他设备先更改了它，取消会失败，新调用仍待生效；当前权限不变。") }}</p>
            </template>
            <p v-else>{{ L("No policy call is pending for this role.", "此角色没有待生效配置。") }}</p>
          </div>
          <template v-if="policy.role === 'verifier'">
          <label
            >{{ L("Policy", "权限类型")
            }}<select
              v-model="policy.kind"
              :aria-label="L('Policy', '权限类型')"
            >
              <option value="session">
                {{ L("Limited token-transfer session", "受限代币转账会话") }}
              </option>
              <option value="revoke">
                {{ L("Revoke session key", "撤销会话密钥") }}
              </option>
              <option value="multisig">
                {{ L("Multiple verifier approvals", "多个验证模块授权") }}
              </option>
            </select></label
          ><label
            >{{
              L(
                "Child verifier hash (empty for root)",
                "子验证模块哈希（根模块留空）",
              )
            }}<input
              v-model.trim="policy.child"
              spellcheck="false"
              placeholder="0x…"
          /></label>
          <template v-if="policy.kind === 'session'"
            ><label
              >{{
                L(
                  "Session public key (compressed P-256)",
                  "会话公钥（压缩 P-256）",
                )
              }}<input
                v-model.trim="policy.publicKey"
                spellcheck="false"
                placeholder="02… / 03…" /></label
            ><label
              >{{ L("Token contract", "代币合约")
              }}<input
                v-model.trim="policy.target"
                spellcheck="false"
                placeholder="0x…"
            /></label>
            <div class="form-row">
              <label
                >{{ L("Expiry UTC (milliseconds)", "到期时间 UTC（毫秒）")
                }}<input
                  v-model.trim="policy.expiresAt"
                  inputmode="numeric" /></label
              ><label
                >{{
                  L(
                    "Total spending cap (base units)",
                    "累计支出上限（最小单位）",
                  )
                }}<input
                  v-model.trim="policy.spendingLimit"
                  inputmode="numeric"
                  placeholder="100000000"
              /></label>
            </div>
            <p class="callout">
              {{
                L(
                  "Only transfer on this token. A positive cap is required; zero means unlimited on chain. Keep the session private key in its wallet. Configuration takes 24 hours; expiry must leave time after activation. Freeze is immediate containment.",
                  "仅允许对此代币调用 transfer。上限必须为正；链上零表示无限。会话私钥由钱包保管。配置需等待 24 小时，到期时间须晚于激活时间；紧急控制请使用冻结。",
                )
              }}
            </p></template
          >
          <template v-else-if="policy.kind === 'multisig'"
            ><label
              >{{
                L(
                  "Ordered verifier child hashes (one per line)",
                  "有序子验证模块哈希（每行一个）",
                )
              }}<textarea
                v-model.trim="policy.children"
                rows="4"
                spellcheck="false"
              /></label
            ><label
              >{{ L("Required modules", "所需模块数")
              }}<input
                v-model.trim="policy.threshold"
                type="number"
                min="1"
                :max="NATIVE_MULTISIG_LIMITS.maxThreshold"
            /></label>
            <p class="callout">
              {{
                L(
                  "Use 1–3 children and a threshold of 1–2. Thresholds count modules, not independent humans. Configure each child before activating the delayed roster. An empty native-child proof still requires a real transaction witness.",
                  "可配置 1–3 个子模块，阈值为 1–2。阈值计算模块数量，不证明由不同人控制。先配置子模块，再激活延迟成员列表。原生子模块即使证明为空，也需要真实交易见证。",
                )
              }}
            </p></template
          >
          <p v-if="policy.kind === 'revoke'" class="callout">
            {{
              L(
                "Session revocation is a delayed configuration call. To stop spending immediately, use the recovery authority to freeze the account.",
                "会话撤销是延迟配置操作；如需立即停止支出，请由恢复权限冻结账户。",
              )
            }}
          </p>
          </template>
          <p v-else class="small">{{ L("Use the native SDK to stage hook configuration. Existing pending calls can be inspected, activated or cancelled here.", "请使用原生 SDK 提交策略模块配置。已有待生效调用可在此查看、激活或取消。") }}</p>
          <div class="actions">
            <button
              v-if="policy.role === 'verifier'"
              :disabled="!profile || !snapshot || busy"
              @click="reviewPolicy"
            >
              {{ L("Review delayed policy", "审核延迟权限配置") }}</button
            ><button
              class="secondary"
              :disabled="!profile || !snapshot || busy || !pendingPolicy?.pending"
              @click="activatePolicy"
            >
              {{ L("Review pending activation", "审核待生效配置") }}
            </button>
          </div>
        </template>
        <template v-else>
          <h2>2. {{ L("Prepare a native operation", "准备原生业务操作") }}</h2>
          <p>
            {{
              L(
                "Uses live nonce and authority epoch. The node must agree with the exact operation digest.",
                "使用实时 Nonce 和权限代际，节点必须确认完全一致的摘要。",
              )
            }}
          </p>
          <div class="form-row">
            <label
              >{{ L("Target contract", "目标合约")
              }}<input
                v-model.trim="operation.targetContract"
                spellcheck="false"
                placeholder="0x…" /></label
            ><label
              >{{ L("Method", "方法")
              }}<input v-model.trim="operation.method" spellcheck="false"
            /></label>
          </div>
          <label
            >{{
              L(
                "Typed NeoVM arguments (JSON array)",
                "NeoVM 类型化参数（JSON 数组）",
              )
            }}<textarea v-model="operation.args" rows="6" spellcheck="false" />
          </label>
          <p class="small">
            {{
              L(
                "Types: Null, Boolean, Integer, ByteString (hex), Array, Struct. Integers are decimal strings; ByteString hashes use native little-endian bytes.",
                "类型：Null、Boolean、Integer、ByteString（十六进制）、Array、Struct。整数使用十进制字符串；ByteString 中的哈希使用小端字节。",
              )
            }}
          </p>
          <div class="form-row">
            <label
              >{{ L("Nonce channel", "Nonce 通道")
              }}<input
                v-model.trim="operation.channel"
                inputmode="numeric" /></label
            ><label
              >{{ L("Deadline UTC (milliseconds)", "截止时间 UTC（毫秒）")
              }}<input v-model.trim="operation.deadline" inputmode="numeric"
            /></label>
          </div>
          <label
            >{{
              L(
                "Verifier proof hex (empty for custody witness)",
                "验证证明十六进制（托管见证留空）",
              )
            }}<textarea
              v-model.trim="operation.signature"
              rows="2"
              spellcheck="false"
            />
          </label>
          <p class="callout">
            {{
              L(
                "Native sponsorship is unavailable. A fee payer needs GAS. Execution needs an exact-script wallet or SDK with the proxy witness; ordinary invoke cannot safely submit it.",
                "原生赞助付费不可用，付费者需要 GAS。执行必须使用支持精确脚本和代理见证的钱包或 SDK，普通 invoke 无法安全提交。",
              )
            }}
          </p>
          <p class="small">
            {{
              L(
                "Bounds: 64 arguments · 4,096 serialized bytes · 1,024 proof bytes · depth 8 · deadline within 1 hour.",
                "边界：64 个参数 · 序列化 4,096 字节 · 证明 1,024 字节 · 深度 8 · 截止时间 1 小时内。",
              )
            }}
          </p>
          <button
            :disabled="
              !profile ||
              !snapshot ||
              snapshot.account.status !== 'Active' ||
              busy
            "
            @click="reviewOperation"
          >
            {{ L("Preview exact operation", "预览精确操作") }}
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
              "The actor pays network and system fees. Confirm actual transaction fees in the wallet.",
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
            <dt>{{ L("Network / ABI", "网络 / ABI") }}</dt>
            <dd>
              {{ review.profile.networkMagic }} /
              {{ review.profile.abiVersion }}
            </dd>
            <dt>{{ L("Account ID", "账户 ID") }}</dt>
            <dd class="mono">0x{{ review.plan.accountId }}</dd>
            <dt>{{ L("Fee payer", "付费者") }}</dt>
            <dd class="mono">0x{{ review.feePayer }}</dd>
            <dt>{{ L("Required authorities", "所需权限") }}</dt>
            <dd class="mono" data-testid="native-required-authorities">
              {{
                review.requiredAuthorities
                  .map((h) => "0x" + h)
                  .join(", ") ||
                L(
                  "Permissionless executor / verifier proof",
                  "任何执行者 / 验证证明",
                )
              }}
            </dd>
            <dt>{{ L("Signer scopes", "签名范围") }}</dt>
            <dd class="mono">
              {{
                review.signers
                  .map(
                    (s) =>
                      s.scopes +
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
          <div v-if="review.plan.preparedOperations" class="small mono">
            <p v-for="p in review.plan.preparedOperations" :key="p.digest">
              {{ p.operation.method }} · 0x{{ p.operation.targetContract
              }}<br />Nonce {{ p.operation.nonce }} ·
              {{ time(p.operation.deadline) }}<br />Digest {{ p.digest }}
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
          <label v-if="review.plan.method === 'freeze'" class="check" data-testid="native-freeze-acknowledgement">
            <input v-model="freezeAccepted" type="checkbox" :disabled="busy" />
            {{ L("I understand both authorities are needed to unfreeze, losing recovery access can leave funds frozen, and pending changes will be cleared.", "我已了解解冻需要双方合作，恢复权限丢失可能导致资金无法解冻，且待生效变更会被清空。") }}
          </label>
          <div class="actions">
            <button
              :disabled="
                !accepted ||
                (review.plan.method === 'freeze' && !freezeAccepted) ||
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
              :disabled="!accepted || (review.plan.method === 'freeze' && !freezeAccepted) || busy"
              @click="exportRequest"
            >
              {{ L("Export reviewed request", "导出审核请求") }}
            </button>
          </div>
          <p v-if="!review.walletSupported" class="callout">
            {{
              review.plan.requiresExactScript ? L(
                "This cancellation needs the exact script to preserve its pending-intent check. The connected wallet's invoke interface rebuilds the call and cannot preserve that check. Export the request for exact transaction signing; ordinary wallet invoke is disabled.",
                "此取消操作必须保留精确脚本中的待生效调用核对。已连接钱包的 invoke 接口会重新组装调用，无法保留这项核对。请导出请求完成精确交易签名；普通钱包 invoke 已禁用。",
              ) : L(
                "This needs exact-script or multiple-authority signing. Export it for the native SDK. Ordinary wallet invoke is disabled.",
                "此请求需要精确脚本或多权限签名，请导出后使用原生 SDK。普通钱包 invoke 已禁用。",
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
              <button :disabled="busy || signedAttempted || !signedPreflight || !signedAccepted || !accepted || (review.plan.method === 'freeze' && !freezeAccepted)" @click="broadcastSignedTransaction">{{ L("Broadcast signed transaction", "广播已签交易") }}</button>
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
  actionBlockReason,
  buildRecoveryDescriptor,
  readRecoveryDescriptor,
  buildSessionArguments,
  buildMultiSigArguments,
  NATIVE_MULTISIG_LIMITS,
  jsonText,
} from "./nativeWorkspace.js";
const { locale } = useI18n();
const L = (en, zh) => (locale.value === "zh-CN" ? zh : en);
const endpoint = ref(RUNTIME_CONFIG.rpcUrl),
  network = ref(String(RUNTIME_CONFIG.networkMagic)),
  profile = shallowRef(null),
  snapshot = shallowRef(null),
  pendingPolicy = shallowRef(null),
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
  recoveryAddress: "",
  salt: "",
  allowNoRecovery: false,
});
const policy = reactive({
  role: "verifier",
  kind: "session",
  child: "",
  publicKey: "",
  target: "",
  expiresAt: String(Date.now() + 2 * 86400000),
  spendingLimit: "",
  children: "",
  threshold: "2",
});
const operation = reactive({
  targetContract: "",
  method: "transfer",
  args: "[]",
  channel: "0",
  deadline: String(Date.now() + 15 * 60000),
  signature: "",
});
const action = ref("freeze"),
  actionAddress = ref("");
const workspace = createNativeWorkspace({
  wallet: createNativeWalletAdapter(walletService),
});
const tabs = [
  { id: "account", en: "Account & recovery", zh: "账户与恢复" },
  { id: "create", en: "Create account", zh: "创建账户" },
  { id: "policy", en: "Sessions & approvals", zh: "会话与授权" },
  { id: "operation", en: "Native operation", zh: "原生操作" },
];
const selectedAction = computed(() =>
  NATIVE_ACTIONS.find((a) => a.value === action.value),
);
const actionBlocked = computed(() =>
  actionBlockReason(
    snapshot.value?.account,
    action.value,
    snapshot.value?.chainTime ?? 0,
  ),
);
const derived = computed(() => {
  try {
    if (!profile.value) return null;
    return nativeCodec.deriveIdentity({
      networkMagic: profile.value.networkMagic,
      custodyAddress: nativeAddress(registration.custodyAddress),
      salt: registration.salt,
    });
  } catch {
    return null;
  }
});
const pendingIntents = computed(() =>
  snapshot.value
    ? [
        "pendingVerifier",
        "pendingHook",
        "pendingRecoveryAddress",
        "pendingRecovery",
      ].flatMap((key) =>
        snapshot.value.account[key]
          ? [{ key, ...snapshot.value.account[key] }]
          : [],
      )
    : [],
);
function addressOf(hash) {
  try {
    return getAddressFromScriptHash(hash);
  } catch {
    return "";
  }
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
  pendingPolicy.value = null;
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
    () => ({ ...policy }),
    () => ({ ...operation }),
    action,
    actionAddress,
    feePayer,
    signingPath,
    tab,
  ],
  clearReview,
  { flush: "sync" },
);
watch(
  accountId,
  () => {
    snapshot.value = null;
    pendingPolicy.value = null;
    clearReview();
  },
  { flush: "sync" },
);
watch(() => policy.role, () => { pendingPolicy.value = null; }, { flush: "sync" });
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
      pendingPolicy.value = null;
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
    pendingPolicy.value = null;
    profile.value = null;
    restoredTransaction.value = null;
    profile.value = await workspace.connect({
      rpcUrl: endpoint.value,
      networkMagic: network.value,
    });
    notice.value = L(
      "Native ABI 2 and network verified.",
      "原生 ABI 2 和网络验证通过。",
    );
  });
}
async function loadAccount() {
  await run(async () => {
    clearReview();
    pendingPolicy.value = null;
    snapshot.value = await workspace.load(accountId.value);
    if (!feePayer.value) feePayer.value = snapshot.value.account.custodyAddress;
    policy.expiresAt = String(snapshot.value.chainTime + 2 * 86400000);
    operation.deadline = String(snapshot.value.chainTime + 15 * 60000);
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
  await run(async () =>
    setReview(
      await workspace.registration({
        ...registration,
        submission: signingPath.value,
        feePayer: feePayer.value,
      }),
    ),
  );
}
async function reviewAction() {
  await run(async () =>
    setReview(
      await workspace.lifecycle({
        accountId: accountId.value,
        action: action.value,
        submission: signingPath.value,
        address: actionAddress.value,
        feePayer: feePayer.value,
      }),
    ),
  );
}
async function reviewPolicy() {
  await run(async () => {
    let args, method;
    if (policy.kind === "revoke") {
      args = [];
      method = "clearSessionKey";
    } else if (policy.kind === "session") {
      args = buildSessionArguments(policy, snapshot.value.chainTime);
      method = "setSessionKey";
    } else {
      args = buildMultiSigArguments(
        policy,
        L(
          "Use 1–3 unique modules and a reachable threshold of 1–2.",
          "请填写 1–3 个不重复模块，并设置 1–2 之间且可满足的阈值。",
        ),
      );
      method = "setConfig";
    }
    setReview(
      await workspace.policy({
        accountId: accountId.value,
        role: policy.role,
        child: policy.child || undefined,
        method,
        args,
        feePayer: feePayer.value,
      }),
    );
  });
}
async function refreshPolicy() {
  await run(async () => {
    clearReview();
    pendingPolicy.value = null;
    pendingPolicy.value = await workspace.inspectPolicy({ accountId: accountId.value, role: policy.role });
  });
}
async function cancelPolicy() {
  await run(async () => {
    const inspected = pendingPolicy.value;
    if (!inspected?.pending) throw Error(L("Refresh the pending policy first.", "请先刷新待生效配置。"));
    setReview(await workspace.lifecycle({
      accountId: accountId.value,
      action: "cancelModuleCall",
      role: inspected.role,
      expectedPending: inspected.pending,
      feePayer: feePayer.value,
      submission: signingPath.value,
    }));
  });
}
async function activatePolicy() {
  await run(async () =>
    setReview(
      await workspace.activatePolicy({
        accountId: accountId.value,
        role: policy.role,
        feePayer: feePayer.value,
      }),
    ),
  );
}
async function reviewOperation() {
  await run(async () => {
    let args;
    try {
      args = JSON.parse(operation.args);
    } catch {
      throw Error(
        L(
          "Arguments must be a typed JSON array.",
          "参数必须是类型化 JSON 数组。",
        ),
      );
    }
    setReview(
      await workspace.operation({
        ...operation,
        accountId: accountId.value,
        targetContract: nativeAddress(operation.targetContract),
        args,
        feePayer: feePayer.value,
      }),
    );
  });
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
      ...profile.value,
      ...derived.value,
      custodyAddress: registration.custodyAddress,
      salt: registration.salt,
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

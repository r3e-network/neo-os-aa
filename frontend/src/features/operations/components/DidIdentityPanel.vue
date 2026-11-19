<template>
  <div
    class="rounded-[20px] border border-sa-border bg-sa-panel/60 overflow-hidden shadow-glow-panel backdrop-blur-lg transition-all duration-200"
  >
    <button
      @click="expanded = !expanded"
      :aria-expanded="expanded"
      aria-controls="did-panel-content"
      class="w-full bg-sa-panel/40 px-6 py-5 border-b border-sa-border flex items-center justify-between hover:bg-sa-dark/40 transition-colors duration-200"
    >
      <div class="flex items-center gap-4">
        <div
          class="w-8 h-8 rounded-full bg-sa-info/20 border border-sa-info/50 text-sa-info flex items-center justify-center font-bold text-sm shadow-glow-sky"
        >
          D
        </div>
        <h2 class="text-lg font-bold text-sa-text font-outfit">
          {{ t("didPanel.title", "NeoDID / Web3Auth") }}
        </h2>
      </div>
      <svg
        aria-hidden="true"
        class="w-4 h-4 text-sa-muted transform transition-transform duration-200"
        :class="expanded ? 'rotate-180' : ''"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M19 9l-7 7-7-7"
        ></path>
      </svg>
    </button>
    <div
      id="did-panel-content"
      v-show="expanded"
      class="p-6 md:p-8 animate-fade-in space-y-6"
    >
      <div class="rounded-xl border border-sa-info/20 bg-sa-info/5 p-5">
        <div
          class="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between"
        >
          <div>
            <p class="text-xs uppercase text-sa-info font-bold mb-2">
              {{ t("didPanel.connectTitle", "Connect Web3Auth First") }}
            </p>
            <p class="text-sm text-sa-text leading-6">
              {{
                didAvailable
                  ? t(
                      "didPanel.connectSubtitle",
                      "NeoDID bind, recovery, and private sessions all start from a live Web3Auth identity. Choose a login method below.",
                    )
                  : t(
                      "didPanel.connectUnavailable",
                      "Web3Auth is not configured in this deployment yet.",
                    )
              }}
            </p>
          </div>
          <div class="flex flex-wrap gap-3">
            <button
              v-if="didAvailable && !didConnected"
              class="btn-primary btn-xs"
              :aria-label="t('operations.ariaConnectDid', 'Connect DID')"
              :class="{ 'btn-loading': busy === 'connectDid' }"
              :disabled="busy === 'connectDid'"
              @click="connectDidAction()"
            >
              {{
                busy === "connectDid"
                  ? t("didPanel.connecting", "Connecting…")
                  : t("didPanel.connectModal", "Open Web3Auth")
              }}
            </button>
            <button
              v-if="didAvailable && !didConnected"
              class="btn-secondary btn-xs"
              :aria-label="
                t('operations.ariaConnectGoogle', 'Connect via Google')
              "
              :class="{ 'btn-loading': busy === 'connectGoogle' }"
              :disabled="busy === 'connectGoogle'"
              @click="connectDidAction('google')"
            >
              {{
                busy === "connectGoogle"
                  ? t("didPanel.connecting", "Connecting…")
                  : t("didPanel.connectGoogle", "Google")
              }}
            </button>
            <button
              v-if="didAvailable && !didConnected"
              class="btn-secondary btn-xs"
              :aria-label="
                t('operations.ariaConnectEmail', 'Connect via Email')
              "
              :class="{ 'btn-loading': busy === 'connectEmail' }"
              :disabled="busy === 'connectEmail'"
              @click="connectDidAction('email_passwordless')"
            >
              {{
                busy === "connectEmail"
                  ? t("didPanel.connecting", "Connecting…")
                  : t("didPanel.connectEmail", "Email")
              }}
            </button>
            <button
              v-if="didAvailable && !didConnected"
              class="btn-secondary btn-xs"
              :aria-label="t('operations.ariaConnectSms', 'Connect via SMS')"
              :class="{ 'btn-loading': busy === 'connectSms' }"
              :disabled="busy === 'connectSms'"
              @click="connectDidAction('sms_passwordless')"
            >
              {{
                busy === "connectSms"
                  ? t("didPanel.connecting", "Connecting…")
                  : t("didPanel.connectSms", "SMS")
              }}
            </button>
            <button
              v-if="didConnected"
              class="btn-secondary btn-xs"
              :aria-label="t('operations.ariaDisconnectDid', 'Disconnect DID')"
              :class="{ 'btn-loading': busy === 'disconnectDid' }"
              :disabled="busy === 'disconnectDid'"
              @click="disconnectDidAction"
            >
              {{ t("didPanel.disconnect", "Disconnect Web3Auth") }}
            </button>
          </div>
        </div>
      </div>

      <DidIdentitySummaryGrids
        :did-profile="didProfile"
        :service-did="serviceDid"
        :resolved-account-id="resolvedAccountId"
        :linked-accounts-label="linkedAccountsLabel"
        :can-email-notice="canEmailNotice"
        :can-sms-notice="canSmsNotice"
      />

      <div class="grid gap-4 xl:grid-cols-2">
        <div class="rounded-xl border border-sa-border bg-sa-panel/40 p-4">
          <p class="text-xs uppercase text-sa-muted font-bold mb-2">
            {{ t("didPanel.resolver", "Resolver") }}
          </p>
          <p class="text-sm text-sa-text break-all">{{ resolverUrl }}</p>
          <p class="mt-2 text-xs text-sa-muted">
            {{
              t(
                "didPanel.resolverHint",
                "Public DID resolution is metadata-only. Private JWT claims and nullifiers never appear in resolver output.",
              )
            }}
          </p>
        </div>
        <div class="rounded-xl border border-sa-border bg-sa-panel/40 p-4">
          <p class="text-xs uppercase text-sa-muted font-bold mb-2">
            {{ t("didPanel.runtimeStatus", "Runtime Status") }}
          </p>
          <p class="text-sm text-sa-text font-semibold break-all">
            {{ runtimeSummary }}
          </p>
          <div class="mt-3 flex flex-wrap gap-3">
            <button
              class="btn-secondary btn-sm"
              :aria-label="
                t('operations.ariaResolveServiceDid', 'Resolve Service DID')
              "
              :class="{ 'btn-loading': busy === 'resolveServiceDid' }"
              :disabled="busy === 'resolveServiceDid'"
              @click="resolveServiceDidAction"
            >
              {{
                busy === "resolveServiceDid"
                  ? t("didPanel.resolving", "Resolving…")
                  : t("didPanel.resolveServiceDid", "Resolve Service DID")
              }}
            </button>
            <a
              :href="resolverUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="btn-secondary btn-sm no-underline"
            >
              {{ t("didPanel.openResolver", "Open Resolver") }}
            </a>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <button
          class="btn-secondary btn-sm"
          :aria-label="
            t('operations.ariaRefreshChainState', 'Refresh chain state')
          "
          :class="{ 'btn-loading': busy === 'refreshState' }"
          :disabled="busy === 'refreshState' || !resolvedAccountId"
          @click="refreshRecoveryStateAction"
        >
          {{
            busy === "refreshState"
              ? t("didPanel.refreshing", "Refreshing…")
              : t("didPanel.refreshChainState", "Refresh Chain State")
          }}
        </button>
        <button
          class="btn-secondary btn-sm"
          :aria-label="t('operations.ariaSendEmailNotice', 'Send email notice')"
          :class="{ 'btn-loading': busy === 'notifyEmail' }"
          :disabled="busy === 'notifyEmail' || !canEmailNotice"
          @click="sendEmailNoticeAction"
        >
          {{
            busy === "notifyEmail"
              ? t("didPanel.sendingEmail", "Sending Email…")
              : t("didPanel.sendEmailNotice", "Send Email Notice")
          }}
        </button>
        <button
          class="btn-secondary btn-sm"
          :aria-label="t('operations.ariaSendSmsNotice', 'Send SMS notice')"
          :class="{ 'btn-loading': busy === 'notifySms' }"
          :disabled="busy === 'notifySms' || !canSmsNotice"
          @click="sendSmsNoticeAction"
        >
          {{
            busy === "notifySms"
              ? t("didPanel.sendingSms", "Sending SMS…")
              : t("didPanel.sendSmsNotice", "Send SMS Notice")
          }}
        </button>
        <span class="text-xs text-sa-muted">{{
          t(
            "didPanel.flowHint",
            "Recommended flow: Connect Web3Auth → Bind NeoDID → Start Recovery / Private Session → Finalize / Revoke.",
          )
        }}</span>
      </div>

      <DidRecoveryStateGrid :recovery-state="recoveryState" />

      <DidPendingStateCards
        :recovery-state="recoveryState"
        :busy="busy"
        @finalize="finalizeRecoveryAction"
        @cancel="cancelRecoveryAction"
        @revoke="revokeSessionAction"
      />

      <DidMaintenanceList :items="configIntentItems" />

      <div class="grid gap-6 xl:grid-cols-3">
        <section
          class="rounded-xl border border-sa-border bg-sa-panel/40 p-5 space-y-4"
        >
          <div>
            <p class="text-xs uppercase text-sa-muted font-bold">
              {{ t("didPanel.stepBind", "1. Bind NeoDID") }}
              {{ bindStatusLabel }}
            </p>
            <p class="mt-1 text-sm text-sa-text">
              {{
                t(
                  "didPanel.stepBindHint",
                  "Seal the live Web3Auth id_token locally, then let the TEE derive the stable identity root inside Morpheus.",
                )
              }}
            </p>
          </div>
          <label for="did-panel-vault-script-hash" class="block text-sm">
            <span class="text-sa-muted">{{
              t("didPanel.vaultScriptHash", "Vault Script Hash")
            }}</span>
            <input
              id="did-panel-vault-script-hash"
              v-model="vaultAccount"
              class="mt-1 input-field"
              :placeholder="t('operations.hexPlaceholder', '0x...')"
            />
          </label>
          <label for="did-panel-claim-type" class="block text-sm">
            <span class="text-sa-muted">{{
              t("didPanel.claimType", "Claim Type")
            }}</span>
            <input
              id="did-panel-claim-type"
              v-model="claimType"
              class="mt-1 input-field"
            />
          </label>
          <label for="did-panel-claim-value" class="block text-sm">
            <span class="text-sa-muted">{{
              t("didPanel.claimValue", "Claim Value")
            }}</span>
            <input
              id="did-panel-claim-value"
              v-model="claimValue"
              class="mt-1 input-field"
            />
          </label>
          <button
            class="btn-secondary w-full"
            :aria-label="
              t('operations.ariaBindDidMorpheus', 'Bind DID with Morpheus')
            "
            :class="{ 'btn-loading': busy === 'bind' }"
            :disabled="!didConnected || !vaultAccount || busy === 'bind'"
            @click="bindDidAction"
          >
            {{
              busy === "bind"
                ? t("didPanel.binding", "Binding…")
                : t("didPanel.bindAction", "Bind DID with Morpheus")
            }}
          </button>

          <div
            v-if="delegatedIdentityParamsHex"
            class="rounded-xl border border-sa-info/20 bg-sa-info/5 p-4 space-y-3"
          >
            <div class="flex items-start justify-between gap-4">
              <div>
                <p class="text-xs uppercase text-sa-info font-bold">
                  {{
                    t("didPanel.delegatedIdentityParamsTitle", "Delegated Identity Params")
                  }}
                </p>
                <p class="mt-1 text-xs text-sa-muted">
                  {{
                    t(
                      "didPanel.delegatedIdentityParamsHint",
                      "Use this hex when installing the DelegatedIdentityValidator for the currently connected Web3Auth identity.",
                    )
                  }}
                </p>
              </div>
              <button
                class="btn-secondary btn-xs"
                :aria-label="
                  t(
                    'didPanel.copyDelegatedIdentityParams',
                    'Copy delegated identity params',
                  )
                "
                :disabled="!delegatedIdentityParamsHex"
                @click="copyDelegatedIdentityParams"
              >
                <span class="flex items-center gap-1.5">
                  <svg
                    aria-hidden="true"
                    v-if="copiedKey !== 'delegated-identity-params'"
                    class="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                    ></path>
                  </svg>
                  <svg
                    aria-hidden="true"
                    v-else
                    class="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M5 13l4 4L19 7"
                    ></path>
                  </svg>
                  {{
                    copiedKey === "delegated-identity-params"
                      ? t("operations.copied", "Copied!")
                      : t("operations.copy", "Copy")
                  }}
                </span>
              </button>
            </div>

            <p class="font-mono text-xs break-all text-sa-text">
              0x{{ delegatedIdentityParamsHex }}
            </p>

            <details
              class="rounded-lg border border-sa-border bg-sa-panel/30 p-3"
            >
              <summary
                class="cursor-pointer text-xs font-semibold text-sa-muted hover:text-sa-text transition-colors duration-200 flex items-center gap-2"
              >
                <svg
                  aria-hidden="true"
                  class="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  ></path>
                </svg>
                {{
                  t("didPanel.delegatedIdentityParamsDetails", "Show underlying fields")
                }}
              </summary>
              <div class="mt-3 space-y-3">
                <div v-if="delegatedIdentityPublicKey" class="space-y-1">
                  <div class="flex items-center justify-between gap-3">
                    <p class="text-xs uppercase text-sa-muted font-bold">
                      {{ t("didPanel.delegatedIdentitySignerKey", "Signer Public Key") }}
                    </p>
                    <button
                      class="btn-secondary btn-xs"
                      :aria-label="
                        t(
                          'didPanel.copyDelegatedIdentityPublicKey',
                          'Copy delegated identity public key',
                        )
                      "
                      @click="copyDelegatedIdentityPublicKey"
                    >
                      <span class="flex items-center gap-1.5">
                        <svg
                          aria-hidden="true"
                          v-if="copiedKey !== 'delegated-identity-pubkey'"
                          class="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                          ></path>
                        </svg>
                        <svg
                          aria-hidden="true"
                          v-else
                          class="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M5 13l4 4L19 7"
                          ></path>
                        </svg>
                        {{
                          copiedKey === "delegated-identity-pubkey"
                            ? t("operations.copied", "Copied!")
                            : t("operations.copy", "Copy")
                        }}
                      </span>
                    </button>
                  </div>
                  <p class="font-mono text-xs break-all text-sa-muted">
                    0x{{ delegatedIdentityPublicKey }}
                  </p>
                </div>

                <div v-if="delegatedIdentityMasterNullifier" class="space-y-1">
                  <div class="flex items-center justify-between gap-3">
                    <p class="text-xs uppercase text-sa-muted font-bold">
                      {{
                        t("didPanel.delegatedIdentityMasterNullifier", "Master Nullifier")
                      }}
                    </p>
                    <button
                      class="btn-secondary btn-xs"
                      :aria-label="
                        t(
                          'didPanel.copyDelegatedIdentityNullifier',
                          'Copy identity master nullifier',
                        )
                      "
                      @click="copyDelegatedIdentityNullifier"
                    >
                      <span class="flex items-center gap-1.5">
                        <svg
                          aria-hidden="true"
                          v-if="copiedKey !== 'delegated-identity-nullifier'"
                          class="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                          ></path>
                        </svg>
                        <svg
                          aria-hidden="true"
                          v-else
                          class="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M5 13l4 4L19 7"
                          ></path>
                        </svg>
                        {{
                          copiedKey === "delegated-identity-nullifier"
                            ? t("operations.copied", "Copied!")
                            : t("operations.copy", "Copy")
                        }}
                      </span>
                    </button>
                  </div>
                  <p class="font-mono text-xs break-all text-sa-muted">
                    0x{{ delegatedIdentityMasterNullifier }}
                  </p>
                </div>
              </div>
            </details>
          </div>
        </section>

        <section
          class="rounded-xl border border-sa-border bg-sa-panel/40 p-5 space-y-4"
        >
          <div>
            <p class="text-xs uppercase text-sa-muted font-bold">
              {{ t("didPanel.stepRecovery", "2. Social Recovery") }}
              {{ recoveryStatusLabel }}
            </p>
            <p class="mt-1 text-sm text-sa-text">
              {{
                t(
                  "didPanel.stepRecoveryHint",
                  "Submit a Morpheus recovery request through the delegated recovery service for the currently connected Web3Auth identity.",
                )
              }}
            </p>
          </div>
          <div class="block text-sm">
            <p class="text-sa-muted">{{
              t("didPanel.recoveryServiceHash", "Recovery Service")
            }}</p>
            <p class="mt-1 font-mono text-xs break-all text-sa-text">
              {{ recoveryServiceHash || t("didPanel.unset", "unset") }}
            </p>
          </div>
          <label for="did-panel-recovery-new-owner" class="block text-sm">
            <span class="text-sa-muted">{{
              t("didPanel.newOwnerAddress", "New Owner Address / Script Hash")
            }}</span>
            <input
              id="did-panel-recovery-new-owner"
              v-model="recoveryNewOwner"
              class="mt-1 input-field"
              :placeholder="
                t('operations.neoOrHexPlaceholder', 'N... or 0x...')
              "
            />
          </label>
          <label for="did-panel-recovery-expiry" class="block text-sm">
            <span class="text-sa-muted">{{
              t("didPanel.expiryMinutes", "Expiry (minutes)")
            }}</span>
            <input
              id="did-panel-recovery-expiry"
              v-model="recoveryExpiryMinutes"
              type="number"
              min="1"
              class="mt-1 input-field"
            />
          </label>
          <div class="flex gap-3">
            <button
              class="btn-secondary flex-1"
              :aria-label="
                t(
                  'operations.ariaPreviewRecoveryTicket',
                  'Preview recovery ticket',
                )
              "
              :class="{ 'btn-loading': busy === 'previewRecovery' }"
              :disabled="!canPreviewRecovery || busy === 'previewRecovery'"
              @click="previewRecoveryAction"
            >
              {{
                busy === "previewRecovery"
                  ? t("didPanel.preparingTicket", "Preparing…")
                  : t("didPanel.previewTicket", "Preview Ticket")
              }}
            </button>
            <button
              class="btn-primary flex-1"
              :aria-label="
                t('operations.ariaInvokeRecovery', 'Invoke recovery')
              "
              :class="{ 'btn-loading': busy === 'invokeRecovery' }"
              :disabled="!canInvokeRecovery || busy === 'invokeRecovery'"
              @click="invokeRecoveryAction"
            >
              {{
                busy === "invokeRecovery"
                  ? t("didPanel.requestingRecovery", "Requesting…")
                  : t("didPanel.invokeRecovery", "Invoke Recovery")
              }}
            </button>
          </div>
        </section>

        <section
          class="rounded-xl border border-sa-border bg-sa-panel/40 p-5 space-y-4"
        >
          <div>
            <p class="text-xs uppercase text-sa-muted font-bold">
              {{ t("didPanel.stepPrivateActions", "3. Private Actions") }}
              {{ sessionStatusLabel }}
            </p>
            <p class="mt-1 text-sm text-sa-text">
              {{
                t(
                  "didPanel.stepPrivateActionsHint",
                  "Create a short-lived private execution session without exposing the long-term identity root on-chain.",
                )
              }}
            </p>
          </div>
          <div class="block text-sm">
            <p class="text-sa-muted">{{
              t("didPanel.proxyServiceHash", "Private Session Service")
            }}</p>
            <p class="mt-1 font-mono text-xs break-all text-sa-text">
              {{ proxyServiceHash || t("didPanel.unset", "unset") }}
            </p>
          </div>
          <div class="rounded-xl border border-sa-border p-3 space-y-2">
            <p class="text-sm">Action identities require a separate owner-wallet enrollment. Recovery factors do not grant session access.</p>
            <label for="did-panel-action-identity" class="block text-sm">Action master nullifier (32 bytes)</label>
            <input id="did-panel-action-identity" v-model="actionMasterNullifier" class="input-field" :placeholder="delegatedIdentityMasterNullifier || '0x...'" />
            <div class="flex gap-3">
              <button class="btn-secondary" :disabled="Boolean(busy) || !hasProxyPreviewContext || Number(proxyRecoveryState?.actionProtocolVersion) !== 4" @click="manageActionIdentity(true)">Enroll action identity — owner signature</button>
              <button class="btn-secondary" :disabled="Boolean(busy) || !hasProxyPreviewContext || Number(proxyRecoveryState?.actionProtocolVersion) !== 4" @click="manageActionIdentity(false)">Revoke action identity — owner signature</button>
            </div>
            <div v-if="proxyRecoveryState?.activeSession?.active" class="text-sm">
              <p v-if="!proxyRecoveryState.actionSessionAuthorized">Stored session requires current-owner approval or a new session from an enrolled identity.</p>
              <p>Stored executor: {{ proxyRecoveryState.activeSession.executor }}; expiry: {{ proxyRecoveryState.activeSession.expiresAt }}</p>
              <button class="btn-secondary" :disabled="Boolean(busy) || !hasProxyPreviewContext || Number(proxyRecoveryState?.actionProtocolVersion) !== 4" @click="reauthorizeActionSession">Reauthorize this displayed session — owner signature</button>
            </div>
          </div>
          <label for="did-panel-proxy-executor" class="block text-sm">
            <span class="text-sa-muted">{{
              t("didPanel.executorAddress", "Executor Address / Script Hash")
            }}</span>
            <input
              id="did-panel-proxy-executor"
              v-model="proxyExecutor"
              class="mt-1 input-field"
              :placeholder="
                t('operations.neoOrHexPlaceholder', 'N... or 0x...')
              "
            />
          </label>
          <label for="did-panel-proxy-expiry" class="block text-sm">
            <span class="text-sa-muted">{{
              t("didPanel.expiryMinutes", "Expiry (minutes)")
            }}</span>
            <input
              id="did-panel-proxy-expiry"
              v-model="proxyExpiryMinutes"
              type="number"
              min="1"
              class="mt-1 input-field"
            />
          </label>
          <div class="flex gap-3">
            <button
              class="btn-secondary flex-1"
              :aria-label="
                t('operations.ariaPreviewProxyTicket', 'Preview proxy ticket')
              "
              :class="{ 'btn-loading': busy === 'previewProxy' }"
              :disabled="!canPreviewProxy || busy === 'previewProxy'"
              @click="previewProxyAction"
            >
              {{
                busy === "previewProxy"
                  ? t("didPanel.preparingTicket", "Preparing…")
                  : t("didPanel.previewTicket", "Preview Ticket")
              }}
            </button>
            <button
              class="btn-primary flex-1"
              :aria-label="
                t('operations.ariaInvokeProxySession', 'Invoke proxy session')
              "
              :class="{ 'btn-loading': busy === 'invokeProxy' }"
              :disabled="!canInvokeProxy || busy === 'invokeProxy'"
              @click="invokeProxyAction"
            >
              {{
                busy === "invokeProxy"
                  ? t("didPanel.requestingSession", "Requesting…")
                  : t("didPanel.invokeSession", "Invoke Session")
              }}
            </button>
          </div>
        </section>
      </div>

      <div
        v-if="resultJson"
        class="rounded-xl border border-sa-border bg-sa-dark/70 p-4"
      >
        <div class="flex items-center justify-between mb-2">
          <p class="text-xs uppercase text-sa-muted font-bold">
            {{ t("didPanel.latestResult", "Latest Result") }}
          </p>
          <button
            class="btn-secondary btn-xs"
            :aria-label="t('operations.ariaCopyResult', 'Copy result')"
            @click="copyResult"
          >
            <span class="flex items-center gap-1.5">
              <svg
                aria-hidden="true"
                v-if="copiedKey !== 'result'"
                class="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                ></path>
              </svg>
              <svg
                aria-hidden="true"
                v-else
                class="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M5 13l4 4L19 7"
                ></path>
              </svg>
              {{
                copiedKey === "result"
                  ? t("operations.copied", "Copied!")
                  : t("operations.copy", "Copy")
              }}
            </span>
          </button>
        </div>
        <pre class="text-xs text-sa-text whitespace-pre-wrap break-all">{{
          resultJson
        }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { useI18n } from "@/i18n";
import { useToast } from "vue-toastification";
import { useClipboard } from "@/composables/useClipboard.js";
import { useDidConnection } from "@/composables/useDidConnection.js";
import {
  morpheusDidService,
  fetchAccountIdentity,
  fetchAccountRecoveryState,
} from "@/services/morpheusDidService.js";
import { notificationService } from "@/services/notificationService.js";
import { getSmartAccountHash } from "@/services/walletService.js";
import { getScriptHashFromAddress } from "@/utils/neo.js";
import { sanitizeHex } from "@/utils/hex.js";
import { RUNTIME_CONFIG } from "@/config/runtimeConfig.js";
import { translateError } from "@/config/errorCodes.js";
import DidIdentitySummaryGrids from "./DidIdentityPanel/DidIdentitySummaryGrids.vue";
import DidRecoveryStateGrid from "./DidIdentityPanel/DidRecoveryStateGrid.vue";
import DidPendingStateCards from "./DidIdentityPanel/DidPendingStateCards.vue";
import DidMaintenanceList from "./DidIdentityPanel/DidMaintenanceList.vue";

const props = defineProps({
  saContractHash: {
    type: String,
    default: "",
  },
  accountAddressScriptHash: {
    type: String,
    default: "",
  },
  accountIdPrefill: {
    type: String,
    default: "",
  },
  neoWalletAddress: {
    type: String,
    default: "",
  },
  recoveryNewOwnerPrefill: {
    type: String,
    default: "",
  },
  recoveryExpiryPrefill: {
    type: [String, Number],
    default: "",
  },
  autoPreviewRecovery: {
    type: Boolean,
    default: false,
  },
});
const emit = defineEmits(["status", "activity"]);

const { t } = useI18n();
const toast = useToast();
const {
  isConfigured: didAvailableRef,
  isConnected: didConnectedRef,
  didProfile,
  connectDid,
  disconnectDid,
} = useDidConnection();
const didAvailable = computed(() => didAvailableRef.value);
const didConnected = computed(() => didConnectedRef.value);
const linkedAccountsLabel = computed(
  () =>
    (didProfile.value?.linkedAccounts || []).join(", ") ||
    t("operations.none", "none"),
);
const serviceDid = computed(
  () => didProfile.value?.serviceDid || RUNTIME_CONFIG.morpheusNeoDidServiceDid,
);
const resolverUrl = computed(() => {
  const endpoint = String(
    RUNTIME_CONFIG.morpheusNeoDidResolveEndpoint ||
      "/api/morpheus-neodid?action=resolve",
  );
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${separator}did=${encodeURIComponent(serviceDid.value)}`;
});
const runtimeSummary = computed(() =>
  didConnected.value
    ? t(
        "didPanel.runtimeConnected",
        "Web3Auth connected. NeoDID requests will use encrypted id_token input and Oracle callback routing.",
      )
    : t(
        "didPanel.runtimeDisconnected",
        "Connect Web3Auth to prepare encrypted NeoDID requests.",
      ),
);
const canEmailNotice = computed(() =>
  Boolean(notificationService.canEmail && didProfile.value?.email),
);
const canSmsNotice = computed(() =>
  Boolean(notificationService.canSms && didProfile.value?.phone),
);
const resolvedAccountId = ref("");
const recoveryState = ref(null);
const recoveryStateContext = ref(null);
// Recovery and private-session views read one on-chain snapshot, so the
// "proxy" surface mirrors the same state instead of a second contract read.
const proxyRecoveryState = computed(() => recoveryState.value);
const proxyRecoveryStateContext = computed(() => recoveryStateContext.value);
const busy = ref("");
const resultJson = ref("");
const { copiedKey, markCopied, copyText: clipboardCopy } = useClipboard();
const expanded = ref(true);
const bindResponse = ref(null);

const delegatedIdentityParamsHex = computed(() =>
  sanitizeHex(
    bindResponse.value?.zklogin_verifier_params_hex ||
      bindResponse.value?.verifier_params_hex ||
      "",
  ),
);
const delegatedIdentityPublicKey = computed(() =>
  sanitizeHex(
    bindResponse.value?.public_key || bindResponse.value?.publicKey || "",
  ),
);
const delegatedIdentityMasterNullifier = computed(() =>
  sanitizeHex(
    bindResponse.value?.master_nullifier ||
      bindResponse.value?.masterNullifier ||
      "",
  ),
);

const vaultAccount = ref("");
const claimType = ref("Web3Auth_PrimaryIdentity");
const claimValue = ref("verified");
const recoveryNewOwner = ref("");
const recoveryExpiryMinutes = ref(30);
// Both surfaces resolve the service the installed ActionSessionValidator
// delegates to; the user never types a service hash.
const recoveryServiceHash = computed(() =>
  sanitizeHex(recoveryState.value?.recoveryServiceHash || ""),
);
const proxyServiceHash = computed(() => recoveryServiceHash.value);
const proxyExecutor = ref("");
const proxyExpiryMinutes = ref(15);
const actionMasterNullifier = ref("");
const bindStatusLabel = computed(() =>
  didConnected.value
    ? t("didPanel.statusReady", "(ready)")
    : t("didPanel.statusConnectDid", "(connect Web3Auth)"),
);
const recoveryStatusLabel = computed(() =>
  recoveryState.value?.pendingRecovery?.active
    ? t("didPanel.statusPending", "(pending)")
    : t("didPanel.statusReady", "(ready)"),
);
const sessionStatusLabel = computed(() =>
  proxyRecoveryState.value?.activeSession?.active && proxyRecoveryState.value?.actionSessionAuthorized
    ? t("didPanel.statusActive", "(active)")
    : t("didPanel.statusReady", "(ready)"),
);

function formatScheduledTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return raw;
  const millis = raw.length >= 13 ? numeric : numeric * 1000;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return raw;
  return `${date.toISOString()} (${raw})`;
}

const configIntentItems = computed(() => {
  const intents = recoveryState.value?.pendingConfiguration?.intents || [];
  return intents.map((intent) => ({
    id: `config-intent-${intent.intentId}`,
    title: t("didPanel.configIntentTitle", "Configuration Intent #{intentId}", {
      intentId: intent.intentId,
    }),
    description: t(
      "didPanel.configIntentHint",
      "One 24-hour intent holds {count} action(s); confirmation re-requires the custody witness.",
      { count: intent.actionCount },
    ),
    matureAt: formatScheduledTimestamp(intent.matureAt),
    expiresAt: formatScheduledTimestamp(intent.expiresAt),
    actionDigest: intent.actionDigest,
  }));
});
const prefillRecoveryNewOwner = computed(() =>
  String(props.recoveryNewOwnerPrefill || "").trim(),
);
const prefillRecoveryExpiryMinutes = computed(() => {
  const raw = Number(String(props.recoveryExpiryPrefill || "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
});
const autoRecoveryPreviewKey = ref("");

function normalizeHashOrAddress(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^[Nn]/.test(raw)) {
    return sanitizeHex(getScriptHashFromAddress(raw));
  }
  return sanitizeHex(raw);
}

function hasNonZeroHash160(value) {
  try {
    const normalized = normalizeHashOrAddress(value);
    return /^[0-9a-f]{40}$/.test(normalized) && normalized !== "00".repeat(20);
  } catch {
    return false;
  }
}

function hasRequiredText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toExpiry(minutes) {
  return Date.now() + Math.max(Number(minutes) || 0, 1) * 60 * 1000;
}

let accountContextRequestId = 0;
let recoveryStateRequestId = 0;
async function refreshAccountContext() {
  const requestId = ++accountContextRequestId;
  // Invalidate earlier reads before clearing context, including an in-flight
  // state response from another core with the same account-ID prefill.
  ++recoveryStateRequestId;
  resolvedAccountId.value = "";
  recoveryState.value = null;
  recoveryStateContext.value = null;
  if (!props.accountIdPrefill && !props.accountAddressScriptHash) return;
  try {
    const identity = await fetchAccountIdentity({
      rpcUrl: RUNTIME_CONFIG.rpcUrl,
      saContractHash: props.saContractHash || getSmartAccountHash(),
      accountIdHex: props.accountIdPrefill,
      accountAddressScriptHash: props.accountAddressScriptHash,
    });
    if (requestId !== accountContextRequestId) return;
    resolvedAccountId.value = identity.accountIdHex;
  } catch (error) {
    if (requestId !== accountContextRequestId) return;
    if (import.meta.env.DEV)
      console.error(
        "[DidIdentityPanel] refreshAccountContext failed:",
        error?.message,
      );
    toast.error(translateError(error?.message, t));
  }
}

watch(
  () => [props.accountAddressScriptHash, props.accountIdPrefill, props.saContractHash, RUNTIME_CONFIG.rpcUrl],
  () => { void refreshAccountContext(); },
  { immediate: true },
);

watch(
  () => [
    prefillRecoveryNewOwner.value,
    prefillRecoveryExpiryMinutes.value,
    props.autoPreviewRecovery,
  ],
  () => {
    if (prefillRecoveryNewOwner.value) {
      recoveryNewOwner.value = prefillRecoveryNewOwner.value;
    }
    if (prefillRecoveryExpiryMinutes.value > 0) {
      recoveryExpiryMinutes.value = prefillRecoveryExpiryMinutes.value;
    }
    if (props.autoPreviewRecovery) {
      expanded.value = true;
      autoRecoveryPreviewKey.value = "";
    }
  },
  { immediate: true },
);

function getRecoveryContext() {
  const contextHash = (value) => (hasNonZeroHash160(value) ? normalizeHashOrAddress(value) : "");
  return {
    rpcUrl: RUNTIME_CONFIG.rpcUrl,
    saContractHash: contextHash(props.saContractHash || getSmartAccountHash()),
    accountIdHex: contextHash(resolvedAccountId.value),
  };
}

function sameRecoveryContext(left, right) {
  return Boolean(left && right &&
    left.rpcUrl === right.rpcUrl &&
    left.saContractHash === right.saContractHash &&
    left.accountIdHex === right.accountIdHex);
}

watch(
  () => getRecoveryContext(),
  (context) => { void refreshRecoveryState(context); },
  { flush: "sync" },
);

async function refreshRecoveryState(context) {
  const requestId = ++recoveryStateRequestId;
  recoveryState.value = null;
  recoveryStateContext.value = null;
  if (!context.accountIdHex || !context.saContractHash) return false;
  try {
    const state = await fetchAccountRecoveryState({
      rpcUrl: context.rpcUrl,
      saContractHash: context.saContractHash,
      accountIdHex: context.accountIdHex,
    });
    if (requestId !== recoveryStateRequestId ||
        !sameRecoveryContext(context, getRecoveryContext())) return false;
    recoveryState.value = state;
    recoveryStateContext.value = context;
    return true;
  } catch (error) {
    if (requestId !== recoveryStateRequestId) return false;
    if (import.meta.env.DEV)
      console.error("[DidIdentityPanel] refreshRecoveryState failed:", error?.message);
    toast.error(translateError(error?.message, t));
    return false;
  }
}

async function refreshRecoveryStateAction() {
  busy.value = "refreshState";
  try {
    const refreshed = await refreshRecoveryState(getRecoveryContext());
    if (refreshed) {
      publishStatus(t("didPanel.refreshChainState", "Refresh Chain State"));
    }
  } finally {
    busy.value = "";
  }
}

watch(
  () => props.neoWalletAddress,
  (next) => {
    if (!next) return;
    try {
      vaultAccount.value = sanitizeHex(getScriptHashFromAddress(next));
    } catch (e) {
      if (import.meta.env.DEV)
        console.warn(
          "[DidIdentityPanel] neoWalletAddress script hash parse failed:",
          e?.message,
        );
      vaultAccount.value = "";
    }
  },
  { immediate: true },
);

function hasRecoveryPreviewContext(state, context) {
  const expected = getRecoveryContext();
  return Boolean(
    state &&
    sameRecoveryContext(context, expected) &&
    hasNonZeroHash160(state.recoveryServiceHash) &&
    hasNonZeroHash160(state.saContract) &&
    normalizeHashOrAddress(state.saContract) === expected.saContractHash &&
    hasRequiredText(state.network) &&
    hasRequiredText(state.accountIdText) &&
    hasNonZeroHash160(state.accountAddress) &&
    hasNonZeroHash160(resolvedAccountId.value),
  );
}
const hasPreviewContext = computed(() => hasRecoveryPreviewContext(
  recoveryState.value, recoveryStateContext.value,
));
const hasProxyPreviewContext = computed(() => hasRecoveryPreviewContext(
  proxyRecoveryState.value, proxyRecoveryStateContext.value,
));
const canInvokeRecovery = computed(
  () =>
    Boolean(
      didConnected.value &&
      recoveryState.value?.recoveryServiceHash &&
      recoveryNewOwner.value &&
      resolvedAccountId.value,
    ),
);
const canPreviewRecovery = computed(
  () =>
    Boolean(
      canInvokeRecovery.value &&
      hasPreviewContext.value &&
      hasNonZeroHash160(recoveryState.value?.recoveryServiceHash) &&
      hasNonZeroHash160(recoveryNewOwner.value),
    ),
);
const canInvokeProxy = computed(
  () =>
    Boolean(
      didConnected.value &&
      recoveryServiceHash.value &&
      proxyExecutor.value &&
      resolvedAccountId.value &&
      Number(proxyRecoveryState.value?.actionProtocolVersion) === 4 &&
      /^[1-9][0-9]*$/.test(String(proxyRecoveryState.value?.actionAuthorizationEpoch || "")),
    ),
);
const canPreviewProxy = computed(
  () =>
    Boolean(
      canInvokeProxy.value &&
      hasProxyPreviewContext.value &&
      Number(proxyRecoveryState.value?.actionProtocolVersion) === 4 &&
      /^[1-9][0-9]*$/.test(String(proxyRecoveryState.value?.actionAuthorizationEpoch || "")) &&
      hasNonZeroHash160(recoveryServiceHash.value) &&
      hasNonZeroHash160(proxyExecutor.value),
    ),
);

watch(
  () => [
    props.autoPreviewRecovery,
    didConnected.value,
    canPreviewRecovery.value,
    resolvedAccountId.value,
    recoveryServiceHash.value,
    recoveryNewOwner.value,
    recoveryExpiryMinutes.value,
  ],
  async ([
    autoPreview,
    connected,
    canPreview,
    accountId,
    verifier,
    newOwner,
    expiry,
  ]) => {
    if (!autoPreview || !connected || !canPreview) return;
    const nextKey = [accountId, verifier, newOwner, expiry].join("|");
    if (!nextKey || autoRecoveryPreviewKey.value === nextKey || busy.value)
      return;
    autoRecoveryPreviewKey.value = nextKey;
    await previewRecoveryAction();
  },
);

function publishStatus(message) {
  emit("status", message);
}

function publishActivity(type, detail) {
  emit("activity", { type, actor: "did", detail });
}

async function connectDidAction(loginProvider = "") {
  busy.value =
    loginProvider === "google"
      ? "connectGoogle"
      : loginProvider === "email_passwordless"
        ? "connectEmail"
        : loginProvider === "sms_passwordless"
          ? "connectSms"
          : "connectDid";
  try {
    await connectDid(loginProvider ? { loginProvider } : {});
    publishStatus(t("nav.connectDid", "Connect Web3Auth"));
    publishActivity("did_connected", loginProvider || "web3auth");
  } catch (err) {
    toast.error(translateError(err?.message, t));
  } finally {
    busy.value = "";
  }
}

async function disconnectDidAction() {
  busy.value = "disconnectDid";
  try {
    await disconnectDid();
    publishStatus(t("nav.disconnectDid", "Disconnect Web3Auth"));
    publishActivity("did_disconnected", "web3auth");
  } catch (err) {
    toast.error(translateError(err?.message, t));
  } finally {
    busy.value = "";
  }
}

async function bindDidAction() {
  busy.value = "bind";
  try {
    const response = await morpheusDidService.bindDid({
      vaultAccount: vaultAccount.value,
      claimType: claimType.value,
      claimValue: claimValue.value,
      metadata: {
        sa_contract: props.saContractHash || getSmartAccountHash(),
        account_address: props.accountAddressScriptHash || undefined,
        account_id: resolvedAccountId.value || undefined,
      },
    });
    bindResponse.value = response;
    resultJson.value = JSON.stringify(response, null, 2);
    publishStatus(t("didPanel.bindAction", "Bind DID with Morpheus"));
    publishActivity(
      "did_bound",
      t(
        "didPanel.activity.didBound",
        "Web3Auth DID bound through Morpheus NeoDID",
      ),
    );
  } catch (err) {
    toast.error(translateError(err?.message, t));
  } finally {
    busy.value = "";
  }
}

async function resolveServiceDidAction() {
  busy.value = "resolveServiceDid";
  try {
    const response = await morpheusDidService.resolveDid({
      did: serviceDid.value,
    });
    resultJson.value = JSON.stringify(response, null, 2);
    publishStatus(t("didPanel.resolveServiceDid", "Resolve Service DID"));
    publishActivity(
      "did_resolved",
      t(
        "didPanel.activity.didResolved",
        "Morpheus NeoDID service DID resolved",
      ),
    );
  } catch (err) {
    toast.error(translateError(err?.message, t));
  } finally {
    busy.value = "";
  }
}

async function previewRecoveryAction() {
  if (!canPreviewRecovery.value || !hasRecoveryPreviewContext(
    recoveryState.value, recoveryStateContext.value,
  )) return;
  busy.value = "previewRecovery";
  try {
    const response = await morpheusDidService.previewRecoveryTicket({
      network: recoveryState.value?.network,
      saContract: recoveryState.value?.saContract,
      verifierContract: recoveryServiceHash.value,
      accountId: resolvedAccountId.value,
      accountIdText: recoveryState.value?.accountIdText,
      accountIdRaw: resolvedAccountId.value,
      accountAddress: recoveryState.value?.accountAddress,
      newOwner: recoveryNewOwner.value,
      recoveryNonce: recoveryState.value?.recoveryNonce || 0,
      expiresAt: toExpiry(recoveryExpiryMinutes.value),
    });
    resultJson.value = JSON.stringify(response, null, 2);
    publishStatus(t("didPanel.previewTicket", "Preview Ticket"));
  } catch (err) {
    toast.error(translateError(err?.message, t));
  } finally {
    busy.value = "";
  }
}

async function invokeRecoveryAction() {
  busy.value = "invokeRecovery";
  try {
    const response = await morpheusDidService.invokeRecoveryRequest({
      verifierHash: recoveryServiceHash.value,
      accountIdHex: resolvedAccountId.value,
      newOwner: recoveryNewOwner.value,
      expiresAt: toExpiry(recoveryExpiryMinutes.value),
    });
    resultJson.value = JSON.stringify(response, null, 2);
    publishStatus(t("didPanel.invokeRecovery", "Invoke Recovery"));
    publishActivity(
      "recovery_requested",
      t(
        "didPanel.activity.recoveryRequested",
        "Morpheus social recovery request submitted",
      ),
    );
  } catch (err) {
    toast.error(translateError(err?.message, t));
  } finally {
    busy.value = "";
  }
}

async function previewProxyAction() {
  if (!canPreviewProxy.value || !hasRecoveryPreviewContext(
    proxyRecoveryState.value, proxyRecoveryStateContext.value,
  )) return;
  busy.value = "previewProxy";
  try {
    const response = await morpheusDidService.previewActionTicket({
      network: proxyRecoveryState.value?.network,
      saContract: proxyRecoveryState.value?.saContract,
      verifierContract: recoveryServiceHash.value,
      accountId: resolvedAccountId.value,
      accountIdText: proxyRecoveryState.value?.accountIdText,
      accountIdRaw: resolvedAccountId.value,
      executor: proxyExecutor.value,
      sessionNonce: proxyRecoveryState.value?.sessionNonce || 0,
      authorizationEpoch: proxyRecoveryState.value?.actionAuthorizationEpoch,
      expiresAt: toExpiry(proxyExpiryMinutes.value),
    });
    resultJson.value = JSON.stringify(response, null, 2);
    publishStatus(t("didPanel.previewTicket", "Preview Ticket"));
  } catch (err) {
    toast.error(translateError(err?.message, t));
  } finally {
    busy.value = "";
  }
}

async function invokeProxyAction() {
  if (!canInvokeProxy.value || !hasRecoveryPreviewContext(proxyRecoveryState.value, proxyRecoveryStateContext.value)) return;
  busy.value = "invokeProxy";
  try {
    const response = await morpheusDidService.invokeProxySessionRequest({
      verifierHash: recoveryServiceHash.value,
      accountIdHex: resolvedAccountId.value,
      executor: proxyExecutor.value,
      expiresAt: toExpiry(proxyExpiryMinutes.value),
    });
    resultJson.value = JSON.stringify(response, null, 2);
    publishStatus(t("didPanel.invokeSession", "Invoke Session"));
    publishActivity(
      "proxy_session_requested",
      t(
        "didPanel.activity.proxySessionRequested",
        "Morpheus proxy session request submitted",
      ),
    );
  } catch (err) {
    toast.error(translateError(err?.message, t));
  } finally {
    busy.value = "";
  }
}

// Every management operation is an explicit owner-wallet transaction. The
// read provenance guard is UX protection; current-owner witness is enforced on-chain.
async function manageActionIdentity(enabled) {
  if (Number(proxyRecoveryState.value?.actionProtocolVersion) !== 4 || !hasRecoveryPreviewContext(proxyRecoveryState.value, proxyRecoveryStateContext.value)) return;
  const masterNullifier = actionMasterNullifier.value || delegatedIdentityMasterNullifier.value;
  if (!/^[0-9a-f]{64}$/i.test(sanitizeHex(masterNullifier))) return;
  busy.value = "actionEnrollment";
  try {
    const response = await morpheusDidService.setActionIdentity({ verifierHash: recoveryServiceHash.value,
      accountIdHex: resolvedAccountId.value, masterNullifier, enabled });
    resultJson.value = JSON.stringify(response, null, 2);
  } catch (err) { toast.error(translateError(err?.message, t)); }
  finally { busy.value = ""; }
}

async function reauthorizeActionSession() {
  if (Number(proxyRecoveryState.value?.actionProtocolVersion) !== 4 || !hasRecoveryPreviewContext(proxyRecoveryState.value, proxyRecoveryStateContext.value)) return;
  const session = proxyRecoveryState.value?.activeSession;
  if (!session?.active) return;
  busy.value = "reauthorizeAction";
  try {
    const response = await morpheusDidService.reauthorizeActiveActionSession({ verifierHash: recoveryServiceHash.value,
      accountIdHex: resolvedAccountId.value, session: { ...session } });
    resultJson.value = JSON.stringify(response, null, 2);
  } catch (err) { toast.error(translateError(err?.message, t)); }
  finally { busy.value = ""; }
}

async function finalizeRecoveryAction() {
  busy.value = "finalizeRecovery";
  try {
    const response = await morpheusDidService.finalizeRecovery({
      verifierHash: recoveryServiceHash.value,
      accountIdHex: resolvedAccountId.value,
    });
    resultJson.value = JSON.stringify(response, null, 2);
    publishStatus(t("didPanel.finalizeRecovery", "Finalize Recovery"));
    publishActivity(
      "recovery_finalized",
      t("didPanel.activity.recoveryFinalized", "Morpheus recovery finalized"),
    );
    await refreshRecoveryStateAction();
  } catch (err) {
    toast.error(translateError(err?.message, t));
  } finally {
    busy.value = "";
  }
}

async function cancelRecoveryAction() {
  busy.value = "cancelRecovery";
  try {
    const response = await morpheusDidService.cancelRecovery({
      verifierHash: recoveryServiceHash.value,
      accountIdHex: resolvedAccountId.value,
    });
    resultJson.value = JSON.stringify(response, null, 2);
    publishStatus(t("didPanel.cancelRecovery", "Cancel Recovery"));
    publishActivity(
      "recovery_cancelled",
      t("didPanel.activity.recoveryCancelled", "Morpheus recovery cancelled"),
    );
    await refreshRecoveryStateAction();
  } catch (err) {
    toast.error(translateError(err?.message, t));
  } finally {
    busy.value = "";
  }
}

async function revokeSessionAction() {
  busy.value = "revokeSession";
  try {
    const response = await morpheusDidService.revokeProxySession({
      verifierHash: recoveryServiceHash.value,
      accountIdHex: resolvedAccountId.value,
    });
    resultJson.value = JSON.stringify(response, null, 2);
    publishStatus(t("didPanel.revokeSession", "Revoke Session"));
    publishActivity(
      "proxy_session_revoked",
      t(
        "didPanel.activity.proxySessionRevoked",
        "Morpheus private session revoked",
      ),
    );
    await refreshRecoveryStateAction();
  } catch (err) {
    toast.error(translateError(err?.message, t));
  } finally {
    busy.value = "";
  }
}

async function copyResult() {
  if (!resultJson.value) return;
  if (await clipboardCopy(resultJson.value)) markCopied("result");
}

async function copyDelegatedIdentityParams() {
  if (!delegatedIdentityParamsHex.value) return;
  if (await clipboardCopy(`0x${sanitizeHex(delegatedIdentityParamsHex.value)}`))
    markCopied("delegated-identity-params");
}

async function copyDelegatedIdentityPublicKey() {
  if (!delegatedIdentityPublicKey.value) return;
  if (await clipboardCopy(`0x${sanitizeHex(delegatedIdentityPublicKey.value)}`))
    markCopied("delegated-identity-pubkey");
}

async function copyDelegatedIdentityNullifier() {
  if (!delegatedIdentityMasterNullifier.value) return;
  if (await clipboardCopy(`0x${sanitizeHex(delegatedIdentityMasterNullifier.value)}`))
    markCopied("delegated-identity-nullifier");
}

async function sendEmailNoticeAction() {
  busy.value = "notifyEmail";
  try {
    const response = await notificationService.sendRecoveryEmail({
      did: didProfile.value?.did,
      email: didProfile.value?.email,
      payload: {
        sa_contract: props.saContractHash || getSmartAccountHash(),
        account_id: resolvedAccountId.value || "",
        verifier: recoveryServiceHash.value || "",
      },
    });
    resultJson.value = JSON.stringify(response, null, 2);
    publishStatus(t("didPanel.sendEmailNotice", "Send Email Notice"));
    publishActivity(
      "did_notice_sent",
      t("didPanel.activity.emailNoticeSent", "Recovery email notice sent"),
    );
  } catch (err) {
    toast.error(translateError(err?.message, t));
  } finally {
    busy.value = "";
  }
}

async function sendSmsNoticeAction() {
  busy.value = "notifySms";
  try {
    const response = await notificationService.sendRecoverySms({
      did: didProfile.value?.did,
      phone: didProfile.value?.phone,
      payload: {
        sa_contract: props.saContractHash || getSmartAccountHash(),
        account_id: resolvedAccountId.value || "",
        verifier: recoveryServiceHash.value || "",
      },
    });
    resultJson.value = JSON.stringify(response, null, 2);
    publishStatus(t("didPanel.sendSmsNotice", "Send SMS Notice"));
    publishActivity(
      "did_notice_sent",
      t("didPanel.activity.smsNoticeSent", "Recovery SMS notice sent"),
    );
  } catch (err) {
    toast.error(translateError(err?.message, t));
  } finally {
    busy.value = "";
  }
}
</script>

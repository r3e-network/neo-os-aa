<template>
  <div
    class="rounded-[20px] border border-aa-border bg-aa-panel/60 overflow-hidden shadow-glow-panel backdrop-blur-lg transition-all duration-200"
  >
    <button
      @click="expanded = !expanded"
      :aria-expanded="expanded"
      aria-controls="did-panel-content"
      class="w-full bg-aa-panel/40 px-6 py-5 border-b border-aa-border flex items-center justify-between hover:bg-aa-dark/40 transition-colors duration-200"
    >
      <div class="flex items-center gap-4">
        <div
          class="w-8 h-8 rounded-full bg-aa-info/20 border border-aa-info/50 text-aa-info flex items-center justify-center font-bold text-sm shadow-glow-sky"
        >
          D
        </div>
        <h2 class="text-lg font-bold text-aa-text font-outfit">
          {{ t("didPanel.title", "NeoDID / Web3Auth") }}
        </h2>
      </div>
      <svg
        aria-hidden="true"
        class="w-4 h-4 text-aa-muted transform transition-transform duration-200"
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
      <div class="rounded-xl border border-aa-info/20 bg-aa-info/5 p-5">
        <div
          class="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between"
        >
          <div>
            <p class="text-xs uppercase text-aa-info font-bold mb-2">
              {{ t("didPanel.connectTitle", "Connect Web3Auth First") }}
            </p>
            <p class="text-sm text-aa-text leading-6">
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
        <div class="rounded-xl border border-aa-border bg-aa-panel/40 p-4">
          <p class="text-xs uppercase text-aa-muted font-bold mb-2">
            {{ t("didPanel.resolver", "Resolver") }}
          </p>
          <p class="text-sm text-aa-text break-all">{{ resolverUrl }}</p>
          <p class="mt-2 text-xs text-aa-muted">
            {{
              t(
                "didPanel.resolverHint",
                "Public DID resolution is metadata-only. Private JWT claims and nullifiers never appear in resolver output.",
              )
            }}
          </p>
        </div>
        <div class="rounded-xl border border-aa-border bg-aa-panel/40 p-4">
          <p class="text-xs uppercase text-aa-muted font-bold mb-2">
            {{ t("didPanel.runtimeStatus", "Runtime Status") }}
          </p>
          <p class="text-sm text-aa-text font-semibold break-all">
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
          @click="refreshVerifierStateAction"
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
        <span class="text-xs text-aa-muted">{{
          t(
            "didPanel.flowHint",
            "Recommended flow: Connect Web3Auth → Bind NeoDID → Start Recovery / Private Session → Finalize / Revoke.",
          )
        }}</span>
      </div>

      <DidVerifierStateGrid :verifier-state="verifierState" />

      <DidPendingStateCards
        :verifier-state="verifierState"
        :busy="busy"
        @finalize="finalizeRecoveryAction"
        @cancel="cancelRecoveryAction"
        @revoke="revokeSessionAction"
      />

      <DidMaintenanceList :items="maintenanceItems" />

      <div class="grid gap-6 xl:grid-cols-3">
        <section
          class="rounded-xl border border-aa-border bg-aa-panel/40 p-5 space-y-4"
        >
          <div>
            <p class="text-xs uppercase text-aa-muted font-bold">
              {{ t("didPanel.stepBind", "1. Bind NeoDID") }}
              {{ bindStatusLabel }}
            </p>
            <p class="mt-1 text-sm text-aa-text">
              {{
                t(
                  "didPanel.stepBindHint",
                  "Seal the live Web3Auth id_token locally, then let the TEE derive the stable identity root inside Morpheus.",
                )
              }}
            </p>
          </div>
          <label for="did-panel-vault-script-hash" class="block text-sm">
            <span class="text-aa-muted">{{
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
            <span class="text-aa-muted">{{
              t("didPanel.claimType", "Claim Type")
            }}</span>
            <input
              id="did-panel-claim-type"
              v-model="claimType"
              class="mt-1 input-field"
            />
          </label>
          <label for="did-panel-claim-value" class="block text-sm">
            <span class="text-aa-muted">{{
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
            v-if="zkloginVerifierParamsHex"
            class="rounded-xl border border-aa-info/20 bg-aa-info/5 p-4 space-y-3"
          >
            <div class="flex items-start justify-between gap-4">
              <div>
                <p class="text-xs uppercase text-aa-info font-bold">
                  {{
                    t("didPanel.zkloginParamsTitle", "ZK Login Verifier Params")
                  }}
                </p>
                <p class="mt-1 text-xs text-aa-muted">
                  {{
                    t(
                      "didPanel.zkloginParamsHint",
                      "Use this hex when deploying/binding the ZkLoginVerifier plugin for the currently connected Web3Auth identity.",
                    )
                  }}
                </p>
              </div>
              <button
                class="btn-secondary btn-xs"
                :aria-label="
                  t(
                    'didPanel.copyZkloginParams',
                    'Copy ZK login verifier params',
                  )
                "
                :disabled="!zkloginVerifierParamsHex"
                @click="copyZkloginVerifierParams"
              >
                <span class="flex items-center gap-1.5">
                  <svg
                    aria-hidden="true"
                    v-if="copiedKey !== 'zklogin-params'"
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
                    copiedKey === "zklogin-params"
                      ? t("operations.copied", "Copied!")
                      : t("operations.copy", "Copy")
                  }}
                </span>
              </button>
            </div>

            <p class="font-mono text-xs break-all text-aa-text">
              0x{{ zkloginVerifierParamsHex }}
            </p>

            <details
              class="rounded-lg border border-aa-border bg-aa-panel/30 p-3"
            >
              <summary
                class="cursor-pointer text-xs font-semibold text-aa-muted hover:text-aa-text transition-colors duration-200 flex items-center gap-2"
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
                  t("didPanel.zkloginParamsDetails", "Show underlying fields")
                }}
              </summary>
              <div class="mt-3 space-y-3">
                <div v-if="zkloginPublicKey" class="space-y-1">
                  <div class="flex items-center justify-between gap-3">
                    <p class="text-xs uppercase text-aa-muted font-bold">
                      {{ t("didPanel.zkloginSignerKey", "Signer Public Key") }}
                    </p>
                    <button
                      class="btn-secondary btn-xs"
                      :aria-label="
                        t(
                          'didPanel.copyZkloginPublicKey',
                          'Copy zklogin signer public key',
                        )
                      "
                      @click="copyZkloginPublicKey"
                    >
                      <span class="flex items-center gap-1.5">
                        <svg
                          aria-hidden="true"
                          v-if="copiedKey !== 'zklogin-pubkey'"
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
                          copiedKey === "zklogin-pubkey"
                            ? t("operations.copied", "Copied!")
                            : t("operations.copy", "Copy")
                        }}
                      </span>
                    </button>
                  </div>
                  <p class="font-mono text-xs break-all text-aa-muted">
                    0x{{ zkloginPublicKey }}
                  </p>
                </div>

                <div v-if="zkloginMasterNullifier" class="space-y-1">
                  <div class="flex items-center justify-between gap-3">
                    <p class="text-xs uppercase text-aa-muted font-bold">
                      {{
                        t("didPanel.zkloginMasterNullifier", "Master Nullifier")
                      }}
                    </p>
                    <button
                      class="btn-secondary btn-xs"
                      :aria-label="
                        t(
                          'didPanel.copyZkloginMasterNullifier',
                          'Copy zklogin master nullifier',
                        )
                      "
                      @click="copyZkloginMasterNullifier"
                    >
                      <span class="flex items-center gap-1.5">
                        <svg
                          aria-hidden="true"
                          v-if="copiedKey !== 'zklogin-master-nullifier'"
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
                          copiedKey === "zklogin-master-nullifier"
                            ? t("operations.copied", "Copied!")
                            : t("operations.copy", "Copy")
                        }}
                      </span>
                    </button>
                  </div>
                  <p class="font-mono text-xs break-all text-aa-muted">
                    0x{{ zkloginMasterNullifier }}
                  </p>
                </div>
              </div>
            </details>
          </div>
        </section>

        <section
          class="rounded-xl border border-aa-border bg-aa-panel/40 p-5 space-y-4"
        >
          <div>
            <p class="text-xs uppercase text-aa-muted font-bold">
              {{ t("didPanel.stepRecovery", "2. Social Recovery") }}
              {{ recoveryStatusLabel }}
            </p>
            <p class="mt-1 text-sm text-aa-text">
              {{
                t(
                  "didPanel.stepRecoveryHint",
                  "Submit a Morpheus recovery request through the bound verifier for the currently connected Web3Auth identity.",
                )
              }}
            </p>
          </div>
          <label for="did-panel-recovery-verifier-hash" class="block text-sm">
            <span class="text-aa-muted">{{
              t("didPanel.recoveryVerifierHash", "Recovery Verifier Hash")
            }}</span>
            <input
              id="did-panel-recovery-verifier-hash"
              v-model="recoveryVerifierHash"
              class="mt-1 input-field"
              :placeholder="t('operations.hexPlaceholder', '0x...')"
            />
          </label>
          <label for="did-panel-recovery-new-owner" class="block text-sm">
            <span class="text-aa-muted">{{
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
            <span class="text-aa-muted">{{
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
          class="rounded-xl border border-aa-border bg-aa-panel/40 p-5 space-y-4"
        >
          <div>
            <p class="text-xs uppercase text-aa-muted font-bold">
              {{ t("didPanel.stepPrivateActions", "3. Private Actions") }}
              {{ sessionStatusLabel }}
            </p>
            <p class="mt-1 text-sm text-aa-text">
              {{
                t(
                  "didPanel.stepPrivateActionsHint",
                  "Create a short-lived private execution session without exposing the long-term identity root on-chain.",
                )
              }}
            </p>
          </div>
          <label for="did-panel-proxy-verifier-hash" class="block text-sm">
            <span class="text-aa-muted">{{
              t("didPanel.proxyVerifierHash", "Proxy Verifier Hash")
            }}</span>
            <input
              id="did-panel-proxy-verifier-hash"
              v-model="proxyVerifierHash"
              class="mt-1 input-field"
              :placeholder="t('operations.hexPlaceholder', '0x...')"
            />
          </label>
          <label for="did-panel-proxy-executor" class="block text-sm">
            <span class="text-aa-muted">{{
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
            <span class="text-aa-muted">{{
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
        class="rounded-xl border border-aa-border bg-aa-dark/70 p-4"
      >
        <div class="flex items-center justify-between mb-2">
          <p class="text-xs uppercase text-aa-muted font-bold">
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
        <pre class="text-xs text-aa-text whitespace-pre-wrap break-all">{{
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
  fetchAccountMaintenanceState,
  fetchUnifiedVerifierState,
} from "@/services/morpheusDidService.js";
import { notificationService } from "@/services/notificationService.js";
import { getAbstractAccountHash } from "@/services/walletService.js";
import { getScriptHashFromAddress } from "@/utils/neo.js";
import { sanitizeHex } from "@/utils/hex.js";
import { RUNTIME_CONFIG } from "@/config/runtimeConfig.js";
import { translateError } from "@/config/errorCodes.js";
import DidIdentitySummaryGrids from "./DidIdentityPanel/DidIdentitySummaryGrids.vue";
import DidVerifierStateGrid from "./DidIdentityPanel/DidVerifierStateGrid.vue";
import DidPendingStateCards from "./DidIdentityPanel/DidPendingStateCards.vue";
import DidMaintenanceList from "./DidIdentityPanel/DidMaintenanceList.vue";

const props = defineProps({
  aaContractHash: {
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
  recoveryVerifierPrefill: {
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
const verifierState = ref(null);
const maintenanceState = ref(null);
const busy = ref("");
const resultJson = ref("");
const { copiedKey, markCopied, copyText: clipboardCopy } = useClipboard();
const expanded = ref(true);
const bindResponse = ref(null);

const zkloginVerifierParamsHex = computed(() =>
  sanitizeHex(
    bindResponse.value?.zklogin_verifier_params_hex ||
      bindResponse.value?.verifier_params_hex ||
      "",
  ),
);
const zkloginPublicKey = computed(() =>
  sanitizeHex(
    bindResponse.value?.public_key || bindResponse.value?.publicKey || "",
  ),
);
const zkloginMasterNullifier = computed(() =>
  sanitizeHex(
    bindResponse.value?.master_nullifier ||
      bindResponse.value?.masterNullifier ||
      "",
  ),
);

const vaultAccount = ref("");
const claimType = ref("Web3Auth_PrimaryIdentity");
const claimValue = ref("verified");
const recoveryVerifierHash = ref("");
const recoveryNewOwner = ref("");
const recoveryExpiryMinutes = ref(30);
const proxyVerifierHash = ref("");
const proxyExecutor = ref("");
const proxyExpiryMinutes = ref(15);
const bindStatusLabel = computed(() =>
  didConnected.value
    ? t("didPanel.statusReady", "(ready)")
    : t("didPanel.statusConnectDid", "(connect Web3Auth)"),
);
const recoveryStatusLabel = computed(() =>
  verifierState.value?.pendingRecovery?.active
    ? t("didPanel.statusPending", "(pending)")
    : t("didPanel.statusReady", "(ready)"),
);
const sessionStatusLabel = computed(() =>
  verifierState.value?.activeSession?.active
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

const maintenanceItems = computed(() => {
  if (!maintenanceState.value) return [];
  const items = [];
  if (maintenanceState.value.pendingVerifierCall?.active) {
    items.push({
      id: "pending-verifier-call",
      title: t(
        "didPanel.pendingVerifierCall",
        "Pending Verifier Maintenance Call",
      ),
      description: t(
        "didPanel.pendingVerifierCallHint",
        "A delayed verifier maintenance request is staged and can only be confirmed after the contract timelock expires.",
      ),
      executeAfter: formatScheduledTimestamp(
        maintenanceState.value.pendingVerifierCall.executeAfter,
      ),
      moduleHash: maintenanceState.value.pendingVerifierCall.moduleHash,
      callHash: maintenanceState.value.pendingVerifierCall.callHash,
    });
  }
  if (maintenanceState.value.pendingHookCall?.active) {
    items.push({
      id: "pending-hook-call",
      title: t("didPanel.pendingHookCall", "Pending Hook Maintenance Call"),
      description: t(
        "didPanel.pendingHookCallHint",
        "A delayed hook maintenance request is staged and can only be confirmed after the contract timelock expires.",
      ),
      executeAfter: formatScheduledTimestamp(
        maintenanceState.value.pendingHookCall.executeAfter,
      ),
      moduleHash: maintenanceState.value.pendingHookCall.moduleHash,
      callHash: maintenanceState.value.pendingHookCall.callHash,
    });
  }
  if (maintenanceState.value.pendingVerifierUpdate?.active) {
    items.push({
      id: "pending-verifier-update",
      title: t("didPanel.pendingVerifierUpdate", "Pending Verifier Rotation"),
      description: t(
        "didPanel.pendingVerifierUpdateHint",
        "A verifier rotation is queued behind the V3 config-update timelock.",
      ),
      executeAfter: formatScheduledTimestamp(
        maintenanceState.value.pendingVerifierUpdate.executeAfter,
      ),
      moduleHash: "",
      callHash: "",
    });
  }
  if (maintenanceState.value.pendingHookUpdate?.active) {
    items.push({
      id: "pending-hook-update",
      title: t("didPanel.pendingHookUpdate", "Pending Hook Rotation"),
      description: t(
        "didPanel.pendingHookUpdateHint",
        "A hook rotation is queued behind the V3 config-update timelock.",
      ),
      executeAfter: formatScheduledTimestamp(
        maintenanceState.value.pendingHookUpdate.executeAfter,
      ),
      moduleHash: "",
      callHash: "",
    });
  }
  return items;
});
const prefillRecoveryVerifier = computed(() =>
  String(props.recoveryVerifierPrefill || "").trim(),
);
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

function toExpiry(minutes) {
  return Date.now() + Math.max(Number(minutes) || 0, 1) * 60 * 1000;
}

let accountContextRequestId = 0;
let verifierStateRequestId = 0;
async function refreshAccountContext() {
  const requestId = ++accountContextRequestId;
  // Invalidate all earlier reads before clearing context, including an in-flight
  // verifier response from another core with the same account-ID prefill.
  ++verifierStateRequestId;
  resolvedAccountId.value = "";
  recoveryVerifierHash.value = "";
  proxyVerifierHash.value = "";
  verifierState.value = null;
  maintenanceState.value = null;
  if (!props.accountIdPrefill && !props.accountAddressScriptHash) return;
  try {
    const identity = await fetchAccountIdentity({
      rpcUrl: RUNTIME_CONFIG.rpcUrl,
      aaContractHash: props.aaContractHash || getAbstractAccountHash(),
      accountIdHex: props.accountIdPrefill,
      accountAddressScriptHash: props.accountAddressScriptHash,
    });
    if (requestId !== accountContextRequestId) return;
    resolvedAccountId.value = identity.accountIdHex;
    recoveryVerifierHash.value = prefillRecoveryVerifier.value || identity.verifierHash;
    proxyVerifierHash.value = identity.verifierHash;
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
  () => [props.accountAddressScriptHash, props.accountIdPrefill, props.aaContractHash, RUNTIME_CONFIG.rpcUrl],
  () => { void refreshAccountContext(); },
  { immediate: true },
);

watch(
  () => [
    prefillRecoveryVerifier.value,
    prefillRecoveryNewOwner.value,
    prefillRecoveryExpiryMinutes.value,
    props.autoPreviewRecovery,
  ],
  () => {
    if (prefillRecoveryVerifier.value) {
      recoveryVerifierHash.value = prefillRecoveryVerifier.value;
    }
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

watch(
  [resolvedAccountId, recoveryVerifierHash],
  ([accountId, verifier]) => { void refreshVerifierState(accountId, verifier); },
);

async function refreshVerifierState(accountId, verifier) {
  const requestId = ++verifierStateRequestId;
  verifierState.value = null;
  maintenanceState.value = null;
  if (!accountId) return false;
  try {
    const [maintenance, state] = await Promise.all([
      fetchAccountMaintenanceState({
        rpcUrl: RUNTIME_CONFIG.rpcUrl,
        aaContractHash: props.aaContractHash || getAbstractAccountHash(),
        accountIdHex: accountId,
      }),
      verifier ? fetchUnifiedVerifierState({
        rpcUrl: RUNTIME_CONFIG.rpcUrl,
        verifierHash: verifier,
        accountIdHex: accountId,
      }) : Promise.resolve(null),
    ]);
    if (requestId !== verifierStateRequestId) return false;
    maintenanceState.value = maintenance;
    verifierState.value = state;
    return true;
  } catch (error) {
    if (requestId !== verifierStateRequestId) return false;
    if (import.meta.env.DEV)
      console.error("[DidIdentityPanel] refreshVerifierState failed:", error?.message);
    toast.error(translateError(error?.message, t));
    return false;
  }
}

async function refreshVerifierStateAction() {
  busy.value = "refreshState";
  try {
    if (await refreshVerifierState(
      resolvedAccountId.value,
      recoveryVerifierHash.value || proxyVerifierHash.value,
    )) {
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

const canPreviewRecovery = computed(
  () =>
    didConnected.value &&
    recoveryVerifierHash.value &&
    recoveryNewOwner.value &&
    resolvedAccountId.value,
);
const canInvokeRecovery = computed(() => canPreviewRecovery.value);
const canPreviewProxy = computed(
  () => didConnected.value && proxyExecutor.value,
);
const effectiveProxyVerifierHash = computed(
  () => proxyVerifierHash.value || recoveryVerifierHash.value,
);
const canInvokeProxy = computed(
  () =>
    didConnected.value &&
    effectiveProxyVerifierHash.value &&
    proxyExecutor.value &&
    resolvedAccountId.value,
);

watch(
  () => [
    props.autoPreviewRecovery,
    didConnected.value,
    canPreviewRecovery.value,
    resolvedAccountId.value,
    recoveryVerifierHash.value,
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
        aa_contract: props.aaContractHash || getAbstractAccountHash(),
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
  busy.value = "previewRecovery";
  try {
    const response = await morpheusDidService.previewRecoveryTicket({
      aaContract: props.aaContractHash || getAbstractAccountHash(),
      verifierContract: recoveryVerifierHash.value,
      accountId: resolvedAccountId.value,
      newOwner: recoveryNewOwner.value,
      recoveryNonce: 0,
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
      verifierHash: recoveryVerifierHash.value,
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
  busy.value = "previewProxy";
  try {
    const response = await morpheusDidService.previewActionTicket({
      executor: proxyExecutor.value,
      actionId: `aa_proxy:${props.aaContractHash || getAbstractAccountHash()}:${resolvedAccountId.value || "unresolved"}:${normalizeHashOrAddress(proxyExecutor.value)}:${toExpiry(proxyExpiryMinutes.value)}`,
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
  busy.value = "invokeProxy";
  try {
    const response = await morpheusDidService.invokeProxySessionRequest({
      verifierHash: effectiveProxyVerifierHash.value,
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

async function finalizeRecoveryAction() {
  busy.value = "finalizeRecovery";
  try {
    const response = await morpheusDidService.finalizeRecovery({
      verifierHash:
        recoveryVerifierHash.value || effectiveProxyVerifierHash.value,
      accountIdHex: resolvedAccountId.value,
    });
    resultJson.value = JSON.stringify(response, null, 2);
    publishStatus(t("didPanel.finalizeRecovery", "Finalize Recovery"));
    publishActivity(
      "recovery_finalized",
      t("didPanel.activity.recoveryFinalized", "Morpheus recovery finalized"),
    );
    await refreshVerifierStateAction();
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
      verifierHash:
        recoveryVerifierHash.value || effectiveProxyVerifierHash.value,
      accountIdHex: resolvedAccountId.value,
    });
    resultJson.value = JSON.stringify(response, null, 2);
    publishStatus(t("didPanel.cancelRecovery", "Cancel Recovery"));
    publishActivity(
      "recovery_cancelled",
      t("didPanel.activity.recoveryCancelled", "Morpheus recovery cancelled"),
    );
    await refreshVerifierStateAction();
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
      verifierHash: effectiveProxyVerifierHash.value,
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
    await refreshVerifierStateAction();
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

async function copyZkloginVerifierParams() {
  if (!zkloginVerifierParamsHex.value) return;
  if (await clipboardCopy(`0x${sanitizeHex(zkloginVerifierParamsHex.value)}`))
    markCopied("zklogin-params");
}

async function copyZkloginPublicKey() {
  if (!zkloginPublicKey.value) return;
  if (await clipboardCopy(`0x${sanitizeHex(zkloginPublicKey.value)}`))
    markCopied("zklogin-pubkey");
}

async function copyZkloginMasterNullifier() {
  if (!zkloginMasterNullifier.value) return;
  if (await clipboardCopy(`0x${sanitizeHex(zkloginMasterNullifier.value)}`))
    markCopied("zklogin-master-nullifier");
}

async function sendEmailNoticeAction() {
  busy.value = "notifyEmail";
  try {
    const response = await notificationService.sendRecoveryEmail({
      did: didProfile.value?.did,
      email: didProfile.value?.email,
      payload: {
        aa_contract: props.aaContractHash || getAbstractAccountHash(),
        account_id: resolvedAccountId.value || "",
        verifier:
          recoveryVerifierHash.value || effectiveProxyVerifierHash.value || "",
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
        aa_contract: props.aaContractHash || getAbstractAccountHash(),
        account_id: resolvedAccountId.value || "",
        verifier:
          recoveryVerifierHash.value || effectiveProxyVerifierHash.value || "",
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

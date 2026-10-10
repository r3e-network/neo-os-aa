<template>
  <section class="card">
    <div class="flex items-start justify-between mb-2">
      <div>
        <h2 class="text-lg font-bold text-aa-text">
          {{ t("studioPanels.createTitle", "Create Abstract Account") }}
        </h2>
        <p class="text-sm text-aa-muted mt-1">
          {{
            t(
              "studioPanels.createSubtitleLong",
              "Register a V3 account with one verifier plugin, one hook plugin, and one backup owner escape hatch.",
            )
          }}
        </p>
      </div>
      <span v-if="canCreate" class="badge-green">
        <span
          class="w-1.5 h-1.5 rounded-full bg-aa-success animate-pulse"
        ></span>
        {{ t("studioPanels.ready", "Ready") }}
      </span>
      <span v-else-if="computedAddress" class="badge-amber">
        <span class="w-1.5 h-1.5 rounded-full bg-aa-warning"></span>
        {{ t("studioPanels.addressDerived", "Address Derived") }}
      </span>
    </div>

    <div class="space-y-8">
      <div>
        <div class="section-label">
          {{ t("studioPanels.identitySection", "Identity") }}
        </div>
        <div class="bg-aa-panel rounded-lg border border-aa-border/60 p-5">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div class="space-y-2">
              <label
                for="matrix-domain-input"
                class="flex items-center gap-2 text-sm font-semibold text-aa-text"
              >
                {{ t("studioPanels.matrixDomain", ".matrix Domain") }}
                <span class="text-xs font-normal text-aa-muted">{{
                  t("studioPanels.optional", "(optional)")
                }}</span>
              </label>
              <div
                class="flex rounded-lg border border-aa-border overflow-hidden bg-aa-dark focus-within:border-aa-orange focus-within:ring-1 focus-within:ring-aa-orange transition-all duration-200"
              >
                <input
                  id="matrix-domain-input"
                  v-model="createForm.matrixDomain"
                  type="text"
                  class="flex-1 bg-transparent py-2.5 px-4 text-sm text-aa-text border-none focus:ring-0"
                  :placeholder="
                    t('studioPanels.matrixDomainPlaceholder', 'alice')
                  "
                />
                <span
                  class="flex items-center px-3 bg-aa-panel border-l border-aa-border text-aa-muted text-sm font-mono select-none"
                  >.matrix</span
                >
                <button
                  type="button"
                  :aria-label="t('studioPanels.check', 'Check')"
                  @click="checkMatrixDomain"
                  class="bg-aa-lightOrange/10 hover:bg-aa-lightOrange/20 text-aa-lightOrange px-4 text-xs font-bold uppercase transition-colors duration-200 border-l border-aa-border"
                  :class="{ 'btn-loading': matrixCheckResult?.checking }"
                  :disabled="
                    !createForm.matrixDomain || matrixCheckResult?.checking
                  "
                >
                  <svg
                    aria-hidden="true"
                    v-if="matrixCheckResult?.checking"
                    class="animate-spin h-4 w-4"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      class="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      stroke-width="4"
                    ></circle>
                    <path
                      class="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  <span v-else>{{ t("studioPanels.check", "Check") }}</span>
                </button>
              </div>
              <p
                class="mt-1 text-xs"
                :class="
                  matrixCheckResult?.available
                    ? 'text-aa-success'
                    : matrixCheckResult?.error
                      ? 'text-aa-error-light'
                      : 'text-aa-muted'
                "
              >
                {{
                  matrixCheckResult?.message ||
                  t(
                    "studioPanels.matrixHint",
                    "Register a memorable name in the same transaction.",
                  )
                }}
              </p>
            </div>

            <div class="space-y-2">
              <label
                class="flex items-center gap-2 text-sm font-semibold text-aa-text"
              >
                {{
                  t(
                    "studioPanels.virtualAccountAddress",
                    "Virtual Account Address",
                  )
                }}
              </label>
              <div class="relative">
                <div
                  v-if="computedAddress"
                  class="w-full bg-aa-panel border border-aa-success/30 rounded-lg py-2.5 px-4 font-mono text-sm text-aa-success-light flex items-center"
                >
                  <span class="flex-1 break-all">{{ computedAddress }}</span>
                  <button
                    :aria-label="t('studioPanels.copyAddress', 'Copy address')"
                    @click="
                      copyText(computedAddress);
                      markCopied('computedAddress');
                    "
                    class="ml-1.5 text-aa-muted hover:text-aa-text transition-colors duration-200 flex-shrink-0"
                  >
                    <svg
                      aria-hidden="true"
                      v-if="copiedKey !== 'computedAddress'"
                      xmlns="http://www.w3.org/2000/svg"
                      class="h-3.5 w-3.5"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"
                      />
                      <path
                        d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"
                      />
                    </svg>
                    <svg
                      aria-hidden="true"
                      v-else
                      xmlns="http://www.w3.org/2000/svg"
                      class="h-3.5 w-3.5 text-aa-success"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fill-rule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clip-rule="evenodd"
                      />
                    </svg>
                  </button>
                </div>
                <div
                  v-else
                  class="w-full bg-aa-dark/50 border border-aa-border rounded-lg py-3 px-4 text-sm text-aa-muted text-center"
                >
                  {{
                    t(
                      "studioPanels.enterAccountParametersToDerive",
                      "Enter account parameters below to derive address",
                    )
                  }}
                </div>
                <div
                  v-if="computedAddress"
                  class="absolute right-3 top-1/2 -translate-y-1/2"
                >
                  <span class="relative flex h-3 w-3">
                    <span
                      class="animate-ping absolute inline-flex h-full w-full rounded-full bg-aa-success opacity-75"
                    ></span>
                    <span
                      class="relative inline-flex rounded-full h-3 w-3 bg-aa-success"
                    ></span>
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div
            v-if="computedAccountIdHash"
            class="mt-5 rounded-lg border border-aa-success/25 bg-aa-success/10 p-4"
          >
            <div
              class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
            >
              <div class="min-w-0">
                <p class="text-xs font-bold uppercase text-aa-success-light">
                  {{ t("studioPanels.accountIdHash", "AccountId Hash") }}
                </p>
                <code
                  class="mt-1 block break-all font-mono text-sm text-aa-text"
                  >0x{{ computedAccountIdHash }}</code
                >
                <p class="mt-1 text-xs text-aa-muted">
                  {{
                    t(
                      "studioPanels.accountIdHashHint",
                      "Use this value to load the account in Operations after registration is confirmed.",
                    )
                  }}
                </p>
              </div>
              <div class="flex shrink-0 flex-wrap gap-2">
                <button
                  type="button"
                  class="btn-secondary btn-sm"
                  @click="
                    copyText(`0x${computedAccountIdHash}`);
                    markCopied('accountIdHash');
                  "
                >
                  {{
                    copiedKey === "accountIdHash"
                      ? t("studioPanels.copied", "Copied!")
                      : t("studioPanels.copyAccountId", "Copy AccountId")
                  }}
                </button>
                <router-link
                  class="btn-primary btn-sm"
                  :to="{
                    path: '/app',
                    query: { accountId: `0x${computedAccountIdHash}` },
                  }"
                >
                  {{
                    t(
                      "studioPanels.openOperations",
                      "Open Operations",
                    )
                  }}
                </router-link>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div class="section-label">
          {{ t("studioPanels.pluginsSection", "Plugins") }}
        </div>
        <div class="bg-aa-panel rounded-lg border border-aa-border/60 p-5">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div class="space-y-4">
              <div>
                <label
                  for="verifier-contract-input"
                  class="block text-sm font-semibold text-aa-text mb-1"
                  >{{
                    t("studioPanels.verifierPlugin", "Verifier Plugin")
                  }}</label
                >
                <input
                  id="verifier-contract-input"
                  v-model="createForm.verifierContract"
                  type="text"
                  class="input-field font-mono text-sm py-2 px-3 bg-aa-dark"
                  :placeholder="
                    t(
                      'studioPanels.verifierContractOptionalPlaceholder',
                      '0x... (optional)',
                    )
                  "
                />
                <p class="mt-1 text-xs text-aa-muted">
                  {{
                    t(
                      "studioPanels.verifierPluginExamples",
                      "Examples: Web3AuthVerifier, TEEVerifier, SessionKeyVerifier, ZkLoginVerifier.",
                    )
                  }}
                </p>
              </div>
              <div>
                <label
                  for="verifier-params-input"
                  class="block text-sm font-semibold text-aa-text mb-1"
                  >{{
                    t("studioPanels.verifierParamsHex", "Verifier Params (hex)")
                  }}</label
                >
                <textarea
                  id="verifier-params-input"
                  v-model="createForm.verifierParams"
                  class="input-field font-mono text-xs py-2 px-3 bg-aa-dark min-h-24"
                  :placeholder="
                    t(
                      'studioPanels.verifierParamsPlaceholder',
                      'Uncompressed pubkey or verifier-specific config hex.',
                    )
                  "
                ></textarea>
              </div>
            </div>

            <div class="space-y-4">
              <div>
                <label
                  for="hook-contract-input"
                  class="block text-sm font-semibold text-aa-text mb-1"
                  >{{ t("studioPanels.hookPlugin", "Hook Plugin") }}</label
                >
                <input
                  id="hook-contract-input"
                  v-model="createForm.hookContract"
                  type="text"
                  class="input-field font-mono text-sm py-2 px-3 bg-aa-dark"
                  :placeholder="
                    t(
                      'studioPanels.hookContractOptionalPlaceholder',
                      '0x... (optional)',
                    )
                  "
                />
                <p class="mt-1 text-xs text-aa-muted">
                  {{
                    t(
                      "studioPanels.hookPluginExamples",
                      "Examples: WhitelistHook, DailyLimitHook, NeoDIDCredentialHook, MultiHook.",
                    )
                  }}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div class="section-label">
          {{ t("studioPanels.backupSection", "Backup & Recovery") }}
        </div>
        <div class="bg-aa-panel rounded-lg border border-aa-border/60 p-5">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div class="space-y-2">
              <label
                for="backup-owner-input"
                class="block text-sm font-semibold text-aa-text mb-1"
                >{{ t("studioPanels.backupOwner", "Backup Owner") }}</label
              >
              <input
                id="backup-owner-input"
                v-model="createForm.backupOwner"
                type="text"
                class="input-field font-mono text-sm py-2 px-3 bg-aa-dark"
                :class="backupOwnerInputClass"
                :placeholder="
                  t('studioPanels.backupOwnerPlaceholder', 'N... or 0x...')
                "
              />
              <p
                v-if="backupOwnerError"
                role="alert"
                class="mt-1 text-xs text-aa-error-light"
              >
                {{ backupOwnerError }}
              </p>
              <p v-else class="mt-1 text-xs text-aa-muted">
                {{
                  t(
                    "studioPanels.backupOwnerHint",
                    "Neo address (N...) or EVM address (0x...)",
                  )
                }}
              </p>
            </div>
            <div class="space-y-2">
              <label
                for="escape-timelock-days"
                class="block text-sm font-semibold text-aa-text mb-1"
                >{{
                  t("studioPanels.escapeTimelockDays", "Escape Timelock (days)")
                }}</label
              >
              <input
                id="escape-timelock-days"
                v-model.number="createForm.escapeTimelockDays"
                type="number"
                min="7"
                max="90"
                class="input-field w-32 text-sm py-2 px-3 bg-aa-dark"
                placeholder="30"
              />
              <p class="mt-1 text-xs text-aa-muted">
                {{
                  t(
                    "studioPanels.escapeTimelockHint",
                    "Countdown before escape hatch activates (7-90 days)",
                  )
                }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div class="section-label">
          {{ t("studioPanels.scriptSection", "Verification Script") }}
        </div>
        <div class="space-y-2">
          <label
            for="verificationScriptHex"
            class="flex items-center justify-between text-sm font-semibold text-aa-text"
          >
            {{
              t(
                "studioPanels.verificationScriptHex",
                "Verification Script (Hex)",
              )
            }}
            <button
              v-if="computedScriptHex"
              type="button"
              @click="copyScript"
              class="text-xs text-aa-orange hover:text-aa-lightOrange transition-colors duration-200 flex items-center gap-1"
            >
              <svg
                aria-hidden="true"
                class="w-3 h-3"
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
              {{
                copiedKey === "script"
                  ? t("studioPanels.copied", "Copied!")
                  : t("studioPanels.copy", "Copy")
              }}
            </button>
          </label>
          <div
            class="relative rounded-lg overflow-hidden border border-aa-border"
          >
            <textarea
              id="verificationScriptHex"
              :value="computedScriptHex || ''"
              readonly
              class="w-full bg-aa-dark border-0 p-4 font-mono text-xs text-aa-text placeholder:text-aa-muted focus:ring-0 resize-none h-24"
              :placeholder="
                computedAddress
                  ? t(
                      'studioPanels.computingPlaceholder',
                      'Computing script...',
                    )
                  : t(
                      'studioPanels.enterAccountParametersPlaceholder',
                      'Enter account parameters above...',
                    )
              "
            ></textarea>
          </div>
        </div>
      </div>

      <div
        class="pt-6 border-t border-aa-border/60 flex flex-col sm:flex-row items-center gap-4"
      >
        <button
          type="button"
          class="btn-primary w-full sm:w-auto"
          :class="{ 'btn-loading': isCreating }"
          :disabled="isCreating || !canCreate"
          @click="createAccount"
        >
          <svg
            aria-hidden="true"
            v-if="isCreating"
            class="animate-spin -ml-1 mr-2 h-4 w-4 text-aa-text"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            ></circle>
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            ></path>
          </svg>
          {{
            isCreating
              ? t(
                  "studioPanels.submittingTransaction",
                  "Submitting Transaction...",
                )
              : t("studioPanels.registerV3Account", "Register V3 Account")
          }}
        </button>
        <span
          class="text-xs text-aa-muted font-medium text-center sm:text-left"
          >{{
            t(
              "studioPanels.registerHint",
              "Creates a V3 account with one verifier, one hook, and one backup-owner escape hatch.",
            )
          }}</span
        >
      </div>
    </div>
  </section>
</template>

<script setup>
import { inject, computed } from "vue";
import { useI18n } from "@/i18n";
import { useClipboard } from "@/composables/useClipboard";

const { t } = useI18n();
const { copiedKey, markCopied, copyText } = useClipboard();

const studio = inject("studio");
const {
  createForm,
  computedAddress,
  computedAccountIdHash,
  computedScriptHex,
  isCreating,
  canCreate,
  createAccount,
  checkMatrixDomain,
  matrixCheckResult,
} = studio;

async function copyScript() {
  if (!computedScriptHex) return;
  if (await copyText(computedScriptHex)) markCopied("script");
}

const backupOwnerError = computed(() => {
  const val = createForm.backupOwner?.trim() || "";
  if (!val) return "";
  const isNeo = val.startsWith("N") && val.length === 34;
  const isEvm = /^0x[0-9a-fA-F]{40}$/.test(val);
  if (!isNeo && !isEvm)
    return t(
      "studioPanels.invalidAddressFormat",
      "Invalid address format (expect N... or 0x...)",
    );
  return "";
});

const backupOwnerInputClass = computed(() => {
  const val = createForm.backupOwner?.trim() || "";
  if (!val) return "";
  return backupOwnerError.value
    ? "border-aa-error focus:border-aa-error-light"
    : "border-aa-success/50";
});
</script>

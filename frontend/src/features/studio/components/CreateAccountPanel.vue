<template>
  <section class="card">
    <div class="flex items-start justify-between mb-2">
      <div>
        <h2 class="text-lg font-bold text-sa-text">
          {{ t("studioPanels.createTitle", "Create Smart Account") }}
        </h2>
        <p class="text-sm text-sa-muted mt-1">
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
          class="w-1.5 h-1.5 rounded-full bg-sa-success animate-pulse"
        ></span>
        {{ t("studioPanels.ready", "Ready") }}
      </span>
      <span v-else-if="computedAddress" class="badge-amber">
        <span class="w-1.5 h-1.5 rounded-full bg-sa-warning"></span>
        {{ t("studioPanels.addressDerived", "Address Derived") }}
      </span>
    </div>

    <div class="space-y-8">
      <div>
        <div class="section-label">
          {{ t("studioPanels.identitySection", "Identity") }}
        </div>
        <div class="bg-sa-panel rounded-lg border border-sa-border/60 p-5">
          <p class="mb-4 text-xs text-sa-muted">{{ t('ordinary.registrationPayer', 'The connected Neo wallet authorizes registration and pays its transaction fees. Review the final fee in the wallet before signing.') }}</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div class="space-y-2">
              <label
                for="matrix-domain-input"
                class="flex items-center gap-2 text-sm font-semibold text-sa-text"
              >
                {{ t("studioPanels.matrixDomain", ".matrix Domain") }}
                <span class="text-xs font-normal text-sa-muted">{{
                  t("studioPanels.optional", "(optional)")
                }}</span>
              </label>
              <div
                class="flex rounded-lg border border-sa-border overflow-hidden bg-sa-dark focus-within:border-sa-orange focus-within:ring-1 focus-within:ring-sa-orange transition-all duration-200"
              >
                <input
                  id="matrix-domain-input"
                  v-model="createForm.matrixDomain"
                  type="text"
                  class="flex-1 bg-transparent py-2.5 px-4 text-sm text-sa-text border-none focus:ring-0"
                  :placeholder="
                    t('studioPanels.matrixDomainPlaceholder', 'alice')
                  "
                />
                <span
                  class="flex items-center px-3 bg-sa-panel border-l border-sa-border text-sa-muted text-sm font-mono select-none"
                  >.matrix</span
                >
                <button
                  type="button"
                  :aria-label="t('studioPanels.check', 'Check')"
                  @click="checkMatrixDomain"
                  class="bg-sa-lightOrange/10 hover:bg-sa-lightOrange/20 text-sa-lightOrange px-4 text-xs font-bold uppercase transition-colors duration-200 border-l border-sa-border"
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
                    ? 'text-sa-success'
                    : matrixCheckResult?.error
                      ? 'text-sa-error-light'
                      : 'text-sa-muted'
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
                class="flex items-center gap-2 text-sm font-semibold text-sa-text"
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
                  class="w-full bg-sa-panel border border-sa-success/30 rounded-lg py-2.5 px-4 font-mono text-sm text-sa-success-light flex items-center"
                >
                  <span class="flex-1 break-all">{{ computedAddress }}</span>
                  <button
                    :aria-label="t('studioPanels.copyAddress', 'Copy address')"
                    @click="
                      copyText(computedAddress);
                      markCopied('computedAddress');
                    "
                    class="ml-1.5 text-sa-muted hover:text-sa-text transition-colors duration-200 flex-shrink-0"
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
                      class="h-3.5 w-3.5 text-sa-success"
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
                  class="w-full bg-sa-dark/50 border border-sa-border rounded-lg py-3 px-4 text-sm text-sa-muted text-center"
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
                      class="animate-ping absolute inline-flex h-full w-full rounded-full bg-sa-success opacity-75"
                    ></span>
                    <span
                      class="relative inline-flex rounded-full h-3 w-3 bg-sa-success"
                    ></span>
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div
            v-if="computedAccountIdHash"
            class="mt-5 rounded-lg border border-sa-success/25 bg-sa-success/10 p-4"
          >
            <div
              class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
            >
              <div class="min-w-0">
                <p class="text-xs font-bold uppercase text-sa-success-light">
                  {{ t("studioPanels.accountIdHash", "AccountId Hash") }}
                </p>
                <code
                  class="mt-1 block break-all font-mono text-sm text-sa-text"
                  >0x{{ computedAccountIdHash }}</code
                >
                <p class="mt-1 text-xs text-sa-muted">
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
        <div class="bg-sa-panel rounded-lg border border-sa-border/60 p-5">
          <p class="mb-4 text-xs text-sa-muted">{{ t('ordinary.registrationPayer', 'The connected Neo wallet authorizes registration and pays its transaction fees. Review the final fee in the wallet before signing.') }}</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div class="space-y-4">
              <div class="space-y-2">
                <span class="block text-sm font-semibold text-sa-text">{{
                  t(
                    "studioPanels.createVerifierPresets",
                    "Published verifier presets",
                  )
                }}</span>
                <div class="grid grid-cols-1 gap-2">
                  <button
                    v-for="preset in createVerifierPresets"
                    :key="preset.id"
                    type="button"
                    class="rounded-lg border px-3 py-2 text-left transition-colors duration-200"
                    :class="
                      selectedVerifierPreset?.id === preset.id
                        ? 'border-sa-orange bg-sa-orange/10'
                        : 'border-sa-border bg-sa-dark hover:border-sa-orange/60'
                    "
                    :aria-pressed="selectedVerifierPreset?.id === preset.id"
                    @click="applyCreateVerifierPreset(preset)"
                  >
                    <span class="block text-xs font-semibold text-sa-text">{{
                      preset.label
                    }}</span>
                    <span class="block font-mono text-[10px] text-sa-muted">{{
                      preset.verifierContract
                    }}</span>
                  </button>
                </div>
                <p class="text-xs text-sa-muted">
                  {{
                    selectedVerifierPreset
                      ? selectedVerifierPreset.description
                      : t(
                          "studioPanels.createVerifierPresetsHint",
                          "Presets come from the published Morpheus registry for this network. Choosing one fills the verifier address; the params rule follows the preset.",
                        )
                  }}
                </p>
              </div>
              <div>
                <label
                  for="verifier-contract-input"
                  class="block text-sm font-semibold text-sa-text mb-1"
                  >{{
                    t("studioPanels.verifierPlugin", "Verifier Plugin")
                  }}</label
                >
                <input
                  id="verifier-contract-input"
                  v-model="createForm.verifierContract"
                  type="text"
                  class="input-field font-mono text-sm py-2 px-3 bg-sa-dark"
                  :placeholder="
                    t(
                      'studioPanels.verifierContractOptionalPlaceholder',
                      '0x... (optional)',
                    )
                  "
                />
                <p class="mt-1 text-xs text-sa-muted">
                  {{
                    t(
                      "studioPanels.verifierPluginExamples",
                      "Pick a published preset above, or paste any verifier contract hash.",
                    )
                  }}
                </p>
              </div>
              <div>
                <label
                  for="verifier-params-input"
                  class="block text-sm font-semibold text-sa-text mb-1"
                  >{{
                    t("studioPanels.verifierParamsHex", "Verifier Params (hex)")
                  }}</label
                >
                <textarea
                  id="verifier-params-input"
                  v-model="createForm.verifierParams"
                  class="input-field font-mono text-xs py-2 px-3 bg-sa-dark min-h-24"
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
                  class="block text-sm font-semibold text-sa-text mb-1"
                  >{{ t("studioPanels.hookPlugin", "Hook Plugin") }}</label
                >
                <input
                  id="hook-contract-input"
                  v-model="createForm.hookContract"
                  type="text"
                  class="input-field font-mono text-sm py-2 px-3 bg-sa-dark"
                  :placeholder="
                    t(
                      'studioPanels.hookContractOptionalPlaceholder',
                      '0x... (optional)',
                    )
                  "
                />
                <p class="mt-1 text-xs text-sa-muted">
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
        <div class="bg-sa-panel rounded-lg border border-sa-border/60 p-5">
          <p class="mb-4 text-xs text-sa-muted">{{ t('ordinary.registrationPayer', 'The connected Neo wallet authorizes registration and pays its transaction fees. Review the final fee in the wallet before signing.') }}</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div class="space-y-2">
              <label
                for="backup-owner-input"
                class="block text-sm font-semibold text-sa-text mb-1"
                >{{ t("studioPanels.backupOwner", "Backup Owner") }}</label
              >
              <input
                id="backup-owner-input"
                v-model="createForm.backupOwner"
                type="text"
                class="input-field font-mono text-sm py-2 px-3 bg-sa-dark"
                :class="backupOwnerInputClass"
                :placeholder="
                  t('studioPanels.backupOwnerPlaceholder', 'N... or 0x...')
                "
              />
              <p
                v-if="backupOwnerError"
                role="alert"
                class="mt-1 text-xs text-sa-error-light"
              >
                {{ backupOwnerError }}
              </p>
              <p class="mt-1 text-xs text-sa-muted">
                {{
                  t(
                    "studioPanels.backupOwnerHint",
                    "Neo N3 address (N...) or Neo script hash (0x...). The connected wallet must be this backup owner.",
                  )
                }}
              </p>
            </div>
            <div class="space-y-2">
              <label
                for="escape-timelock-days"
                class="block text-sm font-semibold text-sa-text mb-1"
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
                class="input-field w-32 text-sm py-2 px-3 bg-sa-dark"
                placeholder="30"
              />
              <p class="mt-1 text-xs text-sa-muted">
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
            class="flex items-center justify-between text-sm font-semibold text-sa-text"
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
              class="text-xs text-sa-orange hover:text-sa-lightOrange transition-colors duration-200 flex items-center gap-1"
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
            class="relative rounded-lg overflow-hidden border border-sa-border"
          >
            <textarea
              id="verificationScriptHex"
              :value="computedScriptHex || ''"
              readonly
              class="w-full bg-sa-dark border-0 p-4 font-mono text-xs text-sa-text placeholder:text-sa-muted focus:ring-0 resize-none h-24"
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
        class="pt-6 border-t border-sa-border/60 flex flex-col sm:flex-row items-center gap-4"
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
            class="animate-spin -ml-1 mr-2 h-4 w-4 text-sa-text"
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
          class="text-xs text-sa-muted font-medium text-center sm:text-left"
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
  createVerifierPresets,
  applyCreateVerifierPreset,
  computedAddress,
  computedAccountIdHash,
  computedScriptHex,
  isCreating,
  canCreate,
  createAccount,
  checkMatrixDomain,
  matrixCheckResult,
  registrationOwnerError,
} = studio;

const selectedVerifierPreset = computed(() => {
  const address = String(createForm.value.verifierContract || "")
    .trim()
    .toLowerCase()
    .replace(/^0x/, "");
  if (!address) return null;
  return (
    (createVerifierPresets.value || []).find(
      (preset) =>
        preset.verifierContract.toLowerCase().replace(/^0x/, "") === address,
    ) || null
  );
});

async function copyScript() {
  if (!computedScriptHex) return;
  if (await copyText(computedScriptHex)) markCopied("script");
}

const backupOwnerError = registrationOwnerError;

const backupOwnerInputClass = computed(() => {
  const val = createForm.value.backupOwner?.trim() || "";
  if (!val) return "";
  return backupOwnerError.value
    ? "border-sa-error focus:border-sa-error-light"
    : "border-sa-success/50";
});
</script>

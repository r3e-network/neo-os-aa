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
              "studioPanels.createSubtitleV4",
              "Create a v4 account from its custody, a unique salt and its recovery timelock. Modules are installed afterwards through a configuration intent.",
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
          <p class="mb-4 text-xs text-sa-muted">{{ t('custom.registrationPayer', 'The connected Neo wallet authorizes registration and pays its transaction fees. Review the final fee in the wallet before signing.') }}</p>
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
                  :disabled="
                    !createForm.matrixDomain || matrixCheckResult?.checking
                  "
                >
                  {{ t("studioPanels.check", "Check") }}
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
                    {{ copiedKey === "computedAddress" ? "✓" : "⧉" }}
                  </button>
                </div>
                <div
                  v-else
                  class="w-full bg-sa-dark/50 border border-sa-border rounded-lg py-3 px-4 text-sm text-sa-muted text-center"
                >
                  {{
                    t(
                      "studioPanels.enterAccountParametersToDerive",
                      "Enter the custody, salt and timelock to derive the address",
                    )
                  }}
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
                  {{ t("studioPanels.accountId", "Account Id") }}
                </p>
                <code
                  class="mt-1 block break-all font-mono text-sm text-sa-text"
                  >0x{{ computedAccountIdHash }}</code
                >
                <p class="mt-1 text-xs text-sa-muted">
                  {{
                    t(
                      "studioPanels.accountIdHintV4",
                      "The identity is hash160(0xAA524704 || custody || salt). Use this id to load the account after creation is confirmed.",
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
                  {{ t("studioPanels.openOperations", "Open Operations") }}
                </router-link>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div class="section-label">
          {{ t("studioPanels.custodySection", "Custody & Recovery") }}
        </div>
        <div class="bg-sa-panel rounded-lg border border-sa-border/60 p-5">
          <p class="mb-4 text-xs text-sa-muted">{{ t('custom.custodyPayer', 'Custody is the witness-bearing controller: it authorizes configuration intents and recovery. The connected wallet must be this address.') }}</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div class="space-y-2">
              <label
                for="custody-input"
                class="block text-sm font-semibold text-sa-text mb-1"
                >{{ t("studioPanels.custody", "Custody") }}</label
              >
              <input
                id="custody-input"
                v-model="createForm.custody"
                type="text"
                class="input-field font-mono text-sm py-2 px-3 bg-sa-dark"
                :class="custodyInputClass"
                :placeholder="
                  t('studioPanels.custodyPlaceholder', 'N... or 0x...')
                "
              />
              <p
                v-if="custodyError"
                role="alert"
                class="mt-1 text-xs text-sa-error-light"
              >
                {{ custodyError }}
              </p>
              <p class="mt-1 text-xs text-sa-muted">
                {{
                  t(
                    "studioPanels.custodyHint",
                    "Neo N3 address (N...) or Neo script hash (0x...) of the controlling wallet.",
                  )
                }}
              </p>
            </div>
            <div class="space-y-2">
              <label
                for="recovery-timelock-days"
                class="block text-sm font-semibold text-sa-text mb-1"
                >{{
                  t("studioPanels.recoveryTimelockDays", "Recovery Timelock (days)")
                }}</label
              >
              <input
                id="recovery-timelock-days"
                v-model.number="createForm.recoveryTimelockDays"
                type="number"
                :min="minRecoveryDays"
                :max="maxRecoveryDays"
                class="input-field w-32 text-sm py-2 px-3 bg-sa-dark"
                placeholder="30"
              />
              <p class="mt-1 text-xs text-sa-muted">
                {{
                  t(
                    "studioPanels.recoveryTimelockHintV4",
                    "Countdown before a recovery authority can take over (7-90 days).",
                  )
                }}
              </p>
            </div>
          </div>

          <div class="mt-5">
            <label
              for="salt-input"
              class="block text-sm font-semibold text-sa-text mb-1"
              >{{ t("studioPanels.salt", "Salt (hex)") }}</label
            >
            <div class="flex gap-2">
              <input
                id="salt-input"
                v-model="createForm.salt"
                type="text"
                class="input-field font-mono text-sm py-2 px-3 bg-sa-dark flex-1"
                :placeholder="
                  t(
                    'studioPanels.saltPlaceholder',
                    '1 through 128 bytes of hex, unique per account',
                  )
                "
              />
              <button
                type="button"
                class="btn-secondary btn-sm"
                @click="regenerateSalt"
              >
                {{ t("studioPanels.generateSalt", "Generate") }}
              </button>
            </div>
            <p class="mt-1 text-xs text-sa-muted">
              {{
                t(
                  "studioPanels.saltHint",
                  "The salt is public uniqueness input. Keep it with the custody address: together they are the only way to re-derive this account.",
                )
              }}
            </p>
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
              class="text-xs text-sa-orange hover:text-sa-lightOrange transition-colors duration-200"
            >
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
                t(
                  'studioPanels.enterAccountParametersPlaceholder',
                  'Enter the custody, salt and timelock above...',
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
          {{
            isCreating
              ? t(
                  "studioPanels.submittingTransaction",
                  "Submitting Transaction...",
                )
              : t("studioPanels.createAccountAction", "Create Account")
          }}
        </button>
        <span
          class="text-xs text-sa-muted font-medium text-center sm:text-left"
          >{{
            t(
              "studioPanels.createHintV4",
              "Creates the account and its control record. Install validators and hooks next from Manage Configuration.",
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
import {
  MAX_RECOVERY_TIMELOCK_DAYS,
  MIN_RECOVERY_TIMELOCK_DAYS,
} from "@/utils/neo.js";

const { t } = useI18n();
const { copiedKey, markCopied, copyText } = useClipboard();

const studio = inject("studio");
const {
  createForm,
  regenerateSalt,
  computedAddress,
  computedAccountIdHash,
  computedScriptHex,
  isCreating,
  canCreate,
  createAccount,
  checkMatrixDomain,
  matrixCheckResult,
  custodyError,
} = studio;

const minRecoveryDays = MIN_RECOVERY_TIMELOCK_DAYS;
const maxRecoveryDays = MAX_RECOVERY_TIMELOCK_DAYS;

async function copyScript() {
  if (!computedScriptHex) return;
  if (await copyText(computedScriptHex)) markCopied("script");
}

const custodyInputClass = computed(() => {
  const value = createForm.value.custody?.trim() || "";
  if (!value) return "";
  return custodyError.value
    ? "border-sa-error focus:border-sa-error-light"
    : "border-sa-success/50";
});
</script>

<template>
  <section class="card">
    <h2 class="text-lg font-bold text-aa-text mb-2">
      {{ t("studioPanels.manageTitle", "Manage Governance") }}
    </h2>
    <p class="text-sm text-aa-muted mb-8">
      {{
        t(
          "studioPanels.manageSubtitle",
          "Load a V3 account, inspect its verifier / hook / escape state, then rotate plugins or operate the escape hatch.",
        )
      }}
    </p>

    <div class="space-y-8">
      <div class="bg-aa-panel p-5 rounded-lg border border-aa-border/60">
        <label
          for="manage-target-account"
          class="block text-sm font-semibold text-aa-text mb-3"
          >{{
            t("studioPanels.targetAccountLabel", "Target AccountId Hash")
          }}</label
        >
        <div class="flex flex-col sm:flex-row gap-4">
          <input
            id="manage-target-account"
            v-model="manageForm.accountAddress"
            type="text"
            list="loaded-manage-accounts"
            class="input-field flex-1 font-mono text-sm py-2.5 px-4 bg-aa-dark"
            :placeholder="
              t('studioPanels.targetAccountPlaceholder', '20-byte hash160')
            "
          />
          <datalist id="loaded-manage-accounts">
            <option
              v-for="addr in autoLoadedAccounts"
              :key="addr"
              :value="addr"
            />
          </datalist>
          <button
            type="button"
            :aria-label="t('studioPanels.ariaLoadAccount', 'Load account')"
            class="btn-primary sm:w-auto"
            :class="{ 'btn-loading': manageBusy.load }"
            :disabled="manageBusy.load || !canManageTarget"
            @click="loadAccountConfiguration"
          >
            {{
              manageBusy.load
                ? t("studioPanels.loading", "Loading...")
                : t("studioPanels.loadV3State", "Load V3 State")
            }}
          </button>
        </div>
        <p class="mt-2 text-xs text-aa-muted">
          {{
            t(
              "studioPanels.v3StateKeyedHint",
              "V3 state is keyed by `accountId` hash160, not by the derived virtual address.",
            )
          }}
        </p>
      </div>

      <!-- Empty state when no account is loaded -->
      <GovernanceEmptyState v-if="!manageSnapshot.loadedAt" />

      <transition name="fade-in-up">
        <GovernanceSnapshotCard
          v-if="manageSnapshot.loadedAt"
          :snapshot="manageSnapshot"
        />
      </transition>

      <div
        v-if="manageSnapshot.loadedAt"
        class="grid grid-cols-1 lg:grid-cols-2 gap-8"
      >
        <RotateVerifierCard
          v-model:verifier-contract="manageForm.verifierContract"
          v-model:verifier-params="manageForm.verifierParams"
          :busy="manageBusy.verifier"
          :disabled="manageBusy.verifier || !canManageTarget"
          @update="updateVerifier"
        />

        <RotateHookCard
          v-model:hook-contract="manageForm.hookContract"
          :busy="manageBusy.hook"
          :disabled="manageBusy.hook || !canManageTarget"
          @update="updateHook"
        />
      </div>

      <div v-if="manageSnapshot.loadedAt">
        <div class="card hover:border-aa-muted transition-colors duration-200">
          <h3 class="text-sm font-bold text-aa-text mb-5">
            {{ t("studioPanels.escapeHatch", "Escape Hatch") }}
          </h3>
          <div class="space-y-4">
            <div>
              <label
                for="governance-escape-verifier"
                class="block text-xs font-semibold text-aa-muted mb-1"
                >{{
                  t(
                    "studioPanels.newVerifierAfterEscape",
                    "New Verifier After Escape",
                  )
                }}</label
              >
              <input
                id="governance-escape-verifier"
                v-model="manageForm.escapeNewVerifier"
                type="text"
                class="input-field font-mono text-sm py-2 px-3 bg-aa-dark"
                :placeholder="t('studioPanels.hashPlaceholder', '0x...')"
              />
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                :aria-label="
                  t('studioPanels.ariaInitiateEscape', 'Initiate escape')
                "
                class="btn-warning w-full"
                :class="{ 'btn-loading': manageBusy.initiateEscape }"
                :disabled="manageBusy.initiateEscape || !canManageTarget"
                @click="confirmInitiateEscape"
              >
                {{
                  manageBusy.initiateEscape
                    ? t("studioPanels.starting", "Starting...")
                    : t("studioPanels.initiateEscape", "Initiate Escape")
                }}
              </button>
              <button
                type="button"
                :aria-label="
                  t('studioPanels.ariaFinalizeEscape', 'Finalize escape')
                "
                class="btn-primary w-full"
                :class="{ 'btn-loading': manageBusy.finalizeEscape }"
                :disabled="manageBusy.finalizeEscape || !canManageTarget"
                @click="confirmFinalizeEscape"
              >
                {{
                  manageBusy.finalizeEscape
                    ? t("studioPanels.finalizing", "Finalizing...")
                    : t("studioPanels.finalizeEscape", "Finalize Escape")
                }}
              </button>
            </div>
            <p class="text-xs text-aa-muted">
              {{
                t(
                  "studioPanels.escapeHint",
                  "Only the configured backup owner can operate the escape hatch.",
                )
              }}
            </p>
          </div>
        </div>
      </div>

      <div v-if="manageSnapshot.loadedAt">
        <AccountMetadataCard
          v-model:metadata-uri="metadataForm.metadataUri"
          v-model:description="metadataForm.description"
          v-model:logo-url="metadataForm.logoUrl"
          :busy="metadataBusy.save"
          :disabled="metadataBusy.save || !canManageTarget"
          @save="saveMetadata"
        />
      </div>
    </div>

    <!-- Styled confirm modal -->
    <ConfirmDialog
      :modal="confirmModal"
      @close="confirmModal = null"
      @confirm="
        confirmModal.onConfirm();
        confirmModal = null;
      "
    />
  </section>
</template>

<script setup>
import { inject, ref } from "vue";
import { useI18n } from "@/i18n";
import GovernanceEmptyState from "./ManageGovernancePanel/GovernanceEmptyState.vue";
import GovernanceSnapshotCard from "./ManageGovernancePanel/GovernanceSnapshotCard.vue";
import RotateVerifierCard from "./ManageGovernancePanel/RotateVerifierCard.vue";
import RotateHookCard from "./ManageGovernancePanel/RotateHookCard.vue";
import AccountMetadataCard from "./ManageGovernancePanel/AccountMetadataCard.vue";
import ConfirmDialog from "./ManageGovernancePanel/ConfirmDialog.vue";

const { t } = useI18n();

const confirmModal = ref(null);

const studio = inject("studio");
const {
  manageForm,
  manageBusy,
  manageSnapshot,
  metadataForm,
  metadataBusy,
  canManageTarget,
  autoLoadedAccounts,
  loadAccountConfiguration,
  updateVerifier,
  updateHook,
  initiateEscape,
  finalizeEscape,
  saveMetadata,
} = studio;

function confirmInitiateEscape() {
  confirmModal.value = {
    title: t("studioPanels.initiateEscapeTitle", "Initiate Escape Hatch"),
    message: t(
      "studioPanels.confirmInitiateEscape",
      "This will start the escape hatch countdown. The current verifier will be replaced after the timelock expires. Continue?",
    ),
    confirmLabel: t("studioPanels.initiateEscape", "Initiate Escape"),
    danger: false,
    onConfirm: initiateEscape,
  };
}

function confirmFinalizeEscape() {
  confirmModal.value = {
    title: t("studioPanels.finalizeEscapeTitle", "Finalize Escape Hatch"),
    message: t(
      "studioPanels.confirmFinalizeEscape",
      "This will finalize the escape hatch and permanently replace the current verifier. This action cannot be undone. Continue?",
    ),
    confirmLabel: t("studioPanels.finalizeEscape", "Finalize Escape"),
    danger: true,
    onConfirm: finalizeEscape,
  };
}
</script>

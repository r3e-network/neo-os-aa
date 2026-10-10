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
            :disabled="governanceBusy || !canManageTarget"
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

      <p v-if="governanceOutcome" role="status" class="text-sm text-aa-warning" data-testid="ordinary-governance-outcome">{{ governanceOutcome }}</p>
      <p v-if="governanceBusy" role="status" class="text-sm text-aa-muted">{{ t('ordinary.waitForWallet', 'Waiting for the wallet or chain confirmation. Keep this page open.') }}</p>
      <!-- Empty state when no account is loaded -->
      <GovernanceEmptyState v-if="!manageSnapshot.loadedAt" />

      <transition name="fade-in-up">
        <GovernanceSnapshotCard
          v-if="manageSnapshot.loadedAt"
          :snapshot="manageSnapshot"
        />
      </transition>

      <div v-if="manageSnapshot.loadedAt" class="space-y-3 text-sm">
        <p data-testid="ordinary-chain-time">{{ t('ordinary.chainTime', 'Node block time at refresh') }}: {{ formatTime(manageSnapshot.chain.time) }} · #{{ manageSnapshot.chain.height }} · {{ String(manageSnapshot.chain.hash || '').slice(0, 10) }}…{{ String(manageSnapshot.chain.hash || '').slice(-8) }}</p>
        <p class="text-xs text-aa-muted">{{ t('ordinary.refreshHint', 'Use Load V3 State to refresh maturity. Your device clock does not advance the verified node state.') }}</p>
        <p v-if="!isGovernanceOwner" role="status" class="text-aa-warning">{{ t('ordinary.connectOwner', 'Connect the configured Neo backup owner.') }}</p>
        <p v-if="manageSnapshot.marketEscrow" class="text-aa-warning">{{ t('ordinary.escrow', 'This account is in market escrow. Plugin changes and recovery are unavailable.') }}</p>
        <p class="text-xs text-aa-muted">{{ t('ordinary.pendingRace', 'State is checked again before wallet signing. Another device can change the pending proposal before your transaction is included; these actions affect the pending update for that role at execution.') }}</p>
        <p class="text-xs text-aa-muted">{{ t('ordinary.rotationDelay', 'Installing into an empty slot is immediate. Replacing an installed plugin requires a separate confirmation after 24 hours. The backup owner authorizes and pays; review the wallet fee.') }}</p>
      </div>
      <div v-if="manageSnapshot.loadedAt" class="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <PendingModuleUpdateCard role="verifier" :pending="manageSnapshot.pendingVerifier" :chain-time="manageSnapshot.chain.time" :can-confirm="canGovernanceAction('confirmVerifierUpdate')" :can-cancel="canGovernanceAction('cancelVerifierUpdate')" @confirm="confirmGovernanceChange('confirmVerifierUpdate')" @cancel="confirmGovernanceChange('cancelVerifierUpdate')" />
        <PendingModuleUpdateCard role="hook" :pending="manageSnapshot.pendingHook" :chain-time="manageSnapshot.chain.time" :can-confirm="canGovernanceAction('confirmHookUpdate')" :can-cancel="canGovernanceAction('cancelHookUpdate')" @confirm="confirmGovernanceChange('confirmHookUpdate')" @cancel="confirmGovernanceChange('cancelHookUpdate')" />
      </div>
      <div
        v-if="manageSnapshot.loadedAt"
        class="grid grid-cols-1 lg:grid-cols-2 gap-8"
      >
        <RotateVerifierCard
          v-model:verifier-contract="manageForm.verifierContract"
          v-model:verifier-params="manageForm.verifierParams"
          :busy="manageBusy.verifier"
          :disabled="!canGovernanceAction('updateVerifier')"
          @update="confirmGovernanceChange('updateVerifier')"
        />

        <RotateHookCard
          v-model:hook-contract="manageForm.hookContract"
          :busy="manageBusy.hook"
          :disabled="!canGovernanceAction('updateHook')"
          @update="confirmGovernanceChange('updateHook')"
        />
      </div>

      <div v-if="manageSnapshot.loadedAt">
        <div class="card hover:border-aa-muted transition-colors duration-200">
          <h3 class="text-sm font-bold text-aa-text mb-5">
            {{ t("studioPanels.escapeHatch", "Escape Hatch") }}
          </h3>
          <div class="space-y-4">
            <p class="text-xs text-aa-muted">{{ t('ordinary.escapeCleanup', 'Recovery removes the old hook, its configuration, old verifier configuration, pending plugin changes and calls, and the on-chain metadata URI. It does not transfer assets. Old plugins must successfully clear their configuration; a cleanup fault rolls back the recovery, and a mined failure may still cost fees.') }}</p>
            <p class="text-xs text-aa-warning">{{ t('ordinary.escapeOwnerLoss', 'Keep a separate backup of the Neo backup owner. If its only key is lost, this recovery path cannot replace that witness.') }}</p>
            <p v-if="manageSnapshot.escapeActive" class="text-sm">{{ t('ordinary.escapeMatures', 'Recovery matures at') }}: {{ formatTime(manageSnapshot.escapeTriggeredAt + manageSnapshot.escapeTimelock * 1000) }}</p>
            <label class="block text-sm" for="governance-escape-mode">{{ t('ordinary.escapeMode', 'Authorization after recovery') }}
              <select id="governance-escape-mode" v-model="manageForm.escapeMode" class="input-field mt-1">
                <option value="backup-owner">{{ t('ordinary.backupMode', 'Backup owner Neo witness') }}</option>
                <option value="verifier">{{ t('ordinary.verifierMode', 'New verifier with initialization parameters') }}</option>
              </select>
            </label>
            <div v-if="manageForm.escapeMode === 'verifier'">
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
            <div v-if="manageForm.escapeMode === 'verifier'" class="space-y-2">
              <label for="governance-escape-params" class="block text-xs font-semibold text-aa-muted">{{ t('ordinary.pendingParams', 'Initialization parameters (hex)') }}</label>
              <textarea id="governance-escape-params" v-model="manageForm.escapeVerifierParams" class="input-field font-mono text-xs" rows="3" />
              <label class="flex gap-2 text-xs text-aa-muted"><input type="checkbox" v-model="manageForm.escapeAllowEmptyParams" />{{ t('ordinary.allowEmptyParams', 'This verifier needs no initialization parameters. I have checked its configuration requirements.') }}</label>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                :aria-label="
                  t('studioPanels.ariaInitiateEscape', 'Initiate escape')
                "
                class="btn-warning w-full"
                :class="{ 'btn-loading': manageBusy.initiateEscape }"
                :disabled="!canGovernanceAction('initiateEscape')"
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
                :disabled="!canGovernanceAction('finalizeEscape')"
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
          :disabled="governanceBusy || !canManageTarget || !isGovernanceOwner"
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
import { inject, ref, watch } from "vue";
import { useToast } from "vue-toastification";
import { useI18n } from "@/i18n";
import GovernanceEmptyState from "./ManageGovernancePanel/GovernanceEmptyState.vue";
import GovernanceSnapshotCard from "./ManageGovernancePanel/GovernanceSnapshotCard.vue";
import RotateVerifierCard from "./ManageGovernancePanel/RotateVerifierCard.vue";
import RotateHookCard from "./ManageGovernancePanel/RotateHookCard.vue";
import AccountMetadataCard from "./ManageGovernancePanel/AccountMetadataCard.vue";
import PendingModuleUpdateCard from "./ManageGovernancePanel/PendingModuleUpdateCard.vue";
import ConfirmDialog from "./ManageGovernancePanel/ConfirmDialog.vue";

const { t } = useI18n();
const toast = useToast();
const formatTime = (value) => Number.isSafeInteger(value) && value > 0 ? new Date(value).toISOString() : "—";

const confirmModal = ref(null);

const studio = inject("studio");
const {
  manageForm,
  manageBusy,
  manageSnapshot,
  metadataForm,
  metadataBusy,
  canManageTarget,
  governanceBusy,
  governanceOutcome,
  isGovernanceOwner,
  canGovernanceAction,
  prepareGovernanceAction,
  submitGovernanceAction,
  autoLoadedAccounts,
  loadAccountConfiguration,
  updateVerifier,
  updateHook,
  initiateEscape,
  finalizeEscape,
  saveMetadata,
} = studio;

watch([manageForm, manageSnapshot], () => { confirmModal.value = null; }, { deep: true });
function confirmGovernanceChange(operation) {
  try {
    const review = prepareGovernanceAction(operation);
    const labels = {
      confirmVerifierUpdate: t('ordinary.confirmVerifier', 'Confirm verifier update'),
      cancelVerifierUpdate: t('ordinary.cancelVerifier', 'Cancel verifier update'),
      confirmHookUpdate: t('ordinary.confirmHook', 'Confirm hook update'),
      cancelHookUpdate: t('ordinary.cancelHook', 'Cancel hook update'),
      updateVerifier: t('studioPanels.updateVerifier', 'Update Verifier'),
      updateHook: t('studioPanels.updateHook', 'Update Hook'),
      initiateEscape: t('studioPanels.initiateEscape', 'Initiate Escape'),
      finalizeEscape: t('studioPanels.finalizeEscape', 'Finalize Escape'),
    };
    let detail = t('ordinary.pendingRace', 'State is checked again before wallet signing. Another device can change the pending proposal before your transaction is included; these actions affect the pending update for that role at execution.');
    if (operation === 'initiateEscape') detail = t('studioPanels.confirmInitiateEscape', 'This starts the recovery countdown. The backup owner must explicitly finalize after the timelock; nothing changes automatically. Continue?');
    if (operation === 'finalizeEscape') detail = t('studioPanels.confirmFinalizeEscape', 'Replace the verifier, remove the hook, and clear pending plugin state and the metadata URI. Old plugin cleanup must succeed. Assets stay at the same address. Continue?');
    const displayHash160 = (value) => {
      const raw = String(value ?? '').trim();
      if (!raw) return '—';
      return `0x${raw.replace(/^0x/i, '')}`;
    };
    const displayBytes = (value) => {
      const raw = String(value ?? '').trim();
      if (!raw) return '0x';
      return raw.toLowerCase().startsWith('0x') ? raw : `0x${raw}`;
    };
    const pending = operation.includes('Verifier') ? review.snapshot.pendingVerifier : operation.includes('Hook') ? review.snapshot.pendingHook : null;
    let target = pending?.exists && pending.full
      ? `\n${t('ordinary.pendingTarget', 'Pending module')}: ${displayHash160(pending.module)}\n${t('ordinary.pendingParams', 'Initialization parameters (hex)')}: ${displayBytes(pending.params)}`
      : '';
    if (operation === 'updateVerifier' || operation === 'updateHook') {
      target = `\n${t('ordinary.requestedTarget', 'Requested module')}: ${displayHash160(review.args[1]?.value)}`
        + (operation === 'updateVerifier' ? `\n${t('ordinary.pendingParams', 'Initialization parameters (hex)')}: ${displayBytes(review.args[2]?.value)}` : '');
    }
    if (operation === 'finalizeEscape' && review.options.mode === 'verifier') {
      target = `\n${t('ordinary.newVerifier', 'New verifier')}: ${displayHash160(review.args[1]?.value)}\n${t('ordinary.pendingParams', 'Initialization parameters (hex)')}: ${displayBytes(review.args[2]?.value)}`;
    } else if (operation === 'finalizeEscape' && review.options.mode === 'backup-owner') {
      target = `\n${t('ordinary.recoveryMode', 'Recovery mode')}: ${t('ordinary.backupMode', 'Backup owner Neo witness')}`;
    }
    confirmModal.value = { title: labels[operation], confirmLabel: labels[operation], danger: operation === 'finalizeEscape' || operation.startsWith('cancel'), message: `${detail}\nAccountId: ${review.snapshot.accountId}${target}`, onConfirm: () => submitGovernanceAction(review) };
  } catch (error) { toast.error(error.message); }
}
const confirmInitiateEscape = () => confirmGovernanceChange('initiateEscape');
const confirmFinalizeEscape = () => confirmGovernanceChange('finalizeEscape');
</script>

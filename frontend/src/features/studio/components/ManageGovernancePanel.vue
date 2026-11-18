<template>
  <section class="card">
    <h2 class="text-lg font-bold text-sa-text mb-2">
      {{ t("studioPanels.manageTitle", "Manage Governance") }}
    </h2>
    <p class="text-sm text-sa-muted mb-8">
      {{
        t(
          "studioPanels.manageSubtitle",
          "Load a V3 account, inspect its verifier / hook / escape state, then rotate plugins or operate the escape hatch.",
        )
      }}
    </p>

    <div class="space-y-8">
      <div class="bg-sa-panel p-5 rounded-lg border border-sa-border/60">
        <label
          for="manage-target-account"
          class="block text-sm font-semibold text-sa-text mb-3"
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
            class="input-field flex-1 font-mono text-sm py-2.5 px-4 bg-sa-dark"
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
        <p class="mt-2 text-xs text-sa-muted">
          {{
            t(
              "studioPanels.v3StateKeyedHint",
              "V3 state is keyed by `accountId` hash160, not by the derived virtual address.",
            )
          }}
        </p>
      </div>

      <p v-if="governanceOutcome" role="status" class="text-sm text-sa-warning" data-testid="custom-governance-outcome">{{ governanceOutcome }}</p>
      <p v-if="governanceBusy" role="status" class="text-sm text-sa-muted">{{ t('custom.waitForWallet', 'Waiting for the wallet or chain confirmation. Keep this page open.') }}</p>
      <!-- Empty state when no account is loaded -->
      <GovernanceEmptyState v-if="!manageSnapshot.loadedAt" />

      <transition name="fade-in-up">
        <GovernanceSnapshotCard
          v-if="manageSnapshot.loadedAt"
          :snapshot="manageSnapshot"
        />
      </transition>

      <div v-if="manageSnapshot.loadedAt" class="space-y-3 text-sm">
        <div v-if="manageSnapshot.ownerOnlyRecovery" role="status" class="rounded-lg border border-sa-warning p-4" data-testid="custom-owner-only-state">
          <p>{{ t('custom.ownerOnlyState', 'This account permanently uses the backup owner witness. Verifier and hook configuration cannot be restored.') }}</p>
          <p class="mt-2">{{ t('custom.ownerOnlyOperations', 'The backup owner can directly authorize account operations. The account identity, asset address and nonce remain unchanged. This recovery does not transfer or refund balances, and cannot guarantee permissions in external contracts.') }}</p>
          <router-link :to="{ path: '/app', query: { accountId: `0x${manageSnapshot.accountId}` } }" class="btn-secondary btn-sm mt-3">{{ t('studioPanels.openOperations', 'Open Operations') }}</router-link>
        </div>
        <p data-testid="custom-chain-time">{{ t('custom.chainTime', 'Node block time at refresh') }}: {{ formatTime(manageSnapshot.chain.time) }} · #{{ manageSnapshot.chain.height }} · {{ String(manageSnapshot.chain.hash || '').slice(0, 10) }}…{{ String(manageSnapshot.chain.hash || '').slice(-8) }}</p>
        <p class="text-xs text-sa-muted">{{ t('custom.refreshHint', 'Use Load V3 State to refresh maturity. Your device clock does not advance the verified node state.') }}</p>
        <p v-if="!isGovernanceOwner" role="status" class="text-sa-warning">{{ t('custom.connectOwner', 'Connect the configured Neo backup owner.') }}</p>
        <p v-if="manageSnapshot.marketEscrow" class="text-sa-warning">{{ t('custom.escrow', 'This account is in market escrow. Plugin changes and recovery are unavailable.') }}</p>
        <p class="text-xs text-sa-muted">{{ t('custom.pendingRace', 'State is checked again before wallet signing. Another device can change the pending proposal before your transaction is included; these actions affect the pending update for that role at execution.') }}</p>
        <p v-if="!manageSnapshot.ownerOnlyRecovery" class="text-xs text-sa-muted">{{ t('custom.rotationDelay', 'Installing into an empty slot is immediate. Replacing an installed plugin requires a separate confirmation after 24 hours. The backup owner authorizes and pays; review the wallet fee.') }}</p>
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
        <div class="card hover:border-sa-muted transition-colors duration-200">
          <h3 class="text-sm font-bold text-sa-text mb-5">
            {{ t("studioPanels.escapeHatch", "Escape Hatch") }}
          </h3>
          <div class="space-y-4">
            <p v-if="!manageSnapshot.ownerOnlyRecovery" class="text-xs text-sa-muted">{{ t('custom.escapeCleanup', 'Recovery removes the old hook, its configuration, old verifier configuration, pending plugin changes and calls, and the on-chain metadata URI. It does not transfer assets. Old plugins must successfully clear their configuration; a cleanup fault rolls back the recovery, and a mined failure may still cost fees.') }}</p>
            <p class="text-xs text-sa-warning">{{ t('custom.escapeOwnerLoss', 'Keep a separate backup of the Neo backup owner. If its only key is lost, this recovery path cannot replace that witness.') }}</p>
            <p v-if="manageSnapshot.escapeActive" class="text-sm">{{ t('custom.escapeMatures', 'Recovery matures at') }}: {{ formatTime(manageSnapshot.escapeTriggeredAt + manageSnapshot.escapeTimelock * 1000) }}</p>
            <label class="block text-sm" for="governance-escape-mode">{{ t('custom.escapeMode', 'Authorization after recovery') }}
              <select id="governance-escape-mode" v-model="manageForm.escapeMode" :disabled="governanceBusy || manageSnapshot.ownerOnlyRecovery" class="input-field mt-1">
                <option value="backup-owner">{{ t('custom.backupMode', 'Backup owner Neo witness') }}</option>
                <option value="verifier">{{ t('custom.verifierMode', 'New verifier with initialization parameters') }}</option>
              </select>
            </label>
            <div v-if="manageForm.escapeMode === 'verifier'">
              <label
                for="governance-escape-verifier"
                class="block text-xs font-semibold text-sa-muted mb-1"
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
                class="input-field font-mono text-sm py-2 px-3 bg-sa-dark"
                :placeholder="t('studioPanels.hashPlaceholder', '0x...')"
              />
            </div>
            <div v-if="manageForm.escapeMode === 'verifier'" class="space-y-2">
              <label for="governance-escape-params" class="block text-xs font-semibold text-sa-muted">{{ t('custom.pendingParams', 'Initialization parameters (hex)') }}</label>
              <textarea id="governance-escape-params" v-model="manageForm.escapeVerifierParams" class="input-field font-mono text-xs" rows="3" />
              <label class="flex gap-2 text-xs text-sa-muted"><input type="checkbox" v-model="manageForm.escapeAllowEmptyParams" />{{ t('custom.allowEmptyParams', 'This verifier needs no initialization parameters. I have checked its configuration requirements.') }}</label>
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
            <p class="text-xs text-sa-muted">
              {{
                t(
                  "studioPanels.escapeHint",
                  "Only the configured backup owner can operate the escape hatch.",
                )
              }}
            </p>
            <div class="space-y-3 rounded-lg border border-sa-warning/40 p-4" data-testid="custom-owner-only-recovery">
              <h4 class="font-semibold">{{ t('custom.ownerOnlyTitle', 'Permanent recovery without plugin cleanup') }}</h4>
              <p class="text-xs text-sa-muted">{{ t('custom.ownerOnlyExplanation', 'If a broken verifier or hook prevents normal recovery, use the same matured recovery timer to permanently return authorization to the backup owner. This path calls no old or new plugin. It removes active plugin bindings, pending changes and the metadata URI.') }}</p>
              <p class="text-xs text-sa-warning">{{ t('custom.ownerOnlyIrreversible', 'This is irreversible: this account can never install a verifier or hook again. Keep the backup owner key available; losing it can permanently lock the account.') }}</p>
              <p class="text-xs text-sa-muted">{{ t('custom.ownerOnlyOperations', 'The backup owner can directly authorize account operations. The account identity, asset address and nonce remain unchanged. This recovery does not transfer or refund balances, and cannot guarantee permissions in external contracts.') }}</p>
              <p v-if="!manageSnapshot.ownerOnlyRecoverySupported" role="status" class="text-xs text-sa-warning">{{ t('custom.ownerOnlyUnsupported', 'This deployment does not support permanent owner-only recovery. The required write method and safe mode query must both be present in its deployed ABI.') }}</p>
              <label v-if="manageSnapshot.ownerOnlyRecoverySupported && !manageSnapshot.ownerOnlyRecovery" class="flex gap-2 text-xs" for="governance-owner-only-acknowledgement">
                <input id="governance-owner-only-acknowledgement" type="checkbox" v-model="manageForm.escapeOwnerOnlyAcknowledged" :disabled="governanceBusy" />
                {{ t('custom.ownerOnlyAcknowledgement', 'I understand this account will permanently use only the backup owner witness, and plugins can never be restored.') }}
              </label>
              <button type="button" class="btn-warning" :disabled="!manageForm.escapeOwnerOnlyAcknowledged || !canGovernanceAction('finalizeEscapeToOwner')" @click="confirmGovernanceChange('finalizeEscapeToOwner')">{{ t('custom.ownerOnlyFinalize', 'Finalize permanent owner-only recovery') }}</button>
            </div>
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
      confirmVerifierUpdate: t('custom.confirmVerifier', 'Confirm verifier update'),
      cancelVerifierUpdate: t('custom.cancelVerifier', 'Cancel verifier update'),
      confirmHookUpdate: t('custom.confirmHook', 'Confirm hook update'),
      cancelHookUpdate: t('custom.cancelHook', 'Cancel hook update'),
      updateVerifier: t('studioPanels.updateVerifier', 'Update Verifier'),
      updateHook: t('studioPanels.updateHook', 'Update Hook'),
      initiateEscape: t('studioPanels.initiateEscape', 'Initiate Escape'),
      finalizeEscape: t('studioPanels.finalizeEscape', 'Finalize Escape'),
      finalizeEscapeToOwner: t('custom.ownerOnlyFinalize', 'Finalize permanent owner-only recovery'),
    };
    let detail = t('custom.pendingRace', 'State is checked again before wallet signing. Another device can change the pending proposal before your transaction is included; these actions affect the pending update for that role at execution.');
    if (operation === 'initiateEscape') detail = t('studioPanels.confirmInitiateEscape', 'This starts the recovery countdown. The backup owner must explicitly finalize after the timelock; nothing changes automatically. Continue?');
    if (operation === 'finalizeEscape') detail = t('studioPanels.confirmFinalizeEscape', 'Replace the verifier, remove the hook, and clear pending plugin state and the metadata URI. Old plugin cleanup must succeed. Assets stay at the same address. Continue?');
    if (operation === 'finalizeEscapeToOwner') detail = `${t('custom.ownerOnlyIrreversible', 'This is irreversible: this account can never install a verifier or hook again. Keep the backup owner key available; losing it can permanently lock the account.')}\n${t('custom.ownerOnlyExplanation', 'If a broken verifier or hook prevents normal recovery, use the same matured recovery timer to permanently return authorization to the backup owner. This path calls no old or new plugin. It removes active plugin bindings, pending changes and the metadata URI.')}\n${t('custom.ownerOnlyOperations', 'The backup owner can directly authorize account operations. The account identity, asset address and nonce remain unchanged. This recovery does not transfer or refund balances, and cannot guarantee permissions in external contracts.')}`;
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
      ? `\n${t('custom.pendingTarget', 'Pending module')}: ${displayHash160(pending.module)}\n${t('custom.pendingParams', 'Initialization parameters (hex)')}: ${displayBytes(pending.params)}`
      : '';
    if (operation === 'updateVerifier' || operation === 'updateHook') {
      target = `\n${t('custom.requestedTarget', 'Requested module')}: ${displayHash160(review.args[1]?.value)}`
        + (operation === 'updateVerifier' ? `\n${t('custom.pendingParams', 'Initialization parameters (hex)')}: ${displayBytes(review.args[2]?.value)}` : '');
    }
    if (operation === 'finalizeEscape' && review.options.mode === 'verifier') {
      target = `\n${t('custom.newVerifier', 'New verifier')}: ${displayHash160(review.args[1]?.value)}\n${t('custom.pendingParams', 'Initialization parameters (hex)')}: ${displayBytes(review.args[2]?.value)}`;
    } else if (operation === 'finalizeEscape' && review.options.mode === 'backup-owner') {
      target = `\n${t('custom.recoveryMode', 'Recovery mode')}: ${t('custom.backupMode', 'Backup owner Neo witness')}`;
    }
    if (operation === 'finalizeEscapeToOwner') target = `\n${t('custom.connectOwner', 'Connect the configured Neo backup owner.')}: ${displayHash160(review.snapshot.backupOwner)}`;
    confirmModal.value = { title: labels[operation], confirmLabel: labels[operation], danger: operation.startsWith('finalizeEscape') || operation.startsWith('cancel'), message: `${detail}\nAccountId: ${review.snapshot.accountId}${target}`, onConfirm: () => submitGovernanceAction(review) };
  } catch (error) { toast.error(error.message); }
}
const confirmInitiateEscape = () => confirmGovernanceChange('initiateEscape');
const confirmFinalizeEscape = () => confirmGovernanceChange('finalizeEscape');
</script>

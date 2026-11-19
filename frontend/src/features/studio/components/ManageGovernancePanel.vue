<template>
  <section class="card">
    <h2 class="text-lg font-bold text-sa-text mb-2">
      {{ t("studioPanels.manageTitleV4", "Manage Configuration") }}
    </h2>
    <p class="text-sm text-sa-muted mb-8">
      {{
        t(
          "studioPanels.manageSubtitleV4",
          "Load a v4 account, inspect its control record and installed modules, then propose a configuration intent. Intents mature for 24 hours before they can be confirmed.",
        )
      }}
    </p>

    <div class="space-y-8">
      <div class="bg-sa-panel p-5 rounded-lg border border-sa-border/60">
        <label
          for="manage-target-account"
          class="block text-sm font-semibold text-sa-text mb-3"
          >{{ t("studioPanels.targetAccountLabel", "Target AccountId Hash") }}</label
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
            :disabled="managementBusy || !canManageTarget"
            @click="loadAccountConfiguration"
          >
            {{
              manageBusy.load
                ? t("studioPanels.loading", "Loading...")
                : t("studioPanels.loadAccountState", "Load Account State")
            }}
          </button>
        </div>
        <p class="mt-2 text-xs text-sa-muted">
          {{
            t(
              "studioPanels.accountStateKeyedHint",
              "Configuration is keyed by the account id (hash160), not by the derived proxy address.",
            )
          }}
        </p>
      </div>

      <p v-if="configurationOutcome" role="status" class="text-sm text-sa-warning whitespace-pre-wrap" data-testid="configuration-outcome">{{ configurationOutcome }}</p>
      <p v-if="managementBusy" role="status" class="text-sm text-sa-muted">{{ t('custom.waitForWallet', 'Waiting for the wallet or chain confirmation. Keep this page open.') }}</p>

      <GovernanceEmptyState v-if="!manageSnapshot.loadedAt" />

      <template v-if="manageSnapshot.loadedAt">
        <!-- Control record -->
        <div class="card">
          <h3 class="text-sm font-bold text-sa-text mb-4">{{ t('studioPanels.controlRecord', 'Control Record') }}</h3>
          <dl class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div><dt class="text-xs uppercase text-sa-muted">{{ t('studioPanels.statusLabel', 'Status') }}</dt><dd data-testid="account-status">{{ manageForm.status }}</dd></div>
            <div><dt class="text-xs uppercase text-sa-muted">{{ t('studioPanels.custody', 'Custody') }}</dt><dd class="font-mono break-all">{{ manageForm.custody || '—' }}</dd></div>
            <div><dt class="text-xs uppercase text-sa-muted">{{ t('studioPanels.recoveryAuthority', 'Recovery authority') }}</dt><dd class="font-mono break-all">{{ isZeroHash(manageForm.recoveryAuthority) ? t('custom.none', 'none') : manageForm.recoveryAuthority }}</dd></div>
            <div><dt class="text-xs uppercase text-sa-muted">{{ t('studioPanels.recoveryTimelock', 'Recovery timelock') }}</dt><dd>{{ recoveryTimelockText }}</dd></div>
            <div><dt class="text-xs uppercase text-sa-muted">{{ t('studioPanels.authorityEpoch', 'Authority epoch') }}</dt><dd>{{ manageForm.authorityEpoch }}</dd></div>
            <div><dt class="text-xs uppercase text-sa-muted">{{ t('studioPanels.configurationNonce', 'Configuration nonce') }}</dt><dd>{{ manageForm.configurationNonce }}</dd></div>
            <div><dt class="text-xs uppercase text-sa-muted">{{ t('studioPanels.hookOrderRevision', 'Hook order revision') }}</dt><dd>{{ manageForm.hookOrderRevision }}</dd></div>
            <div><dt class="text-xs uppercase text-sa-muted">{{ t('studioPanels.defaultAuthorization', 'Default authorization') }}</dt><dd>{{ manageForm.defaultOperationAuthorization ? t('custom.enabled', 'enabled') : t('custom.disabled', 'disabled') }} / {{ manageForm.defaultMessageAuthorization ? t('custom.enabled', 'enabled') : t('custom.disabled', 'disabled') }}</dd></div>
          </dl>
          <p data-testid="configuration-chain-time" class="mt-4 text-xs text-sa-muted">{{ t('custom.chainTime', 'Node block time at refresh') }}: {{ formatTime(manageSnapshot.chain.time * 1000) }} · #{{ manageSnapshot.chain.height }} · {{ String(manageSnapshot.chain.hash || '').slice(0, 10) }}…{{ String(manageSnapshot.chain.hash || '').slice(-8) }}</p>
          <p class="text-xs text-sa-muted">{{ t('custom.refreshHintV4', 'Use Load Account State to refresh maturity. Your device clock does not advance the verified node state.') }}</p>
          <p v-if="!isCustodyOwner" role="status" class="mt-2 text-sa-warning">{{ t('custom.connectCustody', 'Connect the account custody wallet to propose a configuration.') }}</p>
          <p v-if="manageForm.marketEscrowActive" class="mt-2 text-sa-warning">{{ t('custom.escrow', 'This account is in market escrow. Configuration changes and recovery are unavailable.') }}</p>
        </div>

        <!-- Installed modules -->
        <div class="card">
          <h3 class="text-sm font-bold text-sa-text mb-4">{{ t('studioPanels.installedModules', 'Installed Modules') }}</h3>
          <p v-if="!manageForm.modules.length" class="text-sm text-sa-muted">{{ t('studioPanels.noModules', 'No module is installed yet. Install a validator to authorize operations, or a hook to constrain them.') }}</p>
          <table v-else class="w-full text-left text-xs" data-testid="installed-modules">
            <thead class="text-sa-muted uppercase">
              <tr>
                <th class="py-1">Id</th>
                <th class="py-1">{{ t('studioPanels.moduleTypeLabel', 'Type') }}</th>
                <th class="py-1">{{ t('studioPanels.moduleContract', 'Contract') }}</th>
                <th class="py-1">{{ t('studioPanels.moduleGeneration', 'Generation') }}</th>
                <th class="py-1">{{ t('studioPanels.moduleRevision', 'Revision') }}</th>
                <th class="py-1">{{ t('studioPanels.moduleCapabilities', 'Capabilities') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="module in manageForm.modules" :key="module.moduleId" class="border-t border-sa-border/40">
                <td class="py-2 font-mono">{{ module.moduleId }}</td>
                <td class="py-2">{{ module.moduleType }}</td>
                <td class="py-2 font-mono break-all">{{ module.contractHash }}</td>
                <td class="py-2">{{ module.credentialGeneration }}</td>
                <td class="py-2">{{ module.moduleRevision }}</td>
                <td class="py-2">{{ capabilityText(module) }}</td>
              </tr>
            </tbody>
          </table>
          <p class="mt-3 text-xs text-sa-muted">{{ t('studioPanels.hookOrderLabel', 'Hook order') }}: {{ manageForm.hookIds.length ? manageForm.hookIds.join(' → ') : t('custom.none', 'none') }}</p>
        </div>

        <!-- Pending intent -->
        <div class="card">
          <h3 class="text-sm font-bold text-sa-text mb-4">{{ t('studioPanels.pendingIntent', 'Pending Configuration Intent') }}</h3>
          <template v-if="manageForm.pendingIntent">
            <p class="text-sm">{{ t('studioPanels.intentId', 'Intent') }} #{{ manageForm.pendingIntent.intentId }} · {{ pendingStatusText }}</p>
            <p class="mt-1 text-xs text-sa-muted">{{ t('studioPanels.intentWindow', 'Matures at') }} {{ formatTime(Number(manageForm.pendingIntent.matureAt)) }} · {{ t('studioPanels.intentExpires', 'expires at') }} {{ formatTime(Number(manageForm.pendingIntent.expiresAt)) }}</p>
            <p class="mt-1 text-xs text-sa-muted">{{ t('studioPanels.intentActions', 'Actions') }}: {{ manageForm.pendingIntent.actions.length }}</p>
            <div class="mt-4 flex flex-wrap gap-3">
              <button type="button" class="btn-primary" :class="{ 'btn-loading': manageBusy.confirm }" :disabled="managementBusy || !isCustodyOwner || pendingStatusText !== t('custom.intentMature', 'mature')" @click="confirmPendingIntent">{{ t('custom.intentConfirm', 'Confirm intent') }}</button>
              <button type="button" class="btn-warning" :class="{ 'btn-loading': manageBusy.cancel }" :disabled="managementBusy || !isCustodyOwner" @click="cancelPendingIntent">{{ t('custom.intentCancel', 'Cancel intent') }}</button>
            </div>
          </template>
          <p v-else class="text-sm text-sa-muted">{{ t('custom.noPendingIntent', 'There is no pending configuration intent.') }}</p>
        </div>

        <!-- Install / configure / uninstall -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div class="card">
            <h3 class="text-sm font-bold text-sa-text mb-4">{{ t('studioPanels.installModule', 'Install Module') }}</h3>
            <label for="module-contract" class="block text-xs font-semibold text-sa-muted mb-1">{{ t('studioPanels.moduleContract', 'Contract') }}</label>
            <input id="module-contract" v-model="manageForm.moduleContract" type="text" class="input-field font-mono text-sm py-2 px-3 bg-sa-dark" :placeholder="t('studioPanels.hashPlaceholder', '0x...')" />
            <label for="module-init-data" class="block mt-3 text-xs font-semibold text-sa-muted mb-1">{{ t('studioPanels.moduleInitData', 'onInstall data (JSON array)') }}</label>
            <textarea id="module-init-data" v-model="manageForm.moduleInitDataJson" rows="4" class="input-field font-mono text-xs" />
            <p v-if="manageForm.moduleProfileDigest" class="mt-2 break-all text-xs text-sa-muted">{{ t('studioPanels.moduleProfileDigest', 'Profile digest') }}: 0x{{ manageForm.moduleProfileDigest }}</p>
            <button type="button" class="btn-primary mt-4" :disabled="managementBusy || !isCustodyOwner" @click="prepareInstallModule">{{ t('studioPanels.installModuleAction', 'Install module') }}</button>
            <p class="mt-2 text-xs text-sa-muted">{{ t('studioPanels.installProfileHint', 'The profile is read from the module itself and its digest is what the core re-checks. A mismatched digest is refused on-chain.') }}</p>
          </div>

          <div class="card">
            <h3 class="text-sm font-bold text-sa-text mb-4">{{ t('studioPanels.configureModule', 'Configure or Remove') }}</h3>
            <label for="module-select" class="block text-xs font-semibold text-sa-muted mb-1">{{ t('studioPanels.selectModule', 'Installed module') }}</label>
            <select id="module-select" v-model="manageForm.selectedModuleId" class="input-field text-sm py-2 px-3 bg-sa-dark">
              <option value="">{{ t('custom.none', 'none') }}</option>
              <option v-for="module in manageForm.modules" :key="module.moduleId" :value="module.moduleId">#{{ module.moduleId }} · {{ module.moduleType }} · {{ module.contractHash.slice(0, 10) }}…</option>
            </select>
            <label for="module-config-data" class="block mt-3 text-xs font-semibold text-sa-muted mb-1">{{ t('studioPanels.moduleConfigData', 'configure(data) JSON array') }}</label>
            <textarea id="module-config-data" v-model="manageForm.moduleConfigJson" rows="3" class="input-field font-mono text-xs" />
            <p v-if="sessionKeyValueWarning" role="alert" data-testid="session-key-value-warning" class="mt-2 rounded-lg border border-sa-warning/50 bg-sa-warning/10 p-3 text-xs text-sa-warning">
              {{ sessionKeyValueWarning }}
            </p>
            <label for="module-deinit-data" class="block mt-3 text-xs font-semibold text-sa-muted mb-1">{{ t('studioPanels.moduleDeInitData', 'onUninstall data JSON array') }}</label>
            <textarea id="module-deinit-data" v-model="manageForm.moduleDeInitDataJson" rows="3" class="input-field font-mono text-xs" />
            <div class="mt-4 flex flex-wrap gap-3">
              <button type="button" class="btn-primary" :disabled="managementBusy || !isCustodyOwner" @click="prepareConfigureModule">{{ t('studioPanels.configureModuleAction', 'Configure') }}</button>
              <button type="button" class="btn-warning" :disabled="managementBusy || !isCustodyOwner" @click="prepareUninstallModule">{{ t('studioPanels.uninstallModuleAction', 'Uninstall') }}</button>
              <button type="button" class="btn-secondary" :disabled="managementBusy || !isCustodyOwner" @click="revokeCredentials">{{ t('studioPanels.revokeCredentials', 'Revoke credentials') }}</button>
            </div>
            <p class="mt-2 text-xs text-sa-muted">{{ t('studioPanels.revokeHint', 'Revoking credentials rotates the instance generation so signatures bound to the old generation stop validating. The instance stays installed.') }}</p>
          </div>
        </div>

        <!-- Policies -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div class="card">
            <h3 class="text-sm font-bold text-sa-text mb-4">{{ t('studioPanels.hookOrderTitle', 'Hook Order') }}</h3>
            <label class="block text-xs font-semibold text-sa-muted mb-1">{{ t('studioPanels.hookOrderInput', 'Hook ids, in execution order') }}</label>
            <div class="flex flex-wrap items-center gap-2">
              <input v-for="(_, index) in manageForm.hookIds" :key="index" v-model="manageForm.hookIds[index]" type="text" class="input-field w-20 font-mono text-xs py-1 px-2 bg-sa-dark" />
              <button type="button" class="btn-secondary btn-sm" @click="addRow(manageForm.hookIds)">+</button>
              <button type="button" class="btn-secondary btn-sm" @click="removeRow(manageForm.hookIds, manageForm.hookIds.length - 1)">−</button>
            </div>
            <button type="button" class="btn-primary mt-4" :disabled="managementBusy || !isCustodyOwner" @click="prepareHookOrder">{{ t('studioPanels.setHookOrder', 'Set hook order') }}</button>
            <p class="mt-2 text-xs text-sa-muted">{{ t('studioPanels.hookOrderHint', 'Only installed hook ids may appear, and the order is core-owned: no hook can reorder itself.') }}</p>
          </div>

          <div class="card">
            <h3 class="text-sm font-bold text-sa-text mb-4">{{ t('studioPanels.thresholdPolicy', 'Threshold Policy') }}</h3>
            <label for="threshold-policy-id" class="block text-xs font-semibold text-sa-muted mb-1">{{ t('studioPanels.policyId', 'Policy id (0 = allocate)') }}</label>
            <input id="threshold-policy-id" v-model="manageForm.thresholdPolicyId" type="text" class="input-field w-24 font-mono text-xs py-1 px-2 bg-sa-dark" />
            <label for="threshold-value" class="block mt-3 text-xs font-semibold text-sa-muted mb-1">{{ t('studioPanels.thresholdValue', 'Threshold') }}</label>
            <input id="threshold-value" v-model="manageForm.threshold" type="text" class="input-field w-24 font-mono text-xs py-1 px-2 bg-sa-dark" />
            <label class="block mt-3 text-xs font-semibold text-sa-muted mb-1">{{ t('studioPanels.thresholdMembers', 'Member module ids') }}</label>
            <div class="flex flex-wrap items-center gap-2">
              <input v-for="(_, index) in manageForm.thresholdMembers" :key="index" v-model="manageForm.thresholdMembers[index]" type="text" class="input-field w-20 font-mono text-xs py-1 px-2 bg-sa-dark" />
              <button type="button" class="btn-secondary btn-sm" @click="addRow(manageForm.thresholdMembers)">+</button>
              <button type="button" class="btn-secondary btn-sm" @click="removeRow(manageForm.thresholdMembers, manageForm.thresholdMembers.length - 1)">−</button>
            </div>
            <label class="mt-3 flex gap-2 text-xs"><input type="checkbox" v-model="manageForm.thresholdActive" />{{ t('studioPanels.thresholdActive', 'Policy is active') }}</label>
            <button type="button" class="btn-primary mt-4" :disabled="managementBusy || !isCustodyOwner" @click="prepareThresholdPolicy">{{ t('studioPanels.setThresholdPolicy', 'Set threshold policy') }}</button>
            <p class="mt-2 text-xs text-sa-muted">{{ t('studioPanels.thresholdHint', 'Only threshold-member-eligible validators count. Deactivating a policy carries no members and frees its members for uninstall.') }}</p>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div class="card">
            <h3 class="text-sm font-bold text-sa-text mb-4">{{ t('studioPanels.recoveryPolicy', 'Recovery Policy') }}</h3>
            <label for="recovery-authority" class="block text-xs font-semibold text-sa-muted mb-1">{{ t('studioPanels.recoveryAuthority', 'Recovery authority') }}</label>
            <input id="recovery-authority" v-model="manageForm.recoveryPolicyAuthority" type="text" class="input-field font-mono text-sm py-2 px-3 bg-sa-dark" :placeholder="t('studioPanels.hashPlaceholder', '0x... (zero = custody self-rescue)')" />
            <label for="recovery-policy-days" class="block mt-3 text-xs font-semibold text-sa-muted mb-1">{{ t('studioPanels.recoveryPolicyDays', 'Timelock (days)') }}</label>
            <input id="recovery-policy-days" v-model.number="manageForm.recoveryPolicyTimelockDays" type="number" min="7" max="90" class="input-field w-24 text-xs py-1 px-2 bg-sa-dark" />
            <label v-if="!manageForm.ownerOnlyRecovery" class="mt-3 flex gap-2 text-xs"><input type="checkbox" v-model="manageForm.ownerOnlyAcknowledged" />{{ t('custom.ownerOnlyAcknowledgement', 'I understand this permanently limits the account to the custody witness; modules can never be restored.') }}</label>
            <button type="button" class="btn-primary mt-4" :disabled="managementBusy || !isCustodyOwner" @click="prepareRecoveryPolicy">{{ t('studioPanels.setRecoveryPolicy', 'Set recovery policy') }}</button>
            <p class="mt-2 text-xs text-sa-muted">{{ t('custom.recoveryPolicyHint', 'A new non-zero recovery authority must also witness the confirmation. The timelock must be 7 through 90 days.') }}</p>
          </div>

          <div class="card">
            <h3 class="text-sm font-bold text-sa-text mb-4">{{ t('studioPanels.recoveryLifecycle', 'Recovery & Freeze') }}</h3>
            <p v-if="manageForm.recoveryMatureAt" class="text-xs text-sa-muted">{{ t('custom.recoveryMatures', 'Recovery matures at') }}: {{ formatTime(Number(manageForm.recoveryMatureAt)) }}</p>
            <label for="new-custody" class="block mt-3 text-xs font-semibold text-sa-muted mb-1">{{ t('studioPanels.newCustody', 'New custody') }}</label>
            <input id="new-custody" v-model="manageForm.newCustody" type="text" class="input-field font-mono text-sm py-2 px-3 bg-sa-dark" :placeholder="t('studioPanels.hashPlaceholder', '0x...')" />
            <div class="mt-4 flex flex-wrap gap-3">
              <button type="button" class="btn-warning" :disabled="managementBusy || !isCustodyOwner" @click="beginRecovery">{{ t('studioPanels.beginRecovery', 'Begin recovery') }}</button>
              <button type="button" class="btn-secondary" :disabled="managementBusy || !isCustodyOwner" @click="cancelRecovery">{{ t('studioPanels.cancelRecovery', 'Cancel recovery') }}</button>
              <button type="button" class="btn-primary" :disabled="managementBusy || !isCustodyOwner" @click="executeRecovery">{{ t('studioPanels.executeRecovery', 'Execute recovery') }}</button>
              <button type="button" class="btn-secondary" :class="{ 'btn-loading': manageBusy.freeze }" :disabled="managementBusy || !isCustodyOwner" @click="freezeAccount">{{ manageForm.status === 'frozen' ? t('studioPanels.unfreeze', 'Unfreeze account') : t('studioPanels.freeze', 'Freeze account') }}</button>
            </div>
            <p class="mt-2 text-xs text-sa-muted">{{ t('custom.recoveryHintV4', 'Recovery replaces the custody witness after the timelock matures. Executing it clears module state without calling any module.') }}</p>
          </div>
        </div>

        <AccountMetadataCard
          v-model:metadata-uri="metadataForm.metadataUri"
          v-model:description="metadataForm.description"
          v-model:logo-url="metadataForm.logoUrl"
          :busy="metadataBusy.save"
          :disabled="managementBusy || !canManageTarget || !isCustodyOwner"
          @save="saveMetadata"
        />
      </template>
    </div>

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
import { inject, ref, watch, computed } from "vue";
import { useI18n } from "@/i18n";
import { analyzeSessionKeyScope } from "@/features/studio/sessionKeyScope";
import GovernanceEmptyState from "./ManageGovernancePanel/GovernanceEmptyState.vue";
import AccountMetadataCard from "./ManageGovernancePanel/AccountMetadataCard.vue";
import ConfirmDialog from "./ManageGovernancePanel/ConfirmDialog.vue";

const { t } = useI18n();
const formatTime = (value) => (Number.isSafeInteger(value) && value > 0 ? new Date(value).toISOString() : "—");
const isZeroHash = (value) => !value || /^0x0{40}$/i.test(value);

const confirmModal = ref(null);

const studio = inject("studio");
const {
  manageForm,
  manageBusy,
  manageSnapshot,
  metadataForm,
  metadataBusy,
  canManageTarget,
  managementBusy,
  configurationOutcome,
  configurationReview,
  isCustodyOwner,
  autoLoadedAccounts,
  loadAccountConfiguration,
  submitConfiguration,
  dismissConfigurationReview,
  confirmPendingIntent,
  cancelPendingIntent,
  prepareInstallModule,
  prepareConfigureModule,
  prepareUninstallModule,
  prepareHookOrder,
  prepareThresholdPolicy,
  prepareRecoveryPolicy,
  beginRecovery,
  cancelRecovery,
  executeRecovery,
  freezeAccount,
  revokeCredentials,
  saveMetadata,
  addRow,
  removeRow,
} = studio;

watch([manageForm, manageSnapshot], () => { confirmModal.value = null; }, { deep: true });

// A prepared review is exactly the point where the operator still can stop:
// nothing was signed yet, and the dialog is the last place the actions are read.
watch(configurationReview, (review) => {
  if (!review) return;
  const actions = review.actions.map((action) => ({
    code: action?.value?.[0]?.value ?? '?',
    target: action?.value?.[2]?.value || action?.value?.[1]?.value || '',
  }));
  confirmModal.value = {
    title: review.label || t('custom.confirmIntent', 'Propose configuration intent'),
    confirmLabel: t('custom.proposeIntent', 'Propose intent'),
    danger: false,
    message: `${t('custom.intentExplain', 'This proposes a configuration intent. It matures for 24 hours before it can be confirmed, and nothing changes on-chain yet.')}\nAccountId: ${review.accountId}\n${t('studioPanels.intentActions', 'Actions')}: ${actions.map((a) => `#${a.code} ${a.target}`).join(', ')}`,
    onConfirm: () => submitConfiguration(),
  };
  dismissConfigurationReview();
});

// A `setSessionKey` configure list is the only place a v4 session key is granted, so the warning
// belongs beside the data it analyses. The analyzer is shared with its unit tests; an unparseable
// list shows nothing here because the prepare step rejects it with a typed error instead.
const sessionKeyValueWarning = computed(() => {
  const text = String(manageForm.value.moduleConfigJson || "").trim();
  if (!text) return "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "";
  }
  const scope = analyzeSessionKeyScope(parsed);
  if (!scope.applies || !scope.uncapped) return "";
  if (!scope.nativeAsset) return t("studioPanels.sessionKeyUncappedWarning");
  return String(t("studioPanels.sessionKeyUncappedNativeWarning")).replaceAll("{asset}", scope.nativeAsset);
});

const recoveryTimelockText = computed(() => {
  const ms = Number(manageForm.value.recoveryTimelockMs || 0);
  if (!ms) return '—';
  return `${Math.round(ms / 86_400_000)} d`;
});

const pendingStatusText = computed(() => {
  const intent = manageForm.value.pendingIntent;
  if (!intent) return '—';
  const now = Number(manageSnapshot.value.chain?.time || 0) * 1000;
  const matureAt = Number(intent.matureAt || 0);
  const expiresAt = Number(intent.expiresAt || 0);
  if (expiresAt > 0 && expiresAt <= now) return t('custom.intentExpiredShort', 'expired');
  if (matureAt > now) return t('custom.intentMaturingShort', 'maturing');
  return t('custom.intentMature', 'mature');
});

function capabilityText(module) {
  const flags = [];
  if (module.instanceIsolation) flags.push('isolation');
  if (module.messageCapability) flags.push('message');
  if (module.thresholdMemberEligible) flags.push('threshold');
  return flags.length ? flags.join(', ') : '—';
}
</script>

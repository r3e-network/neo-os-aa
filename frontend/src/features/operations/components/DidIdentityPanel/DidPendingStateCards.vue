<template>
  <div
    v-if="
      verifierState &&
      (verifierState.pendingRecovery?.active ||
        verifierState.activeSession?.active)
    "
    class="grid gap-4 xl:grid-cols-2"
  >
    <div
      v-if="verifierState.pendingRecovery?.active"
      class="rounded-xl border border-sa-warning/30 bg-sa-warning/5 p-4"
    >
      <p class="text-xs uppercase text-sa-warning font-bold mb-2">
        {{ t("didPanel.pendingRecovery", "Pending Recovery") }}
      </p>
      <p class="text-sm text-sa-text break-all">
        {{ t("didPanel.newOwner", "new owner") }}:
        {{
          verifierState.pendingRecovery.newOwner ||
          t("didPanel.unset", "unset")
        }}
      </p>
      <p class="text-sm text-sa-text">
        {{ t("didPanel.approved", "approved") }}:
        {{ verifierState.pendingRecovery.approvedCount }} /
        {{ verifierState.threshold }}
      </p>
      <p class="text-sm text-sa-text">
        {{ t("didPanel.executableAt", "executable at") }}:
        {{ verifierState.pendingRecovery.executableAt }}
      </p>
      <div class="mt-4 flex gap-3">
        <button
          class="btn-primary flex-1"
          :aria-label="
            t('operations.ariaFinalizeRecovery', 'Finalize recovery')
          "
          :class="{ 'btn-loading': busy === 'finalizeRecovery' }"
          :disabled="busy === 'finalizeRecovery'"
          @click="$emit('finalize')"
        >
          {{
            busy === "finalizeRecovery"
              ? t("didPanel.finalizingRecovery", "Finalizing…")
              : t("didPanel.finalizeRecovery", "Finalize Recovery")
          }}
        </button>
        <button
          class="btn-secondary flex-1"
          :aria-label="
            t('operations.ariaCancelRecovery', 'Cancel recovery')
          "
          :class="{ 'btn-loading': busy === 'cancelRecovery' }"
          :disabled="busy === 'cancelRecovery'"
          @click="$emit('cancel')"
        >
          {{
            busy === "cancelRecovery"
              ? t("didPanel.cancellingRecovery", "Cancelling…")
              : t("didPanel.cancelRecovery", "Cancel Recovery")
          }}
        </button>
      </div>
    </div>
    <div
      v-if="verifierState.activeSession?.active"
      class="rounded-xl border border-sa-info/30 bg-sa-info/5 p-4"
    >
      <p class="text-xs uppercase text-sa-info font-bold mb-2">
        {{ t("didPanel.activePrivateSession", "Active Private Session") }}
      </p>
      <p class="text-sm text-sa-text break-all">
        {{ t("didPanel.executor", "executor") }}:
        {{
          verifierState.activeSession.executor ||
          t("didPanel.unset", "unset")
        }}
      </p>
      <p class="text-sm text-sa-text break-all">
        {{ t("didPanel.action", "action") }}:
        {{
          verifierState.activeSession.actionId ||
          t("didPanel.unset", "unset")
        }}
      </p>
      <p class="text-sm text-sa-text">
        {{ t("didPanel.expiresAt", "expires at") }}:
        {{ verifierState.activeSession.expiresAt }}
      </p>
      <button
        class="btn-secondary mt-4 w-full"
        :aria-label="t('operations.ariaRevokeSession', 'Revoke session')"
        :class="{ 'btn-loading': busy === 'revokeSession' }"
        :disabled="busy === 'revokeSession'"
        @click="$emit('revoke')"
      >
        {{
          busy === "revokeSession"
            ? t("didPanel.revokingSession", "Revoking…")
            : t("didPanel.revokeSession", "Revoke Session")
        }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

defineProps({
  verifierState: {
    type: Object,
    default: null,
  },
  busy: {
    type: String,
    default: "",
  },
});

defineEmits(["finalize", "cancel", "revoke"]);

const { t } = useI18n();
</script>

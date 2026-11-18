<template>
  <div
    v-if="verifierState"
    class="grid gap-4 md:grid-cols-2 xl:grid-cols-4"
  >
    <div class="rounded-xl border border-sa-border bg-sa-panel/40 p-4">
      <p class="text-xs uppercase text-sa-muted font-bold mb-1">
        {{ t("didPanel.boundVerifier", "Bound Verifier") }}
      </p>
      <p class="text-sm text-sa-text font-semibold break-all">
        {{ verifierState.verifierHash }}
      </p>
    </div>
    <div class="rounded-xl border border-sa-border bg-sa-panel/40 p-4">
      <p class="text-xs uppercase text-sa-muted font-bold mb-1">
        {{ t("didPanel.verifierOwner", "Verifier Owner") }}
      </p>
      <p class="text-sm text-sa-text font-semibold break-all">
        {{ verifierState.owner || t("didPanel.unset", "unset") }}
      </p>
    </div>
    <div class="rounded-xl border border-sa-border bg-sa-panel/40 p-4">
      <p class="text-xs uppercase text-sa-muted font-bold mb-1">
        {{ t("didPanel.recovery", "Recovery") }}
      </p>
      <p class="text-sm text-sa-text font-semibold">
        {{
          verifierState.pendingRecovery?.active
            ? `${t("didPanel.statusPending", "(pending)")
                .replace(/[()（）]/g, "")
                .trim()} ${verifierState.pendingRecovery.approvedCount}/${verifierState.threshold}`
            : `${t("didPanel.nonce", "nonce")} ${verifierState.recoveryNonce}`
        }}
      </p>
    </div>
    <div class="rounded-xl border border-sa-border bg-sa-panel/40 p-4">
      <p class="text-xs uppercase text-sa-muted font-bold mb-1">
        {{ t("didPanel.privateSession", "Private Session") }}
      </p>
      <p class="text-sm text-sa-text font-semibold">
        {{
          verifierState.activeSession?.active
            ? t("didPanel.statusActive", "(active)")
                .replace(/[()（）]/g, "")
                .trim()
            : `${t("didPanel.nonce", "nonce")} ${verifierState.sessionNonce}`
        }}
      </p>
    </div>
  </div>
  <div v-else class="empty-state rounded-xl bg-sa-panel/20 p-6">
    <svg
      aria-hidden="true"
      class="w-8 h-8 mx-auto mb-2 text-sa-muted"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.5"
        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
      ></path>
    </svg>
    <p class="text-sm text-sa-muted">
      {{
        t(
          "didPanel.noVerifierState",
          "No on-chain verifier state loaded yet.",
        )
      }}
    </p>
    <p class="text-xs text-sa-muted mt-1">
      {{
        t(
          "didPanel.refreshHint",
          'Click "Refresh Chain State" to query the latest data.',
        )
      }}
    </p>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

defineProps({
  verifierState: {
    type: Object,
    default: null,
  },
});

const { t } = useI18n();
</script>

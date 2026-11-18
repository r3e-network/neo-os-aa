<template>
  <StatusArt
    tone="success"
    :size="96"
    class="mx-auto mb-5 animate-fade-in"
    :title="t('sharedDraft.transactionSubmitted', 'Transaction Submitted')"
  />
  <h1 class="text-2xl font-bold text-sa-text mb-2 text-center">
    {{ t("sharedDraft.transactionSubmitted", "Transaction Submitted") }}
  </h1>
  <p class="text-sm text-sa-muted mb-8 max-w-lg mx-auto text-center">
    {{
      t(
        "sharedDraft.transactionSubmittedDesc",
        "Your transaction has been securely broadcast to the Neo N3 network.",
      )
    }}
  </p>
  <div class="glass-panel p-5 mb-8 inline-block w-full max-w-full">
    <div class="flex items-center justify-between mb-2">
      <p class="text-xs font-semibold text-sa-muted uppercase">
        {{ t("sharedDraft.transactionHash", "Transaction Hash") }}
      </p>
      <button
        @click="$emit('copy')"
        :aria-label="t('operations.copyTxHash', 'Copy transaction hash')"
        class="text-xs font-medium text-sa-text hover:text-sa-orange bg-sa-dark border border-sa-border px-3 py-2 sm:py-1 rounded transition-colors duration-200"
      >
        {{
          copiedKey === "txid"
            ? t("sharedDraft.copied", "Copied!")
            : t("sharedDraft.copy", "Copy")
        }}
      </button>
    </div>
    <code
      class="block text-sm font-mono text-sa-text break-all bg-sa-dark border border-sa-border p-3 rounded-md select-all"
      >{{ txid }}</code
    >
  </div>
  <div class="flex flex-col sm:flex-row justify-center gap-3">
    <RouterLink to="/" class="btn-secondary w-full sm:w-auto">{{
      t("sharedDraft.returnHome", "Return Home")
    }}</RouterLink>
    <a
      :href="explorerUrl || '#'"
      target="_blank"
      rel="noopener noreferrer"
      class="btn-primary w-full sm:w-auto"
      >{{ t("sharedDraft.viewInExplorer", "View in Explorer") }}</a
    >
  </div>
</template>

<script setup>
import { RouterLink } from "vue-router";
import { useI18n } from "@/i18n";
import { StatusArt } from "@/components/illustrations";

const { t } = useI18n();

defineProps({
  txid: { type: String, default: "" },
  explorerUrl: { type: String, default: "" },
  copiedKey: { type: String, default: "" },
});

defineEmits(["copy"]);
</script>

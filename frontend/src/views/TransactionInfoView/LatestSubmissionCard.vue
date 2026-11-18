<template>
  <div
    v-if="txid"
    class="mt-4 rounded-lg border border-sa-border bg-sa-dark p-4"
  >
    <p class="text-xs font-semibold uppercase text-sa-muted">
      {{ t("sharedDraft.latestSubmission", "Latest Submission") }}
    </p>
    <div class="flex items-start gap-2">
      <code class="mt-1 block break-all text-xs text-sa-text flex-1">{{
        txid
      }}</code>
      <button
        @click="$emit('copy')"
        :aria-label="t('operations.copyTxid', 'Copy transaction ID')"
        class="shrink-0 mt-1 text-sa-muted hover:text-sa-text transition-colors duration-200"
      >
        <svg
          aria-hidden="true"
          v-if="copiedKey !== 'latestTxid'"
          xmlns="http://www.w3.org/2000/svg"
          class="h-3.5 w-3.5"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
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
    <a
      v-if="explorerUrl"
      :href="explorerUrl"
      target="_blank"
      rel="noopener noreferrer"
      class="mt-2 inline-flex rounded-md border border-sa-border bg-sa-panel px-3 py-1.5 text-xs font-medium text-sa-text hover:bg-sa-dark transition-colors duration-200"
      >{{ t("sharedDraft.viewLatestInExplorer", "View Latest in Explorer") }}</a
    >
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

const { t } = useI18n();

defineProps({
  txid: { type: String, default: "" },
  explorerUrl: { type: String, default: "" },
  copiedKey: { type: String, default: "" },
});

defineEmits(["copy"]);
</script>

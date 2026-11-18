<template>
  <div
    class="mt-5 rounded-lg border border-sa-border bg-gradient-to-br from-sa-dark to-sa-panel px-4 py-3.5 shadow-sm"
  >
    <div class="flex items-start gap-3">
      <svg
        aria-hidden="true"
        class="w-5 h-5 text-sa-muted flex-shrink-0 mt-0.5"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
        ></path>
      </svg>
      <div class="flex-1 min-w-0">
        <p class="text-xs font-semibold text-sa-muted uppercase mb-1">
          {{ t("operations.presetSummaryLabel", "Operation Summary") }}
        </p>
        <p class="text-sm font-medium text-sa-text">{{ summaryTitle }}</p>
        <p class="text-sm text-sa-muted mt-0.5">{{ summaryDetail }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

defineProps({
  summaryTitle: { type: String, default: "" },
  summaryDetail: { type: String, default: "" },
});

const { t } = useI18n();
</script>

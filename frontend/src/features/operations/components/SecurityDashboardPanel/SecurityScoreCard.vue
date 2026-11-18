<template>
  <div
    class="mb-6 rounded-lg border border-sa-border bg-gradient-to-br from-sa-panel/80 to-sa-dark/60 p-5"
  >
    <div class="flex items-start justify-between gap-4">
      <div class="flex-1">
        <p class="text-xs font-bold uppercase text-sa-muted mb-2">
          {{ t("security.overallScore", "Overall Security Score") }}
        </p>
        <div class="flex items-center gap-4">
          <div class="relative w-20 h-20">
            <svg class="w-20 h-20 transform -rotate-90" viewBox="0 0 36 36">
              <circle
                cx="18"
                cy="18"
                r="15.5"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                class="text-sa-border"
              />
              <circle
                cx="18"
                cy="18"
                r="15.5"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                :stroke-dasharray="`${securityScorePercentage} 100`"
                :class="overallSecurityLevel.circleClass"
              />
            </svg>
            <span
              class="absolute inset-0 flex items-center justify-center text-lg font-bold"
              :class="overallSecurityLevel.scoreTextClass"
            >
              {{ securityScore }}/3
            </span>
          </div>
          <div class="flex-1">
            <p class="text-sm font-semibold text-sa-text">
              {{ overallSecurityLevel.description }}
            </p>
            <p class="mt-1 text-xs text-sa-muted">
              {{ overallSecurityLevel.hint }}
            </p>
          </div>
        </div>
      </div>
      <router-link
        :to="{ path: '/docs', query: { doc: 'securityGuide' } }"
        class="btn-secondary btn-xs whitespace-nowrap"
      >
        {{ t("security.viewSecurityGuide", "View Guide") }}
      </router-link>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

defineProps({
  securityScore: { type: Number, default: 0 },
  securityScorePercentage: { type: Number, default: 0 },
  overallSecurityLevel: { type: Object, default: () => ({}) },
});

const { t } = useI18n();
</script>

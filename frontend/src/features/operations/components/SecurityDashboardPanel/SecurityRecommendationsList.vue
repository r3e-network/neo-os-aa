<template>
  <div
    v-if="recommendations.length > 0"
    class="mt-6 rounded-lg border border-sa-border bg-sa-panel/60 p-5"
  >
    <div class="flex items-center gap-2 mb-3">
      <svg
        aria-hidden="true"
        class="w-5 h-5 text-sa-info-light"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        ></path>
      </svg>
      <p class="text-xs font-bold uppercase text-sa-muted">
        {{ t("security.recommendations", "Recommendations") }}
      </p>
    </div>
    <div class="space-y-2">
      <div
        v-for="rec in recommendations"
        :key="rec.id"
        class="flex items-start gap-3 rounded-lg bg-sa-dark/30 px-4 py-3"
      >
        <span class="mt-0.5" :class="rec.iconClass">
          <svg
            v-if="rec.type === 'warning'"
            aria-hidden="true"
            class="w-4 h-4 text-sa-warning"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            ></path>
          </svg>
          <svg
            v-else-if="rec.type === 'info'"
            aria-hidden="true"
            class="w-4 h-4 text-sa-info-light"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            ></path>
          </svg>
          <svg
            v-else
            aria-hidden="true"
            class="w-4 h-4 text-sa-success"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            ></path>
          </svg>
        </span>
        <div class="flex-1">
          <p class="text-sm font-medium text-sa-text">{{ rec.title }}</p>
          <p class="text-xs text-sa-muted mt-0.5">{{ rec.description }}</p>
        </div>
        <router-link
          v-if="rec.docLink"
          :to="{ path: '/docs', query: { doc: rec.docLink } }"
          class="btn-ghost btn-xs shrink-0"
        >
          {{ t("security.learnMore", "Learn More") }}
        </router-link>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

defineProps({
  recommendations: { type: Array, default: () => [] },
});

const { t } = useI18n();
</script>

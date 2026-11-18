<template>
  <div
    v-if="sessionKeys.length > 0"
    class="rounded-lg border border-sa-border bg-sa-panel/60 p-5"
  >
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2">
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
            d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
          ></path>
        </svg>
        <p class="text-xs font-bold uppercase text-sa-muted">
          {{ t("security.sessionKeys", "Session Keys") }}
        </p>
      </div>
      <span class="text-xs text-sa-muted"
        >{{ sessionKeys.length }} {{ t("security.active", "active") }}</span
      >
    </div>
    <div class="space-y-2">
      <div
        v-for="key in sessionKeys"
        :key="key.id"
        class="flex items-center gap-3 rounded-lg bg-sa-dark/40 px-3 py-2.5"
      >
        <div
          class="w-8 h-8 rounded-full bg-sa-panel/50 flex items-center justify-center"
        >
          <svg
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
              d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
            ></path>
          </svg>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-sa-text truncate">
            {{ key.label }}
          </p>
          <p class="text-xs text-sa-muted">{{ key.target }}</p>
        </div>
        <div class="text-right shrink-0">
          <p class="text-xs font-mono text-sa-muted">{{ key.expiresAt }}</p>
          <button
            v-if="key.canRevoke"
            class="mt-0.5 text-xs text-sa-error hover:text-sa-error-light transition-colors duration-200"
            @click="$emit('revoke-session-key', key.id)"
          >
            {{ t("security.revoke", "Revoke") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

defineProps({
  sessionKeys: { type: Array, default: () => [] },
});

defineEmits(["revoke-session-key"]);

const { t } = useI18n();
</script>

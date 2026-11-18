<template>
  <div
    v-if="activePolicies.length > 0"
    class="mb-6 rounded-lg border border-sa-border bg-sa-panel/60 p-5"
  >
    <p class="text-xs font-bold uppercase text-sa-muted mb-3">
      {{ t("security.activePolicies", "Active Policies") }}
    </p>
    <div class="space-y-3">
      <div
        v-for="policy in activePolicies"
        :key="policy.id"
        class="flex items-start gap-3 rounded-lg bg-sa-dark/40 p-3"
      >
        <span class="badge shrink-0" :class="policy.badgeClass">
          {{ policy.badgeText }}
        </span>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-sa-text truncate">
            {{ policy.title }}
          </p>
          <p class="text-xs text-sa-muted mt-0.5">
            {{ policy.description }}
          </p>
        </div>
        <span class="text-xs font-mono text-sa-muted shrink-0">{{
          policy.value || ""
        }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

defineProps({
  activePolicies: { type: Array, default: () => [] },
});

const { t } = useI18n();
</script>

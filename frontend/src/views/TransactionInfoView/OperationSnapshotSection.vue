<template>
  <section class="glass-panel p-5">
    <div class="mb-4">
      <h2 class="text-base font-bold font-outfit text-sa-text">
        {{ t("sharedDraft.operationSnapshot", "Operation Snapshot") }}
      </h2>
      <p class="text-sm text-sa-muted">
        {{
          t(
            "sharedDraft.operationSnapshotDesc",
            "Key execution details, relay state, and payload availability for this immutable draft.",
          )
        }}
      </p>
    </div>
    <div class="grid gap-3 sm:grid-cols-2">
      <div
        v-for="item in items"
        :key="item.label"
        class="rounded-lg border border-sa-border/40 bg-sa-dark/40 p-4"
      >
        <p class="text-xs font-semibold uppercase text-sa-muted">
          {{ item.label }}
        </p>
        <div class="mt-1 text-sm font-medium text-sa-text break-all">
          {{ item.value }}
        </div>
        <p v-if="item.note" class="mt-1 text-xs text-sa-muted">
          {{ item.note }}
        </p>
      </div>
    </div>
  </section>
</template>

<script setup>
import { useI18n } from "@/i18n";

const { t } = useI18n();

defineProps({
  items: { type: Array, default: () => [] },
});
</script>

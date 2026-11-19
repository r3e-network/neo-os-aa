<template>
  <div
    v-if="items.length > 0"
    class="rounded-xl border border-sa-warning/30 bg-sa-warning/5 p-4 space-y-3"
  >
    <p class="text-xs uppercase text-sa-warning font-bold">
      {{ t("didPanel.pendingConfiguration", "Pending Configuration Intents") }}
    </p>
    <div
      v-for="item in items"
      :key="item.id"
      class="rounded-lg border border-sa-warning/20 bg-sa-panel/40 p-4"
    >
      <div class="flex items-center justify-between gap-3">
        <p class="text-sm font-semibold text-sa-text">{{ item.title }}</p>
        <span class="text-xs font-medium text-sa-warning">{{
          t("didPanel.statusPending", "(pending)")
            .replace(/[()（）]/g, "")
            .trim()
        }}</span>
      </div>
      <p class="mt-1 text-xs text-sa-muted">{{ item.description }}</p>
      <div class="mt-3 grid gap-3 md:grid-cols-3">
        <div>
          <p class="text-[10px] uppercase text-sa-muted font-bold">
            {{ t("didPanel.maturesAt", "matures at") }}
          </p>
          <p class="mt-1 text-sm text-sa-text break-all">
            {{ item.matureAt }}
          </p>
        </div>
        <div>
          <p class="text-[10px] uppercase text-sa-muted font-bold">
            {{ t("didPanel.expiresAt", "expires at") }}
          </p>
          <p class="mt-1 text-sm text-sa-text break-all">
            {{ item.expiresAt }}
          </p>
        </div>
        <div>
          <p class="text-[10px] uppercase text-sa-muted font-bold">
            {{ t("didPanel.actionDigest", "Action Digest") }}
          </p>
          <p class="mt-1 text-sm text-sa-text break-all">
            {{ item.actionDigest || t("didPanel.unset", "unset") }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

defineProps({
  items: {
    type: Array,
    default: () => [],
  },
});

const { t } = useI18n();
</script>

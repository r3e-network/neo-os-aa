<template>
  <section class="glass-panel p-5">
    <h2 class="text-base font-bold font-outfit text-sa-text mb-3">
      {{ t("sharedDraft.collectedSignaturesTitle", "Collected Signatures") }}
    </h2>
    <div v-if="signatures.length === 0" class="text-sm text-sa-muted">
      {{
        t(
          "sharedDraft.noSignaturesYet",
          "No signatures have been attached yet.",
        )
      }}
    </div>
    <div v-else class="grid gap-3 sm:grid-cols-2">
      <div
        v-for="signature in signatures"
        :key="signature.key"
        class="rounded-lg border border-sa-border/40 bg-sa-dark/40 p-4"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm font-semibold text-sa-text break-all">
              {{ signature.label }}
            </div>
            <div class="mt-1 text-xs text-sa-muted">
              {{ t("sharedDraft.addedPrefix", "Added") }}
              {{ signature.createdLabel }}
            </div>
          </div>
          <div class="flex flex-wrap justify-end gap-1">
            <span
              v-for="badge in signature.badges"
              :key="badge"
              class="rounded border border-sa-border bg-sa-panel px-2 py-0.5 text-xs font-medium text-sa-muted"
              >{{ badge }}</span
            >
          </div>
        </div>
        <code
          class="mt-3 block break-all rounded-md border border-sa-border bg-sa-panel px-3 py-1.5 text-xs text-sa-muted"
          >{{ signature.signaturePreview }}</code
        >
        <details class="mt-3">
          <summary
            class="cursor-pointer text-xs font-medium text-sa-muted hover:text-sa-text transition-colors duration-200"
          >
            {{ t("sharedDraft.viewFullSignature", "View Full Signature") }}
          </summary>
          <code
            class="mt-2 block break-all text-xs text-sa-muted bg-sa-panel border border-sa-border p-2 rounded-md"
            >{{ signature.signatureHex }}</code
          >
        </details>
      </div>
    </div>
  </section>
</template>

<script setup>
import { useI18n } from "@/i18n";

const { t } = useI18n();

defineProps({
  signatures: { type: Array, default: () => [] },
});
</script>

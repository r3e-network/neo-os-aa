<template>
  <section
    class="glass-panel p-6"
    role="status"
    aria-live="polite"
    :class="toneClass"
  >
    <div
      class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <p class="text-xs font-bold uppercase" :class="titleToneClass">
          {{ title }}
        </p>
        <div class="mt-1 text-sm font-semibold text-sa-text">{{ label }}</div>
        <div class="text-sm text-sa-muted">{{ detail }}</div>
      </div>
      <div class="text-[11px] font-medium text-sa-muted">
        {{ timestamp || t("operations.justNow", "Just now") }}
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed } from "vue";
import { buildDraftStatusBanner } from "@/features/operations/draftStatusBanner.js";
import { useI18n } from "@/i18n";

const { t } = useI18n();

const props = defineProps({
  status: { type: String, default: "draft" },
  activity: { type: Array, default: () => [] },
});

const DEFAULT_DRAFT_STATUS_TITLE = computed(() =>
  t("operations.latestDraftState", "Latest Draft State"),
);

const banner = computed(() =>
  buildDraftStatusBanner({
    status: props.status,
    activity: props.activity,
    t,
  }),
);

const title = computed(
  () => banner.value.title || DEFAULT_DRAFT_STATUS_TITLE.value,
);
const label = computed(() => banner.value.label);
const detail = computed(() => banner.value.detail);
const timestamp = computed(() => banner.value.timestamp);

const toneClass = computed(() => {
  if (banner.value.tone === "relay")
    return "border-sa-orange/30 bg-sa-orange/10";
  if (banner.value.tone === "client")
    return "border-sa-lightOrange/30 bg-sa-lightOrange/10";
  if (banner.value.tone === "identity")
    return "border-sa-info/30 bg-sa-info/10";
  return "border-sa-warning/30 bg-sa-warning/10";
});

const titleToneClass = computed(() => {
  if (banner.value.tone === "relay") return "text-sa-orange";
  if (banner.value.tone === "client") return "text-sa-lightOrange";
  if (banner.value.tone === "identity") return "text-sa-info";
  return "text-sa-warning";
});
</script>

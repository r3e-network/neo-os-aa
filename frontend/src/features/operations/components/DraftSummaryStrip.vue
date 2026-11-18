<template>
  <section class="glass-panel p-6 shadow-glow-blue">
    <div class="mb-4 flex items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-bold text-sa-text">{{ displayTitle }}</h2>
        <p class="text-xs text-sa-muted mt-1">
          {{
            t(
              "operations.draftOverviewSubtitle",
              "Overview of staged operation and current status",
            )
          }}
        </p>
      </div>
    </div>
    <div
      v-if="summaryItems.length === 0"
      class="flex flex-col items-center justify-center py-10 text-center"
    >
      <svg
        aria-hidden="true"
        class="w-10 h-10 text-sa-muted/40 mb-3"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.5"
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
      <p class="text-sm font-semibold text-sa-muted">
        {{ t("operations.noDraftItems", "No draft items yet") }}
      </p>
      <p class="text-xs text-sa-muted/60 mt-1">
        {{
          t(
            "operations.noDraftItemsHint",
            "Stage an operation to see its summary here",
          )
        }}
      </p>
    </div>
    <div v-else class="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <div
        v-for="item in summaryItems"
        :key="item.label"
        class="rounded-lg border border-sa-border bg-sa-dark/40 p-4 shadow-inner hover:bg-sa-dark/60 transition-colors duration-200"
      >
        <div class="mb-2 flex items-start justify-between gap-2">
          <p class="text-[10px] font-bold uppercase text-sa-orange">
            {{ item.label }}
          </p>
          <button
            v-if="summaryActions[item.label]"
            class="btn-ghost btn-xs whitespace-nowrap"
            :aria-label="feedbackLabel(summaryActions[item.label], item.label)"
            @click="emitSummaryAction(item, summaryActions[item.label])"
          >
            <span class="flex items-center gap-1">
              <svg
                aria-hidden="true"
                v-if="summaryActions[item.label].id === 'open-url'"
                class="w-3 h-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                ></path>
              </svg>
              <svg
                aria-hidden="true"
                v-else
                class="w-3 h-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                ></path>
              </svg>
              {{ feedbackLabel(summaryActions[item.label], item.label) }}
            </span>
          </button>
        </div>
        <div class="text-sm font-semibold text-sa-text break-all leading-tight">
          {{ item.value }}
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed } from "vue";
import {
  buildDraftSummaryActions,
  buildDraftSummaryItems,
} from "@/features/operations/draftSummary.js";
import { useClipboard } from "@/composables/useClipboard";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const { copiedKey: copiedActionKey, markCopied } = useClipboard();

const props = defineProps({
  title: { type: String, default: "" },
  draft: { type: Object, default: () => ({}) },
  actionContext: { type: Object, default: () => ({}) },
});

const emit = defineEmits(["summary-action"]);

const displayTitle = computed(() =>
  !props.title ? t("operations.draftOverview", "Draft Overview") : props.title,
);

const summaryItems = computed(() =>
  buildDraftSummaryItems({ draft: props.draft || {}, t }),
);
const summaryActions = computed(() =>
  buildDraftSummaryActions({
    draft: props.draft || {},
    shareUrl: props.actionContext?.shareUrl || "",
    collaboratorUrl: props.actionContext?.collaboratorUrl || "",
    operatorUrl: props.actionContext?.operatorUrl || "",
    explorerBaseUrl: props.actionContext?.explorerBaseUrl || "",
    t,
  }),
);

function feedbackLabel(action, key) {
  if (copiedActionKey.value !== key) return action.label;
  if (action.id === "open-url") return t("operations.opened", "Opened!");
  return t("operations.copied", "Copied!");
}

function emitSummaryAction(item, action) {
  markCopied(item.label);
  emit("summary-action", { item, action });
}
</script>

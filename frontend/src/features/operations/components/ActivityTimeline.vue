<template>
  <div>
    <div class="mb-4 flex flex-wrap gap-2">
      <button
        v-for="filter in filters"
        :key="filter.id"
        :aria-label="filter.label"
        class="rounded-full border px-4 py-1.5 text-xs font-semibold transition-all duration-200"
        :class="
          filter.id === activeFilter
            ? 'border-sa-orange/50 bg-sa-orange/20 text-sa-orange shadow-sm'
            : 'border-sa-border bg-sa-panel/40 text-sa-muted hover:bg-sa-panel hover:text-sa-text'
        "
        :aria-pressed="filter.id === activeFilter"
        @click="activeFilter = filter.id"
      >
        <span>{{ filter.label }}</span>
        <span
          class="ml-2 rounded-full px-2 py-0.5 text-[11px]"
          :class="
            filter.id === activeFilter
              ? 'bg-sa-orange/30 text-sa-orange'
              : 'bg-sa-dark text-sa-text'
          "
          >{{ filterCounts[filter.id] ?? 0 }}</span
        >
      </button>
    </div>

    <div v-if="groupedItems.length === 0" class="empty-state">
      <div
        class="mx-auto w-12 h-12 rounded-full bg-sa-dark/30 flex items-center justify-center mb-3"
      >
        <svg
          class="w-6 h-6 text-sa-muted"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.5"
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          ></path>
        </svg>
      </div>
      <p class="text-sm text-sa-muted font-medium mb-1">
        {{ emptyStateMessage }}
      </p>
      <p class="text-xs text-sa-muted">
        {{
          t(
            "operations.activityEmptyHint",
            "Activity will appear here as you work with the workspace",
          )
        }}
      </p>
    </div>
    <div v-else class="space-y-4">
      <section v-for="group in groupedItems" :key="group.date">
        <p class="mb-3 text-xs font-bold uppercase text-sa-muted">
          {{ formatActivityDateLabel(group.date, { t }) }}
        </p>
        <ul class="space-y-3">
          <li
            class="rounded-lg border border-sa-border bg-sa-panel/40 px-4 py-3 hover:bg-sa-panel/60 transition-colors duration-200"
          >
            <div
              v-for="item in group.items"
              :key="item.id"
              class="py-2 first:pt-0 last:pb-0"
            >
              <div class="flex items-center justify-between gap-3 mb-2">
                <div class="flex items-center gap-3">
                  <!-- Compatibility anchor: buildActivityPresentation(item).icon -->
                  <span
                    class="inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold flex-shrink-0"
                    :class="toneClass(presentItem(item).tone)"
                    :aria-label="presentItem(item).label"
                    v-html="presentItem(item).icon"
                  ></span>
                  <div>
                    <div class="text-xs font-bold uppercase text-sa-muted">
                      {{ presentItem(item).label }}
                    </div>
                    <div class="text-sm text-sa-text mt-0.5 leading-relaxed">
                      {{ item.detail }}
                    </div>
                  </div>
                </div>
                <div class="text-xs text-sa-muted font-mono whitespace-nowrap">
                  {{ formatActivityTimeLabel(item.createdAt, { now, t }) }}
                </div>
              </div>
              <div
                v-if="itemActions(item).length > 0"
                class="mt-3 flex flex-wrap gap-2"
              >
                <button
                  v-for="action in itemActions(item)"
                  :key="`${item.id}:${action.id}`"
                  :aria-label="action.label"
                  class="btn-ghost btn-xs min-h-[32px]"
                  @click="emitActivityAction(item, action)"
                >
                  <span class="flex items-center gap-1.5">
                    <svg
                      v-if="action.id === 'open-url'"
                      aria-hidden="true"
                      class="w-3.5 h-3.5"
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
                      v-else-if="action.id === 'jump-relay'"
                      aria-hidden="true"
                      class="w-3.5 h-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M13 10V3L4 14h7v7l9-11h-7z"
                      ></path>
                    </svg>
                    <svg
                      v-else
                      aria-hidden="true"
                      class="w-3.5 h-3.5"
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
                    {{ feedbackLabel(action, `${item.id}:${action.id}`) }}
                  </span>
                </button>
              </div>
            </div>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  buildActivityActions,
  buildActivityEmptyState,
  buildActivityFilterCounts,
  buildActivityFilters,
  buildActivityGroups,
  buildActivityPresentation,
  filterActivityEntries,
  formatActivityDateLabel,
  formatActivityTimeLabel,
} from "@/features/operations/activityTimeline.js";
import { createOperationsPreferences } from "@/features/operations/preferences.js";
import { useClipboard } from "@/composables/useClipboard";
import { useI18n } from "@/i18n";

const { t } = useI18n();

const props = defineProps({
  items: { type: Array, default: () => [] },
  actionContext: { type: Object, default: () => ({}) },
  preferenceKey: { type: String, default: "" },
});

const emit = defineEmits(["activity-action"]);

const preferences = createOperationsPreferences();
const activeFilter = ref(
  props.preferenceKey
    ? preferences.getActivityFilter(props.preferenceKey)
    : "all",
);
const filters = buildActivityFilters(t);
const filterCounts = computed(() => buildActivityFilterCounts(props.items));
const groupedItems = computed(() =>
  buildActivityGroups(filterActivityEntries(props.items, activeFilter.value)),
);
const emptyStateMessage = computed(() =>
  buildActivityEmptyState(activeFilter.value, t),
);
const { copiedKey, markCopied } = useClipboard();
const now = ref(new Date());
let nowTimer = setInterval(() => {
  now.value = new Date();
}, 30000);

watch(activeFilter, (value) => {
  if (!props.preferenceKey) return;
  preferences.setActivityFilter(props.preferenceKey, value);
});

function feedbackLabel(action, key) {
  if (copiedKey.value !== key) return action.label;
  if (action.id === "open-url") return t("operations.opened", "Opened!");
  if (action.id === "jump-relay") return t("operations.jumped", "Jumped!");
  return t("operations.copied", "Copied!");
}

function presentItem(item) {
  return buildActivityPresentation(item, { t });
}

function itemActions(item) {
  return buildActivityActions(item, { ...props.actionContext, t });
}

function emitActivityAction(item, action) {
  const key = `${item.id}:${action.id}`;
  markCopied(key);
  emit("activity-action", { event: item, action });
}

function toneClass(tone) {
  if (tone === "identity")
    return "bg-sa-info/10 text-sa-info border border-sa-info/30";
  if (tone === "signature")
    return "bg-sa-lightOrange/10 text-sa-lightOrange border border-sa-lightOrange/30";
  if (tone === "relay")
    return "bg-sa-orange/10 text-sa-orange border border-sa-orange/30";
  if (tone === "broadcast")
    return "bg-sa-error/10 text-sa-error border border-sa-error/30";
  return "bg-sa-panel text-sa-muted border border-sa-border";
}

onBeforeUnmount(() => {
  clearInterval(nowTimer);
});
</script>

<template>
  <aside
    :aria-label="t('operations.draftActivity', 'Draft activity')"
    class="glass-panel p-6 shadow-glow-blue"
  >
    <div class="mb-5 flex items-center justify-between">
      <h2 class="text-lg font-bold text-sa-text flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-sa-orange animate-pulse"></span>
        {{ t("operations.activitySidebarTitle", "Draft Activity") }}
      </h2>
      <span :class="shareStatus === 'draft' ? 'badge-amber' : 'badge-orange'">
        {{ shareStatus || t("operations.statusLocal", "local") }}
      </span>
    </div>

    <div class="space-y-3 text-sm">
      <details
        class="group rounded-lg border border-sa-border bg-sa-dark/30"
        open
      >
        <summary
          class="flex items-center gap-3 px-4 py-3 cursor-pointer list-none font-semibold text-sa-text hover:text-sa-text transition-colors duration-200"
        >
          <svg
            aria-hidden="true"
            class="w-4 h-4 text-sa-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
            ></path>
          </svg>
          {{ t("operations.shareLinksTitle", "Share Links") }}
          <svg
            aria-hidden="true"
            class="w-4 h-4 ml-auto text-sa-muted group-open:rotate-180 transition-transform duration-200"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M19 9l-7 7-7-7"
            ></path>
          </svg>
        </summary>
        <div class="px-4 pb-4 space-y-3">
          <div class="rounded bg-sa-panel/50 p-3">
            <p class="text-xs font-medium text-sa-muted mb-1">
              {{ t("operations.draftIdLabel", "Draft ID") }}
            </p>
            <p class="font-mono text-xs text-sa-text truncate" :title="draftId">
              {{
                draftId || t("operations.notPersistedYet", "Not persisted yet")
              }}
            </p>
          </div>
          <div class="rounded bg-sa-panel/50 p-3">
            <p class="text-xs font-medium text-sa-muted mb-1">
              {{ t("operations.shareUrlReadOnly", "Share URL (read-only)") }}
            </p>
            <p
              class="font-mono text-xs text-sa-text truncate"
              :title="shareUrl"
            >
              {{
                shareUrl ||
                sharePath ||
                t("operations.notGeneratedYet", "Not generated yet")
              }}
            </p>
          </div>
          <div class="rounded bg-sa-panel/50 p-3">
            <p class="text-xs font-medium text-sa-muted mb-1">
              {{
                t("operations.collaboratorUrlSign", "Collaborator URL (sign)")
              }}
            </p>
            <p
              class="font-mono text-xs text-sa-text truncate"
              :title="collaborationUrl"
            >
              {{
                collaborationUrl ||
                t(
                  "operations.useShareUrlForViewers",
                  "Use Share URL for viewers",
                )
              }}
            </p>
          </div>
          <div class="rounded bg-sa-panel/50 p-3">
            <p class="text-xs font-medium text-sa-muted mb-1">
              {{ t("operations.operatorUrlOperate", "Operator URL (operate)") }}
            </p>
            <p
              class="font-mono text-xs text-sa-text truncate"
              :title="operatorUrl"
            >
              {{
                operatorUrl ||
                t("operations.hiddenForReadOnly", "Hidden for read-only")
              }}
            </p>
          </div>
        </div>
      </details>

      <details
        class="group rounded-lg border border-sa-border bg-sa-dark/30"
        open
      >
        <summary
          class="flex items-center gap-3 px-4 py-3 cursor-pointer list-none font-semibold text-sa-text hover:text-sa-text transition-colors duration-200"
        >
          <svg
            aria-hidden="true"
            class="w-4 h-4 text-sa-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
            ></path>
          </svg>
          {{ t("operations.statusTitle", "Status") }}
          <span class="sr-only">{{
            t("operations.relayReadiness", "Relay Readiness")
          }}</span>
          <svg
            aria-hidden="true"
            class="w-4 h-4 ml-auto text-sa-muted group-open:rotate-180 transition-transform duration-200"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M19 9l-7 7-7-7"
            ></path>
          </svg>
        </summary>
        <div class="px-4 pb-4 space-y-3">
          <div class="flex justify-between items-center">
            <span class="text-xs text-sa-muted">{{
              t("operations.accessMode", "Access Mode")
            }}</span>
            <span
              class="text-xs font-semibold text-sa-text bg-sa-dark px-2 py-0.5 rounded"
              >{{ accessModeLabel }}</span
            >
          </div>
          <div class="flex justify-between items-center">
            <span class="text-xs text-sa-muted">{{
              t("operations.broadcast", "Broadcast")
            }}</span>
            <span class="text-xs font-semibold text-sa-text">{{
              broadcastMode
            }}</span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-xs text-sa-muted">{{
              t("operations.signatures", "Signatures")
            }}</span>
            <span class="text-xs font-semibold"
              ><span class="text-sa-orange">{{ signatureCount }}</span> /
              {{ requiredSignerCount }}</span
            >
          </div>
          <div class="flex justify-between items-center">
            <span class="text-xs text-sa-muted">{{
              t("operations.pending", "Pending")
            }}</span>
            <span class="text-xs font-semibold text-sa-text">{{
              pendingSignerCount
            }}</span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-xs text-sa-muted">{{
              t("operations.relay", "Relay")
            }}</span>
            <span class="text-xs font-semibold" :class="relayLevelClass">{{
              relayReadinessLabel ||
              t("sharedDraft.relayBlocked", "Relay Blocked")
            }}</span>
          </div>
        </div>
      </details>

      <details
        class="group rounded-lg border border-sa-border bg-sa-dark/30"
        open
      >
        <summary
          class="flex items-center gap-3 px-4 py-3 cursor-pointer list-none font-semibold text-sa-text hover:text-sa-text transition-colors duration-200"
        >
          <svg
            aria-hidden="true"
            class="w-4 h-4 text-sa-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            ></path>
          </svg>
          {{ t("operations.recentActivity", "Recent Activity") }}
          <svg
            aria-hidden="true"
            class="w-4 h-4 ml-auto text-sa-muted group-open:rotate-180 transition-transform duration-200"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M19 9l-7 7-7-7"
            ></path>
          </svg>
        </summary>
        <div class="px-4 pb-4">
          <ActivityTimeline
            :items="activityItems"
            :action-context="actionContext"
            :preference-key="timelinePreferenceKey"
            @activity-action="$emit('activity-action', $event)"
          />
        </div>
      </details>
    </div>
  </aside>
</template>

<script setup>
import { computed } from "vue";
import ActivityTimeline from "@/features/operations/components/ActivityTimeline.vue";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const props = defineProps({
  draftId: { type: String, default: "" },
  sharePath: { type: String, default: "" },
  shareUrl: { type: String, default: "" },
  collaborationUrl: { type: String, default: "" },
  operatorUrl: { type: String, default: "" },
  canWrite: { type: Boolean, default: false },
  canOperate: { type: Boolean, default: false },
  accessScope: { type: String, default: "read" },
  shareStatus: { type: String, default: "draft" },
  broadcastMode: { type: String, default: "client" },
  signatureCount: { type: Number, default: 0 },
  requiredSignerCount: { type: Number, default: 0 },
  pendingSignerCount: { type: Number, default: 0 },
  relayReadinessLabel: { type: String, default: "" },
  relayReadinessLevel: { type: String, default: "blocked" },
  activityItems: { type: Array, default: () => [] },
  actionContext: { type: Object, default: () => ({}) },
  timelinePreferenceKey: { type: String, default: "" },
});
defineEmits(["activity-action"]);
const accessModeLabel = computed(() => {
  if (props.canOperate || props.accessScope === "operate")
    return t("operations.operatorLabel", "Operator");
  if (props.canWrite || props.accessScope === "sign")
    return t("operations.collaboratorLabel", "Collaborator");
  return t("operations.readOnlyLabel", "Read-only");
});
const relayLevelClass = computed(() => {
  if (props.relayReadinessLevel === "ready") return "text-sa-orange";
  if (props.relayReadinessLevel === "warning") return "text-sa-warning";
  return "text-sa-error";
});
</script>

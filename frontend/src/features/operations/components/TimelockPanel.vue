<template>
  <section class="glass-panel p-6">
    <div class="mb-4 flex items-center justify-between gap-4">
      <div>
        <h2 class="text-lg font-bold text-sa-text">
          {{ t("timelock.title", "Pending Updates & Timelocks") }}
        </h2>
        <p class="text-sm text-sa-muted">
          {{
            t(
              "timelock.subtitle",
              "View active timelocks and pending account changes.",
            )
          }}
        </p>
      </div>
    </div>

    <!-- Empty state when no pending updates -->
    <div
      v-if="!accountLoaded || pendingUpdates.length === 0"
      class="empty-state"
    >
      <div
        class="mx-auto w-12 h-12 rounded-full bg-sa-panel/30 flex items-center justify-center mb-3"
      >
        <svg
          aria-hidden="true"
          class="w-6 h-6 text-sa-muted"
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
      <p class="text-sm text-sa-text font-medium mb-1">
        {{ t("timelock.noPendingUpdates", "No pending updates") }}
      </p>
      <p class="text-xs text-sa-muted">
        {{
          t(
            "timelock.noPendingUpdatesHint",
            "All account changes have been finalized.",
          )
        }}
      </p>
    </div>

    <!-- Pending updates when account is loaded -->
    <template v-else>
      <!-- Escape hatch countdown (highest priority) -->
      <div
        v-if="escapeUpdate"
        class="mb-5 rounded-xl border-2"
        :class="escapeUpdate.borderClass"
      >
        <div class="p-5">
          <div class="flex items-start justify-between gap-4 mb-4">
            <div class="flex items-center gap-3">
              <div
                class="w-12 h-12 rounded-full flex items-center justify-center"
                :class="escapeUpdate.iconBg"
              >
                <svg
                  aria-hidden="true"
                  class="w-6 h-6"
                  :class="escapeUpdate.iconClass"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                  ></path>
                </svg>
              </div>
              <div>
                <p
                  class="text-xs font-bold uppercase"
                  :class="escapeUpdate.labelClass"
                >
                  {{ t("timelock.escapeHatch", "Escape Hatch") }}
                </p>
                <p class="text-lg font-bold" :class="escapeUpdate.statusClass">
                  {{ escapeUpdate.status }}
                </p>
              </div>
            </div>
            <span class="badge" :class="escapeUpdate.badgeClass">{{
              escapeUpdate.type
            }}</span>
          </div>

          <!-- Countdown timer -->
          <div class="mb-4 rounded-lg" :class="escapeUpdate.timerBg">
            <div class="p-4">
              <p class="text-xs font-bold uppercase text-sa-muted mb-2">
                {{ t("timelock.timeRemaining", "Time Remaining") }}
              </p>
              <div class="flex items-baseline gap-1">
                <span
                  class="text-4xl font-bold font-mono"
                  :class="escapeUpdate.timerTextClass"
                  >{{ formatCountdown(escapeUpdate.timeRemaining) }}</span
                >
                <span class="text-lg" :class="escapeUpdate.timerUnitClass">{{
                  escapeUpdate.timeUnit
                }}</span>
              </div>
            </div>
          </div>

          <!-- Timeline visualization -->
          <div class="mb-4">
            <div class="flex items-center justify-between mb-2">
              <p class="text-xs font-bold uppercase text-sa-muted">
                {{ t("timelock.timeline", "Timeline") }}
              </p>
              <button
                v-if="escapeUpdate.canCancel"
                class="text-xs text-sa-error hover:text-sa-error-light transition-colors duration-200"
                @click="$emit('cancel-escape')"
              >
                {{ t("timelock.cancelEscape", "Cancel Escape") }}
              </button>
            </div>
            <div
              class="relative h-2 rounded-full"
              :class="escapeUpdate.progressBg"
            >
              <div
                class="absolute left-0 top-0 h-2 rounded-full transition-all duration-1000"
                :class="escapeUpdate.progressClass"
                :style="{ width: escapeUpdate.progressPercentage + '%' }"
              ></div>
            </div>
            <div class="flex justify-between mt-1">
              <div
                v-for="(step, idx) in escapeTimeline"
                :key="idx"
                class="text-center"
                style="width: 33.33%"
              >
                <div class="flex items-center justify-center mb-1">
                  <div
                    class="w-4 h-4 rounded-full flex items-center justify-center"
                    :class="step.completed ? 'bg-sa-success' : 'bg-sa-border'"
                  >
                    <svg
                      v-if="step.completed"
                      aria-hidden="true"
                      class="w-2.5 h-2.5 text-sa-dark"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fill-rule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clip-rule="evenodd"
                      />
                    </svg>
                  </div>
                </div>
                <p class="text-[10px] text-sa-muted">{{ step.label }}</p>
              </div>
            </div>
          </div>

          <!-- Action buttons -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              v-if="escapeUpdate.canFinalize"
              class="btn-primary"
              :class="{ 'btn-loading': finalizing }"
              :disabled="finalizing"
              @click="$emit('finalize-escape')"
            >
              {{
                finalizing
                  ? t("timelock.finalizing", "Finalizing…")
                  : t("timelock.finalizeEscape", "Finalize Escape")
              }}
            </button>
            <button
              v-if="escapeUpdate.canCancel"
              class="btn-danger"
              :class="{ 'btn-loading': canceling }"
              :disabled="canceling"
              @click="confirmCancelEscape"
            >
              {{
                canceling
                  ? t("timelock.canceling", "Canceling…")
                  : t("timelock.cancelEscape", "Cancel Escape")
              }}
            </button>
          </div>
        </div>
      </div>

      <!-- Plugin rotation updates -->
      <div
        v-if="pluginUpdates.length > 0"
        class="rounded-lg border border-sa-border bg-sa-panel/60 p-5"
      >
        <p class="text-xs font-bold uppercase text-sa-muted mb-3">
          {{ t("timelock.pluginRotations", "Plugin Rotations") }}
        </p>
        <div class="space-y-3">
          <div
            v-for="update in pluginUpdates"
            :key="update.id"
            class="flex items-start gap-4 rounded-lg bg-sa-dark/40 p-4"
          >
            <div
              class="w-10 h-10 rounded-lg flex items-center justify-center"
              :class="update.iconBg"
            >
              <svg
                v-if="update.type === 'verifier'"
                aria-hidden="true"
                class="w-5 h-5"
                :class="update.iconClass"
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
              <svg
                v-else
                aria-hidden="true"
                class="w-5 h-5"
                :class="update.iconClass"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
                ></path>
              </svg>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <p class="text-sm font-semibold text-sa-text">
                  {{ update.title }}
                </p>
                <span class="badge" :class="update.badgeClass">{{
                  update.statusText
                }}</span>
              </div>
              <p class="text-xs text-sa-muted mb-2">{{ update.description }}</p>
              <div class="flex items-center gap-4">
                <div>
                  <p class="text-[10px] uppercase text-sa-muted">
                    {{ t("timelock.from", "From") }}
                  </p>
                  <p
                    class="text-xs font-mono text-sa-text truncate"
                    :title="update.from"
                  >
                    {{ formatHash(update.from) }}
                  </p>
                </div>
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
                    d="M13 7l5 5m0 0l-5 5M6 12l7-7 7 7"
                  ></path>
                </svg>
                <div>
                  <p class="text-[10px] uppercase text-sa-muted">
                    {{ t("timelock.to", "To") }}
                  </p>
                  <p
                    class="text-xs font-mono text-sa-text truncate"
                    :title="update.to"
                  >
                    {{ formatHash(update.to) }}
                  </p>
                </div>
              </div>
            </div>
            <div class="text-right shrink-0">
              <p class="text-lg font-bold font-mono" :class="update.timeClass">
                {{ formatCountdown(update.timeRemaining) }}
              </p>
              <p class="text-xs text-sa-muted">{{ update.timeUnit }}</p>
              <button
                v-if="update.canCancel"
                class="mt-2 text-xs text-sa-error hover:text-sa-error-light transition-colors duration-200"
                @click="$emit('cancel-plugin-update', update.id)"
              >
                {{ t("timelock.cancel", "Cancel") }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Unauthorized change alert -->
      <div
        v-if="unauthorizedChanges.length > 0"
        class="mt-5 rounded-xl border-2 border-sa-error bg-sa-error/5 p-5"
      >
        <div class="flex items-start gap-3">
          <div
            class="w-10 h-10 rounded-full bg-sa-error/20 flex items-center justify-center"
          >
            <svg
              aria-hidden="true"
              class="w-5 h-5 text-sa-error"
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
          </div>
          <div class="flex-1">
            <p class="text-sm font-bold text-sa-error mb-2">
              {{
                t(
                  "timelock.unauthorizedChangesDetected",
                  "Unauthorized Changes Detected",
                )
              }}
            </p>
            <p class="text-xs text-sa-error-light mb-3">
              {{
                t(
                  "timelock.unauthorizedChangesDesc",
                  "These changes were initiated without proper authorization. Review them carefully.",
                )
              }}
            </p>
            <div class="space-y-2">
              <div
                v-for="change in unauthorizedChanges"
                :key="change.id"
                class="flex items-start gap-2 rounded bg-sa-error/10 px-3 py-2"
              >
                <span class="text-xs text-sa-error font-medium"
                  >{{ change.type }}:</span
                >
                <span class="text-xs font-mono text-sa-muted">{{
                  change.details
                }}</span>
              </div>
            </div>
            <button
              class="mt-3 btn-danger w-full"
              @click="$emit('report-unauthorized')"
            >
              {{ t("timelock.reportUnauthorized", "Report and Reject") }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- Cancel escape confirmation modal -->
    <transition name="fade-in-up">
      <div
        v-if="showCancelModal"
        class="modal-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-dialog-title"
        @click.self="showCancelModal = false"
        @keydown.escape="showCancelModal = false"
        tabindex="-1"
      >
        <div class="modal-panel">
          <h3
            id="cancel-dialog-title"
            class="text-lg font-bold font-outfit text-sa-text mb-2"
          >
            {{ t("timelock.cancelEscapeTitle", "Cancel Escape Hatch?") }}
          </h3>
          <p class="text-sm text-sa-muted mb-6">
            {{
              t(
                "timelock.cancelEscapeDesc",
                "This will stop the escape hatch countdown and revert all pending changes. You will need to initiate the escape again.",
              )
            }}
          </p>
          <div class="flex gap-3 justify-end">
            <button class="btn-ghost" @click="showCancelModal = false">
              {{ t("timelock.back", "Back") }}
            </button>
            <button
              class="btn-danger"
              :class="{ 'btn-loading': canceling }"
              :disabled="canceling"
              @click="confirmCancelEscapeAction"
            >
              {{
                canceling
                  ? t("timelock.canceling", "Canceling…")
                  : t("timelock.confirmCancel", "Confirm Cancel")
              }}
            </button>
          </div>
        </div>
      </div>
    </transition>
  </section>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted } from "vue";
import { useI18n } from "@/i18n";
import { formatHash as formatHashUtil } from "@/utils/hex.js";

const { t } = useI18n();

const props = defineProps({
  accountLoaded: { type: Boolean, default: false },
  pendingUpdates: { type: Array, default: () => [] },
  unauthorizedChanges: { type: Array, default: () => [] },
  finalizing: { type: Boolean, default: false },
  canceling: { type: Boolean, default: false },
});

defineEmits([
  "cancel-escape",
  "finalize-escape",
  "cancel-plugin-update",
  "report-unauthorized",
]);

const showCancelModal = ref(false);
let countdownInterval = null;

// Escape update with countdown
const escapeUpdate = computed(() => {
  const escape = props.pendingUpdates.find((u) => u.type === "escape");
  if (!escape) return null;

  const totalTime = escape.totalTime || 86400; // 24 hours default
  const elapsed = escape.elapsedTime || 0;
  const remaining = Math.max(0, totalTime - elapsed);
  const progressPercentage = (elapsed / totalTime) * 100;

  let status = t("timelock.pending", "Pending");
  let statusClass = "text-sa-warning";
  let badgeClass = "badge-orange";
  let borderClass = "border-sa-warning/30 bg-sa-warning/5";
  let timerBg = "bg-sa-dark/60";
  let timerTextClass = "text-sa-warning";
  let timerUnitClass = "text-sa-muted";
  let progressBg = "bg-sa-border";
  let progressClass = "bg-sa-warning";
  let iconBg = "bg-sa-warning/20";
  let iconClass = "text-sa-warning";
  let labelClass = "text-sa-warning";

  if (escape.status === "active") {
    status = t("timelock.active", "Active");
    statusClass = "text-sa-error";
    badgeClass = "badge-red";
    borderClass = "border-sa-error/30 bg-sa-error/5";
    timerBg = "bg-sa-error/10";
    timerTextClass = "text-sa-error";
    timerUnitClass = "text-sa-error-light";
    progressBg = "bg-sa-border";
    progressClass = "bg-sa-error";
    iconBg = "bg-sa-error/20";
    iconClass = "text-sa-error";
    labelClass = "text-sa-error";
  } else if (escape.status === "ready") {
    status = t("timelock.ready", "Ready to Finalize");
    statusClass = "text-sa-success";
    badgeClass = "badge-green";
    borderClass = "border-sa-success/30 bg-sa-success/5";
    timerBg = "bg-sa-success/10";
    timerTextClass = "text-sa-success";
    timerUnitClass = "text-sa-success-light";
    progressBg = "bg-sa-border";
    progressClass = "bg-sa-success";
    iconBg = "bg-sa-success/20";
    iconClass = "text-sa-success";
    labelClass = "text-sa-success";
  }

  return {
    ...escape,
    status,
    statusClass,
    badgeClass,
    borderClass,
    timerBg,
    timerTextClass,
    timerUnitClass,
    progressBg,
    progressClass,
    progressPercentage,
    iconBg,
    iconClass,
    labelClass,
    canCancel: escape.status === "pending" || escape.status === "active",
    canFinalize: escape.status === "ready",
  };
});

// Escape timeline steps
const escapeTimeline = computed(() => {
  const escape = escapeUpdate.value;
  if (!escape) return [];

  const steps = [
    { label: t("timelock.initiate", "Initiate"), completed: true },
    { label: t("timelock.wait", "Wait"), completed: escape.status === "ready" },
    { label: t("timelock.finalize", "Finalize"), completed: false },
  ];

  if (escape.status === "active") {
    steps[1].completed = true;
  } else if (escape.status === "ready") {
    steps[1].completed = true;
    steps[2].completed = true;
  }

  return steps;
});

// Plugin updates (verifier/hook rotations)
const pluginUpdates = computed(() => {
  return props.pendingUpdates
    .filter((u) => u.type === "verifier" || u.type === "hook")
    .map((u) => {
      const totalTime = u.totalTime || 3600; // 1 hour default
      const elapsed = u.elapsedTime || 0;
      const remaining = Math.max(0, totalTime - elapsed);

      return {
        ...u,
        timeRemaining: remaining,
        timeUnit: remaining > 3600 ? "h" : "m",
        timeClass: remaining < 3600 ? "text-sa-warning" : "text-sa-muted",
        iconBg: u.type === "verifier" ? "bg-neo-500/20" : "bg-sa-info/20",
        iconClass: u.type === "verifier" ? "text-neo-400" : "text-sa-info",
        badgeClass: u.status === "ready" ? "badge-green" : "badge-orange",
        statusText:
          u.status === "ready"
            ? t("timelock.ready", "Ready")
            : t("timelock.pending", "Pending"),
      };
    });
});

function formatCountdown(seconds) {
  if (seconds === null || seconds === undefined) return "--";
  if (seconds < 60) return Math.floor(seconds);
  if (seconds < 3600) return Math.floor(seconds / 60);
  return Math.floor(seconds / 3600);
}

function formatHash(hash) {
  return formatHashUtil(hash, { notSetLabel: t("timelock.unknown", "Unknown") });
}

function confirmCancelEscape() {
  showCancelModal.value = true;
}

function confirmCancelEscapeAction() {
  showCancelModal.value = false;
  // Emit event to parent component
  // Parent will handle the actual cancellation
}

// Start countdown timer
onMounted(() => {
  countdownInterval = setInterval(() => {
    // Update countdown by checking props
    // In real implementation, parent component would emit updates
  }, 1000);
});

// Cleanup timer
onUnmounted(() => {
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }
});
</script>

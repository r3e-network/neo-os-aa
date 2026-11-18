<template>
  <div
    class="mb-8 rounded-xl border border-sa-border bg-sa-panel/40 p-4 backdrop-blur-md"
  >
    <div class="flex items-center justify-between mb-3">
      <p class="text-xs font-bold uppercase text-sa-muted">
        {{ t("operations.workflowProgress", "Workflow Progress") }}
      </p>
      <div class="flex items-center gap-3">
        <p class="text-xs text-sa-muted">{{ currentStepLabel }}</p>
        <button
          @click="emit('toggle-shortcuts')"
          class="text-sa-muted hover:text-sa-text transition-colors duration-200 text-xs font-mono border border-sa-border rounded px-3 py-2 sm:py-1 hover:border-sa-orange/30"
          :aria-label="
            t('operations.keyboardShortcuts', 'Keyboard shortcuts')
          "
          :title="t('operations.keyboardShortcuts', 'Keyboard shortcuts')"
        >
          ?
        </button>
        <button
          @click="emit('reset-workflow')"
          class="text-xs text-sa-muted hover:text-sa-error font-medium transition-colors duration-200"
          :aria-label="t('operations.resetWorkflow', 'Reset workflow')"
          :title="t('operations.resetWorkflow', 'Reset workflow')"
        >
          <svg
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
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            ></path>
          </svg>
        </button>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-2 justify-center">
      <template v-for="(step, index) in steps" :key="step.id">
        <button
          @click="step.state !== 'pending' ? emit('jump-to-step', step.id) : null"
          :aria-label="step.label"
          :disabled="step.state === 'pending'"
          :title="
            step.state === 'pending'
              ? t('operations.stepLocked', 'Complete previous steps first')
              : step.label
          "
          class="flex items-center gap-2 px-3 py-2 rounded-lg transition-all duration-200"
          :class="
            step.state === 'active'
              ? 'bg-neo-500/20 border border-neo-500/50 text-neo-300'
              : step.state === 'completed'
                ? 'bg-sa-success/10 border border-sa-success/30 text-sa-success-light hover:bg-sa-success/20 cursor-pointer'
                : 'bg-sa-dark/30 border border-sa-border text-sa-muted cursor-not-allowed opacity-60'
          "
        >
          <div
            class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
            :class="
              step.state === 'active'
                ? 'bg-neo-500 text-sa-dark'
                : step.state === 'completed'
                  ? 'bg-sa-success text-sa-dark'
                  : 'bg-sa-dark text-sa-text'
            "
          >
            <svg
              aria-hidden="true"
              v-if="step.state === 'completed'"
              class="w-3 h-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="3"
                d="M5 13l4 4L19 7"
              ></path>
            </svg>
            <span v-else>{{ index + 1 }}</span>
          </div>
          <span
            class="text-xs font-medium truncate max-w-20 sm:max-w-none"
            >{{ step.label }}</span
          >
        </button>
        <div
          v-if="index < steps.length - 1"
          class="flex-1 h-0.5 rounded"
          :class="
            steps[index].state === 'completed' &&
            steps[index + 1].state !== 'locked'
              ? 'bg-sa-success/50'
              : 'bg-sa-dark'
          "
        ></div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

defineProps({
  steps: {
    type: Array,
    required: true,
  },
  currentStepLabel: {
    type: String,
    default: "",
  },
});

const emit = defineEmits(["jump-to-step", "reset-workflow", "toggle-shortcuts"]);

const { t } = useI18n();
</script>

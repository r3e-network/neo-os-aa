<template>
  <div
    ref="overlayRef"
    role="dialog"
    aria-modal="true"
    aria-labelledby="shortcuts-title"
    class="modal-overlay"
    @click.self="emit('close')"
    @keydown.escape="emit('close')"
    @keydown.tab="onTab"
    tabindex="-1"
  >
    <div
      class="bg-sa-panel border border-sa-border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4"
    >
      <div class="flex items-center justify-between mb-4">
        <h3
          id="shortcuts-title"
          class="text-lg font-bold font-outfit text-sa-text"
        >
          {{ t("shortcuts.title", "Keyboard Shortcuts") }}
        </h3>
        <button
          @click="emit('close')"
          :aria-label="t('shortcuts.close', 'Close keyboard shortcuts')"
          class="text-sa-muted hover:text-sa-text transition-colors duration-200"
        >
          <svg
            aria-hidden="true"
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M6 18L18 6M6 6l12 12"
            ></path>
          </svg>
        </button>
      </div>
      <div class="space-y-3">
        <div class="flex items-center justify-between text-sm">
          <span class="text-sa-muted">{{
            t("shortcuts.toggle", "Toggle shortcuts")
          }}</span>
          <kbd
            class="px-2 py-1 rounded bg-sa-dark border border-sa-border text-xs font-mono text-sa-text"
            >?</kbd
          >
        </div>
        <div class="flex items-center justify-between text-sm">
          <span class="text-sa-muted">{{
            t("shortcuts.navigateSteps", "Navigate steps")
          }}</span>
          <div class="flex gap-1">
            <kbd
              class="px-2 py-1 rounded bg-sa-dark border border-sa-border text-xs font-mono text-sa-text"
              >Ctrl</kbd
            >
            <span class="text-sa-muted text-xs">+</span>
            <kbd
              class="px-2 py-1 rounded bg-sa-dark border border-sa-border text-xs font-mono text-sa-text"
              >1-5</kbd
            >
          </div>
        </div>
        <div class="flex items-center justify-between text-sm">
          <span class="text-sa-muted">{{
            t("shortcuts.saveDraft", "Save draft")
          }}</span>
          <div class="flex gap-1">
            <kbd
              class="px-2 py-1 rounded bg-sa-dark border border-sa-border text-xs font-mono text-sa-text"
              >Ctrl</kbd
            >
            <span class="text-sa-muted text-xs">+</span>
            <kbd
              class="px-2 py-1 rounded bg-sa-dark border border-sa-border text-xs font-mono text-sa-text"
              >S</kbd
            >
          </div>
        </div>
        <div class="flex items-center justify-between text-sm">
          <span class="text-sa-muted">{{
            t("shortcuts.broadcast", "Broadcast")
          }}</span>
          <div class="flex gap-1">
            <kbd
              class="px-2 py-1 rounded bg-sa-dark border border-sa-border text-xs font-mono text-sa-text"
              >Ctrl</kbd
            >
            <span class="text-sa-muted text-xs">+</span>
            <kbd
              class="px-2 py-1 rounded bg-sa-dark border border-sa-border text-xs font-mono text-sa-text"
              >Enter</kbd
            >
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "@/i18n";

const emit = defineEmits(["close"]);

const { t } = useI18n();

const overlayRef = ref(null);

// Focus management (WCAG 2.4.3): Tab cycles within the dialog while it is
// open, and focus returns to the element that opened it on close.
let previouslyFocused = null;
onMounted(() => {
  previouslyFocused = document.activeElement;
});
onUnmounted(() => {
  previouslyFocused?.focus?.();
});

function onTab(event) {
  const root = overlayRef.value;
  if (!root) return;
  const items = Array.from(
    root.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.disabled);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function focus() {
  overlayRef.value?.focus();
}

defineExpose({ focus });
</script>

<template>
  <div
    ref="overlayRef"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="confirmation-dialog-title"
    @click.self="emit('cancel')"
    @keydown.escape="emit('cancel')"
    @keydown.tab="onTab"
    tabindex="-1"
  >
    <div class="modal-panel">
      <h3
        id="confirmation-dialog-title"
        class="text-lg font-bold text-sa-text font-outfit"
      >
        {{ title }}
      </h3>
      <p class="mt-3 text-sm text-sa-text leading-relaxed">
        {{ message }}
      </p>
      <div class="mt-6 flex gap-3 justify-end">
        <button class="btn-ghost" @click="emit('cancel')">
          {{ t("operations.confirmCancel", "Cancel") }}
        </button>
        <button class="btn-primary" @click="emit('confirm')">
          {{ t("operations.confirmProceed", "Confirm") }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "@/i18n";

defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  title: {
    type: String,
    default: "",
  },
  message: {
    type: String,
    default: "",
  },
});

const emit = defineEmits(["cancel", "confirm"]);

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

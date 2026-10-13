<template>
  <transition name="fade-in-up">
    <div
      ref="confirmOverlayRef"
      v-if="modal"
      class="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="governance-dialog-title"
      @click.self="$emit('close')"
      @keydown.escape="$emit('close')"
      tabindex="-1"
    >
      <div class="modal-panel">
        <h3
          id="governance-dialog-title"
          class="text-lg font-bold font-outfit text-aa-text mb-2"
        >
          {{ modal.title }}
        </h3>
        <p class="text-sm text-aa-muted mb-6 whitespace-pre-line">{{ modal.message }}</p>
        <div class="flex gap-3 justify-end">
          <button class="btn-ghost" @click="$emit('close')">
            {{ t("studioPanels.cancel", "Cancel") }}
          </button>
          <button
            :class="modal.danger ? 'btn-danger' : 'btn-primary'"
            @click="$emit('confirm')"
          >
            {{ modal.confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup>
import { nextTick, ref, watch } from "vue";
import { useI18n } from "@/i18n";

const { t } = useI18n();

const props = defineProps({
  modal: {
    type: Object,
    default: null,
  },
});

defineEmits(["close", "confirm"]);

const confirmOverlayRef = ref(null);

watch(
  () => props.modal,
  (value) => {
    if (value) {
      nextTick(() => confirmOverlayRef.value?.focus());
    }
  },
);
</script>

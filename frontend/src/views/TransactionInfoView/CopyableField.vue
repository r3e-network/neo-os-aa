<template>
  <div class="rounded-lg border border-sa-border bg-sa-dark p-4">
    <p class="text-xs font-semibold text-sa-muted uppercase mb-1">
      {{ label }}
    </p>
    <div class="flex items-center">
      <code class="block text-sm font-mono text-sa-text break-all flex-1">{{
        value
      }}</code>
      <button
        v-if="showCopyButton"
        @click="$emit('copy')"
        :aria-label="copyAriaLabel"
        class="ml-1.5 text-sa-muted hover:text-sa-text transition-colors duration-200 flex-shrink-0"
      >
        <svg
          aria-hidden="true"
          v-if="activeCopiedKey !== copyKey"
          xmlns="http://www.w3.org/2000/svg"
          class="h-3.5 w-3.5"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
          <path
            d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"
          />
        </svg>
        <svg
          aria-hidden="true"
          v-else
          xmlns="http://www.w3.org/2000/svg"
          class="h-3.5 w-3.5 text-sa-success"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fill-rule="evenodd"
            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup>
defineProps({
  label: { type: String, default: "" },
  value: { type: String, default: "" },
  copyKey: { type: String, default: "" },
  activeCopiedKey: { type: String, default: "" },
  copyAriaLabel: { type: String, default: "" },
  showCopyButton: { type: Boolean, default: false },
});

defineEmits(["copy"]);
</script>

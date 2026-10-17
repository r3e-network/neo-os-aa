<template>
  <div class="mb-5 grid gap-3 lg:grid-cols-4">
    <button
      v-for="option in presetOptions"
      :key="option.id"
      :aria-label="option.label"
      class="rounded-lg border p-4 text-left transition-all duration-200"
      :class="
        option.id === preset
          ? 'border-aa-orange bg-aa-orange/15 shadow-md ring-2 ring-aa-orange'
          : 'border-aa-border bg-aa-panel hover:border-aa-orange hover:shadow-sm'
      "
      @click="$emit('update:preset', option.id)"
    >
      <div class="flex items-start gap-2">
        <div class="flex-shrink-0 mt-0.5">
          <svg
            aria-hidden="true"
            v-if="option.id === 'invoke'"
            class="w-5 h-5 text-aa-muted"
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
          <svg
            aria-hidden="true"
            v-else-if="option.id === 'nep17Transfer'"
            class="w-5 h-5 text-aa-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
            ></path>
          </svg>
          <svg
            aria-hidden="true"
            v-else
            class="w-5 h-5 text-aa-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            ></path>
          </svg>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-bold text-aa-text">{{ option.label }}</div>
          <div class="mt-1 text-xs text-aa-muted line-clamp-2">
            {{ option.description }}
          </div>
        </div>
      </div>
    </button>
  </div>
</template>

<script setup>
defineProps({
  preset: { type: String, default: "invoke" },
  presetOptions: { type: Array, default: () => [] },
});

defineEmits(["update:preset"]);
</script>

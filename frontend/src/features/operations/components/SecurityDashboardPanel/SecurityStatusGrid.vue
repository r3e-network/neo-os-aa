<template>
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
    <!-- Verifier Status -->
    <div
      class="rounded-lg border bg-sa-panel/50 p-4"
      :class="verifierStatus.borderClass"
    >
      <div class="flex items-center gap-2 mb-2">
        <svg
          aria-hidden="true"
          class="w-5 h-5"
          :class="verifierStatus.iconClass"
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
        <span
          class="text-xs font-bold uppercase"
          :class="verifierStatus.labelClass"
          >{{ t("security.verifierStatus", "Verifier") }}</span
        >
      </div>
      <p
        class="font-semibold text-sm text-sa-text truncate"
        :title="accountState.verifier"
      >
        {{ verifierStatus.displayValue }}
      </p>
      <p class="mt-1 text-xs" :class="verifierStatus.descriptionClass">
        {{ verifierStatus.description }}
      </p>
    </div>

    <!-- Hook Status -->
    <div
      class="rounded-lg border bg-sa-panel/50 p-4"
      :class="hookStatus.borderClass"
    >
      <div class="flex items-center gap-2 mb-2">
        <svg
          aria-hidden="true"
          class="w-5 h-5"
          :class="hookStatus.iconClass"
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
        <span
          class="text-xs font-bold uppercase"
          :class="hookStatus.labelClass"
          >{{ t("security.hookStatus", "Hook") }}</span
        >
      </div>
      <p
        class="font-semibold text-sm text-sa-text truncate"
        :title="accountState.hook"
      >
        {{ hookStatus.displayValue }}
      </p>
      <p class="mt-1 text-xs" :class="hookStatus.descriptionClass">
        {{ hookStatus.description }}
      </p>
    </div>

    <!-- Backup Owner Status -->
    <div
      class="rounded-lg border bg-sa-panel/50 p-4"
      :class="backupStatus.borderClass"
    >
      <div class="flex items-center gap-2 mb-2">
        <svg
          aria-hidden="true"
          class="w-5 h-5"
          :class="backupStatus.iconClass"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
          ></path>
        </svg>
        <span
          class="text-xs font-bold uppercase"
          :class="backupStatus.labelClass"
          >{{ t("security.backupOwner", "Backup Owner") }}</span
        >
      </div>
      <p
        class="font-semibold text-sm text-sa-text truncate"
        :title="accountState.backupOwner"
      >
        {{ backupStatus.displayValue }}
      </p>
      <p class="mt-1 text-xs" :class="backupStatus.descriptionClass">
        {{ backupStatus.description }}
      </p>
    </div>

    <!-- Escape Hatch Status -->
    <div
      class="rounded-lg border bg-sa-panel/50 p-4"
      :class="escapeStatus.borderClass"
    >
      <div class="flex items-center gap-2 mb-2">
        <svg
          aria-hidden="true"
          class="w-5 h-5"
          :class="escapeStatus.iconClass"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          ></path>
        </svg>
        <span
          class="text-xs font-bold uppercase"
          :class="escapeStatus.labelClass"
          >{{ t("security.escapeHatch", "Escape Hatch") }}</span
        >
      </div>
      <p class="font-semibold text-sm text-sa-text">
        {{ escapeStatus.displayValue }}
      </p>
      <p class="mt-1 text-xs" :class="escapeStatus.descriptionClass">
        {{ escapeStatus.description }}
      </p>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

defineProps({
  verifierStatus: { type: Object, default: () => ({}) },
  hookStatus: { type: Object, default: () => ({}) },
  backupStatus: { type: Object, default: () => ({}) },
  escapeStatus: { type: Object, default: () => ({}) },
  accountState: { type: Object, default: () => ({}) },
});

const { t } = useI18n();
</script>

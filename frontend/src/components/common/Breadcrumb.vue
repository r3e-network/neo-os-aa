<template>
  <nav class="mb-3" :aria-label="t('nav.breadcrumbAria', 'Breadcrumb')">
    <ol class="flex flex-wrap gap-1.5 list-none m-0 p-0 text-sm text-sa-text/75">
      <template v-for="(item, index) in items" :key="`${item.label}-${index}`">
        <li>
          <RouterLink
            v-if="item.to"
            :to="item.to"
            class="text-sa-orange hover:text-sa-lightOrange transition-colors duration-200"
            >{{ item.label }}</RouterLink
          >
          <span
            v-else
            :aria-current="index === items.length - 1 ? 'page' : undefined"
            >{{ item.label }}</span
          >
        </li>
        <li v-if="index < items.length - 1" class="select-none text-sa-text/70">
          <svg
            aria-hidden="true"
            class="w-3 h-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9 5l7 7-7 7"
            />
          </svg>
        </li>
      </template>
    </ol>
  </nav>
</template>

<script setup>
import { useI18n } from "@/i18n";

const { t } = useI18n();

defineProps({
  items: {
    type: Array,
    default: () => [],
  },
});
</script>

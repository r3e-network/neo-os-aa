<template>
  <section class="mb-10 grid grid-cols-1 sm:grid-cols-3 gap-4">
    <template v-if="loading && !hasLoaded">
      <div
        v-for="i in 3"
        :key="'stat-skel-' + i"
        class="gradient-border-card bg-sa-panel/60 backdrop-blur-xl p-5"
      >
        <div class="skeleton h-3 w-24 mb-3"></div>
        <div class="skeleton h-8 w-16"></div>
      </div>
    </template>
    <template v-else>
      <div
        class="gradient-border-card bg-sa-panel/60 backdrop-blur-xl p-5 group hover:bg-sa-panel/60 transition-all duration-200"
      >
        <p class="text-xs font-semibold uppercase text-sa-muted">
          {{ t("market.statsTotal", "Total Listings") }}
        </p>
        <p class="mt-2 text-3xl font-extrabold text-sa-text font-outfit">
          {{ totalListings }}
        </p>
      </div>
      <div
        class="gradient-border-card bg-sa-panel/60 backdrop-blur-xl p-5 group hover:bg-sa-panel/60 transition-all duration-200"
      >
        <p class="text-xs font-semibold uppercase text-sa-muted">
          {{ t("market.statsActive", "Active Escrows") }}
        </p>
        <p class="mt-2 text-3xl font-extrabold text-sa-success font-outfit">
          {{ activeCount }}
        </p>
      </div>
      <div
        class="gradient-border-card bg-sa-panel/60 backdrop-blur-xl p-5 group hover:bg-sa-panel/60 transition-all duration-200"
      >
        <p class="text-xs font-semibold uppercase text-sa-muted">
          {{ t("market.statsAvgPrice", "Avg Price") }}
        </p>
        <p class="mt-2 text-3xl font-extrabold text-sa-text font-outfit">
          {{ avgPrice }}
          <span class="text-sm font-semibold text-sa-muted">GAS</span>
        </p>
      </div>
    </template>
  </section>
</template>

<script setup>
import { useI18n } from "@/i18n";

const { t } = useI18n();

defineProps({
  loading: { type: Boolean, default: false },
  hasLoaded: { type: Boolean, default: false },
  totalListings: { type: Number, default: 0 },
  activeCount: { type: Number, default: 0 },
  avgPrice: { type: String, default: "0" },
});
</script>

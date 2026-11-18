<template>
  <div
    class="flex flex-col gap-3 rounded-2xl border border-sa-border bg-sa-panel/60 p-5 backdrop-blur-xl md:flex-row md:items-center md:justify-between"
  >
    <div>
      <h2 class="text-lg font-bold text-sa-text">
        {{ t("market.onChainListings", "On-Chain Listings") }}
      </h2>
      <p class="mt-1 text-sm text-sa-muted">
        {{
          t(
            "market.onChainListingsHint",
            "Listings, escrow status, and settlement are read directly from the market contract and SA core contract.",
          )
        }}
      </p>
    </div>
    <button
      type="button"
      class="btn-secondary"
      :class="{ 'btn-loading': loading }"
      :disabled="loading || !marketConfigured"
      :aria-label="
        loading
          ? t('market.refreshing', 'Refreshing...')
          : t('market.refreshListings', 'Refresh Listings')
      "
      @click="$emit('refresh')"
    >
      {{
        loading
          ? t("market.refreshing", "Refreshing...")
          : t("market.refreshListings", "Refresh Listings")
      }}
    </button>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

const { t } = useI18n();

defineProps({
  loading: { type: Boolean, default: false },
  marketConfigured: { type: Boolean, default: false },
});

defineEmits(["refresh"]);
</script>

<template>
  <div class="empty-state">
    <EmptyStateArt
      :size="184"
      class="mx-auto mb-3"
      :title="t('market.noListingsFound', 'No listings found on-chain yet')"
    />
    <p class="text-sa-text font-medium mb-2">
      {{
        t("market.noListingsFound", "No listings found on-chain yet")
      }}
    </p>
    <p class="text-sm text-sa-muted max-w-md mx-auto mb-6">
      {{
        t(
          "market.noListingsHint",
          "Be the first to list your Smart Account address for sale. Listings are secured by trustless on-chain escrow.",
        )
      }}
    </p>
    <router-link
      to="/app"
      class="inline-flex items-center gap-2 text-sm font-semibold text-sa-info hover:text-sa-info-light transition-colors duration-200"
    >
      {{
        t("market.createSaAccountFirst", "Create an SA account first")
      }}
      <span>&rarr;</span>
    </router-link>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";
import { EmptyStateArt } from "@/components/illustrations";

const { t } = useI18n();
</script>

<template>
  <section
    class="mb-8 rounded-2xl border border-amber-300 bg-amber-50 p-6 text-slate-800"
  >
    <h2 class="text-lg font-bold text-slate-950">
      {{ t("market.notConfiguredTitle", "Market Contract Not Configured") }}
    </h2>
    <p class="mt-3 text-sm leading-7">
      {{
        t(
          "market.notConfiguredBody",
          "Set VITE_SA_MARKET_HASH for the current deployment before using the trustless escrow market. The UI will not fall back to local listings anymore.",
        )
      }}
    </p>
  </section>
</template>

<script setup>
import { useI18n } from "@/i18n";

const { t } = useI18n();
</script>

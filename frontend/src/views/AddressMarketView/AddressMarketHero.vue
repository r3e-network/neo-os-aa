<template>
  <section class="mb-10 relative">
    <div
      class="absolute -top-20 -right-20 w-72 h-72 bg-sa-info/5 rounded-full blur-3xl pointer-events-none"
    ></div>
    <div
      class="absolute -bottom-16 -left-16 w-56 h-56 bg-sa-success/5 rounded-full blur-3xl pointer-events-none"
    ></div>
    <div class="relative">
      <CoinArt
        kind="stack"
        :size="56"
        class="mb-4"
        :title="t('market.subtitlePart2', 'Marketplace')"
      />
      <div
        class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-sa-info/10 text-sa-info text-sm font-semibold border border-sa-info/25 shadow-sm mb-4"
      >
        <span class="relative flex h-2 w-2">
          <span
            class="animate-ping absolute inline-flex h-full w-full rounded-full bg-sa-info opacity-75"
          ></span>
          <span
            class="relative inline-flex rounded-full h-2 w-2 bg-sa-info"
          ></span>
        </span>
        {{ t("market.badge", "Trustless Escrow") }}
      </div>
      <span class="sr-only">{{
        t(
          "market.srDescription",
          "Trustless escrow for SA address transfers",
        )
      }}</span>
      <h1
        class="text-4xl font-extrabold font-outfit md:text-5xl leading-tight"
      >
        <span class="text-gradient-white mr-2">{{
          t("market.subtitlePart1", "SA Address")
        }}</span>
        <span class="text-gradient">
          {{ t("market.subtitlePart2", "Marketplace") }}</span
        >
      </h1>
      <p class="mt-4 max-w-3xl text-base leading-8 text-sa-text">
        {{
          t(
            "market.description",
            "Sellers list an SA account and atomically lock it into escrow. Buyers settle in one chain transaction: transfer GAS to the market contract, rotate control to the new owner, and release seller payment only if the transfer succeeds.",
          )
        }}
      </p>
      <div class="mt-6 flex flex-wrap gap-3">
        <router-link to="/app" class="btn-primary">{{
          t("market.openAppWorkspace", "Open App Workspace")
        }}</router-link>
        <a href="#vanity-generator" class="btn-secondary">{{
          t("market.vanityTitle", "Vanity Address Generator")
        }}</a>
        <router-link
          :to="{ path: '/docs', query: { doc: 'addressMarket' } }"
          class="btn-secondary"
          >{{
            t("market.readMarketGuide", "Read Market Guide")
          }}</router-link
        >
      </div>
    </div>
  </section>
</template>

<script setup>
import { useI18n } from "@/i18n";
import { CoinArt } from "@/components/illustrations";

const { t } = useI18n();
</script>

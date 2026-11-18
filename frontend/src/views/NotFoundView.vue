<template>
  <div
    class="min-h-[80vh] flex flex-col items-center justify-center text-center px-4 relative"
  >
    <div
      class="absolute inset-0 z-0 pointer-events-none bg-[linear-gradient(rgba(123,97,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(123,97,255,0.035)_1px,transparent_1px)] bg-[size:48px_48px]"
    ></div>

    <div class="relative z-10 glass-panel max-w-lg mx-auto p-10">
      <h1 class="text-7xl font-outfit font-bold text-sa-orange mb-3">404</h1>
      <p class="text-lg text-sa-muted mb-2">
        {{ t("nav.pageNotFound", "Page not found") }}
      </p>
      <p class="text-sm text-sa-muted/70 mb-8">
        {{
          t(
            "nav.pageNotFoundDesc",
            "The page you are looking for does not exist or has been moved.",
          )
        }}
      </p>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8">
        <router-link
          v-for="link in suggestions"
          :key="link.to"
          :to="link.to"
          class="flex items-center gap-2 rounded-2xl border border-sa-border bg-sa-dark/60 px-4 py-3 text-sm text-sa-muted hover:text-sa-text hover:border-sa-orange/40 transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sa-orange/40"
        >
          <svg
            aria-hidden="true"
            class="w-4 h-4 flex-shrink-0 text-sa-orange/60"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            v-html="link.icon"
          ></svg>
          {{ t(link.label, link.fallback) }}
        </router-link>
      </div>

      <router-link to="/" class="btn-primary">
        {{ t("nav.backToHome", "Back to Home") }}
      </router-link>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

const { t } = useI18n();

const suggestions = [
  {
    to: "/",
    label: "nav.home",
    fallback: "Home",
    icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path>',
  },
  {
    to: "/app",
    label: "nav.app",
    fallback: "Workspace",
    icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>',
  },
  {
    to: "/market",
    label: "nav.market",
    fallback: "Market",
    icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z"></path>',
  },
  {
    to: "/docs",
    label: "nav.docs",
    fallback: "Docs",
    icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path>',
  },
];
</script>

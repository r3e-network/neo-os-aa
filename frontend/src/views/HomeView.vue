<template>
  <div class="sa-home-focus">
    <section class="sa-home-band">
      <div class="mx-auto grid max-w-7xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:px-8">
        <div class="sa-home-workflow-card">
          <p class="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
            {{ t("home.powered", "Neo N3 Powered") }} · Focus mode
          </p>
          <h1 class="mt-3 max-w-3xl text-3xl font-semibold leading-tight text-slate-950 md:text-4xl">
            {{ t("home.title", "Smart Wallets That Never Lock You Out") }}
          </h1>
          <p class="mt-4 max-w-2xl text-sm leading-6 text-slate-600 md:text-base">
            {{
              t(
                "home.subtitle",
                "Create programmable Neo N3 accounts with deterministic addresses, plugin permissions, paymaster relay, DID recovery, and address-market transfer built into one operating console.",
              )
            }}
          </p>

          <div class="mt-6 grid gap-3">
            <router-link
              v-for="step in primarySteps"
              :key="step.title"
              :to="step.to"
              class="sa-home-step-link group"
            >
              <span class="sa-home-step-index">{{ step.index }}</span>
              <span class="min-w-0">
                <span class="block text-sm font-semibold text-slate-950">{{ step.title }}</span>
                <span class="mt-1 block text-xs leading-5 text-slate-600">{{ step.body }}</span>
              </span>
              <span class="text-slate-400 transition group-hover:text-emerald-700">→</span>
            </router-link>
          </div>
        </div>

        <aside class="sa-home-workflow-card">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                SA action dock
              </p>
              <h2 class="mt-2 text-xl font-semibold text-slate-950">
                {{ t("home.entryAppTitle", "Create and operate SA accounts") }}
              </h2>
            </div>
            <span
              class="inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium"
              :class="networkOnline ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'"
            >
              <span class="h-1.5 w-1.5 rounded-full" :class="networkOnline ? 'bg-emerald-600' : 'bg-amber-600'"></span>
              {{ networkOnline ? t("home.networkOnline", "Online") : loadingStatus || t("home.networkOffline", "Offline") }}
            </span>
          </div>

          <router-link to="/native" class="btn-primary mt-5 w-full">
            {{ t("home.entryNativeAction", "Open Native Accounts") }}
          </router-link>

          <details class="sa-home-reference mt-5">
            <summary class="cursor-pointer text-sm font-semibold text-slate-950">
              Deployment reference
            </summary>
            <dl class="mt-4 grid gap-3">
              <div
                v-for="item in statusCards"
                :key="item.label"
                class="rounded-xl border border-slate-200 bg-white px-4 py-3"
              >
                <dt class="text-xs font-medium text-slate-500">{{ item.label }}</dt>
                <dd class="mt-1 truncate text-sm font-semibold text-slate-950" :title="item.title">
                  {{ item.value }}
                </dd>
              </div>
            </dl>
          </details>
        </aside>
      </div>
    </section>

    <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <!-- paymasterValidation buildTransactionExplorerUrl -->
      <PaymasterValidationBanner
        :explorer-base-url="RUNTIME_CONFIG.explorerBaseUrl"
        i18n-key-prefix="home"
      />

      <section class="sr-only">
        Programmable Accounts for Neo N3. Open App Workspace. Browse Address Market.
        Paymaster Readiness. Open Validation Ledger. Open Explorer Tx.
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from "vue";
import { useI18n } from "@/i18n";
import { formatHash as formatHashUtil } from "@/utils/hex.js";
import PaymasterValidationBanner from "@/components/common/PaymasterValidationBanner.vue";
import {
  fetchNetworkStatus,
  fetchNetworkSummary,
} from "@/services/n3indexService.js";
import {
  resolveRuntimeNetwork,
  RUNTIME_CONFIG,
} from "@/config/runtimeConfig.js";

const { t } = useI18n();
const runtimeNetwork = resolveRuntimeNetwork();
const networkSummary = ref(null);
const networkStatus = ref(null);
const loadingStatus = ref(t("home.loadingNetworkStatus", "Loading network status..."));

const networkOnline = computed(
  () => !!(networkSummary.value || networkStatus.value),
);

const networkName = computed(() =>
  runtimeNetwork === "mainnet"
    ? t("nav.networkMainnet", "Neo N3 Mainnet")
    : t("nav.networkTestnet", "Neo N3 Testnet"),
);

const accountHash = computed(() => formatHash(RUNTIME_CONFIG.smartAccountHash));
const marketHash = computed(() => formatHash(RUNTIME_CONFIG.addressMarketHash));

const statusCards = computed(() => [
  {
    label: t("console.statNetwork", "Network"),
    value: networkName.value,
    title: networkName.value,
  },
  {
    label: t("console.statContract", "Contract"),
    value: accountHash.value,
    title: RUNTIME_CONFIG.smartAccountHash || "",
  },
  {
    label: t("console.serviceMarketTitle", "Address Market"),
    value: marketHash.value,
    title: RUNTIME_CONFIG.addressMarketHash || "",
  },
]);

const primarySteps = computed(() => [
  {
    index: "01",
    title: t("console.serviceWorkspaceTitle", "Native Accounts"),
    body: t(
      "native.workspaceLead",
      "Create and operate v4 native accounts on a pinned core",
    ),
    to: "/native",
  },
  {
    index: "02",
    title: t("console.serviceIdentityTitle", "Identity & DID"),
    body: t(
      "console.serviceIdentityBody",
      "Manage Web3Auth, NeoDID, and social recovery for your accounts",
    ),
    to: "/identity",
  },
  {
    index: "03",
    title: t("console.servicePluginsTitle", "Plugins & Hooks"),
    body: t(
      "console.servicePluginsBody",
      "Configure validators and hooks for access control and policies",
    ),
    to: { path: "/docs", query: { doc: "pluginGuide" } },
  },
]);

onMounted(() => {
  loadNetworkStatus();
});

async function loadNetworkStatus() {
  loadingStatus.value = t(
    "home.connectingToN3Index",
    "Connecting to N3Index...",
  );
  try {
    const [summary, status] = await Promise.all([
      fetchNetworkSummary({ network: runtimeNetwork }),
      fetchNetworkStatus({ network: runtimeNetwork }),
    ]);
    networkSummary.value = summary?.data || null;
    networkStatus.value = status?.data || null;
    loadingStatus.value = null;
  } catch (_error) {
    if (import.meta.env.DEV)
      console.error("Home: N3Index status fetch failed:", _error?.message);
    networkSummary.value = null;
    networkStatus.value = null;
    loadingStatus.value = t("home.networkOffline", "Offline");
  }
}

function formatHash(value = "") {
  return formatHashUtil(value, {
    notSetLabel: "--",
    separator: "...",
    shortCircuitLength: null,
  });
}
</script>

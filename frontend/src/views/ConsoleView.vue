<template>
  <div class="min-h-screen bg-sa-dark text-slate-950">
    <section class="border-b border-slate-200 bg-white">
      <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p class="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
              Neo Smart Account
            </p>
            <h1 class="mt-2 text-3xl font-semibold text-slate-950">
              {{ t("console.title", "Console") }}
            </h1>
            <p class="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              {{
                t(
                  "console.subtitle",
                  "Manage your smart accounts and smart wallet operations",
                )
              }}
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <span
              class="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold"
              :class="networkOnline ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : statusLoadFailed ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-slate-200 bg-slate-50 text-slate-600'"
            >
              <span class="h-2 w-2 rounded-full" :class="networkOnline ? 'bg-emerald-500' : statusLoadFailed ? 'bg-rose-500' : 'bg-slate-400'"></span>
              {{ networkLabel }}
            </span>
            <span
              v-if="isConnected"
              class="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs font-semibold text-slate-700"
            >
              <span class="h-2 w-2 rounded-full bg-emerald-500"></span>
              {{ truncatedAddress }}
            </span>
            <button
              v-else
              type="button"
              @click="connectWallet"
              :disabled="isWalletConnecting"
              class="btn-primary"
            >
              {{
                isWalletConnecting
                  ? t("console.connecting", "Connecting...")
                  : t("console.connectWallet", "Connect Wallet")
              }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <div class="mx-auto grid max-w-7xl gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[260px_1fr_320px] lg:px-8">
      <aside class="space-y-3">
        <div class="rounded-[20px] border border-slate-200 bg-white p-5 shadow-sm">
          <p class="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            {{ t("console.gettingStartedTitle", "Getting Started") }}
          </p>
          <ol class="mt-4 space-y-3">
            <li
              v-for="step in onboardingSteps"
              :key="step.title"
              class="flex gap-3"
            >
              <span class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-950 text-xs font-semibold text-white">
                {{ step.index }}
              </span>
              <span>
                <span class="block text-sm font-semibold text-slate-950">{{ step.title }}</span>
                <span class="mt-0.5 block text-xs leading-5 text-slate-500">{{ step.body }}</span>
              </span>
            </li>
          </ol>
        </div>

        <nav class="rounded-[20px] border border-slate-200 bg-white p-2 shadow-sm" aria-label="Console workflows">
          <router-link
            v-for="item in workflowNav"
            :key="item.label"
            :to="item.to"
            class="flex items-center justify-between rounded-lg px-3 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-950"
          >
            {{ item.label }}
            <span class="text-slate-400">→</span>
          </router-link>
        </nav>
      </aside>

      <section class="space-y-5">
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div
            v-for="stat in stats"
            :key="stat.label"
            class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <p class="text-xs font-medium text-slate-500">{{ stat.label }}</p>
            <p class="mt-2 truncate text-lg font-semibold text-slate-950" :title="stat.title">
              {{ stat.value }}
            </p>
            <p class="mt-1 text-xs text-slate-500">{{ stat.caption }}</p>
          </div>
        </div>

        <div class="rounded-[20px] border border-slate-200 bg-white p-5 shadow-sm">
          <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p class="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                {{ t("console.quickActionsHeading", "Quick Actions") }}
              </p>
              <h2 class="mt-2 text-2xl font-semibold text-slate-950">
                {{ t("console.serviceWorkspaceTitle", "Native Accounts") }}
              </h2>
              <p class="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                {{
                  t(
                    "console.serviceWorkspaceBody",
                    "Create accounts, build transactions, collect signatures, and broadcast operations",
                  )
                }}
              </p>
            </div>
            <router-link to="/native" class="btn-primary shrink-0">
              {{ t("console.quickCreateAccount", "Create Account") }}
            </router-link>
          </div>

          <div class="mt-5 grid gap-3 md:grid-cols-3">
            <router-link
              v-for="action in primaryActions"
              :key="action.title"
              :to="action.to"
              class="rounded-lg border border-slate-200 bg-slate-50 p-4 transition hover:border-slate-300 hover:bg-white hover:shadow-sm"
            >
              <p class="text-sm font-semibold text-slate-950">{{ action.title }}</p>
              <p class="mt-2 text-xs leading-5 text-slate-600">{{ action.body }}</p>
            </router-link>
          </div>
        </div>

        <div>
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-sm font-semibold uppercase tracking-[0.14em] text-slate-500">
              {{ t("console.servicesHeading", "Services") }}
            </h2>
            <router-link to="/docs" class="text-sm font-semibold text-slate-500 hover:text-slate-950">
              {{ t("console.viewDocs", "Documentation") }} →
            </router-link>
          </div>
          <div class="grid gap-3 md:grid-cols-2">
            <component
              :is="service.external ? 'a' : 'router-link'"
              v-for="service in services"
              :key="service.title"
              v-bind="serviceBind(service)"
              class="group rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow-md"
            >
              <div class="flex items-start justify-between gap-4">
                <div>
                  <p class="text-sm font-semibold text-slate-950">{{ service.title }}</p>
                  <p class="mt-2 text-xs leading-5 text-slate-600">{{ service.body }}</p>
                </div>
                <span class="text-slate-400 transition group-hover:text-slate-950">→</span>
              </div>
            </component>
          </div>
        </div>
      </section>

      <aside class="space-y-5">
        <div class="rounded-[20px] border border-slate-200 bg-white p-5 shadow-sm">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-semibold text-slate-950">
              {{ t("console.recentActivityHeading", "Recent Activity") }}
            </h2>
            <button
              v-if="statusLoadFailed"
              type="button"
              @click="retryNetworkStatus"
              class="text-xs font-semibold text-slate-500 hover:text-slate-950"
            >
              {{ t("console.retry", "Retry") }}
            </button>
          </div>
          <div class="mt-4 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-5 text-center">
            <p class="text-sm font-medium text-slate-700">
              {{
                isConnected
                  ? t("console.activityEmpty", "No recent activity")
                  : t("console.activityConnectPrompt", "Connect your wallet to see recent activity")
              }}
            </p>
            <p class="mt-2 text-xs leading-5 text-slate-500">
              {{ activityHint }}
            </p>
          </div>
        </div>

        <div class="rounded-xl border border-slate-200 bg-white p-5 text-slate-950 shadow-sm">
          <p class="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Runtime configuration
          </p>
          <dl class="mt-4 space-y-3 text-sm">
            <div>
              <dt class="text-xs text-slate-500">{{ t("console.statMasterContract", "Master contract") }}</dt>
              <dd class="mt-1 break-all font-mono text-xs text-slate-950">{{ RUNTIME_CONFIG.smartAccountHash || "--" }}</dd>
            </div>
            <div>
              <dt class="text-xs text-slate-500">Paymaster</dt>
              <dd class="mt-1 break-all font-mono text-xs text-slate-950">{{ RUNTIME_CONFIG.paymasterHash || "--" }}</dd>
            </div>
            <div>
              <dt class="text-xs text-slate-500">Domain</dt>
              <dd class="mt-1 break-all text-xs text-slate-950">{{ RUNTIME_CONFIG.smartAccountDomain || "--" }}</dd>
            </div>
          </dl>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from "vue";
import { useI18n } from "@/i18n";
import { formatHash as formatHashUtil } from "@/utils/hex.js";
import { useWalletConnection } from "@/composables/useWalletConnection";
import { resolveRuntimeNetwork, RUNTIME_CONFIG } from "@/config/runtimeConfig";
import {
  fetchNetworkStatus,
  fetchNetworkSummary,
} from "@/services/n3indexService.js";

const { t } = useI18n();
const {
  isConnected,
  truncatedAddress,
  connect: rawConnect,
  isConnecting: isWalletConnecting,
} = useWalletConnection();

const runtimeNetwork = resolveRuntimeNetwork();
const networkSummary = ref(null);
const networkStatus = ref(null);
const statusLoadFailed = ref(false);
const loadingStatus = ref("Loading...");

const networkName = computed(() =>
  runtimeNetwork === "mainnet" ? "Mainnet" : "Testnet",
);
const networkLabel = computed(() =>
  runtimeNetwork === "mainnet"
    ? t("nav.networkMainnet", "Neo N3 Mainnet")
    : t("nav.networkTestnet", "Neo N3 Testnet"),
);
const networkOnline = computed(
  () => !!(networkSummary.value || networkStatus.value),
);
const blockHeight = computed(() => {
  if (networkSummary.value?.chain_tip_block)
    return String(networkSummary.value.chain_tip_block);
  return "--";
});

const contractHashShort = computed(() =>
  formatHash(RUNTIME_CONFIG.smartAccountHash),
);
const explorerUrl = computed(() =>
  runtimeNetwork === "mainnet"
    ? "https://explorer.onegate.space"
    : "https://testnet.explorer.onegate.space",
);

const stats = computed(() => [
  {
    label: t("console.statNetwork", "Network"),
    value: networkName.value,
    caption: networkOnline.value
      ? t("console.networkOnline", "Online")
      : statusLoadFailed.value
        ? t("console.networkOffline", "Offline")
        : t("console.networkChecking", "Checking..."),
    title: networkName.value,
  },
  {
    label: t("console.statBlockHeight", "Block Height"),
    value: blockHeight.value,
    caption: t("console.statChainTip", "Chain tip"),
    title: blockHeight.value,
  },
  {
    label: t("console.statWallet", "Wallet"),
    value: isConnected.value ? t("console.statConnected", "Connected") : t("console.statDisconnected", "Not connected"),
    caption: isConnected.value ? truncatedAddress.value : t("console.connectWallet", "Connect Wallet"),
    title: isConnected.value ? truncatedAddress.value : "",
  },
  {
    label: t("console.statContract", "Contract"),
    value: contractHashShort.value,
    caption: t("console.statMasterContract", "Master contract"),
    title: RUNTIME_CONFIG.smartAccountHash || "",
  },
]);

const onboardingSteps = computed(() => [
  {
    index: "1",
    title: t("console.step1Title", "Connect Wallet"),
    body: t("console.step1Body", "Link your Neo N3 wallet to get started"),
  },
  {
    index: "2",
    title: t("console.step2Title", "Create Account"),
    body: t("console.step2Body", "Deploy a deterministic smart wallet on Neo N3"),
  },
  {
    index: "3",
    title: t("console.step3Title", "Add Plugins"),
    body: t(
      "console.step3Body",
      "Install verifiers and hooks for access control and policies",
    ),
  },
]);

const workflowNav = computed(() => [
  { label: t("console.serviceWorkspaceTitle", "Native Accounts"), to: "/native" },
  { label: t("console.serviceIdentityTitle", "Identity & DID"), to: "/identity" },
  {
    label: t("console.servicePluginsTitle", "Plugins & Hooks"),
    to: { path: "/docs", query: { doc: "pluginGuide" } },
  },
  { label: t("console.serviceDocsTitle", "Documentation"), to: "/docs" },
]);

const primaryActions = computed(() => [
  {
    title: t("console.quickCreateAccount", "Create Account"),
    body: "Derive, register, and verify a deterministic v4 account.",
    to: "/native",
  },
  {
    title: t("console.quickManageGovernance", "Manage Governance"),
    body: "Update verifier, hook, backup owner, and recovery settings.",
    to: "/native",
  },
  {
    title: "Relay & Receipts",
    body: "Run preflight, submit through relay, and review receipts.",
    to: "/native",
  },
]);

const services = computed(() => [
  {
    title: t("console.serviceIdentityTitle", "Identity & DID"),
    body: t(
      "console.serviceIdentityBody",
      "Manage Web3Auth, NeoDID, and social recovery for your accounts",
    ),
    to: "/identity",
  },
  {
    title: t("console.servicePluginsTitle", "Plugins & Hooks"),
    body: t(
      "console.servicePluginsBody",
      "10 verifiers and 6 hooks available — configure access control and policies",
    ),
    to: { path: "/docs", query: { doc: "pluginGuide" } },
  },
  {
    title: t("console.serviceDocsTitle", "Documentation"),
    body: t("console.serviceDocsBody", "Guides, API reference, and integration examples"),
    to: "/docs",
  },
  {
    title: t("console.serviceExplorerTitle", "Block Explorer"),
    body: t(
      "console.serviceExplorerBody",
      "View transactions, accounts, and contract state on Neo N3",
    ),
    href: explorerUrl.value,
    external: true,
  },
]);

const activityHint = computed(() =>
  isConnected.value
    ? "New signed drafts, relay submissions, and receipts will appear here."
    : "Connection is required before the console can show account-specific activity.",
);

onMounted(async () => {
  await loadNetworkStatus();
});

async function loadNetworkStatus() {
  loadingStatus.value = t(
    "console.networkConnecting",
    "Connecting to N3Index...",
  );
  statusLoadFailed.value = false;
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
      console.error("Console: N3Index status fetch failed:", _error?.message);
    networkSummary.value = null;
    networkStatus.value = null;
    loadingStatus.value = null;
    statusLoadFailed.value = true;
  }
}

async function retryNetworkStatus() {
  await loadNetworkStatus();
}

async function connectWallet() {
  await rawConnect();
}

function serviceBind(service) {
  if (service.external) {
    return {
      href: service.href,
      target: "_blank",
      rel: "noopener noreferrer",
    };
  }
  return { to: service.to };
}

function formatHash(value = "") {
  return formatHashUtil(value, {
    notSetLabel: "--",
    separator: "...",
    shortCircuitLength: null,
  });
}
</script>

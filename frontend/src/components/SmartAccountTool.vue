<template>
  <div class="min-h-screen bg-aa-dark text-slate-950">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 md:py-8">
    <div class="mb-6 border-b border-slate-200">
      <div
        class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6"
      >
        <div>
          <div
            class="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-semibold mb-4"
          >
            {{ t("studio.powered", "Neo N3 Powered") }}
          </div>
          <h1
            class="text-2xl md:text-3xl font-semibold text-slate-950 leading-tight mb-2"
          >
            {{ t("studio.title", "Abstract Account Workspace") }}
          </h1>
          <p class="text-sm md:text-base text-slate-600 max-w-3xl leading-relaxed">
            {{
              t(
                "studio.subtitle",
                "Create programmable wallets with built-in recovery, plugin permissions, and gasless transactions.",
              )
            }}
          </p>
        </div>
      </div>

      <nav
        class="-mx-4 flex w-[calc(100%+2rem)] gap-5 overflow-x-auto overscroll-x-contain px-4 pb-1 sm:mx-0 sm:w-full sm:gap-6 sm:px-0"
        role="tablist"
        :aria-label="t('studio.tabsAriaLabel', 'Tabs')"
      >
        <button
          v-for="(tab, tabIndex) in studio.tabs"
          :key="tab.key"
          :ref="
            (el) => {
              if (el) tabRefs[tabIndex] = el;
            }
          "
          @click="selectTab(tab.key)"
          @keydown="handleTabKeydown($event, tabIndex)"
          :tabindex="
            studio.walletConnected.value && studio.activePanel.value === tab.key
              ? 0
              : -1
          "
          :disabled="!studio.walletConnected.value"
          :aria-disabled="!studio.walletConnected.value"
          :role="'tab'"
          :aria-selected="studio.activePanel.value === tab.key"
          :id="'tab-' + tab.key"
          :aria-controls="'panel-' + tab.key"
          class="relative shrink-0 pb-3 text-sm font-medium transition-colors whitespace-nowrap"
          :class="[
            studio.activePanel.value === tab.key
              ? 'text-slate-950 border-b-2 border-emerald-500'
              : 'text-slate-500 hover:text-slate-950 border-b-2 border-transparent',
            !studio.walletConnected.value
              ? 'opacity-50 cursor-not-allowed pointer-events-none'
              : '',
          ]"
        >
          <div class="flex items-center gap-2">
            <component :is="getTabIcon(tab.key)" class="w-4 h-4" />
            {{ tabLabel(tab) }}
          </div>
        </button>
      </nav>
    </div>

    <!-- Tab description line -->
    <transition name="desc-fade" mode="out-in">
      <p :key="studio.activePanel.value" class="text-sm text-slate-600 mb-6">
        {{ activeTabDescription }}
      </p>
    </transition>

    <!-- Guided onboarding state when wallet not connected -->
    <div
      v-if="!studio.walletConnected.value"
      class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]"
    >
      <div class="w-full rounded-xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
        <div class="mb-8">
          <div
            class="w-12 h-12 rounded-md border border-emerald-200 bg-emerald-50 flex items-center justify-center mb-6"
          >
            <svg
              aria-hidden="true"
              class="w-6 h-6 text-emerald-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.5"
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              ></path>
            </svg>
          </div>
          <h2 class="text-xl font-semibold text-slate-950 mb-2">
            {{
              t("studio.onboardingTitle", "Connect your wallet to get started")
            }}
          </h2>
          <p class="text-slate-600 text-sm leading-relaxed mb-8">
            {{
              t(
                "studio.onboardingBody",
                "The Abstract Account workspace lets you create, configure, and operate programmable smart-contract accounts on Neo N3.",
              )
            }}
          </p>
          <div
            v-if="routeAccountId"
            class="mb-8 rounded-lg border border-emerald-200 bg-emerald-50 p-4"
          >
            <p class="text-xs font-bold uppercase text-emerald-700">
              {{ t("studio.pendingAccountId", "AccountId ready to load") }}
            </p>
            <code class="mt-1 block break-all font-mono text-sm text-slate-950">
              0x{{ routeAccountId }}
            </code>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                class="btn-secondary btn-sm"
                @click="
                  copyText(`0x${routeAccountId}`);
                  markCopied('routeAccountId');
                "
              >
                {{
                  copiedKey === "routeAccountId"
                    ? t("studio.copied", "Copied")
                    : t("studio.copyAccountId", "Copy AccountId")
                }}
              </button>
              <span class="text-xs text-slate-600">
                {{
                  t(
                    "studio.pendingAccountIdHint",
                    "Connect your wallet; Operations will prefill this accountId.",
                  )
                }}
              </span>
            </div>
          </div>
        </div>

        <!-- AA Pipeline Steps -->
        <div
          class="flex flex-wrap items-center gap-2 mb-8 stagger-children"
        >
          <template v-for="(step, i) in pipelineSteps" :key="i">
            <div
              class="flex items-center gap-2 px-3 py-1.5 rounded-md border border-slate-200 bg-slate-50 text-slate-800 text-sm shrink-0"
            >
              <div class="text-slate-500 font-mono text-xs">{{ i + 1 }}</div>
              <span>{{ step }}</span>
            </div>
            <svg
              v-if="i < pipelineSteps.length - 1"
              aria-hidden="true"
              class="w-4 h-4 text-slate-300 shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M9 5l7 7-7 7"
              ></path>
            </svg>
          </template>
        </div>

        <!-- CTA -->
        <div class="mb-10">
          <button
            @click="connectWallet"
            :class="{ 'btn-loading': isWalletConnecting }"
            :disabled="isWalletConnecting"
            class="btn-primary"
          >
            {{
              isWalletConnecting
                ? t("studio.connecting", "Connecting…")
                : t("studio.onboardingAction", "Connect Wallet")
            }}
          </button>
        </div>

        <!-- What happens expandable -->
        <div
          class="rounded-md border border-slate-200 bg-white overflow-hidden"
        >
          <button
            @click="showWhatHappens = !showWhatHappens"
            :aria-expanded="showWhatHappens"
            aria-controls="what-happens-content"
            class="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-50 transition-colors duration-200"
          >
            <span class="text-sm font-semibold text-slate-900">{{
              t("studio.whatHappens", "What happens when I connect?")
            }}</span>
            <svg
              aria-hidden="true"
              class="w-4 h-4 text-slate-500 transition-transform duration-200"
              :class="showWhatHappens ? 'rotate-180' : ''"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M19 9l-7 7-7-7"
              ></path>
            </svg>
          </button>
          <div
            id="what-happens-content"
            v-show="showWhatHappens"
            class="px-4 pb-4 border-t border-slate-200"
          >
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4">
              <div
                v-for="(hint, i) in onboardingHints"
                :key="i"
                class="p-3 rounded-md border border-slate-200 bg-slate-50"
              >
                <div class="mb-2">
                  <svg
                    aria-hidden="true"
                    class="w-4 h-4 text-emerald-700"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    v-html="hint.icon"
                  ></svg>
                </div>
                <p class="text-sm font-semibold text-slate-950">
                  {{ hint.label }}
                </p>
                <p class="text-xs text-slate-500 mt-1">{{ hint.desc }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <aside>
        <details class="aa-focus-reference lg:sticky lg:top-24">
          <summary>
            <span>{{ t("studio.readinessLabel", "Workspace readiness") }}</span>
            <strong>Deployment reference</strong>
          </summary>
          <div class="mt-5 space-y-4">
        <section class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div class="mb-4 flex items-start justify-between gap-4">
            <div>
              <p class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                {{ t("studio.readinessLabel", "Workspace readiness") }}
              </p>
              <h2 class="mt-1 text-lg font-semibold text-slate-950">
                {{ t("studio.readinessTitle", "Runtime configuration detected") }}
              </h2>
            </div>
            <span
              class="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700"
            >
              {{ networkLabel }}
            </span>
          </div>

          <dl class="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <div
              v-for="item in readinessItems"
              :key="item.label"
              class="rounded-lg border border-slate-200 bg-slate-50 p-3"
            >
              <dt class="text-xs font-semibold text-slate-500">{{ item.label }}</dt>
              <dd class="mt-1 break-all font-mono text-sm font-semibold text-slate-950">
                {{ item.value }}
              </dd>
            </div>
          </dl>
        </section>

        <section class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            {{ t("studio.validationCoverageLabel", "Validation coverage") }}
          </p>
          <div class="mt-4 space-y-3">
            <div
              v-for="item in validationCoverage"
              :key="item.title"
              class="rounded-lg border border-slate-200 bg-slate-50 p-3"
            >
              <div class="flex items-start justify-between gap-3">
                <h3 class="text-sm font-semibold text-slate-950">{{ item.title }}</h3>
                <span
                  class="shrink-0 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs font-semibold text-slate-600"
                >
                  {{ item.state }}
                </span>
              </div>
              <p class="mt-2 text-xs leading-5 text-slate-600">{{ item.detail }}</p>
            </div>
          </div>
        </section>
          </div>
        </details>
      </aside>
    </div>

    <!-- Normal workspace when wallet connected -->
    <template v-else>
      <div
        v-if="studio.activePanel.value === 'operations'"
        id="panel-operations"
        role="tabpanel"
        aria-labelledby="tab-operations"
        class="w-full"
      >
        <transition name="fade-slide" mode="out-in">
          <HomeOperationsWorkspace />
        </transition>
      </div>

      <div v-else class="lg:grid lg:grid-cols-12 lg:gap-8">
        <main class="lg:col-span-8 xl:col-span-9 space-y-6 relative">
          <transition name="fade-slide" mode="out-in">
            <CreateAccountPanel
              v-if="studio.activePanel.value === 'create'"
              :id="'panel-create'"
              role="tabpanel"
              :aria-labelledby="'tab-create'"
            />
            <ManageGovernancePanel
              v-else-if="studio.activePanel.value === 'manage'"
              :id="'panel-manage'"
              role="tabpanel"
              :aria-labelledby="'tab-manage'"
            />
            <PermissionsLimitsPanel
              v-else-if="studio.activePanel.value === 'permissions'"
              :id="'panel-permissions'"
              role="tabpanel"
              :aria-labelledby="'tab-permissions'"
            />
            <ContractSourcePanel
              v-else-if="studio.activePanel.value === 'source'"
              :id="'panel-source'"
              role="tabpanel"
              :aria-labelledby="'tab-source'"
            />
          </transition>
        </main>

        <StudioSidebar />
      </div>
    </template>
    </div>
  </div>
</template>

<script setup>
import { computed, defineAsyncComponent, provide, h, ref } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "@/i18n";
import { useStudioController } from "@/features/studio/useStudioController";
import { useWalletConnection } from "@/composables/useWalletConnection";
import { useClipboard } from "@/composables/useClipboard";
import { RUNTIME_CONFIG } from "@/config/runtimeConfig";

const { t } = useI18n();
const route = useRoute();
const { copiedKey, markCopied, copyText } = useClipboard();
const PanelSkeleton = { template: '<div class="skeleton h-64 w-full"></div>' };
const panelErrorMsg = t(
  "studio.panelLoadError",
  "Failed to load panel. Please refresh.",
);
const PanelError = {
  template: `<div class="card p-6 text-center"><p class="text-aa-error text-sm font-medium">${panelErrorMsg}</p></div>`,
};
const asyncErr = {
  loadingComponent: PanelSkeleton,
  errorComponent: PanelError,
  timeout: 8000,
};
const HomeOperationsWorkspace = defineAsyncComponent({
  loader: () =>
    import("@/features/operations/components/HomeOperationsWorkspace.vue"),
  ...asyncErr,
});
const CreateAccountPanel = defineAsyncComponent({
  loader: () => import("@/features/studio/components/CreateAccountPanel.vue"),
  ...asyncErr,
});
const ManageGovernancePanel = defineAsyncComponent({
  loader: () =>
    import("@/features/studio/components/ManageGovernancePanel.vue"),
  ...asyncErr,
});
const PermissionsLimitsPanel = defineAsyncComponent({
  loader: () =>
    import("@/features/studio/components/PermissionsLimitsPanel.vue"),
  ...asyncErr,
});
const ContractSourcePanel = defineAsyncComponent({
  loader: () => import("@/features/studio/components/ContractSourcePanel.vue"),
  ...asyncErr,
});
const StudioSidebar = defineAsyncComponent({
  loader: () => import("@/features/studio/components/StudioSidebar.vue"),
  ...asyncErr,
});

const studio = useStudioController();
const { connect: connectWallet, isConnecting: isWalletConnecting } =
  useWalletConnection();

const showWhatHappens = ref(false);
const tabRefs = {};

function selectTab(key) {
  if (!studio.walletConnected.value) return;
  studio.activePanel.value = key;
}

function handleTabKeydown(event, currentIndex) {
  if (!studio.walletConnected.value) return;
  const len = studio.tabs.length;
  let nextIndex = -1;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    nextIndex = (currentIndex + 1) % len;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    nextIndex = (currentIndex - 1 + len) % len;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = len - 1;
  }
  if (nextIndex >= 0) {
    event.preventDefault();
    const key = studio.tabs[nextIndex].key;
    studio.activePanel.value = key;
    tabRefs[nextIndex]?.focus();
  }
}

const pipelineSteps = [
  t("studio.pipelineConnect", "Connect"),
  t("studio.pipelineCreate", "Create AA"),
  t("studio.pipelineConfigure", "Configure"),
  t("studio.pipelineOperate", "Operate"),
];

const onboardingHints = [
  {
    label: t("studio.onboardingHint1", "Create AA accounts"),
    desc: t("studio.onboardingHint1Desc", "Deploy programmable wallets"),
    icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>',
  },
  {
    label: t("studio.onboardingHint2", "Manage governance"),
    desc: t("studio.onboardingHint2Desc", "Set verifiers and hooks"),
    icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path>',
  },
  {
    label: t("studio.onboardingHint3", "Set permissions"),
    desc: t("studio.onboardingHint3Desc", "Configure spending limits"),
    icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>',
  },
];

function formatHash(value) {
  const normalized = String(value || "").replace(/^0x/i, "");
  if (!normalized) return t("studio.unconfigured", "Unconfigured");
  if (normalized.length <= 14) return `0x${normalized}`;
  return `0x${normalized.slice(0, 6)}...${normalized.slice(-6)}`;
}

const networkLabel = computed(() =>
  RUNTIME_CONFIG.morpheusNetwork === "testnet"
    ? t("studio.testnet", "Testnet")
    : t("studio.mainnet", "Mainnet"),
);

const routeAccountId = computed(() => {
  const raw = String(route.query.accountId || route.query.accountIdHash || "")
    .trim()
    .replace(/^0x/i, "");
  return /^[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : "";
});

const readinessItems = computed(() => [
  {
    label: t("studio.readinessNetwork", "Network"),
    value: networkLabel.value,
  },
  {
    label: t("studio.readinessCore", "AA Core"),
    value: formatHash(RUNTIME_CONFIG.abstractAccountHash),
  },
  {
    label: t("studio.readinessPaymaster", "Paymaster"),
    value: formatHash(RUNTIME_CONFIG.paymasterHash),
  },
  {
    label: t("studio.readinessRelay", "Relay"),
    value: RUNTIME_CONFIG.relayEndpoint || t("studio.unconfigured", "Unconfigured"),
  },
]);

const validationCoverage = computed(() => [
  {
    title: t("studio.validationAccountDeployment", "Account deployment"),
    state: t("studio.validationRequiresWallet", "Wallet required"),
    detail: t(
      "studio.validationAccountDeploymentDetail",
      `AA core ${formatHash(RUNTIME_CONFIG.abstractAccountHash)}`,
    ),
  },
  {
    title: t("studio.validationPaymasterRelay", "Paymaster relay"),
    state: RUNTIME_CONFIG.paymasterHash
      ? t("studio.validationPreflightRequired", "Preflight required")
      : t("studio.unconfigured", "Unconfigured"),
    detail: t(
      "studio.validationPaymasterRelayDetail",
      `${formatHash(RUNTIME_CONFIG.paymasterHash)} via ${RUNTIME_CONFIG.relayEndpoint || "-"}; relay signer and Morpheus credentials are verified by Relay Preflight.`,
    ),
  },
  {
    title: t("studio.validationReceiptCheck", "Receipt verification"),
    state: t("studio.validationReady", "Ready"),
    detail: t(
      "studio.validationReceiptCheckDetail",
      `${networkLabel.value} explorer and local submission receipts`,
    ),
  },
]);

const activeTabDescription = computed(() => {
  const active = studio.tabs.find(
    (tab) => tab.key === studio.activePanel.value,
  );
  if (!active) return "";
  return t(`studio.tabs.desc.${active.key}`, active.description || "");
});

function tabLabel(tab = {}) {
  return t(`studio.tabs.${tab.key}`, tab.label || tab.key || "Tab");
}

function getTabIcon(key) {
  const icons = {
    operations: () =>
      h("svg", {
        fill: "none",
        stroke: "currentColor",
        viewBox: "0 0 24 24",
        "aria-hidden": "true",
        innerHTML:
          '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>',
      }),
    create: () =>
      h("svg", {
        fill: "none",
        stroke: "currentColor",
        viewBox: "0 0 24 24",
        "aria-hidden": "true",
        innerHTML:
          '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>',
      }),
    manage: () =>
      h("svg", {
        fill: "none",
        stroke: "currentColor",
        viewBox: "0 0 24 24",
        "aria-hidden": "true",
        innerHTML:
          '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path>',
      }),
    permissions: () =>
      h("svg", {
        fill: "none",
        stroke: "currentColor",
        viewBox: "0 0 24 24",
        "aria-hidden": "true",
        innerHTML:
          '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>',
      }),
    source: () =>
      h("svg", {
        fill: "none",
        stroke: "currentColor",
        viewBox: "0 0 24 24",
        "aria-hidden": "true",
        innerHTML:
          '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"></path>',
      }),
  };
  return icons[key] || icons.operations;
}

provide("studio", studio);
</script>

<style scoped>
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.fade-slide-enter-from {
  opacity: 0;
  transform: translateX(-15px);
}

.fade-slide-leave-to {
  opacity: 0;
  transform: translateX(15px);
}

.desc-fade-enter-active,
.desc-fade-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.desc-fade-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}

.desc-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>

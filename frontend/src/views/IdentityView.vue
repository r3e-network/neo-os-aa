<template>
  <div
    class="relative min-h-screen overflow-hidden bg-sa-dark font-sans text-sa-text"
  >
    <div
      class="absolute inset-x-0 top-0 z-0 h-72 border-b border-slate-200 bg-white"
    ></div>

    <div class="relative z-10 mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      <div
        class="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"
      >
        <div>
          <p class="mb-2 text-xs font-bold uppercase text-sa-info">
            {{ t("identity.pageEyebrow", "Identity Control Plane") }}
          </p>
          <h1 class="text-3xl font-extrabold text-slate-950 font-outfit md:text-4xl">
            {{ t("identity.pageTitle", "Web3Auth / NeoDID Workspace") }}
          </h1>
          <p
            class="mt-3 max-w-3xl text-sm leading-7 text-sa-muted md:text-base"
          >
            {{
              t(
                "identity.pageSubtitle",
                "Keep Web3 identity login, NeoDID binding, recovery, and private-session controls in one isolated workspace. The main SA workspace stays lighter and only links here when you need identity actions.",
              )
            }}
          </p>
        </div>
        <div class="flex flex-wrap gap-3">
          <router-link class="btn-secondary" :to="workspaceLink">
            {{ t("identity.openWorkspace", "Open SA Workspace") }}
          </router-link>
          <router-link class="btn-primary" to="/docs">
            {{ t("identity.readDocs", "Read Docs") }}
          </router-link>
        </div>
      </div>

      <details class="sa-focus-reference mb-6">
        <summary>
          <span>{{ t("identity.contextReference", "Connection reference") }}</span>
          <strong>{{ walletLabel }}</strong>
        </summary>
        <div class="sa-reference-grid">
          <div class="sa-reference-card">
            <p>{{ t("identity.connectedWallet", "Connected Neo Wallet") }}</p>
            <strong>{{ walletLabel }}</strong>
          </div>
          <div class="sa-reference-card">
            <p>{{ t("identity.boundAccount", "Bound Account Context") }}</p>
            <strong>{{ accountContextLabel }}</strong>
          </div>
          <div class="sa-reference-card">
            <p>{{ t("identity.saContract", "SA Contract") }}</p>
            <strong>{{
              saContractHash || t("identity.unconfigured", "unconfigured")
            }}</strong>
          </div>
        </div>
      </details>

      <DidIdentityPanel
        :sa-contract-hash="saContractHash"
        :account-address-script-hash="accountAddressScriptHash"
        :account-id-prefill="accountIdPrefill"
        :neo-wallet-address="neoWalletAddress"
        :recovery-new-owner-prefill="recoveryNewOwnerPrefill"
        :recovery-expiry-prefill="recoveryExpiryPrefill"
        :auto-preview-recovery="autoPreviewRecovery"
      />
    </div>
  </div>
</template>

<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "@/i18n";
import DidIdentityPanel from "@/features/operations/components/DidIdentityPanel.vue";
import {
  getSmartAccountHash,
  walletService,
} from "@/services/walletService.js";
import { getScriptHashFromAddress } from "@/utils/neo.js";

const route = useRoute();
const { t } = useI18n();

const saContractHash = getSmartAccountHash();
const accountIdPrefill = computed(() =>
  String(route.query.accountId || "").trim(),
);
const accountAddressScriptHash = computed(() => {
  const raw = String(route.query.account || "").trim();
  if (!raw) return "";
  if (/^[Nn]/.test(raw)) {
    try {
      return `0x${getScriptHashFromAddress(raw)}`;
    } catch {
      return raw;
    }
  }
  return raw;
});
const recoveryNewOwnerPrefill = computed(() =>
  String(route.query.recoveryNewOwner || "").trim(),
);
const recoveryExpiryPrefill = computed(() =>
  String(route.query.recoveryExpiryMinutes || "").trim(),
);
const autoPreviewRecovery = computed(() => {
  const raw = String(route.query.autoPreviewRecovery || "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
});
const neoWalletAddress = computed(() => walletService.address || "");
const walletLabel = computed(
  () =>
    neoWalletAddress.value || t("identity.walletNotConnected", "not connected"),
);
const accountContextLabel = computed(
  () =>
    accountAddressScriptHash.value ||
    accountIdPrefill.value ||
    t("identity.noAccountContext", "no account bound"),
);
const workspaceLink = computed(() =>
  accountAddressScriptHash.value
    ? { path: "/app", query: { account: accountAddressScriptHash.value } }
    : "/app",
);
</script>

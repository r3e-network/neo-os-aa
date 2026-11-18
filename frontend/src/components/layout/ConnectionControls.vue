<template>
  <div v-if="compact" class="flex items-center gap-1.5 shrink-0">
    <template v-if="didConnected">
      <span class="badge-blue text-[10px] px-2 py-1">
        <span
          class="w-1.5 h-1.5 mr-1 bg-sa-info rounded-full animate-pulse"
        ></span>
        {{ t("nav.didPrefix", "DID") }} {{ didShort }}
      </span>
      <router-link
        to="/identity"
        class="text-sa-muted hover:text-sa-text transition-colors duration-200 p-2.5"
        :aria-label="t('nav.openIdentity', 'Open Identity')"
      >
        <svg
          aria-hidden="true"
          class="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14m-6 4h6a2 2 0 002-2V8a2 2 0 00-2-2H9a2 2 0 00-2 2v8a2 2 0 002 2z"
          ></path>
        </svg>
      </router-link>
      <button
        @click="disconnectDid"
        class="text-sa-muted hover:text-sa-error-light transition-colors duration-200 p-2.5"
        :aria-label="t('nav.disconnectDid', 'Disconnect Web3Auth')"
      >
        <svg
          aria-hidden="true"
          class="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M6 18L18 6M6 6l12 12"
          ></path>
        </svg>
      </button>
    </template>
    <template v-if="isConnected">
      <span class="badge-orange text-[10px] px-2 py-1">
        <span
          class="w-1.5 h-1.5 mr-1 bg-sa-orange rounded-full animate-pulse"
        ></span>
        <span :title="truncatedAddress">{{ truncatedAddress }}</span>
      </span>
      <button
        @click="disconnect"
        class="text-sa-muted hover:text-sa-error-light transition-colors duration-200 p-2.5"
        :aria-label="t('nav.disconnect', 'Disconnect')"
      >
        <svg
          aria-hidden="true"
          class="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M6 18L18 6M6 6l12 12"
          ></path>
        </svg>
      </button>
    </template>
    <div v-else class="flex items-center gap-1.5 shrink-0">
      <router-link
        v-if="didAvailable && !didConnected"
        to="/identity"
        class="btn-secondary btn-xs font-bold"
        >{{ t("nav.identity", "Identity") }}</router-link
      >
      <button
        @click="connect"
        :class="{ 'btn-loading': isWalletConnecting }"
        :disabled="isWalletConnecting"
        class="btn-primary btn-xs font-bold"
      >
        {{
          isWalletConnecting
            ? t("nav.connecting", "…")
            : t("nav.connect", "Connect")
        }}
      </button>
    </div>
  </div>
  <div
    v-else-if="didConnected"
    class="flex items-center gap-3 bg-sa-panel border border-sa-border rounded px-3 py-1.5 shadow-sm"
  >
    <span class="badge-blue">
      <span
        class="w-1.5 h-1.5 mr-1 bg-sa-info rounded-full animate-pulse"
      ></span>
      {{ t("nav.didPrefix", "DID") }} {{ didShort }}
    </span>
    <router-link
      to="/identity"
      class="text-xs text-sa-muted hover:text-sa-text font-medium px-1 transition-colors duration-200"
      >{{ t("nav.openIdentity", "Open Identity") }}</router-link
    >
    <button
      @click="disconnectDid"
      class="text-xs text-sa-muted hover:text-sa-error-light font-medium px-1 transition-colors duration-200"
    >
      {{ t("nav.disconnectDid", "Disconnect Web3Auth") }}
    </button>
  </div>
  <div
    v-else-if="isConnected"
    class="flex items-center gap-3 bg-sa-panel border border-sa-border rounded px-3 py-1.5 shadow-sm"
  >
    <span class="badge-orange">
      <span
        class="w-1.5 h-1.5 mr-1 bg-sa-orange rounded-full animate-pulse"
      ></span>
      <span :title="truncatedAddress">{{ truncatedAddress }}</span>
    </span>
    <button
      @click="disconnect"
      class="text-xs text-sa-muted hover:text-sa-error-light font-medium px-1 transition-colors duration-200"
    >
      {{ t("nav.disconnect", "Disconnect") }}
    </button>
  </div>
  <div v-else class="animate-fade-in flex items-center gap-2">
    <router-link
      v-if="didAvailable && !didConnected"
      to="/identity"
      class="btn-secondary btn-xs font-bold"
      >{{ t("nav.openIdentity", "Open Identity") }}</router-link
    >
    <button
      @click="connect"
      :class="{ 'btn-loading': isWalletConnecting }"
      :disabled="isWalletConnecting"
      class="btn-primary btn-xs font-bold"
    >
      {{
        isWalletConnecting
          ? t("nav.connecting", "Connecting…")
          : t("nav.connect", "Connect")
      }}
    </button>
  </div>
</template>

<script setup>
import { computed, onMounted } from "vue";
import { useWalletConnection } from "@/composables/useWalletConnection";
import { RUNTIME_CONFIG } from "@/config/runtimeConfig";
import { useI18n } from "@/i18n";
import { useToast } from "vue-toastification";
import { translateError } from "@/config/errorCodes.js";
import {
  connectedDidProfile,
  hydrateConnectedDidProfileFromStorage,
} from "@/utils/did";

defineProps({
  compact: {
    type: Boolean,
    default: false,
  },
});

const {
  isConnected,
  truncatedAddress,
  connect: rawConnect,
  disconnect: rawDisconnect,
  isConnecting: isWalletConnecting,
} = useWalletConnection();
const { t } = useI18n();
const toast = useToast();

const didAvailable = computed(() =>
  Boolean(String(RUNTIME_CONFIG.web3AuthClientId || "").trim()),
);
const didConnected = computed(() => Boolean(connectedDidProfile.value?.did));
const didShort = computed(() => {
  const did = connectedDidProfile.value?.did || "";
  if (!did) return "";
  return did.length > 26 ? `${did.slice(0, 18)}...${did.slice(-6)}` : did;
});

onMounted(() => {
  hydrateConnectedDidProfileFromStorage();
});

async function connect() {
  try {
    await rawConnect();
  } catch (error) {
    toast.error(
      translateError(error?.message, t) ||
        t(
          "nav.connectWalletFailed",
          "Wallet connection failed. Please try again.",
        ),
    );
  }
}

async function disconnect() {
  try {
    await rawDisconnect();
  } catch (error) {
    toast.error(
      translateError(error?.message, t) || t("nav.disconnect", "Disconnect"),
    );
  }
}

async function disconnectDid() {
  try {
    const { didService } = await import("@/services/didService");
    await didService.disconnect();
  } catch (error) {
    toast.error(
      translateError(error?.message, t) ||
        t(
          "nav.connectDidFailed",
          "Web3Auth connection failed. Please try again.",
        ),
    );
  }
}
</script>

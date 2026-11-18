<template>
  <div
    class="mb-8 grid gap-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5"
  >
    <div
      class="rounded-2xl border p-5 shadow-inner backdrop-blur-md"
      :class="statusCardClass(isDidConnected)"
    >
      <p
        class="text-xs uppercase font-bold mb-1"
        :class="isDidConnected ? 'text-sa-success' : 'text-sa-muted'"
      >
        {{ t("operations.didCardLabel", "Web3Auth") }}
      </p>
      <p
        class="text-sm font-semibold truncate"
        :class="isDidConnected ? 'text-sa-success-light' : 'text-sa-text'"
      >
        {{ didLabel }}
      </p>
    </div>
    <div
      class="rounded-2xl border p-5 shadow-inner backdrop-blur-md"
      :class="statusCardClass(isNeoConnected)"
    >
      <p
        class="text-xs uppercase font-bold mb-1"
        :class="isNeoConnected ? 'text-sa-success' : 'text-sa-muted'"
      >
        {{ t("operations.neoWallet", "Neo Wallet") }}
      </p>
      <p
        class="text-sm font-semibold truncate"
        :class="isNeoConnected ? 'text-sa-success-light' : 'text-sa-text'"
      >
        {{ neoWalletLabel }}
      </p>
    </div>
    <div
      class="rounded-2xl border p-5 shadow-inner backdrop-blur-md"
      :class="statusCardClass(evmAddress)"
    >
      <p
        class="text-xs uppercase font-bold mb-1"
        :class="evmAddress ? 'text-sa-success' : 'text-sa-muted'"
      >
        {{ t("operations.evmWallet", "EVM Wallet") }}
      </p>
      <p
        class="text-sm font-semibold truncate"
        :class="evmAddress ? 'text-sa-success-light' : 'text-sa-text'"
      >
        {{ evmWalletLabel }}
      </p>
    </div>
    <div
      class="rounded-2xl border border-sa-border bg-sa-panel/40 p-5 shadow-inner backdrop-blur-md"
    >
      <p class="text-xs uppercase text-sa-muted font-bold mb-1">
        {{ t("operations.signaturesCardLabel", "Signatures") }}
      </p>
      <div class="flex items-center gap-2 mt-1">
        <div
          class="w-full bg-sa-dark rounded-full h-1.5"
          role="progressbar"
          :aria-valuenow="signatureCount"
          aria-valuemin="0"
          :aria-valuemax="requiredSignerCount || 0"
          :aria-label="
            t('operations.signaturesProgress', 'Signature progress')
          "
        >
          <div
            class="bg-neo-500 h-1.5 rounded-full"
            :style="{
              width:
                (requiredSignerCount
                  ? Math.min(
                      100,
                      (signatureCount / requiredSignerCount) * 100,
                    )
                  : 0) + '%',
            }"
          ></div>
        </div>
        <p class="text-sm text-sa-text font-semibold tabular-nums">
          {{ signatureCount }} /
          {{ requiredSignerCount || 0 }}
        </p>
      </div>
    </div>
    <div
      class="rounded-2xl border p-5 shadow-inner backdrop-blur-md"
      :class="statusCardClass(collaborationEnabled, 'neo')"
    >
      <p
        class="text-xs uppercase font-bold mb-1"
        :class="collaborationEnabled ? 'text-neo-400' : 'text-sa-muted'"
      >
        {{ t("operations.collaborationCardLabel", "Collaboration") }}
      </p>
      <div class="flex items-center mt-1">
        <span
          class="w-2 h-2 rounded-full mr-2"
          :class="
            collaborationEnabled
              ? 'bg-neo-500 animate-pulse'
              : 'bg-sa-muted'
          "
        ></span>
        <p
          class="text-sm font-semibold"
          :class="collaborationEnabled ? 'text-neo-300' : 'text-sa-text'"
        >
          {{
            collaborationEnabled
              ? t("operations.collaborationReadyLabel", "Ready")
              : t("operations.collaborationLocalLabel", "Local")
          }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

defineProps({
  isDidConnected: {
    type: Boolean,
    default: false,
  },
  didLabel: {
    type: String,
    default: "",
  },
  isNeoConnected: {
    type: Boolean,
    default: false,
  },
  neoWalletLabel: {
    type: String,
    default: "",
  },
  evmAddress: {
    type: String,
    default: "",
  },
  evmWalletLabel: {
    type: String,
    default: "",
  },
  signatureCount: {
    type: Number,
    default: 0,
  },
  requiredSignerCount: {
    type: Number,
    default: 0,
  },
  collaborationEnabled: {
    type: Boolean,
    default: false,
  },
});

const { t } = useI18n();

function statusCardClass(active, color = "emerald") {
  if (active)
    return color === "neo"
      ? "border-neo-500/30 bg-neo-500/5"
      : "border-sa-success/30 bg-sa-success/5";
  return "border-sa-border bg-sa-panel/40";
}
</script>

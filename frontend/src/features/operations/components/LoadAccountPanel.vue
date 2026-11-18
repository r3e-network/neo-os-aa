<template>
  <section class="glass-panel p-6">
    <div class="mb-4 flex items-center justify-between">
      <div>
        <h2 class="text-lg font-bold text-sa-text">
          {{ t("operations.loadAccountTitle", "Load V3 Account") }}
        </h2>
        <p class="text-sm text-sa-muted">
          {{
            t(
              "operations.loadAccountSubtitle",
              "Enter the 20-byte accountId hash captured when the V3 account was registered. The virtual SA address is derived locally from that identity root.",
            )
          }}
        </p>
        <p class="mt-1 text-xs text-sa-muted">
          {{
            t(
              "operations.loadAccountHelp",
              "Use the accountId shown in Create Account, Address Market, or an existing draft. Neo address and .matrix reverse discovery are intentionally not used for V3 loading.",
            )
          }}
        </p>
      </div>
      <button
        class="btn-primary"
        :class="{ 'btn-loading': loading }"
        :disabled="!canLoad"
        @click="$emit('load')"
      >
        <svg
          v-if="loading"
          aria-hidden="true"
          class="animate-spin -ml-1 mr-2 h-4 w-4 text-sa-text inline"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
          ></circle>
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          ></path>
        </svg>
        {{
          loading
            ? t("operations.loadingAction", "Loading…")
            : t("operations.loadAction", "Load")
        }}
      </button>
    </div>
    <div class="space-y-4">
      <label class="block space-y-1 text-sm" for="load-account-seed">
        <span class="font-medium text-sa-text">{{
          t("operations.boundAddressHashLabel", "AccountId Hash")
        }}</span>
        <input
          id="load-account-seed"
          :value="accountAddressScriptHash"
          class="input-field w-full font-mono"
          :class="validationError ? '!border-sa-error' : ''"
          :placeholder="
            t(
              'operations.accountSeedPlaceholder',
              '40-char hash, e.g. 02a7...3f9c',
            )
          "
          @input="$emit('update:accountAddressScriptHash', $event.target.value)"
        />
        <div v-if="detectedFormat" class="mt-1.5">
          <span class="badge-blue">{{ detectedFormat }}</span>
        </div>
        <p
          v-if="validationError"
          role="alert"
          class="text-xs text-sa-error mt-1"
        >
          {{ validationError }}
        </p>
      </label>
      <div class="glass-panel px-3 py-2 text-xs text-sa-muted space-y-1">
        <p class="font-medium text-sa-text">
          {{ t("operations.supportedFormatsTitle", "Supported formats:") }}
        </p>
        <ul class="list-disc list-inside space-y-0.5 text-sa-muted">
          <li>
            <code class="font-mono text-neo-300">{{
              t("operations.formatLabel40CharHex", "40-char hex")
            }}</code>
            —
            {{ t("operations.format40CharHex", "Pre-derived accountId hash") }}
          </li>
          <li>
            <code class="font-mono text-neo-300">{{
              t("operations.formatLabel0xHash", "0x + 40-char hex")
            }}</code>
            —
            {{
              t(
                "operations.format0xHash",
                "The same accountId hash with an optional 0x prefix.",
              )
            }}
          </li>
          <li>
            <code class="font-mono text-neo-300">N... / .matrix</code> —
            {{
              t(
                "operations.formatUnsupportedDiscovery",
                "Not accepted here; use Account Discovery or paste the accountId hash.",
              )
            }}
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed } from "vue";
import { useI18n } from "@/i18n";

const props = defineProps({
  accountAddressScriptHash: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});
defineEmits(["load", "update:accountAddressScriptHash"]);

const { t } = useI18n();

const HEX_RE = /^[0-9a-fA-F]+$/;

const detectedFormat = computed(() => {
  const raw = props.accountAddressScriptHash.trim();
  if (!raw) return "";
  if (raw.startsWith("0x") || raw.startsWith("0X")) {
    const hex = raw.slice(2);
    if (hex.length === 40 && HEX_RE.test(hex))
      return t("operations.formatDetected0xHash", "0x-prefixed hash");
    return "";
  }
  if (raw.length === 40 && HEX_RE.test(raw))
    return t("operations.formatDetectedAccountId", "Account ID hash");
  return "";
});

const validationError = computed(() => {
  const raw = props.accountAddressScriptHash.trim();
  if (!raw) return "";
  if (raw.startsWith("0x") || raw.startsWith("0X")) {
    const hex = raw.slice(2);
    if (hex.length > 0 && !HEX_RE.test(hex))
      return t(
        "operations.invalidHexChars",
        "Contains non-hexadecimal characters",
      );
    if (hex.length > 0 && hex.length !== 40)
      return t(
        "operations.invalidHexLength",
        "Expected 40 hex characters after 0x",
      );
    return "";
  }
  if (/^[0-9a-fA-F]+$/.test(raw)) {
    if (raw.length !== 40)
      return t(
        "operations.invalidHexLength",
        "Expected 40 hex characters",
      );
    return "";
  }
  if (/^N/.test(raw) || isMatrixLike(raw))
    return t(
      "operations.unsupportedDiscoveryInput",
      "Neo address and .matrix lookup are not supported here. Paste the 20-byte accountId hash.",
    );
  return t("operations.unrecognizedFormat", "Unrecognized format");
});

const canLoad = computed(() => {
  return (
    props.accountAddressScriptHash.trim() !== "" &&
    !props.loading &&
    !validationError.value
  );
});

function isMatrixLike(value) {
  return String(value || "").toLowerCase().endsWith(".matrix");
}
</script>

<template>
  <div class="space-y-4">
    <div class="grid gap-4 md:grid-cols-2">
      <label class="space-y-1.5 text-sm" for="op-composer-token-script-hash">
        <span class="flex items-center gap-1.5 font-medium text-sa-text">
          <svg
            aria-hidden="true"
            class="w-4 h-4 text-sa-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            ></path>
          </svg>
          {{ t("operations.tokenScriptHashLabel", "Token Script Hash") }}
        </span>
        <input
          id="op-composer-token-script-hash"
          :value="transferTokenScriptHash"
          class="input-field font-mono text-xs"
          :class="{
            'border-sa-error': errors.transferTokenScriptHash,
          }"
          :placeholder="t('operations.tokenScriptHashPlaceholder', '0x...')"
          @input="$emit('update:transferTokenScriptHash', $event.target.value)"
        />
        <p
          v-if="errors.transferTokenScriptHash"
          role="alert"
          class="text-xs text-sa-error mt-1"
        >
          {{ errors.transferTokenScriptHash }}
        </p>
      </label>
      <label class="space-y-1.5 text-sm" for="op-composer-transfer-recipient">
        <span class="flex items-center gap-1.5 font-medium text-sa-text">
          <svg
            aria-hidden="true"
            class="w-4 h-4 text-sa-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
            ></path>
          </svg>
          {{ t("operations.recipientLabel", "Recipient Address / Hash") }}
        </span>
        <input
          id="op-composer-transfer-recipient"
          :value="transferRecipient"
          class="input-field"
          :class="{
            'border-sa-error': errors.transferRecipient,
          }"
          :placeholder="t('operations.recipientPlaceholder', 'N... or 0x...')"
          @input="$emit('update:transferRecipient', $event.target.value)"
        />
        <p
          v-if="errors.transferRecipient"
          role="alert"
          class="text-xs text-sa-error mt-1"
        >
          {{ errors.transferRecipient }}
        </p>
      </label>
    </div>
    <div class="grid gap-4 md:grid-cols-2">
      <label class="space-y-1.5 text-sm" for="op-composer-transfer-amount">
        <span class="flex items-center gap-1.5 font-medium text-sa-text">
          <svg
            aria-hidden="true"
            class="w-4 h-4 text-sa-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
            ></path>
          </svg>
          {{ t("operations.amountLabel", "Amount") }}
        </span>
        <input
          id="op-composer-transfer-amount"
          :value="transferAmount"
          type="number"
          class="input-field"
          :class="{ 'border-sa-error': errors.transferAmount }"
          placeholder="0"
          @input="$emit('update:transferAmount', $event.target.value)"
        />
        <p
          v-if="errors.transferAmount"
          role="alert"
          class="text-xs text-sa-error mt-1"
        >
          {{ errors.transferAmount }}
        </p>
      </label>
      <label class="space-y-1.5 text-sm" for="op-composer-transfer-data">
        <span class="flex items-center gap-1.5 font-medium text-sa-text">
          <svg
            aria-hidden="true"
            class="w-4 h-4 text-sa-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"
            ></path>
          </svg>
          {{ t("operations.dataLabel", "Data (Optional)") }}
        </span>
        <input
          id="op-composer-transfer-data"
          :value="transferData"
          class="input-field"
          :placeholder="t('operations.dataPlaceholder', 'null or JSON')"
          @input="$emit('update:transferData', $event.target.value)"
        />
      </label>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

defineProps({
  transferTokenScriptHash: { type: String, default: "" },
  transferRecipient: { type: String, default: "" },
  transferAmount: { type: String, default: "" },
  transferData: { type: String, default: "" },
  errors: { type: Object, default: () => ({}) },
});

defineEmits([
  "update:transferTokenScriptHash",
  "update:transferRecipient",
  "update:transferAmount",
  "update:transferData",
]);

const { t } = useI18n();
</script>

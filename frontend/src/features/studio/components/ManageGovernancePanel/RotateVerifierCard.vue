<template>
  <div class="card hover:border-sa-muted transition-colors duration-200">
    <h3 class="text-sm font-bold text-sa-text mb-5">
      {{ t("studioPanels.rotateVerifier", "Rotate Verifier Plugin") }}
    </h3>
    <div class="space-y-4">
      <div>
        <label
          for="governance-verifier-hash"
          class="block text-xs font-semibold text-sa-muted mb-1"
          >{{ t("studioPanels.verifierHash", "Verifier Hash") }}</label
        >
        <input
          id="governance-verifier-hash"
          :value="verifierContract"
          @input="$emit('update:verifierContract', $event.target.value)"
          type="text"
          class="input-field font-mono text-sm py-2 px-3 bg-sa-dark"
          :placeholder="t('studioPanels.hashPlaceholder', '0x...')"
        />
      </div>
      <div>
        <label
          for="governance-verifier-params"
          class="block text-xs font-semibold text-sa-muted mb-1"
          >{{
            t("studioPanels.verifierParamsHex", "Verifier Params (hex)")
          }}</label
        >
        <textarea
          id="governance-verifier-params"
          :value="verifierParams"
          @input="$emit('update:verifierParams', $event.target.value)"
          class="input-field font-mono text-xs py-2 px-3 bg-sa-dark min-h-24"
          :placeholder="
            t(
              'studioPanels.manageVerifierParamsPlaceholder',
              'Pubkey or verifier-specific config hex.',
            )
          "
        ></textarea>
      </div>
      <button
        type="button"
        :aria-label="t('studioPanels.ariaUpdateVerifier', 'Update verifier')"
        class="btn-primary w-full"
        :class="{ 'btn-loading': busy }"
        :disabled="disabled"
        @click="$emit('update')"
      >
        {{
          busy
            ? t("studioPanels.updating", "Updating...")
            : t("studioPanels.updateVerifier", "Update Verifier")
        }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

const { t } = useI18n();

defineProps({
  verifierContract: {
    type: String,
    default: "",
  },
  verifierParams: {
    type: String,
    default: "",
  },
  busy: {
    type: Boolean,
    default: false,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
});

defineEmits(["update:verifierContract", "update:verifierParams", "update"]);
</script>

<template>
  <div class="card hover:border-sa-muted transition-colors duration-200">
    <h3 class="text-sm font-bold text-sa-text mb-5">
      {{ t("studioPanels.rotateHook", "Rotate Hook Plugin") }}
    </h3>
    <div class="space-y-4">
      <div>
        <label
          for="governance-hook-hash"
          class="block text-xs font-semibold text-sa-muted mb-1"
          >{{ t("studioPanels.hookHash", "Hook Hash") }}</label
        >
        <input
          id="governance-hook-hash"
          :value="hookContract"
          @input="$emit('update:hookContract', $event.target.value)"
          type="text"
          class="input-field font-mono text-sm py-2 px-3 bg-sa-dark"
          :placeholder="t('studioPanels.hashPlaceholder', '0x...')"
        />
      </div>
      <button
        type="button"
        :aria-label="t('studioPanels.ariaUpdateHook', 'Update hook')"
        class="btn-primary w-full"
        :class="{ 'btn-loading': busy }"
        :disabled="disabled"
        @click="$emit('update')"
      >
        {{
          busy
            ? t("studioPanels.updating", "Updating...")
            : t("studioPanels.updateHook", "Update Hook")
        }}
      </button>
      <p class="text-xs text-sa-muted">
        {{
          t(
            "studioPanels.hookPluginExamples",
            "Examples: WhitelistHook, DailyLimitHook, NeoDIDCredentialHook, MultiHook.",
          )
        }}
      </p>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

const { t } = useI18n();

defineProps({
  hookContract: {
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

defineEmits(["update:hookContract", "update"]);
</script>

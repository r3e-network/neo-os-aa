<template>
  <section class="glass-panel p-6 shadow-glow-blue overflow-hidden">
    <div
      class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6"
    >
      <div>
        <h2 class="text-lg font-bold text-sa-text">
          {{ t("market.vanityTitle", "Vanity Address Generator") }}
        </h2>
        <p class="mt-1 text-sm text-sa-muted">
          {{
            t(
              "market.vanitySubtitle",
              "Generate SA addresses with custom prefixes, suffixes, or patterns",
            )
          }}
        </p>
      </div>
    </div>

    <div class="space-y-4">
      <PatternInputSection
        :pattern="vanity.pattern.value"
        :selected-type="vanity.patternType.value"
        @update:pattern="updatePattern"
        @update:selected-type="updatePatternType"
      />

      <DifficultyEstimator
        :difficulty="vanity.difficulty.value"
        :pattern="vanity.pattern.value"
        :show-cost="false"
      />

      <div class="flex gap-2">
        <button
          v-if="!vanity.running.value"
          type="button"
          class="btn-primary flex-1"
          :disabled="!vanity.pattern.value.trim() || vanity.error.value"
          :aria-label="t('market.ariaStartGeneration', 'Start generation')"
          @click="handleStart"
        >
          {{ t("market.vanityStartGeneration", "Start Generation") }}
        </button>
        <button
          v-else
          type="button"
          class="btn-danger flex-1"
          :aria-label="t('market.ariaStopGeneration', 'Stop generation')"
          @click="vanity.stop()"
        >
          {{ t("market.vanityStopGeneration", "Stop Generation") }}
        </button>
        <button
          v-if="vanity.found.value || vanity.attempts.value > 0"
          type="button"
          class="btn-secondary"
          :aria-label="t('market.ariaReset', 'Reset')"
          @click="handleReset"
        >
          {{ t("market.vanityReset", "Reset") }}
        </button>
      </div>

      <GenerationProgress
        :running="vanity.running.value"
        :found="vanity.found.value"
        :attempts="vanity.attempts.value"
        :elapsed="vanity.elapsed.value"
        :address="vanity.address.value"
        @stop="vanity.stop()"
      />

      <VanityResultsList
        :results="results"
        @use-for-listing="handleUseForListing"
      />
    </div>
  </section>
</template>

<script setup>
import { computed, ref } from "vue";
import { useI18n } from "@/i18n";
import { RUNTIME_CONFIG } from "@/config/runtimeConfig.js";
import { useVanityGenerator } from "@/composables/useVanityGenerator.js";
import PatternInputSection from "./PatternInputSection.vue";
import DifficultyEstimator from "./DifficultyEstimator.vue";
import GenerationProgress from "./GenerationProgress.vue";
import VanityResultsList from "./VanityResultsList.vue";

const props = defineProps({
  onUseForListing: { type: Function, default: null },
});

const { t } = useI18n();
const vanity = useVanityGenerator();
const foundResults = ref([]);

const results = computed(() => {
  const list = [...foundResults.value];
  if (vanity.found.value && vanity.seed.value) {
    const exists = list.some((r) => r.seed === vanity.seed.value);
    if (!exists) {
      list.unshift({
        seed: vanity.seed.value,
        address: vanity.address.value,
        accountIdHash: vanity.accountIdHash.value,
      });
    }
  }
  return list;
});

function updatePattern(value) {
  vanity.pattern.value = value;
}

function updatePatternType(value) {
  vanity.patternType.value = value;
}

function handleStart() {
  const contractHash = RUNTIME_CONFIG.smartAccountHash;
  if (!contractHash) return;
  vanity.start(contractHash, vanity.pattern.value, vanity.patternType.value);
}

function handleReset() {
  foundResults.value = [];
  vanity.reset();
}

function handleUseForListing(seed) {
  if (props.onUseForListing) {
    props.onUseForListing(seed);
  }
}

</script>

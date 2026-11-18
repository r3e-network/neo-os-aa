<template>
  <div class="rounded-lg border border-sa-border bg-sa-dark/50 p-4">
    <template v-if="running || (!found && attempts > 0)">
      <div class="flex items-center justify-between mb-3">
        <p class="text-xs font-semibold uppercase text-sa-info-light">
          {{ t("market.vanityGenerating", "Generating...") }}
        </p>
        <button
          type="button"
          class="btn-danger btn-sm"
          :aria-label="t('market.ariaStopGeneration', 'Stop generation')"
          @click="$emit('stop')"
        >
          {{ t("market.vanityStop", "Stop") }}
        </button>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3 mb-3">
        <div>
        <p class="text-[10px] uppercase text-sa-text/75">
            {{ t("market.vanityAttempts", "Attempts") }}
          </p>
          <p class="mt-0.5 font-mono text-sm text-sa-text">
            {{ formattedAttempts }}
          </p>
        </div>
        <div>
        <p class="text-[10px] uppercase text-sa-text/75">
            {{ t("market.vanityElapsed", "Elapsed") }}
          </p>
          <p class="mt-0.5 font-mono text-sm text-sa-text">
            {{ formattedElapsed }}
          </p>
        </div>
        <div>
        <p class="text-[10px] uppercase text-sa-text/75">
            {{ t("market.vanityHashrate", "Hashrate") }}
          </p>
          <p class="mt-0.5 font-mono text-sm text-sa-text">
            {{ hashrate }}{{ t("market.perSecond", "/s") }}
          </p>
        </div>
      </div>

      <div
        role="status"
        aria-live="polite"
        class="h-1.5 rounded-full bg-sa-dark/50 overflow-hidden"
      >
        <span class="sr-only">{{
          t("market.generationRunning", "Generation in progress...")
        }}</span>
        <div
          class="h-full w-full rounded-full bg-sa-info/60 animate-pulse"
        ></div>
      </div>
    </template>

    <template v-else-if="found">
      <div class="text-center py-2">
        <p class="text-lg font-bold text-sa-success font-outfit">
          {{ t("market.vanityFound", "Found!") }}
        </p>
        <p class="mt-2 break-all font-mono text-sm text-sa-text">
          {{ address }}
        </p>
        <p class="mt-1 text-xs text-sa-muted">
          {{ formattedAttempts }} / {{ formattedElapsed }}
        </p>
      </div>
    </template>

    <template v-else>
      <p class="text-sm text-sa-text/80 text-center py-2">
        {{
          t(
            "market.vanityReady",
            "Configure a pattern and click Start to begin",
          )
        }}
      </p>
    </template>
  </div>
</template>

<script setup>
import { computed } from "vue";
import { useI18n } from "@/i18n";
import { formatNumber, formatHashrate } from "@/utils/vanityDifficulty.js";

const props = defineProps({
  running: { type: Boolean, default: false },
  found: { type: Boolean, default: false },
  attempts: { type: Number, default: 0 },
  elapsed: { type: Number, default: 0 },
  address: { type: String, default: "" },
});

defineEmits(["stop"]);

const { t } = useI18n();

const formattedAttempts = computed(() => formatNumber(props.attempts));

const formattedElapsed = computed(() => {
  if (!props.elapsed) return `0${t("market.vanityDurationSecond", "s")}`;
  const s = Math.floor(props.elapsed / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const sec = t("market.vanityDurationSecond", "s");
  const min = t("market.vanityDurationMinuteShort", "m");
  const hr = t("market.vanityDurationHour", "h");
  if (h > 0) return `${h}${hr} ${m % 60}${min} ${s % 60}${sec}`;
  if (m > 0) return `${m}${min} ${s % 60}${sec}`;
  return `${s}${sec}`;
});

const hashrate = computed(() => formatHashrate(props.attempts, props.elapsed));
</script>

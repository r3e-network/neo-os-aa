<template>
  <div
    v-if="pattern"
    class="rounded-lg border border-sa-border bg-sa-dark/50 p-4"
  >
    <div class="flex items-center justify-between mb-3">
      <p class="text-xs font-semibold uppercase text-sa-muted">
        {{ t("market.vanityDifficulty", "Difficulty") }}
      </p>
      <span class="badge text-xs font-semibold uppercase" :class="levelClass">
        {{ levelLabel }}
      </span>
    </div>

    <div class="space-y-2">
      <div class="flex items-center justify-between text-sm">
        <span class="text-sa-muted">{{
          t("market.vanityAttemptsEstimate", "Estimated attempts")
        }}</span>
        <span class="font-mono text-sa-text">{{ formattedAttempts }}</span>
      </div>
      <div class="flex items-center justify-between text-sm">
        <span class="text-sa-muted">{{
          t("market.vanityTimeEstimate", "Estimated time (3K/s)")
        }}</span>
        <span class="font-mono text-sa-text">{{ formattedTime }}</span>
      </div>
      <div v-if="showCost" class="flex items-center justify-between text-sm">
        <span class="text-sa-muted">{{
          t("market.vanityCostEstimate", "Cost estimate")
        }}</span>
        <span class="font-mono text-sa-warning">{{ costGAS }} GAS</span>
      </div>
    </div>

    <div
      v-if="difficulty.level === 'hard'"
      class="mt-3 rounded-lg border border-sa-warning/20 bg-sa-warning/5 p-2.5"
    >
      <p class="text-xs text-sa-warning">
        {{
          t(
            "market.vanityHighDifficultyWarning",
            "This pattern is very hard to find. Consider shortening it or using the paid service.",
          )
        }}
      </p>
    </div>
  </div>
</template>

<script setup>
import { computed } from "vue";
import { useI18n } from "@/i18n";
import {
  formatAttempts,
  formatDuration,
  estimateCostGAS,
} from "@/utils/vanityDifficulty.js";

const props = defineProps({
  difficulty: { type: Object, required: true },
  pattern: { type: String, default: "" },
  showCost: { type: Boolean, default: false },
});

const { t } = useI18n();

const formattedAttempts = computed(() => {
  if (!props.difficulty.attempts) return "—";
  return `${formatAttempts(props.difficulty.attempts)} (${props.difficulty.attempts.toLocaleString()})`;
});

const formattedTime = computed(() =>
  formatDuration(props.difficulty.seconds, {
    instant: t("market.vanityDurationInstant", "instant"),
    subSecond: t("market.vanityDurationSubSecond", "< 1 second"),
    second: t("market.vanityDurationSecond", "s"),
    minute: t("market.vanityDurationMinute", "min"),
    hour: t("market.vanityDurationHour", "h"),
    minuteShort: t("market.vanityDurationMinuteShort", "m"),
    day: t("market.vanityDurationDay", "days"),
    week: t("market.vanityDurationWeek", "weeks"),
    year: t("market.vanityDurationYear", "years"),
  }),
);

const costGAS = computed(() => {
  if (!props.difficulty.seconds) return "0";
  return estimateCostGAS(props.difficulty.seconds).toFixed(2);
});

const levelClass = computed(() => {
  if (props.difficulty.level === "easy") return "badge-green";
  if (props.difficulty.level === "medium") return "badge-amber";
  return "badge-red";
});

const levelLabel = computed(() => {
  if (props.difficulty.level === "easy")
    return t("market.vanityDifficultyEasy", "Easy");
  if (props.difficulty.level === "medium")
    return t("market.vanityDifficultyMedium", "Medium");
  return t("market.vanityDifficultyHard", "Hard");
});
</script>

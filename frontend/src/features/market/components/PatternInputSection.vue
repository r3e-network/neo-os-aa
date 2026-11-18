<template>
  <div class="space-y-3">
    <div class="flex flex-wrap gap-2">
      <button
        v-for="typeOption in patternTypes"
        :key="typeOption.value"
        type="button"
        class="rounded-full border px-3 py-1.5 text-xs font-semibold uppercase transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sa-orange/40"
        :class="
          selectedType === typeOption.value
            ? 'border-sa-orange/40 bg-sa-orange/10 text-sa-orange'
            : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:text-slate-900'
        "
        :aria-label="typeOption.label"
        @click="$emit('update:selectedType', typeOption.value)"
      >
        {{ typeOption.label }}
      </button>
    </div>

    <label class="block" for="vanity-pattern-input">
      <input
        id="vanity-pattern-input"
        :value="pattern"
        type="text"
        class="input-field w-full bg-sa-dark font-mono text-sm"
        :class="inputClass"
        :placeholder="placeholder"
        maxlength="6"
        @input="
          $emit(
            'update:pattern',
            $event.target.value.replace(/[^1-9A-HJ-NP-Za-km-z]/g, ''),
          )
        "
      />
      <p
        v-if="validationError"
        role="alert"
        class="mt-1 text-xs text-sa-error-light"
      >
        {{ validationError }}
      </p>
      <p v-else class="mt-1 text-xs text-sa-text/80">
        {{ hintText }}
      </p>
    </label>
  </div>
</template>

<script setup>
import { computed } from "vue";
import { useI18n } from "@/i18n";
import { validatePattern } from "@/utils/vanityDifficulty.js";

const props = defineProps({
  pattern: { type: String, default: "" },
  selectedType: { type: String, default: "prefix" },
});

defineEmits(["update:pattern", "update:selectedType"]);

const { t } = useI18n();

const patternTypes = computed(() => [
  { value: "prefix", label: t("market.vanityPatternPrefix", "Prefix") },
  { value: "suffix", label: t("market.vanityPatternSuffix", "Suffix") },
  { value: "contains", label: t("market.vanityPatternContains", "Contains") },
]);

const errorCodeMessages = {
  empty: null,
  invalidChar: () =>
    t(
      "market.vanityInvalidChar",
      "Invalid character: only Base58 characters allowed (excludes 0, O, I, l)",
    ),
  tooLongPrefix: () =>
    t("market.vanityTooLong", "Pattern too long for practical generation"),
  tooLongContains: () =>
    t("market.vanityTooLong", "Pattern too long for practical generation"),
};

const validationError = computed(() => {
  const code = validatePattern(props.pattern, props.selectedType);
  if (!code || code === "empty") return null;
  const fn = errorCodeMessages[code];
  return fn ? fn() : code;
});

const inputClass = computed(() => {
  if (validationError.value)
    return "border-sa-error focus:border-sa-error-light focus:ring-sa-error-light/20";
  if (props.pattern.trim()) return "border-sa-success/50";
  return "";
});

const placeholder = computed(() => {
  if (props.selectedType === "prefix")
    return t("market.vanityPatternPlaceholderPrefix", "e.g. SA");
  if (props.selectedType === "suffix")
    return t("market.vanityPatternPlaceholderSuffix", "e.g. 99");
  return t("market.vanityPatternPlaceholderContains", "e.g. ABC");
});

const hintText = computed(() => {
  if (props.selectedType === "prefix") {
    return t(
      "market.vanityPrefixHint",
      'Addresses always start with N. Your pattern will match N + your input (e.g. "SA" matches "NAA...")',
    );
  }

  if (props.selectedType === "suffix") {
    return t(
      "market.vanitySuffixHint",
      'Your pattern will match the end of the address (e.g. "99" matches "...99").',
    );
  }

  if (props.selectedType === "contains") {
    return t(
      "market.vanityContainsHint",
      'Your pattern can appear anywhere after N (e.g. "ABC" matches "N...ABC...").',
    );
  }

  return t(
    "market.vanityPatternHint",
    "Only Base58 characters: 1-9, A-Z (no O/I), a-k (no l), m-z",
  );
});
</script>

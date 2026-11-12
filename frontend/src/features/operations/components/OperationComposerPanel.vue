<template>
  <section class="glass-panel p-6">
    <div class="mb-4 flex items-center justify-between">
      <div>
        <h2 class="text-lg font-bold text-aa-text">
          {{ t("operations.composeTitle", "Compose Operation") }}
        </h2>
        <p class="text-sm text-aa-muted">
          {{
            t(
              "operations.composeSubtitle",
              "Build common AA wrapper payloads with presets, then stage an immutable draft.",
            )
          }}
        </p>
      </div>
      <button
        class="btn-secondary"
        :disabled="!canStage"
        :aria-label="t('operations.ariaStageOperation', 'Stage operation')"
        :title="canStage ? '' : stageDisabledReason"
        @click="$emit('stage')"
      >
        {{ t("operations.stageAction", "Stage") }}
      </button>
    </div>

    <ComposerEmptyState
      v-if="
        !resolvedContractHash &&
        !targetContract.trim() &&
        preset !== 'nep17Transfer'
      "
    />
    <ComposerPresetSelector
      :preset="preset"
      :preset-options="presetOptions"
      @update:preset="$emit('update:preset', $event)"
    />

    <ComposerTransferForm
      v-if="preset === 'nep17Transfer'"
      :transfer-token-script-hash="transferTokenScriptHash"
      :transfer-recipient="transferRecipient"
      :transfer-amount="transferAmount"
      :transfer-data="transferData"
      :errors="nep17TransferErrors"
      @update:transfer-token-script-hash="
        $emit('update:transferTokenScriptHash', $event)
      "
      @update:transfer-recipient="$emit('update:transferRecipient', $event)"
      @update:transfer-amount="$emit('update:transferAmount', $event)"
      @update:transfer-data="$emit('update:transferData', $event)"
    />

    <div v-else class="grid gap-4 md:grid-cols-3">
      <label
        v-if="preset === 'multisigDraft'"
        class="space-y-1.5 text-sm md:col-span-1"
        for="op-composer-multisig-title"
      >
        <span class="font-medium text-aa-text">{{
          t("operations.draftTitleLabel", "Draft Title")
        }}</span>
        <input
          id="op-composer-multisig-title"
          :value="multisigTitle"
          class="input-field"
          @input="$emit('update:multisigTitle', $event.target.value)"
        />
      </label>
      <label
        v-if="preset === 'multisigDraft'"
        class="space-y-1.5 text-sm md:col-span-2"
        for="op-composer-multisig-description"
      >
        <span class="font-medium text-aa-text">{{
          t("operations.draftDescriptionLabel", "Draft Description")
        }}</span>
        <input
          id="op-composer-multisig-description"
          :value="multisigDescription"
          class="input-field"
          @input="$emit('update:multisigDescription', $event.target.value)"
        />
      </label>
      <div class="space-y-2 text-sm md:col-span-2">
        <span id="target-contract-label" class="font-medium text-aa-text">{{
          t("operations.targetContractLabel", "Target Contract")
        }}</span>
        <input
          :value="targetContract"
          class="input-field font-mono text-xs"
          :class="{ 'border-aa-error': invokeErrors.targetContract }"
          aria-labelledby="target-contract-label"
          :placeholder="
            t(
              'operations.targetContractPlaceholder',
              'Contract hash, name, N address, alice.matrix, or app.neo',
            )
          "
          @input="onTargetContractInput"
        />
        <p
          v-if="invokeErrors.targetContract"
          role="alert"
          class="text-xs text-aa-error mt-1"
        >
          {{ invokeErrors.targetContract }}
        </p>
        <p
          v-else-if="contractLookupError"
          role="alert"
          class="text-xs text-aa-error"
        >
          {{ contractLookupError }}
        </p>
        <p
          v-else-if="contractLookupStatus"
          role="status"
          aria-live="polite"
          class="text-xs text-aa-muted"
        >
          {{ contractLookupStatus }}
        </p>
        <div
          v-if="resolvedContractHash"
          class="glass-panel px-3 py-2 text-xs text-aa-muted"
        >
          <div class="font-semibold text-aa-text">
            {{ t("operations.resolvedContract", "Resolved Contract") }}
          </div>
          <div class="font-mono">
            {{ resolvedContractName || t("operations.contract", "Contract") }} ·
            0x{{ resolvedContractHash }}
          </div>
        </div>
        <div
          v-if="contractSuggestions.length > 0"
          class="glass-panel shadow-sm overflow-hidden"
        >
          <button
            v-for="suggestion in contractSuggestions"
            :key="`${suggestion.contractHash}-${suggestion.displayName}`"
            :aria-label="suggestion.displayName"
            type="button"
            class="w-full border-b border-aa-border px-3 py-2 text-left last:border-b-0 hover:bg-aa-panel transition-colors duration-200"
            @click="$emit('select-contract-suggestion', suggestion)"
          >
            <div class="text-xs font-semibold text-aa-text">
              {{ suggestion.displayName }}
            </div>
            <div class="font-mono text-[11px] text-aa-muted">
              0x{{ suggestion.contractHash }}
            </div>
          </button>
        </div>
        <p
          v-if="
            targetContract.trim() &&
            contractSuggestions.length === 0 &&
            !resolvedContractHash &&
            !contractLookupStatus &&
            !contractLookupError
          "
          class="text-xs text-aa-muted px-3 py-2"
        >
          {{
            t("operations.noContractsFound", "No matching contracts found yet.")
          }}
        </p>
      </div>
      <label class="space-y-1.5 text-sm md:col-span-1" for="op-composer-method">
        <span class="font-medium text-aa-text">{{
          t("operations.methodLabel", "Method")
        }}</span>
        <select
          id="op-composer-method"
          v-if="methodOptions.length"
          :value="method"
          class="input-field"
          :class="{ 'border-aa-error': invokeErrors.method }"
          @change="onMethodInput"
        >
          <option value="">
            {{ t("operations.selectMethod", "Select method") }}
          </option>
          <option
            v-for="option in methodOptions"
            :key="option.name"
            :value="option.name"
          >
            {{ option.name }}
          </option>
        </select>
        <input
          id="op-composer-method"
          v-else
          :value="method"
          class="input-field"
          :class="{ 'border-aa-error': invokeErrors.method }"
          @input="onMethodInput"
        />
        <p
          v-if="invokeErrors.method"
          role="alert"
          class="text-xs text-aa-error mt-1"
        >
          {{ invokeErrors.method }}
        </p>
      </label>
      <div
        v-if="parameterFields.length"
        class="grid gap-4 md:grid-cols-2 md:col-span-3"
      >
        <label
          v-for="field in parameterFields"
          :key="field.key"
          class="space-y-1.5 text-sm"
          :for="'op-composer-param-' + field.key"
        >
          <span class="font-medium text-aa-text"
            >{{ field.name }}
            <span class="text-xs text-aa-muted">({{ field.type }})</span></span
          >
          <input
            v-if="!isBooleanField(field.type) && !isComplexField(field.type)"
            :id="'op-composer-param-' + field.key"
            :value="field.value"
            class="input-field font-mono text-xs"
            @input="
              $emit('update:parameterValue', {
                key: field.key,
                value: $event.target.value,
              })
            "
          />
          <div v-else-if="isBooleanField(field.type)" class="flex items-center">
            <button
              type="button"
              class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-aa-orange focus:ring-offset-2 focus:ring-offset-aa-dark"
              :class="field.value ? 'bg-aa-orange' : 'bg-aa-dark'"
              @click="
                $emit('update:parameterValue', {
                  key: field.key,
                  value: !field.value,
                })
              "
            >
              <span class="sr-only"
                >{{ t("operations.toggleField", "Toggle") }}
                {{ field.name }}</span
              >
              <span
                class="inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200"
                :class="field.value ? 'translate-x-6' : 'translate-x-1'"
              />
            </button>
            <span class="ml-3 text-sm text-aa-muted">{{
              field.value
                ? t("operations.true", "true")
                : t("operations.false", "false")
            }}</span>
          </div>
          <textarea
            v-else
            :id="'op-composer-param-' + field.key"
            :value="field.value"
            rows="3"
            class="input-field font-mono text-xs resize-none"
            @input="
              $emit('update:parameterValue', {
                key: field.key,
                value: $event.target.value,
              })
            "
          />
        </label>
      </div>
      <label
        v-if="!parameterFields.length"
        class="space-y-1.5 text-sm md:col-span-3"
        for="op-composer-args-json"
      >
        <span class="font-medium text-aa-text">{{
          t("operations.argsJsonLabel", "Args JSON")
        }}</span>
        <textarea
          id="op-composer-args-json"
          :value="argsText"
          rows="4"
          class="input-field font-mono text-xs resize-none"
          :placeholder="argsPlaceholder"
          @input="$emit('update:argsText', $event.target.value)"
          @blur="validateArgsJson"
        />
        <p v-if="argsError" role="alert" class="text-xs text-aa-error mt-1">
          {{ argsError }}
        </p>
      </label>
    </div>

    <ComposerSummaryStrip
      :summary-title="summaryTitle"
      :summary-detail="summaryDetail"
    />
  </section>
</template>

<script setup>
import { computed, getCurrentInstance, ref } from "vue";
import { useI18n } from "@/i18n";
import ComposerEmptyState from "./OperationComposerPanel/ComposerEmptyState.vue";
import ComposerPresetSelector from "./OperationComposerPanel/ComposerPresetSelector.vue";
import ComposerTransferForm from "./OperationComposerPanel/ComposerTransferForm.vue";
import ComposerSummaryStrip from "./OperationComposerPanel/ComposerSummaryStrip.vue";

defineProps({
  preset: { type: String, default: "invoke" },
  presetOptions: { type: Array, default: () => [] },
  targetContract: { type: String, default: "" },
  method: { type: String, default: "" },
  argsText: { type: String, default: "[]" },
  transferTokenScriptHash: { type: String, default: "" },
  transferRecipient: { type: String, default: "" },
  transferAmount: { type: String, default: "" },
  transferData: { type: String, default: "" },
  multisigTitle: { type: String, default: "" },
  multisigDescription: { type: String, default: "" },
  summaryTitle: { type: String, default: "" },
  summaryDetail: { type: String, default: "" },
  contractLookupStatus: { type: String, default: "" },
  contractLookupError: { type: String, default: "" },
  resolvedContractHash: { type: String, default: "" },
  resolvedContractName: { type: String, default: "" },
  contractSuggestions: { type: Array, default: () => [] },
  methodOptions: { type: Array, default: () => [] },
  parameterFields: { type: Array, default: () => [] },
});

const { t } = useI18n();
const argsPlaceholder = t(
  "operations.argsJsonPlaceholder",
  '[{"type":"String","value":"hello"}]',
);
const argsError = ref("");

function validateArgsJson() {
  const props = getCurrentInstance().props;
  const text = (props.argsText || "").trim();
  if (!text) {
    argsError.value = "";
    return;
  }
  try {
    JSON.parse(text);
    argsError.value = "";
  } catch {
    argsError.value = t("operations.invalidJson", "Invalid JSON format");
  }
}

defineEmits([
  "stage",
  "update:preset",
  "update:targetContract",
  "update:method",
  "update:argsText",
  "update:transferTokenScriptHash",
  "update:transferRecipient",
  "update:transferAmount",
  "update:transferData",
  "update:multisigTitle",
  "update:multisigDescription",
  "select-contract-suggestion",
  "update:parameterValue",
]);

// -- nep17Transfer validation --
const nep17TransferErrors = computed(() => {
  const props = getCurrentInstance().props;
  return {
    transferTokenScriptHash: !props.transferTokenScriptHash?.trim()
      ? t("operations.validationTokenRequired", "Token script hash is required")
      : "",
    transferRecipient: !props.transferRecipient?.trim()
      ? t(
          "operations.validationRecipientRequired",
          "Recipient address is required",
        )
      : "",
    transferAmount:
      !props.transferAmount || Number(props.transferAmount) <= 0
        ? t(
            "operations.validationAmountPositive",
            "Amount must be greater than 0",
          )
        : "",
  };
});

const nep17TransferFieldsValid = computed(() => {
  const e = nep17TransferErrors.value;
  return (
    !e.transferTokenScriptHash && !e.transferRecipient && !e.transferAmount
  );
});

// -- invoke validation --
const invokeErrors = computed(() => {
  const props = getCurrentInstance().props;
  return {
    targetContract: !props.targetContract?.trim()
      ? t(
          "operations.resolveContractBeforeStaging",
          "Resolve or select a contract before staging the operation.",
        )
      : "",
    method: !props.method?.trim()
      ? t(
          "operations.pickMethodBeforeStaging",
          "Pick a contract method before staging the operation.",
        )
      : "",
  };
});

const invokeFieldsValid = computed(() => {
  const e = invokeErrors.value;
  return !e.targetContract && !e.method;
});

// -- canStage: gates the Stage button --
const canStage = computed(() => {
  const props = getCurrentInstance().props;
  if (props.preset === "nep17Transfer") return nep17TransferFieldsValid.value;
  return invokeFieldsValid.value;
});

const stageDisabledReason = computed(() => {
  const props = getCurrentInstance().props;
  if (props.preset === "nep17Transfer") {
    const e = nep17TransferErrors.value;
    return (
      e.transferTokenScriptHash || e.transferRecipient || e.transferAmount || ""
    );
  }
  const e = invokeErrors.value;
  return e.targetContract || e.method || "";
});

// -- Field interaction handlers --
function onTargetContractInput(e) {
  getCurrentInstance().emit("update:targetContract", e.target.value);
}
function onMethodInput(e) {
  getCurrentInstance().emit("update:method", e.target.value);
}

function isBooleanField(type = "") {
  return String(type) === "Boolean";
}

function isComplexField(type = "") {
  return ["Array", "Map", "Any"].includes(String(type));
}
</script>

<template>
  <section class="card">
    <h2 class="text-lg font-bold text-sa-text mb-2">
      {{ t("studioPanels.permissionsTitle", "Module Reads") }}
    </h2>
    <p class="text-sm text-sa-muted mb-8">
      {{
        t(
          "studioPanels.permissionsSubtitleV4",
          "v4 configuration is callback-bound: install, configure and remove modules from Manage Configuration. Here you read an installed module's own safe methods; the core passes the account id and module id, so only the extra arguments are yours to supply.",
        )
      }}
    </p>

    <p v-if="!manageSnapshot.loadedAt" class="mb-6 rounded-lg border border-sa-border/60 bg-sa-panel/60 p-4 text-sm text-sa-muted">
      {{ t("studioPanels.loadAccountForPermissions", "Load the account in Manage Configuration first: a module read is bound to one installed instance.") }}
    </p>

    <div class="space-y-8">
      <div class="rounded-lg border border-sa-border/60 bg-sa-panel/60 p-5">
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div class="space-y-2">
            <label class="block text-sm font-semibold text-sa-text" for="read-account">
              {{ t("studioPanels.readAccountLabel", "Account ID") }}
            </label>
            <input
              id="read-account"
              v-model="permissionsForm.accountAddress"
              type="text"
              class="input-field font-mono text-sm py-2 px-3 bg-sa-dark"
              :placeholder="t('studioPanels.targetAccountPlaceholder', '20-byte hash160')"
            />
          </div>
          <div class="space-y-2">
            <label class="block text-sm font-semibold text-sa-text" for="read-module">
              {{ t("studioPanels.readModuleLabel", "Installed module") }}
            </label>
            <select
              id="read-module"
              v-model="permissionsForm.moduleId"
              class="input-field text-sm py-2 px-3 bg-sa-dark"
            >
              <option value="">{{ t("custom.none", "none") }}</option>
              <option
                v-for="module in manageSnapshot.modules"
                :key="module.moduleId"
                :value="String(module.moduleId)"
              >
                #{{ module.moduleId }} · {{ module.moduleType }} · {{ module.contractHash.slice(0, 10) }}…
              </option>
            </select>
          </div>
        </div>

        <div class="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div class="space-y-2">
            <label class="block text-sm font-semibold text-sa-text" for="read-method">
              {{ t("studioPanels.readMethodLabel", "Read method") }}
            </label>
            <input
              id="read-method"
              v-model="permissionsForm.method"
              type="text"
              class="input-field font-mono text-sm py-2 px-3 bg-sa-dark"
              :placeholder="t('studioPanels.readMethodPlaceholder', 'getConfig / getSessionKey / getDailyLimit …')"
            />
          </div>
          <div class="space-y-2">
            <label class="block text-sm font-semibold text-sa-text" for="read-args">
              {{ t("studioPanels.readArgsLabel", "Extra args JSON (after accountId, moduleId)") }}
            </label>
            <textarea
              id="read-args"
              v-model="permissionsForm.argsJson"
              rows="3"
              class="input-field font-mono text-xs"
              :placeholder="t('studioPanels.readArgsPlaceholder', '[]')"
            />
          </div>
        </div>
        <p v-if="argsError" role="alert" class="mt-2 text-xs text-sa-error-light">{{ argsError }}</p>

        <button
          type="button"
          class="btn-primary mt-4"
          :class="{ 'btn-loading': permissionsBusy.call }"
          :disabled="!canReadModule || permissionsBusy.call"
          @click="submitRead"
        >
          {{
            permissionsBusy.call
              ? t("studioPanels.calling", "Calling...")
              : t("studioPanels.readAction", "Read module")
          }}
        </button>
        <p class="mt-2 text-xs text-sa-muted">
          {{ t("studioPanels.readHintV4", "Reads run against the module contract with the loaded account; they never change on-chain state.") }}
        </p>
      </div>

      <div v-if="moduleReadOutcome" class="rounded-lg border border-sa-border/60 bg-sa-dark/40 p-5">
        <p class="mb-2 text-xs font-semibold uppercase text-sa-muted">
          {{ t("studioPanels.readResult", "Result") }}
        </p>
        <pre class="whitespace-pre-wrap break-all font-mono text-xs text-sa-text">{{ moduleReadOutcome }}</pre>
      </div>

      <div class="rounded-lg border border-sa-border/60 bg-sa-panel/60 p-5">
        <h3 class="text-sm font-bold text-sa-text mb-2">
          {{ t("studioPanels.readPresets", "Read Templates") }}
        </h3>
        <p class="text-sm text-sa-muted">
          {{
            t(
              "studioPanels.readPresetsHint",
              "Pick a template for an installed module, then replace the typed placeholders it carries.",
            )
          }}
        </p>
        <div class="mt-5 grid gap-4 lg:grid-cols-2">
          <div>
            <p class="mb-2 text-xs font-semibold uppercase text-sa-muted">
              {{ t("studioPanels.validatorReads", "Validator Reads") }}
            </p>
            <div class="grid gap-2">
              <button
                v-for="preset in validatorReads"
                :key="preset.label + preset.method"
                type="button"
                class="rounded-lg border border-sa-border bg-sa-dark/70 px-4 py-3 text-left transition-colors duration-200 hover:border-sa-orange/50 hover:bg-sa-dark"
                @click="applyPreset(preset)"
              >
                <p class="text-sm font-semibold text-sa-text">{{ preset.label }}</p>
                <p class="mt-1 text-xs text-sa-muted">{{ preset.description }}</p>
              </button>
            </div>
          </div>
          <div>
            <p class="mb-2 text-xs font-semibold uppercase text-sa-muted">
              {{ t("studioPanels.hookReads", "Hook Reads") }}
            </p>
            <div class="grid gap-2">
              <button
                v-for="preset in hookReads"
                :key="preset.label + preset.method"
                type="button"
                class="rounded-lg border border-sa-border bg-sa-dark/70 px-4 py-3 text-left transition-colors duration-200 hover:border-sa-orange/50 hover:bg-sa-dark"
                @click="applyPreset(preset)"
              >
                <p class="text-sm font-semibold text-sa-text">{{ preset.label }}</p>
                <p class="mt-1 text-xs text-sa-muted">{{ preset.description }}</p>
              </button>
            </div>
          </div>
        </div>
      </div>

      <details
        v-if="permissionsForm.accountAddress"
        class="rounded-lg border border-sa-border/60 bg-sa-panel/60 p-5"
      >
        <summary
          class="cursor-pointer text-sm font-semibold text-sa-muted hover:text-sa-text transition-colors duration-200"
        >
          {{ t("studioPanels.commonExamples", "Common Examples") }}
        </summary>
        <div class="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs text-sa-muted font-mono">
          <div
            v-for="example in commonExamples"
            :key="example.label + example.method"
            class="rounded-lg border border-sa-border/40 bg-sa-dark/30 p-4"
          >
            <div class="flex items-center justify-between mb-2">
              <p class="text-sa-orange font-semibold">{{ example.label }}</p>
              <button
                type="button"
                class="text-xs text-sa-muted hover:text-sa-text transition-colors duration-200"
                @click="applyPreset(example)"
              >
                {{ t("studioPanels.useTemplate", "Use Template") }}
              </button>
            </div>
            <pre class="whitespace-pre-wrap">{{ example.code }}</pre>
          </div>
        </div>
      </details>
    </div>
  </section>
</template>

<script setup>
import { inject, ref } from "vue";
import { useI18n } from "@/i18n";
import { createModuleReadPresets, applyModuleReadPreset } from "@/features/studio/modulePresets";

const { t } = useI18n();

const studio = inject("studio");
const {
  permissionsForm,
  permissionsBusy,
  canReadModule,
  manageSnapshot,
  moduleReadOutcome,
  callModuleRead,
} = studio;

const argsError = ref("");

const { validatorReads, hookReads, commonExamples } = createModuleReadPresets(t);

function validateArgsJson() {
  const text = (permissionsForm.value.argsJson || "").trim();
  if (!text) {
    argsError.value = "";
    return true;
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new TypeError("args must be a JSON array");
    argsError.value = "";
    return true;
  } catch {
    argsError.value = t("studioPanels.invalidJson", "Invalid JSON format");
    return false;
  }
}

function applyPreset(preset) {
  applyModuleReadPreset(permissionsForm.value, preset);
  validateArgsJson();
}

function submitRead() {
  if (!validateArgsJson()) return;
  void callModuleRead();
}
</script>

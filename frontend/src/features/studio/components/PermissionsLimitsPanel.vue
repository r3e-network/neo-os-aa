<template>
  <section class="card">
    <h2 class="text-lg font-bold text-aa-text mb-2">
      {{ t("studioPanels.permissionsTitle", "Permissions & Limits") }}
    </h2>
    <p class="text-sm text-aa-muted mb-8">
      {{
        t(
          "studioPanels.permissionsSubtitle",
          "V3 policy lives in hook and verifier plugins. Use the active account plus raw method/args calls below to configure the currently bound plugin contracts.",
        )
      }}
    </p>

    <div class="space-y-8">
      <div class="rounded-lg border border-aa-border/60 bg-aa-panel/60 p-5">
        <div
          class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"
        >
          <div>
            <h3 class="text-sm font-bold text-aa-text mb-2">
              {{ t("studioPanels.presetCatalog", "Preset Catalog") }}
            </h3>
            <p class="text-sm text-aa-muted">
              {{
                t(
                  "studioPanels.presetCatalogSubtitle",
                  "Pick a common verifier or hook preset first, then adjust the typed args only where your account needs a different target, token, or expiry.",
                )
              }}
            </p>
          </div>
          <router-link
            :to="{ path: '/docs', query: { doc: 'pluginGuide' } }"
            class="btn-secondary whitespace-nowrap"
          >
            {{ t("studioPanels.openPluginGuide", "Open Hook & Plugin Guide") }}
          </router-link>
        </div>
        <div class="mt-5 grid gap-4 lg:grid-cols-2">
          <div>
            <p class="mb-2 text-xs font-semibold uppercase text-aa-muted">
              {{ t("studioPanels.verifierPresets", "Verifier Presets") }}
            </p>
            <div class="grid gap-2">
              <button
                v-for="preset in verifierPresets"
                :key="preset.label"
                type="button"
                :aria-label="
                  preset.label + ' ' + t('studioPanels.presetSuffix', 'preset')
                "
                class="rounded-lg border border-aa-border bg-aa-dark/70 px-4 py-3 text-left transition-colors duration-200 hover:border-aa-orange/50 hover:bg-aa-dark"
                @click="applyVerifierPreset(preset)"
              >
                <p class="text-sm font-semibold text-aa-text">
                  {{ t("studio.presets." + preset.label, preset.label) }}
                </p>
                <p class="mt-1 text-xs text-aa-muted">
                  {{ preset.description }}
                </p>
              </button>
            </div>
          </div>
          <div>
            <p class="mb-2 text-xs font-semibold uppercase text-aa-muted">
              {{ t("studioPanels.hookPresets", "Hook Presets") }}
            </p>
            <div class="grid gap-2">
              <button
                v-for="preset in hookPresets"
                :key="preset.label"
                type="button"
                :aria-label="
                  preset.label + ' ' + t('studioPanels.presetSuffix', 'preset')
                "
                class="rounded-lg border border-aa-border bg-aa-dark/70 px-4 py-3 text-left transition-colors duration-200 hover:border-aa-orange/50 hover:bg-aa-dark"
                @click="applyHookPreset(preset)"
              >
                <p class="text-sm font-semibold text-aa-text">
                  {{ t("studio.presets." + preset.label, preset.label) }}
                </p>
                <p class="mt-1 text-xs text-aa-muted">
                  {{ preset.description }}
                </p>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="bg-aa-panel p-5 rounded-lg border border-aa-border/60">
        <label
          for="permissions-target-account"
          class="block text-sm font-semibold text-aa-text mb-3"
          >{{
            t("studioPanels.targetAccountLabel", "Target AccountId Hash")
          }}</label
        >
        <div class="flex flex-col sm:flex-row gap-4">
          <input
            id="permissions-target-account"
            v-model="permissionsForm.accountAddress"
            type="text"
            list="loaded-permissions-accounts"
            class="input-field flex-1 font-mono text-sm py-2.5 px-4 bg-aa-dark"
            :placeholder="
              t('studioPanels.targetAccountPlaceholder', '20-byte hash160')
            "
          />
          <datalist id="loaded-permissions-accounts">
            <option
              v-for="addr in autoLoadedAccounts"
              :key="addr"
              :value="addr"
            />
          </datalist>
        </div>
        <p class="mt-2 text-xs text-aa-muted">
          {{
            t(
              "studioPanels.permissionsHint",
              "The account must already have an active verifier and/or hook bound. V3 plugin calls are keyed by accountId hash160.",
            )
          }}
        </p>
      </div>

      <!-- Empty state when no account is loaded -->
      <div v-if="!permissionsForm.accountAddress" class="empty-state">
        <div
          class="mx-auto w-12 h-12 rounded-full bg-aa-panel/30 flex items-center justify-center mb-3"
        >
          <svg
            aria-hidden="true"
            class="w-6 h-6 text-aa-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="1.5"
              d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
            ></path>
          </svg>
        </div>
        <p class="text-sm text-aa-text font-medium mb-1">
          {{ t("studioPanels.noAccountForPermissions", "No account loaded") }}
        </p>
        <p class="text-xs text-aa-muted">
          {{
            t(
              "studioPanels.loadAccountForPermissions",
              "Enter a target account above to configure permissions and limits.",
            )
          }}
        </p>
      </div>

      <div
        v-if="permissionsForm.accountAddress"
        class="grid grid-cols-1 md:grid-cols-2 gap-8"
      >
        <div
          class="card hover:border-aa-muted transition-colors duration-200 flex flex-col p-5 rounded-lg"
        >
          <h3 class="text-sm font-bold text-aa-text mb-5">
            {{
              t(
                "studioPanels.callActiveVerifier",
                "Call Active Verifier Plugin",
              )
            }}
          </h3>
          <div class="space-y-4">
            <div>
              <label
                for="verifier-method-input"
                class="block text-xs font-semibold text-aa-muted mb-1"
                >{{ t("studioPanels.methodLabel", "Method") }}</label
              >
              <input
                id="verifier-method-input"
                v-model="permissionsForm.verifierMethod"
                type="text"
                class="input-field text-sm font-mono py-2 px-3 bg-aa-dark"
                :placeholder="
                  t(
                    'studioPanels.verifierMethodPlaceholder',
                    'setSessionKey / setConfig / createSubscription ...',
                  )
                "
              />
            </div>
            <div>
              <label
                for="verifier-args-input"
                class="block text-xs font-semibold text-aa-muted mb-1"
                >{{ t("studioPanels.argsJsonLabel", "Args JSON") }}</label
              >
              <textarea
                id="verifier-args-input"
                v-model="permissionsForm.verifierArgsJson"
                class="input-field text-xs font-mono py-2 px-3 bg-aa-dark min-h-32"
                :placeholder="verifierArgsPlaceholder"
                @blur="validateVerifierArgsJson"
              ></textarea>
              <p
                v-if="verifierArgsError"
                role="alert"
                class="text-xs text-aa-error mt-1"
              >
                {{ verifierArgsError }}
              </p>
            </div>
            <div
              v-if="sessionKeyValueWarning"
              role="alert"
              class="flex items-start gap-2 rounded-lg border border-aa-warning/40 bg-aa-warning/10 px-3 py-2"
            >
              <span class="text-aa-warning text-sm leading-none mt-0.5" aria-hidden="true">⚠</span>
              <p class="text-xs text-aa-warning-light leading-relaxed">
                {{ sessionKeyValueWarning }}
              </p>
            </div>
            <button
              type="button"
              :aria-label="t('studioPanels.ariaCallVerifier', 'Call verifier')"
              class="btn-primary w-full"
              :class="{ 'btn-loading': permissionsBusy.verifierCall }"
              :disabled="permissionsBusy.verifierCall || !canManagePermissions"
              @click="callVerifier"
            >
              {{
                permissionsBusy.verifierCall
                  ? t("studioPanels.calling", "Calling...")
                  : t("studioPanels.callVerifier", "Call Verifier")
              }}
            </button>
          </div>
        </div>

        <div
          class="card hover:border-aa-muted transition-colors duration-200 flex flex-col p-5 rounded-lg"
        >
          <h3 class="text-sm font-bold text-aa-text mb-5">
            {{ t("studioPanels.callActiveHook", "Call Active Hook Plugin") }}
          </h3>
          <div class="space-y-4">
            <div>
              <label
                for="hook-method-input"
                class="block text-xs font-semibold text-aa-muted mb-1"
                >{{ t("studioPanels.methodLabel", "Method") }}</label
              >
              <input
                id="hook-method-input"
                v-model="permissionsForm.hookMethod"
                type="text"
                class="input-field text-sm font-mono py-2 px-3 bg-aa-dark"
                :placeholder="
                  t(
                    'studioPanels.hookMethodPlaceholder',
                    'setWhitelist / setDailyLimit / requireCredentialCommitmentForContract ...',
                  )
                "
              />
            </div>
            <div>
              <label
                for="hook-args-input"
                class="block text-xs font-semibold text-aa-muted mb-1"
                >{{ t("studioPanels.argsJsonLabel", "Args JSON") }}</label
              >
              <textarea
                id="hook-args-input"
                v-model="permissionsForm.hookArgsJson"
                class="input-field text-xs font-mono py-2 px-3 bg-aa-dark min-h-32"
                :placeholder="hookArgsPlaceholder"
                @blur="validateHookArgsJson"
              ></textarea>
              <p
                v-if="hookArgsError"
                role="alert"
                class="text-xs text-aa-error mt-1"
              >
                {{ hookArgsError }}
              </p>
            </div>
            <button
              type="button"
              :aria-label="t('studioPanels.ariaCallHook', 'Call hook')"
              class="btn-secondary w-full"
              :class="{ 'btn-loading': permissionsBusy.hookCall }"
              :disabled="permissionsBusy.hookCall || !canManagePermissions"
              @click="callHook"
            >
              {{
                permissionsBusy.hookCall
                  ? t("studioPanels.calling", "Calling...")
                  : t("studioPanels.callHook", "Call Hook")
              }}
            </button>
          </div>
        </div>
      </div>

      <details
        v-if="permissionsForm.accountAddress"
        class="rounded-lg border border-aa-border/60 bg-aa-panel/60 p-5"
      >
        <summary
          class="cursor-pointer text-sm font-semibold text-aa-muted hover:text-aa-text transition-colors duration-200 flex items-center gap-2"
        >
          <svg
            aria-hidden="true"
            class="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
            ></path>
          </svg>
          {{ t("studioPanels.commonExamples", "Common Examples") }}
        </summary>
        <div
          class="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs text-aa-muted font-mono"
        >
          <div
            v-for="example in commonExamples"
            :key="example.label"
            class="rounded-lg border border-aa-border/40 bg-aa-dark/30 p-4"
          >
            <div class="flex items-center justify-between mb-2">
              <p class="text-aa-orange font-semibold">
                {{ t("studio.presets." + example.label, example.label) }}
              </p>
              <button
                @click="applyExample(example)"
                class="text-xs text-aa-muted hover:text-aa-text transition-colors duration-200 flex items-center gap-1"
              >
                <svg
                  aria-hidden="true"
                  class="w-3 h-3"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                  ></path>
                </svg>
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
import { computed, inject, ref } from "vue";
import { useI18n } from "@/i18n";
import { analyzeSessionKeyScope } from "@/features/studio/sessionKeyScope";

const { t } = useI18n();

const studio = inject("studio");
const {
  permissionsForm,
  permissionsBusy,
  canManagePermissions,
  autoLoadedAccounts,
  callVerifier,
  callHook,
} = studio;

const verifierArgsPlaceholder = t(
  "studioPanels.verifierArgsPlaceholder",
  '[{"type":"Hash160","value":"0x..."},{"type":"ByteArray","value":"0x..."}]',
);
const hookArgsPlaceholder = t(
  "studioPanels.hookArgsPlaceholder",
  '[{"type":"Hash160","value":"0x..."},{"type":"Boolean","value":true}]',
);

const verifierArgsError = ref("");
const hookArgsError = ref("");

function validateVerifierArgsJson() {
  const text = (permissionsForm.value.verifierArgsJson || "").trim();
  if (!text) {
    verifierArgsError.value = "";
    return;
  }
  try {
    JSON.parse(text);
    verifierArgsError.value = "";
  } catch {
    verifierArgsError.value = t(
      "studioPanels.invalidJson",
      "Invalid JSON format",
    );
  }
}

function validateHookArgsJson() {
  const text = (permissionsForm.value.hookArgsJson || "").trim();
  if (!text) {
    hookArgsError.value = "";
    return;
  }
  try {
    JSON.parse(text);
    hookArgsError.value = "";
  } catch {
    hookArgsError.value = t("studioPanels.invalidJson", "Invalid JSON format");
  }
}

// setSessionKey is value-uncapped unless it is a "transfer" method with a positive spending limit
// (the only path SessionKeyVerifier enforces). Surface that distinctly so the one-target/one-method
// preset is not mistaken for a bounded grant. Detection lives in sessionKeyScope.js (unit-tested).
const sessionKeyValueWarning = computed(() => {
  if (permissionsForm.value.verifierMethod !== "setSessionKey") return "";

  let args;
  try {
    args = JSON.parse(permissionsForm.value.verifierArgsJson || "");
  } catch {
    return "";
  }

  const scope = analyzeSessionKeyScope(args);
  if (!scope.applies || !scope.uncapped) return "";

  if (scope.nativeAsset) {
    return t(
      "studioPanels.sessionKeyUncappedNativeWarning",
      'This session key is VALUE-UNCAPPED on a native asset ({asset}): a wildcard ("*") method or a zero spending limit lets the delegated signer drain your entire {asset} balance — it is not limited to one method. Set method to "transfer" and add a positive spending limit (7th arg) to enforce a cap.',
    ).replace(/{asset}/g, scope.nativeAsset);
  }
  return t(
    "studioPanels.sessionKeyUncappedWarning",
    'This session key is VALUE-UNCAPPED: a wildcard ("*") method or a zero spending limit lets the delegated signer move the whole balance on the target contract — it is not limited to one method. Set method to "transfer" and add a positive spending limit (7th arg) to enforce a cap.',
  );
});

const verifierPresets = [
  {
    label: t("studioPanels.presetSessionKeyLabel", "SessionKeyVerifier"),
    description: t(
      "studioPanels.presetSessionKeyDesc",
      "Temporary delegated signer for one target + method.",
    ),
    method: "setSessionKey",
    args: [
      { type: "Hash160", value: "0x<accountId>" },
      { type: "ByteArray", value: "0x<sessionPubKey>" },
      { type: "Hash160", value: "0x<targetContract>" },
      { type: "String", value: "*" },
      { type: "Integer", value: "1735689600" },
    ],
  },
  {
    label: t("studioPanels.presetSubscriptionLabel", "SubscriptionVerifier"),
    description: t(
      "studioPanels.presetSubscriptionDesc",
      "Recurring approvals for scheduled pull-style flows.",
    ),
    method: "createSubscription",
    args: [
      { type: "Hash160", value: "0x<accountId>" },
      { type: "Hash160", value: "0x<targetContract>" },
      { type: "String", value: "executeUserOp" },
      { type: "Integer", value: "86400" },
    ],
  },
  {
    label: t("studioPanels.presetMultiSigLabel", "MultiSigVerifier"),
    description: t(
      "studioPanels.presetMultiSigDesc",
      "Threshold-based approvals for treasury-style accounts.",
    ),
    method: "setSigners",
    args: [
      { type: "Hash160", value: "0x<accountId>" },
      { type: "Array", value: [] },
      { type: "Integer", value: "2" },
    ],
  },
];

const hookPresets = [
  {
    label: t("studioPanels.presetWhitelistLabel", "WhitelistHook"),
    description: t(
      "studioPanels.presetWhitelistDesc",
      "Allow one target contract.",
    ),
    method: "setWhitelist",
    args: [
      { type: "Hash160", value: "0x<accountId>" },
      { type: "Hash160", value: "0x<targetContract>" },
      { type: "Boolean", value: true },
    ],
  },
  {
    label: t("studioPanels.presetDailyLimitLabel", "DailyLimitHook"),
    description: t(
      "studioPanels.presetDailyLimitDesc",
      "Cap daily token outflow.",
    ),
    method: "setDailyLimit",
    args: [
      { type: "Hash160", value: "0x<accountId>" },
      { type: "Hash160", value: "0x<token>" },
      { type: "Integer", value: "1000000" },
    ],
  },
  {
    label: t("studioPanels.presetDIDLabel", "NeoDIDCredentialHook"),
    description: t(
      "studioPanels.presetDIDDesc",
      "Require an active NeoDID registry binding before target access.",
    ),
    method: "requireCredentialCommitmentForContract",
    args: [
      { type: "Hash160", value: "0x<accountId>" },
      { type: "Hash160", value: "0x<targetContract>" },
      { type: "String", value: "github" },
      { type: "String", value: "Github_VerifiedUser" },
      { type: "ByteArray", value: "0x<32-byte-commitment>" },
    ],
  },
  {
    label: t("studioPanels.presetMultiHookLabel", "MultiHook"),
    description: t(
      "studioPanels.presetMultiHookDesc",
      "Compose multiple policy hooks behind one slot.",
    ),
    method: "setHooks",
    args: [
      { type: "Hash160", value: "0x<accountId>" },
      { type: "Array", value: [] },
    ],
  },
];

const commonExamples = [
  {
    label: t("studioPanels.presetWhitelistLabel", "WhitelistHook"),
    code: `method: setWhitelist
args: [
 { "type": "Hash160", "value": "0x<account>" },
 { "type": "Hash160", "value": "0x<target>" },
 { "type": "Boolean", "value": true }
]`,
    method: "setWhitelist",
    args: [
      { type: "Hash160", value: "0x<account>" },
      { type: "Hash160", value: "0x<target>" },
      { type: "Boolean", value: true },
    ],
  },
  {
    label: t("studioPanels.presetDailyLimitLabel", "DailyLimitHook"),
    code: `method: setDailyLimit
args: [
 { "type": "Hash160", "value": "0x<account>" },
 { "type": "Hash160", "value": "0x<token>" },
 { "type": "Integer", "value": "1000000" }
]`,
    method: "setDailyLimit",
    args: [
      { type: "Hash160", value: "0x<account>" },
      { type: "Hash160", value: "0x<token>" },
      { type: "Integer", value: "1000000" },
    ],
  },
  {
    label: t("studioPanels.presetSessionKeyLabel", "SessionKeyVerifier"),
    code: `method: setSessionKey
args: [
 { "type": "Hash160", "value": "0x<account>" },
 { "type": "ByteArray", "value": "0x<pubkey>" },
 { "type": "Hash160", "value": "0x<target>" },
 { "type": "String", "value": "*" },
 { "type": "Integer", "value": "1735689600" }
]`,
    method: "setSessionKey",
    args: [
      { type: "Hash160", value: "0x<account>" },
      { type: "ByteArray", value: "0x<pubkey>" },
      { type: "Hash160", value: "0x<target>" },
      { type: "String", value: "*" },
      { type: "Integer", value: "1735689600" },
    ],
  },
  {
    label: t("studioPanels.presetDIDLabel", "NeoDIDCredentialHook"),
    code: `method: setRegistry
args: [
 { "type": "Hash160", "value": "0x<neoDidRegistry>" }
]

method: requireCredentialCommitmentForContract
args: [
 { "type": "Hash160", "value": "0x<account>" },
 { "type": "Hash160", "value": "0x<target>" },
 { "type": "String", "value": "github" },
 { "type": "String", "value": "Github_VerifiedUser" },
 { "type": "String", "value": "true" }
]`,
    method: "requireCredentialCommitmentForContract",
    args: [
      { type: "Hash160", value: "0x<account>" },
      { type: "Hash160", value: "0x<target>" },
      { type: "String", value: "github" },
      { type: "String", value: "Github_VerifiedUser" },
      { type: "ByteArray", value: "0x<32-byte-commitment>" },
    ],
  },
];

function applyVerifierPreset(preset) {
  permissionsForm.value.verifierMethod = preset.method;
  permissionsForm.value.verifierArgsJson = JSON.stringify(preset.args, null, 2);
}

function applyHookPreset(preset) {
  permissionsForm.value.hookMethod = preset.method;
  permissionsForm.value.hookArgsJson = JSON.stringify(preset.args, null, 2);
}

function applyExample(example) {
  if (example.method.startsWith("set") && example.args[0]?.type === "Hash160") {
    const firstArgStr = example.args[0].value;
    if (firstArgStr.includes("token") || firstArgStr.includes("target")) {
      permissionsForm.value.hookMethod = example.method;
      permissionsForm.value.hookArgsJson = JSON.stringify(
        example.args,
        null,
        2,
      );
    } else {
      permissionsForm.value.verifierMethod = example.method;
      permissionsForm.value.verifierArgsJson = JSON.stringify(
        example.args,
        null,
        2,
      );
    }
  }
}
</script>

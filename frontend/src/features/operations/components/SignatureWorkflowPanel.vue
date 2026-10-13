<template>
  <section class="glass-panel p-6">
    <div class="mb-4 flex items-center justify-between gap-4">
      <div>
        <h2 class="text-lg font-bold text-aa-text">
          {{ t("operations.signatureWorkflowTitle", "Signature Workflow") }}
        </h2>
        <p class="text-sm text-aa-muted">
          {{
            t(
              "operations.signatureWorkflowSubtitle",
              "Collect Neo and EVM approvals against one immutable shared draft.",
            )
          }}
        </p>
      </div>
    </div>
    <div class="mb-5 rounded-lg border border-aa-border bg-aa-dark/50 p-4">
      <div class="flex items-center justify-between mb-3">
        <p class="text-xs font-bold uppercase text-aa-muted">
          {{ t("operations.signatureProgressTitle", "Signature Progress") }}
        </p>
        <p class="text-xs font-mono text-aa-muted">
          {{
            t("operations.collectedCount", "{collected} / {required} collected")
              .replace("{collected}", signatureCount)
              .replace("{required}", requiredSignerCount)
          }}
        </p>
      </div>
      <div class="w-full bg-aa-dark rounded-full h-2">
        <div
          role="progressbar"
          :aria-valuenow="signatureCount"
          aria-valuemin="0"
          :aria-valuemax="requiredSignerCount"
          :aria-label="
            t('operations.signatureProgressTitle', 'Signature progress')
          "
          class="bg-neo-500 h-2 rounded-full transition-all duration-200"
          :style="{
            width:
              requiredSignerCount > 0
                ? Math.min(100, (signatureCount / requiredSignerCount) * 100) +
                  '%'
                : '0%',
          }"
        ></div>
      </div>
      <p
        v-if="signatureCount >= requiredSignerCount && requiredSignerCount > 0"
        class="mt-2 text-xs text-aa-success flex items-center gap-1"
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
            d="M5 13l4 4L19 7"
          ></path>
        </svg>
        {{
          t(
            "operations.requiredApprovalRecordsCollected",
            "Required approval records collected. On-chain authorization still needs verification.",
          )
        }}
      </p>
      <p
        v-else-if="requiredSignerCount === 0"
        class="mt-2 text-xs text-aa-muted"
      >
        {{
          t(
            "operations.stageForRequirements",
            "Stage an operation to see signature requirements",
          )
        }}
      </p>
    </div>
    <div class="grid gap-4 md:grid-cols-2">
      <label class="space-y-1 text-sm" for="sig-workflow-signer-id">
        <span class="font-medium text-aa-text">{{
          t("operations.signerIdLabel", "Signer ID")
        }}</span>
        <input
          id="sig-workflow-signer-id"
          :value="signerId"
          class="input-field font-mono"
          :placeholder="
            t('operations.signerIdPlaceholder', 'N... address or 0x... for EVM')
          "
          @input="$emit('update:signerId', $event.target.value)"
        />
      </label>
      <label class="space-y-1 text-sm" for="sig-workflow-signer-kind">
        <span class="font-medium text-aa-text">{{
          t("operations.signerKindLabel", "Signer Kind")
        }}</span>
        <select
          id="sig-workflow-signer-kind"
          :value="signerKind"
          class="input-field"
          @change="$emit('update:signerKind', $event.target.value)"
        >
          <option value="neo">
            {{
              t(
                "operations.neoSignWithNeoGas",
                "Neo - Sign with NEO/GAS wallet",
              )
            }}
          </option>
          <option value="evm">
            {{
              t(
                "operations.evmSignWithMetaMask",
                "EVM - Sign with MetaMask or similar",
              )
            }}
          </option>
          <option value="zklogin">
            {{
              t(
                "operations.zkLoginSignWithMorpheus",
                "ZK Login - Sign with Morpheus NeoDID",
              )
            }}
          </option>
        </select>
        <p class="text-xs text-aa-muted mt-1">
          {{
            t(
              "operations.neoEvmAddressHint",
              "Neo = NEO address, EVM = Ethereum-style address",
            )
          }}
        </p>
      </label>
    </div>
    <div class="mt-4">
      <label class="space-y-1 text-sm" for="sig-workflow-signature-hex">
        <span class="font-medium text-aa-text">{{
          t("operations.signatureHexLabel", "Signature Hex")
        }}</span>
        <textarea
          id="sig-workflow-signature-hex"
          :value="signatureHex"
          rows="3"
          class="input-field font-mono text-xs resize-none"
          :class="
            signatureHex && !isValidHex(signatureHex) ? '!border-aa-error' : ''
          "
          :placeholder="
            t(
              'operations.signatureHexPlaceholder',
              'Paste signature hex (e.g. 3045022100...)',
            )
          "
          @input="$emit('update:signatureHex', $event.target.value)"
        ></textarea>
        <p
          v-if="signatureHex && !isValidHex(signatureHex)"
          role="alert"
          class="text-xs text-aa-error mt-1"
        >
          {{
            t(
              "operations.invalidHexFormat",
              "Invalid hex format — signature should start with 3045…",
            )
          }}
        </p>
      </label>
    </div>
    <div class="mt-5 flex items-center justify-between gap-4">
      <p class="text-xs text-aa-muted">
        {{ t("operations.orSignWithWallet", "Or sign with your wallet:") }}
      </p>
      <button
        class="btn-primary"
        :class="{ 'btn-loading': isAppendingSignature }"
        :disabled="
          !signatureHex || !isValidHex(signatureHex) || isAppendingSignature
        "
        @click="$emit('append-signature')"
      >
        {{
          isAppendingSignature
            ? t("operations.appendingSignature", "Appending…")
            : t("operations.appendManualSignature", "Append Signature")
        }}
      </button>
    </div>

    <div class="mt-6 rounded-lg border border-aa-border bg-aa-dark/50 p-4">
      <p class="text-xs font-bold uppercase text-aa-muted mb-3">
        {{ t("sharedDraft.collectedSignaturesTitle", "Collected Signatures") }}
      </p>
      <div
        v-if="signatures.length === 0"
        class="flex flex-col items-center justify-center py-6 text-center"
      >
        <svg
          aria-hidden="true"
          class="w-8 h-8 text-aa-muted/40 mb-2"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.5"
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <p class="text-sm text-aa-muted">
          {{
            t(
              "sharedDraft.noSignaturesYet",
              "No signatures have been attached yet.",
            )
          }}
        </p>
      </div>
      <div v-else class="space-y-2">
        <div
          v-for="(sig, idx) in signatures"
          :key="`${sig.signerId}:${sig.kind}:${idx}`"
          class="flex items-center gap-3 rounded-lg bg-aa-panel/50 px-3 py-2.5"
        >
          <span
            class="badge"
            :class="
              sig.kind === 'evm'
                ? 'badge-blue'
                : sig.kind === 'zklogin'
                  ? 'badge-orange'
                  : 'badge-green'
            "
          >
            {{
              sig.kind === "evm"
                ? t("sharedDraft.sigKindEvm", "EVM")
                : sig.kind === "zklogin"
                  ? t("sharedDraft.sigKindZkLogin", "ZK Login")
                  : t("sharedDraft.sigKindNeo", "Neo")
            }}
          </span>
          <span
            class="font-mono text-xs text-aa-text truncate flex-1"
            :title="sig.signerId"
            >{{ truncateSignerId(sig.signerId) }}</span
          >
          <span
            v-if="sig.createdAt"
            class="text-[10px] text-aa-muted whitespace-nowrap"
            >{{ formatSigTime(sig.createdAt) }}</span
          >
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { useI18n } from "@/i18n";

defineProps({
  signerId: { type: String, default: "" },
  signerKind: { type: String, default: "neo" },
  signatureHex: { type: String, default: "" },
  requiredSignerCount: { type: Number, default: 0 },
  signatureCount: { type: Number, default: 0 },
  signatures: { type: Array, default: () => [] },
  isAppendingSignature: { type: Boolean, default: false },
});
defineEmits([
  "append-signature",
  "update:signerId",
  "update:signerKind",
  "update:signatureHex",
]);

const { t } = useI18n();

function isValidHex(str) {
  return /^(0x)?[0-9a-fA-F]+$/.test(str) && str.length >= 64;
}

function truncateSignerId(id) {
  const s = String(id || "");
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

function formatSigTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return t("operations.justNow", "just now");
  if (diff < 3600000)
    return t("operations.minutesAgo", "{n}m ago").replace(
      "{n}",
      Math.floor(diff / 60000),
    );
  if (diff < 86400000)
    return t("operations.hoursAgo", "{n}h ago").replace(
      "{n}",
      Math.floor(diff / 3600000),
    );
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
</script>

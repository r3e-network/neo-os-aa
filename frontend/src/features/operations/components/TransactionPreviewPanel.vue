<template>
  <section class="glass-panel p-6">
    <div class="mb-4 flex items-center justify-between gap-4">
      <div>
        <h2 class="text-lg font-bold text-sa-text">
          {{ t("txPreview.title", "Transaction Preview") }}
        </h2>
        <p class="text-sm text-sa-muted">
          {{ t("txPreview.subtitle", "Review your operation before signing.") }}
        </p>
      </div>
      <span v-if="riskLevel" class="badge" :class="riskBadgeClass">
        <span class="w-1.5 h-1.5 rounded-full" :class="riskDotClass"></span>
        {{ riskLevel.label }}
      </span>
    </div>

    <!-- Empty state when no transaction is staged -->
    <div v-if="!transaction" class="empty-state">
      <div
        class="mx-auto w-12 h-12 rounded-full bg-sa-panel/30 flex items-center justify-center mb-3"
      >
        <svg
          aria-hidden="true"
          class="w-6 h-6 text-sa-muted"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.5"
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
          ></path>
        </svg>
      </div>
      <p class="text-sm text-sa-text font-medium mb-1">
        {{ t("txPreview.noTransaction", "No transaction staged") }}
      </p>
      <p class="text-xs text-sa-muted">
        {{
          t(
            "txPreview.stageTransactionHint",
            "Compose an operation to preview it here.",
          )
        }}
      </p>
    </div>

    <!-- Transaction preview when staged -->
    <template v-else>
      <!-- Operation Summary -->
      <div class="mb-5 rounded-lg border border-sa-border bg-sa-panel/50 p-4">
        <div class="flex items-start gap-4">
          <div
            class="w-12 h-12 rounded-xl flex items-center justify-center"
            :class="operationIconBg"
          >
            <svg
              v-if="transaction.type === 'transfer'"
              aria-hidden="true"
              class="w-6 h-6"
              :class="operationIconClass"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4 4"
              ></path>
            </svg>
            <svg
              v-else
              aria-hidden="true"
              class="w-6 h-6"
              :class="operationIconClass"
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
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-xs font-bold uppercase text-sa-muted">
              {{ t("txPreview.operation", "Operation") }}
            </p>
            <p class="text-sm font-semibold text-sa-text">
              {{ transaction.title }}
            </p>
            <p class="text-xs text-sa-muted mt-0.5">
              {{ transaction.description }}
            </p>
          </div>
          <div class="text-right">
            <p class="text-sm font-mono text-sa-text">
              {{ transaction.value || t("txPreview.noValue", "No value") }}
            </p>
            <p class="text-xs text-sa-muted">
              {{ transaction.token || t("txPreview.native", "Native") }}
            </p>
          </div>
        </div>
      </div>

      <!-- Target Contract Information -->
      <div
        v-if="transaction.contract"
        class="mb-5 rounded-lg border border-sa-border bg-sa-panel/50 p-4"
      >
        <div class="flex items-start gap-3">
          <div
            class="w-10 h-10 rounded-lg bg-sa-panel flex items-center justify-center"
          >
            <svg
              aria-hidden="true"
              class="w-5 h-5 text-sa-muted"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
              ></path>
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-xs font-bold uppercase text-sa-muted">
              {{ t("txPreview.targetContract", "Target Contract") }}
            </p>
            <div class="flex items-center gap-2 mt-1">
              <p class="text-sm font-semibold text-sa-text truncate">
                {{
                  transaction.contract.name ||
                  t("txPreview.unknownContract", "Unknown Contract")
                }}
              </p>
              <span v-if="transaction.contract.isNew" class="badge badge-red">{{
                t("txPreview.newContract", "New")
              }}</span>
              <span
                v-if="transaction.contract.isVerified"
                class="badge badge-green"
              >
                <svg
                  aria-hidden="true"
                  class="w-2.5 h-2.5 inline"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fill-rule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clip-rule="evenodd"
                  />
                </svg>
                {{ t("txPreview.verified", "Verified") }}
              </span>
            </div>
            <p class="text-xs font-mono text-sa-muted">
              {{ formatContractHash(transaction.contract.hash) }}
            </p>
          </div>
          <router-link
            v-if="transaction.contract.explorerUrl"
            :to="transaction.contract.explorerUrl"
            class="btn-ghost btn-xs"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ t("txPreview.viewOnExplorer", "View on Explorer") }}
          </router-link>
        </div>
      </div>

      <!-- Method Information -->
      <div
        v-if="transaction.method"
        class="mb-5 rounded-lg border border-sa-border bg-sa-panel/50 p-4"
      >
        <div class="flex items-start gap-3">
          <div
            class="w-10 h-10 rounded-lg bg-sa-panel flex items-center justify-center"
          >
            <svg
              aria-hidden="true"
              class="w-5 h-5 text-sa-muted"
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
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-xs font-bold uppercase text-sa-muted">
              {{ t("txPreview.method", "Method") }}
            </p>
            <div class="flex items-center gap-2 mt-1">
              <code class="text-sm font-mono text-sa-text">{{
                transaction.method.name
              }}</code>
              <span
                v-if="transaction.method.isUnrestricted"
                class="badge badge-orange"
                >{{ t("txPreview.unrestricted", "Unrestricted") }}</span
              >
            </div>
            <p
              v-if="transaction.method.signature"
              class="text-xs font-mono text-sa-muted mt-0.5 break-all"
            >
              {{ transaction.method.signature }}
            </p>
            <details
              v-if="
                transaction.method.parameters &&
                transaction.method.parameters.length > 0
              "
              class="mt-3"
            >
              <summary
                class="cursor-pointer text-xs font-semibold text-sa-muted hover:text-sa-text transition-colors duration-200 flex items-center gap-1"
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
                    d="M19 9l-7 7-7-7"
                  ></path>
                </svg>
                {{ t("txPreview.viewParameters", "View Parameters") }}
              </summary>
              <div class="mt-3 space-y-2">
                <div
                  v-for="(param, idx) in transaction.method.parameters"
                  :key="idx"
                  class="rounded bg-sa-dark/40 px-3 py-2"
                >
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-xs font-mono text-sa-muted"
                      >param{{ idx }}</span
                    >
                    <span
                      class="badge"
                      :class="getParameterBadgeClass(param.type)"
                      >{{ param.type }}</span
                    >
                  </div>
                  <p v-if="param.name" class="text-xs text-sa-text">
                    {{ param.name }}
                  </p>
                  <p
                    class="text-xs font-mono text-sa-muted truncate"
                    :title="param.value"
                  >
                    {{ param.value }}
                  </p>
                </div>
              </div>
            </details>
          </div>
        </div>
      </div>

      <!-- Estimated Cost -->
      <div
        v-if="estimatedCost"
        class="mb-5 rounded-lg border border-sa-border bg-gradient-to-br from-sa-panel/80 to-sa-dark/60 p-4"
      >
        <div class="flex items-center gap-3">
          <svg
            aria-hidden="true"
            class="w-10 h-10 text-sa-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2-1.343-2-3-2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            ></path>
          </svg>
          <div class="flex-1">
            <p class="text-xs font-bold uppercase text-sa-muted">
              {{ t("txPreview.estimatedCost", "Estimated Cost") }}
            </p>
            <div class="flex items-baseline gap-1 mt-1">
              <p class="text-2xl font-bold text-sa-text">
                {{ estimatedCost.amount }}
              </p>
              <p class="text-sm text-sa-muted">{{ estimatedCost.token }}</p>
            </div>
            <p
              v-if="estimatedCost.isSponsored"
              class="text-xs text-sa-success mt-1"
            >
              <svg
                aria-hidden="true"
                class="w-3 h-3 inline mr-1"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fill-rule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                  clip-rule="evenodd"
                />
              </svg>
              {{ t("txPreview.sponsored", "Sponsored by paymaster") }}
            </p>
            <div v-if="estimatedCost.breakdown" class="mt-2 space-y-1">
              <div class="flex justify-between text-xs">
                <span class="text-sa-muted">{{
                  t("txPreview.gasCost", "Gas Cost")
                }}</span>
                <span class="font-mono text-sa-text">{{
                  estimatedCost.breakdown.gas
                }}</span>
              </div>
              <div
                v-if="estimatedCost.breakdown.fee"
                class="flex justify-between text-xs"
              >
                <span class="text-sa-muted">{{
                  t("txPreview.networkFee", "Network Fee")
                }}</span>
                <span class="font-mono text-sa-text">{{
                  estimatedCost.breakdown.fee
                }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Risk Indicators -->
      <div
        v-if="riskIndicators && riskIndicators.length > 0"
        class="rounded-lg border"
        :class="riskBorderClass"
      >
        <div class="p-4">
          <div class="flex items-center gap-2 mb-3">
            <svg
              aria-hidden="true"
              class="w-5 h-5"
              :class="riskIconClass"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              ></path>
            </svg>
            <p class="text-xs font-bold uppercase" :class="riskTextClass">
              {{ t("txPreview.riskIndicators", "Risk Indicators") }}
            </p>
          </div>
          <div class="space-y-2">
            <div
              v-for="indicator in riskIndicators"
              :key="indicator.id"
              class="flex items-start gap-3 rounded-lg px-3 py-2"
              :class="indicatorBgClass"
            >
              <span :class="indicatorIconClass(indicator.severity)">
                <svg
                  v-if="indicator.severity === 'high'"
                  aria-hidden="true"
                  class="w-4 h-4 text-sa-error"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  ></path>
                </svg>
                <svg
                  v-else-if="indicator.severity === 'medium'"
                  aria-hidden="true"
                  class="w-4 h-4 text-sa-warning"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  ></path>
                </svg>
                <svg
                  v-else
                  aria-hidden="true"
                  class="w-4 h-4 text-sa-info"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  ></path>
                </svg>
              </span>
              <div class="flex-1">
                <p class="text-sm font-medium text-sa-text">
                  {{ indicator.title }}
                </p>
                <p class="text-xs text-sa-muted">{{ indicator.description }}</p>
              </div>
              <router-link
                v-if="indicator.docLink"
                :to="{ path: '/docs', query: { doc: indicator.docLink } }"
                class="btn-ghost btn-xs shrink-0"
              >
                {{ t("txPreview.learnMore", "Learn More") }}
              </router-link>
            </div>
          </div>
        </div>
      </div>

      <!-- UserOperation Breakdown -->
      <details
        v-if="userOperation"
        class="mt-5 rounded-lg border border-sa-border bg-sa-panel/50 p-4"
      >
        <summary
          class="cursor-pointer text-sm font-semibold text-sa-muted hover:text-sa-text transition-colors duration-200 flex items-center gap-2"
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
          {{ t("txPreview.userOperationBreakdown", "UserOperation Breakdown") }}
        </summary>
        <div class="mt-4 space-y-3">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="rounded bg-sa-dark/40 px-3 py-2">
              <p class="text-xs text-sa-muted">
                {{ t("txPreview.sender", "Sender") }}
              </p>
              <p class="text-sm font-mono text-sa-text truncate">
                {{ userOperation.sender }}
              </p>
            </div>
            <div class="rounded bg-sa-dark/40 px-3 py-2">
              <p class="text-xs text-sa-muted">
                {{ t("txPreview.nonce", "Nonce") }}
              </p>
              <p class="text-sm font-mono text-sa-text">
                {{ userOperation.nonce }}
              </p>
            </div>
            <div class="rounded bg-sa-dark/40 px-3 py-2">
              <p class="text-xs text-sa-muted">
                {{ t("txPreview.initCode", "Init Code") }}
              </p>
              <p class="text-sm font-mono text-sa-text truncate">
                {{ userOperation.initCode || t("txPreview.none", "None") }}
              </p>
            </div>
            <div class="rounded bg-sa-dark/40 px-3 py-2">
              <p class="text-xs text-sa-muted">
                {{ t("txPreview.callData", "Call Data") }}
              </p>
              <p
                class="text-sm font-mono text-sa-muted truncate"
                :title="userOperation.callData"
              >
                {{ userOperation.callData }}
              </p>
            </div>
          </div>
        </div>
      </details>
    </template>
  </section>
</template>

<script setup>
import { computed } from "vue";
import { useI18n } from "@/i18n";
import { formatHash as formatHashUtil } from "@/utils/hex.js";

const { t } = useI18n();

const props = defineProps({
  transaction: {
    type: Object,
    default: null,
  },
  userOperation: {
    type: Object,
    default: null,
  },
  estimatedCost: {
    type: Object,
    default: null,
  },
  riskIndicators: {
    type: Array,
    default: () => [],
  },
});

// Risk level calculation
const riskLevel = computed(() => {
  if (!props.riskIndicators || props.riskIndicators.length === 0) {
    return {
      label: t("txPreview.lowRisk", "Low Risk"),
      badgeClass: "badge-green",
      dotClass: "bg-sa-success",
    };
  }
  const hasHighRisk = props.riskIndicators.some((r) => r.severity === "high");
  if (hasHighRisk) {
    return {
      label: t("txPreview.highRisk", "High Risk"),
      badgeClass: "badge-red",
      dotClass: "bg-sa-error animate-pulse",
    };
  }
  const hasMediumRisk = props.riskIndicators.some(
    (r) => r.severity === "medium",
  );
  if (hasMediumRisk) {
    return {
      label: t("txPreview.mediumRisk", "Medium Risk"),
      badgeClass: "badge-orange",
      dotClass: "bg-sa-warning",
    };
  }
  return {
    label: t("txPreview.lowRisk", "Low Risk"),
    badgeClass: "badge-green",
    dotClass: "bg-sa-success",
  };
});

const riskBadgeClass = computed(() => riskLevel.value.badgeClass);
const riskDotClass = computed(() => riskLevel.value.dotClass);

// Risk styling
const riskBorderClass = computed(() => {
  const hasHigh = props.riskIndicators.some((r) => r.severity === "high");
  return hasHigh
    ? "border-sa-error/30 bg-sa-error/5"
    : "border-sa-warning/30 bg-sa-warning/5";
});

const riskIconClass = computed(() => {
  const hasHigh = props.riskIndicators.some((r) => r.severity === "high");
  return hasHigh ? "text-sa-error" : "text-sa-warning";
});

const riskTextClass = computed(() => {
  const hasHigh = props.riskIndicators.some((r) => r.severity === "high");
  return hasHigh ? "text-sa-error" : "text-sa-warning";
});

const indicatorBgClass = computed(() => {
  const hasHigh = props.riskIndicators.some((r) => r.severity === "high");
  return hasHigh ? "bg-sa-error/10" : "bg-sa-warning/10";
});

function indicatorIconClass(severity) {
  if (severity === "high") return "text-sa-error";
  if (severity === "medium") return "text-sa-warning";
  return "text-sa-info";
}

// Operation icon styling
const operationIconBg = computed(() => {
  if (!props.transaction) return "bg-sa-panel";
  if (props.transaction.type === "transfer") return "bg-neo-500/20";
  return "bg-sa-panel";
});

const operationIconClass = computed(() => {
  if (!props.transaction) return "text-sa-muted";
  if (props.transaction.type === "transfer") return "text-neo-400";
  return "text-sa-muted";
});

function getParameterBadgeClass(type) {
  const typeLower = String(type).toLowerCase();
  if (typeLower.includes("hash160") || typeLower.includes("hash256"))
    return "badge-blue";
  if (typeLower.includes("array") || typeLower.includes("map"))
    return "badge-purple";
  if (typeLower.includes("int") || typeLower.includes("byte"))
    return "badge-green";
  return "badge-gray";
}

function formatContractHash(hash) {
  return formatHashUtil(hash, { notSetLabel: t("txPreview.unknown", "Unknown") });
}
</script>

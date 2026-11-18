<template>
  <section class="glass-panel p-6">
    <div class="mb-4 flex items-center justify-between gap-4">
      <div>
        <h2 class="text-lg font-bold text-sa-text">
          {{ t("security.title", "Security Dashboard") }}
        </h2>
        <p class="text-sm text-sa-muted">
          {{
            t(
              "security.subtitle",
              "Overview of account security state, active policies, and recovery settings.",
            )
          }}
        </p>
      </div>
      <span
        v-if="accountLoaded"
        class="badge"
        :class="overallSecurityLevel.badgeClass"
      >
        <span
          class="w-1.5 h-1.5 rounded-full"
          :class="overallSecurityLevel.dotClass"
        ></span>
        {{ overallSecurityLevel.label }}
      </span>
    </div>

    <!-- Empty state when no account is loaded -->
    <SecurityEmptyState v-if="!accountLoaded" />

    <!-- Security overview when account is loaded -->
    <template v-else>
      <!-- Overall Security Score -->
      <SecurityScoreCard
        :security-score="securityScore"
        :security-score-percentage="securityScorePercentage"
        :overall-security-level="overallSecurityLevel"
      />

      <!-- Security Status Grid -->
      <SecurityStatusGrid
        :verifier-status="verifierStatus"
        :hook-status="hookStatus"
        :backup-status="backupStatus"
        :escape-status="escapeStatus"
        :account-state="accountState"
      />

      <!-- Active Policies Section -->
      <SecurityActivePoliciesList :active-policies="activePolicies" />

      <!-- Pending Updates Section -->
      <SecurityPendingUpdatesList
        :pending-updates="pendingUpdates"
        @cancel-pending-update="$emit('cancel-pending-update', $event)"
      />

      <!-- Session Keys Section (for SessionKeyVerifier) -->
      <SecuritySessionKeysList
        :session-keys="sessionKeys"
        @revoke-session-key="$emit('revoke-session-key', $event)"
      />

      <!-- Security Recommendations -->
      <SecurityRecommendationsList :recommendations="recommendations" />
    </template>
  </section>
</template>

<script setup>
import { computed } from "vue";
import { useI18n } from "@/i18n";
import { formatHash as formatHashUtil } from "@/utils/hex.js";
import SecurityEmptyState from "./SecurityDashboardPanel/SecurityEmptyState.vue";
import SecurityScoreCard from "./SecurityDashboardPanel/SecurityScoreCard.vue";
import SecurityStatusGrid from "./SecurityDashboardPanel/SecurityStatusGrid.vue";
import SecurityActivePoliciesList from "./SecurityDashboardPanel/SecurityActivePoliciesList.vue";
import SecurityPendingUpdatesList from "./SecurityDashboardPanel/SecurityPendingUpdatesList.vue";
import SecuritySessionKeysList from "./SecurityDashboardPanel/SecuritySessionKeysList.vue";
import SecurityRecommendationsList from "./SecurityDashboardPanel/SecurityRecommendationsList.vue";

const { t } = useI18n();

const props = defineProps({
  accountLoaded: { type: Boolean, default: false },
  accountState: {
    type: Object,
    default: () => ({
      accountId: "",
      verifier: "",
      hook: "",
      backupOwner: "",
      escapeTimelock: 0,
      escapeActive: false,
      escapeTriggeredAt: "",
      verifierType: "",
      hookType: "",
    }),
  },
  activePolicies: { type: Array, default: () => [] },
  pendingUpdates: { type: Array, default: () => [] },
  sessionKeys: { type: Array, default: () => [] },
});

defineEmits(["cancel-pending-update", "revoke-session-key"]);

// Overall security score calculation
const securityScore = computed(() => {
  let score = 0;
  if (props.accountState.verifier && props.accountState.verifier !== "0x")
    score++;
  if (props.accountState.hook && props.accountState.hook !== "0x") score++;
  if (props.accountState.backupOwner && props.accountState.backupOwner !== "0x")
    score++;
  return score;
});

const securityScorePercentage = computed(() => (securityScore.value / 3) * 100);

const overallSecurityLevel = computed(() => {
  if (securityScore.value === 3) {
    return {
      label: t("security.secure", "Secure"),
      badgeClass: "badge-green",
      dotClass: "bg-sa-success animate-pulse",
      circleClass: "text-sa-success",
      scoreTextClass: "text-sa-success",
      description: t(
        "security.secureDesc",
        "All security features are configured",
      ),
      hint: t("security.secureHint", "Your account has full protection"),
    };
  }
  if (securityScore.value === 2) {
    return {
      label: t("security.good", "Good"),
      badgeClass: "badge-blue",
      dotClass: "bg-sa-info",
      circleClass: "text-sa-info",
      scoreTextClass: "text-sa-info",
      description: t(
        "security.goodDesc",
        "Most security features are configured",
      ),
      hint: t("security.goodHint", "Consider adding backup owner"),
    };
  }
  return {
    label: t("security.basic", "Basic"),
    badgeClass: "badge-orange",
    dotClass: "bg-sa-warning",
    circleClass: "text-sa-warning",
    scoreTextClass: "text-sa-warning",
    description: t("security.basicDesc", "Basic protection only"),
    hint: t("security.basicHint", "Add verifier, hook, and backup owner"),
  };
});

// Verifier status
const verifierStatus = computed(() => {
  if (!props.accountState.verifier || props.accountState.verifier === "0x") {
    return {
      displayValue: t("security.notSet", "Not Set"),
      description: t("security.verifierNotSetDesc", "No verifier configured"),
      borderClass: "border-sa-error/30",
      iconClass: "text-sa-error",
      labelClass: "text-sa-error",
      descriptionClass: "text-sa-error",
    };
  }
  return {
    displayValue: formatHash(props.accountState.verifier),
    description:
      props.accountState.verifierType ||
      t("security.customVerifier", "Custom Verifier"),
    borderClass: "border-sa-success/30",
    iconClass: "text-sa-success",
    labelClass: "text-sa-success",
    descriptionClass: "text-sa-muted",
  };
});

// Hook status
const hookStatus = computed(() => {
  if (!props.accountState.hook || props.accountState.hook === "0x") {
    return {
      displayValue: t("security.notSet", "Not Set"),
      description: t("security.hookNotSetDesc", "No hook configured"),
      borderClass: "border-sa-error/30",
      iconClass: "text-sa-error",
      labelClass: "text-sa-error",
      descriptionClass: "text-sa-error",
    };
  }
  return {
    displayValue: formatHash(props.accountState.hook),
    description:
      props.accountState.hookType || t("security.customHook", "Custom Hook"),
    borderClass: "border-sa-success/30",
    iconClass: "text-sa-success",
    labelClass: "text-sa-success",
    descriptionClass: "text-sa-muted",
  };
});

// Backup owner status
const backupStatus = computed(() => {
  if (
    !props.accountState.backupOwner ||
    props.accountState.backupOwner === "0x"
  ) {
    return {
      displayValue: t("security.notSet", "Not Set"),
      description: t("security.backupNotSetDesc", "No recovery configured"),
      borderClass: "border-sa-error/30",
      iconClass: "text-sa-error",
      labelClass: "text-sa-error",
      descriptionClass: "text-sa-error",
    };
  }
  return {
    displayValue: formatHash(props.accountState.backupOwner),
    description: t("security.backupSetDesc", "Recovery is available"),
    borderClass: "border-sa-success/30",
    iconClass: "text-sa-success",
    labelClass: "text-sa-success",
    descriptionClass: "text-sa-success",
  };
});

// Escape hatch status
const escapeStatus = computed(() => {
  if (
    !props.accountState.escapeTimelock ||
    props.accountState.escapeTimelock === 0
  ) {
    return {
      displayValue: t("security.disabled", "Disabled"),
      description: t("security.escapeDisabledDesc", "No escape timelock"),
      borderClass: "border-sa-error/30",
      iconClass: "text-sa-error",
      labelClass: "text-sa-error",
      descriptionClass: "text-sa-error",
    };
  }
  if (props.accountState.escapeActive) {
    return {
      displayValue: t("security.escapeActive", "Active"),
      description: `${t("security.since")} ${formatTime(props.accountState.escapeTriggeredAt)}`,
      borderClass: "border-sa-warning/30",
      iconClass: "text-sa-warning",
      labelClass: "text-sa-warning",
      descriptionClass: "text-sa-warning",
      timeRemainingClass: "text-sa-warning",
    };
  }
  return {
    displayValue: `${props.accountState.escapeTimelock}s`,
    description: t("security.escapeReadyDesc", "Recovery is ready"),
    borderClass: "border-sa-success/30",
    iconClass: "text-sa-success",
    labelClass: "text-sa-success",
    descriptionClass: "text-sa-muted",
    timeRemainingClass: "text-sa-muted",
  };
});

// Recommendations based on current state
const recommendations = computed(() => {
  const recs = [];

  if (
    !props.accountState.backupOwner ||
    props.accountState.backupOwner === "0x"
  ) {
    recs.push({
      id: "backup-owner",
      type: "warning",
      title: t("security.recBackupOwnerTitle", "Set a Backup Owner"),
      description: t(
        "security.recBackupOwnerDesc",
        "Without a backup owner, you cannot recover your account if you lose access to your primary key.",
      ),
      docLink: "recoveryGuide",
    });
  }

  if (!props.accountState.hook || props.accountState.hook === "0x") {
    recs.push({
      id: "hook-policy",
      type: "info",
      title: t("security.recHookPolicyTitle", "Add a Hook Policy"),
      description: t(
        "security.recHookPolicyDesc",
        "Hook policies can add whitelist restrictions, daily limits, and other security controls.",
      ),
      docLink: "hookGuide",
    });
  }

  if (props.accountState.escapeTimelock === 0) {
    recs.push({
      id: "escape-timelock",
      type: "warning",
      title: t("security.recEscapeTimelockTitle", "Configure Escape Timelock"),
      description: t(
        "security.recEscapeTimelockDesc",
        "Set a timelock period for backup owner recovery to prevent instant unauthorized access.",
      ),
      docLink: "recoveryGuide",
    });
  }

  return recs;
});

function formatHash(hash) {
  return formatHashUtil(hash, { notSetLabel: t("security.notSet", "Not Set") });
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
</script>

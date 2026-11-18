<template>
  <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
    <div class="rounded-xl border border-sa-border bg-sa-panel/40 p-4">
      <p class="text-xs uppercase text-sa-muted font-bold mb-1">
        {{ t("didPanel.identityRoot", "Identity Root") }}
      </p>
      <p class="text-sm text-sa-text font-semibold break-all">
        {{
          didProfile?.identityRoot ||
          didProfile?.providerUid ||
          t("didPanel.notConnected", "not connected")
        }}
      </p>
    </div>
    <div class="rounded-xl border border-sa-border bg-sa-panel/40 p-4">
      <p class="text-xs uppercase text-sa-muted font-bold mb-1">
        {{ t("didPanel.provider", "Provider") }}
      </p>
      <p class="text-sm text-sa-text font-semibold">
        {{ didProfile?.provider || t("operations.web3auth", "web3auth") }}
      </p>
    </div>
    <div class="rounded-xl border border-sa-border bg-sa-panel/40 p-4">
      <p class="text-xs uppercase text-sa-muted font-bold mb-1">
        {{ t("didPanel.serviceDid", "NeoDID Service DID") }}
      </p>
      <p class="text-sm text-sa-text font-semibold break-all">
        {{ serviceDid }}
      </p>
    </div>
    <div class="rounded-xl border border-sa-border bg-sa-panel/40 p-4">
      <p class="text-xs uppercase text-sa-muted font-bold mb-1">
        {{ t("didPanel.resolvedAccountId", "Resolved AccountId") }}
      </p>
      <p class="text-sm text-sa-text font-semibold break-all">
        {{ resolvedAccountId || t("didPanel.unresolved", "unresolved") }}
      </p>
    </div>
  </div>

  <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
    <div class="rounded-xl border border-sa-border bg-sa-panel/40 p-4">
      <p class="text-xs uppercase text-sa-muted font-bold mb-1">
        {{ t("didPanel.linkedAccounts", "Linked Accounts") }}
      </p>
      <p class="text-sm text-sa-text font-semibold">
        {{ linkedAccountsLabel }}
      </p>
    </div>
    <div class="rounded-xl border border-sa-border bg-sa-panel/40 p-4">
      <p class="text-xs uppercase text-sa-muted font-bold mb-1">
        {{ t("didPanel.emailNotice", "Email Notice") }}
      </p>
      <p class="text-sm text-sa-text font-semibold">
        {{ didProfile?.email || t("didPanel.unavailable", "unavailable") }}
      </p>
    </div>
    <div class="rounded-xl border border-sa-border bg-sa-panel/40 p-4">
      <p class="text-xs uppercase text-sa-muted font-bold mb-1">
        {{ t("didPanel.smsNotice", "SMS Notice") }}
      </p>
      <p class="text-sm text-sa-text font-semibold">
        {{ didProfile?.phone || t("didPanel.unavailable", "unavailable") }}
      </p>
    </div>
    <div class="rounded-xl border border-sa-border bg-sa-panel/40 p-4">
      <p class="text-xs uppercase text-sa-muted font-bold mb-1">
        {{ t("didPanel.emailChannel", "Email Channel") }}
      </p>
      <p class="text-sm text-sa-text font-semibold">
        {{
          canEmailNotice
            ? t("didPanel.enabled", "enabled")
            : t("didPanel.disabled", "disabled")
        }}
      </p>
    </div>
    <div class="rounded-xl border border-sa-border bg-sa-panel/40 p-4">
      <p class="text-xs uppercase text-sa-muted font-bold mb-1">
        {{ t("didPanel.smsChannel", "SMS Channel") }}
      </p>
      <p class="text-sm text-sa-text font-semibold">
        {{
          canSmsNotice
            ? t("didPanel.enabled", "enabled")
            : t("didPanel.disabled", "disabled")
        }}
      </p>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

defineProps({
  didProfile: {
    type: Object,
    default: null,
  },
  serviceDid: {
    type: String,
    default: "",
  },
  resolvedAccountId: {
    type: String,
    default: "",
  },
  linkedAccountsLabel: {
    type: String,
    default: "",
  },
  canEmailNotice: {
    type: Boolean,
    default: false,
  },
  canSmsNotice: {
    type: Boolean,
    default: false,
  },
});

const { t } = useI18n();
</script>

<template>
  <div
    class="bg-gradient-to-r from-sa-success/10 to-sa-panel/60 rounded-lg p-5 border border-sa-orange/30 shadow-sm relative overflow-hidden backdrop-blur-sm"
  >
    <div class="absolute left-0 top-0 bottom-0 w-1 bg-sa-orange"></div>
    <div class="flex items-center justify-between mb-4">
      <h3
        class="text-xs font-bold text-sa-orange uppercase font-outfit flex items-center gap-2"
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
            d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
          ></path>
        </svg>
        {{ t("studioPanels.currentV3State", "Current V3 State") }}
      </h3>
      <span class="text-xs text-sa-muted">{{ snapshot.loadedAt }}</span>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-sm">
      <div class="rounded-lg bg-sa-dark/40 p-3 border border-sa-border/40">
        <span class="block text-sa-muted text-xs mb-1">{{
          t("studioPanels.accountIdLabel", "AccountId")
        }}</span>
        <div class="flex items-center">
          <span class="font-semibold text-sa-text break-all text-xs flex-1">{{
            snapshot.accountId || t("studioPanels.unset", "unset")
          }}</span>
          <button
            v-if="snapshot.accountId"
            :aria-label="t('studioPanels.copyAccountId', 'Copy AccountId')"
            @click="
              copyText(snapshot.accountId);
              markCopied('governanceAccountId');
            "
            class="ml-1.5 text-sa-muted hover:text-sa-text transition-colors duration-200 flex-shrink-0"
          >
            <svg
              aria-hidden="true"
              v-if="copiedKey !== 'governanceAccountId'"
              xmlns="http://www.w3.org/2000/svg"
              class="h-3.5 w-3.5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
              <path
                d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"
              />
            </svg>
            <svg
              aria-hidden="true"
              v-else
              xmlns="http://www.w3.org/2000/svg"
              class="h-3.5 w-3.5 text-sa-success"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fill-rule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>
      <div class="rounded-lg bg-sa-dark/40 p-3 border border-sa-border/40">
        <span class="block text-sa-muted text-xs mb-1">{{
          t("studioPanels.verifierLabel", "Verifier")
        }}</span>
        <div class="flex items-center">
          <span class="font-semibold text-sa-text break-all text-xs flex-1">{{
            snapshot.verifier || t("studioPanels.unset", "unset")
          }}</span>
          <button
            v-if="snapshot.verifier"
            :aria-label="t('studioPanels.copyVerifier', 'Copy Verifier')"
            @click="
              copyText(snapshot.verifier);
              markCopied('governanceVerifier');
            "
            class="ml-1.5 text-sa-muted hover:text-sa-text transition-colors duration-200 flex-shrink-0"
          >
            <svg
              aria-hidden="true"
              v-if="copiedKey !== 'governanceVerifier'"
              xmlns="http://www.w3.org/2000/svg"
              class="h-3.5 w-3.5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
              <path
                d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"
              />
            </svg>
            <svg
              aria-hidden="true"
              v-else
              xmlns="http://www.w3.org/2000/svg"
              class="h-3.5 w-3.5 text-sa-success"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fill-rule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>
      <div class="rounded-lg bg-sa-dark/40 p-3 border border-sa-border/40">
        <span class="block text-sa-muted text-xs mb-1">{{
          t("studioPanels.hookLabel", "Hook")
        }}</span>
        <div class="flex items-center">
          <span class="font-semibold text-sa-text break-all text-xs flex-1">{{
            snapshot.hook || t("studioPanels.unset", "unset")
          }}</span>
          <button
            v-if="snapshot.hook"
            :aria-label="t('studioPanels.copyHook', 'Copy Hook')"
            @click="
              copyText(snapshot.hook);
              markCopied('governanceHook');
            "
            class="ml-1.5 text-sa-muted hover:text-sa-text transition-colors duration-200 flex-shrink-0"
          >
            <svg
              aria-hidden="true"
              v-if="copiedKey !== 'governanceHook'"
              xmlns="http://www.w3.org/2000/svg"
              class="h-3.5 w-3.5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
              <path
                d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"
              />
            </svg>
            <svg
              aria-hidden="true"
              v-else
              xmlns="http://www.w3.org/2000/svg"
              class="h-3.5 w-3.5 text-sa-success"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fill-rule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>
      <div class="rounded-lg bg-sa-dark/40 p-3 border border-sa-border/40">
        <span class="block text-sa-muted text-xs mb-1">{{
          t("studioPanels.backupOwnerLabel", "Backup Owner")
        }}</span>
        <div class="flex items-center">
          <span class="font-semibold text-sa-text break-all text-xs flex-1">{{
            snapshot.backupOwner || t("studioPanels.unset", "unset")
          }}</span>
          <button
            v-if="snapshot.backupOwner"
            :aria-label="t('studioPanels.copyBackupOwner', 'Copy Backup Owner')"
            @click="
              copyText(snapshot.backupOwner);
              markCopied('governanceBackupOwner');
            "
            class="ml-1.5 text-sa-muted hover:text-sa-text transition-colors duration-200 flex-shrink-0"
          >
            <svg
              aria-hidden="true"
              v-if="copiedKey !== 'governanceBackupOwner'"
              xmlns="http://www.w3.org/2000/svg"
              class="h-3.5 w-3.5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
              <path
                d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"
              />
            </svg>
            <svg
              aria-hidden="true"
              v-else
              xmlns="http://www.w3.org/2000/svg"
              class="h-3.5 w-3.5 text-sa-success"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fill-rule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>
      <div class="rounded-lg bg-sa-dark/40 p-3 border border-sa-border/40">
        <span class="block text-sa-muted text-xs mb-1">{{
          t("studioPanels.escapeTimelockLabel", "Escape Timelock")
        }}</span>
        <span class="font-semibold text-sa-text text-xs"
          >{{ snapshot.escapeTimelock || 0 }}
          {{ t("studioPanels.sec", "sec") }}</span
        >
      </div>
      <div class="rounded-lg bg-sa-dark/40 p-3 border border-sa-border/40">
        <span class="block text-sa-muted text-xs mb-1">{{
          t("studioPanels.escapeStateLabel", "Escape State")
        }}</span>
        <span
          class="font-semibold text-xs"
          :class="
            snapshot.escapeActive ? 'text-sa-warning' : 'text-sa-success'
          "
        >
          {{
            snapshot.escapeActive
              ? `${t("studioPanels.activeAt", "active @")} ${snapshot.escapeTriggeredAt}`
              : t("studioPanels.inactive", "inactive")
          }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";
import { useClipboard } from "@/composables/useClipboard";

const { t } = useI18n();
const { copiedKey, markCopied, copyText } = useClipboard();

defineProps({
  snapshot: {
    type: Object,
    required: true,
  },
});
</script>

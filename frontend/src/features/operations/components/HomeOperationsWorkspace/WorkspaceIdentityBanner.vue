<template>
  <div
    class="mb-8 rounded-2xl border border-sa-info/20 bg-sa-info/5 p-5 backdrop-blur-md"
  >
    <div
      class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"
    >
      <div>
        <p class="text-xs font-bold uppercase text-sa-info">
          {{ t("operations.identityWorkspaceLabel", "Identity Workspace") }}
        </p>
        <p class="mt-2 text-sm leading-6 text-sa-text">
          {{
            t(
              "operations.identityWorkspaceHint",
              "Web3Auth login, NeoDID bind, recovery, and private-session controls now live in a separate route so the main SA workspace stays lighter and faster.",
            )
          }}
        </p>
        <p class="mt-2 text-xs text-sa-muted">
          {{
            isDidConnected
              ? t(
                  "operations.identityWorkspaceConnected",
                  "DID connected and ready for NeoDID actions.",
                )
              : t(
                  "operations.identityWorkspaceDisconnected",
                  "Open the identity workspace when you need login or NeoDID operations.",
                )
          }}
        </p>
      </div>
      <router-link class="btn-secondary" :to="identityWorkspaceLink">
        {{
          t("operations.openIdentityWorkspace", "Open Identity Workspace")
        }}
      </router-link>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

defineProps({
  isDidConnected: {
    type: Boolean,
    default: false,
  },
  identityWorkspaceLink: {
    type: [Object, String],
    required: true,
  },
});

const { t } = useI18n();
</script>

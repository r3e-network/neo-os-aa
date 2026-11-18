<template>
  <div class="empty-state">
    <EmptyStateArt
      :size="150"
      class="mx-auto mb-2"
      :title="t('security.noAccountLoaded', 'No account loaded')"
    />
    <p class="text-sm text-sa-text font-medium mb-1">
      {{ t("security.noAccountLoaded", "No account loaded") }}
    </p>
    <p class="text-xs text-sa-muted">
      {{
        t(
          "security.loadAccountForSecurity",
          "Load an account to view its security dashboard.",
        )
      }}
    </p>
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";
import { EmptyStateArt } from "@/components/illustrations";

const { t } = useI18n();
</script>

<template>
  <div class="empty-state">
    <EmptyStateArt
      :size="150"
      class="mx-auto mb-2"
      :title="t('studioPanels.noAccountLoaded', 'No account loaded')"
    />
    <p class="text-sm text-sa-text font-medium mb-1">
      {{ t("studioPanels.noAccountLoaded", "No account loaded") }}
    </p>
    <p class="text-xs text-sa-muted">
      {{
        t(
          "studioPanels.loadAccountHint",
          'Enter an accountId hash above and click "Load V3 State" to get started.',
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

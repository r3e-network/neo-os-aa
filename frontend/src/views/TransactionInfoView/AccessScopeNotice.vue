<template>
  <div
    v-if="hasDraft && accessScope === 'read'"
    class="mb-6 rounded-lg border border-sa-warning/30 bg-sa-warning/10 px-4 py-3 text-sm text-sa-warning font-medium"
  >
    {{
      t(
        "sharedDraft.readOnlyNotice",
        "This shared draft is read-only. Open the Collaborator Link to sign, or the Operator Link to manage relay and broadcast actions.",
      )
    }}
  </div>
  <div
    v-else-if="hasDraft && accessScope === 'sign'"
    class="mb-6 rounded-lg border border-sa-info/30 bg-sa-info/10 px-4 py-3 text-sm text-sa-info font-medium"
  >
    {{
      t(
        "sharedDraft.signatureOnlyNotice",
        "This is a signature-only link. Relay checks, broadcasts, and link rotation require the Operator Link.",
      )
    }}
  </div>
</template>

<script setup>
import { useI18n } from "@/i18n";

const { t } = useI18n();

defineProps({
  accessScope: { type: String, default: "read" },
  hasDraft: { type: Boolean, default: false },
});
</script>

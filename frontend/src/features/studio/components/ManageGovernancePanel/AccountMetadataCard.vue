<template>
  <div class="card hover:border-aa-muted transition-colors duration-200">
    <h3 class="text-sm font-bold text-aa-text mb-2">
      {{ t("studioPanels.metadataTitle", "Account Metadata") }}
    </h3>
    <p class="text-xs text-aa-muted mb-5">
      {{
        t(
          "studioPanels.metadataSubtitle",
          "Set a description, logo, and off-chain metadata URI for this account.",
        )
      }}
    </p>
    <div class="space-y-4">
      <div>
        <label
          for="governance-metadata-uri"
          class="block text-xs font-semibold text-aa-muted mb-1"
          >{{
            t(
              "studioPanels.metadataUriLabel",
              "Metadata URI (on-chain, max 240 chars)",
            )
          }}</label
        >
        <input
          id="governance-metadata-uri"
          :value="metadataUri"
          @input="$emit('update:metadataUri', $event.target.value)"
          type="text"
          class="input-field font-mono text-sm py-2 px-3 bg-aa-dark"
          :placeholder="
            t(
              'studioPanels.metadataUriPlaceholder',
              'https://example.com/metadata.json',
            )
          "
        />
        <p class="mt-1 text-xs text-aa-muted">
          {{ metadataUri.length }} / 240 —
          {{
            t(
              "studioPanels.metadataUriHint",
              "Points to a JSON file with extended account details.",
            )
          }}
        </p>
      </div>
      <div>
        <label
          for="governance-description"
          class="block text-xs font-semibold text-aa-muted mb-1"
          >{{
            t(
              "studioPanels.descriptionLabel",
              "Description (off-chain, max 500 chars)",
            )
          }}</label
        >
        <textarea
          id="governance-description"
          :value="description"
          @input="$emit('update:description', $event.target.value)"
          class="input-field font-mono text-sm py-2 px-3 bg-aa-dark min-h-20 resize-y"
          :placeholder="
            t(
              'studioPanels.descriptionPlaceholder',
              'A brief description of this account...',
            )
          "
        ></textarea>
        <p class="mt-1 text-xs text-aa-muted">
          {{ description.length }} / 500
        </p>
      </div>
      <div>
        <label
          for="governance-logo-url"
          class="block text-xs font-semibold text-aa-muted mb-1"
          >{{
            t("studioPanels.logoUrlLabel", "Logo URL (off-chain, HTTPS only)")
          }}</label
        >
        <div class="flex items-center gap-3">
          <input
            id="governance-logo-url"
            :value="logoUrl"
            @input="$emit('update:logoUrl', $event.target.value)"
            type="text"
            class="input-field font-mono text-sm py-2 px-3 bg-aa-dark flex-1"
            :placeholder="
              t(
                'studioPanels.logoUrlPlaceholder',
                'https://example.com/logo.png',
              )
            "
          />
          <img
            v-if="logoUrl"
            :src="logoUrl"
            :alt="t('studioPanels.logoPreview', 'Logo preview')"
            class="w-8 h-8 rounded border border-aa-border object-cover"
            @error="$event.target.style.display = 'none'"
          />
        </div>
        <div class="mt-2 flex items-center gap-2">
          <input
            ref="logoFileInput"
            type="file"
            accept="image/*"
            class="hidden"
            @change="handleLogoUpload"
          />
          <button
            type="button"
            :aria-label="t('studioPanels.ariaUploadLogo', 'Upload logo')"
            class="btn-secondary text-xs"
            :class="{ 'btn-loading': logoUploading }"
            :disabled="logoUploading"
            @click="$refs.logoFileInput.click()"
          >
            {{
              logoUploading
                ? t("studioPanels.uploadingLogo", "Uploading...")
                : t("studioPanels.uploadToNeoFS", "Upload to NeoFS")
            }}
          </button>
          <span class="text-xs text-aa-muted">{{
            t(
              "studioPanels.uploadLogoHint",
              "Upload an image to NeoFS and set the URL automatically.",
            )
          }}</span>
        </div>
      </div>
      <button
        type="button"
        :aria-label="t('studioPanels.ariaSaveMetadata', 'Save metadata')"
        class="btn-primary w-full"
        :class="{ 'btn-loading': busy }"
        :disabled="disabled"
        @click="$emit('save')"
      >
        {{
          busy
            ? t("studioPanels.savingMetadata", "Saving...")
            : t("studioPanels.saveMetadata", "Save Metadata")
        }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref } from "vue";
import { useI18n } from "@/i18n";
import { useToast } from "vue-toastification";
import { uploadToNeoFS } from "@/utils/neofsUpload.js";
import { translateError } from "@/config/errorCodes.js";

const { t } = useI18n();
const toast = useToast();

defineProps({
  metadataUri: {
    type: String,
    default: "",
  },
  description: {
    type: String,
    default: "",
  },
  logoUrl: {
    type: String,
    default: "",
  },
  busy: {
    type: Boolean,
    default: false,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits([
  "update:metadataUri",
  "update:description",
  "update:logoUrl",
  "save",
]);

const logoFileInput = ref(null);
const logoUploading = ref(false);

async function handleLogoUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  logoUploading.value = true;
  try {
    const url = await uploadToNeoFS(file);
    emit("update:logoUrl", url);
  } catch (err) {
    toast.error(translateError(err?.message, t));
  } finally {
    logoUploading.value = false;
    if (logoFileInput.value) logoFileInput.value.value = "";
  }
}
</script>

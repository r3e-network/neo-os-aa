<template>
  <details class="rounded-xl border border-aa-border bg-aa-panel p-4 my-4">
    <summary class="cursor-pointer font-semibold text-sm text-aa-text">{{ t('operatorBackup.title') }}</summary>
    <p class="text-sm text-aa-muted my-3">{{ t('operatorBackup.description') }}</p>
    <div class="grid gap-3">
      <label class="text-sm text-aa-text">
        <span class="block mb-1">{{ t('operatorBackup.password') }}</span>
        <input v-model="passphrase" type="password" autocomplete="new-password" maxlength="1024"
          :disabled="busy" class="w-full rounded-lg border border-aa-border bg-aa-dark px-3 py-2" />
      </label>
      <label class="text-sm text-aa-text">
        <span class="block mb-1">{{ t('operatorBackup.confirmPassword') }}</span>
        <input v-model="confirmation" type="password" autocomplete="new-password" maxlength="1024"
          :disabled="busy" class="w-full rounded-lg border border-aa-border bg-aa-dark px-3 py-2" />
      </label>
      <button type="button" class="btn-secondary" :disabled="busy || passphrase.length < 12 || !confirmation" @click="exportBackup">
        {{ t('operatorBackup.export') }}
      </button>
      <label class="text-sm text-aa-text">
        <span class="block mb-1">{{ t('operatorBackup.file') }}</span>
        <input ref="fileInput" type="file" accept=".json,application/json" :disabled="busy" @change="selectFile" class="w-full text-sm" />
      </label>
      <button type="button" class="btn-secondary" :disabled="busy || !selectedFile || !passphrase" @click="importBackup">
        {{ t('operatorBackup.import') }}
      </button>
      <p v-if="errorKey" role="alert" class="text-sm text-red-500">{{ t(errorKey) }}</p>
      <p v-if="successKey" role="status" class="text-sm text-emerald-600">{{ t(successKey) }}</p>
    </div>
  </details>
</template>

<script setup>
import { ref, shallowRef, watch } from 'vue';
import { useI18n } from '@/i18n';
import { createOperatorMutationTransport } from '../operatorMutationTransport.js';
import { downloadJsonFile } from '../viewActions.js';

const props = defineProps({ shareSlug: { type: String, required: true }, accessSlug: { type: String, required: true } });
const { t } = useI18n();
const transport = createOperatorMutationTransport();
const passphrase = ref('');
const confirmation = ref('');
const busy = ref(false);
const errorKey = ref('');
const successKey = ref('');
const selectedFile = shallowRef(null);
const fileInput = ref(null);
const errorKeys = {
  EC_operator_key_storage_unavailable: 'operatorBackup.storageUnavailable',
  EC_operator_key_storage_corrupt: 'operatorBackup.storageCorrupt',
  EC_operator_key_recovery_required: 'operatorBackup.recoveryRequired',
  EC_operator_backup_invalid: 'operatorBackup.invalidBackup',
  EC_operator_backup_wrong_draft: 'operatorBackup.wrongDraft',
  EC_operator_backup_password_weak: 'operatorBackup.weakPassword',
};

function clearSecrets() {
  passphrase.value = '';
  confirmation.value = '';
  selectedFile.value = null;
  if (fileInput.value) fileInput.value.value = '';
}

watch(() => props.shareSlug, () => { clearSecrets(); errorKey.value = ''; successKey.value = ''; });

function selectFile(event) {
  errorKey.value = ''; successKey.value = '';
  const file = event.target.files?.[0];
  if (file && file.size > 16_384) {
    selectedFile.value = null;
    event.target.value = '';
    errorKey.value = 'operatorBackup.invalidBackup';
    return;
  }
  selectedFile.value = file || null;
}

async function run(operation, success) {
  if (busy.value) return;
  busy.value = true; errorKey.value = ''; successKey.value = '';
  const draft = props.shareSlug;
  try {
    await operation({ shareSlug: draft, accessSlug: props.accessSlug, passphrase: passphrase.value });
    if (props.shareSlug === draft) successKey.value = success;
  } catch (err) {
    if (props.shareSlug === draft) errorKey.value = errorKeys[err?.message] || 'operatorBackup.failed';
  } finally {
    clearSecrets(); busy.value = false;
  }
}

async function exportBackup() {
  successKey.value = '';
  if (passphrase.value !== confirmation.value) { errorKey.value = 'operatorBackup.mismatch'; return; }
  await run(async (args) => {
    const backup = await transport.exportBackup(args);
    if (!downloadJsonFile(backup, { filename: 'neo-aa-operator-backup.json' })) throw new Error('download_failed');
  }, 'operatorBackup.exported');
}

async function importBackup() {
  const file = selectedFile.value;
  if (!file) return;
  await run(async (args) => {
    if (file.size > 16_384) throw new Error('EC_operator_backup_invalid');
    await transport.importBackup({ ...args, backup: await file.text() });
  }, 'operatorBackup.imported');
}
</script>

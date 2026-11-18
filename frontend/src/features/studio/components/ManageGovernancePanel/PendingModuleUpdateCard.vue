<template>
  <section class="card space-y-3" :data-testid="`custom-pending-${role}`">
    <h3 class="text-sm font-bold text-sa-text">{{ role === 'verifier' ? t('custom.pendingVerifier', 'Pending verifier update') : t('custom.pendingHook', 'Pending hook update') }}</h3>
    <p v-if="!pending?.exists" class="text-sm text-sa-muted">{{ t('custom.noPending', 'No pending update.') }}</p>
    <template v-else>
      <dl v-if="pending.full" class="space-y-2 text-xs">
        <div><dt class="text-sa-muted">{{ t('custom.pendingTarget', 'Pending module') }}</dt><dd class="font-mono break-all">0x{{ pending.module }}</dd></div>
        <div><dt class="text-sa-muted">{{ t('custom.pendingParams', 'Initialization parameters (hex)') }}</dt><dd class="font-mono break-all">{{ pending.params ? `0x${pending.params}` : t('custom.emptyParams', 'Empty') }}</dd></div>
        <div><dt class="text-sa-muted">{{ t('custom.initiatedAt', 'Initiated at') }}</dt><dd>{{ formatTime(pending.initiatedAt) }}</dd></div>
      </dl>
      <p v-else class="text-sm text-sa-warning" role="status">{{ t('custom.pendingUnavailable', 'This deployment cannot show the pending target and parameters. Confirmation is unavailable.') }}</p>
      <p class="text-xs text-sa-muted">{{ t('custom.maturesAt', 'Matures at') }}: {{ formatTime(pending.matureAt) }}</p>
      <p class="text-xs" :class="chainTime >= pending.matureAt ? 'text-sa-success' : 'text-sa-warning'">{{ chainTime >= pending.matureAt ? t('custom.mature', 'Mature at the last node refresh.') : t('custom.waiting', 'Waiting for the timelock. Refresh node state after the deadline.') }}</p>
      <div class="flex flex-wrap gap-3">
        <button type="button" class="btn-primary" :disabled="!canConfirm" @click="$emit('confirm')">{{ role === 'verifier' ? t('custom.confirmVerifier', 'Confirm verifier update') : t('custom.confirmHook', 'Confirm hook update') }}</button>
        <button type="button" class="btn-secondary" :disabled="!canCancel" @click="$emit('cancel')">{{ role === 'verifier' ? t('custom.cancelVerifier', 'Cancel verifier update') : t('custom.cancelHook', 'Cancel hook update') }}</button>
      </div>
    </template>
  </section>
</template>
<script setup>
import { useI18n } from '@/i18n';
const { t } = useI18n();
defineProps({ role: String, pending: Object, chainTime: Number, canConfirm: Boolean, canCancel: Boolean });
defineEmits(['confirm', 'cancel']);
const formatTime = (value) => Number.isSafeInteger(value) && value > 0 ? new Date(value).toISOString() : '—';
</script>

<template>
  <section class="card space-y-3" :data-testid="`ordinary-pending-${role}`">
    <h3 class="text-sm font-bold text-aa-text">{{ role === 'verifier' ? t('ordinary.pendingVerifier', 'Pending verifier update') : t('ordinary.pendingHook', 'Pending hook update') }}</h3>
    <p v-if="!pending?.exists" class="text-sm text-aa-muted">{{ t('ordinary.noPending', 'No pending update.') }}</p>
    <template v-else>
      <dl v-if="pending.full" class="space-y-2 text-xs">
        <div><dt class="text-aa-muted">{{ t('ordinary.pendingTarget', 'Pending module') }}</dt><dd class="font-mono break-all">0x{{ pending.module }}</dd></div>
        <div><dt class="text-aa-muted">{{ t('ordinary.pendingParams', 'Initialization parameters (hex)') }}</dt><dd class="font-mono break-all">{{ pending.params ? `0x${pending.params}` : t('ordinary.emptyParams', 'Empty') }}</dd></div>
        <div><dt class="text-aa-muted">{{ t('ordinary.initiatedAt', 'Initiated at') }}</dt><dd>{{ formatTime(pending.initiatedAt) }}</dd></div>
      </dl>
      <p v-else class="text-sm text-aa-warning" role="status">{{ t('ordinary.pendingUnavailable', 'This deployment cannot show the pending target and parameters. Confirmation is unavailable.') }}</p>
      <p class="text-xs text-aa-muted">{{ t('ordinary.maturesAt', 'Matures at') }}: {{ formatTime(pending.matureAt) }}</p>
      <p class="text-xs" :class="chainTime >= pending.matureAt ? 'text-aa-success' : 'text-aa-warning'">{{ chainTime >= pending.matureAt ? t('ordinary.mature', 'Mature at the last node refresh.') : t('ordinary.waiting', 'Waiting for the timelock. Refresh node state after the deadline.') }}</p>
      <div class="flex flex-wrap gap-3">
        <button type="button" class="btn-primary" :disabled="!canConfirm" @click="$emit('confirm')">{{ role === 'verifier' ? t('ordinary.confirmVerifier', 'Confirm verifier update') : t('ordinary.confirmHook', 'Confirm hook update') }}</button>
        <button type="button" class="btn-secondary" :disabled="!canCancel" @click="$emit('cancel')">{{ role === 'verifier' ? t('ordinary.cancelVerifier', 'Cancel verifier update') : t('ordinary.cancelHook', 'Cancel hook update') }}</button>
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

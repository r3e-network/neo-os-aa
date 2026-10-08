import { selectSignedInvocation } from './signedInvocation.js';

export function evaluateRelayReadiness({ runtime = {}, transactionBody = {}, signatures = [], t } = {}) {
  if (!runtime?.relayEnabled) {
    return {
      level: 'blocked',
      mode: 'none',
      isReady: false,
      payloadReady: false,
      label: t ? t('sharedDraft.relayBlocked', 'Relay Blocked') : 'Relay Blocked',
      detail: t ? t('sharedDraft.relayEndpointNotConfigured', 'Relay endpoint is not configured.') : 'Relay endpoint is not configured.',
    };
  }

  let metaInvocation;
  try {
    metaInvocation = selectSignedInvocation({ transactionBody, signatures, morpheusNetwork: runtime.morpheusNetwork, networkMagic: runtime.networkMagic });
  } catch (error) {
    return {
      level: 'blocked', mode: 'none', isReady: false, payloadReady: false,
      label: t ? t('sharedDraft.relayBlocked', 'Relay Blocked') : 'Relay Blocked',
      detail: error.message,
    };
  }

  if (transactionBody?.rawTransaction || transactionBody?.raw_transaction || transactionBody?.txHex) {
    if (runtime?.relayRawEnabled) {
      return {
        level: 'warning',
        mode: 'raw',
        isReady: false,
        payloadReady: true,
        label: t ? t('sharedDraft.relayPayloadReady', 'Relay Payload Ready') : 'Relay Payload Ready',
        detail: t ? t('sharedDraft.rawTxReady', 'Signed raw transaction is staged. Run Relay Preflight to verify the server signer and runtime credentials before submission.') : 'Signed raw transaction is staged. Run Relay Preflight to verify the server signer and runtime credentials before submission.',
      };
    }

    return {
      level: 'warning',
      mode: 'raw',
      isReady: false,
      payloadReady: false,
      label: t ? t('sharedDraft.relayPending', 'Relay Pending') : 'Relay Pending',
      detail: t ? t('sharedDraft.rawTxPending', 'Signed raw transaction is collected; enable raw relay forwarding to submit it through the relay.') : 'Signed raw transaction is collected; enable raw relay forwarding to submit it through the relay.',
    };
  }

  if (metaInvocation) {
    if (runtime?.relayMetaEnabled) {
      return {
        level: 'warning',
        mode: 'meta',
        isReady: false,
        payloadReady: true,
        label: t ? t('sharedDraft.relayPayloadReady', 'Relay Payload Ready') : 'Relay Payload Ready',
        detail: t ? t('sharedDraft.metaReady', 'Relay invocation is staged. Run Relay Preflight to verify the server signer and runtime credentials before submission.') : 'Relay invocation is staged. Run Relay Preflight to verify the server signer and runtime credentials before submission.',
      };
    }

    return {
      level: 'warning',
      mode: 'meta',
      isReady: false,
      payloadReady: false,
      label: t ? t('sharedDraft.relayPending', 'Relay Pending') : 'Relay Pending',
      detail: t ? t('sharedDraft.metaPending', 'Relay invocation is collected; enable relay invocation mode to submit it directly.') : 'Relay invocation is collected; enable relay invocation mode to submit it directly.',
    };
  }

  return {
    level: 'blocked',
    mode: 'none',
    isReady: false,
    payloadReady: false,
    label: t ? t('sharedDraft.relayBlocked', 'Relay Blocked') : 'Relay Blocked',
    detail: t ? t('sharedDraft.noSignedTransaction', 'No signed raw transaction or relay-ready invocation is available yet.') : 'No signed raw transaction or relay-ready invocation is available yet.',
  };
}

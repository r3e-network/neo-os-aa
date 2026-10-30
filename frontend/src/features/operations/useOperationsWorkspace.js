import { computed, ref } from 'vue';
import { EC } from '../../config/errorCodes.js';
import { DEFAULT_BROADCAST_MODE, DEFAULT_DRAFT_STATUS, SUPPORTED_BROADCAST_MODES } from './constants.js';
import { cloneImmutable, deriveAccountForms } from './helpers.js';
import { buildDraftCollaborationPath, buildDraftSharePath } from './shareLinks.js';

function resolveSharePaths({ shareSlug = '', draftId = '', collaborationSlug = '', operatorSlug = '' } = {}) {
  const slug = shareSlug || draftId;
  return {
    sharePath: slug ? buildDraftSharePath(slug) : '',
    collaborationPath: slug && collaborationSlug ? buildDraftCollaborationPath(slug, collaborationSlug) : '',
    operatorPath: slug && operatorSlug ? buildDraftCollaborationPath(slug, operatorSlug) : '',
  };
}

export function createOperationsWorkspace() {
  const account = ref({
    accountAddressScriptHash: '',
    accountSignerScriptHash: '',
  });
  const operationBody = ref(null);
  const transactionBody = ref(null);
  const signerRequirements = ref([]);
  const signatures = ref([]);
  const share = ref({
    draftId: '',
    shareSlug: '',
    sharePath: '',
    collaborationSlug: '',
    collaborationPath: '',
    operatorSlug: '',
    operatorPath: '',
    canWrite: false,
    canOperate: false,
    accessScope: 'read',
    status: DEFAULT_DRAFT_STATUS,
  });
  const broadcast = ref({
    mode: DEFAULT_BROADCAST_MODE,
  });

  const isDraftImmutable = computed(() => Boolean(share.value.draftId));

  function loadSmartAccount(input) {
    account.value = {
      ...account.value,
      ...deriveAccountForms(input),
    };
  }

  function setOperationBody(value) {
    operationBody.value = cloneImmutable(value);
  }

  function setTransactionBody(value) {
    if (isDraftImmutable.value) {
      throw new Error(`${EC.immutableDraftBody}: immutable draft transaction body cannot be changed after persistence`);
    }
    transactionBody.value = cloneImmutable(value);
  }

  function setSignerRequirements(items = []) {
    signerRequirements.value = cloneImmutable(items);
  }

  function appendSignature(signature) {
    const next = cloneImmutable(signature);
    const alreadyPresent = signatures.value.some(
      (item) => item.signerId === next.signerId && item.kind === next.kind
    );
    if (!alreadyPresent) {
      signatures.value = [...signatures.value, next];
    }
  }

  function replaceSignatures(items = []) {
    signatures.value = cloneImmutable(items);
  }

  function setBroadcastMode(mode) {
    if (!SUPPORTED_BROADCAST_MODES.includes(mode)) {
      throw new Error(EC.broadcastModeUnsupported);
    }
    broadcast.value = { ...broadcast.value, mode };
  }

  function markPersisted({
    draftId,
    shareSlug,
    collaborationSlug = '',
    operatorSlug = '',
    canWrite = false,
    canOperate = false,
    accessScope = 'read',
    status = DEFAULT_DRAFT_STATUS,
  }) {
    const paths = resolveSharePaths({ draftId, shareSlug, collaborationSlug, operatorSlug });
    share.value = {
      draftId,
      shareSlug,
      collaborationSlug,
      operatorSlug,
      canWrite: Boolean(canWrite || collaborationSlug || operatorSlug),
      canOperate: Boolean(canOperate || operatorSlug),
      accessScope,
      ...paths,
      status,
    };
  }

  function setShareStatus(status = DEFAULT_DRAFT_STATUS) {
    share.value = {
      ...share.value,
      status,
    };
  }

  function hydrateDraft(record = {}) {
    account.value = {
      ...account.value,
      ...deriveAccountForms(record.account || {}),
    };
    operationBody.value = cloneImmutable(record.operation_body || null);
    transactionBody.value = cloneImmutable(record.transaction_body || null);
    signerRequirements.value = cloneImmutable(record.signer_requirements || []);
    signatures.value = cloneImmutable(record.signatures || []);
    broadcast.value = {
      mode: record.broadcast_mode || DEFAULT_BROADCAST_MODE,
    };

    const accessScope = record.access_scope || (record.can_operate ? 'operate' : record.can_write ? 'sign' : 'read');
    const collaborationSlug = record.can_write ? (record.collaboration_slug || share.value.collaborationSlug || '') : '';
    const operatorSlug = record.can_operate ? (record.operator_slug || share.value.operatorSlug || '') : '';
    const shareSlug = record.share_slug || '';
    const paths = resolveSharePaths({
      draftId: record.draft_id || '',
      shareSlug,
      collaborationSlug,
      operatorSlug,
    });
    share.value = {
      draftId: record.draft_id || '',
      shareSlug,
      collaborationSlug,
      operatorSlug,
      canWrite: Boolean(record.can_write),
      canOperate: Boolean(record.can_operate),
      accessScope,
      sharePath: record.share_path || paths.sharePath,
      collaborationPath: record.can_write ? (record.collaboration_path || paths.collaborationPath) : '',
      operatorPath: record.can_operate ? (record.operator_path || paths.operatorPath) : '',
      status: record.status || DEFAULT_DRAFT_STATUS,
    };
  }

  return {
    account,
    operationBody,
    transactionBody,
    signerRequirements,
    signatures,
    share,
    broadcast,
    isDraftImmutable,
    loadSmartAccount,
    setOperationBody,
    setTransactionBody,
    setSignerRequirements,
    appendSignature,
    replaceSignatures,
    setBroadcastMode,
    markPersisted,
    setShareStatus,
    hydrateDraft,
  };
}

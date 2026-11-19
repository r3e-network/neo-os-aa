export const STUDIO_TABS = [
  { key: 'operations', label: 'Operations Workspace', description: 'Load, compose, sign, share, and broadcast SA transactions' },
  { key: 'create', label: 'Create Account', description: 'Create a v4 account from a custody, a salt and its recovery timelock' },
  { key: 'manage', label: 'Manage Configuration', description: 'Install, configure and remove modules, hook order, and recovery policy' },
  { key: 'permissions', label: 'Module Calls', description: 'Call installed module methods directly' },
  { key: 'source', label: 'View Source', description: 'Browse the on-chain contract source files' }
];

export const RECENT_TRANSACTIONS_STORAGE_KEY = 'sa_recent_transactions';
export const DEFAULT_RECENT_TRANSACTIONS_LIMIT = 8;

export function createCreateFormState() {
  return {
    matrixDomain: '',
    custody: '',
    salt: '',
    recoveryTimelockDays: 30,
  };
}

export function createManageFormState() {
  return {
    accountAddress: '',
    // getAccount descriptor
    status: '',
    custody: '',
    recoveryAuthority: '',
    recoveryTimelockMs: '',
    authorityEpoch: '',
    configurationNonce: '',
    hookOrderRevision: '',
    defaultOperationAuthorization: true,
    defaultMessageAuthorization: true,
    ownerOnlyRecovery: false,
    recoveryPending: false,
    recoveryMatureAt: '',
    marketEscrowActive: false,
    // installed modules and the pending intent
    modules: [],
    hookIds: [],
    pendingIntent: null,
    // install / configure inputs
    moduleType: 'validator',
    moduleContract: '',
    moduleProfileDigest: '',
    moduleInitDataJson: '[]',
    selectedModuleId: '',
    moduleConfigJson: '[]',
    moduleDeInitDataJson: '[]',
    // policy inputs
    thresholdPolicyId: '0',
    threshold: '1',
    thresholdMembers: [],
    thresholdActive: true,
    recoveryPolicyAuthority: '',
    recoveryPolicyTimelockDays: 30,
    ownerOnlyAcknowledged: false,
    // recovery inputs
    newCustody: '',
  };
}

export function createPermissionsFormState() {
  return {
    accountAddress: '',
    moduleId: '',
    method: '',
    argsJson: '[]',
  };
}

export function createManageBusyState() {
  return {
    load: false,
    propose: false,
    confirm: false,
    cancel: false,
    recovery: false,
    freeze: false,
  };
}

export function createPermissionsBusyState() {
  return {
    call: false,
  };
}

export function createManageSnapshotState() {
  return {
    loadedAt: '',
  };
}

export function createMetadataFormState() {
  return {
    metadataUri: '',
    description: '',
    logoUrl: '',
  };
}

export function createMetadataBusyState() {
  return {
    load: false,
    save: false,
  };
}

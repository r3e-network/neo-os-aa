export const STUDIO_TABS = [
  { key: 'operations', label: 'Operations Workspace', description: 'Load, compose, sign, share, and broadcast AA transactions' },
  { key: 'create', label: 'Create Account', description: 'Deploy a new deterministic smart-contract account' },
  { key: 'manage', label: 'Manage Governance', description: 'Update verifier, hook, backup owner, and escape settings' },
  { key: 'permissions', label: 'Permissions & Limits', description: 'Call verifier and hook plugin methods directly' },
  { key: 'source', label: 'View Source', description: 'Browse the on-chain contract source files' }
];

export const RECENT_TRANSACTIONS_STORAGE_KEY = 'aa_recent_transactions';
export const DEFAULT_RECENT_TRANSACTIONS_LIMIT = 8;

export function createCreateFormState() {
  return {
    matrixDomain: '',
    verifierContract: '',
    verifierParams: '',
    hookContract: '',
    backupOwner: '',
    escapeTimelockDays: 30,
  };
}

export function createManageFormState() {
  return {
    accountAddress: '',
    verifierContract: '',
    verifierParams: '',
    hookContract: '',
    backupOwner: '',
    escapeTimelock: '',
    escapeTriggeredAt: '',
    escapeActive: false,
    escapeNewVerifier: '',
  };
}

export function createPermissionsFormState() {
  return {
    accountAddress: '',
    verifierMethod: '',
    verifierArgsJson: '[]',
    hookMethod: '',
    hookArgsJson: '[]',
  };
}

export function createManageBusyState() {
  return {
    load: false,
    hook: false,
    verifier: false,
    initiateEscape: false,
    finalizeEscape: false,
  };
}

export function createPermissionsBusyState() {
  return {
    verifierCall: false,
    hookCall: false,
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

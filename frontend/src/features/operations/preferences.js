export const DEFAULT_OPERATIONS_PREFERENCES = {
  relayPayloadMode: {},
  activityFilter: {},
};

export const OPERATIONS_PREFERENCES_STORAGE_KEY = 'sa_operations_preferences_v1';

const VALID_RELAY_PAYLOAD_MODES = new Set(['best', 'raw', 'meta']);
const VALID_ACTIVITY_FILTERS = new Set(['all', 'workflow', 'identity', 'signatures', 'relay', 'broadcast']);

function getStorageBackend(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage || null;
  } catch (err) {
    if (import.meta.env.DEV) console.warn('[preferences] localStorage access denied:', err?.message);
    return null;
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function readPreferences(storage) {
  const backend = getStorageBackend(storage);
  if (!backend) return clone(DEFAULT_OPERATIONS_PREFERENCES);
  const raw = backend.getItem(OPERATIONS_PREFERENCES_STORAGE_KEY);
  if (!raw) return clone(DEFAULT_OPERATIONS_PREFERENCES);

  try {
    const parsed = JSON.parse(raw);
    return {
      relayPayloadMode: { ...(parsed?.relayPayloadMode || {}) },
      activityFilter: { ...(parsed?.activityFilter || {}) },
    };
  } catch (err) {
    if (import.meta.env.DEV) console.warn('[preferences] Malformed preferences JSON:', err?.message);
    return clone(DEFAULT_OPERATIONS_PREFERENCES);
  }
}

function writePreferences(storage, value) {
  const backend = getStorageBackend(storage);
  if (!backend) return;
  backend.setItem(OPERATIONS_PREFERENCES_STORAGE_KEY, JSON.stringify(value));
}

export function createOperationsPreferences({ storage = null } = {}) {
  function getRelayPayloadMode(viewKey) {
    const preferences = readPreferences(storage);
    const value = preferences.relayPayloadMode?.[viewKey];
    return VALID_RELAY_PAYLOAD_MODES.has(value) ? value : 'best';
  }

  function setRelayPayloadMode(viewKey, mode) {
    if (!viewKey || !VALID_RELAY_PAYLOAD_MODES.has(mode)) return;
    const preferences = readPreferences(storage);
    preferences.relayPayloadMode[viewKey] = mode;
    writePreferences(storage, preferences);
  }

  function getActivityFilter(viewKey) {
    const preferences = readPreferences(storage);
    const value = preferences.activityFilter?.[viewKey];
    return VALID_ACTIVITY_FILTERS.has(value) ? value : 'all';
  }

  function setActivityFilter(viewKey, filterId) {
    if (!viewKey || !VALID_ACTIVITY_FILTERS.has(filterId)) return;
    const preferences = readPreferences(storage);
    preferences.activityFilter[viewKey] = filterId;
    writePreferences(storage, preferences);
  }

  return {
    getRelayPayloadMode,
    setRelayPayloadMode,
    getActivityFilter,
    setActivityFilter,
  };
}

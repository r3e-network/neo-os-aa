import { ref } from 'vue';

export const connectedDidProfile = ref(null);
const DID_STORAGE_KEY = 'aa_connected_did_profile';

export function setConnectedDidProfile(profile) {
  connectedDidProfile.value = profile || null;
}

export function hydrateConnectedDidProfileFromStorage() {
  if (typeof window === 'undefined' || connectedDidProfile.value?.did) {
    return connectedDidProfile.value;
  }

  try {
    // Historical localStorage records are display metadata, never login proof.
    window.localStorage.removeItem(DID_STORAGE_KEY);
  } catch {
    setConnectedDidProfile(null);
  }

  return connectedDidProfile.value;
}

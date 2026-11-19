// Test seam for loading the real studio controller without the browser wallet stack.
import { ref } from 'vue';

export const connectedAccount = ref('');
export const connectedDidProfile = ref(null);
export const walletService = {
  isConnected: false,
  address: '',
  async invokeMultiple() {
    return { txid: '' };
  },
};
export function getSmartAccountHash() {
  // A full 20-byte hash: a truncated one would make every derivation fail and
  // quietly hide that the create flow never derived anything.
  return '0268a387913250166ddec032b03332690a1ef781';
}
export function useToast() {
  return { error() {}, info() {}, success() {} };
}
export function useClipboard() {
  return { copiedKey: ref(''), markCopied() {}, async copyText() { return true; } };
}
export async function fetchAccountMetadata() { return null; }
export async function upsertAccountMetadata() {}

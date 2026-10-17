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
export function getAbstractAccountHash() {
  return '0268a387913250166ddec032b03332690a1ef78';
}
export function useToast() {
  return { error() {}, info() {}, success() {} };
}
export function useClipboard() {
  return { copiedKey: ref(''), markCopied() {}, async copyText() { return true; } };
}
export async function fetchAccountMetadata() { return null; }
export async function upsertAccountMetadata() {}

import { EC } from '../../config/errorCodes.js';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout.js';
import { canonicalizeOperatorMutationPayload, signOperatorMutationPayload } from '../../../api/operatorMutationHelpers.js';
import {
  createOperatorKeyVault, encryptOperatorBackup, decryptOperatorBackup,
  assertOperatorBackupPassphrase, withOperatorKeyLock,
} from './operatorKeyVault.js';

const DEFAULT_OPERATOR_MUTATION_ENDPOINT = '/api/draft-operator';

async function postJson(url, body, fetchImpl) {
  const response = await fetchWithTimeout(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, { fetchImpl });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (payload?.error === 'operator_key_already_claimed') throw new Error('EC_operator_key_recovery_required');
    const err = new Error(EC.mutationTransportFailed);
    err.rpcDetail = payload?.message || payload?.error || null;
    throw err;
  }
  return payload;
}

function assertAccess(shareSlug, accessSlug) {
  if (!shareSlug || !accessSlug) throw new Error(EC.operatorMutationMissingParams);
}

export function createOperatorMutationTransport({
  endpoint = DEFAULT_OPERATOR_MUTATION_ENDPOINT,
  keyStore,
  legacyStorage,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const vault = createOperatorKeyVault({ store: keyStore, legacyStorage });
  const claim = (shareSlug, accessSlug, publicKeyJwk) => postJson(endpoint, {
    action: 'claim', shareSlug, accessSlug, publicKeyJwk,
  }, fetchImpl);
  async function claimLocalKey(shareSlug, accessSlug) {
    try {
      const material = await vault.getOrCreate(shareSlug);
      return { material, claimed: await claim(shareSlug, accessSlug, material.publicJwk) };
    } catch (err) {
      if (!['EC_operator_key_recovery_required', 'EC_operator_key_storage_corrupt'].includes(err?.message)) throw err;
      // Another tab may have saved a fresh key before the original session was
      // migrated. Only the server's existing pin can authorize its replacement.
      const legacy = await vault.readLegacy(shareSlug);
      if (!legacy) throw err;
      const claimed = await claim(shareSlug, accessSlug, legacy.publicJwk);
      const material = await vault.save(shareSlug, legacy);
      vault.removeLegacy(shareSlug);
      return { material, claimed };
    }
  }

  return {
    async run({ shareSlug = '', accessSlug = '', mutation = '', payload = {} } = {}) {
      assertAccess(shareSlug, accessSlug);
      if (!mutation) throw new Error(EC.operatorMutationMissingParams);
      return withOperatorKeyLock(shareSlug, async () => {
        const { material, claimed } = await claimLocalKey(shareSlug, accessSlug);
        const counter = Number(claimed?.operatorCounter || 0);
        const canonicalPayload = canonicalizeOperatorMutationPayload({ shareSlug, mutation, payload, counter });
        const signature = await signOperatorMutationPayload(canonicalPayload, material.privateKey);
        const result = await postJson(endpoint, {
          action: 'mutate', shareSlug, accessSlug: claimed?.accessSlug || accessSlug,
          mutation, payload, counter, signature,
        }, fetchImpl);
        return result?.draft || null;
      });
    },
    async exportBackup({ shareSlug = '', accessSlug = '', passphrase } = {}) {
      assertAccess(shareSlug, accessSlug);
      assertOperatorBackupPassphrase(passphrase);
      return withOperatorKeyLock(shareSlug, async () => {
        const { material } = await claimLocalKey(shareSlug, accessSlug);
        return encryptOperatorBackup(shareSlug, material, passphrase);
      });
    },
    async importBackup({ shareSlug = '', accessSlug = '', backup, passphrase } = {}) {
      assertAccess(shareSlug, accessSlug);
      const material = await decryptOperatorBackup(backup, passphrase, shareSlug);
      return withOperatorKeyLock(shareSlug, async () => {
        // Server pin verification precedes any replacement of a local key.
        await claim(shareSlug, accessSlug, material.publicJwk);
        await vault.save(shareSlug, material);
        return true;
      });
    },
  };
}

import { EC } from '../config/errorCodes.js';

const ZERO_HASH = '0'.repeat(40);

function requireHash(value) {
  const hash = String(value || '').trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash) || hash === ZERO_HASH) {
    throw new Error(EC.addressValidationFailed);
  }
  return hash;
}

function readUInt160(result) {
  if (result?.state !== 'HALT') {
    const error = new Error(EC.rpcFault);
    error.rpcDetail = result?.exception || null;
    throw error;
  }
  const item = result.stack?.[0];
  // Neo RPC encodes UInt160 as a little-endian 20-byte ByteString, never as
  // display-order hex. Validate the full shape before reversing it.
  if (item?.type !== 'ByteString' || typeof item.value !== 'string'
      || !/^[A-Za-z0-9+/]{27}=$/.test(item.value)) {
    throw new Error(EC.rpcRequestFailed);
  }
  const bytes = globalThis.atob(item.value);
  if (bytes.length !== 20 || globalThis.btoa(bytes) !== item.value) {
    throw new Error(EC.rpcRequestFailed);
  }
  return Array.from(bytes, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).reverse().join('');
}

// Transport injection keeps identity semantics testable without connecting a
// wallet. All methods below are safe entries in UnifiedSmartWallet's V3 ABI.
export function createAccountIdentityReader(invokeReadFunction) {
  return async function fetchAccountIdentity({
    rpcUrl, aaContractHash, accountIdHex, accountAddressScriptHash,
  } = {}) {
    if (!String(rpcUrl || '').trim()) throw new Error(EC.rpcRequestFailed);
    const core = requireHash(aaContractHash);
    const proxy = accountAddressScriptHash ? requireHash(accountAddressScriptHash) : '';
    let accountId = accountIdHex ? requireHash(accountIdHex) : '';
    if (!accountId && !proxy) throw new Error(EC.accountSeedOrHashRequired);

    const readHash = async (operation, hash) => readUInt160(await invokeReadFunction(
      rpcUrl, core, operation, [{ type: 'Hash160', value: `0x${hash}` }],
    ));
    if (!accountId) {
      accountId = await readHash('getAccountIdByProxy', proxy);
      // The reverse index only covers platform registrations. Legacy accounts
      // require an explicit ID; treating their asset address as the ID is unsafe.
      if (accountId === ZERO_HASH) throw new Error(EC.accountSeedOrHashRequired);
    }
    if (proxy && await readHash('getProxyScriptHash', accountId) !== proxy) {
      throw new Error(EC.addressValidationFailed);
    }
    // Also verifies existence: getProxyScriptHash alone is a pure derivation and
    // succeeds for IDs that have never been registered.
    const verifier = await readHash('getVerifier', accountId);
    return { accountIdHex: accountId, verifierHash: verifier === ZERO_HASH ? '' : verifier };
  };
}

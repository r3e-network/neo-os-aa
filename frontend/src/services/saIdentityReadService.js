import { EC } from '../config/errorCodes.js';
import {
  decodeAccountDescriptor,
  decodeModuleDescriptor,
  decodeModulePage,
} from './smartAccountProtocol.js';

const ZERO_HASH = '0'.repeat(40);

function requireHash(value) {
  const hash = String(value || '').trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash) || hash === ZERO_HASH) {
    throw new Error(EC.addressValidationFailed);
  }
  return hash;
}

function readUInt160(item) {
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

const hashParam = (hash) => ({ type: 'Hash160', value: `0x${hash}` });
const intParam = (value) => ({ type: 'Integer', value: String(value) });
const stringParam = (value) => ({ type: 'String', value: value });

/**
 * v4 account identity reader.
 *
 * An account is named by its 20-byte id and described by `getAccount` (§9). Its
 * validator instances are module instances, so the authorization contract is
 * the first installed `validator` module's contract hash — not a single
 * `getVerifier` slot, which no longer exists.
 *
 * Transport injection keeps identity semantics testable without connecting a
 * wallet. All methods below are safe entries in the v4 core ABI.
 */
export function createAccountIdentityReader(invokeReadFunction) {
  return async function fetchAccountIdentity({
    rpcUrl, saContractHash, accountIdHex, accountAddressScriptHash,
  } = {}) {
    if (!String(rpcUrl || '').trim()) throw new Error(EC.rpcRequestFailed);
    const core = requireHash(saContractHash);
    const proxy = accountAddressScriptHash ? requireHash(accountAddressScriptHash) : '';
    let accountId = accountIdHex ? requireHash(accountIdHex) : '';
    if (!accountId && !proxy) throw new Error(EC.accountSeedOrHashRequired);

    const readStack = async (operation, args = []) => {
      const result = await invokeReadFunction(rpcUrl, core, operation, args);
      if (result?.state !== 'HALT') {
        const error = new Error(EC.rpcFault);
        error.rpcDetail = result?.exception || null;
        throw error;
      }
      return result.stack?.[0];
    };

    if (!accountId) {
      accountId = readUInt160(await readStack('getAccountIdByProxy', [hashParam(proxy)]));
      // The reverse index only covers platform registrations. Other accounts
      // require an explicit id; treating their asset address as the id is unsafe.
      if (accountId === ZERO_HASH) throw new Error(EC.accountSeedOrHashRequired);
    }
    if (proxy && readUInt160(await readStack('getProxyScriptHash', [hashParam(accountId)])) !== proxy) {
      throw new Error(EC.addressValidationFailed);
    }

    // Also verifies existence: getProxyScriptHash alone is a pure derivation and
    // succeeds for ids that have never been created.
    const descriptorItem = await readStack('getAccount', [hashParam(accountId)]);
    const hasDescriptor = descriptorItem?.type === 'Array' && (descriptorItem.value || []).length > 0;
    const account = hasDescriptor ? decodeAccountDescriptor(descriptorItem) : null;
    if (!account?.exists) throw new Error(EC.accountNotRegistered);

    const page = decodeModulePage(await readStack('getModules', [
      hashParam(accountId), stringParam('validator'), intParam(0), intParam(1),
    ]));
    let validatorHash = '';
    if (page.ids.length > 0) {
      const descriptor = decodeModuleDescriptor(await readStack('getModule', [
        hashParam(accountId), intParam(page.ids[0]),
      ]));
      validatorHash = descriptor?.contractHash || '';
    }

    return {
      accountIdHex: accountId,
      validatorHash,
      custody: account.custody,
      status: account.status,
      authorityEpoch: String(account.authorityEpoch),
      configurationNonce: String(account.configurationNonce),
    };
  };
}

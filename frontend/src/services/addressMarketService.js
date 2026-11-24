import { EC } from '../config/errorCodes.js';
import { RUNTIME_CONFIG } from '@/config/runtimeConfig.js';
import { walletService } from '@/services/walletService.js';
import { connectedAccount } from '@/utils/wallet.js';
import { sanitizeHex } from '@/utils/hex.js';
import {
  createProxyScript,
  deriveAccountIdHash,
  getAddressFromScriptHash,
  getScriptHashFromAddress,
  hash160,
  invokeReadFunction,
  reverseHex,
} from '@/utils/neo.js';

const GAS_TOKEN_HASH = 'd2a4cff31913016155e38e474a2c06d08be276cf';
const ZERO_HASH160 = '0000000000000000000000000000000000000000';
const LISTING_STATUS = {
  1: 'active',
  2: 'sold',
  3: 'cancelled',
};
const ACCOUNT_STATUS = {
  0: 'active',
  1: 'frozen',
  2: 'migration-required',
};

function requireMarketHash() {
  const hash = sanitizeHex(RUNTIME_CONFIG.addressMarketHash || '');
  if (!/^[0-9a-f]{40}$/.test(hash)) {
    throw new Error(EC.addressMarketNotConfigured);
  }
  return hash;
}

function normalizeHash160Input(value) {
  const raw = String(value || '').trim();
  if (!raw) return ZERO_HASH160;
  const normalized = raw.startsWith('N') ? getScriptHashFromAddress(raw) : sanitizeHex(raw);
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(EC.addressValidationFailed);
  }
  return normalized;
}

function buildEscrowCreationSigner(accountAddress, marketHash, saContractHash) {
  return {
    account: accountAddress,
    scopes: 16,
    allowedContracts: [`0x${sanitizeHex(marketHash)}`, `0x${sanitizeHex(saContractHash)}`],
  };
}

function encodeAccountSeed(value = '') {
  let hex = '';
  for (let index = 0; index < value.length; index += 1) {
    hex += value.charCodeAt(index).toString(16).padStart(2, '0');
  }
  return hex;
}

export function resolveListedAccountId(input = '') {
  const raw = String(input || '').trim();
  if (!raw) {
    throw new Error(EC.accountSeedOrHashRequired);
  }
  if (raw.startsWith('N') && raw.length === 34) {
    throw new Error(EC.accountSeedRequiredForListing);
  }

  const normalized = sanitizeHex(raw);
  if (/^[0-9a-f]{40}$/i.test(normalized)) {
    return normalized;
  }
  if (/^[0-9a-f]{130}$/i.test(normalized)) {
    return deriveAccountIdHash(normalized);
  }
  return deriveAccountIdHash(encodeAccountSeed(raw));
}

export function deriveVirtualAddressFromListing({ saContractHash, accountIdHash }) {
  const script = createProxyScript(saContractHash, accountIdHash);
  const scriptHash = reverseHex(hash160(script));
  return getAddressFromScriptHash(scriptHash);
}

function parseGasToFractions(value) {
  const raw = String(value || '').trim();
  if (!/^\d+(\.\d{1,8})?$/.test(raw)) {
    throw new Error(EC.invalidPrice);
  }
  const [wholePart, fractionPart = ''] = raw.split('.');
  const whole = BigInt(wholePart || '0');
  const fraction = BigInt((fractionPart + '00000000').slice(0, 8));
  const total = whole * 100000000n + fraction;
  if (total <= 0n) {
    throw new Error(EC.invalidPrice);
  }
  return total.toString();
}

export function formatGasFractions(value) {
  const raw = BigInt(String(value || '0'));
  const whole = raw / 100000000n;
  const fraction = raw % 100000000n;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(8, '0').replace(/0+$/, '')}`;
}

function base64ToBytes(value) {
  let binary;
  try {
    binary = atob(String(value || ''));
  } catch (_error) {
    return new Uint8Array();
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64ToUtf8(value) {
  return new TextDecoder().decode(base64ToBytes(value));
}

function decodeByteString(item = {}) {
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'String') return String(item.value || '');
  if (item.type !== 'ByteString') return '';
  const hex = bytesToHex(base64ToBytes(item.value || ''));
  if (!hex) return '';
  return base64ToUtf8(item.value || '');
}

function decodeHash160(item = {}) {
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'Hash160') return sanitizeHex(item.value || '');
  if (item.type === 'ByteString') return reverseHex(sanitizeHex(bytesToHex(base64ToBytes(item.value || ''))));
  return '';
}

function decodeInteger(item = {}) {
  if (!item || typeof item !== 'object') return '0';
  if (item.type === 'Integer') return String(item.value || '0');
  if (item.type === 'Boolean') return item.value ? '1' : '0';
  if (item.type === 'ByteString') return String(BigInt(`0x${bytesToHex(base64ToBytes(item.value || '')) || '0'}`));
  return '0';
}

function decodeListing(item = {}) {
  if (!item || item.type !== 'Array' || !Array.isArray(item.value) || item.value.length === 0) {
    return null;
  }
  const [
    idItem,
    saContractItem,
    accountIdItem,
    sellerItem,
    priceItem,
    titleItem,
    metadataUriItem,
    statusItem,
    buyerItem,
    createdAtItem,
    updatedAtItem,
  ] = item.value;

  const statusCode = Number(decodeInteger(statusItem));

  return {
    id: decodeInteger(idItem),
    saContractHash: decodeHash160(saContractItem),
    accountIdHash: decodeHash160(accountIdItem),
    sellerScriptHash: decodeHash160(sellerItem),
    priceRaw: decodeInteger(priceItem),
    price_gas: formatGasFractions(decodeInteger(priceItem)),
    title: decodeByteString(titleItem),
    metadataUri: decodeByteString(metadataUriItem),
    statusCode,
    status: LISTING_STATUS[statusCode] || 'unknown',
    buyerScriptHash: decodeHash160(buyerItem),
    createdAt: decodeInteger(createdAtItem),
    updatedAt: decodeInteger(updatedAtItem),
  };
}

async function invokeMarketRead(operation, args = []) {
  const marketHash = requireMarketHash();
  const result = await invokeReadFunction(RUNTIME_CONFIG.rpcUrl, marketHash, operation, args);
  if (String(result?.state || '').includes('FAULT')) {
    const err = new Error(EC.rpcFault);
    err.rpcDetail = result?.exception || null;
    throw err;
  }
  return result;
}

// v4 reads the account's control record instead of the removed v3 slots
// (`getVerifier`, `getHook`, `getBackupOwner`): getAccount returns
// [exists, status, custody, recoveryAuthority, authorityEpoch, configurationNonce,
//  recoveryTimelockMs, defaultOperationAuthorization, defaultMessageAuthorization,
//  ownerOnlyRecovery, hookOrderRevision, controlRevision, recoveryPending,
//  recoveryMatureAt, marketEscrowActive].
async function fetchAccountSnapshot(saContractHash, accountIdHash) {
  const empty = {
    exists: false,
    status: '',
    custody: '',
    recoveryAuthority: '',
    escrowActive: null,
  };
  try {
    const result = await invokeReadFunction(RUNTIME_CONFIG.rpcUrl, saContractHash, 'getAccount', [{ type: 'Hash160', value: `0x${accountIdHash}` }]);
    const record = result?.stack?.[0];
    if (!record || record.type !== 'Array' || !Array.isArray(record.value) || record.value.length !== 15) {
      return empty;
    }
    const [existsItem, statusItem, custodyItem, recoveryItem, , , , , , , , , , , escrowItem] = record.value;
    if (existsItem?.type !== 'Boolean' || existsItem.value !== true) return empty;
    const escrowActive = escrowItem?.type === 'Boolean' ? Boolean(escrowItem.value) : null;
    return {
      exists: true,
      status: ACCOUNT_STATUS[Number(decodeInteger(statusItem))] || 'unknown',
      custody: decodeHash160(custodyItem),
      recoveryAuthority: decodeHash160(recoveryItem),
      escrowActive,
    };
  } catch (error) {
    if (import.meta.env.DEV) console.error('[addressMarketService] getAccount failed:', error?.message);
    return empty;
  }
}

async function enrichListing(listing) {
  const accountAddress = deriveVirtualAddressFromListing({
    saContractHash: listing.saContractHash,
    accountIdHash: listing.accountIdHash,
  });
  const snapshot = await fetchAccountSnapshot(listing.saContractHash, listing.accountIdHash);
  return {
    ...listing,
    account_address: accountAddress,
    seller_address: listing.sellerScriptHash ? `0x${listing.sellerScriptHash}` : '',
    buyer_address: listing.buyerScriptHash ? `0x${listing.buyerScriptHash}` : '',
    account_status: snapshot.status,
    custody: snapshot.custody ? `0x${snapshot.custody}` : '',
    recovery_authority: snapshot.recoveryAuthority ? `0x${snapshot.recoveryAuthority}` : '',
    escrow_active: snapshot.escrowActive,
  };
}

export function isAddressMarketConfigured() {
  return /^[0-9a-f]{40}$/.test(sanitizeHex(RUNTIME_CONFIG.addressMarketHash || ''));
}

export async function findListingsForWallet(walletScriptHash) {
  const normalized = sanitizeHex(walletScriptHash || '');
  if (!/^[0-9a-f]{40}$/.test(normalized)) return [];
  const all = await listAddressListings();
  return all.filter((listing) => {
    if (listing.sellerScriptHash === normalized) return true;
    if (listing.status === 'sold' && listing.buyerScriptHash === normalized) return true;
    if (listing.custody && sanitizeHex(listing.custody) === normalized) return true;
    return false;
  });
}

export async function readAddressListing(id) {
  const result = await invokeMarketRead('getListing', [{ type: 'Integer', value: String(id) }]);
  const decoded = decodeListing(result?.stack?.[0]);
  if (!decoded) throw new Error(EC.listingNotFound);
  return enrichListing(decoded);
}

export async function listAddressListings() {
  if (!isAddressMarketConfigured()) return [];

  const countResult = await invokeMarketRead('getListingCount');
  const count = Number(decodeInteger(countResult?.stack?.[0]));
  const reads = [];
  for (let id = 1; id <= count; id += 1) {
    reads.push(invokeMarketRead('getListing', [{ type: 'Integer', value: String(id) }]).catch((error) => { if (import.meta.env.DEV) console.error('[addressMarketService] getListing failed:', error?.message); return null; }));
  }

  const decoded = (await Promise.all(reads))
    .map((result) => decodeListing(result?.stack?.[0]))
    .filter(Boolean);

  const enriched = await Promise.all(decoded.map((listing) => enrichListing(listing)));
  return enriched.sort((left, right) => Number(right.id) - Number(left.id));
}

export async function createAddressListing(input = {}) {
  const marketHash = requireMarketHash();
  if (!walletService.isConnected || !connectedAccount.value) {
    throw new Error(EC.walletRequiredForListing);
  }

  const saContractHash = normalizeHash160Input(input.saContractHash || RUNTIME_CONFIG.smartAccountHash);
  const accountIdHash = resolveListedAccountId(input.accountSeed || input.accountId || '');
  const priceFractions = parseGasToFractions(input.price_gas);
  const title = String(input.title || '').trim();
  const metadataUri = String(input.metadataUri || '').trim();

  const result = await walletService.invoke({
    scriptHash: marketHash,
    operation: 'createListing',
    args: [
      { type: 'Hash160', value: `0x${saContractHash}` },
      { type: 'Hash160', value: `0x${accountIdHash}` },
      { type: 'Integer', value: priceFractions },
      { type: 'String', value: title },
      { type: 'String', value: metadataUri },
    ],
    signers: [buildEscrowCreationSigner(connectedAccount.value, marketHash, saContractHash)],
  });

  return {
    txid: result?.txid || '',
    accountIdHash,
    accountAddress: deriveVirtualAddressFromListing({ saContractHash, accountIdHash }),
  };
}

export async function cancelAddressListing(id) {
  const marketHash = requireMarketHash();
  if (!walletService.isConnected || !connectedAccount.value) {
    throw new Error(EC.walletRequiredForListing);
  }

  const result = await walletService.invoke({
    scriptHash: marketHash,
    operation: 'cancelListing',
    args: [{ type: 'Integer', value: String(id) }],
    signers: [{ account: connectedAccount.value, scopes: 1 }],
  });

  return { txid: result?.txid || '' };
}

export async function updateAddressListingPrice(id, priceGas) {
  const marketHash = requireMarketHash();
  if (!walletService.isConnected || !connectedAccount.value) {
    throw new Error(EC.walletRequiredForListing);
  }

  const result = await walletService.invoke({
    scriptHash: marketHash,
    operation: 'updateListingPrice',
    args: [
      { type: 'Integer', value: String(id) },
      { type: 'Integer', value: parseGasToFractions(priceGas) },
    ],
    signers: [{ account: connectedAccount.value, scopes: 1 }],
  });

  return { txid: result?.txid || '' };
}

export async function refundPendingAddressPurchase(id) {
  const marketHash = requireMarketHash();
  if (!walletService.isConnected || !connectedAccount.value) {
    throw new Error(EC.walletRequiredForListing);
  }

  const payerScriptHash = getScriptHashFromAddress(connectedAccount.value);
  const result = await walletService.invoke({
    scriptHash: marketHash,
    operation: 'refundPendingPayment',
    args: [
      { type: 'Integer', value: String(id) },
      { type: 'Hash160', value: `0x${payerScriptHash}` },
    ],
    signers: [{ account: connectedAccount.value, scopes: 1 }],
  });

  return { txid: result?.txid || '' };
}

export async function buyAddressListing(id, options = {}) {
  const marketHash = requireMarketHash();
  if (!walletService.isConnected || !connectedAccount.value) {
    throw new Error(EC.walletRequiredForListing);
  }

  const listing = await readAddressListing(id);
  if (listing.status !== 'active') {
    throw new Error(EC.listingNotActive);
  }

  const payerScriptHash = getScriptHashFromAddress(connectedAccount.value);
  const backupOwnerHash = normalizeHash160Input(options.newBackupOwner || connectedAccount.value);

  const result = await walletService.invokeMultiple({
    invokeArgs: [
      {
        scriptHash: GAS_TOKEN_HASH,
        operation: 'transfer',
        args: [
          { type: 'Hash160', value: `0x${payerScriptHash}` },
          { type: 'Hash160', value: `0x${marketHash}` },
          { type: 'Integer', value: String(listing.priceRaw) },
          { type: 'Integer', value: String(id) },
        ],
      },
      {
        scriptHash: marketHash,
        operation: 'settleListing',
        args: [
          { type: 'Integer', value: String(id) },
          { type: 'Hash160', value: `0x${payerScriptHash}` },
          { type: 'Hash160', value: `0x${backupOwnerHash}` },
        ],
      },
    ],
    signers: [{ account: connectedAccount.value, scopes: 1 }],
  });

  return { txid: result?.txid || '' };
}

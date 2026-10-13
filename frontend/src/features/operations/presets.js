import { EC } from '../../config/errorCodes.js';
import { TRANSFER_METHOD, isProxySourcedTransfer } from '../../shared/transferOutcome.mjs';
import { sanitizeHex } from '../../utils/hex.js';
import { getScriptHashFromAddress } from '../../utils/neo.js';

export const OPERATION_PRESETS = [
  {
    id: 'invoke',
    label: 'Generic Invoke',
    description: 'Compose any AA wrapper contract call manually.',
  },
  {
    id: 'nep17Transfer',
    label: 'NEP-17 Transfer',
    description: 'Build a token transfer payload with account and recipient hashes.',
  },
  {
    id: 'multisigDraft',
    label: 'Multisig Draft',
    description: 'Prepare a shareable transaction draft for additional co-signers.',
  },
];

export const EXPERIMENTAL_OPERATION_PRESETS = [
  {
    id: 'batchCreate',
    label: 'Batch Create',
    description: 'Deploy multiple abstract accounts in a single transaction.',
  },
];

function parseJson(text, fallback) {
  const value = String(text || '').trim();
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (e) {
    if (import.meta.env.DEV) console.warn('[presets] parseJson failed:', e?.message);
    return fallback;
  }
}

function normalizeHash160(value) {
  const hex = sanitizeHex(value || '');
  if (/^[0-9a-f]{40}$/i.test(hex)) {
    return hex;
  }

  const address = String(value || '').trim();
  if (!address) return '';

  try {
    return sanitizeHex(getScriptHashFromAddress(address));
  } catch (e) {
    if (import.meta.env.DEV) console.warn('[presets] normalizeHash160 address parse failed:', address, e?.message);
    return hex;
  }
}

function toHash160Arg(value) {
  return { type: 'Hash160', value: value ? `0x${value}` : '0x' };
}

function toIntegerArg(value) {
  const normalized = String(value ?? '').trim();
  return { type: 'Integer', value: normalized || '0' };
}

function toAnyArg(value) {
  return {
    type: 'Any',
    value: value,
  };
}

function toArrayArg(items, itemType = 'String') {
  return {
    type: 'Array',
    value: (items || []).map(item => ({ type: itemType, value: item })),
  };
}

/**
 * A preset that cannot produce an operation which can do what it says. The message is the machine-readable
 * error code, like every EC error, so `translateError(error.message, t)` shows the translated reason; `details`
 * names what was refused.
 */
export class OperationPresetRefusedError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'OperationPresetRefusedError';
    this.code = code;
    this.details = details;
  }
}

export function isOperationPresetRefusal(error) {
  return error instanceof OperationPresetRefusedError;
}

export function buildOperationFromPreset({
  preset = 'invoke',
  broadcastMode = 'client',
  account = {},
  invoke = {},
  transfer = {},
  multisig = {},
  batch = {},
} = {}) {
  const normalizedTargetContract = sanitizeHex(invoke.targetContract || '');
  const normalizedMethod = String(invoke.method || '').trim();
  const normalizedArgs = parseJson(invoke.argsText || '[]', []);

  if (preset === 'nep17Transfer') {
    const fromHash = normalizeHash160(transfer.from || account.accountAddressScriptHash || '');
    const recipientHash = normalizeHash160(transfer.recipient || '');
    const tokenHash = sanitizeHex(transfer.tokenScriptHash || '');
    // Client wallet invoke APIs cannot supply the proxy verification script. The
    // relay resolves the exact script and on-chain scope before simulating/signing;
    // a relay without that capability still refuses the resulting false transfer.
    const proxyHash = normalizeHash160(account.accountAddressScriptHash || '');
    const requiresProxyWitness = isProxySourcedTransfer({ method: TRANSFER_METHOD, from: fromHash, proxy: proxyHash });
    if (requiresProxyWitness && broadcastMode !== 'relay') {
      throw new OperationPresetRefusedError(EC.presetProxyTransferRefused, {
        preset,
        from: fromHash,
        token: tokenHash,
      });
    }
    return {
      kind: 'transfer',
      targetContract: tokenHash,
      method: 'transfer',
      args: [
        toHash160Arg(fromHash),
        toHash160Arg(recipientHash),
        toIntegerArg(transfer.amount),
        toAnyArg(parseJson(transfer.data, String(transfer.data || '').trim() ? String(transfer.data).trim() : null)),
      ],
      metadata: {
        assetStandard: 'NEP-17',
        ...(requiresProxyWitness ? { requiresProxyWitness: true } : {}),
      },
    };
  }

  if (preset === 'multisigDraft') {
    return {
      kind: 'multisig',
      targetContract: normalizedTargetContract,
      method: normalizedMethod,
      args: normalizedArgs,
      metadata: {
        title: String(multisig.title || '').trim(),
        description: String(multisig.description || '').trim(),
        requiresAdditionalSigners: true,
      },
    };
  }

  if (preset === 'batchCreate') {
    const accountIds = parseJson(batch.accountIds, []);
    const signers = parseJson(batch.signers, []);
    const threshold = Number(batch.threshold) || 1;
    return {
      kind: 'batchCreate',
      targetContract: normalizedTargetContract,
      method: normalizedMethod || 'create',
      args: [
        toArrayArg(accountIds),
        toArrayArg(signers.map(s => normalizeHash160(s))),
        toIntegerArg(threshold),
      ],
      metadata: {
        accountCount: accountIds.length,
        signerCount: signers.length,
        threshold,
      },
    };
  }

  return {
    kind: 'invoke',
    targetContract: normalizedTargetContract,
    method: normalizedMethod,
    args: normalizedArgs,
    metadata: {},
  };
}

/**
 * buildOperationFromPreset with a refusal as a result instead of an exception: exactly one of `operation` and
 * `refusal` (the OperationPresetRefusedError) is set. Any other error still throws, because it is a bug.
 */
export function tryBuildOperationFromPreset(input) {
  try {
    return { operation: buildOperationFromPreset(input), refusal: null };
  } catch (error) {
    if (isOperationPresetRefusal(error)) return { operation: null, refusal: error };
    throw error;
  }
}

export function buildPresetSummary(operation = {}) {
  const kind = String(operation.kind || '').trim();
  if (kind === 'transfer') {
    const amount = operation.args?.[2]?.value || '0';
    return {
      title: 'NEP-17 Transfer',
      detail: `Amount: ${amount}`,
    };
  }
  if (kind === 'multisig') {
    return {
      title: 'Multisig Draft',
      detail: String(operation.metadata?.description || operation.method || '').trim(),
    };
  }
  return {
    title: String(operation.method || 'Generic Invoke'),
    detail: String(operation.targetContract || '').trim(),
  };
}

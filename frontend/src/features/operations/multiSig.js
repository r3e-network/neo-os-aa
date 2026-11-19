/**
 * Threshold-route assembly for the wallet frontend.
 *
 * A threshold instance (`validatorId` = the policy id) is routed like any other
 * validator, but its operation signature field carries the serialized member
 * list `[[memberModuleId, r‖s], ...]` instead of one signature. Each member
 * signs the §5 digest over the core's operation digest plus its own module id
 * and credential generation, so a member signature cannot be replayed onto
 * another member or across a credential rotation.
 *
 * The member list is not readable from the core (only the policy that installed
 * it knows it), so the caller supplies the members and this module reads the
 * one value it must not guess: each member's current credential generation.
 */

import { sha256 } from 'ethers';
import { EC } from '../../config/errorCodes.js';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout.js';
import { toMultiSigRpcParameter, createThresholdTools } from '../../shared/multiSigCore.mjs';
import { decodeHash160Stack } from '../../shared/metaTxCore.mjs';
import {
  computeOperationDigest,
  fetchModuleDescriptor,
  fetchValidationPreview,
} from './metaTx.js';

export const thresholdTools = createThresholdTools({
  sha256: (hex) => sha256(`0x${String(hex).replace(/^0x/i, '')}`),
});

async function invokeRead({ rpcUrl, scriptHash, operation, args = [], fetchImpl } = {}) {
  const response = await fetchWithTimeout(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'invokefunction',
      params: [scriptHash, operation, args.map(toMultiSigRpcParameter)],
    }),
  }, { fetchImpl });

  if (!response.ok) throw new Error(EC.rpcRequestFailed);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || EC.rpcRequestFailed);
  return payload.result;
}

const hash160 = (value) => {
  const clean = String(value || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error(EC.accountIdRequired);
  return clean;
};

/**
 * A threshold session bound to one account. Every read goes through the core of
 * the caller's choice, so a session can never mix values from two networks.
 */
export function createThresholdSession({ rpcUrl, fetchImpl } = {}) {
  if (!rpcUrl) throw new Error(EC.rpcRequestFailed);

  const read = (contract, method, args) => invokeRead({
    rpcUrl,
    scriptHash: hash160(contract),
    operation: method,
    args,
    fetchImpl,
  });

  return {
    /** The member's current credential generation, read at assembly time. */
    async readMember({ coreContractHash, accountId, moduleId }) {
      const module = await fetchModuleDescriptor({
        rpcUrl,
        saContractHash: coreContractHash,
        accountId: hash160(accountId),
        moduleId,
        fetchImpl,
      });
      if (!module.thresholdMemberEligible) {
        throw new Error(`module ${module.moduleId} is not eligible as a threshold member`);
      }
      return {
        moduleId: module.moduleId,
        credentialGeneration: module.credentialGeneration,
        contractHash: module.contractHash,
      };
    },

    /** §4.3 digest every member signs over (via §5 member digests). */
    operationDigest({ networkMagic, coreContractHash, accountId, operation }) {
      return computeOperationDigest({
        networkMagic,
        coreContractHash: hash160(coreContractHash),
        accountId: hash160(accountId),
        operation,
      });
    },

    /** The digest each member must sign, with its generation read from the core. */
    async prepareMembers({ networkMagic, coreContractHash, accountId, operation, memberModuleIds = [] }) {
      const operationDigest = this.operationDigest({ networkMagic, coreContractHash, accountId, operation });
      const members = [];
      for (const moduleId of memberModuleIds) {
        members.push(await this.readMember({ coreContractHash, accountId, moduleId }));
      }
      return thresholdTools.prepareMembers({ operationDigest, members });
    },

    /** The serialized signature field for the operation, from signed members. */
    assembleOperationSignature({ operationDigest, members }) {
      return thresholdTools.assembleOperationSignature({ operationDigest, members });
    },

    /** Read-only preview of the assembled operation; the chain stays authoritative. */
    async preview({ coreContractHash, accountId, operation }) {
      return fetchValidationPreview({
        rpcUrl,
        saContractHash: coreContractHash,
        accountId: hash160(accountId),
        operation,
        fetchImpl,
      });
    },

    /** `getProxyScriptHash(accountId)` — the address the core derives for this account. */
    async readProxyHash({ coreContractHash, accountId }) {
      const result = await read(coreContractHash, 'getProxyScriptHash', [
        { type: 'Hash160', value: `0x${hash160(accountId)}` },
      ]);
      if (result?.state === 'FAULT') throw new Error(EC.rpcFault);
      return decodeHash160Stack(result?.stack?.[0]);
    },
  };
}

// DEPRECATED: Use buildV3UserOperationTypedData from '../metaTx.js' instead.
// This file is retained only for backward compatibility.
const { buildV3UserOperationTypedData } = require('../metaTx');

/**
 * @deprecated Use buildV3UserOperationTypedData from '../metaTx.js' instead.
 *
 * Builds EIP-712 payload for Web3Auth verifier.
 * Retained for backward compatibility only.
 *
 * @param {Object} options - Payload options
 * @param {string|number} options.chainId - Chain ID
 * @param {string} options.verifierHash - Verifier contract hash
 * @param {string} options.accountId - Account ID hash
 * @param {string} options.coreContractHash - Authorized AA core hash
 * @param {Object} options.userOp - UserOperation object
 * @param {string} options.argsHash - On-chain-computed args hash. REQUIRED: this
 *   must equal keccak256(StdLib.Serialize(args)) as produced by the contract's
 *   computeArgsHash method (see AbstractAccountClient.computeArgsHash). It is not
 *   derived locally because a JS-side hash (e.g. of JSON.stringify(args)) does
 *   NOT match the on-chain serialization, which would yield a signature that can
 *   never be verified.
 * @returns {Object} EIP-712 typed data
 * @throws {Error} If argsHash is omitted.
 */
function buildEIP712PayloadForWeb3AuthVerifier({ chainId, verifierHash, accountId, coreContractHash, userOp, argsHash }) {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.warn('buildEIP712PayloadForWeb3AuthVerifier is deprecated. Use buildV3UserOperationTypedData from metaTx.js instead.');
  }
  if (!argsHash) {
    // Deriving the hash locally (e.g. keccak256(JSON.stringify(args))) diverges
    // from the on-chain keccak256(StdLib.Serialize(args)), producing a digest
    // that the verifier can never validate. Require the caller to supply the
    // hash computed on-chain instead of silently failing later.
    throw new Error(
      'buildEIP712PayloadForWeb3AuthVerifier requires argsHash. Compute it on-chain ' +
      'via AbstractAccountClient.computeArgsHash(args) (keccak256(StdLib.Serialize(args))) ' +
      'and pass it as argsHash; do not let it be derived locally.'
    );
  }
  return buildV3UserOperationTypedData({
    chainId,
    verifyingContract: verifierHash,
    accountIdHash: accountId,
    coreContractHash,
    targetContract: userOp.TargetContract,
    method: userOp.Method,
    argsHashHex: argsHash,
    nonce: userOp.Nonce,
    deadline: userOp.Deadline,
  });
}

/**
 * @deprecated Construct the UserOp object directly instead.
 *
 * Builds a V3 UserOperation object.
 * Retained for backward compatibility only.
 *
 * @param {Object} options - UserOp options
 * @param {string} options.targetContract - Target contract hash
 * @param {string} options.method - Method name
 * @param {Array} options.args - Method arguments
 * @param {string|number} options.nonce - Nonce value
 * @param {string|number} options.deadline - Deadline in Neo Runtime.Time milliseconds
 * @returns {Object} UserOperation object
 */
function buildV3UserOp({ targetContract, method, args, nonce, deadline }) {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.warn('buildV3UserOp is deprecated. Construct the UserOp object directly.');
  }
  return {
    TargetContract: targetContract,
    Method: method,
    Args: args,
    Nonce: nonce,
    Deadline: deadline,
    Signature: '',
  };
}

module.exports = { buildEIP712PayloadForWeb3AuthVerifier, buildV3UserOp };

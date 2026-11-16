/**
 * ERC-4337 shape adapters for the Neo N3 Abstract Account stack.
 *
 * The V3 core does not implement the 4337 EntryPoint interface (Neo has no
 * mempool rules, no initCode, and no gas-price bidding — fees are computed by
 * the VM at execution time). What these adapters provide is the SHAPE: they
 * map a V3 UserOperation onto the field names 4337-aware tooling (wallets,
 * indexers, bundler UIs) already know how to display, and they run the
 * non-faulting simulateUserOp preflight where 4337 would run
 * simulateValidation.
 *
 * Field mapping:
 * - sender       = the V3 account id (20 bytes, 0x-prefixed big-endian
 *                  display hex). This is the abstract account identity, NOT
 *                  an EOA address.
 * - nonce        = the UserOperation nonce as a 0x-prefixed hex quantity.
 * - callData     = the Neo VM invocation script for target.method(args)
 *                  (System.Contract.Call), i.e. the exact bytecode an
 *                  equivalent native Neo transaction would carry.
 * - signature    = the UserOperation signature bytes.
 * - gas fields   = '0x0'. Neo N3 computes network and system fees from VM
 *                  execution, not from bid fields; use estimateUserOperationGas
 *                  for the preflight view.
 * - deadline     = extension field with no 4337 counterpart: the
 *                  UserOperation deadline in Neo Runtime.Time milliseconds.
 */

const { sc } = require('./neonCompat');
const { EC, createError } = require('./errors');
const { sanitizeHex, validateHash160 } = require('./validation');

function toHexQuantity(value) {
  const integer = BigInt(value ?? 0);
  if (integer < 0n) {
    throw createError(EC.VALIDATION_OPTIONS_REQUIRED, {
      hint: `ERC-4337 quantities must be non-negative, got ${value}`,
    });
  }
  return `0x${integer.toString(16)}`;
}

/**
 * Maps a V3 UserOperation onto the ERC-4337 UserOperation field names.
 *
 * @param {Object} options - UserOperation fields
 * @param {string} options.accountIdHash - V3 account ID hash (becomes sender)
 * @param {string} options.targetContract - Target contract hash
 * @param {string} options.method - Method name
 * @param {Array} [options.args=[]] - Typed contract parameters ({type, value})
 * @param {string|number|bigint} [options.nonce=0] - Nonce value
 * @param {string|number|bigint} [options.deadline=0] - Deadline (Runtime.Time ms)
 * @param {string} [options.signatureHex=''] - Signature bytes, hex
 * @returns {Object} ERC-4337-shaped UserOperation
 */
function toErc4337UserOperation({
  accountIdHash,
  targetContract,
  method,
  args = [],
  nonce = 0,
  deadline = 0,
  signatureHex = '',
} = {}) {
  if (!accountIdHash) {
    throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'accountIdHash is required' });
  }
  validateHash160(accountIdHash);
  validateHash160(targetContract);
  const callData = sc.createScript({
    scriptHash: sanitizeHex(targetContract),
    operation: String(method || ''),
    args,
  });
  return {
    sender: `0x${sanitizeHex(accountIdHash)}`,
    nonce: toHexQuantity(nonce),
    callData: `0x${callData}`,
    signature: `0x${sanitizeHex(signatureHex)}`,
    // Neo N3 has no bid-style gas fields; the VM prices execution. The zeros
    // keep 4337-aware renderers honest instead of inventing numbers.
    callGasLimit: '0x0',
    verificationGasLimit: '0x0',
    preVerificationGas: '0x0',
    maxFeePerGas: '0x0',
    maxPriorityFeePerGas: '0x0',
    // Extension field (no 4337 counterpart): Neo Runtime.Time milliseconds.
    deadline: String(deadline),
  };
}

/**
 * ERC-4337 estimateUserOperationGas counterpart: runs the core's
 * non-faulting simulateUserOp preflight (the simulateValidation analogue)
 * and returns the 4337 gas fields as zero alongside the simulation, because
 * Neo N3 prices execution in the VM instead of through bid fields.
 *
 * @param {SmartAccountClient} client - The SDK client instance
 * @param {Object} options - Same options as client.simulateUserOp
 * @returns {Promise<Object>} 4337-shaped gas estimate with the simulation
 */
async function estimateUserOperationGas(client, options = {}) {
  if (!client || typeof client.simulateUserOp !== 'function') {
    throw createError(EC.VALIDATION_OPTIONS_REQUIRED, {
      hint: 'estimateUserOperationGas requires a SmartAccountClient with simulateUserOp',
    });
  }
  const simulation = await client.simulateUserOp(options);
  return {
    preVerificationGas: '0x0',
    verificationGasLimit: '0x0',
    callGasLimit: '0x0',
    simulation,
    note: 'Neo N3 computes network and system fees from VM execution; the zero gas fields are placeholders for the 4337 shape. The simulation reports the core preflight checks.',
  };
}

module.exports = {
  toErc4337UserOperation,
  estimateUserOperationGas,
};

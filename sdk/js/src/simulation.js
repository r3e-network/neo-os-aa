/**
 * Simulation helpers for pre-flight validation of UserOperations.
 * Provides methods to check execution conditions before submission.
 */

const { EC, createError, formatError, mapRpcError } = require('./errors');
const { validateHash160, validateAccountId, sanitizeHex } = require('./validation');
const { wallet } = require('./neonCompat');
// Shared with the relay route and the wallet (single source of truth for what counts as a refused transfer).
const { isProxySourcedTransfer } = require('../../../shared/transferOutcome.mjs');

/**
 * Result of a UserOperation simulation.
 * @typedef {Object} SimulationResult
 * @property {boolean} passed - Whether all PREVIEW checks passed. This does NOT
 *   imply the operation is executable: the signature is never checked here
 *   (see {@link signatureVerified}).
 * @property {boolean} signatureVerified - Always false. simulate does not verify
 *   the UserOperation signature or its session scope. Only the on-chain
 *   executeUserOp (or the relay's full-op simulation) validates the signature.
 * @property {Object} checks - Individual check results
 * @property {boolean} checks.deadlineValid - Deadline is in the future
 * @property {boolean} checks.nonceAcceptable - Nonce is valid and unused
 * @property {boolean} checks.hasVerifier - Verifier is configured
 * @property {string} checks.verifier - Verifier contract hash
 * @property {string} checks.hook - Hook contract hash
 * @property {'verifier'|'owner-witness'} checks.authorization - How executeUserOp authorizes the operation:
 *   through the configured verifier, or (no verifier) through the backup owner's native witness
 * @property {string} checks.backupOwner - Backup owner hash on the owner-witness path ('' when it was not read)
 * @property {boolean} [checks.ownerWitnessPresent] - Only on the owner-witness path when `signers` were supplied:
 *   whether those signers carry the backup owner's witness
 * @property {Array} errors - List of error messages (if any)
 * @property {Array} warnings - List of warnings (if any)
 */

/**
 * Reads a Hash160 out of a contract parameter ({ type, value }) or a bare value: 40 hex characters with or
 * without 0x, or an N address. Returns '' when it is none of those.
 * @private
 */
function hash160FromParam(param) {
  const raw = param && typeof param === 'object' ? param.value : param;
  if (typeof raw !== 'string') return '';
  const clean = raw.trim();
  if (/^N[a-zA-Z0-9]{33}$/.test(clean)) {
    try {
      return sanitizeHex(wallet.getScriptHashFromAddress(clean));
    } catch (_error) {
      return '';
    }
  }
  return sanitizeHex(clean);
}

/**
 * The account's proxy address as 40 hex characters, in a list: derived from the account id by the client (it
 * knows the master contract), and for a legacy account the address itself. Empty when it cannot be known (a client
 * that cannot derive it): then nothing can be judged and nothing is refused.
 * @private
 */
function resolveProxyHashes(client, { accountIdHash, accountAddress }) {
  const proxies = [];
  if (accountIdHash && typeof client?.deriveVirtualAccount === 'function') {
    try {
      proxies.push(sanitizeHex(client.deriveVirtualAccount(accountIdHash).scriptHash));
    } catch (_error) {
      // An id the client cannot derive from is reported by the preview itself.
    }
  }
  if (accountAddress) proxies.push(hash160FromParam(accountAddress));
  return proxies.filter(Boolean);
}

const ZERO_HASH160 = '00'.repeat(20);

/**
 * The account's backup owner as 40 hex characters, read the cheapest way the client offers (describeAccount is
 * one call, getAccountState is the fallback for a core without it). `backupOwner` is null when it cannot be read
 * (a client without either reader, or both reads failing): then nothing can be judged and nothing is refused.
 * @private
 */
async function readBackupOwner(client, accountHashOrAddress) {
  if (typeof client?.describeAccount === 'function') {
    try {
      const descriptor = await client.describeAccount(accountHashOrAddress);
      return { exists: descriptor?.exists !== false, backupOwner: sanitizeHex(descriptor?.backupOwner || '') };
    } catch (_error) {
      // A core without describeAccount: fall through to the individual getters.
    }
  }
  if (typeof client?.getAccountState === 'function') {
    try {
      const state = await client.getAccountState(accountHashOrAddress);
      return { exists: true, backupOwner: sanitizeHex(state?.backupOwner || '') };
    } catch (_error) {
      // Unreadable: reported as unknown below.
    }
  }
  return { exists: true, backupOwner: null };
}

/**
 * Mirrors the no-plugin branch of executeUserOp: without a verifier the core asserts a non-zero backup owner
 * ("Native fallback requires backup owner") and that owner's native witness ("Native witness failed"). Fills
 * checks.backupOwner / checks.ownerWitnessPresent and reports through errors and warnings.
 * @private
 */
async function checkOwnerWitnessAuthorization(client, request, signers, checks, errors, warnings) {
  const { exists, backupOwner } = await readBackupOwner(client, request.accountIdHash || request.accountAddress);
  checks.backupOwner = backupOwner || '';

  if (!exists) {
    errors.push('Account is not registered.');
    return;
  }
  if (backupOwner === null) {
    warnings.push('No verifier configured: the operation is authorized by the backup owner\'s native witness, '
      + 'but the backup owner could not be read. The transaction must be signed by the backup owner.');
    return;
  }
  if (!backupOwner || backupOwner === ZERO_HASH160) {
    errors.push('No verifier configured and no backup owner set. Native fallback requires backup owner.');
    return;
  }

  if (Array.isArray(signers) && signers.length > 0 && typeof client?.simulateValidation === 'function') {
    try {
      const simulation = await client.simulateValidation({ ...request, signers });
      checks.ownerWitnessPresent = Boolean(simulation?.nativeWitnessPresent);
      if (!checks.ownerWitnessPresent) {
        errors.push(`Native witness failed. No verifier is configured, so the transaction must carry the witness of backup owner 0x${backupOwner}; the supplied signers do not provide it.`);
      }
      return;
    } catch (_error) {
      // The witness could not be judged: fall through to the reminder.
    }
  }

  warnings.push(`No verifier configured: the operation is authorized by the native witness of backup owner 0x${backupOwner}. The transaction must be signed by that account (a relay or third-party signature alone is rejected).`);
}

/**
 * Simulates a UserOperation before submission.
 * Calls getUserOpValidationPreview to check execution conditions.
 *
 * A NEP transfer whose source is the account's own proxy address is reported as an error (OP_001): the token
 * checks that address as a witness, an owner or relay signature does not provide it, so the transfer returns false
 * while the transaction HALTs, burns the nonce and pays the fee (recorded on the deployed core, SA-03 case a).
 *
 * An account without a verifier is a complete smart account, not an error: executeUserOp then authorizes through
 * the backup owner's native witness. The simulation follows the same branch (checks.authorization is
 * 'owner-witness'): it requires a non-zero backup owner and, when `signers` are supplied, that they carry the
 * backup owner's witness. Without `signers` it passes with a warning naming the account that must sign.
 *
 * IMPORTANT: This is a pre-flight preview only. It checks the deadline, nonce
 * and the authorization path, but it does NOT verify the UserOperation signature or
 * its session scope. A `passed: true` result therefore means "the previewed
 * conditions look acceptable", NOT "this operation will execute". The returned
 * {@link SimulationResult.signatureVerified} flag is always false to make this
 * contract explicit. The signature is only validated by the on-chain
 * executeUserOp (or by the relay's full-operation simulation).
 *
 * @param {SmartAccountClient} client - The SDK client instance
 * @param {Object} options - Simulation options
 * @param {string} options.accountIdHash - Account ID hash
 * @param {string} options.accountAddress - Legacy account address (alternative)
 * @param {string} options.targetContract - Target contract hash
 * @param {string} options.method - Method name
 * @param {Array} options.args - Method arguments
 * @param {string|number} options.nonce - Nonce value
 * @param {string|number} options.deadline - Deadline in Neo Runtime.Time milliseconds
 * @param {Array} [options.signers] - RPC signers of the transaction that will carry the operation. Only used for
 *   an account without a verifier, to check that the backup owner's witness is among them
 * @returns {Promise<SimulationResult>} Simulation results. `passed` reflects the
 *   preview checks only and never implies signature validity; `signatureVerified`
 *   is always false.
 *
 * @example
 * const result = await simulateUserOperation(client, {
 *   accountIdHash: 'f951...',
 *   targetContract: '49c0...',
 *   method: 'transfer',
 *   args: [],
 *   nonce: 0,
 *   deadline: Date.now() + 3600_000,
 * });
 *
 * if (!result.passed) {
 *   console.error('Simulation failed:', result.errors);
 *   throw new Error(result.errors[0]);
 * }
 * // result.signatureVerified is always false: the signature must still be
 * // validated on-chain by executeUserOp (or by the relay's full simulation).
 */
async function simulateUserOperation(client, options) {
  const {
    accountIdHash = '',
    accountAddress = '',
    targetContract,
    method,
    args = [],
    nonce,
    deadline,
    signers,
  } = options || {};

  const errors = [];
  const warnings = [];

  // Basic validation
  if (!accountIdHash && !accountAddress) {
    return {
      passed: false,
      signatureVerified: false,
      checks: {},
      errors: ['Account ID hash or address is required'],
      warnings,
    };
  }

  if (!targetContract) {
    return {
      passed: false,
      signatureVerified: false,
      checks: {},
      errors: ['Target contract is required'],
      warnings,
    };
  }

  if (!method) {
    return {
      passed: false,
      signatureVerified: false,
      checks: {},
      errors: ['Method name is required'],
      warnings,
    };
  }

  const source = hash160FromParam(args?.[0]);
  const transferFromProxy = resolveProxyHashes(client, { accountIdHash, accountAddress })
    .some((proxy) => isProxySourcedTransfer({ method, from: source, proxy }));
  if (transferFromProxy) {
    errors.push(formatError(createError(EC.OPERATION_PROXY_TRANSFER_REFUSED)));
  }

  // Validate deadline against Neo Runtime.Time, which is expressed in milliseconds.
  const now = BigInt(Date.now());
  const deadlineNum = BigInt(deadline || 0);
  const isDeadlineValid = deadlineNum > now;

  if (!isDeadlineValid) {
    errors.push(`Deadline has passed. Current: ${now}, Deadline: ${deadlineNum}`);
  } else if (deadlineNum > now + BigInt(7 * 24 * 60 * 60 * 1000)) {
    // Warn if deadline is more than 7 days in the future
    warnings.push(`Deadline is more than 7 days in the future (${(deadlineNum - now) / BigInt(60 * 60 * 1000)} hours)`);
  }

  try {
    const request = {
      accountIdHash,
      accountAddress,
      targetContract,
      method,
      args,
      nonce: nonce || 0,
      deadline: deadline || 0,
    };

    // Call the contract's previewUserOpValidation method
    const preview = await client.getUserOpValidationPreview(request);

    const checks = {
      deadlineValid: isDeadlineValid && Boolean(preview.deadlineValid),
      nonceAcceptable: Boolean(preview.nonceAcceptable),
      hasVerifier: Boolean(preview.hasVerifier),
      verifier: preview.verifier || '',
      hook: preview.hook || '',
      authorization: preview.hasVerifier ? 'verifier' : 'owner-witness',
      backupOwner: '',
    };

    // Analyze results
    if (!checks.nonceAcceptable) {
      errors.push('Nonce is not acceptable. It may have already been used or is out of range.');
    }

    if (!checks.hasVerifier) {
      // Same branch as executeUserOp: no verifier means the backup owner's native witness authorizes.
      await checkOwnerWitnessAuthorization(client, request, signers, checks, errors, warnings);
    } else if (!checks.verifier || sanitizeHex(checks.verifier) === ZERO_HASH160) {
      errors.push('Preview reports a verifier but returned no verifier hash. The account state could not be read consistently.');
    }

    // Additional checks based on preview
    if (preview.hook && !isDeadlineValid) {
      warnings.push('Hook is configured but deadline validation may cause rejection');
    }

    return {
      // passed reflects the preview checks only; the signature is never checked
      // here, so this must not be treated as "executable".
      passed: errors.length === 0,
      signatureVerified: false,
      checks,
      errors,
      warnings,
    };
  } catch (error) {
    const mappedError = mapRpcError(error);
    if (mappedError) {
      errors.push(mappedError.message);
    } else {
      errors.push(error.message || 'Unknown simulation error');
    }
    return {
      passed: false,
      signatureVerified: false,
      checks: {},
      errors,
      warnings,
    };
  }
}

/**
 * Checks if a verifier is valid for the account.
 * Both the expected hash input and the reported current hash are big-endian
 * display hex — getAccountState normalizes the node's little-endian wire
 * bytes, so the comparison is byte-order safe against real nodes.
 * @param {SmartAccountClient} client - The SDK client instance
 * @param {string} accountHashOrAddress - Account hash or address
 * @param {string} verifierHash - Verifier contract hash to check (big-endian display hex)
 * @returns {Promise<Object>} Check result with valid flag and details (hashes in big-endian display hex)
 */
async function checkVerifier(client, accountHashOrAddress, verifierHash) {
  try {
    const accountState = await client.getAccountState(accountHashOrAddress);
    const currentVerifier = accountState.verifier;

    return {
      valid: currentVerifier === sanitizeHex(verifierHash),
      currentVerifier,
      expectedVerifier: sanitizeHex(verifierHash),
      configured: Boolean(currentVerifier),
    };
  } catch (error) {
    return {
      valid: false,
      error: error.message,
    };
  }
}

/**
 * Checks if a hook is valid for the account.
 * Hash inputs and outputs are big-endian display hex, matching getAccountState.
 * @param {SmartAccountClient} client - The SDK client instance
 * @param {string} accountHashOrAddress - Account hash or address
 * @param {string} hookHash - Hook contract hash to check (optional, big-endian display hex)
 * @returns {Promise<Object>} Check result with valid flag and details (hashes in big-endian display hex)
 */
async function checkHook(client, accountHashOrAddress, hookHash) {
  try {
    const accountState = await client.getAccountState(accountHashOrAddress);
    const currentHook = accountState.hook;

    if (!hookHash) {
      // Just check if any hook is configured
      return {
        valid: Boolean(currentHook),
        currentHook,
        configured: Boolean(currentHook),
      };
    }

    return {
      valid: currentHook === sanitizeHex(hookHash),
      currentHook,
      expectedHook: sanitizeHex(hookHash),
      configured: Boolean(currentHook),
    };
  } catch (error) {
    return {
      valid: false,
      error: error.message,
    };
  }
}

/**
 * Checks if the account's escape hatch is active.
 * @param {SmartAccountClient} client - The SDK client instance
 * @param {string} accountHashOrAddress - Account hash or address
 * @returns {Promise<Object>} Check result with escape status
 */
async function checkEscapeStatus(client, accountHashOrAddress) {
  try {
    const accountState = await client.getAccountState(accountHashOrAddress);

    return {
      active: Boolean(accountState.escapeActive),
      triggeredAt: accountState.escapeTriggeredAt,
      timelock: accountState.escapeTimelock,
      hasTimelockExpired: accountState.escapeActive &&
                          (Date.now() > parseInt(accountState.escapeTriggeredAt, 10) +
                                        (parseInt(accountState.escapeTimelock, 10) * 1000)),
    };
  } catch (error) {
    return {
      active: false,
      error: error.message,
    };
  }
}

/**
 * Estimates gas for a UserOperation.
 * Note: This requires the contract to support gas estimation.
 * @param {SmartAccountClient} client - The SDK client instance
 * @param {Object} userOp - The UserOperation to estimate
 * @returns {Promise<Object>} Gas estimate or error
 */
async function estimateGas(client, userOp) {
  // This is a placeholder - actual implementation depends on contract support
  // for gas estimation. In Neo N3, gas is determined by the VM during execution.
  return {
    supported: false,
    message: 'Gas estimation is not directly supported. Use simulation instead.',
  };
}

/**
 * Runs a comprehensive pre-flight check suite.
 * All Hash160 options (verifierHash, hookHash) are big-endian display hex;
 * reported hashes in the results use the same byte order.
 * @param {SmartAccountClient} client - The SDK client instance
 * @param {Object} options - Check options
 * @returns {Promise<Object>} Comprehensive check results
 */
async function preFlightCheck(client, options) {
  const {
    accountHashOrAddress,
    verifierHash,
    hookHash,
    userOp,
  } = options || {};

  const results = {
    passed: true,
    checks: {},
    errors: [],
    warnings: [],
  };

  // 1. Check account exists
  try {
    const accountState = await client.getAccountState(accountHashOrAddress);
    results.checks.accountExists = true;
    results.checks.accountState = accountState;
  } catch (error) {
    results.passed = false;
    results.checks.accountExists = false;
    results.errors.push('Account not found or not registered');
    return results;
  }

  // 2. Check escape status
  const escapeStatus = await checkEscapeStatus(client, accountHashOrAddress);
  results.checks.escape = escapeStatus;

  if (escapeStatus.active) {
    if (escapeStatus.hasTimelockExpired) {
      results.warnings.push('Escape hatch timelock has expired. Account may be in recovery mode.');
    } else {
      results.warnings.push('Escape hatch is active. Operations may be restricted.');
    }
  }

  // 3. Check verifier
  if (verifierHash) {
    const verifierCheck = await checkVerifier(client, accountHashOrAddress, verifierHash);
    results.checks.verifier = verifierCheck;

    if (!verifierCheck.valid) {
      results.passed = false;
      results.errors.push(`Verifier mismatch. Current: ${verifierCheck.currentVerifier}, Expected: ${verifierCheck.expectedVerifier}`);
    }
  }

  // 4. Check hook
  if (hookHash) {
    const hookCheck = await checkHook(client, accountHashOrAddress, hookHash);
    results.checks.hook = hookCheck;

    if (!hookCheck.valid) {
      results.passed = false;
      results.errors.push(`Hook mismatch. Current: ${hookCheck.currentHook}, Expected: ${hookCheck.expectedHook}`);
    }
  }

  // 5. Simulate UserOperation if provided
  if (userOp) {
    const simResult = await simulateUserOperation(client, userOp);
    results.checks.simulation = simResult;

    if (!simResult.passed) {
      results.passed = false;
      results.errors.push(...simResult.errors);
    }

    if (simResult.warnings.length > 0) {
      results.warnings.push(...simResult.warnings);
    }
  }

  return results;
}

module.exports = {
  simulateUserOperation,
  checkVerifier,
  checkHook,
  checkEscapeStatus,
  estimateGas,
  preFlightCheck,
};

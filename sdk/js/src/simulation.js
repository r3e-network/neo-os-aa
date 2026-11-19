/**
 * v4 simulation and preflight.
 *
 * A simulation is evidence, not permission: it runs the exact script a
 * transaction would carry, in the same signer order, and reports what the core
 * answered. A preflight is the local half — account state, digest agreement,
 * channel nonce, deadline and validator instance — checked before a wallet is
 * asked to sign anything.
 *
 * Removed v3 surface: `simulateValidation`, `checkVerifier`, `checkHook`,
 * `checkEscapeStatus`, `estimateUserOperationGas`. v4 has no verifier/hook
 * objects to check and no gas estimation RPC of its own: the fee comes from
 * `invokescript` and the transaction's `calculatenetworkfee`.
 */

const { codec } = require('./codec');
const { EC, createError } = require('./errors');
const { validateAccountId } = require('./validation');

const fail = (errorCode, details) => {
  throw createError(errorCode, details);
};

/**
 * Simulates one execution script over 1..32 operations.
 *
 * @returns {Promise<Object>} `{ plan, state, exception, stack, incompleteTransfers,
 *   gasConsumed, minimumRequiredFee }` — a fault is reported, not thrown.
 */
async function simulateUserOperation(client, { accountId, operations, signers = [] } = {}) {
  validateAccountId(codec.hex(accountId, 20));
  const plan = client.buildExecutionScript({ accountId, operations });
  client.prepare(plan);
  return { plan, ...(await client.simulate(plan, signers)) };
}

/**
 * Preflights an unsigned operation against the account's current state.
 *
 * Every check answers a question the chain would otherwise answer with an
 * `SA_*` abort after the signature was already produced: the account is
 * active, the local digest is the core's digest, the nonce is the next
 * sequence on the derived channel, the deadline has not passed, and the
 * validator instance is installed at the generation and epoch the operation
 * names.
 */
async function preflightUserOperation(client, { accountId, operation } = {}) {
  const id = codec.hex(accountId, 20);
  if (!operation || typeof operation !== 'object') {
    fail(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'operation is required' });
  }
  const account = await client.getAccount(id);
  if (!account) fail(EC.ACCOUNT_NOT_FOUND, { hint: id });
  if (account.status !== 0) {
    fail(EC.ACCOUNT_STATUS_INVALID, { hint: account.statusName, accountId: id });
  }

  const now = Date.now();
  if (BigInt(operation.deadline) <= BigInt(now)) {
    fail(EC.VALIDATION_DEADLINE_INVALID, {
      hint: 'deadline has passed',
      deadline: String(operation.deadline),
      now: String(now),
    });
  }

  const digest = await client.getOperationDigest(id, operation);

  const routing = {
    authorityEpoch: operation.authorityEpoch,
    validatorId: operation.validatorId,
    credentialGeneration: operation.credentialGeneration,
    nonceSubkey: operation.nonceSubkey,
  };
  const requested = codec.splitNonce(operation.nonce);
  const channel = BigInt(client.deriveNonceRouting(id, routing));
  if (requested.channel !== channel) {
    fail(EC.VALIDATION_NONCE_UNACCEPTABLE, {
      hint: 'nonce channel is not the derived namespace',
      derived: channel.toString(),
      supplied: requested.channel.toString(),
    });
  }
  const sequence = BigInt(await client.getNonceSequence(id, channel.toString()));
  if (requested.sequence !== sequence) {
    fail(EC.VALIDATION_NONCE_UNACCEPTABLE, {
      hint: 'nonce sequence is not the next one on this channel',
      expected: sequence.toString(),
      supplied: requested.sequence.toString(),
    });
  }

  if (BigInt(operation.authorityEpoch) !== BigInt(account.authorityEpoch)) {
    fail(EC.VALIDATION_NONCE_UNACCEPTABLE, {
      hint: 'authority epoch is not current',
      current: account.authorityEpoch,
    });
  }
  if (BigInt(operation.configurationNonce) !== BigInt(account.configurationNonce)) {
    fail(EC.VALIDATION_OPTIONS_REQUIRED, {
      hint: 'configuration nonce is not current',
      current: account.configurationNonce,
    });
  }

  const validator = await client.getModule(id, operation.validatorId);
  if (!validator) {
    fail(EC.MODULE_NOT_INSTALLED, {
      hint: `validator ${operation.validatorId} is not installed`,
    });
  }
  if (validator.credentialGeneration !== String(operation.credentialGeneration)) {
    fail(EC.VALIDATION_OPTIONS_REQUIRED, {
      hint: 'credential generation is stale for this validator',
      current: validator.credentialGeneration,
      supplied: String(operation.credentialGeneration),
    });
  }

  return Object.freeze({
    accountId: id,
    accountAddress: account.accountAddress,
    operationDigest: digest,
    channel: channel.toString(),
    sequence: sequence.toString(),
    validator,
  });
}

/**
 * Simulates a prepared plan in the signer order it will be submitted in.
 * A review needs the failure, so this never throws on a VM fault.
 */
async function simulatePlan(client, plan, signers = []) {
  if (!plan || typeof plan !== 'object') {
    fail(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'plan is required' });
  }
  client.prepare(plan);
  return client.simulate(plan, signers);
}

module.exports = {
  simulateUserOperation,
  simulatePlan,
  preflightUserOperation,
};

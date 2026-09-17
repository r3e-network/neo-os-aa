/**
 * Type-level consumer test for the published SDK declarations.
 *
 * This file is never executed; it is type-checked by `npm run types:check`
 * (tsc --noEmit) to guarantee the public `.d.ts` keeps describing the real
 * runtime surface. It imports the package by name so the `types` field in
 * package.json is exercised the same way a downstream consumer would.
 */
import {
  AbstractAccountClient,
  UserOperationBuilder,
  createUserOpBuilder,
  simulateUserOperation,
  preFlightCheck,
  buildV3UserOperationTypedData,
  buildMetaTransactionTypedData,
  buildContractCompatibleStructHash,
  buildWeb3AuthSigningPayload,
  toBytes20Word,
  toUint256Word,
  withRetry,
  isRetryableError,
  formatError,
  createError,
  mapRpcError,
  EC,
} from 'neo-abstract-account';
import type {
  UserOperation,
  UserOperationTypedData,
  MetaTransactionTypedData,
  AccountState,
  SimulationResult,
  ContractInvocationPayload,
  SdkError,
} from 'neo-abstract-account';

const ACCOUNT_ID = 'f951cd3eb5196dacde99b339c5dcca37ac38cc22';
const VERIFIER = 'b4107cb2cb4bace0ebe15bc4842890734abe133a';
const CORE = 'dbf38e7b2117186bf7a5e17ead702322c0c5b6f2';
const MASTER = '5be915aea3ce85e4752d522632f0a9520e377aaf';
const TARGET = '49c095ce04d38642e39155f5481615c58227a498';
const PAYMASTER = '27a81e6d04d38642e39155f5481615c58227a498';
const SPONSOR = 'NXV6kqVqp4Qh3Dx8a9z2sCq8sQ4QZbZ4q';
const ARGS_HASH = 'ab'.repeat(32);

// --- Client construction ---------------------------------------------------
const client = new AbstractAccountClient('https://rpc.example.com', MASTER);

// --- UserOperationBuilder fluent API ---------------------------------------
const builder: UserOperationBuilder = createUserOpBuilder()
  .setAccountId(ACCOUNT_ID)
  .setTarget(TARGET)
  .setMethod('transfer')
  .setArgs([{ type: 'Hash160', value: '0xabc' }])
  .addArg({ type: 'Integer', value: 1 })
  .setVerifier(VERIFIER)
  .setCoreContract(CORE)
  .setChainId(860833102)
  .setNonce(7)
  .setDeadline(Date.now() + 3_600_000)
  .setArgsHash(ARGS_HASH);

const userOp: UserOperation = builder.build();
const v3Typed: UserOperationTypedData = builder.buildEIP712(ARGS_HASH);
const legacyTyped: MetaTransactionTypedData = builder.buildLegacyEIP712(ARGS_HASH, MASTER);

// Typed-data message shape is type-sensitive (V3 signs `method`, legacy `methodHash`).
const v3Method: string = v3Typed.message.method;
const legacyMethodHash: string = legacyTyped.message.methodHash;
const v3Nonce: string = v3Typed.message.nonce;

// autoNonce overloads: sync fetcher returns the builder, async returns a promise.
const syncChain: UserOperationBuilder = builder.autoNonce(() => 3);
async function exerciseAutoNonce(): Promise<void> {
  const asyncChain: UserOperationBuilder = await builder.autoNonce(async () => 9);
  asyncChain.build();
}
void exerciseAutoNonce;

const direct = new UserOperationBuilder({ accountIdHash: ACCOUNT_ID, chainId: 1 });
const snapshot = direct.toJSON();
const cachedArgsHash: string | null = snapshot.argsHash;
void cachedArgsHash;

// --- createEIP712Payload (Promise of either layout) ------------------------
async function exercisePayloads(): Promise<void> {
  const typedData: UserOperationTypedData | MetaTransactionTypedData =
    await client.createEIP712Payload({
      chainId: 860833102,
      accountIdHash: ACCOUNT_ID,
      verifierHash: VERIFIER,
      targetContract: TARGET,
      method: 'transfer',
      args: [{ type: 'Hash160', value: '0xabc' }],
      nonce: 0,
      deadline: Date.now() + 3_600_000,
    });
  const domainName: string = typedData.domain.name;
  void domainName;

  const argsHash: string = await client.computeArgsHash([]);
  void argsHash;

  // getAccountState return shape.
  const state: AccountState = await client.getAccountState(ACCOUNT_ID);
  const verifier: string = state.verifier;
  const escapeActive: boolean = state.escapeActive;
  const escapeTimelock: string = state.escapeTimelock;
  void verifier;
  void escapeActive;
  void escapeTimelock;

  // SimulationResult.signatureVerified is the literal `false`.
  const sim: SimulationResult = await simulateUserOperation(client, {
    accountIdHash: ACCOUNT_ID,
    targetContract: TARGET,
    method: 'transfer',
    args: [],
    nonce: 0,
    deadline: Date.now() + 3_600_000,
  });
  const verified: false = sim.signatureVerified;
  const passed: boolean = sim.passed;
  void verified;
  void passed;

  const preflight = await preFlightCheck(client, {
    accountHashOrAddress: ACCOUNT_ID,
    verifierHash: VERIFIER,
    userOp: { targetContract: TARGET, method: 'transfer', nonce: 0, deadline: 1 },
  });
  void preflight.passed;

  // Sponsored payload shape.
  const sponsored: ContractInvocationPayload = client.createSponsoredUserOpPayload({
    accountAddress: ACCOUNT_ID,
    userOp,
    paymasterHash: PAYMASTER,
    sponsorAddress: SPONSOR,
    reimbursementAmount: '100000000',
  });
  const op: string = sponsored.operation;
  void op;

  const balance: string = await client.querySponsorBalance(PAYMASTER, SPONSOR);
  void balance;
}
void exercisePayloads;

// --- Standalone meta-tx + signing helpers ----------------------------------
const standaloneTyped = buildV3UserOperationTypedData({
  chainId: 1,
  verifyingContract: VERIFIER,
  accountIdHash: ACCOUNT_ID,
  coreContractHash: CORE,
  targetContract: TARGET,
  method: 'transfer',
  argsHashHex: ARGS_HASH,
  nonce: 0,
  deadline: 1,
});
void standaloneTyped.message.accountId;

const legacyStandalone = buildMetaTransactionTypedData({
  chainId: 1,
  verifyingContract: MASTER,
  accountAddressScriptHash: ACCOUNT_ID,
  targetContract: TARGET,
  method: 'transfer',
  argsHashHex: ARGS_HASH,
  nonce: 0,
  deadline: 1,
});
void legacyStandalone.message.accountAddress;

const structHash: string = buildContractCompatibleStructHash({
  accountIdHash: ACCOUNT_ID,
  coreContractHash: CORE,
  targetContract: TARGET,
  method: 'transfer',
  argsHash: ARGS_HASH,
  nonce: 0,
  deadline: 1,
});
void structHash;

const signingPayload: Uint8Array = buildWeb3AuthSigningPayload({
  chainId: 1,
  verifierHash: VERIFIER,
  accountIdHash: ACCOUNT_ID,
  coreContractHash: CORE,
  targetContract: TARGET,
  method: 'transfer',
  argsHash: ARGS_HASH,
  nonce: 0,
  deadline: 1,
});
void signingPayload;

const word20: Uint8Array = toBytes20Word(ACCOUNT_ID);
const word256: Uint8Array = toUint256Word(42n);
void word20;
void word256;

// --- Retry utilities (generic) ---------------------------------------------
async function exerciseRetry(): Promise<void> {
  const result: number = await withRetry('read', async () => 5);
  void result;
}
void exerciseRetry;
const retryable: boolean = isRetryableError(new Error('ECONNRESET'));
void retryable;

// --- Errors -----------------------------------------------------------------
const err: SdkError = createError(EC.VALIDATION_HASH160_INVALID, { provided: 'x' });
const code: string = err.code;
const formatted: string = formatError(err);
const mapped = mapRpcError('method not found');
void code;
void formatted;
void mapped;

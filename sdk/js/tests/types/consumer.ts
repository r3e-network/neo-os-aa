/**
 * Type-level consumer test for the published SDK declarations.
 *
 * This file is never executed; it is type-checked by `npm run types:check`
 * (tsc --noEmit) to guarantee the public `.d.ts` keeps describing the real
 * runtime surface. It imports the package by name so the `types` field in
 * package.json is exercised the same way a downstream consumer would.
 *
 * Every name the package exports at runtime appears here at least once: a
 * declaration that drifts from `src/index.js` fails this file, not a user.
 */
import {
  // Protocol identity
  DEFAULT_CALL_FLAGS,
  NATIVE_ABI_VERSION,
  NATIVE_PROFILE_PARAMETER_DIGEST,
  NATIVE_PROXY_CALL_FLAGS,
  NATIVE_REQUIRED_ABI,
  NATIVE_REQUIRED_EVENTS,
  NATIVE_SMART_ACCOUNT_CONTRACT,
  PROTOCOL_VERSION,
  USER_OPERATION_DOMAIN_NAME,
  USER_OPERATION_DOMAIN_VERSION,
  codec,
  nativeCodec,
  // Clients
  NativeSmartAccountClient,
  createNativeSmartAccountClient,
  normalizeAddress,
  // Operations
  UserOperationBuilder,
  createUserOpBuilder,
  // Signing surfaces
  buildUserOperationTypedData,
  buildUserOperationSigningPayload,
  buildUserOperationSigningDigest,
  methodHash,
  toBytes20Word,
  toAddressWord,
  toUint256Word,
  sanitizeHex,
  decodeByteStringStackHex,
  decodeIntegerStack,
  decodeStackBoolean,
  decodeHash160Stack,
  decodeValidationPreviewStack,
  decodeAccountDescriptorStack,
  decodeModuleDescriptorStack,
  decodeRecoveryStatusStack,
  // Threshold
  THRESHOLD_MAX_MEMBERS,
  createThresholdClient,
  thresholdTools,
  serializeMemberSignatures,
  toMultiSigRpcParameter,
  // Proxy witness
  buildExecuteUserOpScript,
  buildProxyWalletSignRequest,
  buildProxyWitnessTransaction,
  createProxyVerificationScript,
  createProxyWitness,
  resolveProxyWitnessTransaction,
  // Transfer result rules
  TRANSFER_RETURNED_FALSE,
  TRANSFER_RETURNED_FALSE_MESSAGE,
  findFailedTransferInExecution,
  findFailedTransferInInvocation,
  isProxySourcedTransfer,
  // Session keys
  SESSION_KEY_CLEAR_COMMAND,
  SESSION_KEY_INSTALL_COMMAND,
  MAX_SESSION_DURATION_MS,
  MAX_SESSION_KEY_DESCRIPTION_BYTES,
  buildSessionKeyClearCommand,
  buildSessionKeyInstallCommand,
  buildSessionKeyPermission,
  // Errors and utilities
  EC,
  SA_ERRORS,
  SA_ERROR_CODES,
  createError,
  mapRpcError,
  formatError,
  withRetry,
  // Native transaction tools
  transactionTools,
  codeIdentityTools,
} from '@r3e-network/neo-smart-account';
import type {
  AccountActionPlan,
  AccountDescriptor,
  CreateAccountInput,
  NativePlan,
  NativePreparedTransaction,
  NativeSignedTransaction,
  NativeSignedTransactionArtifact,
  NativeTransactionPreflight,
  NativeTransactionReceipt,
  ProtocolCodec,
  RegistrationPlan,
  SignerDescriptor,
  SimulationResult,
  SmartAccountKernel,
  UserOperation,
  UserOperationTypedData,
  VMValue,
  WalletSigner,
} from '@r3e-network/neo-smart-account';

const ACCOUNT_ID = 'f2125dfcd4f8992f79231d8c175fc499baa10130';
const CUSTODY = '202122232425262728292a2b2c2d2e2f30313233';
const CORE = '398dc3f0227d7efac5533ed5ce9937390c158084';
const TARGET = '49c095ce04d38642e39155f5481615c58227a498';
const NETWORK = 305419896;
const SALT = '404142434445464748494a4b4c4d4e4f';
const NONCE_SUBKEY = '11'.repeat(32);

/** Type-only unwrap: a declaration mismatch fails here, not at runtime. */
declare function awaited<T>(value: Promise<T>): T;

// --- Protocol identity ------------------------------------------------------
const version: 4 = PROTOCOL_VERSION;
const abiVersion: 4 = NATIVE_ABI_VERSION;
const profileDigest: string = NATIVE_PROFILE_PARAMETER_DIGEST;
const nativeFlags: 5 = NATIVE_PROXY_CALL_FLAGS;
const defaultFlags: 5 = DEFAULT_CALL_FLAGS;
const domainName: 'Neo Smart Account' = USER_OPERATION_DOMAIN_NAME;
const domainVersion: '4' = USER_OPERATION_DOMAIN_VERSION;
const nativeContract: string = NATIVE_SMART_ACCOUNT_CONTRACT;
const requiredEvents: readonly string[] = NATIVE_REQUIRED_EVENTS;
const coreAbi: readonly string[] = NATIVE_REQUIRED_ABI.getAccount[0];
const sharedCodec: ProtocolCodec = codec;
const nativeSurface: ProtocolCodec = nativeCodec;

// --- Codec derivations ------------------------------------------------------
const identity = codec.deriveIdentity({
  custodyAddress: CUSTODY,
  salt: SALT,
  coreContractHash: CORE,
  callFlags: nativeFlags,
});
const accountId: string = identity.accountId;
const accountAddress: string = codec.accountAddress(ACCOUNT_ID, {
  coreContractHash: CORE,
  callFlags: nativeFlags,
});
const channel: string = codec.deriveNonceChannel(
  { networkMagic: NETWORK, coreContractHash: CORE, accountId: ACCOUNT_ID },
  {
    authorityEpoch: '1',
    validatorId: 0,
    credentialGeneration: 1,
    nonceSubkey: NONCE_SUBKEY,
  },
);
const packedNonce: bigint = codec.composeNonce(channel, '0');
const split: { channel: bigint; sequence: bigint } = codec.splitNonce(packedNonce);

// --- UserOperationBuilder ---------------------------------------------------
const operation: UserOperation = createUserOpBuilder({ networkMagic: NETWORK })
  .setCoreContractHash(CORE)
  .setAccountId(ACCOUNT_ID)
  .setTarget(TARGET)
  .setMethod('transfer')
  .setArgs([
    codec.hashValue(ACCOUNT_ID),
    codec.integerValue(1),
  ])
  .setRouting({ validatorId: 0, credentialGeneration: '1', authorityEpoch: '1', configurationNonce: '1' })
  .setNonceSubkey(NONCE_SUBKEY)
  .setNonceSequence({ channel, sequence: '0' })
  .autoDeadline()
  .setSignature('aa'.repeat(64))
  .build();
const builderAgain: UserOperationBuilder = new UserOperationBuilder({
  networkMagic: NETWORK,
});
const digest: string = codec.operationDigest(
  { networkMagic: NETWORK, coreContractHash: CORE, accountId: ACCOUNT_ID },
  operation,
);
const serialized: string = codec.serializeOperation(operation, true);
const value: VMValue = codec.operationValue(operation);
// The codec takes one complete 13-field operation: there is no list form.
const script: string = codec.buildExecutionScript(ACCOUNT_ID, operation, {
  networkMagic: NETWORK,
  coreContractHash: CORE,
  accountId: ACCOUNT_ID,
});

const decodedDescriptor = decodeAccountDescriptorStack(null);
const decodedModule = decodeModuleDescriptorStack(null);
const decodedRecovery = decodeRecoveryStatusStack(null);
const preview: { accepted: boolean; operationDigest: string } =
  decodeValidationPreviewStack(null);
const integer: bigint = decodeIntegerStack(null);
const flag: boolean = decodeStackBoolean(null);
const hash: string = decodeHash160Stack(null);
const bytesHex: string = decodeByteStringStackHex(null);

// --- Meta-transaction signing surface --------------------------------------
const typed: UserOperationTypedData = buildUserOperationTypedData({
  chainId: NETWORK,
  verifyingContract: TARGET,
  accountId: ACCOUNT_ID,
  coreContractHash: CORE,
  validatorId: 0,
  targetContract: TARGET,
  method: 'transfer',
  argsHashHex: 'ab'.repeat(32),
  nonce: packedNonce.toString(),
  deadline: '1700000000000',
  operationDigest: digest,
});
const payload: Uint8Array = buildUserOperationSigningPayload({
  chainId: NETWORK,
  verifyingContract: TARGET,
  accountId: ACCOUNT_ID,
  coreContractHash: CORE,
  targetContract: TARGET,
  method: 'transfer',
  argsHashHex: 'ab'.repeat(32),
  nonce: packedNonce.toString(),
  deadline: '1700000000000',
  operationDigest: digest,
});
const signingDigest: string = buildUserOperationSigningDigest({
  chainId: NETWORK,
  verifyingContract: TARGET,
  accountId: ACCOUNT_ID,
  coreContractHash: CORE,
  targetContract: TARGET,
  method: 'transfer',
  argsHashHex: 'ab'.repeat(32),
  nonce: packedNonce.toString(),
  deadline: '1700000000000',
  operationDigest: digest,
});
const selector: string = methodHash('transfer');
const word: Uint8Array = toBytes20Word(ACCOUNT_ID);
const addressWord: Uint8Array = toAddressWord(ACCOUNT_ID);
const integerWord: Uint8Array = toUint256Word(1);
const cleanHex: string = sanitizeHex('0xAB');

// --- Threshold route --------------------------------------------------------
const maxMembers: 10 = THRESHOLD_MAX_MEMBERS;
const memberDigest: string = thresholdTools.memberDigest(digest, 1, 1);
const preparedMembers = thresholdTools.prepareMembers({
  operationDigest: digest,
  members: [{ moduleId: 1, credentialGeneration: 1 }],
});
const memberSignature: string = serializeMemberSignatures([
  [1, 'aa'.repeat(64)],
]);
const rpcParameter: unknown = toMultiSigRpcParameter({ type: 'ByteArray', value: '00' });

// --- Proxy witness ----------------------------------------------------------
const proxyScript: string = createProxyVerificationScript({
  coreHash: CORE,
  accountId: ACCOUNT_ID,
});
const proxyArtifacts = createProxyWitness({
  coreHash: CORE,
  accountId: ACCOUNT_ID,
  proxyHash: accountAddress,
  feePayer: TARGET,
});
const executeScript: string = buildExecuteUserOpScript({
  coreHash: CORE,
  accountId: ACCOUNT_ID,
  invocation: { operation: 'executeUserOp', scriptHash: CORE, args: [] },
});
const proxyTransaction = buildProxyWitnessTransaction({
  coreHash: CORE,
  accountId: ACCOUNT_ID,
  invocation: { operation: 'executeUserOp', scriptHash: CORE, args: [] },
  proxyHash: accountAddress,
  feePayer: TARGET,
});
const walletRequest = buildProxyWalletSignRequest({ transaction: proxyTransaction });
const resolved = awaited(
  resolveProxyWitnessTransaction({
    coreHash: CORE,
    accountId: ACCOUNT_ID,
    invocation: { operation: 'executeUserOp', scriptHash: CORE, args: [] },
    proxyHash: accountAddress,
    feePayer: TARGET,
    readState: async () => ({ proxyHash: accountAddress }),
  }),
);
const proxySignerScope: string = proxyArtifacts.signer.scopes;

// --- Transfer result rules --------------------------------------------------
const transferFailure: 'transfer_returned_false' = TRANSFER_RETURNED_FALSE;
const transferText: string = TRANSFER_RETURNED_FALSE_MESSAGE;
const failedInvocation: number[] = findFailedTransferInInvocation({ stack: [] });
const failedExecution: number[] = findFailedTransferInExecution({});
const proxySourced: boolean = isProxySourcedTransfer({ method: 'transfer' });

// --- Session keys -----------------------------------------------------------
const installCommand: VMValue[] = buildSessionKeyInstallCommand({
  publicKeyHex: '02' + '11'.repeat(32),
  targetContract: TARGET,
  method: 'transfer',
  validUntilMs: 1_700_000_000_000,
  spendingLimitDatoshi: 1_000_000,
  description: 'daily',
});
const clearCommand: VMValue[] = buildSessionKeyClearCommand();
const permission = buildSessionKeyPermission({
  publicKeyHex: '02' + '11'.repeat(32),
  targetContract: TARGET,
  method: 'transfer',
  validUntilMs: 1_700_000_000_000,
});
const installName: 'setSessionKey' = SESSION_KEY_INSTALL_COMMAND;
const clearName: 'clearSessionKey' = SESSION_KEY_CLEAR_COMMAND;
const descriptionLimit: 128 = MAX_SESSION_KEY_DESCRIPTION_BYTES;
const durationLimit: number = MAX_SESSION_DURATION_MS;

// --- Errors -----------------------------------------------------------------
const code: string = EC.VALIDATION_OPTIONS_REQUIRED.code;
const saText: string = SA_ERRORS.SA_NONCE_INVALID;
const saCodes: readonly string[] = SA_ERROR_CODES;
const failure: Error = createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'x' });
const mapped = mapRpcError(new Error('SA_DEADLINE_EXPIRED'));
const formatted: string = formatError(failure);
const retried: number = awaited(
  withRetry('rpc.getblockcount', async () => 1, { maxAttempts: 2 }),
);

// --- The packaged client ----------------------------------------------------
const client = createNativeSmartAccountClient({
  rpcUrl: 'https://rpc.example.com',
  networkMagic: NETWORK,
});
const sameClient: NativeSmartAccountClient = client;
const kernel: SmartAccountKernel = client;
const normalized: string = normalizeAddress('NXV6kqVqp4Qh3Dx8a9z2sCq8sQ4QZbZ4q');

const registration: RegistrationPlan = client.buildCreateAccountScript({
  custodyAddress: CUSTODY,
  salt: SALT,
});
const moduleInstall: AccountActionPlan = client.buildAccountActionScript({
  method: 'installModule',
  accountId: ACCOUNT_ID,
  args: [codec.integerValue(1), codec.hashValue(TARGET), { type: 'Array', value: [] }],
});
const batch: AccountActionPlan = awaited(client.buildConfigurationBatchPlan({ accountId: ACCOUNT_ID, actions: [
  { method: 'setBuiltinAuthorization', defaultOperationAuthorization: true, defaultMessageAuthorization: false },
  { method: 'configureModule', moduleId: 3, data: [codec.integerValue(1)] },
] }));
const execution = client.buildExecutionScript({
  accountId: ACCOUNT_ID,
  operation,
});
const executionOperation: UserOperation = execution.operation;
const executionMethod: 'executeUserOp' = execution.method;
const executionSigners: SignerDescriptor[] = execution.signers.map((account) => ({
  account,
  scopes: 'WitnessRules',
}));
// Freezing is an account action; the client never grows a method per action.
const frozen = client.buildAccountActionScript({
  method: 'freezeAccount',
  accountId: ACCOUNT_ID,
});
const routed: string = client.deriveNonceRouting(ACCOUNT_ID, {
  authorityEpoch: '1',
  credentialGeneration: '1',
  nonceSubkey: NONCE_SUBKEY,
});
const lookup = awaited(client.getNonce(ACCOUNT_ID, { validatorId: 0, nonceSubkey: NONCE_SUBKEY }));
const state: AccountDescriptor | null = awaited(client.getAccount(ACCOUNT_ID));
const simulation: SimulationResult = awaited(client.simulate(execution));
const registrationRecipe: CreateAccountInput = {
  custodyAddress: CUSTODY,
  salt: SALT,
};

// --- Native kernel client ---------------------------------------------------
const nativeClient = new NativeSmartAccountClient({
  rpcUrl: 'https://rpc.example.com',
  networkMagic: NETWORK,
});
const nativePlan: NativePlan = nativeClient.buildCreateAccountScript({
  custodyAddress: CUSTODY,
  salt: SALT,
});
const nativeSimulation: SimulationResult = awaited(
  nativeClient.simulate(nativePlan),
);
// Supplying both namespace inputs turns the read into a stale-generation check.
const checked = awaited(
  nativeClient.getNonce(ACCOUNT_ID, {
    authorityEpoch: '1',
    validatorId: 0,
    credentialGeneration: '1',
    nonceSubkey: NONCE_SUBKEY,
  }),
);
const routingGeneration: string = awaited(
  nativeClient.resolveCredentialGeneration(ACCOUNT_ID, '2'),
);

// --- Transaction lifecycle --------------------------------------------------
const feePayer: WalletSigner = {
  account: TARGET,
  verificationScript: '0c21' + '02' + '11'.repeat(32) + '4156e7b327',
  sign: async () => 'aa'.repeat(64),
};
const prepared: NativePreparedTransaction = awaited(
  nativeClient.prepareTransaction(nativePlan, {
    feePayer,
    recipe: { method: 'buildCreateAccountScript', input: registrationRecipe },
    maxSystemFee: '100000000',
    maxNetworkFee: '100000000',
    maxTotalFee: '200000000',
  }),
);
const signed: NativeSignedTransaction = awaited(nativeClient.signTransaction(prepared));
const artifact: NativeSignedTransactionArtifact =
  nativeClient.exportSignedTransaction(signed);
const preflight: NativeTransactionPreflight = awaited(
  nativeClient.preflightTransaction(signed),
);
const receipt: NativeTransactionReceipt = awaited(
  nativeClient.getTransactionReceipt(signed),
);

// --- Shared tools -----------------------------------------------------------
const nativePrepared: NativePreparedTransaction = awaited(
  transactionTools.prepareNativeTransaction(nativeClient, nativePlan, {
    feePayer,
    recipe: { method: 'buildCreateAccountScript', input: registrationRecipe },
    maxSystemFee: '100000000',
    maxNetworkFee: '100000000',
    maxTotalFee: '200000000',
  }),
);
const identityTools = codeIdentityTools(codec);
const thresholdClient = createThresholdClient({ client });
const thresholdMembers = awaited(
  thresholdClient.prepareMembers({
    accountId: ACCOUNT_ID,
    operationDigest: digest,
    memberIds: [1],
  }),
);
const codeHash: string = identityTools.moduleCodeHash({
  nef: {
    magic: 0x3346454e,
    compiler: 'test',
    source: 'test',
    tokens: [],
    script: '',
    checksum: 0,
  },
  manifest: {},
});

// --- Removed v3 surface -----------------------------------------------------
// The v3 client took (url, coreHash); v4 takes one options object.
// @ts-expect-error - v3 client signature is gone
const legacyClient = new NativeSmartAccountClient('https://rpc.example.com', CORE);
// @ts-expect-error - setVerifier was removed with the v3 verifier model
builderAgain.setVerifier(TARGET);
// @ts-expect-error - the operation is 13 fields; a 6-field shape is rejected
const legacyOperation: UserOperation = {
  targetContract: TARGET,
  method: 'transfer',
  args: [],
  nonce: '0',
  deadline: '0',
  signature: 'aa',
};

void [
  version,
  abiVersion,
  profileDigest,
  nativeFlags,
  defaultFlags,
  domainName,
  domainVersion,
  nativeContract,
  requiredEvents,
  coreAbi,
  sharedCodec,
  nativeSurface,
  accountId,
  channel,
  split,
  script,
  builderAgain,
  serialized,
  value,
  decodedDescriptor,
  decodedModule,
  decodedRecovery,
  preview,
  integer,
  flag,
  hash,
  bytesHex,
  typed,
  payload,
  signingDigest,
  selector,
  word,
  addressWord,
  integerWord,
  cleanHex,
  maxMembers,
  memberDigest,
  preparedMembers,
  memberSignature,
  rpcParameter,
  proxyScript,
  proxyArtifacts,
  executeScript,
  proxyTransaction,
  walletRequest,
  resolved,
  proxySignerScope,
  transferFailure,
  transferText,
  failedInvocation,
  failedExecution,
  proxySourced,
  installCommand,
  clearCommand,
  permission,
  installName,
  clearName,
  descriptionLimit,
  durationLimit,
  code,
  saText,
  saCodes,
  failure,
  mapped,
  formatted,
  retried,
  sameClient,
  kernel,
  normalized,
  registration,
  executionSigners,
  executionOperation,
  executionMethod,
  thresholdMembers,
  moduleInstall,
  batch,
  frozen,
  routed,
  lookup,
  checked,
  routingGeneration,
  state,
  simulation,
  nativePlan,
  nativeSimulation,
  prepared,
  signed,
  artifact,
  preflight,
  receipt,
  nativePrepared,
  codeHash,
  legacyClient,
  legacyOperation,
];

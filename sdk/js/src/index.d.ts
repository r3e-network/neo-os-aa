/**
 * @r3e-network/neo-smart-account — Neo Smart Account v4 SDK.
 *
 * One client surface for two kernels. `SmartAccountClient` drives a deployed
 * custom kernel (market escrow, platform registrar, metadata, sponsored
 * execution); `NativeSmartAccountClient` drives the native core. Both speak the
 * same 13-field operation, nonce namespace, digests and `SA_*` vocabulary.
 *
 * There is no v3 compatibility layer: `registerAccount`, `getVerifier`,
 * `updateVerifier`, `getHook`, `updateHook`, `createSponsoredUserOpPayload`
 * and the 6-field operation do not exist.
 */

export * from "./native";

import type {
  AccountActionInput,
  AccountActionPlan,
  BroadcastResult,
  ConfigurationInput,
  ConfigurationPlan,
  ExecutionInput,
  ExecutionPlan,
  InvocationResult,
  ModuleBinding,
  NativePlan,
  NativePreparedTransaction,
  NativeProfile,
  NativeSignedTransaction,
  NativeSignedTransactionArtifact,
  NativeTransactionPreflight,
  NativeTransactionReceipt,
  ProtocolCodec,
  RegistrationPlan,
  SignerDescriptor,
  SignerScope,
  SimulationResult,
  SmartAccountKernel,
  TransactionOptions,
  UserOperation,
  VMInteger,
  VMValue,
  WitnessRule,
} from "./native";

/** The custom kernel pushes CallFlags.All in its proxy verification script. */
export declare const CUSTOM_PROXY_CALL_FLAGS: 15;
/** `SmartAccount.State.cs` pins this implementation id. */
export declare const CUSTOM_IMPLEMENTATION_ID: "org.r3e.neo.smart-account.v4";
/** Custom-only ABI gate: `[parameterTypes, returntype]` per method. */
export declare const CUSTOM_REQUIRED_ABI: Readonly<
  Record<string, readonly [readonly string[], string]>
>;

/** Neo address or 40-hex hash to display-order hex. */
export declare function normalizeAddress(address: string): string;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface UserOperationBuilderOptions {
  networkMagic?: VMInteger;
  coreContractHash?: string;
  accountId?: string;
}

/**
 * Builds the v4 13-field operation offline. The builder owns input shape only:
 * it composes the channel nonce, checks every bound and hands out the exact
 * value the core serializes. It never hashes a signature and never talks to RPC.
 */
export declare class UserOperationBuilder {
  constructor(options?: UserOperationBuilderOptions);
  setNetworkMagic(networkMagic: VMInteger): this;
  setCoreContractHash(coreContractHash: string): this;
  setAccountId(accountId: string): this;
  setTarget(targetContract: string): this;
  setMethod(method: string): this;
  setArgs(args?: VMValue[]): this;
  addArg(arg: VMValue): this;
  setRouting(routing: {
    validatorId?: VMInteger;
    credentialGeneration?: VMInteger;
    authorityEpoch: VMInteger;
    configurationNonce: VMInteger;
  }): this;
  setNonceSubkey(nonceSubkey: string): this;
  setNonce(nonce: VMInteger): this;
  setNonceSequence(input: { channel: VMInteger; sequence: VMInteger }): this;
  setDeadline(deadline: VMInteger): this;
  autoDeadline(bufferMs?: number): this;
  setSignature(signature: string): this;
  setHookProofs(hookProofs?: UserOperation["hookProofs"]): this;
  nonceChannel(): string;
  build(): UserOperation;
  digest(): string;
  toValue(): VMValue;
  serialize(): string;
  clone(): UserOperationBuilder;
  reset(): UserOperationBuilder;
  toJSON(): Record<string, unknown>;
}

export declare function createUserOpBuilder(
  options?: UserOperationBuilderOptions,
): UserOperationBuilder;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ErrorCode {
  readonly code: string;
  readonly message: string;
}

/** SDK error codes (`SDK_*`, `NET_*`, `CONTRACT_*`, `ENCODING_*`). */
export declare const EC: Readonly<Record<string, ErrorCode>>;
/** The contract's v4 abort codes mapped to their operator-facing text. */
export declare const SA_ERRORS: Readonly<Record<string, string>>;
export declare const SA_ERROR_CODES: readonly string[];

export declare function createError(
  errorCode: ErrorCode,
  details?: Record<string, unknown>,
): Error;
export declare function mapRpcError(
  error: unknown,
): (ErrorCode & { rpcDetail?: string }) | null;
export declare function formatError(error: unknown): string;

// ---------------------------------------------------------------------------
// Transfer result rules (shared with the relay route and the wallet)
// ---------------------------------------------------------------------------

export declare const TRANSFER_RETURNED_FALSE: "transfer_returned_false";
export declare const TRANSFER_RETURNED_FALSE_MESSAGE: string;
export declare function findFailedTransferInInvocation(input: {
  invocation?: unknown;
  stack?: readonly unknown[];
}): number[];
export declare function findFailedTransferInExecution(execution: unknown): number[];
export declare function isProxySourcedTransfer(input: {
  method?: string;
  from?: string;
  proxy?: string;
}): boolean;

// ---------------------------------------------------------------------------
// Session keys
// ---------------------------------------------------------------------------

export declare const SESSION_KEY_INSTALL_COMMAND: "setSessionKey";
export declare const SESSION_KEY_CLEAR_COMMAND: "clearSessionKey";
export declare const MAX_SESSION_KEY_DESCRIPTION_BYTES: 128;
export declare const MAX_SESSION_DURATION_MS: number;

export interface SessionKeyInstallOptions {
  publicKeyHex: string;
  targetContract: string;
  method: string;
  validUntilMs: VMInteger;
  spendingLimitDatoshi?: VMInteger;
  description?: string;
}

export interface SessionKeyPermissionRequest {
  readonly permission: {
    readonly signer: { readonly type: "key"; readonly data: { readonly publicKey: string } };
    readonly permissions: ReadonlyArray<{
      readonly type: "contract-call";
      readonly data: {
        readonly address: string;
        readonly selector: string;
        readonly spendingLimit: string;
      };
    }>;
    readonly expiry: number;
  };
  readonly installCommand: VMValue[];
  readonly sessionKeyArgs: {
    readonly publicKeyHex: string;
    readonly targetContract: string;
    readonly method: string;
    readonly validUntilMs: string;
    readonly spendingLimitDatoshi: string;
    readonly description: string;
  };
}

export declare function buildSessionKeyInstallCommand(
  options: SessionKeyInstallOptions,
): VMValue[];
export declare function buildSessionKeyClearCommand(): VMValue[];
export declare function buildSessionKeyPermission(
  options: SessionKeyInstallOptions,
): SessionKeyPermissionRequest;

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export declare function withRetry<T>(
  label: string,
  fn: (attempt: number) => Promise<T> | T,
  options?: RetryOptions | false,
): Promise<T>;

/** True for a transport failure the shared classification retries. */
export declare function isRetryableError(error: unknown): boolean;

// ---------------------------------------------------------------------------
// Simulation and preflight
// ---------------------------------------------------------------------------

/** What a simulation reported about one execution plan. */
export interface ExecutionSimulation extends SimulationResult {
  readonly plan: ExecutionPlan;
}

/**
 * Simulates exactly the script a transaction would carry. A VM fault is
 * reported, not thrown; `incompleteTransfers` names the positions of transfer
 * operations whose result was a Boolean false.
 */
export declare function simulateUserOperation(
  client: SmartAccountKernel,
  input: ExecutionInput,
): Promise<ExecutionSimulation>;

export declare function simulatePlan(
  client: SmartAccountKernel,
  plan: NativePlan,
  signers?: readonly SignerDescriptor[],
): Promise<SimulationResult>;

/** The local half of a preflight, before any wallet is asked to sign. */
export interface PreflightResult {
  readonly accountId: string;
  readonly accountAddress: string;
  readonly operationDigest: string;
  readonly channel: string;
  readonly sequence: string;
  readonly validator: ModuleBinding;
}

/**
 * Checks the account state, digest, channel nonce, deadline and validator
 * instance against one unsigned operation; throws the `SA_*`-shaped SDK error
 * the chain would otherwise raise after the signature was produced.
 */
export declare function preflightUserOperation(
  client: SmartAccountKernel,
  input: { accountId: string; operation: UserOperation },
): Promise<PreflightResult>;

// ---------------------------------------------------------------------------
// Proxy witness (the account's second signer)
// ---------------------------------------------------------------------------

export declare const DEFAULT_CALL_FLAGS: 15;

export interface ProxyInvocation {
  operation: string;
  scriptHash: string;
  args: unknown[];
}

export interface ProxyWitnessArtifacts {
  readonly signer: {
    readonly account: string;
    readonly scopes: "WitnessRules";
    readonly rules: readonly WitnessRule[];
    readonly allowedContracts?: readonly string[];
  };
  readonly witness: { readonly invocationScript: string; readonly verificationScript: string };
}

export interface ProxyWitnessTransaction {
  readonly script: string;
  readonly operation: string;
  readonly coreHash: string;
  readonly accountId: string;
  readonly proxyHash: string;
  readonly proxySigner: ProxyWitnessArtifacts["signer"];
  readonly proxyWitness: ProxyWitnessArtifacts["witness"];
  readonly feePayerSigner: SignerDescriptor;
  readonly signers: readonly SignerDescriptor[];
  readonly witness: ProxyWitnessArtifacts["witness"];
}

export declare function createProxyVerificationScript(input: {
  coreHash: string;
  accountId: string;
  callFlags?: number;
}): string;

export declare function createProxyWitness(input: {
  coreHash: string;
  accountId: string;
  proxyHash: string;
  feePayer: string;
  expectedProxyHash?: string;
  callFlags?: number;
}): ProxyWitnessArtifacts;

export declare function buildExecuteUserOpScript(input: {
  coreHash: string;
  accountId: string;
  invocation: ProxyInvocation;
  callFlags?: number;
}): string;

export declare function buildProxyWitnessTransaction(input: {
  coreHash: string;
  accountId: string;
  invocation: ProxyInvocation;
  proxyHash: string;
  expectedProxyHash?: string;
  feePayer: string;
  feePayerScope?: SignerScope;
  feePayerAllowedContracts?: readonly string[];
  callFlags?: number;
}): ProxyWitnessTransaction;

export declare function buildProxyWalletSignRequest(input: {
  transaction: ProxyWitnessTransaction;
  scope?: SignerScope;
  allowedContracts?: readonly string[];
}): ProxyWitnessTransaction & { readonly feePayerSigner: SignerDescriptor };

export declare function resolveProxyWitnessTransaction(input: {
  coreHash: string;
  accountId: string;
  invocation: ProxyInvocation;
  proxyHash: string;
  feePayer: string;
  readState: (state: { coreHash: string; accountId: string }) => Promise<{ proxyHash?: string }>;
  feePayerScope?: SignerScope;
  feePayerAllowedContracts?: readonly string[];
  callFlags?: number;
}): Promise<ProxyWitnessTransaction>;

// ---------------------------------------------------------------------------
// Threshold (validatorId route, §5)
// ---------------------------------------------------------------------------

export declare const THRESHOLD_MAX_MEMBERS: 10;

export interface ThresholdMemberInput {
  moduleId: VMInteger;
  credentialGeneration: VMInteger;
  signature?: string;
}

export interface PreparedThresholdMember {
  readonly moduleId: string;
  readonly credentialGeneration: string;
  readonly digest: string;
}

export interface ThresholdSignatureResult {
  readonly signatureHex: string;
  readonly members: readonly PreparedThresholdMember[];
}

/** The v4 threshold tools: member digests and the serialized field 11 value. */
export interface ThresholdTools {
  memberDigest(
    operationDigest: string,
    moduleId: VMInteger,
    credentialGeneration: VMInteger,
  ): string;
  prepareMembers(input: {
    operationDigest: string;
    members: readonly Pick<ThresholdMemberInput, "moduleId" | "credentialGeneration">[];
  }): readonly PreparedThresholdMember[];
  assembleSignature(input: { members: readonly ThresholdMemberInput[] }): string;
  assembleOperationSignature(input: {
    operationDigest: string;
    members: readonly ThresholdMemberInput[];
  }): ThresholdSignatureResult;
}

export declare const thresholdTools: ThresholdTools;

/**
 * The threshold tools bound to one account: the pure helpers, plus a member
 * reader that resolves each member's credential generation from the core
 * before computing its digest. `prepareMembers` therefore reads state and is
 * asynchronous, which is why it replaces the pure form instead of widening it.
 */
export interface ThresholdClient extends Omit<ThresholdTools, "prepareMembers"> {
  prepareMembers(input: {
    accountId: string;
    operationDigest: string;
    memberIds: readonly VMInteger[];
  }): Promise<readonly PreparedThresholdMember[]>;
}

export declare function createThresholdClient(options: {
  client: Pick<SmartAccountKernel, "getModule">;
}): ThresholdClient;

/** Serialized `[[memberModuleId, signature]]` list for operation field 11. */
export declare function serializeMemberSignatures(
  entries: ReadonlyArray<readonly [VMInteger, string]>,
): string;

/** Hex parameters to base64 JSON-RPC parameters. */
export declare function toMultiSigRpcParameter(parameter: any): any;

// ---------------------------------------------------------------------------
// Meta-transaction signing (the validator's EIP-712 surface)
// ---------------------------------------------------------------------------

export interface TypedDataInput {
  chainId: VMInteger;
  verifyingContract: string;
  accountId: string;
  coreContractHash: string;
  validatorId?: VMInteger;
  targetContract: string;
  method: string;
  argsHashHex: string;
  nonce: VMInteger;
  deadline: VMInteger;
  operationDigest: string;
}

export interface UserOperationTypedData {
  readonly domain: {
    readonly name: "Neo Smart Account";
    readonly version: "4";
    readonly chainId: VMInteger;
    readonly verifyingContract: string;
  };
  readonly types: {
    readonly UserOperation: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  };
  readonly message: {
    readonly accountId: string;
    readonly coreContract: string;
    readonly validatorId: string;
    readonly targetContract: string;
    readonly method: string;
    readonly argsHash: string;
    readonly nonce: string;
    readonly deadline: string;
    readonly operationDigest: string;
  };
}

export declare function buildUserOperationTypedData(
  input: TypedDataInput,
): UserOperationTypedData;
/** The 66-byte `0x1901 ‖ domainSeparator ‖ structHash` the validator verifies. */
export declare function buildUserOperationSigningPayload(
  input: TypedDataInput,
): Uint8Array;
/** keccak256 of the signing payload: the 32 bytes a raw signer signs. */
export declare function buildUserOperationSigningDigest(input: TypedDataInput): string;
export declare function methodHash(method: string): string;
export declare function toBytes20Word(hash160: string): Uint8Array;
export declare function toAddressWord(hash160: string): Uint8Array;
export declare function toUint256Word(value: VMInteger): Uint8Array;

export declare function sanitizeHex(value: unknown): string;
export declare function decodeByteStringStackHex(item: unknown): string;
export declare function decodeIntegerStack(item: unknown): bigint;
export declare function decodeStackBoolean(item: unknown): boolean;
export declare function decodeHash160Stack(item: unknown): string;

/** The `validateUserOp` preview: acceptance and the core's §4.3 digest. */
export declare function decodeValidationPreviewStack(item: unknown): {
  accepted: boolean;
  operationDigest: string;
};

/** The raw 16-field `getAccount` Array, decoded without a client identity. */
export interface DecodedAccountDescriptor {
  readonly exists: true;
  readonly status: number;
  readonly statusName: string;
  readonly custody: string;
  readonly recoveryAuthority: string;
  readonly authorityEpoch: string;
  readonly configurationNonce: string;
  readonly recoveryTimelockMs: string;
  readonly defaultOperationAuthorization: boolean;
  readonly defaultMessageAuthorization: boolean;
  readonly ownerOnlyRecovery: boolean;
  readonly hookOrderRevision: string;
  readonly controlRevision: string;
  readonly recoveryPending: boolean;
  readonly recoveryMatureAt: string;
  readonly marketEscrowActive: boolean;
  readonly legacyRow: boolean;
}

export interface DecodedModuleDescriptor {
  readonly moduleId: string;
  readonly moduleType: number;
  readonly contractHash: string;
  readonly contractId: string;
  readonly updateCounter: string;
  readonly nefSha256: string;
  readonly profileSha256: string;
  readonly moduleRevision: string;
  readonly credentialGeneration: string;
  readonly instanceIsolation: boolean;
  readonly messageCapability: boolean;
  readonly thresholdMemberEligible: boolean;
}

export interface DecodedRecoveryStatus {
  readonly pending: boolean;
  readonly initiatedAt: string;
  readonly matureAt: string;
  readonly authorityEpochAtInit: string;
  readonly newCustody: string;
}

export declare function decodeAccountDescriptorStack(
  item: unknown,
): DecodedAccountDescriptor | null;
export declare function decodeModuleDescriptorStack(
  item: unknown,
): DecodedModuleDescriptor | null;
export declare function decodeRecoveryStatusStack(
  item: unknown,
): DecodedRecoveryStatus | null;

// ---------------------------------------------------------------------------
// The custom kernel
// ---------------------------------------------------------------------------

export interface CustomClientOptions {
  rpcUrl?: string;
  rpcClient?: { send(method: string, params: unknown[]): Promise<any> };
  networkMagic: VMInteger;
  contractHash: string;
  retry?: RetryOptions | false;
}

export interface CreateAccountsInput {
  custodyAddress: string;
  salts: readonly string[];
  recoveryTimelockMs?: VMInteger;
}

export interface LegacyRegistrationInput {
  verifier: string;
  verifierParams: string;
  hookId: string;
  backupOwner: string;
  escapeTimelock?: VMInteger;
}

export interface CustomActionInput {
  method: string;
  accountId: string;
  args?: VMValue[];
}

/** The custody-authorised custom actions this client will build a plan for. */
export type CustodyAction = "setMetadataUri";

export interface MarketEscrowState {
  readonly marketContract: string;
  readonly listingId: string;
  readonly active: boolean;
}

export interface MigrationState {
  readonly status: string;
  readonly manifestDigest: string;
  readonly classification: string;
  readonly legacyModuleCount: string;
  readonly legacyScopeInvalidated: boolean;
  readonly importedAt: string;
}

export interface PlatformAccountInput {
  appBinding: string;
  backupOwner: string;
  escapeTimelock?: VMInteger;
}

export interface StablePlatformAccountInput {
  appBinding: string;
  escapeTimelock?: VMInteger;
}

export interface SponsoredExecutionInput {
  accountId: string;
  operations: UserOperation | readonly UserOperation[];
  paymaster: string;
  sponsor: string;
  reimbursementAmount: VMInteger;
}

export interface SponsoredExecutionPlan extends ExecutionPlan {
  readonly method: "executeSponsoredUserOp" | "executeSponsoredUserOps";
  readonly operations: readonly UserOperation[];
  readonly paymaster: string;
  readonly sponsor: string;
  readonly reimbursementAmount: string;
}

/**
 * Drives one deployed custom kernel. Everything protocol-shaped is inherited
 * from the shared kernel client; this class adds registration, custody actions,
 * market/registrar/migration reads and sponsored execution.
 */
export declare class SmartAccountClient implements SmartAccountKernel {
  constructor(options: CustomClientOptions);
  readonly networkMagic: number;
  readonly contractHash: string;
  readonly callFlags: number;
  profile: NativeProfile | null;
  proxyAddress(accountId: string): string;
  invokeScript(
    script: string,
    signers?: readonly SignerDescriptor[],
  ): Promise<InvocationResult>;
  discover(): Promise<NativeProfile & { kernel: "custom" }>;
  deriveIdentity(input: { custodyAddress: string; salt: string }): {
    readonly accountId: string;
    readonly verificationScript: string;
    readonly accountAddress: string;
  };
  // Reads shared with the native kernel (see ./native for descriptor shapes).
  getAccount(accountId: string): Promise<import("./native").AccountDescriptor | null>;
  getProtocolInfo(): Promise<import("./native").ProtocolInfo>;
  getModules(
    accountId: string,
    moduleType: string,
    options?: { cursor?: VMInteger; limit?: number },
  ): Promise<import("./native").ModulePage>;
  getModule(
    accountId: string,
    moduleId: VMInteger,
  ): Promise<import("./native").ModuleBinding | null>;
  isModuleInstalled(
    accountId: string,
    moduleType: string,
    moduleHash: string,
    additionalContext?: string,
  ): Promise<boolean>;
  getHookOrder(accountId: string): Promise<import("./native").HookOrder>;
  deriveNonceRouting(
    accountId: string,
    routing: import("./native").NonceRouting,
  ): string;
  getNonce(
    accountId: string,
    routing: import("./native").NonceRouting,
  ): Promise<import("./native").NonceState>;
  getNonceSequence(accountId: string, channel: VMInteger): Promise<string>;
  getOperationDigest(accountId: string, operation: UserOperation): Promise<string>;
  validateUserOp(
    accountId: string,
    operation: UserOperation,
  ): Promise<import("./native").OperationValidation>;
  isValidSignature(
    accountId: string,
    hash: string,
    envelope: VMValue[],
  ): Promise<import("./native").SignatureCheck>;
  getRecoveryStatus(
    accountId: string,
  ): Promise<import("./native").RecoveryStatus | null>;
  getPendingConfiguration(
    accountId: string,
    intentId: VMInteger,
  ): Promise<import("./native").PendingConfiguration | null>;
  getPendingConfigurationIntentIds(accountId: string): Promise<readonly string[]>;
  buildCreateAccountScript(input: {
    custodyAddress: string;
    salt: string;
    recoveryTimelockMs?: VMInteger;
    actions?: VMValue[];
  }): RegistrationPlan;
  buildExecutionScript(input: ExecutionInput): ExecutionPlan;
  buildConfigurationScript(input: ConfigurationInput): ConfigurationPlan;
  buildAccountActionScript(input: AccountActionInput): AccountActionPlan;
  simulate(plan: NativePlan, signers?: readonly SignerDescriptor[]): Promise<SimulationResult>;
  execute(plan: NativePlan, signers?: readonly SignerDescriptor[]): Promise<InvocationResult>;
  prepare<T extends NativePlan>(plan: T): T;
  revalidatePlan(plan: NativePlan): Promise<true>;
  // Registration (§10)
  buildCreateAccountsScript(
    input: CreateAccountsInput,
  ): import("./native").BatchRegistrationPlan;
  /** Legacy identity of a v3 registration (migration evidence, read-only). */
  getRegistrationAccountId(input: LegacyRegistrationInput): Promise<string>;
  // Custody-authorised account actions
  freezeAccount(accountId: string): AccountActionPlan;
  unfreezeAccount(accountId: string): AccountActionPlan;
  beginRecovery(accountId: string, newCustody: string): AccountActionPlan;
  cancelRecovery(accountId: string): AccountActionPlan;
  executeRecovery(accountId: string): AccountActionPlan;
  revokeCredentials(accountId: string, moduleId: VMInteger): AccountActionPlan;
  buildCustomActionScript(input: CustomActionInput): AccountActionPlan;
  setMetadataUri(accountId: string, metadataUri: string): AccountActionPlan;
  // Market escrow state (writes belong to the market contract)
  getMarketEscrow(accountId: string): Promise<MarketEscrowState>;
  isMarketService(marketContract: string): Promise<boolean>;
  // Platform registrar (registrar-sourced; ids stay v3-stable)
  computePlatformAccountId(input: PlatformAccountInput): Promise<string>;
  computeStablePlatformAccountId(input: StablePlatformAccountInput): Promise<string>;
  getPlatformAccountBinding(accountId: string): Promise<string | null>;
  getAccountIdByProxy(proxy: string): Promise<string>;
  getProxyScriptHash(accountId: string): Promise<string>;
  getPlatformRegistrar(): Promise<string>;
  getPendingPlatformRegistrar(): Promise<string>;
  getPlatformRegistrarAvailableAt(): Promise<string>;
  // Metadata, migration and sponsored execution
  getMetadataUri(accountId: string): Promise<string>;
  isMigrationRequired(accountId: string): Promise<boolean>;
  getMigrationState(accountId: string): Promise<MigrationState>;
  buildSponsoredExecutionScript(
    input: SponsoredExecutionInput,
  ): SponsoredExecutionPlan;
  // Transaction lifecycle
  prepareTransaction(
    plan: NativePlan,
    options: TransactionOptions,
  ): Promise<NativePreparedTransaction>;
  signTransaction(prepared: NativePreparedTransaction): Promise<NativeSignedTransaction>;
  exportSignedTransaction(
    signed: NativeSignedTransaction,
  ): NativeSignedTransactionArtifact;
  preflightTransaction(
    signed: NativeSignedTransaction,
  ): Promise<NativeTransactionPreflight>;
  broadcastTransaction(signed: NativeSignedTransaction): Promise<BroadcastResult>;
  getTransactionReceipt(
    signed: NativeSignedTransaction,
  ): Promise<NativeTransactionReceipt>;
}

export declare function createSmartAccountClient(
  options: CustomClientOptions,
): SmartAccountClient;

/** The single protocol codec every entry point shares. */
export declare const codec: ProtocolCodec;

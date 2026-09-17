/**
 * Type definitions for the Neo N3 Abstract Account SDK.
 *
 * These declarations describe the public surface exported from
 * `src/index.js` (the package `main`). All Hash160 values are hex strings
 * (40 hex chars / 20 bytes), with or without a `0x` prefix unless a
 * comment states otherwise; args hashes are 32 bytes (64 hex chars).
 * Deadlines are expressed in Neo `Runtime.Time` milliseconds, not seconds.
 */

// ===========================================================================
// Shared primitives
// ===========================================================================

/**
 * A Hash160 value: 40 hex characters (20 bytes), optionally `0x`-prefixed.
 * Kept as a plain string alias for documentation; no branding is enforced.
 */
export type Hash160 = string;

/**
 * A Neo N3 address (Base58, `N`-prefixed, 34 characters).
 */
export type NeoAddress = string;

/**
 * A 32-byte hash as 64 hex characters, optionally `0x`-prefixed.
 */
export type Bytes32Hex = string;

/**
 * Integer-like value accepted by encoders. Strings are used to carry
 * BigInteger values that exceed the safe-integer range.
 */
export type IntegerLike = string | number | bigint;

/**
 * A Neo contract parameter as understood by the RPC layer. Arguments passed
 * to UserOperations and payloads use this loose shape (e.g.
 * `{ type: 'Hash160', value: '...' }`). The runtime does not constrain the
 * value, so it is typed as `unknown`.
 */
export interface ContractParameter {
  type: string;
  value?: unknown;
}

// ===========================================================================
// Errors
// ===========================================================================

/**
 * A single error-code specification: a stable machine code plus a default
 * human-readable message.
 */
export interface ErrorCodeSpec {
  code: string;
  message: string;
  /** Present on RPC-mapped contract errors; carries the raw RPC detail. */
  rpcDetail?: string;
}

/**
 * The registry of error-code specifications used across the SDK. Each entry
 * is an {@link ErrorCodeSpec}; the key set is stable but treated as a record
 * for forward compatibility.
 */
export type ErrorCodes = Record<string, ErrorCodeSpec>;

/**
 * Error registry. Every SDK error carries one of these `code` values on the
 * thrown `Error` instance (see {@link createError}).
 */
export declare const EC: ErrorCodes;

/**
 * An `Error` augmented with a stable SDK error code and structured details.
 */
export interface SdkError extends Error {
  code: string;
  details: Record<string, unknown>;
}

/**
 * Creates a structured {@link SdkError} from an error-code specification.
 *
 * @param errorCode - An entry from {@link EC}.
 * @param details - Additional context attached to `error.details`.
 */
export declare function createError(
  errorCode: ErrorCodeSpec,
  details?: Record<string, unknown>,
): SdkError;

/**
 * Maps an RPC error (string or object with a `message`) onto an SDK
 * error-code specification, or `null` when no mapping applies.
 */
export declare function mapRpcError(
  error: string | { message?: string } | null | undefined,
): ErrorCodeSpec | null;

/**
 * Formats an error for display, combining its code, message, and details.
 */
export declare function formatError(error: SdkError | Error | string): string;

// ===========================================================================
// EIP-712 typed data
// ===========================================================================

/** A single EIP-712 type field descriptor. */
export interface Eip712Field {
  name: string;
  type: string;
}

/** The EIP-712 domain shared by the legacy and V3 layouts. */
export interface Eip712Domain {
  name: string;
  version: string;
  chainId: IntegerLike;
  /** Verifying contract as a `0x`-prefixed 40-hex string. */
  verifyingContract: string;
}

/**
 * Legacy MetaTransaction EIP-712 typed data. The legacy flow verifies against
 * the master contract (not the account's verifier plugin).
 */
export interface MetaTransactionTypedData {
  domain: Eip712Domain;
  types: {
    MetaTransaction: Eip712Field[];
  };
  message: {
    /** `0x`-prefixed account script hash (20 bytes). */
    accountAddress: string;
    /** `0x`-prefixed target contract hash (20 bytes). */
    targetContract: string;
    /** `0x`-prefixed keccak256 of the method name (32 bytes). */
    methodHash: string;
    /** `0x`-prefixed args hash (32 bytes). */
    argsHash: string;
    /** Decimal string. */
    nonce: string;
    /** Decimal string (Neo Runtime.Time milliseconds). */
    deadline: string;
  };
}

/**
 * V3 UserOperation EIP-712 typed data. Verified against the account's verifier
 * plugin using an account-id binding.
 */
export interface UserOperationTypedData {
  domain: Eip712Domain;
  types: {
    UserOperation: Eip712Field[];
  };
  message: {
    /** `0x`-prefixed account id (20 bytes, `bytes20`). */
    accountId: string;
    /** `0x`-prefixed authorized AA core hash (20 bytes, `bytes20`). */
    coreContract: string;
    /** `0x`-prefixed target contract hash (20 bytes). */
    targetContract: string;
    /** Raw method name (the V3 layout signs the string, not its hash). */
    method: string;
    /** `0x`-prefixed args hash (32 bytes). */
    argsHash: string;
    /** Decimal string. */
    nonce: string;
    /** Decimal string (Neo Runtime.Time milliseconds). */
    deadline: string;
  };
}

/** Options for {@link buildMetaTransactionTypedData}. */
export interface BuildMetaTransactionTypedDataOptions {
  chainId: IntegerLike;
  /** Master contract hash the legacy flow verifies against. */
  verifyingContract: Hash160;
  accountAddressScriptHash?: Hash160;
  accountAddressHash?: Hash160;
  targetContract: Hash160;
  method: string;
  /** Args hash (32 bytes / 64 hex chars). */
  argsHashHex: Bytes32Hex;
  nonce: IntegerLike;
  /** Deadline in Neo Runtime.Time milliseconds. */
  deadline: IntegerLike;
}

/** Options for {@link buildV3UserOperationTypedData}. */
export interface BuildV3UserOperationTypedDataOptions {
  chainId: IntegerLike;
  /** Verifier contract hash. */
  verifyingContract: Hash160;
  accountIdHash: Hash160;
  /** Authorized AA core hash; signatures are invalid on another core. */
  coreContractHash: Hash160;
  targetContract: Hash160;
  method: string;
  /** Args hash (32 bytes / 64 hex chars). */
  argsHashHex: Bytes32Hex;
  nonce: IntegerLike;
  /** Deadline in Neo Runtime.Time milliseconds. */
  deadline: IntegerLike;
}

/** Builds the legacy MetaTransaction EIP-712 typed data. */
export declare function buildMetaTransactionTypedData(
  options: BuildMetaTransactionTypedDataOptions,
): MetaTransactionTypedData;

/** Builds the V3 UserOperation EIP-712 typed data. */
export declare function buildV3UserOperationTypedData(
  options: BuildV3UserOperationTypedDataOptions,
): UserOperationTypedData;

// ===========================================================================
// Web3Auth contract-compatible signing helpers
// ===========================================================================

/** Options for {@link buildContractCompatibleStructHash}. */
export interface BuildContractCompatibleStructHashOptions {
  accountIdHash: Hash160;
  /** Authorized AA core hash; signatures are invalid on another core. */
  coreContractHash: Hash160;
  targetContract: Hash160;
  method: string;
  /** Args hash (32 bytes / 64 hex chars). */
  argsHash: Bytes32Hex;
  nonce: IntegerLike;
  /** Deadline in Neo Runtime.Time milliseconds. */
  deadline: IntegerLike;
}

/** Options for {@link buildWeb3AuthSigningPayload}. */
export interface BuildWeb3AuthSigningPayloadOptions {
  chainId: IntegerLike;
  verifierHash: Hash160;
  accountIdHash: Hash160;
  /** Authorized AA core hash; signatures are invalid on another core. */
  coreContractHash: Hash160;
  targetContract: Hash160;
  method: string;
  /** Args hash (32 bytes / 64 hex chars). */
  argsHash: Bytes32Hex;
  nonce: IntegerLike;
  /** Deadline in Neo Runtime.Time milliseconds. */
  deadline: IntegerLike;
}

/**
 * Builds the contract-compatible UserOperation struct hash.
 * @returns 32-byte struct hash as a `0x`-prefixed hex string.
 */
export declare function buildContractCompatibleStructHash(
  options: BuildContractCompatibleStructHashOptions,
): string;

/**
 * Builds the contract-compatible EIP-712 domain separator.
 * @returns 32-byte domain separator as a `0x`-prefixed hex string.
 */
export declare function buildContractCompatibleDomainSeparator(
  network: IntegerLike,
  verifyingContract: Hash160,
): string;

/**
 * Builds the complete 66-byte Web3Auth signing payload
 * (`0x1901 || domainSeparator(32) || structHash(32)`).
 */
export declare function buildWeb3AuthSigningPayload(
  options: BuildWeb3AuthSigningPayloadOptions,
): Uint8Array;

/**
 * Converts a Hash160 (big-endian display hex) to a 32-byte `bytes20` word
 * (20 bytes, right-padded with zeros).
 */
export declare function toBytes20Word(hash160: Hash160): Uint8Array;

/**
 * Converts a Hash160 (big-endian display hex) to a 32-byte EVM `address` word
 * (left-padded with zeros).
 */
export declare function toAddressWord(hash160: Hash160): Uint8Array;

/** Converts a non-negative integer to a 32-byte big-endian uint256 word. */
export declare function toUint256Word(value: IntegerLike): Uint8Array;

// ===========================================================================
// Stack decoding
// ===========================================================================

/**
 * A Neo RPC stack item (`{ type, value }`). Decode helpers accept these and
 * tolerate `null`/`undefined`.
 */
export interface StackItem {
  type?: string;
  value?: unknown;
}

/**
 * Decodes a ByteString/Buffer stack item to a hex string (no `0x` prefix).
 */
export declare function decodeByteStringStackHex(
  item: StackItem | null | undefined,
): string;

/** Sanitizes a hex string: strips a leading `0x` and lower-cases it. */
export declare function sanitizeHex(hex: unknown): string;

// ===========================================================================
// UserOperation
// ===========================================================================

/**
 * The built UserOperation object. Field names are PascalCase to match the
 * on-chain struct fields consumed by the master/verifier contracts.
 */
export interface UserOperation {
  /** Target contract hash (40 hex chars). */
  TargetContract: Hash160;
  /** Method name to invoke. */
  Method: string;
  /** Method arguments in Neo contract-parameter form. */
  Args: ContractParameter[];
  /** Nonce value. */
  Nonce: IntegerLike;
  /** Deadline in Neo Runtime.Time milliseconds. */
  Deadline: IntegerLike;
  /** Signature hex (empty until signed). */
  Signature: string;
}

/** Plain-object representation produced by {@link UserOperationBuilder.toJSON}. */
export interface UserOperationBuilderState {
  accountIdHash: string;
  targetContract: string;
  method: string;
  args: ContractParameter[];
  nonce: IntegerLike;
  deadline: IntegerLike | string;
  verifierHash: string;
  coreContractHash: string;
  chainId: string;
  accountAddressScriptHash: string;
  accountAddressHash: string;
  signature: string;
  /** Cached args hash, or `null` when not yet computed/set. */
  argsHash: string | null;
}

/** Constructor options for {@link UserOperationBuilder}. */
export interface UserOperationBuilderOptions {
  accountIdHash?: string;
  targetContract?: string;
  method?: string;
  args?: ContractParameter[];
  nonce?: IntegerLike;
  deadline?: IntegerLike | string;
  verifierHash?: string;
  coreContractHash?: string;
  chainId?: IntegerLike;
  accountAddressScriptHash?: string;
  accountAddressHash?: string;
  signature?: string;
}

/** Default deadline buffer (seconds) applied by {@link UserOperationBuilder.autoDeadline}. */
export declare const DEFAULT_DEADLINE_BUFFER: number;

/** Default nonce value. */
export declare const DEFAULT_NONCE: number;

/**
 * Fluent builder for constructing UserOperations and their EIP-712 typed data.
 *
 * Setters return `this` for chaining; {@link UserOperationBuilder.autoNonce}
 * returns a `Promise<UserOperationBuilder>` when given an async fetcher.
 */
export declare class UserOperationBuilder {
  accountIdHash: string;
  targetContract: string;
  method: string;
  args: ContractParameter[];
  nonce: IntegerLike;
  deadline: IntegerLike | string;
  verifierHash: string;
  coreContractHash: string;
  chainId: string;
  accountAddressScriptHash: string;
  accountAddressHash: string;
  signature: string;

  constructor(options?: UserOperationBuilderOptions);

  /** Sets the account id hash (20 bytes). */
  setAccountId(accountIdHash: string): this;
  /** Sets the target contract hash (20 bytes). */
  setTarget(contractHash: string): this;
  /** Sets the method name. */
  setMethod(method: string): this;
  /** Replaces the argument array. */
  setArgs(args: ContractParameter[]): this;
  /** Appends a single argument. */
  addArg(arg: ContractParameter): this;
  /** Sets the nonce. */
  setNonce(nonce: IntegerLike): this;
  /**
   * Auto-generates the nonce. With a synchronous fetcher (or none) returns
   * `this`; with an async fetcher returns a promise resolving to `this` so the
   * awaited nonce (never the promise) is stored.
   */
  autoNonce(): this;
  autoNonce(fetchNonceFn: () => IntegerLike): this;
  autoNonce(fetchNonceFn: () => Promise<IntegerLike>): Promise<this>;
  /** Sets the deadline (Neo Runtime.Time milliseconds). */
  setDeadline(deadline: IntegerLike): this;
  /** Auto-generates a deadline `bufferSeconds` in the future. */
  autoDeadline(bufferSeconds?: number): this;
  /** Sets the verifier contract hash for V3 EIP-712 signing. */
  setVerifier(verifierHash: string): this;
  /** Sets the authorized AA core hash for V3 EIP-712 signing. */
  setCoreContract(coreContractHash: string): this;
  /** Sets the chain id for EIP-712 signing. */
  setChainId(chainId: IntegerLike): this;
  /** Sets the legacy account address script hash. */
  setAccountAddressScriptHash(scriptHash: string): this;
  /** Sets the signature hex. */
  setSignature(signature: string): this;
  /** Sets the args hash directly (32 bytes / 64 hex chars). */
  setArgsHash(argsHash: Bytes32Hex): this;
  /** Alias for {@link setArgsHash}; takes a pre-computed args hash. */
  computeArgsHash(argsHash: Bytes32Hex): this;

  /** Builds the {@link UserOperation} object. */
  build(): UserOperation;
  /** Builds the V3 UserOperation EIP-712 typed data. */
  buildEIP712(argsHash?: Bytes32Hex): UserOperationTypedData;
  /** Builds the legacy MetaTransaction EIP-712 typed data. */
  buildLegacyEIP712(
    argsHash: Bytes32Hex | undefined,
    verifyingContract: Hash160,
  ): MetaTransactionTypedData;

  /** Returns a deep-enough clone, preserving the cached args hash. */
  clone(): UserOperationBuilder;
  /** Resets all fields to their defaults. */
  reset(): this;
  /** Returns a plain-object snapshot of the builder state. */
  toJSON(): UserOperationBuilderState;
}

/** Creates a new {@link UserOperationBuilder}. */
export declare function createUserOpBuilder(
  options?: UserOperationBuilderOptions,
): UserOperationBuilder;

// ===========================================================================
// Simulation / pre-flight
// ===========================================================================

/** Individual preview checks returned by a simulation. */
export interface SimulationChecks {
  /** Deadline is in the future and accepted by the contract preview. */
  deadlineValid: boolean;
  /** Nonce is valid and unused. */
  nonceAcceptable: boolean;
  /** A verifier is configured. */
  hasVerifier: boolean;
  /** Verifier hash (big-endian display hex), or empty. */
  verifier: string;
  /** Hook hash (big-endian display hex), or empty. */
  hook: string;
}

/**
 * Result of {@link simulateUserOperation}.
 *
 * `passed` reflects the preview checks only and never implies signature
 * validity. `signatureVerified` is always `false`: the signature is validated
 * only on-chain by `executeUserOp` (or by the relay's full simulation).
 */
export interface SimulationResult {
  passed: boolean;
  /** Always `false`; the simulation never verifies the signature. */
  signatureVerified: false;
  /** Empty when an early validation error short-circuits the preview. */
  checks: SimulationChecks | Record<string, never>;
  errors: string[];
  warnings: string[];
}

/** Options for {@link simulateUserOperation}. */
export interface SimulateUserOperationOptions {
  accountIdHash?: Hash160;
  /** Legacy account address or hash (alternative to `accountIdHash`). */
  accountAddress?: Hash160 | NeoAddress;
  targetContract: Hash160;
  method: string;
  args?: ContractParameter[];
  nonce?: IntegerLike;
  /** Deadline in Neo Runtime.Time milliseconds. */
  deadline?: IntegerLike;
}

/**
 * Simulates a UserOperation against the contract preview. Pre-flight only:
 * it never verifies the signature (see {@link SimulationResult}).
 */
export declare function simulateUserOperation(
  client: AbstractAccountClient,
  options: SimulateUserOperationOptions,
): Promise<SimulationResult>;

/** Options for {@link preFlightCheck}. */
export interface PreFlightCheckOptions {
  accountHashOrAddress: Hash160 | NeoAddress;
  /** Expected verifier hash (big-endian display hex). */
  verifierHash?: Hash160;
  /** Expected hook hash (big-endian display hex). */
  hookHash?: Hash160;
  /** Optional simulation options run as part of the suite. */
  userOp?: SimulateUserOperationOptions;
}

/** Aggregate result of {@link preFlightCheck}. */
export interface PreFlightCheckResult {
  passed: boolean;
  checks: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}

/** Runs a comprehensive pre-flight check suite for an account/operation. */
export declare function preFlightCheck(
  client: AbstractAccountClient,
  options: PreFlightCheckOptions,
): Promise<PreFlightCheckResult>;

// ===========================================================================
// Retry utility
// ===========================================================================

/** Configuration for {@link withRetry}. */
export interface RetryConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  /** Invoked before each retry sleep. */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

/** Retries `fn` with exponential backoff while the error is retryable. */
export declare function withRetry<T>(
  label: string,
  fn: (attempt: number) => Promise<T> | T,
  config?: RetryConfig,
): Promise<T>;

/** Returns whether an error looks transient/retryable. */
export declare function isRetryableError(error: unknown): boolean;

// ===========================================================================
// Client
// ===========================================================================

/** A virtual account derived from a seed. */
export interface VirtualAccount {
  /** Account id hash (40 hex chars). */
  accountIdHash: Hash160;
  /** Verification script hex. */
  verifyScript: string;
  /** Script hash (40 hex chars). */
  scriptHash: Hash160;
  /** Neo address. */
  address: NeoAddress;
}

/** Options for {@link AbstractAccountClient.deriveRegistrationAccountIdHash}. */
export interface RegistrationAccountIdOptions {
  verifierContractHash?: Hash160;
  verifierParamsHex?: string;
  hookContractHash?: Hash160;
  backupOwnerAddress: Hash160 | NeoAddress;
  /** Escape-hatch timelock in seconds (default: 30 days). */
  escapeTimelock?: number;
}

/** Options for {@link AbstractAccountClient.createAccountPayload}. */
export interface CreateAccountPayloadOptions {
  verifierContractHash?: Hash160;
  verifierParamsHex?: string;
  hookContractHash?: Hash160;
  backupOwnerAddress: Hash160 | NeoAddress;
  /** Escape-hatch timelock in seconds (default: 30 days). */
  escapeTimelock?: number;
}

/** A contract invocation payload returned by the `create*Payload` methods. */
export interface ContractInvocationPayload {
  scriptHash: Hash160;
  operation: string;
  args: unknown[];
}

/**
 * Account-scoped options. Exactly one of `accountScriptHash` or
 * `accountAddress` must be supplied.
 */
export interface AccountScopedOptions {
  accountScriptHash?: Hash160;
  accountAddress?: Hash160 | NeoAddress;
}

/** Options for {@link AbstractAccountClient.createUpdateVerifierPayload}. */
export interface UpdateVerifierPayloadOptions extends AccountScopedOptions {
  verifierContractHash: Hash160;
  verifierParamsHex?: string;
}

/** Options for {@link AbstractAccountClient.createUpdateHookPayload}. */
export interface UpdateHookPayloadOptions extends AccountScopedOptions {
  /** New hook contract hash; empty removes the hook. */
  hookContractHash?: Hash160;
}

/** Options for {@link AbstractAccountClient.createSetMetadataUriPayload}. */
export interface SetMetadataUriPayloadOptions extends AccountScopedOptions {
  metadataUri?: string;
}

/** Options for {@link AbstractAccountClient.createEIP712Payload}. */
export interface CreateEIP712PayloadOptions {
  chainId: IntegerLike;
  /** V3 account id hash (40 hex chars). */
  accountIdHash?: Hash160;
  /** Account id seed/hex; derives `accountIdHash` when provided. */
  accountIdHex?: string;
  /** Verifier hash (V3); auto-resolved from the contract when omitted. */
  verifierHash?: Hash160;
  /** Legacy account script hash. */
  accountAddressScriptHash?: Hash160;
  /** Legacy account address hash. */
  accountAddressHash?: Hash160;
  targetContract: Hash160;
  method: string;
  args?: ContractParameter[];
  nonce: IntegerLike;
  /** Deadline in Neo Runtime.Time milliseconds. */
  deadline: IntegerLike;
}

/** Options for {@link AbstractAccountClient.getUserOpValidationPreview}. */
export interface UserOpValidationPreviewOptions {
  accountIdHash?: Hash160;
  accountAddress?: Hash160 | NeoAddress;
  targetContract: Hash160;
  method: string;
  args?: ContractParameter[];
  nonce?: IntegerLike;
  /** Deadline in Neo Runtime.Time milliseconds. */
  deadline?: IntegerLike;
}

/** Decoded validation preview returned by the contract. */
export interface UserOpValidationPreview {
  deadlineValid: boolean;
  nonceAcceptable: boolean;
  hasVerifier: boolean;
  /** Verifier hash (big-endian display hex). */
  verifier: string;
  /** Hook hash (big-endian display hex). */
  hook: string;
}

/**
 * Full account state. All Hash160 fields are big-endian display hex; timelock
 * and timestamp fields are decimal strings.
 */
export interface AccountState {
  accountId: Hash160;
  verifier: Hash160;
  hook: Hash160;
  backupOwner: Hash160;
  /** Escape-hatch timelock in seconds (decimal string). */
  escapeTimelock: string;
  /** Timestamp the escape was triggered (decimal string, ms). */
  escapeTriggeredAt: string;
  escapeActive: boolean;
  metadataUri: string;
}

/** A pending module call (verifier or hook) on an account. */
export interface PendingModuleCall {
  hasPending: boolean;
  /** Earliest execution time (decimal string, Neo Runtime.Time ms). */
  executeAfter: string;
  /** Module hash (big-endian display hex). */
  moduleHash: Hash160;
  /** Call hash hex. */
  callHash: string;
}

/** Options for {@link AbstractAccountClient.createSponsoredUserOpPayload}. */
export interface SponsoredUserOpPayloadOptions extends AccountScopedOptions {
  userOp: UserOperation;
  paymasterHash: Hash160;
  sponsorAddress: Hash160 | NeoAddress;
  /** GAS reimbursement in fractions (10^8 = 1 GAS). */
  reimbursementAmount: IntegerLike;
}

/** Options for {@link AbstractAccountClient.createSponsoredBatchPayload}. */
export interface SponsoredBatchPayloadOptions extends AccountScopedOptions {
  userOps: UserOperation[];
  paymasterHash: Hash160;
  sponsorAddress: Hash160 | NeoAddress;
  /** Total GAS reimbursement for the batch (fractions). */
  reimbursementAmount: IntegerLike;
}

/** Options for {@link AbstractAccountClient.validatePaymasterOp}. */
export interface ValidatePaymasterOpOptions {
  paymasterHash: Hash160;
  sponsorAddress: Hash160 | NeoAddress;
  accountAddress: Hash160 | NeoAddress;
  targetContract: Hash160;
  method: string;
  reimbursementAmount: IntegerLike;
}

/**
 * The Neo N3 Abstract Account SDK client.
 *
 * Provides account derivation, payload construction, EIP-712 signing-data
 * generation, read-only contract queries, and paymaster/sponsored-operation
 * helpers.
 */
export declare class AbstractAccountClient {
  /** The configured master contract hash (40 hex chars). */
  masterContractHash: Hash160;
  /** The underlying neon-js RPC client. */
  rpcClient: unknown;

  /**
   * @param rpcUrl - RPC endpoint URL (`http://` or `https://`).
   * @param masterContractHash - Master contract hash (40 hex chars).
   */
  constructor(rpcUrl: string, masterContractHash: Hash160);

  /** Invokes a script with transient-failure retry. */
  invokeScriptWithRetry(script: unknown, signers?: unknown[]): Promise<any>;
  /** Invokes a contract function with transient-failure retry. */
  invokeFunctionWithRetry(
    scriptHash: Hash160,
    operation: string,
    params?: unknown[],
    signers?: unknown[],
  ): Promise<any>;

  /** Builds the verification script from a display-order account id. */
  buildVerifyScript(accountIdHex: string): string;
  /** Derives the account id hash from a seed or existing hash. */
  deriveAccountIdHash(accountIdHexOrSeed: string): Hash160;
  /** Derives the registration-bound account id hash used by V3 creation (big-endian display form, matching the on-chain ComputeRegistrationAccountId display string). */
  deriveRegistrationAccountIdHash(
    options?: RegistrationAccountIdOptions,
  ): Hash160;
  /** Derives a virtual account from a seed. */
  deriveVirtualAccount(accountIdSeedHex: string): VirtualAccount;
  /** Derives a Neo address from an uncompressed EVM public key. */
  deriveAddressFromEVM(uncompressedPubKey: string): NeoAddress;

  /** Builds the payload to register a new V3 account. */
  createAccountPayload(
    options: CreateAccountPayloadOptions,
  ): ContractInvocationPayload;
  /** Builds the payload to update an account's verifier. */
  createUpdateVerifierPayload(
    options: UpdateVerifierPayloadOptions,
  ): ContractInvocationPayload;
  /** Builds the payload to update an account's hook. */
  createUpdateHookPayload(
    options: UpdateHookPayloadOptions,
  ): ContractInvocationPayload;
  /** Builds the payload to set an account's metadata URI. */
  createSetMetadataUriPayload(
    options: SetMetadataUriPayloadOptions,
  ): ContractInvocationPayload;
  /** Builds the payload to confirm a pending hook update. */
  createConfirmHookUpdatePayload(
    options: AccountScopedOptions,
  ): ContractInvocationPayload;
  /** Builds the payload to confirm a pending verifier update. */
  createConfirmVerifierUpdatePayload(
    options: AccountScopedOptions,
  ): ContractInvocationPayload;
  /** Builds the payload to cancel a pending hook update. */
  createCancelHookUpdatePayload(
    options: AccountScopedOptions,
  ): ContractInvocationPayload;
  /** Builds the payload to cancel a pending verifier update. */
  createCancelVerifierUpdatePayload(
    options: AccountScopedOptions,
  ): ContractInvocationPayload;

  /** Computes the on-chain args hash (keccak256 of serialized args). */
  computeArgsHash(args?: ContractParameter[]): Promise<Bytes32Hex>;

  /**
   * Generates the EIP-712 typed data for signing a UserOperation. Returns the
   * V3 layout when an account id is supplied, otherwise the legacy layout.
   */
  createEIP712Payload(
    options: CreateEIP712PayloadOptions,
  ): Promise<UserOperationTypedData | MetaTransactionTypedData>;

  /** Decodes a stack item into an array of Neo addresses. */
  decodeAddressArray(stackItem: StackItem | null | undefined): NeoAddress[];

  /** Reads the account implementation id string. */
  getAccountImplementationId(): Promise<string>;
  /** Checks whether an execution mode is supported. */
  supportsExecutionMode(mode: string): Promise<boolean>;
  /** Checks whether a module type is supported. */
  supportsModuleType(moduleType: string): Promise<boolean>;
  /** Checks whether a module is installed on an account. */
  isModuleInstalled(
    accountHashOrAddress: Hash160 | NeoAddress,
    moduleType: string,
    moduleHashOrAddress: Hash160 | NeoAddress,
  ): Promise<boolean>;
  /**
   * Checks a message signature through the ERC-1271-compatible Neo adapter.
   * Returns `0x1626ba7e` for valid or `0xffffffff` for invalid.
   */
  isValidSignature(
    accountHashOrAddress: Hash160 | NeoAddress,
    hash: Bytes32Hex,
    /** Compact r||s or recoverable r||s||v signature (64 or 65 bytes). */
    signature: string,
  ): Promise<string>;

  /** Returns a validation preview for a UserOperation before submission. */
  getUserOpValidationPreview(
    options: UserOpValidationPreviewOptions,
  ): Promise<UserOpValidationPreview>;

  /** Returns the full state of an abstract account. */
  getAccountState(
    accountHashOrAddress: Hash160 | NeoAddress,
  ): Promise<AccountState>;

  /** Whether a pending verifier update exists. */
  getHasPendingVerifierUpdate(
    accountHashOrAddress: Hash160 | NeoAddress,
  ): Promise<boolean>;
  /** Whether a pending hook update exists. */
  getHasPendingHookUpdate(
    accountHashOrAddress: Hash160 | NeoAddress,
  ): Promise<boolean>;
  /** Time (Neo Runtime.Time ms) a pending verifier update can be confirmed. */
  getPendingVerifierUpdateTime(
    accountHashOrAddress: Hash160 | NeoAddress,
  ): Promise<number>;
  /** Time (Neo Runtime.Time ms) a pending hook update can be confirmed. */
  getPendingHookUpdateTime(
    accountHashOrAddress: Hash160 | NeoAddress,
  ): Promise<number>;
  /** Returns the pending verifier module call, if any. */
  getPendingVerifierCall(
    accountHashOrAddress: Hash160 | NeoAddress,
  ): Promise<PendingModuleCall>;
  /** Returns the pending hook module call, if any. */
  getPendingHookCall(
    accountHashOrAddress: Hash160 | NeoAddress,
  ): Promise<PendingModuleCall>;
  /** Whether an execution is currently active for an account. */
  getIsExecutionActive(
    accountHashOrAddress: Hash160 | NeoAddress,
  ): Promise<boolean>;

  // --- Paymaster / sponsored transactions ---

  /** Builds the payload to execute a sponsored UserOperation via paymaster. */
  createSponsoredUserOpPayload(
    options: SponsoredUserOpPayloadOptions,
  ): ContractInvocationPayload;
  /** Builds the payload to execute a sponsored batch of UserOperations. */
  createSponsoredBatchPayload(
    options: SponsoredBatchPayloadOptions,
  ): ContractInvocationPayload;
  /** Queries a sponsor's GAS deposit balance (fractions, BigInteger string). */
  querySponsorBalance(
    paymasterHash: Hash160,
    sponsorAddress: Hash160 | NeoAddress,
  ): Promise<string>;
  /** Validates whether a sponsored operation would be accepted. */
  validatePaymasterOp(options: ValidatePaymasterOpOptions): Promise<boolean>;

  /** @deprecated Removed in V3; always throws. */
  getAccountsByAdmin(): Promise<never>;
  /** @deprecated Removed in V3; always throws. */
  getAccountsByManager(): Promise<never>;
  /** @deprecated Removed in V3; always throws. */
  getAccountAddressesByAdmin(): Promise<never>;
  /** @deprecated Removed in V3; always throws. */
  getAccountAddressesByManager(): Promise<never>;
}

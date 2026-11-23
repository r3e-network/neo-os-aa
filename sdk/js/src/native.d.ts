/**
 * Neo Smart Account v4 — native kernel surface and the protocol types both
 * kernels share.
 *
 * One protocol: a 13-field operation, a 191-bit channel nonce, the §4.3
 * operation digest, the §8 message digest, configuration intents and module
 * queries. The two kernels differ in exactly two constructor constants — which
 * script hash answers and which call flags the proxy verification script
 * pushes — so every type here is kernel-agnostic.
 *
 * Hashes are display-order hex (40 characters for Hash160). ByteString values
 * carried inside arguments are wire-order hex. Integer fields are decimal text
 * in every returned descriptor and `string | number | bigint` on input.
 */

export type VMInteger = string | number | bigint;

/** A canonical NeoVM value: `Struct` is rejected inside an operation (§4.1). */
export type VMValue =
  | { type: "Null"; value?: null }
  | { type: "Boolean"; value: boolean }
  | { type: "Integer"; value: VMInteger }
  | { type: "ByteString"; value: string }
  | { type: "Array"; value: VMValue[] };

/** One hook proof: instance id and its serialized proof bytes. */
export interface HookProofEntry {
  hookId: VMInteger;
  proof: string;
}

/**
 * The v4 13-field operation (§4): version, target, method, args, nonce,
 * nonceSubkey, deadline, validatorId, credentialGeneration, authorityEpoch,
 * configurationNonce, signature, hookProofs. Fields 0 and 12 are derived from
 * the protocol and never supplied.
 */
export interface UserOperation {
  targetContract: string;
  method: string;
  args: VMValue[];
  nonce: VMInteger;
  /** 32-byte nonce subkey; the channel is derived from it (§6). */
  nonceSubkey: string;
  deadline: VMInteger;
  validatorId?: VMInteger;
  /**
   * Required: the routing generation is part of the §4.3 domain. Built-in
   * validator → the account 0x57 SubjectRevision; installed validator or
   * active threshold policy → its CredentialGeneration. There is no default.
   */
  credentialGeneration: VMInteger;
  authorityEpoch: VMInteger;
  configurationNonce: VMInteger;
  signature?: string;
  hookProofs?: ReadonlyArray<HookProofEntry | readonly [VMInteger, string]>;
}

/** Network, core and account binding of every derivation. */
export interface ProtocolContext {
  networkMagic: VMInteger;
  coreContractHash?: string;
  accountId: string;
}

/** Nonce routing inputs; the authority epoch and generation are part of the namespace. */
export interface NonceRouting {
  authorityEpoch: VMInteger;
  validatorId?: VMInteger;
  /**
   * Required by every digest and channel derivation (§6). Built-in validator →
   * the account 0x57 SubjectRevision; installed validator or active threshold
   * policy → its CredentialGeneration. There is no protocol default.
   */
  credentialGeneration: VMInteger;
  nonceSubkey: string;
}

/**
 * `getNonce` routing. The kernel resolves the routing generation itself (§6), so
 * the namespace inputs are optional here. Supplying *both* the generation and
 * the authority epoch turns the read into a cross-check that refuses a stale
 * view; supplying neither trusts only the channel the contract returned.
 */
export type NonceLookup = { validatorId?: VMInteger; nonceSubkey: string } & (
  | { credentialGeneration?: undefined; authorityEpoch?: undefined }
  | { credentialGeneration: VMInteger; authorityEpoch: VMInteger }
);

/** §8 message envelope: the original sender, the 32-byte hash and the route. */
export interface MessageEnvelope {
  originalSender: string;
  hash: string;
  validatorId?: VMInteger;
  /** Required: §8 binds it to SubjectRevision or CredentialGeneration. */
  credentialGeneration: VMInteger;
}

export interface MessageContext extends ProtocolContext {
  authorityEpoch: VMInteger;
}

/** §16.1 identity: `Hash160(0xAA524704 ‖ custody ‖ salt)`. */
export interface NativeIdentity {
  readonly accountId: string;
  readonly verificationScript: string;
  readonly accountAddress: string;
}

export interface NonceSplit {
  channel: bigint;
  sequence: bigint;
}

export interface BuiltInSignatureInput {
  credentialGeneration: VMInteger;
  pairs: ReadonlyArray<{ script: string; signature: string }>;
}

export interface ThresholdSignatureInput {
  moduleId: VMInteger;
  signature: string;
}

/** The one protocol codec: every byte a signature covers comes from here. */
export interface ProtocolCodec {
  readonly protocolVersion: number;
  hex(value: string, bytes?: number): string;
  bytes(value: string): Uint8Array;
  bytesToHex(value: Uint8Array): string;
  integer(value: VMInteger): bigint;
  unsigned(value: VMInteger, bits: number, label: string): bigint;
  integerValue(value: VMInteger): VMValue;
  byteStringValue(value: string): VMValue;
  hashValue(displayHash: string): VMValue;
  stringValue(text: string): VMValue;
  canonicalValue(value: VMValue): VMValue;
  serializeValue(value: VMValue): string;
  encodeValue(value: VMValue): string;
  operationValue(operation: UserOperation, emptySignature?: boolean): VMValue;
  serializeOperation(operation: UserOperation, emptySignature?: boolean): string;
  dynamicCall(
    contract: string,
    method: string,
    args: VMValue[],
    flags?: number,
  ): string;
  composeNonce(channel: VMInteger, sequence: VMInteger): bigint;
  splitNonce(nonce: VMInteger): NonceSplit;
  verificationScript(
    accountId: string,
    options?: { coreContractHash?: string; callFlags?: number },
  ): string;
  accountAddress(
    accountId: string,
    options?: { coreContractHash?: string; callFlags?: number },
  ): string;
  deriveIdentity(input: {
    custodyAddress: string;
    salt: string;
    coreContractHash?: string;
    callFlags?: number;
  }): NativeIdentity;
  nonceNamespaceDigest(context: ProtocolContext, routing: NonceRouting): string;
  deriveNonceChannel(context: ProtocolContext, routing: NonceRouting): string;
  operationDomain(context: ProtocolContext, operation: UserOperation): string;
  operationPreimage(context: ProtocolContext, operation: UserOperation): string;
  operationDigest(context: ProtocolContext, operation: UserOperation): string;
  messageDigest(context: MessageContext, message: MessageEnvelope): string;
  builtInSignature(input: BuiltInSignatureInput): string;
  thresholdSignature(members: readonly ThresholdSignatureInput[]): string;
  thresholdMemberDigest(
    operationDigest: string,
    moduleId: VMInteger,
    credentialGeneration: VMInteger,
  ): string;
  buildExecutionScript(
    accountId: string,
    operations: readonly UserOperation[],
    context?: ProtocolContext,
  ): string;
}

/** §4.3 domain name, shared with the meta-transaction validators. */
export declare const USER_OPERATION_DOMAIN_NAME: "Neo Smart Account";
export declare const USER_OPERATION_DOMAIN_VERSION: "4";

export declare const nativeCodec: ProtocolCodec;
export declare const PROTOCOL_VERSION: 4;
export declare const NATIVE_ABI_VERSION: 4;
export declare const NATIVE_SMART_ACCOUNT_CONTRACT: string;
export declare const NATIVE_PROXY_CALL_FLAGS: 5;

/** `[parameters, returntype, safe, parameterNames]` per required method. */
export type RequiredAbiEntry = readonly [
  readonly string[],
  string,
  boolean,
  readonly string[],
];
export declare const NATIVE_REQUIRED_ABI: Readonly<
  Record<string, RequiredAbiEntry>
>;
/**
 * The account-address query of the native core (§9).
 */
export declare const NATIVE_ACCOUNT_ADDRESS_ABI: Readonly<
  Record<string, RequiredAbiEntry>
>;
export declare const NATIVE_REQUIRED_EVENTS: readonly string[];

export interface NativeProfile {
  readonly contract: string;
  readonly networkMagic: number;
  readonly protocolVersion: number;
  readonly implementationId: string;
}

export type SignerScope =
  | "None"
  | "CalledByEntry"
  | "CustomContracts"
  | "Global"
  | "WitnessRules";

export interface WitnessRule {
  readonly action: "Allow" | "Deny";
  readonly condition: { readonly type: string; readonly hash?: string };
}

export interface SignerDescriptor {
  readonly account: string;
  readonly scopes: SignerScope;
  readonly allowedContracts?: readonly string[];
  readonly rules?: readonly WitnessRule[];
}

export interface Witness {
  readonly invocation: string;
  readonly verification: string;
}

export interface InvocationResult {
  readonly state: string;
  readonly exception?: string | null;
  readonly stack: unknown[];
  readonly gasconsumed?: string;
  readonly [key: string]: unknown;
}

/** Account status: 0 Active, 1 Frozen, 2 MigrationRequired. */
export type AccountStatus = 0 | 1 | 2;

export interface AccountDescriptor {
  readonly accountId: string;
  readonly accountAddress: string;
  readonly exists: true;
  readonly status: AccountStatus;
  readonly statusName: "Active" | "Frozen" | "MigrationRequired";
  readonly custodyAddress: string;
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
  readonly legacyRow: unknown;
}

export interface ModuleBinding {
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

export interface ModulePage {
  readonly moduleIds: readonly string[];
  readonly nextCursor: string;
  readonly configurationNonce: string;
}

export interface ProtocolInfo {
  readonly protocolVersion: string;
  readonly migrationModeOpen: unknown;
}

export interface NonceState {
  readonly packed: string;
  readonly channel: string;
  readonly sequence: string;
}

export interface OperationValidation {
  readonly accepted: boolean;
  readonly operationDigest: string;
}

/** A failed simulation is reported, not thrown; the review shows it. */
export interface SimulationResult {
  readonly state: string | null;
  readonly exception: string | null;
  readonly stack: readonly unknown[];
  readonly incompleteTransfers: readonly number[];
  readonly gasConsumed: string | null;
  readonly minimumRequiredFee: string | null;
}

export interface PlanBase {
  readonly kind: "registration" | "execution" | "account" | "recovery";
  readonly method: string;
  readonly script: string;
  readonly signers: readonly string[];
  readonly accountId?: string;
  readonly accountAddress?: string;
}

export interface RegistrationPlan extends PlanBase {
  readonly kind: "registration";
  readonly method: "createAccount";
  readonly accountId: string;
  readonly accountAddress: string;
  readonly custodyAddress: string;
  readonly verificationScript: string;
}

/** Batch registration names its accounts as lists; no single id exists. */
export interface BatchRegistrationPlan extends PlanBase {
  readonly kind: "registration";
  readonly method: "createAccounts";
  readonly accountIds: readonly string[];
  readonly accountAddresses: readonly string[];
  readonly custodyAddress: string;
}

export interface ExecutionPlan extends PlanBase {
  readonly kind: "execution";
  readonly accountId: string;
  readonly accountAddress: string;
  readonly proxyCallFlags: number;
  readonly batch: boolean;
  readonly operations: readonly UserOperation[];
}

export interface AccountActionPlan extends PlanBase {
  readonly kind: "account";
  readonly accountId: string;
  readonly accountAddress: string;
}

export interface RecoveryModulePlan extends PlanBase {
  readonly kind: "recovery";
  readonly accountId: string;
  readonly targetContract: string;
  readonly moduleId: string;
  readonly configurationNonce: string;
  readonly nefSha256: string;
}

export type NativePlan =
  | RegistrationPlan
  | BatchRegistrationPlan
  | ExecutionPlan
  | AccountActionPlan
  | RecoveryModulePlan;

/** The method that built a reviewed plan, and the input that rebuilds it. */
export interface PlanRecipe {
  readonly method: string;
  readonly input: any;
}

export interface CreateAccountInput {
  custodyAddress: string;
  salt: string;
  recoveryTimelockMs?: VMInteger;
  actions?: VMValue[];
}

export interface ExecutionInput {
  accountId: string;
  operations: UserOperation[];
}

/**
 * An account-level call the core declares itself: `freezeAccount`,
 * `unfreezeAccount`, `installModule` or `removeModule`. Configuration intents,
 * recovery and credential revocation are user-space module concerns, so they
 * are not native account actions.
 */
export interface AccountActionInput {
  method: string;
  accountId: string;
  args?: VMValue[];
}

/** One member's IEEE P1363 r‖s signature and its compressed P-256 public key. */
export interface WalletMemberSignature {
  publicKey: string;
  signature: string;
}

/**
 * A wallet: its account, the standard verification script it owns and a signer
 * for the network-bound `signData`. CHECKSIG returns one signature string,
 * CHECKMULTISIG returns member entries; both are verified before use.
 */
export interface WalletSigner {
  account: string;
  verificationScript: string;
  sign(
    signDataHex: string,
  ):
    | string
    | readonly WalletMemberSignature[]
    | Promise<string | readonly WalletMemberSignature[]>;
}

/** A wallet bound into a prepared transaction. */
export interface BoundWallet {
  readonly account: string;
  readonly verification: string;
  readonly descriptor: SignerDescriptor;
  readonly role: string;
  sign(
    signDataHex: string,
  ):
    | string
    | readonly WalletMemberSignature[]
    | Promise<string | readonly WalletMemberSignature[]>;
}

export interface TransactionOptions {
  /** The fee payer; its witness is signer 0. */
  feePayer: WalletSigner;
  /** Extra authority wallets (custody, recovery, registration). */
  authorizers?: WalletSigner[];
  /** The plan-building call this review replays before every signature. */
  recipe: PlanRecipe;
  systemFee?: VMInteger;
  maxSystemFee: VMInteger;
  maxNetworkFee: VMInteger;
  maxTotalFee: VMInteger;
  validUntilBlock?: number;
  nonce?: number;
}

export interface ReviewedTransaction {
  readonly format: "neo-native-reviewed-request";
  readonly version: 1;
  readonly submission: "native-sdk";
  readonly profile: NativeProfile;
  readonly feePayer: string;
  readonly signers: readonly SignerDescriptor[];
  readonly plan: NativePlan;
  readonly recipe: PlanRecipe;
  readonly simulation: {
    readonly state: string | null;
    readonly gasConsumed: string | null;
    readonly minimumRequiredFee: string | null;
  };
}

export interface EncodedTransaction {
  readonly nonce: number;
  readonly systemFee: string;
  readonly networkFee: string;
  readonly validUntilBlock: number;
  readonly script: string;
  readonly signers: readonly SignerDescriptor[];
}

export interface NativePreparedTransaction {
  readonly kind: "native-transaction";
  readonly review: ReviewedTransaction;
  readonly reviewJson: string;
  readonly transaction: EncodedTransaction;
  readonly witnesses: readonly (Witness | { placeholder: true })[];
  readonly unsignedHex: string;
  readonly txid: string;
  readonly signData: string;
  readonly systemFee: string;
  readonly networkFee: string;
  readonly systemFeeSource: "explicit-budget" | "minimumrequiredfee";
  readonly simulation: SimulationResult;
  readonly wallets: readonly BoundWallet[];
  readonly proxy: { readonly signer: SignerDescriptor; readonly witness: Witness } | null;
  readonly placeholderWitnesses: readonly (Witness | { placeholder: true })[];
}

export interface NativeSignedTransaction {
  readonly kind: "signed-native-transaction";
  readonly prepared: NativePreparedTransaction;
  readonly txid: string;
  readonly rawTransaction: string;
  readonly witnesses: readonly Witness[];
}

/** Public exact-byte artifact: signatures and transaction data, no signers. */
export interface NativeSignedTransactionArtifact {
  readonly format: "neo-native-signed-transaction";
  readonly version: 1;
  readonly networkMagic: number;
  readonly profile: NativeProfile;
  readonly transaction: EncodedTransaction;
  readonly witnesses: readonly Witness[];
  readonly unsignedHex: string;
  readonly txid: string;
  readonly signData: string;
  readonly rawTransaction: string;
}

export interface NativeTransactionPreflight {
  readonly hash: string;
  readonly network: number;
  readonly snapshot: { readonly height: number; readonly hash: string };
  readonly simulation: {
    readonly mode: "single-transaction-next-block";
    readonly height: number;
    readonly timestamp: string;
    readonly primaryIndex: number;
    readonly view: 0;
    readonly transactionCount: 1;
    readonly onPersist: "HALT";
    readonly nextConsensus: string;
  };
  readonly verification: "Succeed";
  readonly relayed: false;
  readonly mempoolChecked: false;
  readonly state: "HALT";
  readonly gasconsumed: string;
  readonly minimumrequiredfee: string;
  readonly stack: unknown[];
  readonly exception?: string | null;
  readonly notifications: unknown[];
}

export type NativeTransactionReceipt =
  | { readonly txid: string; readonly confirmed: false }
  | {
      readonly txid: string;
      readonly confirmed: true;
      readonly succeeded: boolean;
      readonly failures: readonly number[];
      readonly blockHash: string;
      readonly vmState: string;
      readonly exception: string | null;
      readonly stack: readonly unknown[];
      readonly notifications: readonly unknown[];
      readonly gasConsumed: string;
      readonly systemFee: string;
      readonly networkFee: string;
    };

export interface BroadcastResult {
  readonly txid: string;
  readonly submitted: true;
  readonly confirmed: false;
}

/** The methods both kernels expose; the two clients extend this surface. */
export interface SmartAccountKernel {
  readonly networkMagic: number;
  readonly contractHash: string;
  readonly callFlags: number;
  readonly profile: NativeProfile | null;
  proxyAddress(accountId: string): string;
  invokeScript(
    script: string,
    signers?: readonly SignerDescriptor[],
  ): Promise<InvocationResult>;
  discover(): Promise<NativeProfile>;
  deriveIdentity(input: {
    custodyAddress: string;
    salt: string;
  }): NativeIdentity;
  getAccount(accountId: string): Promise<AccountDescriptor | null>;
  getProtocolInfo(): Promise<ProtocolInfo>;
  getModules(
    accountId: string,
    moduleType: string,
    options?: { cursor?: VMInteger; limit?: number },
  ): Promise<ModulePage>;
  getModule(accountId: string, moduleId: VMInteger): Promise<ModuleBinding | null>;
  isModuleInstalled(
    accountId: string,
    moduleType: string,
    moduleHash: string,
    additionalContext?: string,
  ): Promise<boolean>;
  deriveNonceRouting(accountId: string, routing: NonceRouting): string;
  /** Resolves the kernel's generation for an installed validator (chain read). */
  resolveCredentialGeneration(accountId: string, validatorId?: VMInteger): Promise<string>;
  getNonce(accountId: string, routing: NonceLookup): Promise<NonceState>;
  getNonceSequence(accountId: string, channel: VMInteger): Promise<string>;
  getOperationDigest(
    accountId: string,
    operation: UserOperation,
  ): Promise<string>;
  validateUserOp(
    accountId: string,
    operation: UserOperation,
  ): Promise<OperationValidation>;
  buildCreateAccountScript(input: CreateAccountInput): RegistrationPlan;
  buildExecutionScript(input: ExecutionInput): ExecutionPlan;
  getRecoverySeat(accountId: string): Promise<{ readonly seat: { readonly contractHash: string; readonly moduleId: string }; readonly supported: boolean; readonly pending?: { readonly nonce: string; readonly matureAt: string; readonly newCustody: string } | null } | null>;
  buildRecoveryModulePlan(input: { accountId: string; action: "beginRecovery" | "cancelRecovery" | "executeRecovery"; authority?: string; newCustody?: string }): Promise<RecoveryModulePlan>;
  buildRecoveryPolicyPlan(input: { accountId: string; recoveryAuthority: string; recoveryTimelockMs: VMInteger; ownerOnlyRecovery?: boolean }): Promise<AccountActionPlan & { readonly recoveryAuthority: string; readonly configurationNonce: string }>;
  buildAccountActionScript(input: AccountActionInput): AccountActionPlan;
  simulate(
    plan: NativePlan,
    signers?: readonly SignerDescriptor[],
  ): Promise<SimulationResult>;
  execute(plan: NativePlan, signers?: readonly SignerDescriptor[]): Promise<InvocationResult>;
  prepare<T extends NativePlan>(plan: T): T;
  revalidatePlan(plan: NativePlan): Promise<true>;
  prepareTransaction(
    plan: NativePlan,
    options: TransactionOptions,
  ): Promise<NativePreparedTransaction>;
  signTransaction(
    prepared: NativePreparedTransaction,
  ): Promise<NativeSignedTransaction>;
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

/**
 * The native kernel client: the v4 protocol bound to the native core hash and
 * call flags 5 (CallFlags.ReadOnly).
 */
export declare class NativeSmartAccountClient implements SmartAccountKernel {
  constructor(options: {
    rpcUrl?: string;
    rpcClient?: { send(method: string, params: unknown[]): Promise<any> };
    networkMagic: VMInteger;
    contractHash?: string;
    callFlags?: number;
  });
  readonly networkMagic: number;
  readonly contractHash: string;
  readonly callFlags: number;
  profile: NativeProfile | null;
  proxyAddress(accountId: string): string;
  invokeScript(
    script: string,
    signers?: readonly SignerDescriptor[],
  ): Promise<InvocationResult>;
  discover(): Promise<NativeProfile>;
  deriveIdentity(input: {
    custodyAddress: string;
    salt: string;
  }): NativeIdentity;
  getAccount(accountId: string): Promise<AccountDescriptor | null>;
  /**
   * The asset-holding script hash of the account (§9); it is the derived proxy
   * address and is refused if the core answers anything else.
   */
  getAccountAddress(accountId: string): Promise<string>;
  getProtocolInfo(): Promise<ProtocolInfo>;
  getModules(
    accountId: string,
    moduleType: string,
    options?: { cursor?: VMInteger; limit?: number },
  ): Promise<ModulePage>;
  getModule(accountId: string, moduleId: VMInteger): Promise<ModuleBinding | null>;
  isModuleInstalled(
    accountId: string,
    moduleType: string,
    moduleHash: string,
    additionalContext?: string,
  ): Promise<boolean>;
  deriveNonceRouting(accountId: string, routing: NonceRouting): string;
  /** Resolves the kernel's generation for an installed validator (chain read). */
  resolveCredentialGeneration(accountId: string, validatorId?: VMInteger): Promise<string>;
  getNonce(accountId: string, routing: NonceLookup): Promise<NonceState>;
  getNonceSequence(accountId: string, channel: VMInteger): Promise<string>;
  getOperationDigest(
    accountId: string,
    operation: UserOperation,
  ): Promise<string>;
  validateUserOp(
    accountId: string,
    operation: UserOperation,
  ): Promise<OperationValidation>;
  buildCreateAccountScript(input: CreateAccountInput): RegistrationPlan;
  buildExecutionScript(input: ExecutionInput): ExecutionPlan;
  getRecoverySeat(accountId: string): Promise<{ readonly seat: { readonly contractHash: string; readonly moduleId: string }; readonly supported: boolean; readonly pending?: { readonly nonce: string; readonly matureAt: string; readonly newCustody: string } | null } | null>;
  buildRecoveryModulePlan(input: { accountId: string; action: "beginRecovery" | "cancelRecovery" | "executeRecovery"; authority?: string; newCustody?: string }): Promise<RecoveryModulePlan>;
  buildRecoveryPolicyPlan(input: { accountId: string; recoveryAuthority: string; recoveryTimelockMs: VMInteger; ownerOnlyRecovery?: boolean }): Promise<AccountActionPlan & { readonly recoveryAuthority: string; readonly configurationNonce: string }>;
  buildAccountActionScript(input: AccountActionInput): AccountActionPlan;
  simulate(
    plan: NativePlan,
    signers?: readonly SignerDescriptor[],
  ): Promise<SimulationResult>;
  execute(plan: NativePlan, signers?: readonly SignerDescriptor[]): Promise<InvocationResult>;
  prepare<T extends NativePlan>(plan: T): T;
  revalidatePlan(plan: NativePlan): Promise<true>;
  prepareTransaction(
    plan: NativePlan,
    options: TransactionOptions,
  ): Promise<NativePreparedTransaction>;
  signTransaction(
    prepared: NativePreparedTransaction,
  ): Promise<NativeSignedTransaction>;
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

/** The shared transaction tools, bound to the native codec. */
export interface NativeTransactionTools {
  prepareNativeTransaction(
    client: SmartAccountKernel,
    plan: NativePlan,
    options: TransactionOptions,
  ): Promise<NativePreparedTransaction>;
  signNativeTransaction(
    client: SmartAccountKernel,
    prepared: NativePreparedTransaction,
  ): Promise<NativeSignedTransaction>;
  exportSignedTransaction(
    client: SmartAccountKernel,
    signed: NativeSignedTransaction,
  ): NativeSignedTransactionArtifact;
  preflightNativeTransaction(
    client: SmartAccountKernel,
    signed: NativeSignedTransaction,
  ): Promise<NativeTransactionPreflight>;
  broadcastNativeTransaction(
    client: SmartAccountKernel,
    signed: NativeSignedTransaction,
  ): Promise<BroadcastResult>;
  getNativeTransactionReceipt(
    client: SmartAccountKernel,
    signed: NativeSignedTransaction,
  ): Promise<NativeTransactionReceipt>;
}

export interface ModuleContractInput {
  nef: {
    magic: number;
    compiler: string;
    source: string;
    tokens: ReadonlyArray<{
      hash: string;
      method: string;
      paramcount: number;
      hasreturnvalue: boolean;
      callflags: number | string;
    }>;
    script: string;
    checksum: number;
  };
  manifest: unknown;
}

/** Module deployment identity: canonical NEF+manifest hash (§7). */
export interface CodeIdentityTools {
  canonicalJson(value: unknown): string;
  serializeNef(nef: ModuleContractInput["nef"]): Uint8Array;
  moduleCodeHash(contract: ModuleContractInput): string;
}

export declare const transactionTools: NativeTransactionTools;
export declare const codeIdentityTools: (codec: ProtocolCodec) => CodeIdentityTools;

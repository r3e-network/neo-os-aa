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
 * configurationNonce, signature, hookProofs. The codec supplies the version;
 * omitted hookProofs encode as an empty Array.
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
   * validator → 1; installed validator → its current CredentialGeneration.
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
   * 1; installed validator → its current CredentialGeneration.
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
  /** Required: use the current subject revision for built-in messages or the installed validator’s generation. */
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
    options?: { coreContractHash?: string; callFlags?: 5 },
  ): string;
  accountAddress(
    accountId: string,
    options?: { coreContractHash?: string; callFlags?: 5 },
  ): string;
  deriveIdentity(input: {
    custodyAddress: string;
    salt: string;
    coreContractHash?: string;
    callFlags?: 5;
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
  /**
   * One transaction carries exactly one complete 13-field operation, so the
   * argument is a single operation, never a list: the retired `executeUserOps`
   * batch entry has no replacement and is refused as protocol-incompatible.
   */
  buildExecutionScript(
    accountId: string,
    operation: UserOperation,
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
export declare const NATIVE_PROFILE_PARAMETER_DIGEST: string;
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
  /**
   * The §3 configuration parameter fingerprint the core published. It is part
   * of the protocol identity: a different digest is a different protocol, not
   * a partial deployment this client could degrade onto.
   */
  readonly profileParameterDigest: string;
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

/** Account status: 0 Active, 1 Frozen. */
export type AccountStatus = 0 | 1;

export interface AccountDescriptor {
  readonly accountId: string;
  readonly accountAddress: string;
  readonly exists: true;
  readonly status: AccountStatus;
  readonly statusName: "Active" | "Frozen";
  readonly custodyAddress: string;
  readonly authorityEpoch: string;
  readonly configurationNonce: string;
  readonly defaultOperationAuthorization: boolean;
  readonly defaultMessageAuthorization: boolean;
  /** The one validator instance the core requires for an operation, or 0. */
  readonly requiredValidatorId: string;
  readonly controlRevision: string;
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
  readonly compositeLayer: boolean;
  readonly governance: boolean;
  readonly hookPlanner: boolean;
}

export interface ModulePage {
  readonly moduleIds: readonly string[];
  readonly nextCursor: string;
  readonly configurationNonce: string;
}

export interface ProtocolInfo {
  readonly protocolVersion: string;
  readonly profileParameterDigest: string;
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
}

export interface PlanBase {
  readonly kind: "registration" | "execution" | "account" | "recovery" | "governance";
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
  readonly method: "executeUserOp";
  readonly accountId: string;
  readonly accountAddress: string;
  readonly proxyCallFlags: 5;
  /** The one complete 13-field operation the signed script carries. */
  readonly operation: UserOperation;
}

export interface AccountActionPlan extends PlanBase {
  readonly kind: "account";
  readonly accountId: string;
  readonly accountAddress: string;
}

export interface RecoveryModulePlan extends PlanBase {
  readonly kind: "recovery";
  readonly action: "beginRecovery" | "cancelRecovery" | "executeRecovery";
  readonly accountId: string;
  readonly targetContract: string;
  readonly moduleId: string;
  readonly configurationNonce: string;
  readonly governanceDelayMs: null;
  readonly nefSha256: string;
  readonly policy: RecoveryPolicySnapshot | null;
  readonly pending: RecoveryRequest | null;
}

/** RecoveryModule policy snapshot: `[guardians[], threshold, timelockMs, authority, revision, digest]`. */
export interface RecoveryPolicySnapshot {
  readonly guardians: readonly string[];
  readonly threshold: number;
  readonly timelockMs: string;
  readonly authority: string;
  readonly revision: string;
  readonly digest: string;
}

/** RecoveryModule twelve-field request record, reduced to its live pending view. */
export interface RecoveryRequest {
  readonly nonce: string;
  readonly initiator: string;
  readonly startedAt: string;
  readonly executableAt: string;
  readonly status: 1;
  readonly newCustody: string;
  readonly authorityEpochAtInit: string;
  readonly configurationNonceAtInit: string;
  readonly policyDigest: string;
  readonly policyRevision: string;
}

/**
 * One step of a thaw, addressed to the installed governance module. The core
 * admits `unfreezeAccount` only from that module, so custody never signs a core
 * thaw: `unfreezeAccount` proposes the single-action intent and
 * `confirmConfiguration` lands it once the module's delay has matured. Custody
 * signs both steps. The plan is stateless bytes plus the reviewed binding, so
 * the same recipe rebuilds it for an archived review.
 */
export interface GovernanceModulePlan extends PlanBase {
  readonly kind: "governance";
  readonly action: "unfreezeAccount" | "confirmConfiguration";
  readonly accountId: string;
  readonly accountAddress: string;
  /** The governance module's contract hash: the contract the script calls. */
  readonly targetContract: string;
  readonly moduleId: string;
  readonly nefSha256: string;
  /** The module's own configuration delay, read from its `configurationMaturity`. */
  readonly governanceDelayMs: string | null;
  readonly configurationNonce: string;
  /** The intent a confirmation lands; null for a proposal. */
  readonly intentId: string | null;
  /** The reviewed pending intent record; null for a proposal. */
  readonly pending: GovernanceIntent | null;
}

/** One step of a thaw through the installed governance module. */
export interface GovernanceModulePlanInput {
  accountId: string;
  action: "unfreezeAccount" | "confirmConfiguration";
  /** Required by `confirmConfiguration`: the pending unfreeze intent to land. */
  intentId?: string;
}

export type NativePlan =
  | RegistrationPlan
  | BatchRegistrationPlan
  | ExecutionPlan
  | AccountActionPlan
  | RecoveryModulePlan
  | GovernanceModulePlan;

/** The method that built a reviewed plan, and the input that rebuilds it. */
export interface PlanRecipe {
  readonly method: string;
  readonly input: any;
}

/**
 * `createAccount` input: exactly (accountId, custody, salt, actions). The v4.0
 * recovery timelock argument is retired; the recovery timelock is a policy of
 * the recovery module. `actions` are at most 16 typed VM Arrays in the v4.1
 * registration grammar: install `[1, moduleType(1|4|5), contractHash,
 * profileDigest, initData[]]` only; malformed entries are refused before signing.
 */
export interface CreateAccountInput {
  custodyAddress: string;
  salt: string;
  actions?: VMValue[];
}

/** `createAccounts` input: one custody with 1..64 salts. */
export interface CreateAccountsInput {
  custodyAddress: string;
  salts: string[];
}

export interface ExecutionInput {
  accountId: string;
  /** One complete 13-field operation; a list is protocol-incompatible. */
  operation: UserOperation;
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

/** Ordered direct updates to an existing account. The normal SDK path uses custody.
 * v4.1 action codes are 1, 2, 3, 5 and 7; codes 4, 6, 8, 9 and 10 are retired.
 */
export type ConfigurationBatchAction =
  | { method: "installModule"; moduleType: 1 | 4 | 5; moduleContractHash: string; profileDigest: string; initData?: VMValue[] }
  | { method: "removeModule"; moduleId: VMInteger; deInitData?: VMValue[] }
  | { method: "configureModule"; moduleId: VMInteger; data?: VMValue[] }
  | { method: "setBuiltinAuthorization"; defaultOperationAuthorization: boolean; defaultMessageAuthorization: boolean }
  | { method: "setRequiredValidator"; validatorId?: VMInteger; required?: boolean };
export interface ConfigurationBatchInput { accountId: string; actions: readonly ConfigurationBatchAction[] }

/** A message signature request: resolved against an installed message-capable module. */
export interface MessageVerificationInput {
  accountId: string;
  originalSender: string;
  validatorId?: VMInteger;
  generation: VMInteger;
  hash: string;
  pairs: readonly (readonly [string, string])[];
  module?: ModuleBinding;
}

export interface MessageVerificationResult {
  readonly accepted: boolean;
  readonly moduleId: string;
  readonly contractHash: string;
}

/** A recovery seat read: the module descriptor, its policy and its pending request. */
export interface RecoverySeat {
  readonly seat: ModuleBinding;
  readonly supported: boolean;
  readonly policy?: RecoveryPolicySnapshot | null;
  readonly pending?: RecoveryRequest | null;
}

/**
 * One governed configuration intent, read from the installed governance module.
 * v4.1 publishes no native intent queue, so this is module state, not core
 * state: `matureAt` is the module's maturity window applied to `proposedAt`.
 */
export interface GovernanceIntent {
  readonly intentId: string;
  /** The module's own record kind: a configuration batch or the single unfreeze action. */
  readonly kind: "configure" | "unfreeze";
  readonly proposedAt: string;
  readonly matureAt: string;
  readonly expiresAt: string;
  readonly authorityEpoch: string;
  readonly configurationNonce: string;
  readonly digest: string;
  readonly actionCount: number;
}

/**
 * A governance seat read: the validator instance that publishes the governance
 * flag, its configuration delay and its pending intents. `supported` is false
 * when no governance instance is installed or the instance answers for another
 * core; every numeric field is a decimal string, exactly as the VM returned it.
 */
export interface GovernanceSeat {
  readonly seat: ModuleBinding | null;
  readonly supported: boolean;
  readonly governanceDelayMs: string | null;
  readonly intentIds: readonly string[];
  readonly intents: readonly GovernanceIntent[];
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
  /**
   * An explicit system fee, in datoshi. Omit it and the transaction declares
   * exactly the gas the simulation consumed (plain Neo: the declared system
   * fee is the only gas limit and the node burns all of it; no margin is
   * added). A supplied value must cover that consumption and the system cap.
   */
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
  /** "simulation": the simulated consumption; "explicit": the caller's `systemFee`. */
  readonly systemFeeSource: "simulation" | "explicit";
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
  readonly callFlags: 5;
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
  validateMember(
    accountId: string,
    memberId: VMInteger,
    operationDigest: string,
    operation: UserOperation,
  ): Promise<boolean>;
  resolveMessageModule(accountId: string): Promise<ModuleBinding | null>;
  verifyMessage(input: MessageVerificationInput): Promise<MessageVerificationResult>;
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
  buildCreateAccountsScript(input: CreateAccountsInput): BatchRegistrationPlan;
  buildExecutionScript(input: ExecutionInput): ExecutionPlan;
  getRecoverySeat(accountId: string): Promise<RecoverySeat | null>;
  /** The installed governance validator instance: delay and pending intents. */
  getGovernanceSeat(accountId: string): Promise<GovernanceSeat>;
  buildRecoveryModulePlan(input: { accountId: string; action: "beginRecovery" | "cancelRecovery" | "executeRecovery"; authority?: string; newCustody?: string }): Promise<RecoveryModulePlan>;
  /** Propose or confirm the thaw of a frozen account on its governance module; custody signs both steps. */
  buildGovernanceModulePlan(input: GovernanceModulePlanInput): Promise<GovernanceModulePlan>;
  buildConfigurationBatchScript(input: ConfigurationBatchInput): string;
  buildConfigurationBatchPlan(input: ConfigurationBatchInput): Promise<AccountActionPlan & { readonly configurationNonce: string; readonly governanceDelayMs: null }>;
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
    callFlags?: 5;
  });
  readonly networkMagic: number;
  readonly contractHash: string;
  readonly callFlags: 5;
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
  validateMember(
    accountId: string,
    memberId: VMInteger,
    operationDigest: string,
    operation: UserOperation,
  ): Promise<boolean>;
  resolveMessageModule(accountId: string): Promise<ModuleBinding | null>;
  verifyMessage(input: MessageVerificationInput): Promise<MessageVerificationResult>;
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
  buildCreateAccountsScript(input: CreateAccountsInput): BatchRegistrationPlan;
  buildExecutionScript(input: ExecutionInput): ExecutionPlan;
  getRecoverySeat(accountId: string): Promise<RecoverySeat | null>;
  /** The installed governance validator instance: delay and pending intents. */
  getGovernanceSeat(accountId: string): Promise<GovernanceSeat>;
  buildRecoveryModulePlan(input: { accountId: string; action: "beginRecovery" | "cancelRecovery" | "executeRecovery"; authority?: string; newCustody?: string }): Promise<RecoveryModulePlan>;
  /** Propose or confirm the thaw of a frozen account on its governance module; custody signs both steps. */
  buildGovernanceModulePlan(input: GovernanceModulePlanInput): Promise<GovernanceModulePlan>;
  buildConfigurationBatchScript(input: ConfigurationBatchInput): string;
  buildConfigurationBatchPlan(input: ConfigurationBatchInput): Promise<AccountActionPlan & { readonly configurationNonce: string; readonly governanceDelayMs: null }>;
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

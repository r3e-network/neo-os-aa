/** Native AccountManagement ABI 2. Hashes are display-order hex; ByteString values are wire-order hex. */
export type NativeInteger = string | bigint | number;
export type NativeValue =
  | { type: "Null"; value?: null }
  | { type: "Boolean"; value: boolean }
  | { type: "Integer"; value: NativeInteger }
  | { type: "ByteString"; value: string }
  | { type: "Array" | "Struct"; value: NativeValue[] };
export interface NativeOperation {
  targetContract: string;
  method: string;
  args: NativeValue[];
  nonce: NativeInteger;
  deadline: NativeInteger;
  signature?: string;
}
export interface NativeContext {
  networkMagic: NativeInteger;
  accountId: string;
  authorityEpoch: NativeInteger;
  configurationNonce: NativeInteger;
}
export interface NativeIdentity {
  readonly accountId: string;
  readonly accountAddress: string;
  readonly verificationScript: string;
}
export interface NativeCodec {
  hex(value: string, bytes?: number): string;
  bytes(value: string): Uint8Array;
  bytesToHex(value: Uint8Array): string;
  integer(value: NativeInteger): bigint;
  unsigned(value: NativeInteger, bits: number, label: string): bigint;
  hashValue(displayHash: string): NativeValue;
  stringValue(text: string): NativeValue;
  canonicalValue(value: NativeValue): NativeValue;
  serializeValue(value: NativeValue): string;
  encodeValue(value: NativeValue): string;
  operationValue(
    operation: NativeOperation,
    emptySignature?: boolean,
  ): NativeValue;
  serializeOperation(
    operation: NativeOperation,
    emptySignature?: boolean,
  ): string;
  dynamicCall(
    contract: string,
    method: string,
    args: NativeValue[],
    flags?: number,
  ): string;
  composeNonce(channel: NativeInteger, sequence: NativeInteger): bigint;
  splitNonce(nonce: NativeInteger): { channel: bigint; sequence: bigint };
  verificationScript(accountId: string): string;
  accountAddress(accountId: string): string;
  deriveIdentity(input: {
    networkMagic: NativeInteger;
    custodyAddress: string;
    salt: string;
  }): NativeIdentity;
  authorizationDomain(context: NativeContext): string;
  operationPreimage(context: NativeContext, operation: NativeOperation): string;
  operationDigest(context: NativeContext, operation: NativeOperation): string;
  buildExecutionScript(
    accountId: string,
    operations: NativeOperation[],
    context: Pick<NativeContext, "authorityEpoch" | "configurationNonce"> & {
      accountId?: string;
    },
    batch?: boolean,
  ): string;
}
export declare const nativeCodec: NativeCodec;
export declare function createNativeCodec(hashAdapters: {
  sha256: (hex: string) => string;
  hash160: (hex: string) => string;
}): NativeCodec;
export declare const NATIVE_ACCOUNT_SERVICE: "d9421d07adf206e9dc4be746a02e8e087fa61741";
export declare const NATIVE_ABI_VERSION: 2;
export declare const NATIVE_PROFILE_PARAMETER_DIGEST: string;
export interface NativeProfile {
  readonly service: string;
  readonly networkMagic: number;
  readonly abiVersion: 2;
  readonly identityVersion: 1;
  readonly authorizationVersion: 2;
  readonly profileParameterDigest: string;
}
export interface NativeModuleBinding {
  readonly contract: string;
  readonly codeHash: string;
}
export interface NativePendingIntent {
  readonly address?: string;
  readonly contract?: string;
  readonly codeHash?: string;
  readonly proposedAt: string;
  readonly matureAt: string;
  readonly configurationNonce: string;
}
export interface NativePendingModuleCall {
  readonly accountId: string;
  readonly role: "verifier" | "hook";
  readonly root: NativeModuleBinding | null;
  readonly selected: NativeModuleBinding | null;
  readonly method: string;
  readonly invokedArguments: NativeValue;
  readonly proposedAt: string;
  readonly matureAt: string;
  readonly configurationNonce: string;
}
export interface NativeAccount {
  readonly version: 2;
  readonly accountId: string;
  readonly accountAddress: string;
  readonly custodyAddress: string;
  readonly recoveryAddress: string;
  readonly verifier: NativeModuleBinding | null;
  readonly hook: NativeModuleBinding | null;
  readonly status: "Active" | "Frozen";
  readonly configurationNonce: string;
  readonly authorityEpoch: string;
  readonly pendingVerifier: NativePendingIntent | null;
  readonly pendingHook: NativePendingIntent | null;
  readonly pendingRecoveryAddress: NativePendingIntent | null;
  readonly pendingRecovery: NativePendingIntent | null;
}
export interface NativePreparedOperation {
  readonly kind: "native-operation";
  readonly profile: NativeProfile;
  readonly account: NativeAccount;
  readonly context: NativeContext;
  readonly operation: NativeOperation;
  readonly digest: string;
  readonly preimage: string;
  readonly channel: string;
  readonly sequence: string;
}
export interface NativeSignerDescriptor {
  readonly account: string;
  readonly scopes: "None" | "CustomContracts";
  readonly allowedcontracts?: readonly string[];
}
export interface NativeWitness {
  readonly invocation: string;
  readonly verification: string;
}
export interface NativePlan {
  readonly kind: "registration" | "configuration" | "lifecycle" | "execution";
  readonly accountId: string;
  readonly script: string;
  readonly requiredAuthorities: readonly string[];
  readonly method?: string;
  readonly accountAddress?: string;
  readonly verificationScript?: string;
  readonly accountState?: NativeAccount;
  readonly configurationNonce?: string;
  readonly authorityPolicy?: string;
  readonly role?: "verifier" | "hook";
  readonly pending?: NativePendingModuleCall | null;
  readonly pendingCallBytes?: string;
  readonly requiresExactScript?: boolean;
}
export interface NativeExecutionPlan extends NativePlan {
  readonly kind: "execution";
  readonly batch: boolean;
  readonly accountAddress: string;
  readonly preparedOperations: readonly NativePreparedOperation[];
  readonly proxySigner: NativeSignerDescriptor;
  readonly proxyWitness: NativeWitness;
}
export interface NativeSimulation {
  readonly failedTransfers: number[];
  readonly state: string;
  readonly exception: string | null;
  readonly stack: unknown[];
  readonly gasConsumed: string | null;
  readonly minimumRequiredFee: string | null;
  readonly automaticSystemFeeAvailable: boolean;
  readonly raw: unknown;
}
/** One member's IEEE P1363 r||s signature (64-byte hex) and compressed P-256 public key. */
export interface NativeWalletMemberSignature {
  publicKey: string;
  signature: string;
}
/** Standard Neo P-256 CHECKSIG or canonical CHECKMULTISIG wallet. Sign exact
 * networkLE32 || SHA256(unsignedTx), hashing it once with P-256/SHA256.
 * CHECKSIG returns one signature string. CHECKMULTISIG returns member entries;
 * every submitted entry is verified before selecting m in script public-key order.
 * Both witness scripts must fit Neo's existing 1,024-byte limits. */
export interface NativeWalletSigner {
  account: string;
  verificationScript: string;
  sign: (signDataHex: string) =>
    | string
    | readonly NativeWalletMemberSignature[]
    | Promise<string | readonly NativeWalletMemberSignature[]>;
}
export interface NativeTransactionOptions {
  feePayer: NativeWalletSigner;
  authoritySigners?: NativeWalletSigner[];
  /** Explicit NeoNativeVerifier witnesses; scopes are derived from current root/active children and code pins. */
  verifierSigners?: NativeWalletSigner[];
  systemFee?: NativeInteger;
  maxSystemFee: NativeInteger;
  maxNetworkFee: NativeInteger;
  maxTotalFee: NativeInteger;
  validUntilBlock?: number;
  nonce?: number;
}
export interface NativePreparedTransaction {
  readonly kind: "native-transaction";
  readonly plan: NativePlan;
  readonly transaction: {
    readonly nonce: number;
    readonly systemFee: string;
    readonly networkFee: string;
    readonly validUntilBlock: number;
    readonly script: string;
    readonly signers: readonly NativeSignerDescriptor[];
  };
  readonly unsignedHex: string;
  readonly txid: string;
  readonly signData: string;
  readonly systemFee: string;
  readonly networkFee: string;
  readonly systemFeeSource: "explicit-budget" | "minimumrequiredfee";
  readonly simulation: NativeSimulation;
}
export interface NativeSignedTransaction {
  readonly kind: "signed-native-transaction";
  readonly prepared: NativePreparedTransaction;
  readonly txid: string;
  readonly rawTransaction: string;
  readonly witnesses: readonly { readonly invocation: string; readonly verification: string }[];
}
/** Public exact-byte artifact. Contains signatures and transaction data, never signing callbacks or private keys. */
export interface NativeSignedTransactionArtifact {
  readonly format: "neo-native-signed-transaction";
  readonly version: 1;
  readonly networkMagic: number;
  readonly profile: NativeProfile;
  readonly transaction: NativePreparedTransaction["transaction"];
  readonly witnesses: NativeSignedTransaction["witnesses"];
  readonly unsignedHex: string;
  readonly txid: string;
  readonly signData: string;
  readonly rawTransaction: string;
}
export interface NativeOperationInput {
  targetContract: string;
  method: string;
  args?: NativeValue[];
  channel?: NativeInteger;
  deadline: NativeInteger;
}
export type NativeLifecycleAction =
  | "proposeVerifier"
  | "activateVerifier"
  | "cancelVerifier"
  | "proposeHook"
  | "activateHook"
  | "cancelHook"
  | "proposeRecoveryAddress"
  | "activateRecoveryAddress"
  | "cancelRecoveryAddress"
  | "proposeRecovery"
  | "executeRecovery"
  | "cancelRecovery"
  | "freeze"
  | "unfreeze"
  | "cancelModuleCall";
export declare class NativeSmartAccountClient {
  constructor(options: {
    rpcUrl?: string;
    rpcClient?: { send(method: string, params: unknown[]): Promise<any> };
    networkMagic: NativeInteger;
    profileParameterDigest?: string;
  });
  readonly networkMagic: number;
  readonly profileParameterDigest: string;
  readonly profile: NativeProfile | null;
  discover(): Promise<NativeProfile>;
  deriveIdentity(options: {
    custodyAddress: string;
    salt: string;
  }): NativeIdentity;
  getAccount(accountId: string): Promise<NativeAccount | null>;
  getNonce(accountId: string, channel?: NativeInteger): Promise<bigint>;
  buildRegistration(options: {
    custodyAddress: string;
    salt: string;
    verifier?: string;
    hook?: string;
    recoveryAddress?: string;
  }): NativePlan & NativeIdentity;
  prepareOperation(
    options: NativeOperationInput & { accountId: string },
  ): Promise<NativePreparedOperation>;
  prepareOperations(options: {
    accountId: string;
    operations: NativeOperationInput[];
  }): Promise<readonly NativePreparedOperation[]>;
  attachSignature(
    prepared: NativePreparedOperation,
    signatureHex: string,
  ): NativePreparedOperation;
  revalidate(prepared: NativePreparedOperation): Promise<true>;
  revalidateExecution(plan: NativeExecutionPlan): Promise<true>;
  revalidatePlan(plan: NativePlan): Promise<true>;
  buildExecution(
    prepared: readonly NativePreparedOperation[],
    options?: { batch?: boolean },
  ): NativeExecutionPlan;
  getPendingModuleCall(
    accountId: string,
    role: "verifier" | "hook",
  ): Promise<NativePendingModuleCall | null>;
  getModuleDependencies(
    accountId: string,
    role: "verifier" | "hook",
  ): Promise<{
    root: NativeModuleBinding | null;
    cleanupBindings: NativeModuleBinding[];
    activeChildren: string[];
  }>;
  buildModuleCall(options: {
    accountId: string;
    role: "verifier" | "hook";
    child?: string;
    method: string;
    args?: NativeValue[];
  }): Promise<NativePlan>;
  buildAction(options: {
    accountId: string;
    action: NativeLifecycleAction;
    address?: string;
    role?: "verifier" | "hook";
  }): Promise<NativePlan>;
  simulate(
    plan: { script: string },
    signers?: NativeSignerDescriptor[],
  ): Promise<NativeSimulation>;
  prepareTransaction(
    plan: NativePlan,
    options: NativeTransactionOptions,
  ): Promise<NativePreparedTransaction>;
  signTransaction(
    prepared: NativePreparedTransaction,
  ): Promise<NativeSignedTransaction>;
  exportSignedTransaction(signed: NativeSignedTransaction): NativeSignedTransactionArtifact;
  preflightTransaction(signed: NativeSignedTransaction): Promise<{
    hash: string;
    network: number;
    snapshot: { height: number; hash: string };
    simulation: {
      mode: "single-transaction-next-block";
      height: number;
      timestamp: string;
      primaryIndex: number;
      view: 0;
      transactionCount: 1;
      onPersist: "HALT";
      nextConsensus: string;
    };
    verification: "Succeed";
    relayed: false;
    mempoolChecked: false;
    state: "HALT";
    gasconsumed: string;
    minimumrequiredfee: string;
    stack: unknown[];
    exception?: string | null;
    notifications: unknown[];
  }>;
  getTransactionReceipt(signed: NativeSignedTransaction): Promise<{
    txid: string;
    confirmed: boolean;
    blockHash?: string;
    vmState?: string;
    exception?: string | null;
    stack?: unknown[];
    notifications?: unknown[];
    gasConsumed?: string;
    systemFee?: string;
    networkFee?: string;
  }>;
  broadcastTransaction(
    signed: NativeSignedTransaction,
  ): Promise<{ txid: string; submitted: true; confirmed: false }>;
}

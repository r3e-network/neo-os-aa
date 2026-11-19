#!/usr/bin/env node
/**
 * v4 testnet market escrow runbook.
 *
 * v3 listed an account by calling the market, which flipped a verifier/hook
 * pair off at settlement. v4 escrows the account *control*: the market records
 * a (market, listingId) binding at the account's control revision, and
 * settlement sweeps every module instance, threshold policy, hook order,
 * message-subject set, pending intent and nonce channel, rotates custody to the
 * buyer and re-enables the built-in route — callback-free.
 *
 * That shift adds two admin gates the v3 runbook did not need:
 *
 * - the core must register the market (`setMarketService`) before the market
 *   may drive `enterMarketEscrow`;
 * - the market must allowlist the core (`setAllowedSA`) before it accepts a
 *   listing.
 *
 * Both admins are the deploying wallet, so the runbook configures them right
 * after deployment. The scenario then proves:
 *
 * 1. a module-backed account (TeeKeyValidator + WhitelistHook) lists itself;
 * 2. the account stays operable while escrowed, and a second listing of the
 *    same account is refused;
 * 3. the buyer pays, settles, and receives a clean account: modules swept,
 *    custody rotated, built-in route re-enabled;
 * 4. the buyer can immediately operate with the built-in route while the
 *    seller's old key no longer signs for the account.
 *
 * Runbooks are not gates: the v4 core is not deployed to a public testnet yet,
 * so this script is exercised only against a local chain that carries the v4
 * artifacts built by `bash contracts/compile.sh`.
 */

const crypto = require("crypto");
const { CONST, wallet } = require("@cityofzion/neon-js");

const h = require("./testnet-v4-harness");

const GAS_HASH = CONST.NATIVE_CONTRACT_HASH.GasToken;
const SALT_BYTES = 20;
const LISTING_PRICE = 10_000_000n; // 0.1 GAS, above the market's 0.01 GAS floor
const BUYER_FUNDING = 30_000_000n; // covers the price plus both network fees

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function saltHex() {
  return crypto.randomBytes(SALT_BYTES).toString("hex");
}

function nonceRouting(descriptor, validatorId = "0", credentialGeneration = "1") {
  return {
    validatorId,
    credentialGeneration,
    authorityEpoch: descriptor.authorityEpoch,
    nonceSubkey: "00".repeat(32),
  };
}

/**
 * A TeeKeyValidator operation: the signature field is the module's own
 * `keyId ‖ r‖s` DTO, so the runbook reads the key id from the module instead of
 * recomputing it, and signs the §4.3 digest with the custody key the module was
 * installed with.
 */
async function signTeeOperation(chain, core, tee, { accountId, moduleId, keyId, operation: op }) {
  const digest = h.operationDigest(chain, core.hash, accountId, op);
  const signature = wallet.sign(digest, chain.account.privateKey);
  return { ...op, validatorId: moduleId, signature: `${keyId}${signature}` };
}

async function main() {
  const chain = await h.connect();
  const seller = chain.account;
  const sellerHash = h.normalizeHash(seller.scriptHash);
  const buyer = new wallet.Account();

  console.log(JSON.stringify({
    rpc: chain.rpcUrl,
    networkMagic: chain.networkMagic,
    runId: chain.runId,
    seller: { address: seller.address, scriptHash: sellerHash },
    buyer: { address: buyer.address, scriptHash: h.normalizeHash(buyer.scriptHash) },
  }, null, 2));

  // -------------------------------------------------------------------------
  // Deployment and the two admin allowlists the v4 escrow requires.
  // -------------------------------------------------------------------------

  h.logSection("Deploy Contracts");
  const core = await h.deployCore(chain);
  const market = await h.deployContract(chain, "SAAddressMarket", `${chain.deploymentTag}-market`);
  const tee = await h.deployModule(chain, core.hash, "validators/TeeKeyValidator");
  const whitelist = await h.deployModule(chain, core.hash, "hooks/WhitelistHook");

  // The core admin is the deploying wallet, so both allowlists are written by
  // the same transaction signer that deployed the contracts.
  const sellerSigner = h.makeCustomContractSigner(seller.scriptHash, [market.hash, core.hash]);
  const marketService = await h.invokePersisted(
    chain,
    core.hash,
    "setMarketService",
    [h.hash160Param(market.hash), h.boolParam(true)],
    [h.makeSigner(seller.scriptHash)],
  );
  const allowedCore = await h.invokePersisted(
    chain,
    market.hash,
    "setAllowedSA",
    [h.hash160Param(core.hash), h.boolParam(true)],
    [h.makeSigner(seller.scriptHash)],
  );
  const marketRegistered = await h.readAndDecode(chain, core.hash, "isMarketService", [h.hash160Param(market.hash)]);
  const coreAllowed = await h.readAndDecode(chain, market.hash, "isAllowedSA", [h.hash160Param(core.hash)]);
  assert(marketRegistered?.value === true, "core did not register the market service");
  assert(coreAllowed?.value === true, "market did not allowlist the core");
  console.log(JSON.stringify({
    core,
    market,
    tee,
    whitelist,
    marketService: marketService.txid,
    allowedCore: allowedCore.txid,
    marketRegistered: marketRegistered.value,
    coreAllowed: coreAllowed.value,
  }, null, 2));

  const sdk = h.clientFor(chain, core.hash);

  // -------------------------------------------------------------------------
  // A module-backed account for sale: enclave-key validator + whitelist hook.
  // -------------------------------------------------------------------------

  h.logSection("Register Module-Backed Account");
  const accountIdSalt = saltHex();
  const validatorInstall = await h.installActionFor(chain, {
    moduleType: h.VALIDATOR_MODULE_TYPE,
    moduleHash: tee.hash,
    initData: [h.codec.stringValue("setPublicKey"), h.codec.byteStringValue(seller.publicKey)],
  });
  const hookInstall = await h.installActionFor(chain, {
    moduleType: h.HOOK_MODULE_TYPE,
    moduleHash: whitelist.hash,
    initData: [h.codec.stringValue("allowTarget"), h.codec.hashValue(GAS_HASH)],
  });
  const account = await h.createAccount(chain, sdk, {
    custody: seller,
    salt: accountIdSalt,
    actions: [validatorInstall, hookInstall],
  });
  const accountId = account.accountId;
  const descriptor = await sdk.getAccount(accountId);
  assert(descriptor.defaultOperationAuthorization === false, "installing a validator must turn the built-in route off");

  const validatorModules = await h.moduleIds(sdk, accountId, h.VALIDATOR_MODULE_TYPE);
  const hookModules = await h.moduleIds(sdk, accountId, h.HOOK_MODULE_TYPE);
  assert(validatorModules.moduleIds.length === 1, "expected exactly one validator instance");
  assert(hookModules.moduleIds.length === 1, "expected exactly one hook instance");
  const validatorId = validatorModules.moduleIds[0];
  const validatorRecord = await h.moduleState(sdk, accountId, validatorId);
  const keyIdItem = await h.readAndDecode(chain, tee.hash, "getKeyId", [
    h.hash160Param(accountId),
    h.integerParam(validatorId),
  ]);
  const keyId = Buffer.from(keyIdItem?.value || "", "base64").toString("hex");
  assert(keyId.length === 64, "the validator did not publish a key id for its configured key");
  console.log(JSON.stringify({
    txid: account.txid,
    accountId: h.normalizeHash(accountId),
    virtualAddress: account.accountAddress,
    validatorId,
    hookId: hookModules.moduleIds[0],
    keyId,
    defaultOperationAuthorization: descriptor.defaultOperationAuthorization,
  }, null, 2));

  h.logSection("Module Authorization Before Listing");
  const preSaleNonce = await h.nextNonce(sdk, accountId, nonceRouting(descriptor, validatorId, validatorRecord.credentialGeneration));
  const preSaleOp = await signTeeOperation(chain, core, tee, {
    accountId,
    moduleId: validatorId,
    keyId,
    operation: h.operation({
      targetContract: GAS_HASH,
      method: "symbol",
      nonce: preSaleNonce,
      validatorId,
      credentialGeneration: validatorRecord.credentialGeneration,
      authorityEpoch: descriptor.authorityEpoch,
    }),
  });
  const preSaleExec = await h.executeOperation(chain, sdk, { accountId, operation: preSaleOp });
  const preSaleResult = h.stackText(preSaleExec.appLog.executions[0].stack[0]);
  assert(preSaleResult === "GAS", `validator route returned ${preSaleResult}, expected GAS`);
  console.log(JSON.stringify({ txid: preSaleExec.txid, result: preSaleResult }, null, 2));

  // -------------------------------------------------------------------------
  // Listing: the market drives the core's escrow entry.
  // -------------------------------------------------------------------------

  h.logSection("Create Listing");
  const createListing = await h.invokePersisted(
    chain,
    market.hash,
    "createListing",
    [
      h.hash160Param(core.hash),
      h.hash160Param(accountId),
      h.integerParam(LISTING_PRICE),
      h.stringParam("testnet escrow smoke"),
      h.stringParam(""),
    ],
    [sellerSigner],
  );
  const listingCountItem = await h.readAndDecode(chain, market.hash, "getListingCount");
  const listingId = Number(h.decodeInteger(listingCountItem));
  const escrowActive = await h.readAndDecode(chain, core.hash, "isMarketEscrowActive", [h.hash160Param(accountId)]);
  const escrowed = await sdk.getAccount(accountId);
  assert(escrowActive?.value === true, "the core does not report an active escrow after listing");
  assert(escrowed.marketEscrowActive === true, "the account descriptor does not report the escrow marker");
  console.log(JSON.stringify({
    txid: createListing.txid,
    listingId,
    escrowActive: escrowActive.value,
    marketEscrowActive: escrowed.marketEscrowActive,
    controlRevision: escrowed.controlRevision,
  }, null, 2));

  h.logSection("Second Listing Refused While Escrowed");
  const doubleListing = await h.testInvoke(
    chain,
    market.hash,
    "createListing",
    [
      h.hash160Param(core.hash),
      h.hash160Param(accountId),
      h.integerParam(LISTING_PRICE),
      h.stringParam("duplicate"),
      h.stringParam(""),
    ],
    [sellerSigner],
  );
  assert(String(doubleListing.state || "").includes("FAULT"), "a second listing of an escrowed account should fault");
  assert(
    /market escrow|SA_MARKET_LOCKED/i.test(String(doubleListing.exception || "")),
    `second listing faulted for another reason: ${doubleListing.exception}`,
  );
  console.log(JSON.stringify({
    state: doubleListing.state,
    exception: doubleListing.exception,
  }, null, 2));

  // -------------------------------------------------------------------------
  // Escrow must not freeze the account: modules keep authorizing while listed.
  // -------------------------------------------------------------------------

  h.logSection("Module Authorization While Escrowed");
  const duringEscrowNonce = await h.nextNonce(sdk, accountId, nonceRouting(escrowed, validatorId, validatorRecord.credentialGeneration));
  const duringEscrowOp = await signTeeOperation(chain, core, tee, {
    accountId,
    moduleId: validatorId,
    keyId,
    operation: h.operation({
      targetContract: GAS_HASH,
      method: "symbol",
      nonce: duringEscrowNonce,
      validatorId,
      credentialGeneration: validatorRecord.credentialGeneration,
      authorityEpoch: escrowed.authorityEpoch,
    }),
  });
  const duringEscrowExec = await h.executeOperation(chain, sdk, { accountId, operation: duringEscrowOp });
  const duringEscrowResult = h.stackText(duringEscrowExec.appLog.executions[0].stack[0]);
  assert(duringEscrowResult === "GAS", `escrowed account returned ${duringEscrowResult}, expected GAS`);
  console.log(JSON.stringify({ txid: duringEscrowExec.txid, result: duringEscrowResult }, null, 2));

  // -------------------------------------------------------------------------
  // Payment and settlement.
  // -------------------------------------------------------------------------

  h.logSection("Fund Buyer");
  const funding = await h.invokePersisted(
    chain,
    GAS_HASH,
    "transfer",
    [
      h.hash160Param(seller.scriptHash),
      h.hash160Param(buyer.scriptHash),
      h.integerParam(BUYER_FUNDING),
      h.anyParam(null),
    ],
    [h.makeSigner(seller.scriptHash)],
  );
  console.log(JSON.stringify({ txid: funding.txid, amount: BUYER_FUNDING.toString() }, null, 2));

  h.logSection("Buyer Pays Listing");
  // The market's OnNEP17Payment records a pending payment keyed by (listing,
  // payer); its data payload is the listing id, exactly as in v3.
  const payment = await h.invokePersisted(
    chain,
    GAS_HASH,
    "transfer",
    [
      h.hash160Param(buyer.scriptHash),
      h.hash160Param(market.hash),
      h.integerParam(LISTING_PRICE),
      h.integerParam(listingId),
    ],
    [h.makeSigner(buyer.scriptHash)],
    { account: buyer },
  );
  const pending = await h.readAndDecode(chain, market.hash, "getPendingPaymentOf", [
    h.integerParam(listingId),
    h.hash160Param(buyer.scriptHash),
  ]);
  assert(h.decodeInteger(pending) === LISTING_PRICE.toString(), "the market did not record the buyer's payment");
  console.log(JSON.stringify({ txid: payment.txid, pendingPayment: h.decodeInteger(pending) }, null, 2));

  h.logSection("Settle Listing");
  const settle = await h.invokePersisted(
    chain,
    market.hash,
    "settleListing",
    [
      h.integerParam(listingId),
      h.hash160Param(buyer.scriptHash),
      h.hash160Param(buyer.scriptHash),
    ],
    [h.makeSigner(buyer.scriptHash)],
    { account: buyer },
  );
  const listingItem = await h.readAndDecode(chain, market.hash, "getListing", [h.integerParam(listingId)]);
  const listingFields = listingItem?.value || [];
  const status = h.decodeInteger(listingFields[7]);
  const buyerRecorded = h.decodeHash160(listingFields[8]);
  const settled = await sdk.getAccount(accountId);
  const escrowAfter = await h.readAndDecode(chain, core.hash, "isMarketEscrowActive", [h.hash160Param(accountId)]);
  const validatorsAfter = await h.moduleIds(sdk, accountId, h.VALIDATOR_MODULE_TYPE);
  const hooksAfter = await h.moduleIds(sdk, accountId, h.HOOK_MODULE_TYPE);
  const hookOrderAfter = await sdk.getHookOrder(accountId);
  const pendingAfter = await h.readAndDecode(chain, market.hash, "getPendingPaymentOf", [
    h.integerParam(listingId),
    h.hash160Param(buyer.scriptHash),
  ]);

  assert(status === "2", `listing should be sold, got status=${status}`);
  assert(buyerRecorded === h.normalizeHash(buyer.scriptHash), `listing buyer mismatch: ${buyerRecorded}`);
  assert(
    String(settled.custodyAddress).toLowerCase().endsWith(h.sanitizeHex(buyer.scriptHash)),
    "settlement did not rotate custody to the buyer",
  );
  assert(settled.marketEscrowActive === false, "settlement left the escrow marker on the account");
  assert(settled.defaultOperationAuthorization === true, "settlement must re-enable the built-in route");
  assert(
    BigInt(settled.authorityEpoch) === BigInt(escrowed.authorityEpoch) + 1n,
    `authority epoch should advance once: ${escrowed.authorityEpoch} -> ${settled.authorityEpoch}`,
  );
  assert(escrowAfter?.value === false, "settlement did not clear the core escrow");
  assert(validatorsAfter.moduleIds.length === 0, `settlement left ${validatorsAfter.moduleIds.length} validator instances`);
  assert(hooksAfter.moduleIds.length === 0, `settlement left ${hooksAfter.moduleIds.length} hook instances`);
  assert(hookOrderAfter.hookIds.length === 0, `settlement left ${hookOrderAfter.hookIds.length} hooks in the order`);
  assert(h.decodeInteger(pendingAfter) === "0", "settlement left a pending payment behind");
  console.log(JSON.stringify({
    txid: settle.txid,
    status,
    buyerRecorded,
    custody: settled.custodyAddress,
    authorityEpoch: settled.authorityEpoch,
    defaultOperationAuthorization: settled.defaultOperationAuthorization,
    marketEscrowActive: settled.marketEscrowActive,
    validatorsAfter: validatorsAfter.moduleIds,
    hooksAfter: hooksAfter.moduleIds,
    hookOrder: hookOrderAfter.hookIds,
    pendingAfter: h.decodeInteger(pendingAfter),
  }, null, 2));

  // -------------------------------------------------------------------------
  // The buyer receives a clean, immediately usable account.
  // -------------------------------------------------------------------------

  h.logSection("Buyer Operates The Swept Account");
  const buyerNonce = await h.nextNonce(sdk, accountId, nonceRouting(settled));
  const buyerOp = h.signOperationWithCustody(chain, core.hash, {
    accountId,
    operation: h.operation({
      targetContract: GAS_HASH,
      method: "symbol",
      nonce: buyerNonce,
      authorityEpoch: settled.authorityEpoch,
    }),
    signer: buyer,
  });
  const buyerExec = await h.executeOperation(chain, sdk, { accountId, operation: buyerOp });
  const buyerResult = h.stackText(buyerExec.appLog.executions[0].stack[0]);
  assert(buyerResult === "GAS", `buyer built-in route returned ${buyerResult}, expected GAS`);
  console.log(JSON.stringify({ txid: buyerExec.txid, result: buyerResult }, null, 2));

  h.logSection("Seller Key No Longer Signs");
  const sellerRetryNonce = await h.nextNonce(sdk, accountId, nonceRouting(settled));
  const sellerOp = h.signOperationWithCustody(chain, core.hash, {
    accountId,
    operation: h.operation({
      targetContract: GAS_HASH,
      method: "symbol",
      nonce: sellerRetryNonce,
      authorityEpoch: settled.authorityEpoch,
    }),
    signer: seller,
  });
  const sellerRefusal = await h.expectRefusal(
    chain,
    sdk,
    h.executionPlan(sdk, { accountId, operations: [sellerOp] }),
    /SA_VALIDATION_REJECTED|SA_MODULE_NOT_ROUTABLE/i,
    "operation signed by the seller's custody key after settlement",
  );
  console.log(JSON.stringify({ sellerRefusal }, null, 2));

  // -------------------------------------------------------------------------
  // Summary — the last JSON object is what the validation suite reads.
  // -------------------------------------------------------------------------

  h.logSection("Summary");
  console.log(JSON.stringify({
    core,
    market,
    teeVerifier: tee,
    whitelistHook: whitelist,
    listingId,
    accountId: h.normalizeHash(accountId),
    seller: sellerHash,
    buyerRecorded,
    buyer: h.normalizeHash(buyer.scriptHash),
    custodyAfterSale: settled.custodyAddress,
    status,
    txids: {
      createListing: createListing.txid,
      funding: funding.txid,
      payment: payment.txid,
      settle: settle.txid,
      buyerExecute: buyerExec.txid,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

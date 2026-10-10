function text(value) {
  return String(value ?? '').trim();
}

/**
 * Capture every value that can affect a metadata save before the wallet is
 * asked to sign. The returned object is immutable so a later form or session
 * change cannot alter the payload selected for the transaction or mirror.
 */
export function captureMetadataSaveIntent({
  accountAddress,
  accountIdHash,
  backupOwner,
  wallet,
  rpcUrl,
  coreHash,
  metadataUri,
  description,
  logoUrl,
  idToken,
  epoch,
  walletContext,
}) {
  return Object.freeze({
    accountAddress: text(accountAddress).toLowerCase(),
    accountIdHash: text(accountIdHash).toLowerCase(),
    backupOwner: text(backupOwner).toLowerCase(),
    wallet: text(wallet),
    rpcUrl: text(rpcUrl),
    coreHash: text(coreHash).toLowerCase(),
    metadataUri: text(metadataUri),
    description: text(description),
    logoUrl: text(logoUrl),
    idToken: text(idToken),
    epoch,
    walletContext,
  });
}

export function metadataIntentMatchesCurrent(intent, current) {
  if (!intent || !current) return false;
  return intent.accountAddress === text(current.accountAddress).toLowerCase()
    && intent.accountIdHash === text(current.accountIdHash).toLowerCase()
    && intent.backupOwner === text(current.backupOwner).toLowerCase()
    && intent.wallet === text(current.wallet)
    && intent.rpcUrl === text(current.rpcUrl)
    && intent.coreHash === text(current.coreHash).toLowerCase()
    && intent.metadataUri === text(current.metadataUri)
    && intent.description === text(current.description)
    && intent.logoUrl === text(current.logoUrl)
    && intent.idToken === text(current.idToken)
    && intent.epoch === current.epoch
    && intent.walletContext === current.walletContext;
}

export function metadataMirrorPayload(intent) {
  if (!intent) throw new Error('metadata intent is required');
  return {
    accountIdHash: intent.accountIdHash,
    description: intent.description,
    logoUrl: intent.logoUrl,
    metadataUri: intent.metadataUri,
    ...(intent.idToken ? { idToken: intent.idToken } : {}),
  };
}

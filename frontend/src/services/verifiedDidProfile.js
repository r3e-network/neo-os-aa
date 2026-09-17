// Authentication failures never fall back to unverified browser claims.
export async function authenticateVerifiedDid(client, verify) {
  if (typeof client?.authenticateUser !== 'function') throw new Error('did_authentication_unavailable');
  const response = await client.authenticateUser();
  const token = typeof response === 'string' ? response : response?.idToken;
  if (typeof token !== 'string' || !token.trim() || token !== token.trim()) {
    throw new Error('did_token_missing');
  }
  const verified = await verify(token);
  if (verified?.ok !== true || typeof verified.profile?.did !== 'string'
    || !verified.profile.did.trim() || verified.profile.provider !== 'web3auth'
    || !verified.claims || typeof verified.claims !== 'object' || Array.isArray(verified.claims)) {
    throw new Error('did_verification_failed');
  }
  return { ...verified.profile, tokenClaims: verified.claims, idToken: token };
}

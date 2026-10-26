# Action identity enrollment and session migration

SocialRecoveryVerifier action-v4 uses a separate owner-enrolled identity set.
Recovery factors are never copied into it. The initial owner still authenticates
`setupRecovery` against the pinned core's backup-owner registry. Subsequent
enrollment uses the verifier's **current owner**, including an owner changed by
threshold/timelock recovery; it does not substitute the old core backup owner.

The owner explicitly invokes `setActionIdentity(accountId, masterNullifier,
enabled)`. The 32-byte master nullifier is the existing DID-derived identity
root; the transaction grants the distinct action purpose. A provider login or
DID bind response alone does not grant that purpose. The UI's enrollment/revoke
buttons request normal owner-wallet transactions only when clicked. Recovery
remains ownerless through its existing recovery-ticket, threshold and timelock
path. Action membership neither counts as a recovery approval nor bypasses it.

`getActionAuthorizationEpoch(accountId)` is a persistent, monotonically
increasing integer. New enrollment/removal, revoke-all, session revoke, shared
trust-config changes, recovery finalization, cleanup and setup advance it.
Cleanup deletes grants/session authorization but **retains** the epoch. An added
identity does not remove other enrolled identities; it invalidates outstanding
tickets and sessions from the prior epoch. No-op enrollment of an existing
identity does not advance the epoch. The identity list is bounded to 16 entries.
Integer exhaustion faults atomically; the epoch never wraps or resets to zero.

## Wire contract

- Encoding: `neo_n3_action_v4`; both existing selector names `callback_encoding`
  and `result_encoding` reach the same issuer guard. Conflicting values fail.
- Action ID keeps the existing exact `aa_proxy:` formula binding network text,
  raw core/account/executor bytes, session nonce and expiry.
- Digest: SHA256 of `UTF8("neodid-aa-action-v3") || LP(network) || rawCore20 ||
  rawAccount20 || rawVerifier20 || LP(accountText) || rawExecutor20 ||
  LP(actionId) || LP(expiryDecimal) || actionNullifier32 || masterNullifier32 ||
  LP(authorizationEpochDecimal)`. `LP` is one UTF-8 byte-count byte followed by
  those exact UTF-8 bytes (maximum 255 bytes). Do not trim opaque signing text,
  normalize Unicode or reverse the raw UInt160 bytes in the digest.
- Oracle packet: ASCII `4|base64(master32)|epochDecimal|base64(actionNullifier32)|base64(signature64)`.
  Exactly five fields; epoch is positive canonical decimal. The DID owner source
  exports its encoder. Recovery packet v3 and its digest domain are unchanged.
- Manual entry: `submitActionTicketV4(accountId, executor, actionId, expiresAt,
  masterNullifier, authorizationEpoch, actionNullifier, verificationSignature)`.
  Manual and Oracle routes share activation's current membership/epoch guard,
  followed by the existing context/signature/expiry/replay checks and atomic
  session/nonce writes. Oracle requests retain their original epoch separately,
  so delayed responses cannot borrow a later enrollment generation.

The issuer authenticates the provider UID inside the TEE and derives the same
master nullifier from the existing server salt. A server-owned reader must
attest the configured canonical core -> installed verifier -> current action
grant, exact account/context, epoch and session nonce at one coherent state.
Unknown, missing, FAULT or incoherent reads fail before any custody signing.
Caller RPC URLs, owner strings, posted grants or valid JWTs alone cannot supply
this authority. The action lane does not inherit the recovery provider override.

## Existing v3 tickets and active sessions

New AA issuance requires v4. The legacy direct `submitActionTicket` may consume
an existing v3 signature **only with actual current-owner witness plus executor
witness**; the shared helper enforces this rule. It does not provide ownerless
fallback. Old Oracle v3 packets are rejected; submit a new v4 request after
explicit action enrollment. No recovery-only identity is grandfathered.

Previously stored active sessions have no authorization-origin marker. Their
session execution branch returns false until the current owner explicitly
invokes `reauthorizeActiveActionSession(accountId, expectedExecutor,
expectedActionId, expectedExpiresAt, expectedActionNullifier)`, or authorizes a
new session. The method compares the exact displayed tuple before recording
consent; a concurrent replacement cannot receive accidental approval. Ordinary
current-owner execution remains available. Reauthorization does not enroll an
identity or grant permission to create subsequent sessions. Epoch changes
invalidate this session-specific consent too.

Preserve the salt and stable identity roots. Existing users enroll the action
purpose with the owner wallet; they do not re-register the consumed nullifier
in NeoDIDRegistry. Deployments need freshly built artifacts and an explicit
consumer/issuer/Services composition plan; source changes and fake controls do
not establish compilation, migration execution or production readiness.

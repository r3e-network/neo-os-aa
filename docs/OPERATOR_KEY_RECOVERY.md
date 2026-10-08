# Draft operator key persistence and recovery

Draft operator keys authorize off-chain draft administration, not account spending.
The server pins the first P-256 public key and verifies every mutation against that
key and the current counter. An operator URL remains necessary, but cannot replace
a lost, already-pinned key.

## Threat model and user flows

- A browser restart must preserve the same key. Store an AES-GCM encrypted private
  JWK in IndexedDB with a non-extractable, origin-local wrapping key. Do not write
  private JWKs, backup passwords or operator links to localStorage or URLs.
- Browser storage deletion, a different browser or a different device requires an
  explicitly exported, password-encrypted backup plus the current operator link.
  Without that backup, an already-lost key cannot be recovered. There is no server
  reset or bearer-link takeover endpoint.
- An operator exports a backup from the draft's key panel using a password of at
  least 12 characters. The backup contains the draft identity and an encrypted key
  pair, never an operator access link. Keep the password separately from the file.
- On import, validate the format, authenticated encryption, draft identity and
  private/public key correspondence. Ask the existing claim endpoint to verify the
  pinned public key before replacing local key material. Wrong keys and malformed
  backups must not overwrite a working local key or issue mutations.
- Existing sessionStorage keys migrate after a successful IndexedDB write and
  readback. Malformed existing data fails closed; it is not silently replaced.
- Origin compromise (XSS), a malicious browser extension or an unlocked device can
  use the local key. Browser encryption limits plaintext exposure; it does not
  create protection from a hostile same-origin runtime. A stolen backup permits
  offline password guessing, so choose a long, unique passphrase.

## Interfaces and data

`createOperatorMutationTransport()` retains `run({ shareSlug, accessSlug,
mutation, payload })`. The counter is refreshed by the authenticated claim before
each mutation. Link rotation does not rotate or reset the pinned key.
Claims always read the current server pin and counter; Redis response replay is
disabled for claims, including requests with explicit idempotency keys. Mutation
replay is bound to the signature, HTTP method and canonical request fields. Only
an exact signed retry can retrieve its previous response, including a rotated
operator link; this replay is receipt recovery, not a fresh authorization grant.
Adding those fields also prevents old cache entries from being used after deploy.
Request journaling is retained. Public-key matching
compares P-256 curve and coordinates, so JSONB property reordering is harmless.

Additional local interfaces are `exportBackup({ shareSlug, accessSlug,
passphrase })` and `importBackup({ shareSlug, accessSlug, passphrase, backup })`.
Export returns a JSON string for a user-initiated download. Import returns only
success; secret material never appears in error strings, telemetry or HTTP bodies.
Only public keys and signed canonical mutations are sent to `/api/draft-operator`.

The backup envelope has format `neo-aa-operator-backup`, version `1`, `shareSlug`,
PBKDF2-SHA256 parameters (600,000 iterations, 16-byte random salt), and AES-GCM
parameters (256-bit key, 12-byte random IV, 128-bit tag). The format, version and
draft identity are authenticated as additional data. The decrypted payload holds
the draft identity and P-256 public/private JWK pair. File size is limited to 16 KiB
and cryptographic parameters are fixed, preventing arbitrary KDF work on import.

Browser records have version `2`, draft identity, public JWK, encrypted private
JWK, IV and a non-extractable AES-GCM wrapping CryptoKey. IndexedDB transactions
atomically reuse the first generated record when same-origin tabs race to create
a key. A per-draft lock serializes local claim/mutate and import operations when
the Web Locks API is available; server counter checks remain authoritative.

If a new tab persisted a key that the server rejected before an old tab migrated,
the original tab may offer its legacy key. Only a successful server pin check
allows that legacy key to replace the rejected durable record.

## Errors, performance and rollout

Unavailable or corrupt durable storage blocks key creation before server binding.
Backup failures have fixed error codes: weak password, invalid backup, wrong
draft, key mismatch, unavailable storage or pinned-key recovery required. UI errors
never echo input. Password derivation happens only on explicit export/import;
normal mutations use the local wrapping key and do not run PBKDF2.

Deploy the frontend and draft-operator API together; no database migration or
server trust-policy change is required. Existing users must export a backup or
perform an operator action in the old session to migrate before closing it.
Users who already lost the only session key must create a new draft;
neither this migration nor an operator link can recreate the lost private key.

Validation commands (run in `frontend/`):

```sh
node --test tests/operatorKeyRecovery.test.js tests/operatorMutationHelpers.test.js tests/operatorMutationWiring.test.js tests/operatorClaimFreshness.test.js tests/requestDurability.test.js
npm run test:operator-recovery:browser
```

The browser test uses a disposable Chromium profile and a local endpoint to verify
the real backup UI, encrypted download, full browser restart with IndexedDB key
retention, incorrect password rejection and recovery in a fresh browser profile.
The repository verification script runs it after the existing frontend browser
suite, so CI covers recovery without requiring a separate workflow.

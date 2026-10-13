# Neo N3 Abstract Account V3 Historical Design Note

> This document records the V3 design direction, not a current deployment or protocol
> activation certificate. Current behavior and release evidence are documented in
> [AA system status](AA-SYSTEM-STATUS.md), [ordinary account workspace](ORDINARY_ACCOUNT_WORKSPACE.md),
> [formal verification](AA-FORMAL-VERIFICATION.md) and `implementations/*/profile.json`.
> Passing current ordinary source checks does not close public callback resource isolation,
> candidate artifact migration, deployment parity or native protocol activation.

## Historical design and current corrections

The design aimed to combine social identities, different signature curves, off-chain
policies and fee sponsorship. The following corrections describe current ordinary
contract source. They do not certify a public deployment, identity provider, TEE
service or wallet integration.

### Account identity and state

Ordinary registration derives accountId from a registration domain, BackupOwner,
verifier, initialization parameters, Hook and escape delay; it does not accept an
arbitrary random salt. Platform registrations have separate registrar-controlled
binding and stable-identity paths. accountId identifies core state; assets are held
at the core-derived proxy script hash. These identifiers are not interchangeable.

No separate contract is deployed per account, but registration, storage and execution
still incur transaction fees. The core stores configuration, nonce cursors, pending
changes, recovery, market escrow and authorization contexts. Plugins also store
per-account public keys, sessions, budgets or policy; they are not stateless pure
computations. Execution accepts bounded target/method/argument calls and batches,
not arbitrary NeoVM bytecode.

The only executable nonce rule is `0 <= nonce < 2^255`: the upper 191 bits select a
channel and the lower 64 bits are its sequence. Each channel advances independently
from zero; an exhausted sequence cannot continue in the same channel. There is no
numeric threshold selecting a UUID, random-salt or bitmap mode. Successful execution
consumes the nonce atomically; a fault rolls back account state.

### Plugin configuration and upgrades

The ordinary BackupOwner authorizes configuration using a Neo witness. First
installation into an empty slot is immediate; replacement of an installed verifier
or Hook is proposed and confirmed after 24 hours, and may be cancelled. The core is
upgradeable: an admin pins the NEF and manifest digests, waits at least seven days,
and supplies the matching artifact pair. Plugins have their own administration and
upgrade authority, dependencies and cleanup requirements.

The current source candidate uses a seven-day proposal/confirmation/cancellation
flow for platform BackupOwner rotation, including a new-owner witness at confirmation.
The older public artifact's immediate rotation behavior is not proof of deployment
of this candidate flow.

### Identity and signature capability

- Web3AuthVerifier checks secp256k1 operation signatures with its specific domain and
  encoding. Ordinary UserOperation signatures use 64-byte `r || s`; the separate
  message adapter accepts 64 or 65 bytes. Social login and DID mapping remain separate
  integrations; a valid operation signature does not prove identity or credentials.
- TEEVerifier checks a configured P-256 key's AA payload signature. It does not verify
  remote attestation, enclave vendor, hardware custody, privacy or off-chain policy
  execution on chain. Those claims need independent evidence.
- WebAuthnVerifier is currently a bare P-256 signature verifier. It does not validate
  WebAuthn challenge, rpIdHash, origin, authenticatorData flags or sign counters. It
  provides no complete Passkey, biometric or browser-origin guarantee. A normal
  WebAuthn assertion is not automatically a signature over the same AA payload.
- ZKEmailVerifier rejects operations pending real proof verification. DKIM proof,
  email recovery and private on-chain email authorization remain design goals.
- SessionKeyVerifier, SubscriptionVerifier and Hooks enforce their implemented
  permissions and metering. Login alone does not grant a session or imply unlimited,
  risk-free use.
- MultiSigVerifier and MultiHook have bounded configuration and dependency rules.
  A plugin name does not imply composability. Current ordinary Web3Auth, TEE and
  WebAuthn verifiers do not advertise composition support; an EVM/Passkey/TEE threshold
  example must not be interpreted as an available configuration.

### Sponsorship and callback resources

The on-chain AAPaymaster holds GAS deposits and sponsorship policies. A relay pays
transaction fees up front; the ordinary sponsored entrypoint executes the account
operation and settles reimbursement atomically, enforcing target/method restrictions,
expiry, budgets and deposits. The core caps reimbursement at actual transaction fees.
Settlement failure rolls back the operation, but a persisted failed transaction may
still cost the relay fees. Morpheus pre-authorization and simulation are additional
submission checks, not substitutes for on-chain policy enforcement. A gasless user
experience means another party pays, not that execution is free.

Public ordinary callbacks have no isolated verifier/Hook child gas budget. A private
PLATFORM syscall, native AccountManagement budget or abstract formal model cannot
close that public gate. Sponsoring arbitrary unaudited plugins remains NO-GO.

### Backup-owner recovery

BackupOwner initiates `initiateEscape(accountId)` and explicitly completes
`finalizeEscape(accountId, newVerifier)` after the configured 7–90 day delay. A retained
overload accepts initialization parameters; a zero verifier restores BackupOwner
authorization. Initiation has a one-hour cooldown whose marker is cleared after
successful finalization. Maturity never completes recovery automatically.

An active escape can be cancelled only by a successful operation carrying the current
BackupOwner witness; a verifier signature alone cannot cancel it. Loss of the sole
backup key cannot be repaired by this path. Finalization requires successful cleanup
of the old verifier and Hook, so a faulty or refusing `clearAccount` can block it.
Atomic rollback protects state integrity, not unconditional recovery or asset availability.

### Use and acceptance

Follow the ordinary account workspace to register and govern accounts. Preserve
accountId, derived receiving address, BackupOwner and recovery arrangements. Wait for
successful chain execution after submission; a wallet-returned txid is not confirmation.
Review pending targets and parameters before plugin replacement, and do not confirm
blindly when an older deployment lacks complete pending-state reads.

Automated trading, maximum-drawdown policy, full Passkey ceremonies, email recovery and
credential composition each require implementation and acceptance evidence. Source
tests, candidate artifact identity, public deployment and independent readback are
separate evidence layers. Historical examples or local passes do not establish
protocol-wide GO.

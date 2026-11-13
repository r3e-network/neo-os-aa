# SmartAccount V3 — Platform Service Extraction (Phase 1b)

Status: design record for the V3 platform-service extraction refactor.
Scope: `contracts/` (core partials, market, paymaster, new registrar), tests, ABI
mirrors, ordinary profile, AA upgrade scripts. Native areas (implementations/
native, shared/nativeSmartAccountClient.mjs, frontend/src/shared, native docs)
are out of scope and untouched.

## 1. Summary

The V3 core currently embeds three platform-service domains as partial-class
logic: market escrow arbitration, paymaster reimbursement settlement, and the
platform registrar's pending-owner-rotation bookkeeping. Phase 1b moves each
domain's policy and bookkeeping to a single-responsibility service contract and
shrinks the core to state ownership plus minimal, explicitly gated entry
points. One storage migration (pending platform owner rotations, prefix `0x20`)
moves core-owned state to the new registrar contract through a one-time
admin-gated method.

## 2. Service boundaries

### 2.1 Market (`contracts/market/AAAddressMarket.cs`)

* Service owns: listings, pricing, payment custody/matching, settlement and
  cancellation policy, its own admin allowlist (`setAllowedAA`) and upgrade
  timelock.
* Core owns: the escrow *lock primitives* — `enterMarketEscrow`,
  `cancelMarketEscrow`, `settleMarketEscrow`, the owner-side
  `initiateMarketEscrowCancel` / `forceCancelMarketEscrow` escape (a destroyed
  market must never brick the owner's reclaim), and the escrow marker keys
  (`0x06`, `0x07`, `0x1D`) that gate execution/configuration on the account.
* New core defense: `enterMarketEscrow` additionally requires the calling
  market to be *registered* on the core (`setMarketService`, prefix `0x29`,
  admin-gated). Caller==market alone does not stop a fake market contract from
  locking a seller's account and settling it to an attacker-chosen
  `newBackupOwner` without payment; the admin-registered allowlist does.

### 2.2 Paymaster (`contracts/paymaster/Paymaster.cs`)

* Service owns: sponsorship policies, sponsor deposits, daily/total spending
  counters, relay payout, its authority surface (authorized core, admin,
  timelocked update) — unchanged.
* Core owns: `executeSponsoredUserOp(s)` — the sponsored execution callback
  driven by the core execution engine — plus the transaction-global
  reimbursement reservation (`0x21`) that realizes
  `CapReimbursementToActualCost`. Settlement is already fully paymaster-side
  (`settleReimbursement`); the core partial keeps no settlement logic.
* Flagged decision (see §6): the cost-cap reservation stays in the core
  because it must be one record shared across *all paymasters* settling in one
  transaction. Moving it per-paymaster would re-open audit MEDIUM-a for
  multi-paymaster transactions (the pinned invariant
  `SameTransaction_DifferentAccountsAndPaymastersShareCoreBudget`).

### 2.3 Registrar (`contracts/registrar/PlatformRegistrar.cs`, new)

* Service owns: pending platform-account owner rotations (proposal records,
  7-day timelock, cancellation), the admin/authorized-core/upgrade authority
  surface (mirrors the Paymaster/PaymasterAuthority pattern), and the
  orchestration wrappers `registerPlatformAccount` /
  `registerStablePlatformAccount` / `propose…Rotation` / `confirm…Rotation` /
  `cancel…Rotation` with their getters.
* Core owns: platform-account *state* — deterministic account computation
  (`computePlatformAccountId` / `computeStablePlatformAccountId`), the
  registrar-gated registration entry points, the registrar pointer
  (`0x17`–`0x19`, admin + 7-day timelock), the app binding (`0x1E`), the proxy
  index (`0x1F`), and a new registrar-gated `applyPlatformAccountOwnerRotation`
  that performs the authoritative ownership change with full re-validation.

## 3. Minimal core ↔ service interfaces

| Direction | Call | Gate |
| --- | --- | --- |
| market → core | `enterMarketEscrow`, `cancelMarketEscrow`, `settleMarketEscrow`, `getBackupOwner`, `isMarketEscrowActive` | escrow market binding; `enter` additionally requires registered market (`0x29`) |
| core → market | `abandonListing` notification (pre-flighted, best-effort) | market manifest ABI check |
| core → paymaster | `authorizedCore` (read), `settleReimbursement` (write) | paymaster validates `authorizedCore == core` / core caller |
| paymaster → core | `isUserOpExecutionActive` (read) | confused-deputy closure, unchanged |
| registrar → core | `registerPlatformAccount`, `registerStablePlatformAccount`, `applyPlatformAccountOwnerRotation` | `AssertPlatformRegistrar` (caller == `0x17` pointer) |
| registrar → core (read) | `getBackupOwner`, `isMarketEscrowActive`, `getEscapeTriggeredAt`, `getPlatformAccountBinding` | `[Safe]` reads |
| core → registrar (migration only) | `ingestPendingPlatformOwnerRotation` | registrar validates core caller |

Registrar `apply` is deliberately the only state-changing platform entry the
core exposes besides registration: the registrar holds the timelock record,
the core re-validates everything it owns (binding match, configuration idle,
no escrow, escape idle, `previousOwner == state.BackupOwner` staleness guard,
`CheckWitness(newBackupOwner)`, previous != new) and emits
`OnPlatformAccountOwnerRotated`. A pre-sale rotation can therefore never be
confirmed against a sold account — the old `SettleMarketEscrow` deletion of
`0x20` becomes redundant and is removed; escape finalization likewise stops
deleting the core key it no longer owns.

## 4. Storage ownership migration table

| Prefix | Contents | Owner before | Owner after | Migration |
| --- | --- | --- | --- | --- |
| `0x06`/`0x07` | escrow market/listing markers | core | core (unchanged) | none — escrow lock is core-owned account state |
| `0x1D` | owner cancel marker | core | core (unchanged) | none |
| `0x20` | pending platform owner rotation | core | registrar (`0x01` + accountId) | one-time `migratePlatformOwnerRotations` |
| `0x21` | transaction reimbursement reservation | core | core (unchanged) | none — flagged, §6.1 |
| `0x29` (new) | registered market service allowlist | — | core (`MarketEscrow.cs`, +market) | none — new key, empty at upgrade |
| `0x2A` (new) | migration completed flag | — | core (bare) | written once by the migration method |
| market GAS custody | listing payments | market | market | none — already service-side |

Pending rotation records are enriched on migration: the registrar stores
`{NewBackupOwner, PreviousOwner, AppBinding, InitiatedAt}` where
`PreviousOwner` is read from the core account state at migration time. New
proposals store the same shape. `AppBinding` lets the registrar enforce scope
without a core round-trip; the core still independently re-validates it in
`apply`.

## 5. Call-gate matrix

| Core entry | Caller gate | Second gate |
| --- | --- | --- |
| `enterMarketEscrow` | escrow market == caller | registered market (`0x29`) + backup-owner assert + idle + no escrow |
| `cancelMarketEscrow` / `settleMarketEscrow` | escrow market == caller | listing match (+ clean-shell wipe on settle) |
| `forceCancelMarketEscrow` | backup owner | 7-day owner-cancel timelock |
| `setMarketService` / `isMarketService` | admin witness / `[Safe]` | one market per key row |
| `executeSponsoredUserOp(s)` | relay (op validation) | paymaster `authorizedCore` == core + reservation cap |
| `registerPlatformAccount` / `registerStablePlatformAccount` | registrar pointer | account-id determinism |
| `applyPlatformAccountOwnerRotation` | registrar pointer | binding match + idle + no escrow + escape idle + staleness guard + `CheckWitness(newBackupOwner)` |
| `migratePlatformOwnerRotations` | admin witness | one-time `0x2A` flag |
| `propose/confirm/cancelPlatformRegistrar` | admin witness | 7-day timelock + global-config idle |

Registrar service gates: `propose…Rotation` — admin witness + staleness check
via core `getBackupOwner` (a record whose `PreviousOwner` no longer matches the
core state is replaceable, giving liveness); `confirm…Rotation` — 7-day
timelock, then core `apply` enforces the new-owner witness; `cancel…Rotation` —
admin or current core owner witness; `ingest…` — core caller only.

## 6. Flagged design decisions

These are deliberate deviations from the literal extraction instructions,
kept because the alternatives weaken pinned security invariants. They are
flagged for the operator's sign-off rather than unilaterally taken as final.

1. **Reimbursement reservation stays core-side (`0x21`).** A per-paymaster
   reservation would give every paymaster its own budget inside one
   transaction; the transaction-global record is the only construction that
   keeps the aggregate sponsored reimbursement bounded by actual cost when
   several paymasters settle in the same transaction. The cap arithmetic
   (`CapReimbursementToActualCost`) therefore remains in the core partial as
   the execution-side half of the sponsored path, while all settlement policy
   and payout remain paymaster-side. This is a boundary clarification, not a
   behavioral change: no pinned test changes.
2. **`ContractPermission("*","*")` retained on the core.** `executeUserOp`
   dispatches `Contract.Call(op.TargetContract, op.Method, …)` for
   user-chosen targets; permission checks only apply to non-`[Safe]` target
   methods, so enumerating the target surface would restrict user operations
   to a fixed method set — a protocol-level functional decision. Instead the
   header comment is rewritten to enumerate every *fixed* callee domain
   (module callbacks, module-call allowlists, GAS transfer,
   `ContractManagement.update`, paymaster settlement, market
   `abandonListing`, registrar ingest) and state the wildcard's sole
   justification: the user-op dispatch axis.
3. **Migration gating rides the upgrade timelock.** The core bytecode
   upgrade is already admin + 7-day timelocked (AA-D-01); the one-time
   `migratePlatformOwnerRotations` adds an admin witness + one-time flag on
   top of that window instead of a second independent 7-day timelock. The
   migrated records keep their original `InitiatedAt`, so an in-flight
   rotation cannot be re-armed by the migration.

## 7. Migration and rollback

Orchestration (scripts/ phase, testnet first; driven by
`scripts/migrate_smart_account_v3.js` — one phase per invocation, dry-run by
default, fail-closed surface checks, explicit `--execute` confirmation):

1. Deploy `PlatformRegistrar` with `data = core hash` (authority
   `AuthorizedCore` = current core).
2. Propose + confirm the core V3 upgrade (existing 7-day timelock path).
3. Core: `setMarketService(market, true)` for the deployed AAAddressMarket;
   `proposePlatformRegistrar` + 7-day + `confirmPlatformRegistrar` to point the
   core at the new registrar.
4. Core: `migratePlatformOwnerRotations(accountIds)` — reads legacy `0x20`
   rows plus their `0x1E` bindings and current backup owners, ingests them
   into the registrar, deletes the core keys, sets `0x2A`.
5. Registrar authority: `ProposeAuthorizedCore` + 7-day +
   `ConfirmAuthorizedCore` after any future core re-deployment.

Rollback: until step 4 the legacy `0x20` keys are untouched and the previous
core bytecode still understands them, so a pre-migration rollback is a plain
core upgrade. After the `0x2A` flag is set the migration is one-way by design
(records live in registrar storage); recovery is a fresh rotation proposal, not
a storage rewind.

## 8. Downstream sync surface

* `scripts/upgrade_testnet_smart_account.js` `REQUIRED_METHODS`: drop the six
  rotation methods, add `applyPlatformAccountOwnerRotation`,
  `migratePlatformOwnerRotations`, `setMarketService`, `isMarketService`.
* `implementations/ordinary/profile.json`
  `currentSourceCandidate.abiMethodCount`: recounted after the ABI delta.
* `frontend/src/assets/contracts` byte-identical mirror of every changed core
  partial (pinned by `FrontendContractSourceMirrorTests`).
* `SourceInvariantTests` / `StoragePrefixMapTests` pins updated for the new
  boundary (prefix map rows `0x29`/`0x2A`, removed `0x20` row, registrar
  contract invariants).
* `contracts/compile.sh`: compile paymaster and registrar service contracts
  into `bin/v3` (closing the existing gap where `AAPaymaster.nef` is expected
  at `bin/v3` but never built there), and drop `PlatformRegistrarMock` once
  tests target the real registrar.
* Cross-repo pins: `docs/SMARTACCOUNT-V3-UPGRADE-COORDINATION.md` lists every
  downstream reference of the mainnet core `0x0268a387…` / testnet
  `0xdbf38e7b…` addresses.

## 9. Verification

`contracts/compile.sh` full rebuild; `dotnet test` over
`tests/SmartAccount.Contracts.Tests` with the new registrar runtime tests
(real contract, not the mock), the market-service-allowlist tests, and the
one-time migration tests (legacy `0x20` rows written directly into engine
storage, migrated, asserted gone, second call rejected).

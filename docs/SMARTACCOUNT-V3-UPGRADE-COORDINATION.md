# SmartAccountV3 Platform-Service Extraction — Cross-Repo Upgrade Coordination

Phase 1b of the dual-edition audit remediation extracted the platform services
(MarketEscrow settlement, Paymaster reimbursement settlement, Platform
Registrar) out of the ordinary core into standalone service contracts. This
checklist coordinates every downstream repository that pins the deployed core
identity so the governed upgrade ships without a stale pin.

Design reference: `docs/proposals/SMARTACCOUNT-V3-PLATFORM-SERVICE-EXTRACTION.md`.
Native-edition convergence (Phase 2) is tracked separately and is NOT in scope
here.

## 1. Contract identities

The upgrade rides `ContractManagement.Update`, so the deployed contract
**hashes do not change**. Only the NEF and manifest digests change.

| Identity | Value | Change |
| --- | --- | --- |
| Mainnet core script hash | `0x0268a387913b250166ddec032b03332690a1ef78` | unchanged (update path) |
| Testnet core script hash | `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2` | unchanged (update path) |
| Candidate NEF sha256 | `4e9046335c5cfdab2f5ecd84c55ce8b66156ae88cd4e6b25429ec080104d7b3b` | new (Phase 1b build) |
| Candidate manifest sha256 | `8b76f39ed5b4e5167be3dc6d5ca6c442eb4e28648140061b02e8a15f182215c0` | new (Phase 1b build) |

Newly deployed service contracts (deploy fresh, hash assigned at deploy):

- `AAPlatformRegistrar` — deploy with `data = core script hash` (authority
  `authorizedCore` = current core; admin = deploying sender; 7-day authority
  timelocks for core change, update, admin rotation).
- `AAPaymaster` / `AAAddressMarket` already exist as standalone contracts;
  Phase 1b moved the remaining core-side settlement halves to their manifests
  (`settleReimbursement` on paymaster, `abandonListing` on market).

## 2. Core ABI delta (candidate vs. the previously verified surfaces)

Live mainnet core: 90 raw manifest methods. Phase 1b candidate: 108 raw
manifest methods (`finalizeEscape` is overloaded, so unique names are 107).

Removed from the core (rotation now lives in the registrar service):

- `rotatePlatformAccountOwner` (removed)
- `proposePlatformAccountOwnerRotation` (removed)
- `confirmPlatformAccountOwnerRotation` (removed)
- `cancelPlatformAccountOwnerRotation` (removed)
- `getPendingPlatformAccountOwnerRotation` (removed)
- `getPlatformAccountOwnerRotationAvailableAt` (removed)

Added to the core (delegation + migration surface):

- `applyPlatformAccountOwnerRotation`
- `freezeAccount`, `unfreezeAccount`, `isAccountFrozen` (candidate ABI, not part of the pinned public artifact)
- `getPlatformAccountBinding`
- `setMarketService`, `isMarketService`
- `isUserOpExecutionActive`
- `migratePlatformOwnerRotations`

Registrar-owned replacements (on `AAPlatformRegistrar`):
`registerPlatformAccount`, `proposePlatformAccountOwnerRotation`,
`confirmPlatformAccountOwnerRotation`, `cancelPlatformAccountOwnerRotation`,
`getPendingPlatformOwnerRotation`, `getPlatformOwnerRotationAvailableAt` (not part of any
pinned core manifest; names live in the registrar source),
`ingestPendingPlatformOwnerRotation`, plus the authority surface
(`authorizedCore`, `setAuthorizedCore`, `proposeUpdate`, `confirmUpdate`,
`rotateAdmin`, …). Event display names are intentionally preserved across
the move (`PlatformOwnerRotationProposed` / `...Cancelled` now emit from the
registrar; `PlatformAccountOwnerRotated` still emits from the core) so
indexers keep continuity.

## 3. Orchestration order (testnet first)

1. Deploy `AAPlatformRegistrar` with `data = core hash`.
2. Propose + confirm the core V3 upgrade through the existing 7-day
   admin timelock (`scripts/upgrade_testnet_smart_account.js`, then mainnet).
3. Drive steps 3-5 with `scripts/migrate_smart_account_v3.js` (one phase per
   invocation; dry-run by default, `--execute` gated by
   `CONFIRM_AA_TESTNET_MIGRATION` + an admin WIF):
   - `--enroll-market` — core: `setMarketService(market, true)` for the bound
     `AAAddressMarket`.
   - `--propose-registrar` → 7-day timelock → `--confirm-registrar` to point the
     core at the new registrar (the confirm phase re-reads
     `getPlatformRegistrarAvailableAt` and refuses an unexpired timelock).
   - `--migrate-rotations --accounts <ids>` (or `AA_MIGRATION_ACCOUNTS_FILE`) —
     core: `migratePlatformOwnerRotations(accountIds)` in batches of 50:
     ingests legacy `0x20` pending-rotation rows plus their `0x1E` bindings into
     the registrar, then deletes the core keys (one-time, core-admin-gated;
     rides the upgrade window, records keep their original `InitiatedAt` so
     in-flight rotations cannot be re-armed).
4. Registrar authority: propose + confirm the `authorizedCore` change if the core hash
   itself ever rotates (not needed for an in-place `update`).
5. Re-read `getPlatformRegistrar`, `getPendingPlatformRegistrar`,
   `getPlatformAccountBinding` via RPC as post-conditions (the script performs
   these readbacks itself after each executed phase).

## 4. Downstream pin inventory (workspace grep of the two core hashes)

Authoritative source-side pinners (hand-maintained; update on evidence):

- `neo-os-aa` — already synced in Phase 1b:
  - `implementations/ordinary/profile.json` — `verifiedArtifact.coreHash`
    unchanged (hash survives `update`); `currentSourceCandidate.abiMethodCount`
    now 108.
  - `scripts/upgrade_testnet_smart_account.js` / `upgrade_mainnet_smart_account.js`
    — REQUIRED/REMOVED method lists match the new ABI; fail-closed candidate
    checks updated.
  - `scripts/neoexpress_validate.py` — `ARTIFACTS` now deploys the real
    `AAPlatformRegistrar` (data = core hash) instead of `PlatformRegistrarMock`;
    the platform-owner-rotation scenario asserts the registrar fault messages
    and preserved event names.
  - `scripts/verify-private-artifact-provenance.mjs` — `LOCAL_ARTIFACTS`
    swapped to `AAPlatformRegistrar.nef`.
  - `sdk/js` test fixtures (`ordinary-owner-only-candidate.manifest.json` and
    the `v3_testnet_*` suites) pin the **testnet address** for RPC readback —
    the address is unchanged, but method-level assertions on the removed
    rotation methods must ride the SDK's next fixture refresh.
- `neo-os-devpack` — `shared/constants/generated-miniapp-contracts.ts`,
  `generated-morpheus-registry.ts`, `generated-morpheus-runtime-catalog.ts`
  and `scripts/contract-registry-inputs.lock.json`: regenerate the catalogs
  from the registry inputs once the upgraded core evidence lands; the
  generated artifacts in `neo-os-web` and `neo-os-miniapps` flow from these.
- `neo-os-contracts` — `data/miniapp-manifests.json`: sync from the devpack
  registry output after regeneration.
- `neo-os-miniapps` — `apps/aa-account-lab/neo-manifest.json` +
  `NETWORK_STATUS.md` (and its `dist/`): update after testnet validation of
  the upgraded core.
- `neo-os-web` — `platform/host-app/public/miniapp-manifests.json`,
  `public/miniapp-definitions/aa-relay-console.json` and `.next/` build
  output: rebuild after the devpack catalogs update.
- `qa-artifacts/` — audit snapshots (`deployments/*.json`, `inventory.json`):
  regenerate on the next audit cycle; do not hand-edit.
- `neo-os-root` — greps clean for both hashes; no action.

Historical/dated material that intentionally stays untouched:

- `docs/reports/*` — dated receipts and evidence; new evidence goes into new
  dated reports.
- `docs/AA-MAINNET-UPGRADE-READINESS-*.md`, `PLUGIN_MATRIX.md`, etc. —
  historical docs; append updates, do not rewrite receipts.
- `formal/refinement` fixtures still reference `PlatformRegistrarMock` —
  the formal gate is explicitly out of Phase 1b scope per the plan; flagged
  for the formal-gate owner to re-run after the extraction lands.

Cross-track note (native lane): the native-edition commits (4b7d5f0, 06e99a4,
53a7eb9, f76ca3a) generate `implementations/native/core/SmartAccount/*` from
the AA true source under `contracts/` via `scripts/sync_native_smartaccount.py`
and gate CI on that sync. Phase 1b changed `contracts/SmartAccount*.cs`, so
once this work is committed the native sync must be re-run (and its pin
bumped) by the native-lane owner. No file overlap exists between the two
change sets.

## 5. Evidence cycles that must re-run before release

1. **Artifact reproducibility certificate** — the source snapshot changed,
   so `check-artifact-reproducibility` fails closed by design until a fresh
   certificate is produced; `verify-private-artifact-provenance.mjs` joins it
   to the new NeoExpress receipt (comment at the `LOCAL_ARTIFACTS` block
   marks this).
2. **NeoExpress private-chain receipt** — re-run
   `scripts/neoexpress_validate.py` end-to-end: the registrar now deploys as
   a real `needs_core` artifact, and the rotation scenario must produce a new
   dated `aa-neoexpress-validation` receipt.
3. **Pinned refinement offsets** — the four `ImplementationRefinement*`
   suites pin the candidate NEF hash and fee-helper offsets; they are
   current with the Phase 1b build and re-pin on any further source change.

## 6. Known environment-dependent script-test failures (Windows dev box)

`node --test scripts/*.test.mjs` shows 13 failures on this Windows machine;
12 are pre-existing environmental issues (the 13th — the mainnet candidate
count pin — was updated to 108 in Phase 1b and passes):

- `implementation_profiles.test.mjs` (3): `path.resolve(URL.pathname)`
  doubles the drive (`D:\D:\Git\...`) on Windows.
- `repo_hygiene.test.mjs` (1): git 2.56 `ls-files --cached --ignored`
  misreports tracked `docs/reports/**` as ignored; `git check-ignore`
  disagrees (not ignored).
- `check-artifact-reproducibility.test.mjs` (2): `path.relative` yields
  backslashes, breaking forward-slash artifact inventories; the scratch-copy
  exclusion then lets `contracts/bin` through.
- `verify-private-artifact-provenance.test.mjs` (1): same backslash
  inventory mismatch inside `verifyReleaseCertificate`.
- `check-ordinary-runtime-provenance.test.mjs` (3): child processes spawn
  `python` through the Windows Store alias (exit 9009).
- `verify_repo.test.mjs` (2): POSIX `/tmp` hardcoded where the test expects
  `os.tmpdir()`; and a CRLF workflow checkout breaks an LF-only regex in the
  native-browser-gate assertion (`.github/workflows` is a no-touch area).

None of these are caused by the Phase 1b edits; the Linux CI lane is the
authoritative gate for them.

## 7. Rollback

Each step is individually reversible within its timelock window:
`cancelPlatformRegistrar` (pre-confirm), `setMarketService(market, false)`,
`cancelUpdate` (pre-confirm), and registrar-side
`cancelAuthorizedCoreChange`. After `migratePlatformOwnerRotations` completes
it is one-way (core keys deleted); the registrar rows it wrote are the system
of record from that point on.

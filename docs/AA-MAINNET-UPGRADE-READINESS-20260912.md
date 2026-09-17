# Mainnet AA Upgrade Readiness (proxy-signer scope fix)

## Current status — 2026-09-15: mainnet upgrade confirmed

The existing AA core was upgraded in place. Two independent RPC nodes confirmed
the transaction's **Application HALT** and exact deployed script and manifest.

- Core: `0x0268a387913b250166ddec032b03332690a1ef78` (unchanged).
- Transaction: `0x8b93cf7c9b5fa3ac74ea7b12ebcf384ccce2ec8376220ea8a375541880de609a`.
- Block: `13245950`, `2026-09-15T10:02:24.044Z`; update counter: **4 → 5**.
- Administrator: `NR3E4D8NUXh3zhbf5ZkAp3rTxWbQqNih32`, canonical hash
  `0x6d0656f6dd91469db1c90cc1e574380613f43738`.
- Deployed NEF SHA-256: `c634ab9821c83bdb53b342d64359183cff2b917ac2dc5bdd9b57613494d09b4b`.
- Manifest SHA-256: `24c4710a8ac00a3df236d2a08509726dbe2745174abf833dd52e26d89b03b1b4`.
- NEF checksum: `2035992441`; 90 ABI entries / 89 distinct method names;
  `transferAdmin` is absent.
- System fee: **0.38820645 GAS**; network fee: **0.00800884 GAS**.
- Evidence: [transaction, Application logs, and independent readback](reports/mainnet-unified-smart-wallet-upgrade-20260915-evidence.json).

**Correction:** Earlier sections decoded little-endian RPC stack bytes as a
canonical script hash, producing the wrong `NVrSS…` address. The matching signing
key was already available locally. The conclusions that this administrator's key
was missing and that AA required replacement deployment were incorrect.

The first post-write comparison also treated the SDK's hex script as UTF-8;
correcting the decoder proved exact byte equality. The transaction was not
rebroadcast. Upgrade tooling now preserves the txid before confirmation/readback,
compares manifests structurally, and does not retry ambiguous broadcasts.

This proves this AA upgrade, not whole-system production readiness. Downstream
integration acceptance and artifact provenance checks remain independent gates.

## Historical preflight (superseded by the current status above)

The following notes record the earlier read-only preflight. Their live-state,
missing-key, administrator-address, and candidate claims are historical and must
not be used as current deployment instructions.

## Live State (read-only RPC, mainnet)

- Core: `0x0268a387913b250166ddec032b03332690a1ef78`, updateCounter 4.
- NEF SHA-256 `009b1b499a87dab1c17c5ed732717af294ae615fc05e1fc958fe712eb443c3ba`,
  NEF checksum `2765313802`, compiler `Neo.Compiler.CSharp 3.9.1+5fa9566e5165ede2165a9be1f4a0120c176...`.
- Upgrade route: `legacy_direct` - `update(nef, manifest)` exists and is gated by the
  contract admin witness alone. There is no propose/confirm timelock at this revision,
  so an upgrade takes effect in the same transaction that carries it.
- The live NEF is byte-identical to the repository artifact at commit
  `fa452d141013d6f7d44470b57a655b671df70331` (`contracts/build/UnifiedSmartWalletV3.nef`),
  whose checksum and manifest ABI/events/permissions/trusts also match the live contract.
  This is exact binary provenance, stronger than the ABI-proxy inference the shared
  preflight records by default.

## Candidate Artifact

Built from the current worktree with the canonical command:

```sh
cd neo-os-aa && INCLUDE_VALIDATION_MOCKS=1 bash contracts/compile.sh
```

- `contracts/bin/v3/UnifiedSmartWalletV3.nef` SHA-256
  `360f830f3f56731fabbab909865cbbe1c76dab6557412bbbc405393254d479b0`,
  NEF checksum `2875851451`.
- `contracts/bin/v3/UnifiedSmartWalletV3.manifest.json` SHA-256
  `8cacd63c82077f0419d30942e786cdc666f8968d6358c084847f35bc0b45b475`.

Blocking provenance caveat: the worktree is dirty, so this candidate is not pinned to a
commit. Pin it (commit the source plus the generated artifact) before broadcasting so the
deployed bytes can be regenerated and audited later.

## Compatibility (shared preflight plus source diff)

- ABI: 24 methods added; 1 removed (event count +10) (`transferAdmin(Hash160)`). No existing method
  signature changed. `finalizeEscape` keeps its 2-argument overload, so the Studio
  call path stays valid.
- Events: none removed or changed; 10 added, including `VerifyScopeTargetSet`, which now makes scope-target configuration auditable on chain.
- `transferAdmin` callers: none in `frontend/src` or `sdk/js/src`; only historical
  reports and the test that asserts its removal. Admin rotation moves to
  `proposeAdminTransfer`/`confirmAdminTransfer`.
- Storage: the only changed existing prefix is `Prefix_VerifyScopeTarget` `0x12` -> `0x1C`,
  and the candidate reads the legacy `0x12` key as a fallback while deleting it on the
  next write, so previously configured scope targets keep working. No unmigrated
  prefixes, no changed stored-record layouts, 10 added prefixes.
- Preflight classification: `conditional` / `semantic_proxy_only`. That label is the
  tool's conservative default for the 4-byte NEF checksum comparison; the SHA-256
  byte-identity check above removes the "unknown live binary" risk.

## Test Evidence

`dotnet test tests/AbstractAccount.Contracts.Tests/AbstractAccount.Contracts.Tests.csproj`
passes 234/234, including the fixed-artifact rejection test and the pinned
deployed-bytecode test that still reproduces the live bypass.

## Plan Run (executed, read-only)

```sh
node scripts/upgrade_mainnet_unified_smart_wallet.js
```

Recorded output (`docs/reports/mainnet-unified-smart-wallet-upgrade-latest.json`):

- network magic 860833102 verified; core `0x0268a387913b250166ddec032b03332690a1ef78`;
- live updateCounter 4, NEF checksum `2765313802`, 64 methods, no update timelock;
- candidate NEF SHA-256 matches the pinned release value and exposes all required methods;
- live admin `0x3837f413063874e5c10cc9b19d4691ddf656066d`, address
  `NVrSS9zXSxgB2DcsDPknffpyWQqwJM2rmq`. It is **not** a deployed contract, so a single
  account (or its multisig script) holds upgrade authority;
- `update` simulation with an unwitnessed signer FAULTs with `Not admin`, which is the
  expected authorization control: the deployed gate rejects unauthorized upgrades.
  An authorized HALT cannot be simulated without the admin's witness.

`chain_writes_performed: false`.

## Procedure for the Contract Admin

```sh
# 0. Confirm locally that your wallet controls NVrSS9zXSxgB2DcsDPknffpyWQqwJM2rmq.
#    If the key ever appeared in chat or a log, rotate it first and transfer the
#    AA admin to the new account through the governed flow.

# 1. Plan only (read-only; already run successfully).
node scripts/upgrade_mainnet_unified_smart_wallet.js

# 2. Broadcast with the admin key supplied through the environment only.
CONFIRM_AA_MAINNET_UPDATE=I_UNDERSTAND_THIS_WRITES_MAINNET \
AA_MAINNET_UPDATE_WIF='<admin key from a secure source>' \
  node scripts/upgrade_mainnet_unified_smart_wallet.js --execute
```

The execute path verifies the WIF resolves to the live admin, broadcasts `update`, then
reads the contract back and requires the deployed script bytes to equal the candidate
artifact byte-for-byte before reporting success. Because this revision has no upgrade
timelock, broadcast only after reviewing the plan output against this document.

## Remaining Work Before Enabling the Feature

1. (done in the candidate) `VerifyScopeTargetSet` is emitted whenever a scope target
   changes; confirm it appears in the post-upgrade application log during acceptance.
2. Re-run the same preflight for the Anchor/agents path and confirm no account carries
   a live scope target before/after the upgrade.
3. Commit a pinned artifact set and add the reproducibility gate described in
   `AA-RUNTIME-ARTIFACT-ALIGNMENT-20260912.md`.

## 2026-09-13 current preflight recheck

The mainnet preflight was rerun against `https://api.n3index.dev/mainnet` in plan mode after the candidate artifact and upgrade guard were refreshed.

- Live core: `0x0268a387913b250166ddec032b03332690a1ef78`.
- Live admin hash: `0x3837f413063874e5c10cc9b19d4691ddf656066d`.
- Live update counter: `4`; live NEF checksum: `2765313802`; live ABI method count: `64`.
- The live ABI still exposes `transferAdmin(Hash160)->Void` and has no update timelock.
- Candidate NEF SHA-256: `0xc634ab9821c83bdb53b342d64359183cff2b917ac2dc5bdd9b57613494d09b4b`.
- Candidate manifest SHA-256: `0x24c4710a8ac00a3df236d2a08509726dbe2745174abf833dd52e26d89b03b1b4`.
- Candidate ABI method count: `89`; `transferAdmin` is absent; the timelocked admin and upgrade methods are present.
- The update preview rejected an unwitnessed signer with `Not admin`, confirming the deployed authorization check. No chain write occurred.

The governed upgrade script now fails closed if a reviewed candidate contains any method in `REMOVED_METHODS`, currently including `transferAdmin`. The default release pin remains unchanged because this worktree is dirty; changing the pin to the current candidate without a reviewed commit would weaken provenance. The current candidate may be used only after its source and generated artifacts are committed and independently reviewed.

The mainnet write remains blocked by two independent conditions: the live core still needs the authorized upgrade, and no matching admin key was available in the execution environment. The preflight script verifies the supplied WIF against the live admin before it can broadcast, so an unrelated key cannot be used accidentally.

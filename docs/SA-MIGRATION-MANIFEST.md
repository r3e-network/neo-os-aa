# SA Migration Manifest — Legacy → Protocol v4 (Design)

This document specifies the **migration manifest**: the canonical, exportable,
per-account classification record that drives migration of existing Neo Smart
Account (SA) accounts from the legacy single-slot model (custom five-field
`0x01` AccountState / native 14-slot Array) to the shared module protocol
version 4 (`docs/SA-MODULE-PROTOCOL.md`).

Status: **design + manifest schema + idempotency rules; migration executor is a
later batch.** The re-deployment decision is confirmed: the new core, Market and
Paymaster deploy under new names (`SmartAccount`, `SAAddressMarket`,
`SAPaymaster`) at fresh addresses; legacy cores (mainnet `0x0268a387…`,
testnet `0xdbf38e7b…`) are migrated, never upgraded in place. Consequently the
"preserve manifest.name / coreHash" identity constraints of an in-place
upgrade do not apply to the *new* deployment; the legacy contracts are frozen
read-only sources for export.

## 1. Export pipeline (per design report §4.3)

1. Re-scan both networks before anything moves: every account, every legacy
   prefix row, the deployment artifacts. The scan produces the manifest.
2. Export per account: legacy state, root modules, children, threshold
   configuration, hook order, freeze/escape state, nonce cursors, Market
   markers, plugin code identity.
3. Classify (§2). Unknown/unresolvable plugins ⇒ `MigrationRequired`, never a
   guess.
4. New-core deployment happens first; no single transaction walks 53 mainnet /
   407 testnet accounts.
5. Every legacy account that had plugins enters `MigrationRequired` state on
   the new core: execution and message authorization are rejected, while
   queries, freeze and callback-free recovery remain reachable. No silent
   owner fallback.
6. Owner proposes a migration intent (24 h, the normal configuration timelock)
   with the exact new modules, instances, thresholds and hook order; custody
   confirms.
7. Import runs through the new `onInstall` lifecycle with the exact approved
   configuration; MultiHook unfolds in legacy forward order; MultiSig keeps
   its threshold as a core-owned policy.
8. On verified success the account atomically switches to `Active`; the
   manifest digest and legacy digest are recorded in `0x5A`.
9. Re-scan after migration: addresses, permissions, nonce, locks and results.

## 2. Classification

Every account gets exactly one primary class:

| Class | Meaning | Default path |
| --- | --- | --- |
| `no-plugin` | zero verifier, zero hook, no policy rows of any kind (a nonzero legacy hook is *not* "no policy") | bounded materialize to Active |
| `scalar-plugin` | one verifier and/or one hook, no children | direct install of renamed module(s) |
| `multihook` | MultiHook root with 0–8 child hooks | unfold children into core `hookOrder` in legacy forward order; MultiHook itself is not reinstalled |
| `multisig` | MultiSigVerifier root (≤10 children, threshold) | core-owned threshold policy; members installed as `thresholdMemberEligible` validators; member order preserved |
| `unknown-plugin` | any root/child whose contract hash is not in the approved v4 module set | `MigrationRequired`; no speculative mapping |
| `owner-only` | legacy permanent owner-only accounts (0x22 semantics) | migrate but the owner-only flag persists in 0x51 and keeps constraining the account |
| `market-locked` | live escrow/listing marker (0x06/0x07/0x1D) at export time | migrate account; 0x5D records the binding; Market settle/cancel revalidates epoch; owner escape writes 0x59 only |
| `recovery-pending` | pending escape/recovery at export time | finish or cancel on the legacy core first, then re-export; the new core never continues a legacy pending |

A legacy pending configuration/call is **not** an authorization source: it is
exported only as evidence and is dropped.

## 3. Manifest format

One JSON document per network (canonical JSON: sorted keys, no insignificant
whitespace; its SHA-256 is the `manifestDigest`). Schema skeleton:
`tests/fixtures/sa-module-protocol/migration-manifest.template.json`.

```json
{
  "manifestVersion": 1,
  "protocolVersion": 4,
  "network": 860833102,
  "legacyCoreHash": "…",
  "newCoreHash": "…",
  "exportedAt": 1765000000000,
  "scan": {
    "accounts": 407,
    "legacyPrefixRows": { "0x01": 407, "0x12": 84, "0x1C": 3 },
    "artifactDigest": "…"
  },
  "accounts": [
    {
      "accountId": "…",
      "accountAddress": "…",
      "classification": "multisig",
      "legacyState": {
        "verifier": "…", "hook": "…", "backupOwner": "…",
        "escapeTimelock": 86400, "escapeTriggeredAt": 0,
        "frozen": false, "ownerOnly": false,
        "pendingConfig": null, "pendingCalls": []
      },
      "legacyModules": [
        { "role": "verifier-root", "contractHash": "…",
          "contractId": 42, "updateCounter": 1, "nefSha256": "…",
          "children": [ { "contractHash": "…", "type": "verifier" } ] }
      ],
      "legacyThreshold": { "members": 10, "value": 3 },
      "legacyHookOrder": ["childHashA", "childHashB"],
      "legacyNonces": [ { "channel": "…", "cursor": 7 } ],
      "marketLock": { "listingId": 5, "escrowContract": "…" },
      "targetState": {
        "modules": [
          { "moduleId": 1, "type": 1, "contractHash": "…",
            "credentialGeneration": 1,
            "source": "legacy-verifier-root" }
        ],
        "hookOrder": [1],
        "thresholdPolicies": [
          { "policyId": 2, "threshold": 3, "memberIds": [1,2,3] }
        ],
        "recoveryTimelockMs": 604800000,
        "defaultPolicy": { "operation": "builtin", "message": "builtin" }
      },
      "idempotencyKey": "network:accountId:manifestDigest"
    }
  ]
}
```

Field rules:

- `legacyModules[].children` lists sub-module registrations (0x23/0x24 roots)
  — evidence only; children are never migrated as independent installs.
- `targetState` is the *proposed* v4 state computed by the classifier; the
  owner may amend it in the 24 h intent window; confirmation binds the exact
  final action digest.
- `moduleIds` in `targetState` are allocated fresh on the new core starting
  from 1, in a deterministic order (verifier roots first, then children in
  legacy order, then hooks in hookOrder order, then policy members).
- `credentialGeneration` starts at 1 for every imported instance; the legacy
  generation/nonce history is *not* carried into the new instance's
  credential space.
- `legacyNonces` feeds only the monotonic merge rule of protocol §6: new
  cursor = `max(legacy channel cursor, new 0x56 value)`, never a decrease.
- Accounts with `classification: unknown-plugin` carry `targetState: null`
  plus a `required` block listing what the owner must decide.

## 4. Idempotency requirements

- Re-submitting an identical `(accountId, manifestDigest)` migration intent
  is a no-op (not an error, not a second install).
- The manifest digest is stored under `0x5A` at import; any later intent for
  the same account must quote it. An import interrupted mid-way (transaction
  FAULT) leaves zero partial state (transaction atomicity) and the account
  remains `MigrationRequired`; retry re-runs the whole intent.
- Once `Active`, a repeat import is rejected unless it quotes the recorded
  digest *and* proposes an empty action set (proving no-op) — otherwise
  `SA_MIGRATION_REQUIRED`-style guards treat it as a normal configuration.
- Legacy data is never deleted by migration: 0x01 rows (custom) and the
  native 14-slot records stay as historical evidence on their contracts; the
  new core only records the invalidation declarations (0x12/0x1C) and
  digests in 0x5A.
- Old signatures, old pending intents, 0x12 rows and 0x1C rows are never
  authorization inputs on the new core (protocol §7.4).
- Stateful quotas / rate-limit history (DailyLimitHook etc.) are imported with
  their counters; an import failure keeps the account in `MigrationRequired`
  — history is never silently zeroed; the owner may explicitly choose a
  delayed re-set as a separate action.
- Contract custody message subjects require an explicit owner authorization
  during migration setup — never inferred from the custody address.

## 5. Acceptance evidence (per account)

1. Legacy export row matches an on-chain readback at migration time.
2. New account state matches `targetState` exactly (module count, ids, order,
   threshold, generations).
3. `authorityEpoch`/`configurationNonce` on the new core are ≥ legacy
   exported values where defined; nonce cursors never decreased.
4. A legacy-crafted signature/pending replay attempt against the new core
   fails (regression fixture, protocol §16.3).
5. Post-migration re-scan equality on both networks.

These become golden fixture entries in
`tests/fixtures/sa-module-protocol/golden-vectors/migration.template.json`
(kernel batches 39/40 fill the expected outputs).

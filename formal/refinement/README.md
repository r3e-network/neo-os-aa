# formal/refinement: method-level refinement material, not a current gate

This directory is a manually run evidence layer. Nothing here is executed by
`formal/verify.py`, by `python3 -m unittest discover -s formal` (discovery does
not enter this directory), by `scripts/verify_repo.sh` or by any workflow under
`.github/workflows/`. The formal gate that CI policy counts is `formal/verify.py`
(profile `native-current`). Whatever is produced here is **not current evidence**
for the native SmartAccount profile and closes none of the `openGates` in
`contracts/native/profile.json`; the open boundaries are listed in
`docs/SA-NATIVE-OPEN-BOUNDARIES.json`.

## What is in it

| Part | Target | Standing |
| --- | --- | --- |
| `prove.py`, `method_*.py`, `*_proofs.py`, `*_source.py`, `coq/` (37 `.v`), `fixtures/current-method-proof/`, `scenarios/`, `plugins/` | The retired custom SmartAccount kernel and its artifact `contracts/bin/public/SmartAccount.nef`. The method `SmartAccount.SmartAccount.CapReimbursementToActualCost(...)` that `prove.py` and `method_inventory.py` name no longer exists under `contracts/`. | Historical record of the method-level refinement scopes. It cannot be re-derived from the current tree. |
| `native_overlay_build.py`, `native_discovery_proofs.py`, `native_dispatch_proofs.py`, `native_export/`, `native-discovery/`, `native_codec_source.py`, `entrypoint_inventory.py`, `closure.py` | The native overlay built from the pinned core checkout (`NEOOS_NATIVE_CORE_SOURCE`). | Audit re-verification tools named in `docs/SMARTACCOUNT-AUDIT-HANDOFF.zh-CN.md`. They are run by hand on a reviewed host; no gate requires them. |
| `export/` | Typed source and NEF inventory (Roslyn exporter). | Project-agnostic inventory tool; its own README says the same. |
| `plugins/build-plugins.sh`, `plugins/provenance.json` | The plugin bytes that `scenarios/sa-account-plugins.json` deployed. | Recorded build step. It cannot be replayed: `contracts/plugins/verifiers` was renamed `contracts/plugins/validators` and has no `MultiSigVerifier` project, so the script now stops before building with a message that says so. The pinned hashes stay as the record. |

`docs/engineering/VERIFICATION-AND-GATES.md` does not describe this layer: none of
its material is part of the native v4.1 gate.

## Running its own checks

From the repository root, on a host with Coq (`coqc`, `coqchk`), .NET and the
mirrors the individual tests name:

```sh
python3 -m unittest discover -s formal/refinement -p 'test_*.py'
```

A missing tool is an error, never a simulated pass: without `coqc`/`coqchk` the
kernel-backed tests error out and the tests that need a mirror or a built
exporter skip by name. Nothing in CI runs this command.

## Why it is kept

`docs/SECURITY.md` and `docs/SA-SPEC.zh-CN.md`
cite the fixtures and receipts under this directory, and `.gitleaksignore`
carries fingerprints of files in it. Removing or rewriting a fixture changes
what those documents cite; do neither without updating them in the same change.

# Operations Manual

The protocol is in design and has no public deployment. Every procedure in this
book runs on a local tree, a local build or a private chain. A passing local run is
evidence for the source and artifacts it names, nothing more.

## Contents

1. [Local validation](#local-validation)
2. [Generated and pinned files](#generated-and-pinned-files)
3. [Evidence rules](#evidence-rules)

## Local validation

Run these from the repository root unless a different directory is named. A
change that touches a listed input must leave its check green.

| Check | Command | Covers |
| --- | --- | --- |
| Core unit tests (`neo-native-core`) | `dotnet test tests/Neo.UnitTests --filter "FullyQualifiedName~SmartAccount"` | The compiled native contract with its standard modules |
| Native profile CI | `python scripts/test_native_profile_ci.py` | The profile parameters, fixture manifest and core copy against the IDL |
| Module interface check | `python scripts/check_module_neps.py` | Named module interfaces against the NEP drafts |
| Repository checks | `bash scripts/verify_repo.sh` | Formatting, packaging and the contract test suites |
| JS SDK | `cd sdk/js && npm test` | Client encoding, routing and ABI guards |
| Frontend and docs | `cd frontend && npm test` | The workspace, generated help pages and the documentation guards |
| Formal verification (WSL) | `python3 formal/verify.py` | Bounded models and the source lock |

## Generated and pinned files

- **Fixture manifest.** `tests/fixtures/native-smartaccount.manifest.json` must
  equal the manifest the core emits. Regenerate it by running the core
  `UT_SmartAccount` tests with `SMARTACCOUNT_MANIFEST_FIXTURE=<output path>`, then
  copy the file with LF line endings to both `neo-os-aa` and `neo-native-core`.
- **Client mirror.** `frontend/src/shared/nativeSmartAccountClient.mjs` is a byte
  copy of `shared/nativeSmartAccountClient.mjs`.
- **Help pages.** The pages under `frontend/src/assets/docs/` are generated from
  the books in `docs/`. Run `node scripts/sync-frontend-docs.mjs` after editing a
  book; `--check` fails when a copy is stale.
- **Protocol parameter digest.** A change to
  `docs/proposals/smartaccount-native-profile-parameters.json` changes the
  parameter digest. Re-pin it in the core contract, its core copy, the IDL, both
  client copies, the fixture manifests and `formal/source-lock.json`, then
  regenerate the fixture.
- **Source lock.** `formal/source-lock.json` pins the reviewed sources. A change
  to a pinned file requires a re-pin and a matching update of the documentation
  guard that pins the lock's content digest.

## Evidence rules

- A receipt names the commit, artifacts and runtime it measured. It is never a
  statement about a later tree.
- A returned transaction ID means submitted. Confirmation requires reading back
  the transaction and its application result.
- A local or private-chain run proves nothing about a public network, and no
  public network is configured.

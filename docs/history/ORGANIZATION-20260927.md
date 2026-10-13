# Repository Organization

Repository: `neo-os-aa`

Verification snapshot: 2026-09-27. Baseline HEAD: `4b87010707c49e51020f03eec6f2ea1d16e89dbc`.
This document describes the tracked tree at that HEAD. Existing local untracked files are
outside its ownership.

## Purpose

`neo-os-aa` owns the Neo N3 account-abstraction security boundary. Its tracked README
describes UnifiedSmartWallet V3, verifier and hook plugins, the paymaster path, frontend
workflows, and the JavaScript SDK. The approved organization standard assigns AA
authorization to this repository as protocol component C03.

## Authority Boundaries (OWNS/NEVER OWNS)

### OWNS

- Account-abstraction contracts and their verifier, hook, recovery, market, and paymaster
  modules under `contracts/`.
- AA SDK and integration types under `sdk/` and `shared/`.
- The AA frontend and its local persistence and migration integration under `frontend/`
  and `supabase/`.
- Formal verification inputs and checks under `formal/`, AA-specific scripts under
  `scripts/`, and AA specifications, reports, and runbooks under `docs/`.

### NEVER OWNS

- Platform, application, or Oracle contract source; those belong to `neo-os-contracts`.
- NeoDID identity and eligibility authority; the approved standard assigns that boundary
  to `neo-os-did` (planned extraction where the repository is not present in this six-repo
  scope).
- Workspace registries or release/catalog writing, which belong to `neo-os-workspace` and
  `neo-os-admin` respectively.
- Service signer custody, network identity policy, or general service runtime, which belong
  to `neo-os-services`.

AA authorization may be composed with an eligibility proof supplied by another boundary;
that composition does not transfer DID ownership to AA.

## Directory Structure

The tracked production and verification roots are:

```text
contracts/       UnifiedSmartWallet and AA modules, verifiers, hooks, recovery, market, paymaster
frontend/        AA application and operator-facing routes
sdk/             JavaScript/TypeScript AA SDK
shared/          shared AA helpers and wire adapters
formal/          formal verification sources and runners
supabase/        AA application migration and test resources
scripts/         build, validation, deployment helpers, and gates
docs/            protocol, security, validation, reports, and runbooks
tests/           repository-level tests
```

The exact tracked tree is defined by `git ls-tree -r HEAD`. In particular, `contracts/build/`
contains tracked NEF and manifest fixtures used by AA verification, while local `bin/` and
`obj/` output is not part of this documented source tree.

## File Organization Rules

- Put AA contract source in the relevant `contracts/` security-boundary subdirectory.
- Keep verifier and hook implementations next to their AA contract interfaces and preserve
  their artifact and ABI provenance in the existing reports and build paths.
- Keep frontend application code in `frontend/`, SDK code in `sdk/`, and shared protocol
  helpers in `shared/`.
- Keep formal obligations and source locks under `formal/`; keep runbooks and audit evidence
  under `docs/` using the existing topic/report namespaces.
- Keep database migrations in the existing `supabase/migrations/` domain path until a
  separately reviewed domain migration plan changes it.
- Do not add platform contract source, copied SDK implementations, untracked credentials,
  or local build output. Do not perform directory moves in documentation work.

## Cross-Repository Dependencies

- `neo-os-devpack` supplies versioned app-facing SDK packages; AA consumers should use a
  reviewed package or pin rather than copying DevPack source.
- `neo-os-contracts` is the approved owner of platform/app/Oracle contract source. AA may
  consume platform artifacts and integration interfaces where the AA protocol requires them.
- `neo-os-services` supplies service catalogs and runtime integration projections; the AA
  README records generated Morpheus config as sourced from that repository.
- `neo-os-workspace` is the approved future owner of registries and gates; current enforced
  architecture references still live in `neo-os-web` until v2 adoption.
- The local remotes are named `origin` and `rustforneo`; workspace policy designates
  `origin` as r3e-network canonical and `rustforneo` as the CI mirror. Exact URLs are not
  reproduced in this document.

## Maintenance Guidelines

- Review AA changes against the boundary statements in `README.md`, the relevant protocol
  document, and the exact artifact/source checks before describing a release as ready.
- Keep deployed addresses, generated registries, and validation reports tied to their source
  commit and network; a local build alone is not deployment evidence.
- Preserve existing testnet/mainnet safety gates and keep signing material out of source,
  logs, reports, and documentation.
- Mark planned consolidation or extraction as planned until a tracked migration and its
  dependent checks are actually completed.
- Preserve unrelated working-tree changes and update only this file for organization work.

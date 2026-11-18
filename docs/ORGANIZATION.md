# Repository Organization

Updated for the ordinary/native layout on 2026-10-13. The earlier 2026-09-27
organization snapshot was deleted with the pre-deployment compatibility surfaces,
so this file is the only tracked layout statement; the current layout and ownership
rules are below.

## Purpose

neo-os-aa is the NeoOS account-abstraction repository. It contains the
Neo N3 SA contracts, frontend tooling, and SDK surfaces for creating and using
Smart Accounts.

## Authority Boundaries

- This repo OWNS: SA user operations, verifier and hook plugin bindings,
  recovery policy, paymaster policy, SA contract behavior, and SA-specific
  frontend and SDK integration.
- This repo NEVER OWNS: DID eligibility or identity issuance, network identity
  selection, signer custody, catalog publication, MiniApp product behavior, or
  production deployment state.

## Directory Structure

    implementations/ordinary/ user-contract delivery profile and entrypoint
    implementations/native/   native ABI 2 submission profile and entrypoint
    .github/                 CI workflows
    contracts/               Neo N3 SA contract sources
    formal/                  formal verification inputs and checks
    frontend/                SA application and server routes
    sdk/                     SA SDK surfaces
    shared/                  shared SA types and helpers
    supabase/                SA database migrations
    tests/                   test suites
    scripts/                 repository tooling
    docs/                    project documentation
    SmartAccount.sln .NET solution
    README.md                public project and boundary documentation

`implementations/ordinary/` and `implementations/native/` are the two
implementation entrypoints on the same branch. They intentionally point at
the existing build-compatible source locations through `profile.json`; source
files are not duplicated. The ordinary profile is the current user-contract
delivery path. The native profile contains the native modules, SDK and UI
profile prepared for standard submission, while the consensus
`SmartAccount` service remains in the matching Neo core repository.

## File Organization Rules

- Keep contract sources and contract-specific checks under contracts/.
- Keep third-party plugin starting points under contracts/templates/; templates
  compile against the shared plugin layer (contracts/verifiers/Verifier*.cs,
  contracts/hooks/HookAuthority.cs) and scripts/check_plugin_templates.mjs keeps
  their manifests aligned with the core's bind-time ABI gate.
- Use `implementations/ordinary/profile.json` and
  `implementations/native/profile.json` to select the implementation profile;
  do not infer profile identity from a deployment label or a shared artifact
  directory.
- Keep native-only modules and client code under the native roots listed by
  `implementations/native/profile.json`; ordinary source must not import native
  entrypoints as proof of native activation.
- Keep frontend routes, UI, and frontend configuration under frontend/.
- Keep SA client types and builders under sdk/ and shared/.
- Keep formal evidence and verification inputs under formal/.
- Keep database migrations under supabase/migrations/ and apply them only
  through the repository's documented migration process.
- Do not commit credentials, local environment files, build output, or
  unrelated MiniGame content.

## Cross-Repository Dependencies

- neo-os-contracts owns platform/app/Oracle contract source, while this repository
  owns SA contract source. SA consumes reviewed artifacts and interfaces.
- neo-os-devpack supplies versioned SDK packages; consumers use reviewed pins
  instead of copying its implementation.
- neo-os-workspace and neo-os-admin own workspace registries and release/catalog
  publication respectively; SA integration does not transfer these authorities.

- neo-os-web owns the current architecture contract until the documented v2
  adoption completes. neo-os-services is the source for the public Morpheus
  registry, public runtime catalog, and confidential-envelope inputs that SA
  synchronizes through `scripts/lib/morpheus-canonical-sync.mjs`.
- neo-os-did owns DID identity and eligibility; SA may consume a verified
  eligibility proof but does not make identity decisions.
- neo-os-services supplies service-side integrations and generated registry
  inputs where the repository contracts require them.
- contracts/neo-platform-packages.json records the contract build's package
  provenance. Package availability is a build-environment prerequisite; this
  repository remains authoritative for SA contract sources and does not assign
  contract authority to another repository.

## Maintenance Guidelines

1. Route new integrations through the centralized SA operation and validation
   surfaces so authorization and execution remain distinct.
2. Keep relay and paymaster paths as convenience or funding layers; they must
   not replace on-chain authorization.
3. Run the affected contract, frontend, formal, migration, and test checks
   before committing.
4. Review generated contract artifacts and deployment references for exact
   source parity.
5. Use conventional commits and keep production, chain, and cloud writes out of
   repository validation.

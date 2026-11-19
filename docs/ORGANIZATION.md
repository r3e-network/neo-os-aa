# Repository Organization

Updated on 2026-11-18 for the three-directory contract layout
(`contracts/custom`, `contracts/native`, `contracts/plugins`), which replaced the
2026-10-13 `implementations/` entrypoints. The earlier 2026-09-27 organization
snapshot was deleted with the pre-deployment compatibility surfaces, so this file
is the only tracked layout statement; the current layout and ownership rules are
below.

## Purpose

neo-os-sa is the NeoOS account-abstraction repository. It contains the
Neo N3 SA contracts, frontend tooling, and SDK surfaces for creating and using
Smart Accounts.

## Authority Boundaries

- This repo OWNS: SA user operations, validator and hook module bindings,
  recovery policy, paymaster policy, SA contract behavior, and SA-specific
  frontend and SDK integration.
- This repo NEVER OWNS: DID eligibility or identity issuance, network identity
  selection, signer custody, catalog publication, MiniApp product behavior, or
  production deployment state.

## Directory Structure

    contracts/               Neo N3 SA contract sources
      custom/                user-contract (custom) implementation
        market/              SAAddressMarket escrow contract
        paymaster/           SAPaymaster contract
        registrar/           SAPlatformRegistrar contract
      native/                native ABI 2 implementation
        SmartAccount/        true source of the consensus SmartAccount service
        Runtime/             runtime overlay compiled with it
      plugins/               module contracts shared by both implementations
        validators/          validator modules
        hooks/               hook modules
        recovery/            social-recovery service and action-session validator
        templates/           third-party module starting points
        native-profile/      native-profile builds of the shared modules
      build/                 pinned artifacts of the public deployments
      compile.sh             builds every contract into contracts/bin/ (ignored)
    tests/                   test suites
      mocks/                 mock contracts the suites deploy
    formal/                  formal verification inputs and checks
    frontend/                SA application and server routes
    sdk/                     SA SDK surfaces
    shared/                  shared SA types and helpers
    supabase/                SA database migrations
    scripts/                 repository tooling
    docs/                    project documentation
    .github/                 CI workflows
    SmartAccount.sln         .NET solution
    README.md                public project and boundary documentation

`contracts/custom/` and `contracts/native/` hold the two implementations on
the same branch; `contracts/plugins/` holds the validator and hook modules
both of them install. Each implementation directory carries a `profile.json` that
names its source roots, artifacts and verification commands; source files are
not duplicated. The custom profile (`contracts/custom/`) is the current
user-contract delivery path. The native profile (`contracts/native/`) holds the
true source of the consensus `SmartAccount` service prepared for standard
submission; the matching Neo core repository carries generated copies of it and
owns native VM enforcement.

## File Organization Rules

- Keep contract sources and contract-specific checks under contracts/, in
  exactly one of custom/, native/ or plugins/. A contract only one
  implementation uses belongs to that implementation; a module both can install
  belongs to plugins/.
- Keep mock and probe contracts under tests/mocks/; they are test fixtures, not
  part of either implementation.
- Keep third-party module starting points under contracts/plugins/templates/; templates
  compile against the shared module layer (contracts/plugins/validators/ValidatorAuthority.cs,
  contracts/plugins/hooks/HookAuthority.cs) and scripts/check_plugin_templates.mjs keeps
  their manifests aligned with the core's install-time ABI gate.
- Use `contracts/custom/profile.json` and
  `contracts/native/profile.json` to select the implementation profile;
  do not infer profile identity from a deployment label or a shared artifact
  directory.
- Keep native-only modules and client code under the native roots listed by
  `contracts/native/profile.json`; custom source must not import native
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

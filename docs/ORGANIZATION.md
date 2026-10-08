# Repository Organization

## Purpose

neo-os-aa is the NeoOS account-abstraction repository. It contains the
Neo N3 AA contracts, frontend tooling, and SDK surfaces for creating and using
Abstract Accounts.

## Authority Boundaries

- This repo OWNS: AA user operations, verifier and hook plugin bindings,
  recovery policy, paymaster policy, AA contract behavior, and AA-specific
  frontend and SDK integration.
- This repo NEVER OWNS: DID eligibility or identity issuance, network identity
  selection, signer custody, catalog publication, MiniApp product behavior, or
  production deployment state.

## Directory Structure

    .github/                 CI workflows
    contracts/               Neo N3 AA contract sources
    formal/                  formal verification inputs and checks
    frontend/                AA application and server routes
    sdk/                     AA SDK surfaces
    shared/                  shared AA types and helpers
    supabase/                AA database migrations
    tests/                   test suites
    scripts/                 repository tooling
    docs/                    project documentation
    neo-abstract-account.sln .NET solution
    README.md                public project and boundary documentation

## File Organization Rules

- Keep contract sources and contract-specific checks under contracts/.
- Keep frontend routes, UI, and frontend configuration under frontend/.
- Keep AA client types and builders under sdk/ and shared/.
- Keep formal evidence and verification inputs under formal/.
- Keep database migrations under supabase/migrations/ and apply them only
  through the repository's documented migration process.
- Do not commit credentials, local environment files, build output, or
  unrelated MiniGame content.

## Cross-Repository Dependencies

- neo-os-web owns the current architecture contract until the documented v2
  adoption completes. neo-os-services is the source for the public Morpheus
  registry, public runtime catalog, and confidential-envelope inputs that AA
  synchronizes through `scripts/lib/morpheus-canonical-sync.mjs`.
- neo-os-did owns DID identity and eligibility; AA may consume a verified
  eligibility proof but does not make identity decisions.
- neo-os-services supplies service-side integrations and generated registry
  inputs where the repository contracts require them.
- contracts/neo-platform-packages.json records the contract build's package
  provenance. Package availability is a build-environment prerequisite; this
  repository remains authoritative for AA contract sources and does not assign
  contract authority to another repository.

## Maintenance Guidelines

1. Route new integrations through the centralized AA operation and validation
   surfaces so authorization and execution remain distinct.
2. Keep relay and paymaster paths as convenience or funding layers; they must
   not replace on-chain authorization.
3. Run the affected contract, frontend, formal, migration, and test checks
   before committing.
4. Review generated contract artifacts and deployment references for exact
   source parity.
5. Use conventional commits and keep production, chain, and cloud writes out of
   repository validation.

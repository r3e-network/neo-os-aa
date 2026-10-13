# Parallel smart-account implementations

The project develops one smart-account protocol through two implementation paths.
The deployed-contract path is the immediate delivery priority for NeoOS. The
native path develops the standard and node integration in parallel. A native
activation schedule must not prevent current NeoOS account functionality.

## Protocol and implementation responsibilities

Protocol rules describe authorization, execution ordering, replay protection,
account lifecycle, recovery, failure outcomes and fee responsibility. Each runtime
profile specifies its exact identity, serialization, entrypoints and enforcement
capabilities. A reference implementation validates the rules it actually
implements; passing its tests is not acceptance of a Neo standard.

| Path | Starting implementation | Delivery boundary |
| --- | --- | --- |
| Deployed contract | `UnifiedSmartWalletV3`, its public `v3` modules, `AbstractAccountClient` and app | Deployable on the published Neo N3 runtime after artifact, integration and release validation |
| Native service | `AccountManagement`, native ABI 2 modules, `NativeSmartAccountClient` and `/native` | Matching node implementation, protocol review and hardfork activation |
| Runtime experiments | Private `PLATFORM` build | Research and controlled validation only; not a third public product |

Existing V3 is the operational starting point for the deployed-contract path,
not a claim that its current ABI already conforms to every native draft rule.
Evolution must preserve existing users or introduce an explicit new version and
migration. Do not overwrite a deployed account's meaning by changing an endpoint,
core hash, build symbol or display label.

## Common semantics and explicit differences

Both paths must specify and test the following: deterministic account discovery;
separate authorization and fee payment; typed operation commitments; nonce and
deadline checks; ordered verifier, hook and target execution; atomic application
rollback; confirmation distinct from submission; module changes; recovery; and
the difference between a VM fault and a successful call returning `false`.

Cross-implementation cases compare these semantic outcomes through explicit
profile adapters. Byte-level vectors remain profile-specific until the same
encoding has been implemented and verified on both paths. In particular:

| Boundary | Public deployed V3 | Native ABI 2 |
| --- | --- | --- |
| Availability | Ordinary deployment and matching modules | Consensus activation of the service |
| Account and asset identity | V3 account registration and proxy script | Native account derivation and canonical native proxy script |
| Operation authorization | V3 verifier-specific signatures and witness rules | Native service/network/account/epoch/configuration commitment |
| Callback resources | Transaction budget and reviewed module behavior; no isolated child budget | Platform-enforced verifier, hook and maintenance child budgets |
| Recovery | Backup-owner escape with timelock and checked old-module cleanup | Independent custody recovery revokes old modules through the authority epoch |
| Sponsored fees | Existing constrained paymaster and relay flows | External transaction payer; no native reimbursement paymaster in ABI 2 |
| Service changes | Contract deployment/update authority and documented version migration | Protocol governance and hardfork migration |

The public runtime cannot reproduce a non-bypassable child execution budget using
a contract convention. Do not weaken or remove the native requirement to claim
equivalence. Improve the deployed profile within its runtime capabilities and
state remaining restrictions in the SDK, UI and integration contract.

## Current delivery sequence

1. Verify the deployed-contract baseline and exact NeoOS integration surface:
   account creation and discovery, supported authorization, proxy asset transfer,
   fee payment, persisted receipts and backup-owner recovery.
2. Remove product and integration gaps in that path. Use published Neo packages,
   isolated test deployments and explicit account/network/core identity checks.
   Keep optional modules and sponsorship behind their own verified prerequisites.
3. Maintain a capability and conformance matrix for both implementations. Every
   semantic change identifies affected profiles, expected outcomes and migration
   implications; profile-specific improvements are labelled as such.
4. Continue native correctness, resource accounting, modules, SDK and proposal
   review independently. Ordinary deployment is neither native activation nor
   permission to advertise the draft as an adopted standard.

## Release and migration

Each implementation needs its own pinned source, reproducible artifacts, tests,
deployment identity and post-deployment readback. Local tests and historical
receipts do not prove that the current public deployment contains reviewed code.
Public deployment, administrator updates and user wallet signatures remain
separate operational actions.

Moving to native accounts is an explicit opt-in migration. Account IDs, proxy
addresses, balances, allowances, plugin settings and signatures must not be
assumed portable. Preserve the old path until each user's assets and operational
dependencies have been verified on the destination. ABI 2 currently has no
automatic legacy import endpoint.

See [capability boundaries](AA-SYSTEM-STATUS.md), the
[V3 architecture](AA_V3_ARCHITECTURE.en.md), the
[native architecture](NATIVE_SYSTEM_ARCHITECTURE.md), and
[issue #242](https://github.com/neo-project/proposals/issues/242) for the current
implementation and protocol-review scopes.

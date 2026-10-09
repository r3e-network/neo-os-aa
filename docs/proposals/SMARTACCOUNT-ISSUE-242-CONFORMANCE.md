# Native SmartAccount issue 242 conformance map

Review date: 2026-10-09. This map follows [issue #242](https://github.com/neo-project/proposals/issues/242), including its six required sections and six acceptance criteria. It describes a draft review candidate, not an adopted standard or permission to activate a public network.

The normative documents are the [native ABI 2 profile](SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md) and the [deployment-independent foundation](nep-aa-entry-verifier.mediawiki). Identity derivation remains version 1. The profile parameter digest is unchanged by these clarifications.

## Required sections

| Issue requirement | Normative coverage | Implementation and evidence | Boundary |
| --- | --- | --- | --- |
| Native identity and activation | Profile §§3–5, §13; canonical parameters and vectors | Core `SmartAccountProtocol`, `AccountManagement.Initialize`; tests `NativeIdentityActivationAndRequiredAbiAreStable`, `InitializationStoresProfileOnlyAtItsActivation`, `NativeIdentityAndPublishedAccountVectorMatch` | Missing activation disables the service. An ordinary deployed contract cannot activate it. Network configuration and protocol approval remain pending. |
| Account and module state | §§6–8, including authority epoch, configuration nonce, freeze, recovery and composition registry | Core `SmartAccountState`, `SmartAccountModulePolicy`, `AccountManagement.Keys/Modules`; actual lifecycle/recovery/configuration suites in the [iteration receipt](../reports/aa-consistency-iteration-20261009.md) | Custody, execution, configuration, recovery and service governance remain distinct. Recovery revokes old module authority without calling the old modules. |
| UserOperation semantics | §9 plus foundation canonical field order, nonce channels, callback order, batch rollback and reentrancy rules | Core `AccountManagement.Execution`, `SmartAccountEnvelope`; SDK codec vectors; actual transaction-commitment and new chain-clock regressions | Both scalar descriptors remain mandatory on every native verifier; composite execution uses its additional receipt callbacks. Boolean `false` is not automatically a VM fault; applicable module or client policy may reject it. |
| Resource and fee accounting | §§3,10; explicit callback budgets, ancestor inheritance, sponsor and failure semantics | Bounded-call prerequisite [#4759](https://github.com/neo-project/neo/pull/4759); native callback probes and fee-aware RPC preflight evidence | Exhaustion faults atomically; transaction fees may still be charged. Measurements cover the recorded modules and fee policy, not arbitrary plugin liveness. |
| Witness and address compatibility | §§5,9.1–9.3,12,14 | Fixed proxy script/address vectors; actual signed single/batch proxy verification and Application replay; typed RPC/SDK manifests | Verification uses persisted chain time; Application uses its executing block. A successful preflight reserves neither nonce nor inclusion. Script changes require explicit address migration. |
| Governance and migration | §§7,11,12,15 | Old 13-field state, ABI 1 modules and obsolete two-argument execution are rejected by core tests | ABI 2 is an unactivated draft revision. There is no legacy import method, registry, event, implicit custody or native-state conversion. Any adapter or prior experimental state migration needs its own specification, vectors and review. |

## Acceptance criteria and evidence limits

1. **Normative state and transitions:** the profile specifies the account record and all current entrypoints. The cross-repository audit matched all **39 methods and 16 events**, including ordered parameter names/types, return types and safe flags, to core. Discovery must reject a missing or malformed required member rather than infer compatibility from the digest alone.
2. **Canonical vectors:** the [parameter file](smartaccount-native-profile-v2-parameters.json), [vector file](smartaccount-native-profile-v2-vectors.json) and validators cover native identity, address, nonce, authorization and witness encodings. Existing C# and JavaScript checks are implementation evidence; they do not establish acceptance by two independently maintained consensus clients.
3. **Resources and fees:** fixed verifier/hook bounds, ancestor charging, whitelist behavior, exhaustion and transaction fee effects are specified. Private execution and preflight receipts remain pinned to their actual source/artifact versions; later test-only or documentation changes do not rewrite those receipts.
4. **Authority, governance, recovery and migration:** account-level controls cannot upgrade the native service. Public activation and any state conversion require explicit network governance. Registering a native identity leaves legacy assets under their original witness rules.
5. **Cross-client and failure conformance:** §14 specifies required vectors and rollback cases. The new clock tests cover equality, one-millisecond expiry, missing ledger header, single/batch proxy verification and the same signed bytes at successive Application times. Full independent-client conformance, full compiler/VM refinement and arbitrary third-party module correctness are not claimed.
6. **Compatibility:** [#218](https://github.com/neo-project/proposals/pull/218) is the generic witness proposal; [#243](https://github.com/neo-project/proposals/pull/243) is the deployment-independent foundation; #242 adds native identity, state, resources and governance. Closed proposals [#219](https://github.com/neo-project/proposals/pull/219) and [#220](https://github.com/neo-project/proposals/pull/220) describe optional extensions and are not adopted dependencies. The native proxy is a narrower profile of the witness mechanism, not a merger of these layers.

## Corrections from this review

- Clarify mandatory scalar compatibility descriptors and composite callback dispatch without weakening module admission.
- Define chain milliseconds, the persisted/executing time distinction, inclusive deadline/maturity boundaries and fail-closed missing-header behavior.
- Remove the implication that native legacy import or automatic ABI 1 state conversion exists.
- Separate protocol-review completeness from public-activation approval.
- Validate the complete required ABI during SDK discovery, including events, and preserve nested native metadata through REST serialization.

Current implementation review is coordinated through [core #4768](https://github.com/neo-project/neo/pull/4768), [RPC #1115](https://github.com/neo-project/neo-node/pull/1115) and [foundation #243](https://github.com/neo-project/proposals/pull/243). Upstream review and public-activation gates remain open. Historical issue comments and pinned runtime receipts describe their original checkpoints and must not be read as current deployment claims.

The [2026-10-09 validation receipt](../reports/aa-issue-242-conformance-20261009.json) records the source pins, new regression cases and verification counts for this review.

## Lifecycle and usability follow-up

The [protocol audit receipt](../reports/aa-native-protocol-review-20261009.json)
tracks the subsequent client and workspace review. It separates permissionless
account-level activation from custody-authorized module-policy activation, binds
module cancellation reviews to their exact pending intent, and documents the
user's authority and timing choices in the [account guide](../NATIVE_ACCOUNT_USER_GUIDE.md).

One protocol boundary remains unresolved: using a native account's proxy as
another account's custody or recovery authority. Source review indicates that
the nested account lock may make that authority unusable; executable
confirmation is still unavailable. Do not treat nested-account authority as a
supported recovery arrangement or this audit as complete protocol clearance.
Resolving that boundary must preserve the specified target-frame witness
isolation and receive the corresponding native-protocol review.

# Native SmartAccount issue 242 conformance map

Review baseline: 2026-10-09; authority-admission correction: 2026-10-14. This map follows [issue #242](https://github.com/neo-project/proposals/issues/242), including its six required sections and six acceptance criteria. It describes a draft review candidate, not an adopted standard or permission to activate a public network.

The normative documents are the [native ABI 2 profile](SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md) and the [deployment-independent foundation](nep-smartaccount-entry-verifier.mediawiki). Identity derivation remains version 1. Authority admission now requires recipient consent and rejects registered proxy authorities. This changes draft consensus behavior without changing ABI methods, state layout, identity derivation or parameter constants. The unchanged parameter digest does not identify this source revision or prove compatibility with earlier experimental state.

The foundation supports parallel ordinary-contract and native implementations.
An ordinary implementation can validate shared protocol behavior and serve
applications under its own deployment profile. This map evaluates the native
profile specifically; its consensus activation, VM-enforced callback budgets
and witness restrictions are not inferred from ordinary-contract execution.

## Required sections

| Issue requirement | Normative coverage | Implementation and evidence | Boundary |
| --- | --- | --- | --- |
| Native identity and activation | Profile §§3–5, §13; canonical parameters and vectors | Core `SmartAccountProtocol`, `SmartAccount.Initialize`; tests `NativeIdentityActivationAndRequiredAbiAreStable`, `InitializationStoresProfileOnlyAtItsActivation`, `NativeIdentityAndPublishedAccountVectorMatch` | Missing activation disables the service. An ordinary deployed contract cannot activate it. Network configuration and protocol approval remain pending. |
| Account and module state | §§6–8, including authority admission, authority epoch, configuration nonce, freeze, recovery and composition registry | Core `SmartAccountState`, `SmartAccount.ReadState/Save`, `SmartAccountModulePolicy`, `SmartAccount.Keys/Modules`; historical lifecycle/recovery/configuration suites in the [iteration receipt](../reports/sa-consistency-iteration-20261009.md), with the admission correction described below | Newly introduced authority recipients must consent; current and pending registered proxies are excluded. Custody, execution, configuration, recovery and service governance remain distinct. Recovery revokes old module authority without calling the old modules. |
| UserOperation semantics | §9 plus foundation canonical field order, nonce channels, callback order, batch rollback and reentrancy rules | Core `SmartAccount.Execution`, `SmartAccountEnvelope`; SDK codec vectors; actual transaction-commitment and new chain-clock regressions | Both scalar descriptors remain mandatory on every native verifier; composite execution uses its additional receipt callbacks. Boolean `false` is not automatically a VM fault; applicable module or client policy may reject it. |
| Resource and fee accounting | §§3,10; explicit callback budgets, ancestor inheritance, sponsor and failure semantics | Bounded-call prerequisite [#4759](https://github.com/neo-project/neo/pull/4759); native callback probes and fee-aware RPC preflight evidence | Exhaustion faults atomically; transaction fees may still be charged. Measurements cover the recorded modules and fee policy, not arbitrary plugin liveness. |
| Witness and address compatibility | §§5,9.1–9.3,12,14 | Fixed proxy script/address vectors; actual signed single/batch proxy verification and Application replay; typed RPC/SDK manifests | Verification uses persisted chain time; Application uses its executing block. A successful preflight reserves neither nonce nor inclusion. Script changes require explicit address migration. |
| Governance and migration | §§7,11,12,15 | Old 13-field state, ABI 1 modules and obsolete two-argument execution are rejected by core tests | ABI 2 is an unactivated draft revision. There is no legacy import method, registry, event, implicit custody or native-state conversion. Any adapter or prior experimental state migration needs its own specification, vectors and review. |

## Acceptance criteria and evidence limits

1. **Normative state and transitions:** the profile specifies the account record and all current entrypoints. The cross-repository audit matched all **39 methods and 16 events**, including ordered parameter names/types, return types and safe flags, to core. Discovery must reject a missing or malformed required member rather than infer compatibility from the digest alone.
2. **Canonical vectors:** the [parameter file](smartaccount-native-profile-v2-parameters.json), [vector file](smartaccount-native-profile-v2-vectors.json) and validators cover native identity, address, nonce, authorization and witness encodings. Existing C# and JavaScript checks are implementation evidence; they do not establish acceptance by two independently maintained consensus clients.
3. **Resources and fees:** fixed verifier/hook bounds, ancestor charging, whitelist behavior, exhaustion and transaction fee effects are specified. Private execution and preflight receipts remain pinned to their actual source/artifact versions; later test-only or documentation changes do not rewrite those receipts.
4. **Authority, governance, recovery and migration:** account-level controls cannot upgrade the native contract. Public activation and any state conversion require explicit network governance. Registering a native identity leaves legacy assets under their original witness rules.
5. **Cross-client and failure conformance:** §14 specifies required vectors and rollback cases. The new clock tests cover equality, one-millisecond expiry, missing ledger header, single/batch proxy verification and the same signed bytes at successive Application times. Full independent-client conformance, full compiler/VM refinement and arbitrary third-party module correctness are not claimed.
6. **Compatibility:** [#218](https://github.com/neo-project/proposals/pull/218) is the generic witness proposal; [#243](https://github.com/neo-project/proposals/pull/243) is the deployment-independent foundation; #242 adds native identity, state, resources and governance. Closed proposals [#219](https://github.com/neo-project/proposals/pull/219) and [#220](https://github.com/neo-project/proposals/pull/220) describe optional extensions and are not adopted dependencies. The native proxy is a narrower profile of the witness mechanism, not a merger of these layers.

## Corrections from this review

- Clarify mandatory scalar compatibility descriptors and composite callback dispatch without weakening module admission.
- Define chain milliseconds, the persisted/executing time distinction, inclusive deadline/maturity boundaries and fail-closed missing-header behavior.
- Remove the implication that native legacy import or automatic ABI 1 state conversion exists.
- Separate protocol-review completeness from public-activation approval.
- Validate the complete required ABI during SDK discovery, including events, and preserve nested native metadata through REST serialization.
- Document the existing native target-result serializer separately from argument encoding: supported VM types, runtime size/item bounds, repeated-reference rejection and atomic failure. Profile §9.4 explains current behavior without changing the ABI or parameter digest; it does not assign those implementation limits to an ordinary-contract profile.
- Require admission witnesses for newly introduced custody/recovery recipients and reject registered proxies in every current or pending authority slot. Preserve permissionless mature transitions and prohibit reverse reservations that would let third parties block future registration.

Current implementation review is coordinated through [core #4768](https://github.com/neo-project/neo/pull/4768), [RPC #1115](https://github.com/neo-project/neo-node/pull/1115) and [foundation #243](https://github.com/neo-project/proposals/pull/243). Upstream review and public-activation gates remain open. Historical issue comments and pinned runtime receipts describe their original checkpoints and must not be read as current deployment claims.

The [2026-10-09 validation receipt](../reports/sa-issue-242-conformance-20261009.json) records the source pins, new regression cases and verification counts for this review.

## Lifecycle and usability follow-up

The [protocol audit receipt](../reports/sa-native-protocol-review-20261009.json)
tracks the subsequent client and workspace review. It separates permissionless
account-level activation from custody-authorized module-policy activation, binds
module cancellation reviews to their exact pending intent, and documents the
user's authority and timing choices in the [account guide](../NATIVE_ACCOUNT_USER_GUIDE.md).

The 2026-10-14 engine audit confirmed that the former rules allowed one native
account's proxy to become another account's custody or recovery authority while
normal authorized transitions could then fail. Exact target-frame isolation hides
an ancestor's grant, and two independent native authorities cannot generally
share the required single-account envelope. These checks remain intact.

The corrected draft excludes registered native proxies from every current and
pending custody/recovery slot and requires a witness for newly introduced
non-zero authority addresses. The native candidate applies this at the common
state boundary: `SmartAccountState.GetAuthorityAddresses` includes both current
and both pending roles; `SmartAccount.ReadState` validates registered-proxy
exclusion; `Save` compares the complete next/prior authority sets and validates
admission before writing. Registration also checks admission before external
module discovery. Ordinary wallet, CHECKMULTISIG and deployed-contract authorities
remain eligible under their actual native witness rules.

Creation with recovery now needs both recipients' consent; nomination needs a
new recipient's consent as well as the existing custody or recovery initiator.
Mature activation and custody-recovery execution remain permissionless because
the destination was admitted in its pending record. No reverse reservation index
is introduced: a third party cannot block a future account's deterministic
registration by naming its precomputed address as recovery. A future unregistered
proxy cannot supply a valid canonical transaction witness, and an existing proxy
is explicitly rejected. A stored invalid authority faults closed; this draft
does not silently repair prior experimental records or supply their migration.

These changes resolve the documented admission policy for the candidate; they
do not establish universal implementation refinement, independent-client
conformance, upstream adoption or public activation. Runtime claims must remain
bound to the corrected candidate and its regression evidence, not the historical
receipts linked above.

The [usability follow-up](../reports/sa-native-usability-20261009.md) adds
execution-time pending-content checks to SDK cancellation, standard Neo
CHECKMULTISIG wallet authorities, exact signed-file submission and recovery of
historical receipts. These are client and integration guarantees; the native
two-argument cancellation entrypoint, ABI 2, identity version 1 and parameter
digest remain unchanged. The native core additions in this follow-up are tests.

The [performance comparison](../NATIVE_ACCOUNT_PERFORMANCE.md) keeps all callback
bounds and authorization checks. A fresh owned range copy reduces the measured
maximum fixture's post-execution callback cost by 239,646 datoshi (0.2504%).
The result is specific to the pinned runtime and module artifacts; it does not
establish network throughput, arbitrary module feasibility or compiler refinement.
Those historical results predate the authority-admission correction above and
do not replace its regression evidence, independent consensus-client conformance
or upstream protocol review.

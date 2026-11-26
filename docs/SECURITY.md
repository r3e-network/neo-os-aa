# Neo N3 Smart Account Security Model

This book states the security model of the native `SmartAccount` protocol service
and of the modules an account installs. It is derived from the
[v4.1 IDL](proposals/smartaccount-v4.1.idl.json), [SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md)
and [SA-MODULE-PROTOCOL.md](SA-MODULE-PROTOCOL.md); where this book disagrees with
them, they win. The protocol is unpublished and has no network activation, so
nothing here is a statement about a public network.

## Contents

1. [Scope and authority](#scope-and-authority)
2. [Trust boundaries](#trust-boundaries)
3. [Identity and account state](#identity-and-account-state)
4. [Execution security](#execution-security)
5. [Configuration and governance](#configuration-and-governance)
6. [Emergency containment](#emergency-containment)
7. [Recovery](#recovery)
8. [Fees and failure semantics](#fees-and-failure-semantics)
9. [Module trust assumptions](#module-trust-assumptions)
10. [Open boundaries](#open-boundaries)

## Scope and authority

The native contract is a closed 26-method ABI. The core owns identity and the
funding address, the operation encoding and digest, nonce channels, single-route
execution, the module registry with its code binding, freeze and credential
revocation, and the restricted `resetAccount` landing. Modules own everything
that shapes policy: governance intents, threshold rosters, message signatures,
hook order and the recovery policy. No module extends the native ABI.

Every permission in this book is a consent check by the core or a standard module.
An SDK, an RPC node, a relayer or a user interface can build, simulate or submit a
transaction; none of them can grant an authority the contract refuses.

## Trust boundaries

| Layer | Trusted for | Not trusted for |
| --- | --- | --- |
| Neo N3 | Block time, witness scope rules, contract state and `Runtime.CheckWitness` | Account policy |
| Native core | Admission, nonce consumption, routing, code binding, module registry | Deciding whether an operation is wanted |
| Installed modules | Authorization, hooks, governance delay, recovery policy | Extending the ABI or bypassing the core |
| RPC node and SDK | Discovery, construction, simulation | Authority over funds or configuration |
| Fee payer | Paying the transaction | Any account permission |

## Identity and account state

An account is its `accountId`, derived from custody and salt. Custody and recovery
addresses are authorities, not identity: replacing custody keeps the account ID and
the funding address. The salt must be persisted by the owner.

The control record holds the status, custody, authority epoch, configuration
nonce, the two built-in authorization switches, the required validator id and the
control revision. A registered account is Active or Frozen. Freezing, unfreezing
and recovery advance the authority epoch; every landed configuration batch and
every counter-advancing transition advances the configuration nonce. Signatures,
intents and recovery requests are bound to the counters they were created under
and become stale when those counters move.

## Execution security

- **One operation per transaction.** `executeUserOp(accountId, operation)` is the
  only execution entry. There is no batch or sponsored entry.
- **Admission is not authorization.** The proxy witness calls `verify(accountId)`,
  which checks only that the caller is the proxy and not the payer, the account is
  Active, the transaction script is exactly one `executeUserOp` call for that
  account, and the deadline, authority epoch, configuration nonce and nonce are
  current. It verifies no signature, inside the 1.5 GAS a witness may use.
- **Authorization happens once**, inside `executeUserOp`: the routed validator or
  the built-in custody signature authorizes the exact 13-field operation, the
  nonce is consumed, pre-hooks run forward, the target is called, and post-hooks
  run in reverse over the same snapshot. Callback arguments and results are
  independent copies.
- **Everything is bound.** The operation and its digest bind the network, the
  native contract, the account, the nonce channel, the deadline, the validator id,
  its credential generation, the authority epoch and the configuration nonce.
- **Code is bound.** Installation records the module's contract hash, NEF digest,
  profile digest, contract id and update counter; they are rechecked around every
  callback and at commit. An updated, destroyed or recreated contract is rejected.
- **Scope is narrow.** The proxy witness grants the intended target frame only;
  descendant calls obtain no access to account assets, and the account proxy can
  never be the fee payer.
- **Thresholds are counted by the core.** A composite validator selects the first
  quorum of valid children in the roster order; the core never reads the roster,
  the weights or the quorum, and only the selected children obtain post-execution
  authority.

An invalid signature passes the witness and faults at execution with no state
change; the fee is burned. Simulate before sending.

## Configuration and governance

- **Registration** requires the custody witness. Its actions are install-only, at
  most 16, and apply atomically.
- **Every later change is an intent** on the governance module: `proposeConfiguration`,
  a 24-hour maturity, `confirmConfiguration` inside a 7-day window, at most 16
  pending intents and 16 actions each. Proposal, confirmation and cancellation of
  an unexpired intent all require the custody witness; an installed validator that
  calls these entries is not a governance witness. Anyone may clean an expired intent.
- **The core accepts one writer.** Installation, removal, configuration, built-in
  authorization changes and unfreezing reach the core only from the account's
  installed, code-bound governance instance. A custody-signed direct call fails
  with `SA_UNAUTHORIZED`.
- **Each landed batch advances the configuration nonce exactly once.**
- **A frozen account accepts one intent.** While Frozen, only the unfreeze intent
  can be proposed, confirmed or cancelled.
- **Mandatory spending is a routing rule.** A pinned required validator id makes
  every operation take that validator. It is not a transfer of control: custody
  can unpin it through the 24-hour governance path, or recover.

## Emergency containment

| Action | Who | Effect |
| --- | --- | --- |
| `freezeAccount` | Custody witness, account Active | Immediate; advances the authority epoch, so pending intents and recovery requests become stale |
| `revokeModuleCredentials` | Custody witness or the governance instance, account Active | Immediate; advances the validator's credential generation, so every signature under the previous generation fails |
| Unfreeze | Governance intent | After 24 hours, inside 7 days |

Delayed removal is not an emergency control. For immediate containment followed by
a custody change, freeze first, confirm Frozen, then start a recovery request.

## Recovery

Recovery is recovery-seat state. The account carries no recovery delay at
creation. The seat's policy is `[guardians[], threshold, timelockMs, authority]`:
1..10 guardians, a threshold of at least 1, and a delay of 7..90 days.

| Step | Who | Rule |
| --- | --- | --- |
| `beginRecovery(accountId, newCustody)` | Custody, the configured authority or the guardian quorum; a named new custody must also witness | Account Active or Frozen; one pending request; the timer never restarts |
| `cancelRecovery(accountId)` | The same authorities | Until the request is executed |
| `executeRecovery(accountId)` | Anyone | After maturity, and only while the authority epoch, configuration nonce and policy revision and digest are unchanged |

Execution is permissionless and callback-free. The core's `resetAccount` accepts
only the installed, code-bound recovery seat: it removes every module instance and
nonce cursor without calling a validator or hook, replaces custody when the
request names one, clears the required validator, re-enables built-in
authorization, returns the account to Active and advances the authority epoch,
the configuration nonce and the control revision. The seat then reinstalls the
account's module set as one install-only composition in the same transaction
(recovery seat and governance-capable validators first, at most 16 instances) and
deletes its own policy, so guardians, threshold and delay must be configured
again. A reset transaction that ends without a governance-capable validator
installed faults as a whole.

Freeze first when the old custody key may be compromised: proposing recovery does
not freeze an Active account. Recovery is not a promise to refund module-held
funds or revoke external allowances.

## Fees and failure semantics

The account cannot pay fees; an external payer signs the complete transaction
after checking separate system, network and total ceilings. The declared
`SystemFee` is the only execution limit and the network burns it in full, so an
included transaction whose Application faults still charges the payer. A target
returning Boolean `false` is a business result, not a fault. A transaction ID is a
submission: confirmation requires reading back the exact transaction and its
application result.

## Module trust assumptions

A module's profile is an admission compatibility check, not a proof that its
bytecode behaves as described. Installing a validator grants it authority over
operations; a governance-capable validator can reconfigure the account; a
recovery seat can reset it; a hook can reject every operation. Install only code
that has been reviewed for the role it will hold. The standard modules are
NeoWitnessValidator, SessionKeyValidator, MultiSigValidator, SigningModule,
ThresholdPolicyModule, GovernanceModule, RecoveryModule and the whitelist,
daily-limit and token-restriction hooks.

Reusing one P-256 key as both a session key and a standard Neo signer yields one
vote, not two. Distinct keys are not proof of distinct people, and an arbitrary
verification script reveals nothing about who controls it.

## Open boundaries

- **Batch accounts.** A `createAccounts` entry installs nothing, and the core
  accepts no later installation without a governance instance, so such an account
  cannot be given modules. Whether to drop the batch entry or to allow a
  custody-witnessed first installation is an open design decision.
- **Recovery composition.** The reinstall after a reset carries at most 16
  instances; instances beyond that limit are not reinstalled.
- **Evidence.** Unit tests, local NeoVM runs and bounded formal models cover the
  source tree they name. They do not establish complete compiler refinement,
  cryptographic soundness or behaviour on a public network.

## Appendix B: Frontend dependency security assessment

Re-reviewed on 2026-11-16 across every manifest ecosystem in this repository:
`npm audit` reports 0 findings for `sdk/js`, and
`dotnet list package --vulnerable --include-transitive` reports 0 findings for
all 43 .NET projects (contracts, hooks, verifiers, native core, probes and test
fixtures). The frontend remains at 22 production / 27 total affected packages,
all low, all resolving to the same two reviewed advisories below; both audit
gates pass. `@web3auth/modal` 11.4.3 was re-evaluated as an upgrade path: its
published manifest still depends directly on `deepmerge ^4.3.1`, so the major
migration would not clear either root advisory, and the Web3Auth 10.x line plus
this review policy remains the correct posture. GitHub's Dependabot alert count
on the web UI lags the merged state; the local gates above are the source of
truth.

Reviewed on 2026-10-30. The frontend's remaining low-severity audit entries
originate from two upstream advisories, Elliptic and deepmerge, including findings
propagated to dependent packages. They are known upstream risks, not a
zero-vulnerability result. The current production audit reports 22 affected
packages at low severity; the complete tree reports 27, with no moderate, high,
or critical finding after the Vite and qs patches below.

### Patched renderers

- DOMPurify is pinned to **3.4.16**, which fixes
  [GHSA-p98j-92pf-mc4p](https://github.com/cure53/DOMPurify/security/advisories/GHSA-p98j-92pf-mc4p)
  and [GHSA-6688-9rhm-gjv2](https://github.com/cure53/DOMPurify/security/advisories/GHSA-6688-9rhm-gjv2).
  These concern `IN_PLACE` sanitization. The reviewed Mermaid code sanitizes a
  serialized SVG string, and the application does not enable `IN_PLACE`.
- Mermaid's KaTeX dependency is overridden to **0.18.2**, fixing
  [GHSA-238p-pmpm-9mq7](https://github.com/KaTeX/KaTeX/security/advisories/GHSA-238p-pmpm-9mq7).
  This flaw requires pre-existing prototype pollution or control of the renderer
  options' prototype; it does not itself introduce prototype pollution.
  The scoped override crosses Mermaid's declared `^0.16.47` range. The application
  uses the stable `renderToString` API through Mermaid and has Chromium coverage
  for flowcharts, sequence diagrams, fractions, square roots, malicious HTML,
  JavaScript links, and inherited `trust` options. See the
  [KaTeX API](https://katex.org/docs/api) and
  [0.18.2 release](https://github.com/KaTeX/KaTeX/releases/tag/v0.18.2).

Documentation renderers are loaded lazily from `DocsView.vue`; document content
comes from the repository's fixed loader registry. Mermaid and KaTeX are listed
as development dependencies but ship in browser chunks, so a production-only
dependency audit is insufficient. Both dependency scopes are checked.

### Remaining Elliptic risk

[GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84)
affects Elliptic through 6.6.1. At review time, 6.6.1 was the latest published
release and the advisory listed no patched version. The upstream
[signature-truncation report](https://github.com/indutny/elliptic/issues/321)
describes incorrect handling of some curve/digest combinations and concern
about attacker-chosen prehashes. An application-specific key-exposure exploit
has not been demonstrated here; this is not evidence that the dependency is safe.

Elliptic is used by the active Web3Auth/Torus dependency tree. In the inspected
installed code, Torus metadata signing uses secp256k1 with 32-byte Keccak digests,
and `@toruslabs/eccrypto` accepts at most 32-byte messages for that curve. Other
transitive paths include Starkware/XRPL support and the `crypto-browserify`
polyfill. Those branches cannot all be declared harmless or unreachable merely
because the application currently exposes an identity login flow.

The native workspace has no direct import of the Web3Auth modal runtime.
`didService` imports it only when initializing the identity client; identity
reconnection is another possible trigger in views using `useDidConnection`.
Before the chunk-boundary fix, a fresh production `/native` visit still loaded
a 3.17 MB shared identity chunk containing Elliptic: manual grouping had pulled
Ethers and Vite's preload helper into that deferred chunk. The build now keeps
manual groups explicit and lets the identity dependency tree retain automatic
chunk boundaries. Chromium verifies that ordinary routes, including `/native`
when registered, do not request any chunk containing Elliptic until identity
initialization. It also imports and constructs the actual bundled Web3Auth
provider, so keeping it deferred cannot silently remove the feature. Measured
native-route JavaScript decreased from 3,817,540 to 663,165 uncompressed bytes
(about 83%). This is a loading boundary, not a fix for the remaining advisory.
The deferred provider still produces a build size warning above the unchanged
3.5 MB budget; the warning is not suppressed. Native wallet operations are handed to the external wallet. The native Node SDK
accepts caller-provided transaction signers and verifies their P-256 signatures
with Node crypto. This separation does not remove the frontend dependency risk.

Upgrading Web3Auth to 11.4.2 is **not** a complete Elliptic fix: the published
[`@web3auth/no-modal` 11.4.2 manifest](https://registry.npmjs.org/@web3auth/no-modal/11.4.2)
still depends on `ripple-keypairs ^1.3.1` and `xrpl ^2.14.0`;
[`ripple-keypairs` 1.4.0](https://registry.npmjs.org/ripple-keypairs/1.4.0)
still depends on Elliptic. Although newer Torus crypto packages use Noble, forcing
them under older callers is not a verified compatible replacement. The separate
polyfill path also remains. No Web3Auth major migration, custom cryptography patch,
or audit-suggested polyfill downgrade is included in this change.

### Remaining deepmerge risk

[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
affects `deepmerge` 4.2.0 through 4.3.1. At review time, 4.3.1 was the latest
published release and the advisory listed no patched version. The issue is
prototype poisoning through `mergeObject()` in the returned object graph.

Deepmerge is loaded by the deferred Web3Auth/Torus identity path and is used to
merge application, dashboard and login configuration. This is client-local
JavaScript: a successful poisoning would affect the page that loaded the
attacker-controlled value, not another origin or the Neo chain. The application
does not accept arbitrary object graphs as identity configuration, and its CSP
does not permit the dependency to be introduced by an unrelated script. Those
constraints reduce exposure but do not prove the dependency harmless. A forced
Web3Auth downgrade is not an acceptable fix, and no compatible patched release
exists at this review point.

Vite is updated to 6.4.5 for GHSA-8g5g-mxqh-grgj and qs to 6.17.1 for
GHSA-6pq8-jhm2-2vcw. Neither advisory is allowed at moderate severity; both are
fixed in the lockfile rather than accepted by the audit policy.

### Audit policy and validation

`npm run audit:prod` and `npm run audit:all` resolve every reported dependency
finding to its advisory leaves. Only **GHSA-848j-6mx2-7j84 for Elliptic** and
**GHSA-gcqx-w48m-w2h4 for deepmerge**, each at no more than low severity, are
accepted. There is no package-name or moderate-severity exception. A new advisory
on an already known package also fails. Invalid JSON, registry error objects,
missing or unknown severity, incomplete reports, inconsistent counts, and
unresolved advisory paths fail closed.

The gate requires a fresh successful npm audit report. Exceptions must be removed
when a compatible upstream fix exists; broadening the accepted advisory set
requires a separate review. A passing audit gate does not establish protocol,
deployment, or signing safety.

Reproduce the focused validation from `frontend/`:

```sh
npm ci
node --test tests/frontendAuditPolicy.test.js tests/frontendAuditBaseline.test.js
npm run audit:prod
npm run audit:all
npm run test:docs-security:browser
npm run test:bundle:browser
```

The repository frontend verification command also includes this browser security
test alongside the production build, unit tests, and existing browser tests.

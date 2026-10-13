# Ordinary candidate acceptance — 2026-10-13

This report covers the current ordinary user-contract candidate on local `main`.
The ordinary and native entrypoints remain in `implementations/ordinary` and
`implementations/native` in the same branch. This is an internal engineering
acceptance of specified behavior on the published Neo runtime. It is not public
deployment approval, native activation, universal plugin compatibility, or a
claim that every possible protocol defect has been excluded.

## Decisions and closed findings

| Scope | Decision | Evidence and limit |
| --- | --- | --- |
| Ordinary contracts and specified source protocol | GO for the tested candidate and declared module scope | 438 contract tests; fresh public-runtime chain acceptance; reproducible artifacts and eight-module RPC readback |
| Formal models and source snapshot gate | GO for the declared abstractions | Host and pinned container independently pass 29 Coq modules, 490 closed declarations and 287 rejected semantic mutations |
| Frontend internal-use flows | GO | 782 unit tests and 20 browser checks; production build and dependency-policy gates pass |
| SDK package | GO | 296 unit tests, TypeScript consumer checks and 5 real installed-package checks; production dependencies have zero reported vulnerabilities |
| PlatformRegistry runtime integration | GO for the migrated local source and complete artifact | 118/118 Registry NeoVM tests, including actual AA candidate/legacy artifacts, restricted witnesses, timing and rollback; public migration remains required |
| Offline Registry interface gate | GO for the selected candidate and reviewed source shape | 14 checks pass; legacy AA is rejected; 64/64 negative-control/unit tests also pass without an AA sibling checkout |
| Public artifact replacement | NO-GO until operational release gates close | The historical 90-entry public artifact does not contain the current 100-entry candidate fixes |
| Full native standard conformance and activation | NO-GO in this report | Ordinary calls cannot enforce isolated child-callback gas budgets; native runtime and activation evidence are separate |

1. **Transaction sponsorship could repay the enclosing fee repeatedly.** The
   core now reserves from one cumulative transaction fee ceiling before external
   calls, shared across single, batch, nested and cross-account/paymaster entries.
   One bounded ledger slot is reused across transactions. Failed transactions
   roll back ledger, sponsor balance and nonce together. Independent core
   deployments have separate ledgers.
2. **A failed plugin cleanup could veto recovery.** The candidate adds optional
   callback-free permanent owner-only recovery after the existing owner-witness
   and timelock checks. It detaches roots and pending authority without executing
   old plugins, preserves identity, proxy address and nonce history, and rejects
   every later plugin installation, including after ownership transfer. Legacy
   cleanup-based recovery remains available for accounts needing future plugins.
3. **Governance proof assumptions did not match implementation.** The model now
   checks owner witness independently of caller identity, uses exact millisecond
   delay arithmetic, and pins administrative and market cleanup sources.
4. **Production crypto initialization broke the browser bundle.** Removing the
   incorrect compile-time `process.browser` constant restores the existing runtime
   shim. The browser harness tests a static production build, real navigation and
   the error boundary. The recovery UI checks deployed capability and current
   state, explains irreversibility, and disables plugin configuration afterward.
5. **Verification evidence used the wrong runtime or could lose identity.** The
   ordinary selector now runs the published NeoExpress source suite. Source
   snapshot, independent rebuilds, on-disk NEF/manifest and actual deployed RPC
   script/checksum/complete manifest are joined and checked for all eight modules.
   Formal mutation scratch paths are namespaced by module to avoid collisions.
6. **The real Registry assumed immediate AA owner rotation.** Registry proposals
   now start the AA proposal, use at least its seven-day maturity, confirm with
   the incoming owner's witness, read back the actual AA owner and cleared intent,
   and only then update the Registry administrator. Cancellation, replacement,
   restricted witness scopes, legacy local intents and late account materialization
   are covered. A legacy immediate mock was replaced with staged behavior; the
   actual candidate and historical AA artifacts are also executed in NeoVM.
7. **Registry catalog code could not compile and had isolation defects.** The
   existing Composition ABI is retained and the catalog getter has a distinct
   name. Module grants use a 33-byte domain-prefixed hash key, preventing ambiguous
   app/module concatenation while respecting Neo storage limits. Legacy ambiguous
   grants fail closed and require reviewed regrant. Callback bindings cannot be
   taken from another app or have another app's reverse mapping silently removed.

## Concrete validation

| Gate | Result |
| --- | --- |
| Registry interface controls | 64/64 in both repository and isolated checkout; current candidate PASS, legacy AA FAIL |
| Complete Registry regressions | 118/118 in both the working repository and an isolated checkout without an AA sibling, zero skipped; includes 29 catalog and 12 new rotation cases |
| Contract Release suite | 438/438, no skipped tests |
| Repository script tests | 131/131, no skipped tests |
| Runtime/deployer/build Python tests | 14 + 3 + 14 passed |
| Artifact reproducibility | 80/80 files byte-identical across independent builds |
| Published NeoExpress acceptance | 38/38 checks; 47 successful transactions; 6 simulation-only fault cases; 4 node-refused cases (one also faults in simulation, for 7 total simulation faults) |
| Runtime artifact provenance | 8/8 deployed modules match source certificate, release bytes and complete RPC manifest |
| SDK unit / installed package / types | 296/296 units; 5/5 package checks; type check PASS; no skipped tests |
| Frontend unit / browser | 782/782 units; 20/20 selected browser checks, no skips |
| Frontend build / dependency audit | PASS under repository policy; 24 low advisories allowed by the existing allowlist, not zero vulnerabilities |
| Formal host and container | Each passes 29 modules, 490 declarations, 283 Coq + 4 TLC rejected mutations |
| Bounded TLC exploration | 61,460 distinct states; 11,859,476 generated |
| SMT obligations and controls | 7 obligations + 7 controls |
| Formal runner regressions | 68/68 in each environment |

The final SRC-08 transaction executes single and batch sponsored entrypoints
in one signed transaction. Their combined reimbursement is **602,465,220
GAS base units**, exactly the persisted transaction's system plus network fee.
The sponsor loses that amount, the relay receives no profit, and the account
nonce advances twice. Unit/NeoVM tests separately cover cross-account, different
paymasters, nested callbacks, zero-fee estimation and exhausted-budget rollback.

SRC-10 first demonstrates the old hook's cleanup refusal and atomic rollback,
then successfully finalizes permanent recovery. The old verifier storage remains
untouched, proving that recovery did not invoke its cleanup. The recovered owner
executes directly and transfers exactly **1 GAS** from the unchanged proxy address;
plugin reinstallation and unauthorized execution fail without state changes.

Gas estimation simulates the complete transaction and uses a fee margin. Storage
initialization and serialization can affect gas; no exact universal estimation or
performance-optimality claim is made. The bounded ledger avoids persistent
per-transaction storage growth.

Registry tests pin the original candidate and historical AA NEF/manifest bytes in
repository fixtures, so their default execution does not depend on an adjacent AA
checkout. Four real-artifact cases also pass using explicit current sibling build
directories. A modified manifest or missing explicit directory fails rather than
silently switching artifacts or skipping tests.

## Artifact identity and reproducibility

The contract changes are present by `d41aec3c5843b0f3ce33a032970aa307817cd52f`.
Later SDK and reporting changes do not change contract build inputs. Exact file
identities are recorded in [the acceptance manifest](aa-ordinary-acceptance-20261013.json).
The dependent Registry repair is committed on its existing `master` branch as
`630d82d`; ordinary and native AA implementations both remain on AA `main`.

- Source-input snapshot: `d2f29f455bd9da5aa9005de2a2a0ec8d34b905f7aa55c1a375f344c6f33dece3`.
- Candidate core NEF: `083ed325f9bdaa6b223662042f32d29f398ba055f507bbdde46daf8113c47f2a`.
- Candidate core manifest: `e79fa04969ef3f0bdd6b9df6afe41acdd19767968575ea38c1cd011ee97e5156`.
- Candidate ABI: 100 entries, 99 unique method names. Ten added methods; no removed
  method signatures or manifest permission changes compared with the pinned artifact.
- Existing `rotatePlatformAccountOwner` behavior changes to a seven-day proposal
  followed by new-owner-authorized confirmation; Registrar integrations must migrate.

[Rebuild certificate](aa-ordinary-artifact-reproducibility-20261013.json),
[fresh chain receipt](aa-ordinary-source-chain-20261013.json),
[RPC provenance join](aa-ordinary-runtime-provenance-20261013.json),
[ABI/behavior review](aa-ordinary-candidate-compatibility-20261013.json),
[host proof receipt](aa-formal-ordinary-closure-20261013.json),
[container proof receipt](aa-formal-ordinary-closure-docker-20261013.json),
[container build receipt](aa-formal-container-build-20261013.json), and
[Registry integration evidence](aa-registry-integration-20261013.json) are retained.
The default and ordinary-named reproducibility receipts contain identical bytes.

The contracts gate ran with `--profile ordinary --contracts-only
--skip-contract-build --formal --neoexpress` after the full build. The final
entrypoint still rebuilt both profiles independently for its reproducibility
certificate. Frontend and SDK gates use their respective `--frontend-only` and
`--sdk-only` selectors with `NEOOS_REQUIRE_COMPLETE=1`. The acceptance manifest
records exact commands and log hashes.

The container used the pinned toolchain and the exact checksum-pinned cached TLA
JAR. The mutable upstream release URL had different bytes and was correctly
rejected. Neither the Dockerfile nor checksum was weakened; this does not claim
that the mutable URL currently rebuilds. Temporary serving and Colima were
stopped afterward. No public-chain writes, remote pushes or deployments occurred.

## Remaining boundaries

- Ordinary standard calls have no isolated per-child gas budget. The internal
  profile requires reviewed modules and transaction fee limits. This does not
  satisfy the stronger native resource-isolation requirement.
- Registry/AA consistency is a property of successful coordinated Registry
  transactions, not every possible chain state. Direct AA cancellation may leave
  a non-executable Registry intent that can be cleared while its owner is unchanged.
  An independent AA market sale can change the AA owner without transferring the
  Registry app administrator; such ownership drift requires separate coordination
  and must fail closed rather than let the old app administrator reclaim the AA.
- Recovery still requires the owner witness, maturity, no active execution or
  configuration context, and no active market escrow. It cannot refund plugin
  balances, revoke external token approvals, defeat malicious market aborts, or
  remove the independent core upgrade authority.
- Formal results establish the handwritten models and source correspondence
  checks. The governance model has 18 declarations and 14 rejected mutations; it
  models AA owner/pending/timing/witness state, not the external Registry app-admin
  state or two-contract synchronization. Registry integration is separately
  reviewed and tested in NeoVM and is not included in the 490 formal declarations. `implementationVerified: false` remains deliberate: there is no full
  C# → NEF → NeoVM compiler refinement or arbitrary-plugin liveness proof.
- Chain provenance covers the named eight-module ordinary suite. The separate
  private PLATFORM full-module matrix was not selected and is not claimed.
- The public 90-entry artifact has historical identity evidence only. Public
  release requires deployment of the migrated Registry, reviewed governed AA
  upgrade, user signing and independent readback against both candidates. Deploy
  the fail-closed Registry migration first and clear old 24-hour local intents;
  upgrading AA first while the old Registry still assumes immediate rotation
  creates an inconsistent window. Resume AA-bound proposals only after both
  reviewed artifacts are active. The catalog permission-key and getter migration
  has its own explicit consumer and regrant requirements.
- External automated deep scanning was unavailable in this environment. The
  evidence here is source review, runtime tests, private-chain transactions and
  formal checks; it is not an external audit attestation.

Generated-report secret review found 76 generic-key alerts in the selected new
receipts. All were checked against actual values: 74 exact file SHA-256 digests
and two deployed public script hashes. This is a scoped report-content review,
not a claim that a whole-repository secret scan returned no findings.

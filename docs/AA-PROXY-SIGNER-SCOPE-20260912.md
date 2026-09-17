# AA Proxy Signer Scope Bypass

## Finding

Release blocker: VerifyScopedTransactionSigner checked witness rules on any
transaction signer, not on the signer belonging to the calling verification
script. For an account with a configured nonzero verify-scope target, a proxy
with Global scope could borrow matching WitnessRules from an unrelated signer.
The unrelated signer can use a PUSH1 verification script and needs no private
key. This defeats the configured proxy scope restriction.

The condition requires a configured verify-scope target and the vulnerable
wallet code. This review does not establish which production accounts meet
those conditions or demonstrate an on-chain theft.

## Reproduction and Fix

ProxyWitnessRuntimeTests executes Neo.SmartContract.Helper.VerifyWitnesses
against a deployed wallet NEF, real proxy verification scripts and explicit
transaction witnesses. No TestEngine signer shortcut replaces this check.

Before the fix:

- Proxy with exact allowed WitnessRules: accepted, as expected.
- Proxy with Global alone: rejected, as expected.
- Proxy with Global plus unrelated matching-rule signer: accepted, incorrectly.

The third test failed with expected false / actual true. The fix requires
signer.Account == Runtime.CallingScriptHash before accepting that signer's
rules. The caller is the verification script invoking the wallet. This ties
the accepted scope to the script being verified rather than another signer.
No native-asset permissions or target allowlists were broadened.

## Verification

Recompiled current UnifiedSmartWallet.csproj with nccs --optimize=All into
contracts/build. Full suite:

```sh
dotnet test tests/AbstractAccount.Contracts.Tests/AbstractAccount.Contracts.Tests.csproj --no-restore --verbosity quiet --blame-hang-timeout 60s
```

230 passed, zero failed or skipped, including all three witness cases.

Tested core SHA-256:

```text
NEF      c38e3a3ecb37b04c5e16edb85540809be22103d0b1c0d742c639d8a460886369
manifest 4b5edc0de6f92aa048a9374b7f840b69ec30b92b8b9457318fe2853dc3185184
```

This is a real witness-validation regression, not full transaction mempool
acceptance, native-asset execution, economic verification or a formal proof.
The test scope target is a mock; its business methods are not exercised.

## Production Status

Local fix only. No chain write, key use, proxy migration or deployment occurred.
Before releasing or funding agents, compare deployed wallet code with the
vulnerable and fixed artifacts, enumerate configured proxy scope targets and
balances, and apply the existing governed upgrade process. Do not treat the
local test result as evidence of production remediation. Anchor custody,
native voting/recall and GAS attribution remain independent release blockers.

## Mainnet Confirmation (read-only, no writes)

The mainnet AA core `0x0268a387913b250166ddec032b03332690a1ef78` runs updateCounter 4.
Its NEF was read back through a read-only `ContractManagement.getContract`
`invokefunction` call and hashes to
`009b1b499a87dab1c17c5ed732717af294ae615fc05e1fc958fe712eb443c3ba`, which is
byte-identical to the repository artifact `contracts/build/UnifiedSmartWalletV3.nef`
committed at `fa452d1`. Its manifest metadata matches that artifact as well
(64 methods, 21 events, `*:*` permission, `Basic` optimization).

`DeployedMainnetProxyWitnessTests` deploys those exact bytes locally and runs the
witness scenarios:

- exact proxy WitnessRules: accepted;
- Global proxy alone: rejected;
- Global proxy plus an unrelated decoy signer carrying matching WitnessRules:
  accepted - the live artifact is vulnerable.

The same decoy case is rejected by the fixed local build, so both states are pinned
in the suite. This is a proven bypass in the deployed bytecode, not an inference
from ABI offsets.

## Exposure

The bypass requires a configured verify-scope target for the account. The deployed
contract emits no event when that target is set, so configuration changes are not
auditable off-chain, and the RPC's `findstorage` cannot enumerate them (a control
query against the NEO native contract's populated balance prefix also returned
zero, so that endpoint is not usable as evidence).

Sampled platform agent accounts do not have a target configured. On mainnet
`miniapp-trustanchor` and `miniapp-profitanchor` each have 21 registered agents
(for example `0x6d97903409bb339e53768d0fefe5cc06c3b18fd2` and
`0xcf3ad5f51f024a445c675cfe287a134b41f486c7`); `getVerifyScopeTarget` returns zero
for the sampled accounts on mainnet and testnet. The flaw therefore appears latent
for those accounts today. A complete account inventory was not obtained, so this is
not a statement that no account is affected.

## Required Remediation

1. Ship the fixed core (local source fix plus the fixed artifact) through the
   governed `scheduleUpdate`/`update` path with the contract admin; do not widen
   native callbacks or treat any AA caller as authority.
2. (implemented in the candidate) Emit `VerifyScopeTargetSet` when the verify-scope
   target changes so the configuration is auditable; still add a read-only audit of
   existing accounts before enabling the feature anywhere.
3. Do not enable verify-scope targets, and do not deploy new accounts depending on
   them, until the fixed core is live.

## Transaction-Shape Binding (added after the first fix)

The witness-rule fix above still accepted any transaction that merely listed the
proxy as a signer. `VerifyScopedTransactionSigner` now additionally requires
`TransactionIsBoundToAccountExecution`:

- the proxy is never the fee payer (`tx.Sender == proxy` is rejected), so a
  shaped-but-faulting transaction cannot burn the virtual account's GAS;
- the transaction script must be data pushes followed by exactly one
  `executeUserOp(accountId, op)` or `executeUserOps(accountId, ops)` call on the
  core, for the same `accountId`.

Locally verified against the rebuilt candidate artifact (`contracts/bin/v3`,
NEF `3396894b12ace9cc507563f868ced036149a9e39a06ec5b7dd1a462db4e862bb`, manifest
`9a9df7f84fdb4d0b2d4dabd02413c7d29bff86233c9838e20f4e9333fecb1a59`):

- two signers (a `CalledByEntry` fee payer plus the proxy), exact proxy
  `WitnessRules`, shaped `executeUserOp` call on the core: accepted;
- the same arrangement with `executeUserOps`: accepted;
- the same arrangement with any other script shape (for example a bare `RET`):
  rejected;
- a single-signer transaction where the proxy pays its own fees: rejected;
- Global proxy alone, or Global proxy plus an unrelated decoy signer carrying
  matching rules: rejected.

`ProxyWitnessRuntimeTests` was rewritten to these semantics: the earlier suite
encoded the pre-binding behaviour, so its "exact rules accepted" case used a
non-execution script and a proxy-as-fee-payer transaction. That suite now covers
the witness-rule restriction, the script-shape binding and the fee-payer rule.
Full local suite: 237 passed, 0 failed, 0 skipped.

Production status is unchanged: the deployed mainnet core still matches the
vulnerable artifact and this fix is local only.

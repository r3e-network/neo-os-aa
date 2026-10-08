# Legacy policy semantics regression

Scope: public Neo N3 plugin policies, tested in the Neo VM using compiled NEFs. The test core provides the plugin authority boundary; `PolicyExecutionProbe` is a deliberately non-compliant token. Tests execute pre-hook, token mutation and post-hook (or verifier validation, mutation and post-execute) in one transaction, then inspect token balances after success or FAULT. This is local policy evidence, not live network deployment evidence.

Required behavior:

- DailyLimit meters every configured token's realized net debit regardless of the target's return value. A direct transfer charges the greater of its successful declared amount and actual net debit, once. A false result never hides an actual debit.
- SessionKey transfer authorization requires the exact NEP-17 four-argument shape, the core-derived proxy source, a valid destination, and an integer nonnegative amount. Positive caps remain restricted to the transfer method. A transfer result must be Boolean true before spending/last-used state is committed; generic non-transfer return values retain their existing semantics.
- Subscription pulls require the four-argument transfer shape and integer positive amount within the cap. A false or malformed transfer result faults before the billing period/counter is recorded so token effects and the core nonce can roll back together.

Regression tests are written before the policy changes in `PolicySemanticsRuntimeTests`. Validation commands/results are recorded after execution.

DailyLimit's fixed 24-hour window is anchored to its first spend. Later spends must not move the reset timestamp. Account cleanup also deletes transient balance snapshots.

## Reproduction and validation

The initial implementation produced **7/7 failing policy tests**: each expected rejection was absent. A separately added fixed-window clock test also failed when a spend at hour 23 delayed the original window's reset beyond hour 25. These were behavioral Neo VM failures against the pre-fix compiled contracts, not source-text assertions.

After the patch:

```sh
bash contracts/compile.sh
dotnet test tests/AbstractAccount.Contracts.Tests/AbstractAccount.Contracts.Tests.csproj --no-restore \
  --filter 'FullyQualifiedName~PolicySemanticsRuntimeTests|FullyQualifiedName~VerifierSignatureRuntimeTests|FullyQualifiedName~SubscriptionVerifierRuntimeTests|FullyQualifiedName~ProxyWitnessRuntimeTests|FullyQualifiedName~Fix_Escape|FullyQualifiedName~ExecuteUserOpRuntimeTests|FullyQualifiedName~Fix_DailyLimitHook|FullyQualifiedName~ContractTests'
```

Full public and PLATFORM compilation succeeded. The selected suite passed **121/121 tests**, including **11 policy cases**. Cases cover fixed and rolling windows, direct extra debit without double counting, false/zero indirect outflow, malformed transfer arguments with valid signatures, false/integer/null token results, zero-value SessionKey transfer, and ordinary non-transfer false return values.

Two policy cases use the **real public UnifiedSmartWallet core** with verifiers bound to that core, real backup-owner configuration and non-owner execution. A token that debits then returns false faults at the policy post-execution check; the account nonce stays at zero, token balance is restored, and execution authority is cleared. A successful retry at the same nonce advances the nonce once and records the correct balance/spend. Subscription configuration follows the core's 24-hour approval flow.

Existing SessionKey runtime fixtures now use the real wallet as the authority and its derived proxy as the transfer source. Existing Subscription vectors include the required fourth `data` argument.

## Scope and limits

The SessionKey cap constrains the declared NEP-17 transfer amount. It does not prove that arbitrary token bytecode honestly implements that amount. Attach a DailyLimitHook to meter observable net balance changes when additional outflow controls are required; even this relies on the token reporting truthful balances. The generic AA executor continues accepting arbitrary business return values; the stricter Boolean-true rule belongs to policies that explicitly authorize token transfers.

This report establishes local source/bytecode behavior for the policy fixes. It is not a live deployment receipt or protocol-wide security claim.

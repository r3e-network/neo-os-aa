# AA local-chain acceptance: deployed artifacts and current source

From the repository root, install .NET 10 and the published Neo.Express package
3.10.1 (`dotnet tool install -g Neo.Express --version 3.10.1`, runtime reports
3.10.1.18), Python 3, Node 22 and OpenSSL. Then:

```sh
npm ci --prefix frontend --ignore-scripts --no-audit --no-fund
npm ci --prefix sdk/js --ignore-scripts --no-audit --no-fund
python3 scripts/localchain/aa_rpc_scenarios.py --variant deployed
```

`python3 tests/localchain/run.py` is the equivalent runner; `--variant source`
runs the current-source suite instead. Set `NEOXP` to the executable if it is
neither on PATH nor in `~/.dotnet/tools`. On Homebrew the existing helper derives
`DOTNET_ROOT` from `dotnet --list-runtimes` when unset. The signing helper shells
out to `openssl` and needs OpenSSL 3: the macOS system LibreSSL cannot read a DER
key with `dgst -keyform DER`, so put a real OpenSSL first on PATH on macOS.

The suite creates a private published-neoxp chain with random loopback RPC/P2P
ports above 20000 and disposable keys. Its data lives in `/private/tmp` on macOS
(`/tmp` on Linux); it stops its own node PID and deletes the data on completion,
setup failure or interruption. It does not accept an existing chain or RPC URL.
The relay subprocess receives only basic process variables and its freshly
created relay key; no configured remote relay, paymaster or Redis is used.

Expect approximately six minutes, 100 successful checks, 78 RPC-driver executed
transactions, 29 simulated faults and 6 node refusals. Of the faults, one is a
broadcast transaction that faults on chain (the paymaster's per-operation bound,
asserted by its text and by the untouched deposit and nonce); the rest are
simulations and nothing is broadcast for them. The additional relay broadcast
(case 7) is checked through its returned transaction id and the chain state; it
is not included in the RPC-driver transaction count. No private hardfork is
required.

`AA-10` walks the two timelocks across their boundaries with scripted chain-time
jumps (`neoxp fastfwd`, one node stop and restart per jump) on three accounts of
its own: a verifier call and a hook call under the 24 h configuration timelock
(`getPendingVerifierCallTime`, `getPendingHookCallTime`) and an escape under the
7 d minimum (`getEscapeTriggeredAt` + `getEscapeTimelock`). Each boundary is
attempted twice on the deny side (at the start of the timelock and again just
before the on-chain deadline) and once on the allow side, and every observation
records the chain time next to the deadline the chain itself reported: the
receipt gate rejects a walk whose denied time is not strictly before the
deadline or whose allowed time is not at or after it, so a jump that silently
landed on the wrong side cannot pass as evidence. The changes themselves are
also read back: the pending call is still pending and the session key is not
stored before the boundary, and the stored key, the whitelist entry and the
finalized escape are asserted after it.

`AA-09` also drives the relay route's paymaster branch against a loopback
paymaster stub (127.0.0.1, ephemeral port asserted above 20000, a throwaway
bearer token, no live host): a positive approval that echoes the operation hash
it was sent, an approval bound to another operation, an explicit denial, an
answer without a positive approval, an approval whose own ceiling is below the
real cost, and an endpoint that is not listening. Cases 11 to 15 must all refuse
to broadcast and leave the nonce untouched; they use the operation the case-7
broadcast has just consumed plus one, and the probe waits for the case-7
application log before simulating, because a broadcast returns its transaction
id before the nonce moves. Case 16 records a limit of the deployed stack: the
route prices every invocation with a simulation, and the deployed core caps the
sponsored settlement at the transaction's real system plus network fee, which
are zero in a pricing container, so a sponsored invocation faults there
(`Reimbursement exceeds actual gas cost`) and the route refuses it before
signing, leaving the nonce and the sponsor deposit untouched. A sponsored
operation on the deployed core is therefore only expressible by direct
submission, which `AA-08` covers. The frontend has no sponsored-invocation
builder either, so the probe composes that wire shape itself and the SDK's
`createSponsoredUserOpPayload` wraps the inner argument array in an `Any`
parameter a relay-ready JSON payload cannot carry; both are inputs for CU-162.

`AA-08` funds the sponsor deposit, executes a sponsored operation at a fixed
2.5 GAS system fee plus 0.5 GAS network fee while requesting 5 GAS back, and
asserts the settlement: the `Reimbursed` event names the sponsor and the relay
and carries exactly the 3 GAS the relay paid, the sponsor's deposit is debited
by the same amount, and the relay's own balance is unchanged. It then re-binds
the paymaster's per-operation bound to 1 GAS, where the same operation must be
refused on chain with `Exceeds per-operation limit` and move nothing, and to
4 GAS, where it executes.

The receipt at `tests/localchain/out/rpc-deployed.json` includes all scenarios,
named checks, transaction outcomes, artifact digests and engine version. Override
it with `--receipt PATH`. A fresh run removes any prior receipt before checking
prerequisites. Exit 0 requires the exact ordered scenario/check inventory, every
check true, all scenarios passing and all three outcome counts matching
`expected-deployed.json`. A missing executable or dependency fails the suite.

```sh
python3 tests/localchain/test_gate.py
python3 tests/localchain/test_mismatch.py
```

The negative control starts another real chain, substitutes WebAuthnVerifier for
the native account's zero verifier, and requires `no verifier: native fallback`
to fail with CLI exit 1. It never skips for missing prerequisites. The fast gate
tests plant missing/duplicate scenarios, missing/renamed/false checks, count drift,
unexpected outcomes and a changed artifact digest, and mutate the timelock walk
(missing, empty, reordered, renamed, missing reading, one side unobserved, and
both sides moved off the deadline) to show the boundary evidence is load-bearing.

## Current-source variant

```sh
python3 scripts/localchain/source_build.py --out /private/tmp/aa-source
python3 tests/localchain/run.py --variant source --source-dir /private/tmp/aa-source
```

The source variant compiles the current checkout with the pinned published
compiler (`nccs`, Neo.Compiler.CSharp 3.9.1) and deploys those bytes instead of
`contracts/build`. Without `--source-dir` the suite builds inside its own
temporary run directory; the compiler writes only gitignored `obj/` state into
the checkout. `source_build.py` fails closed on a missing compiler, a failed
restore or compile, or a missing artifact.

Which expectations apply is read from the compiled core, never claimed on the
command line. `source_build.py` parses the NEF, decodes its SYSCALL instructions
and reports the build profile:

- `platform-syscall-present`: the core emits `System.Contract.CallWithGasLimit`
  (interop `1371299780`) once for `validateSignature` and once for `postExecute`
  (DEC-AA-1). No published Neo core registers that interop, so both verifier
  paths must **fault** with `The given key '1371299780' was not present in the
  dictionary.` The suite asserts that fault and that nothing moved.
- `platform-syscall-absent`: after the public build profile lands (CU-29) the
  same verifier-signed and verifier-backed proxy-witness operations must
  **HALT**, move exactly the signed amount and advance the nonce.

Both halves live in `expected-source.json`; the build selects one, so the
expectation flips with the profile without editing the suite. The receipt records
the source core digest, the profile and the call sites, and the gate rejects a
receipt whose profile, call sites or outcome counts disagree with the artifact.
`SRC-03` covers the proxy-witness path with no verifier: it never reaches the
gas-bounded syscall and must keep working in both profiles, which is what makes
the DEC-AA-1 fault specific to the verifier callbacks. Expect approximately one
minute, 19 successful checks, 26 executed transactions, 2 simulated faults and
1 node refusal while the fault is present. The public profile additionally runs
SRC-09: 19 checks, 34 executed transactions and 4 node refusals in total.

The compiled core can carry a third `SYSCALL` with the same interop token in
unreachable tail position; the repository's own `CompiledCoreSyscallTests` pins
the two named callbacks, and this suite pins the same two and records the total
for information only.

```sh
python3 tests/localchain/test_source_gate.py
```

This gate needs no chain and no compiler: it assembles NEFs byte by byte,
parses the committed deployed core as the negative sample, and mutates both
expectation branches (profile swap, call-site drift, false or renamed check,
missing or duplicated scenario, outcome drift, deployed digest reuse).

## Provenance and scope

Ported from the 2026-10-05 AA assessment (`rpcx.py`, `aa_rpc_scenarios.py`,
`relay_probe.mjs`). The eight NEFs and manifests under `contracts/build` are
pinned by SHA-256 in the deployed expectations; the core script was observed
identical to MainNet in that assessment. This suite performs no public-chain
readback and local contract addresses differ because every run generates a new
deployer. The source variant deliberately does not re-run the deployed scenario
list: the current source differs from the deployed artifact in more ways than
DEC-AA-1, so it asserts the native path, the verifier callbacks and the proxy
witness cases that its profile decides.

The current relay includes CU-06's false-transfer refusal. Five historical
AA-09 checks now require preflight/broadcast refusal, the preserved false stack
result, and unchanged nonce and balance. The deployed contract's owner-only
false-return/nonce-consumption behavior is still tested directly in AA-03.
Session keys, proxy witnesses, hooks, recovery and paymaster scenarios retain
the assessor's assertions. These are regression expectations, not a claim that
the deployed contract has self-service proxy setup or a complete WebAuthn flow.

`.github/workflows/localchain.yml` installs dependencies and runs both suites and
the negative control. Hosted CI is billing-blocked; local exact-commit workflow
replay is the acceptance evidence. Hosted Linux execution and the
checkout/setup/upload actions are not verified by local replay. The jobs use no
sibling repositories. This is test-only; rollback removes the localchain scripts,
tests and workflow without changing any contract, SDK or frontend.

## Current-source relay proxy acceptance

`SRC-09` runs the real frontend relay route against the disposable source chain.
It enables proxy support only in that subprocess, using the chain's throwaway
relay key. The test explicitly sets the account's GAS scope and a bounded custom
witness fee reserve; published Neo RPC does not price non-standard nonempty
verification scripts completely. Missing or insufficient reserves and exceeded
network ceilings must leave every observed balance, deposit and nonce unchanged.

The direct relay transaction must move exactly 1 GAS from proxy to buyer, advance
the account nonce once, charge only the relay, and carry the canonical proxy
script and exact restricted signer rules. Sponsored proxy transfers are disabled:
the route refuses single/batch envelopes, and the node refuses even the correctly
shaped sponsored witness envelope, as well as wrong-account and wrong-scope
variants. A source receipt stores raw transaction, witness, balance and nonce
readback under `sourceProxyRelay`; `test_source_gate.py` mutates that evidence to
ensure a txid or green assertion by itself cannot pass acceptance. See
`docs/AA-PROXY-TRANSFERS.md` for the settlement authority boundary.

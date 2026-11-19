# SA local-chain acceptance: deployed artifacts and current source

From the repository root, install .NET 10 and the published Neo.Express package
3.10.1 (`dotnet tool install -g Neo.Express --version 3.10.1`, runtime reports
3.10.1.18), Python 3, Node 22 and OpenSSL. Then:

```sh
npm ci --prefix frontend --ignore-scripts --no-audit --no-fund
npm ci --prefix sdk/js --ignore-scripts --no-audit --no-fund
python3 scripts/localchain/sa_rpc_scenarios.py --variant deployed
```

`python3 tests/localchain/run.py` is the equivalent runner; `--variant source`
runs the current-source suite instead. Set `NEOXP` to the executable if it is
neither on PATH nor in `~/.dotnet/tools`. On Homebrew the existing helper derives
`DOTNET_ROOT` from `dotnet --list-runtimes` when unset. The signing helper shells
out to `openssl` and needs OpenSSL 3: the macOS system LibreSSL cannot read a DER
key with `dgst -keyform DER`, so put a real OpenSSL first on PATH on macOS.

> **Protocol v4 status.** The `deployed` variant is unchanged evidence: it runs the
> frozen 2026-10-05 artifacts under `contracts/build/` against its deployed
> expectations. The `source` variant drives the protocol v4 ABI: the roster in
> `scripts/localchain/source_build.py` is the nine-artifact public module set
> (`SmartAccount`, the two helpers, three validators and three hooks) and the four
> source scenarios exercise `createAccount`, the configuration intents, the core
> hook order and owner-only recovery. A build whose core does not expose the v4
> entrypoints fails closed at the roster before a node starts, so a v3-shaped build
> cannot be accepted by v4 expectations.

The suite creates a private published-neoxp chain with random loopback RPC/P2P
ports above 20000 and disposable keys. Its data lives in `/private/tmp` on macOS
(`/tmp` on Linux); it stops its own node PID and deletes the data on completion,
setup failure or interruption. It does not accept an existing chain or RPC URL.
The relay subprocess receives only basic process variables and its freshly
created relay key; no configured remote relay, paymaster or Redis is used.

Expect approximately six minutes, 161 successful checks, 101 RPC-driver executed
transactions, 30 simulated faults and 6 node refusals. Of the faults, one is a
broadcast transaction that faults on chain (the paymaster's per-operation bound,
asserted by its text and by the untouched deposit and nonce); the rest are
simulations and nothing is broadcast for them. The additional relay broadcast
(case 7) is checked through its returned transaction id and the chain state; it
is not included in the RPC-driver transaction count. No private hardfork is
required.

`SA-10` walks the two timelocks across their boundaries with scripted chain-time
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

`SA-09` also drives the relay route's paymaster branch against a loopback
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
submission, which `SA-08` covers. The frontend has no sponsored-invocation
builder either, so the probe composes that wire shape itself, and the SDK's
`buildSponsoredExecutionScript` returns a VM script rather than the relay-ready
JSON invocation the probe sends; both are inputs for CU-162.

`SA-11` drives the SDK sponsored-operation end to end. The invocation is composed by the SDK's own
payload builder (`scripts/localchain/sdk_paymaster_fixture.mjs`), not by the harness: the fixture
checks that the payload reproduces the requested operation field by field with its argument types
intact, that no parameter is an untyped carrier, that a batch of one operation describes that
operation exactly as the single-operation builder does, and that the payload survives a JSON round
trip. It refuses a malformed request with a JSON answer instead of crashing. The script the SDK
built is then driven on the deployed core and read back: the SDK invocation and the harness
parameter path produce the same VM state, the same `gasconsumed` and the same fault text, the
broadcast HALTs, consumes the account nonce, emits `SponsoredUserOpExecuted` and one `Reimbursed`
naming the sponsor and the relay, and the sponsor deposit falls by exactly the amount the relay was
reimbursed — 3 GAS of the 5 GAS requested — while an unrelated sponsor's deposit is untouched. The
scenario then re-binds the bound to 1 GAS, where the same payload faults on chain with
`Exceeds per-operation limit` and moves neither the deposit nor the nonce, and to 6 GAS, where it
settles below the request again. The bound is read through the paymaster's own preflight (inside at
5 GAS, outside one datoshi above it). The scenario's own session key is separate from the one
`SA-08` and `SA-09` use. Two readings it records are what a relay can price from: the sponsored
envelope faults in a fee-less container on its settlement cap, while the inner operation prices
cleanly there.

`SA-08` funds the sponsor deposit, executes a sponsored operation at a fixed
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
python3 scripts/localchain/source_build.py --out /private/tmp/sa-source
python3 tests/localchain/run.py --variant source --source-dir /private/tmp/sa-source
```

The source variant compiles the current checkout with the pinned published
compiler (`nccs`, Neo.Compiler.CSharp 3.9.1) and deploys those bytes instead of
`contracts/build`. Without `--source-dir` the suite builds inside its own
temporary run directory; the compiler writes only gitignored `obj/` state into
the checkout. `source_build.py` fails closed on a missing compiler, a failed
restore or compile, or a missing artifact.

The source variant drives the protocol v4 module roster that the release recipe
writes to `contracts/bin/public`: nine artifacts — the `SmartAccount` core, the
`MockTransferTarget` and `SAPaymaster` helpers, the three validators under
`validators/` (`NeoWitnessValidator`, `SessionKeyValidator`, `MultiSigValidator`)
and the three hooks under `hooks/` (`WhitelistHook`, `DailyLimitHook`,
`TokenRestrictedHook`). `source_build.py` fails closed on a missing artifact or on
a core whose manifest does not expose the v4 entrypoints (`createAccount`,
`proposeConfiguration`, `confirmConfiguration`, `executeUserOp`,
`executeSponsoredUserOp`, `getOperationDigest`) — a v3 build is refused before the
node starts.

The build profile is still read from the compiled core, never claimed on the
command line: `source_build.py` parses the NEF and decodes its SYSCALL
instructions. The v4 core carries no gas-bounded verifier callback at all —
validators and hooks are plain contracts invoked through the module ABI — so
`expected-source.json` declares the `platform-syscall-absent` profile and the gate
rejects a receipt whose call sites or outcome counts disagree with the artifact.

The four source scenarios cover the v4 semantics end to end on a published node:

- `SRC-01/02`: `createAccount` derives the account from custody plus salt and
  installs `NeoWitnessValidator` atomically; a custody-witness operation executes
  and advances the module's own nonce channel, while replay and stranger and
  duplicate registration are refused without consuming a nonce.
- `SRC-03`: a 24 h `proposeConfiguration`/`confirmConfiguration` intent installs
  `SessionKeyValidator`; the grant digest plus the session P-256 signature HALT,
  and a foreign key or an out-of-grant target is refused with the nonce unchanged.
- `SRC-04`: the intent path installs `WhitelistHook` into the core-owned hook
  order; the allowlisted target executes, another target is refused with
  `Target contract not in whitelist`, and a reconfigured hook allows it.
- `SRC-10`: the owner-only recovery policy makes module changes permanent; after
  `beginRecovery` and the 7-day timelock, `executeRecovery` sweeps every module
  instance, rotates the custody, re-enables the built-in route and keeps the
  owner-only latch. The rotated custody then executes through the built-in
  signature envelope, while the previous custody and any reinstall are refused.

The source receipt retains `sourceArtifactRuntime`: the nine artifacts' declared
relative paths, their NEF and manifest file digests, the parsed manifests and the
complete RPC script/checksum/manifest readback for each. The gate recomputes
script and canonical manifest digests from the retained RPC content, checks exact
identities and inventory, and rejects missing, duplicate, malformed or mismatched
evidence. Artifact bytes and the runner/oracle hashes must remain unchanged
throughout the run; the outer rebuild certificate join binds these digests to the
current contract inputs separately. This readback covers the nine artifacts this
suite deploys; it does not claim runtime coverage of the whole release catalog or
public deployment. Expect approximately one minute and 28 successful checks:
36 executed transactions, 11 simulated faults and no node refusals.

```sh
python3 tests/localchain/test_source_gate.py
```

This gate needs no chain and no compiler: it assembles NEFs byte by byte, parses
the committed deployed core as the negative sample, and mutates the v4 oracle
(profile swap, call-site drift, false or renamed check, missing or duplicated
scenario, missing roster artifact, nested versus flat artifact path, outcome
drift, deployed digest reuse).

## Provenance and scope

Ported from the 2026-10-05 SA assessment (`rpcx.py`, `sa_rpc_scenarios.py`,
`relay_probe.mjs`). The eight NEFs and manifests under `contracts/build` are
pinned by SHA-256 in the deployed expectations; the core script was observed
identical to MainNet in that assessment. This suite performs no public-chain
readback and local contract addresses differ because every run generates a new
deployer. The source variant deliberately does not re-run the deployed scenario
list: the current source is the v4 core and module set, not the frozen artifact, so
it asserts the v4 account, module and recovery paths that its profile decides and
its own oracle declares.

The current relay includes CU-06's false-transfer refusal. Five historical
SA-09 checks now require preflight/broadcast refusal, the preserved false stack
result, and unchanged nonce and balance. The deployed contract's owner-only
false-return/nonce-consumption behavior is still tested directly in SA-03.
Session keys, proxy witnesses, hooks, recovery and paymaster scenarios retain
the assessor's assertions. These are regression expectations, not a claim that
the deployed contract has self-service proxy setup or a complete WebAuthn flow.

`.github/workflows/localchain.yml` installs dependencies and runs both suites and
the negative control. Hosted CI is billing-blocked; local exact-commit workflow
replay is the acceptance evidence. Hosted Linux execution and the
checkout/setup/upload actions are not verified by local replay. The jobs use no
sibling repositories. This is test-only; rollback removes the localchain scripts,
tests and workflow without changing any contract, SDK or frontend.

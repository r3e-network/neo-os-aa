# Deployed AA local-chain acceptance

From the repository root, install .NET 10 and the published Neo.Express package
3.10.1 (`dotnet tool install -g Neo.Express --version 3.10.1`, runtime reports
3.10.1.18), Python 3, Node 22 and OpenSSL. Then:

```sh
npm ci --prefix frontend --ignore-scripts --no-audit --no-fund
npm ci --prefix sdk/js --ignore-scripts --no-audit --no-fund
python3 scripts/localchain/aa_rpc_scenarios.py --variant deployed
```

`python3 tests/localchain/run.py` is the equivalent runner. Set `NEOXP` to the
executable if it is neither on PATH nor in `~/.dotnet/tools`. On Homebrew the
existing helper derives `DOTNET_ROOT` from `dotnet --list-runtimes` when unset.

The suite creates a private published-neoxp chain with random loopback RPC/P2P
ports above 20000 and disposable keys. Its data lives in `/private/tmp` on macOS
(`/tmp` on Linux); it stops its own node PID and deletes the data on completion,
setup failure or interruption. It does not accept an existing chain or RPC URL.
The relay subprocess receives only basic process variables and its freshly
created relay key; no configured remote relay, paymaster or Redis is used.

Expect approximately three minutes, 54 successful checks, 66 RPC-driver executed
transactions, 21 simulated faults and 6 node refusals. The one additional relay
broadcast is checked through its returned transaction id and the on-chain nonce;
it is not included in the assessor's 66 RPC-driver transaction count. Faults are
simulations, not executed transactions. No private hardfork is required.

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
unexpected outcomes and a changed artifact digest.

## Provenance and scope

Ported from the 2026-10-05 AA assessment (`rpcx.py`, `aa_rpc_scenarios.py`,
`relay_probe.mjs`). The eight NEFs and manifests under `contracts/build` are
pinned by SHA-256 in the expectations; the core script was observed identical to
MainNet in that assessment. This suite performs no public-chain readback and
local contract addresses differ because every run generates a new deployer.
Do not rebuild contracts for this job: current source and deployed artifacts
have different behavior. The source variant is outside this suite's scope.

The current relay includes CU-06's false-transfer refusal. Five historical
AA-09 checks now require preflight/broadcast refusal, the preserved false stack
result, and unchanged nonce and balance. The deployed contract's owner-only
false-return/nonce-consumption behavior is still tested directly in AA-03.
Session keys, proxy witnesses, hooks, recovery and paymaster scenarios retain
the assessor's assertions. These are regression expectations, not a claim that
the deployed contract has self-service proxy setup or a complete WebAuthn flow.

`.github/workflows/localchain.yml` installs dependencies and runs both the suite
and the negative control. Hosted CI is billing-blocked; local exact-commit
workflow replay is the acceptance evidence. Hosted Linux execution and the
checkout/setup/upload actions are not verified by local replay. The job uses
no sibling repositories. This is test-only; rollback removes the localchain
scripts, tests and workflow without changing any contract, SDK or frontend.

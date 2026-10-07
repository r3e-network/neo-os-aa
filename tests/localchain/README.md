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
minute, 18 successful checks, 26 executed transactions, 2 simulated faults and
1 node refusal while the fault is present.

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

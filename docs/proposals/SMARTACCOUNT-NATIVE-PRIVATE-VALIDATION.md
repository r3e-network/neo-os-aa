# Native SmartAccount private-chain validation

## Actual native module profiles

The current real-module matrix is `scripts/neoexpress_native_modules_validate.py`.
It uses the source-built runner receipt and the separately reproduced native
NeoNativeVerifier/WhitelistHook artifacts, not accepting diagnostic modules.
The native manifest ABI and `hasModuleContext` phases are not relaxed to admit
legacy artifacts. See `SMARTACCOUNT-NATIVE-MODULE-PROFILES.md` for packaging.

Each fresh run persists two registrations and 29 signed matrix transactions:
11 HALTs and 18 expected FAULTs. It checks actual 2-of-2 witness authorization,
missing cosigners, incorrect witness scopes, one-day configuration maturity,
default-deny allowlists, direct-entry rejection, callback/target-frame separation,
account isolation, cleanup on root removal and custody fallback. Every matrix
transaction has block inclusion, exact script/signer/witness readback and checks
of the complete account record, operation cursor, both pending call intents and
the selected policy getters. FAULTs must preserve these observations and emit
no notifications. This is not a claim about every arbitrary plugin storage key.

Every field of each module's RPC NEF, including method tokens and compiler/source
metadata, is reserialized and compared with the local NEF bytes. Packaged
manifests are compared structurally. The complete runner directory and module
build pins are checked, and independent replay uses a new chain and new keys.
The final receipts are `docs/reports/aa-neoexpress-native-real-modules-final-20261006.json`
and `docs/reports/aa-neoexpress-native-real-modules-replay-20261006.json`.
Only the replay receipt pins the latest fail-closed receipt-initialization helper.

This establishes the tested two-profile compatibility, not every verifier/hook,
private-key independence, full cryptographic soundness, or compiler refinement.
The earlier diagnostic harness scopes and evidence remain distinct below.

The native-service harness activates `HF_SmartAccountV1` on a newly created,
disposable NeoExpress chain before its first block. It never accepts a remote
endpoint or an existing wallet/chain. Wallet material stays in a temporary
chain directory and is not written to receipts. RPC is loopback-only and its
network magic must match the created chain.

This is distinct from the bounded-call diagnostic probe: the service harness
requires a deployed native `AccountManagement`, validates its manifest identity,
ABI/version/digest, and submits actual registration, operation, delayed recovery-
address rotation and freeze transactions. Transaction receipts are read from
persisted application logs; expected preflight faults are labelled separately.
A deployed witness diagnostic also provides a positive custody-witness control
and a negative service-hash witness control through persisted UserOperations. Its
NEF script, checksum and manifest must match RPC readback byte-for-byte/structurally.
The final account and nonce state is independently read through RPC after the
node starts. The recorded runtime assembly hashes must remain unchanged.
The harness deliberately adds a 10 GAS private transaction envelope. Its recorded
system fee is therefore not an optimized product fee estimate; actual consumed
GAS is recorded separately. The artificial envelope is never a public transfer.

Expected sequence: register -> execute -> reject replay -> propose guardian ->
reject immature activation -> advance local time -> activate guardian -> freeze
-> reject execution -> guardian unfreezes (both authorities required). The first
harness revision tests freeze and rejection; joint-witness unfreeze, real proxy
signatures, plugin conformance and full native coverage remain separate gates.
No passing receipt means all native-profile conformance scenarios are complete.

The output is overwritten with RUNNING before chain work; an exception produces
FAIL with a sanitized stage/type, never a previous PASS. Owned nodes are stopped
in finally blocks. Missing runtime files, a native identity/ABI mismatch, wrong
network, mismatched nonce/state, or a transaction without the expected event
must fail closed. Native runtime provenance is an explicit local assembly
overlay, not a claim of a reproducibly rebuilt NeoExpress distribution.

Run with a locally prepared runtime:

```sh
python3 scripts/neoexpress_native_service_validate.py --runtime /path/to/runtime --output /path/to/receipt.json
```

## Source-built runner reproducibility gate

The runner build gate must compile NeoExpress, the native Neo core, RPC server,
RPC client, MPT library and DBFT from explicit local source snapshots, rather than
replace assemblies in an existing runner. Source inputs must exclude build output,
wallets, private configuration and symbolic links. Every included file and every
external NuGet archive is identified by SHA-256. Source compatibility changes and
deterministic build metadata are explicit recipe inputs; no build may silently
reuse an old SmartAccount package or unrecorded DLL.

Two independent clean directories, package extraction directories and offline
restores must produce identical complete runtime file maps, including dependencies,
runtime configuration, debug symbols and native libraries. Different paths are
normalized during compilation, not by editing compiled output. Missing, added or
changed files fail the gate. The source snapshots must remain unchanged throughout
both builds. A failed attempt must replace any previous PASS receipt.

Package feeds are local-only. Reproducibility covers the pinned SDK, host and
dependency inputs, not the compiler's correctness or a source-to-VM refinement
proof. The resulting runtime must then pass the existing disposable-chain native
validation, with its exact assembly hashes recorded. Previous overlay receipts
remain historical evidence and are not relabelled as source-built results.

`neoexpress_source_validate.py` verifies the complete two-build file map before
and after each existing service, proxy, configuration, recovery and activation
validator. It retains each original receipt unchanged as `*.raw.json`; a linked
receipt records the verified source-build provenance instead of the older
harnesses' fixed overlay label. VM outcomes, transactions and source hashes must
be identical to the original receipt. A missing PASS, an owned node not stopped,
or any runtime drift prevents the aggregate from passing. Activation replay uses
the current runtime only; the historical regression is not silently counted.

```sh
python3 scripts/neoexpress_reproducible_build.py \
  --core /path/to/native-core --node /path/to/neo-node \
  --express /path/to/neo-express --cache /path/to/local-nuget-cache \
  --work /path/to/new-build-directory --output /path/to/build-receipt.json
python3 scripts/neoexpress_source_validate.py \
  --runtime /path/to/new-build-directory/build-1/runtime \
  --build-receipt /path/to/build-receipt.json --output /path/to/new-receipt-directory
```

To reproduce an already reviewed build, pass `--expected` with its build receipt
and use different output/work paths. SDK, host architecture, recipe, compatibility
patch, source snapshots, restored package archive bytes, dependency locks and
runtime file maps must match. Source repositories are read-only; temporary
assembly overlays, prior `bin`/`obj` contents and private runtime packages are
not build inputs. Git-version and source-link build generators are replaced with
explicit version metadata plus receipt source identities, avoiding local Git
state or paths in generated artifacts. NuGet's online advisory query is disabled
for this offline build; this is not a current dependency-vulnerability audit.

The native integration repository also retains
`docs/reports/smartaccount-source-runtime-tests.csproj`. In a disposable copy of
its test tree, replace only the unit-test project with this recipe, retaining both
original `.editorconfig` files and `tests/Directory.Build.props`/`AssemblyInfo.cs`.
Set `SmartAccountRuntime` to the verified runtime during offline restore and test.
The project references the exact rebuilt core assemblies rather than rebuilding
them. Dependency versions come from the four core projects. Compare the copied
test-output core/VM DLL hashes with the verified runtime after the full suite;
a green suite alone is not proof that it loaded the intended runtime bytes.
Do not change the original test sources, fixtures or assertion configuration.

## Signed proxy and atomic asset-transfer matrix

`scripts/neoexpress_native_proxy_validate.py` creates a separate disposable chain.
It constructs the exact native verification script and canonical operation
application envelope independently of the node. A temporary P-256 wallet signs
`networkMagic || SHA256(unsignedTransaction)`. The transaction carries both the
payer's actual signature and the account proxy's actual verification script;
there is no RPC-simulated witness substitution.

The matrix funds the script address with private GAS, then checks:

- With only the custody signer, a target cannot synthesize the proxy witness:
  the GAS transfer returns false, the operation halts and consumes its nonce.
- A valid proxy witness with the allowed scope transfers actual GAS; independent
  balance deltas, nonce advancement, Transfer and UserOpExecuted events agree.
- A denying proxy scope returns false without moving assets; verifier acceptance
  is not equivalent to an application witness grant.
- A recipient callback that aborts produces a persisted FAULT with no operation
  nonce, asset-balance or notification commit. A batch whose second transfer
  aborts must also roll back the first transfer and its event.
- A repeated batch nonce, noncanonical application tail and invalid payer
  signature are rejected before persistence, separately labelled as admission
  failures. Expected rejections are not counted as persisted rollback evidence.

Receipt validation checks the exact native service, transaction hash, raw
application script, signer identities/scopes, block inclusion, VM result/event
shape, and balances/cursors read over loopback RPC. Diagnostic NEF/manifest bytes
must match deployed readback. Only child processes and temporary wallets created
by the harness may be used. Missing evidence or unexpected RPC outcomes fail
closed; no provider attestation or cryptographic soundness proof is claimed.

The RPC transaction readback must also match both invocation and verification
witness bytes. The abort recipient's balance is checked separately before and
after every scenario. Admission reasons are exact, not substring matches:
Neo's state-dependent custom-witness failure returns `Invalid`, whereas an
invalid standard P-256 signature returns `InvalidSignature`. Neither an
insufficient-fee rejection nor a transport error satisfies either control.
Rejected hashes must be absent from the mempool and transaction readback;
an accepted canonical batch after the controls provides a positive control
under the same funded account, runtime and nonce state.

The raw transaction uses a deliberately conservative private-only fee envelope.
The receipt keeps paid fees separate from consumed GAS. This is neither a
production fee estimate nor a public-chain transaction recipe.

## Configuration root-mutation regression

`scripts/neoexpress_native_configuration_validate.py` deploys diagnostic composite
roots and leaf modules for both roles. The destructive leaf writes a storage
marker, calls the root's deliberately exposed destroy method and returns false.
Its matured configuration is submitted as an actual signed transaction without
RPC preflight filtering. It must persist as FAULT for the root admission check,
with no notifications, unchanged epoch/intent/roster, absent child marker and
the original root NEF/manifest still present. A benign leaf under the same root
must subsequently configure successfully and commit its false return, marker,
epoch and cleanup enrollment. The fixtures test the native boundary, not the
safety or complete semantics of arbitrary plugins. All artifacts and wallets
are disposable and all RPC traffic is loopback-only.

## Recovery authority and joint-witness matrix

`scripts/neoexpress_native_recovery_validate.py` uses four separately generated,
funded private-chain P-256 wallets: custody, recovery, replacement custody and a
neutral fee payer. Transactions carry actual standard witness scripts and
signatures. A simulation, `ManualWitness`, or a supplied RPC signer list alone
does not satisfy this gate.

The matrix verifies unauthorized freeze, recovery-authorized freeze, rejection
of either single signer for unfreeze, and successful joint unfreeze. Freeze and
unfreeze must advance the configuration epoch and invalidate pending intents.
While custody recovery is pending, mutable configuration is rejected; an Active
account may still execute an authorized operation. The recovery authority can
freeze separately if execution must stop. Custody cancellation is allowed only
before maturity, while the recovery authority can cancel after maturity.

After a renewed delay, a neutral payer executes recovery without either old or
new custody signing that activation. The old custody witness must then fail;
the new custody witness must execute successfully. Account ID, proxy address,
authorization domain and operation nonce history are preserved. Re-freeze and
joint unfreeze use the replacement custody, not the retired key. Every outcome
is persisted, with exact raw transaction/witness readback, expected event/result,
complete account-record comparison and independent nonce readback. Expected
FAULTs must leave the full account/cursor record and notifications unchanged.

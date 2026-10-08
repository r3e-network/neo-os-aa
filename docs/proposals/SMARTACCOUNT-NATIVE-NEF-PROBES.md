# Native module bytecode probes

## Purpose and boundary

Persisted NeoExpress transactions establish reachable end-to-end behavior, but
do not cover defensive states such as a missing snapshot between authenticated
callbacks. A separate in-memory probe executes the unchanged production NEF
against the same source-built native runtime. It must not replace persisted
chain tests or describe host fault injection as an on-chain attack.

The probe accepts an explicit runtime directory, native artifact directory and
output path. Runtime and module build receipts must be checked by its launcher
before execution and again afterwards. The runtime is loaded locally, without
public peers, wallets, RPC or network writes. No production artifact or callback
grant is replaced. Registration, configuration delay and callback dispatch use
the actual AccountManagement native contract.

## Observations and failure handling

For TokenRestrictedHook, exercise exact VM balance reply types, zero balances,
missing snapshots, stale snapshot cleanup, account isolation and fault rollback.
Small test-only token scripts may produce VM values that ordinary C# compilation
does not expose. Their bytes and role must be recorded separately from unchanged
production artifacts. An instrumentation callback may delete a snapshot only at
the recorded native postExecute boundary; the resulting rejection is a defensive
fault-injection test, not a reachable contract interaction.

Every case must assert the expected HALT or specific FAULT and compare complete
contract/account storage before committing a successful invocation. A failed
run must overwrite any earlier success receipt. Inputs, loaded assemblies,
production NEF/manifest and probe sources are hashed. Reports contain no machine
paths or credentials. There are no new keys and no deployment migration.

## Coverage accounting

Decode the complete production NEF script to obtain the instruction denominator.
Record attempted instruction offsets, including a faulting opcode, and actual
completed conditional branch edges. Test the collector independently with
small scripts, both branch directions and a fault before branch completion.
Coverage must retain all decoded instructions, including administration and
defensive paths; never discard unvisited code to increase the percentage.

Instruction and conditional-edge coverage is not C# line coverage, path
exhaustiveness, proof of gas sufficiency or mechanized compiler refinement.
Report missing offsets and totals even when the coverage target is unmet.
Instrumentation runs are not performance measurements. Per-operation gas may
be observed, but protocol callback budgets must remain unchanged.

## Local use

The launcher builds the probe with an explicit `NativeRuntimeDirectory` MSBuild
property, then runs the local executable with the artifact and report paths.
For the recorded five-profile artifact set, set `NATIVE_RUNTIME` to the local
runtime covered by the source-build receipt and `PROBE_RECEIPT` to a new local
JSON output path, then run:

```sh
python3 scripts/native_nef_probe.py \
  --runtime "$NATIVE_RUNTIME" \
  --artifacts contracts/bin/native-v1/restricted \
  --runtime-receipt docs/reports/aa-neoexpress-source-build-final-20261006.json \
  --module-receipt docs/reports/aa-native-restricted-build-20261008.json \
  --output "$PROBE_RECEIPT"
```

A successful receipt must contain all twelve balance vectors in each phase, the required
specific rejection reasons, snapshot-isolation checks, administration/update
checks, matching loaded-runtime identities and explicit coverage deficits.
The independently rebuilt probe executable is deterministic, with embedded
debug information and normalized scratch paths; private machine paths are not
embedded in the public receipt. The source-built runtime still requires its
normal .NET and ASP.NET shared frameworks.

Missing runtime/module provenance, mismatched artifacts, an unexpected VM state
or an incorrect rollback is a hard failure. A successful result covers only the
listed cases and the exact hashed bytecode. It does not complete the outstanding
VM, cryptographic or arbitrary-plugin proof obligations.

Like the node's persistence loop, the host uses a transaction snapshot and
commits it only after HALT. FAULT may leave staged writes in the engine's current
frame cache; those writes must not reach the parent store. The probe compares
the full parent store rather than incorrectly requiring all ephemeral caches to
have erased their writes. Persisted NeoExpress rejection remains separate
evidence for the node's actual transaction commit/discard path.

## Phase and decoder extension

Balance-type representatives must be exercised after a successful preExecute
as well as before it. A test-only token may select its reply from an explicit
storage mode. The host changes that mode at the native postExecute boundary;
the token's script, production hook, canonical operation and phase grant remain
unchanged. Each injected mode change must occur exactly once. Rejected replies
must discard that mode write together with the account nonce and hook snapshot.
A positive control must still advance the operation nonce, and a zero post-balance following a
positive pre-balance must reject as outflow, not as a type error.

Direct calls must fail without a phase grant. Malformed callback Arrays may be
injected at the native diagnostic boundary to test the hook's defensive shape
guards, without weakening the actual native parser. Such injections are not
claims that a correctly executing native service produces those shapes.

## Compiler source mapping

The compiler's extended debug output may be used to locate unvisited source
sequence points only after its newly compiled NEF matches the existing native
artifact byte-for-byte. A different debug build is not coverage of the release
artifact. Preserve the entire NEF denominator, including retained framework
helper bodies and defensive code. Debug positions refer to prepared sources,
so remove exactly the one added preprocessor line when reporting repository
locations. Compiler-provided positions are diagnostic correspondence evidence,
not a verified compilation or a proof of unreachability.

# Native MultiSig VM budget and policy probe

Run from the repository root against an explicitly built native core runtime and
its matching packaged module artifacts:

```sh
dotnet run --project tests/NativeMultiSigProbe/NativeMultiSigProbe.csproj \
  -p:NativeRuntimeDirectory=/absolute/path/to/source-built/runtime \
  -p:UseArtifactsOutput=true -p:ArtifactsPath=/absolute/path/to/isolated/artifacts \
  -- /absolute/path/to/native-module-artifacts
```

The host has no Neo NuGet dependency. Its committed restore lock is intentionally
empty; the supplied runtime DLLs determine execution. Never substitute a public
Neo package or use a different profile digest. The JSON receipt binds both NEF
and manifest bytes, loaded Neo assembly hashes, probe sources and the lock.
The surrounding source-runtime build receipt supplies core commit provenance.

This is an in-memory ApplicationEngine probe using real compiled module NEFs,
real P-256 operation signatures and synthetic transaction signers. It checks the
actual proxy Verification script under the global 1.5 GAS ceiling, and Application
under unchanged 1 GAS callback limits. It does not relay transactions, validate
external payer signatures, use a public network or prove private-chain persistence.
The separate SDK/NeoExpress runner covers those boundaries.

The matrix includes Session/Native and two-Session pairs; all three 2-of-3 slot
positions; surplus proofs with only the first quorum charged; an invalid first
signature followed by two approvals; malformed unused slots; quorum failure;
maximum 128-byte description, positive 255-bit amount, 191-bit nonce channel,
4096 serialized argument bytes and depth-eight argument data. Storage, nonce,
metadata projection, public signing preimage and phase-denial assertions accompany
the gas checks. Public-key vectors include both standard encodings, duplicate
Session/native identities, invalid-point rollback and revocation cleanup.

Pricing is recorded explicitly. These measurements concern the tested official
modules at that pricing, not arbitrary third-party bytecode or all future
consensus/governance fee schedules. Clients must still simulate their exact
transaction and enforce independent fee limits.

The optional `--diagnose` argument records failed positive cases for cost triage;
a diagnostic receipt reports `FAIL` and must never be used as an acceptance gate.

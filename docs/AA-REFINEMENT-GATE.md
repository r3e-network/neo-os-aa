# Fresh refinement gate

The default `formal/refinement/verify.py` command rebuilds the typed source
inventory and executes the arithmetic-region, numeric-coercion, reservation and
complete-helper proof runners in a new evidence directory. Each runner must
return a kernel-checked receipt for its exact supported scope. The helper receipt
must match the independently decoded complete method range, instruction count,
NEF and script identity. Its source projection digest must also equal a fresh
source-only projection of the exported inventory; a well-formed digest alone
is insufficient. It does not certify a public ABI entrypoint.

Source and verification-tool membership and bytes are captured before export and
rechecked after all proofs. Inputs cannot change between a successful local proof
and the aggregate receipt. A missing runner, kernel failure, unsupported scope,
changed input or inconsistent receipt fails with exit 1. The gate accepts no
external success certificate as a substitute for running the prover.

The complete helper certificate is relative to its explicit Neo contract dialect,
well-formed input and storage relations, reference instruction semantics and
environment contracts. Numeric conversion and reservation arithmetic results
remain separate lemmas unless the helper theorem actually imports and composes
them. The gate never sums declaration counts across imported models or turns
runtime examples into universal correspondence proofs.

All public entrypoints remain unproved until their implementation certificates
exist. Consequently the default command returns exit 2 even when every current
proof lane passes. `--allow-partial` returns exit 0 for development while keeping
`implementationVerified: false`. `--arithmetic-only` selects the earlier region
lane for historical reproduction; it does not bypass the full release gate.

```sh
python3 formal/refinement/verify.py --timeout-seconds 1800 --output-dir /tmp/aa-refinement-fresh
python3 formal/refinement/verify.py --output-dir /tmp/aa-region-fresh --arithmetic-only --allow-partial
```

The complete helper and its semantic controls take several minutes. The command
above gives each proof runner 30 minutes; it does not weaken any proof condition.

The aggregate report keeps the full list of unproved ABI dispatch signatures and
names frontend/dialect correspondence, caller/static/ledger invariant
establishment, actual serialization and storage, rollback, external calls, gas,
ApplicationEngine and protocol composition as outstanding obligations. Closing a
private method under reference contracts does not silently remove these gates.

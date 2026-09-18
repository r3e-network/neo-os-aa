# AA Formal Verification

## Status

The current AA formal artifacts live in the sibling local
`neo-os-formal-verification` workspace.

The fail-closed run on 2026-09-18 completed with **79 passed, 0 failed**.
This result is a verification of the stated abstract models and arithmetic
obligations; it is not a claim that the deployed NEF is fully formally
verified.

Run from the formal-verification workspace:

```sh
./verify.sh
./verify.sh --report
python3 audit-coverage.py --check-ledger
```

For an AA-repository-local gate with source-hash pinning and semantic
mutation tests:

```sh
python3 formal/verify.py
python3 -m unittest discover -s formal -p 'test_*.py'
```

The local gate invalidates any previous result before checking, refuses source
hash drift, requires real Coq/Z3/TLC execution, checks final TLC state counts
and action coverage, rejects syntax-only mutations, and records tool/artifact
hashes under ignored `formal/.runs/`.

## AA artifacts

| Artifact | Scope |
|---|---|
| `verified/coq/UnifiedSmartWalletAA.v` | Closed Coq proofs for authorization, exact channel nonce use, rollback, reentrancy, escape-owner gating and success-only state transitions |
| `verified/tla/UnifiedSmartWalletAA.tla` | Finite state-machine exploration of Begin/success/failure/Tick transitions |
| `verified/tla/UnifiedSmartWalletAA.cfg` | TLC bounds and safety invariants |
| `verified/smt/aa_core.smt2` | Nonce arithmetic, cursor advancement, rollback equalities, reimbursement cap and budget arithmetic |
| `reports/aa-formal-20260918/README.md` | Human-readable result and boundary report |
| `formal/verify.py` | AA-local fail-closed runner with source pins and semantic mutations |
| `formal/test_verify.py` | Runner/parser fail-closed regression tests |
| `formal/source-lock.json` | Reviewed source snapshot hashes; not a proof attestation |

## Security boundaries

The models do not prove cryptography, witness-rule or script parsing
correctness, Neo VM semantics, callback refinement, session lifecycle,
paymaster policy resolution, or C#-to-NEF/deployed-bytecode equivalence.
The local runtime suite does check the concrete session-key ordering rule:
after `clearSessionKey` executes, a later `validateSignature` faults with no
active key, and the clear emits `SessionKeyRevoked`. This does not cancel a
transaction already ordered earlier and does not provide mempool invalidation.

The protocol boundary is now explicit in the implementation and proposal:
nonzero valid target, method length 1--128 UTF-8 bytes, argument count at most
64, canonical argument serialization at most 4096 bytes, signature at most
1024 bytes, non-empty batch of at most 32 operations, and nonce/deadline in
the unsigned uint256 domain. `GetNonce` also rejects channels outside uint192.
These are input-domain and resource-shape checks, not a gas or semantic type
policy for every nested argument.

The AA core now rejects negative and over-width nonce values before splitting
the Neo `BigInteger`; deadlines are subject to the same unsigned 256-bit width
bound. The arithmetic proof models that domain exactly. The concrete Neo VM
transport/refinement and the byte-for-byte C#-to-NEF correspondence remain
separate security obligations.

The local runtime correspondence suite is also bounded evidence: twelve tests
passed for false-return consumption, replay/gap rejection, target-fault
rollback, batch rollback, reentrancy rollback, operation shape bounds and
high-channel nonce routing, malformed-field rejection, nonce-query bounds and
the maximum batch. It executes local compiled NEFs only; it does not establish
deployed-bytecode parity by itself. The exact `2^256 - 1` upper bound is
covered by the arithmetic model; Neo VM runtime vectors use its highest
directly representable positive integer.

The complete local AA runtime suite currently passes **257/257**. The separate
session-key regression proves clear-then-validate failure and the
`SessionKeyRevoked(accountId)` notification. Two independent `nccs` 3.9.1
compilations of the core and session-key profile are byte-identical; the
source/artifact hashes and explicit deployed-parity `unverified` status are
recorded in `docs/reports/aa-protocol-security-build-20260918.json`.

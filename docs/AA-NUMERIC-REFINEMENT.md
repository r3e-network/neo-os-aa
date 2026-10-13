# Numeric coercion refinement

This work extends the reference model beyond Integer-tag-only arithmetic inputs.
It targets NeoVM 3.10.1, source commit
`004cd6070a940405818d9357638277dd44407e2e`. It does not modify production contracts,
the compiler, or the existing arithmetic certificate. Kernel checking the new
model does not establish that the runtime implements it; that correspondence
remains an explicit obligation until independently established.

Arithmetic opcodes call `StackItem.GetInteger()`. The pinned implementations
accept Integer values, Boolean values as zero or one, and ByteString payloads
of at most 32 bytes interpreted as signed little-endian two's complement.
Empty payloads represent zero. Redundant positive or negative sign bytes are
accepted within the size bound; canonical encoding is not an admission rule.
See [ByteString.GetInteger](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/ByteString.cs)
and [Integer construction](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/Integer.cs).

Buffer has no GetInteger override and arithmetic therefore rejects it, despite
its separate `ConvertTo(Integer)` implementation accepting a payload of at most
32 bytes. Null also rejects GetInteger, but `ConvertTo(Integer)` returns the
original Null, not numeric zero. Other unsupported tags reject GetInteger.
These separate paths must remain separate in the model. See
[Buffer](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/Buffer.cs),
[Null](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/Null.cs)
and [the base coercion](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/StackItem.cs).

`NumericCoercions.v` defines an executable decoder over byte lists and a separate
numeric value type. Its relationship to a typed source BigInteger is equality
to the decoded integer, not equality of VM tags. Physical bytes are constrained
to 0..255. Successful numeric values remain in `[-2^255, 2^255)`; oversized
payloads, unsupported tags and unrepresentable Integer constructors reject.
The proofs cover the decoding algorithm, range, sign extension and value
relation. They do not prove ABI argument admission, gas, heap identity,
serialization, transaction fees, or .NET BigInteger's implementation.

Run the independent gate with:

```sh
python3 -m unittest formal/refinement/test_numeric_proofs.py
python3 formal/refinement/numeric_proofs.py --output-dir /tmp/aa-numeric-proof \
  --json-report /tmp/aa-numeric-proof.json
```

The gate invokes `coqc` and `coqchk` and requires every reported declaration to
have no assumptions. Semantic negative controls change definitions while
preserving valid Coq syntax; each must fail a theorem after its definition-only
version has compiled. All existing refinement gates retain their original
scope until this model is explicitly composed into them.

`numeric_proofs.py` verifies 13 pinned runtime type-source files. By default it
uses `/tmp/aa-pinned-neovm-numeric-004cd607` and downloads only missing files
from the fixed official commit. Supply `--source-cache` to use another prepared
cache; changed cached bytes fail rather than being silently refreshed. Receipts
have scope `numeric-coercions`, `vmCorrespondenceProven: false` and
`fullImplementationVerified: false`. The host vector oracle is only a test
comparison; the kernel proofs use the independently defined decoding algorithm.

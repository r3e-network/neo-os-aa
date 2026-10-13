# Typed source and NEF inventory

This independent tool uses the installed, audited NCCS 3.9.1 package. It does not
change production contracts, the compiler, or the existing formal model gate.
Its JSON is input inventory and compiler location information, never a proof.

From the repository root:

```sh
dotnet build formal/refinement/export/RefinementExport.csproj --nologo
dotnet formal/refinement/export/bin/Debug/net10.0/RefinementExport.dll \
  --source-root "$PWD" \
  --project "$PWD/contracts/UnifiedSmartWallet.csproj" \
  --nef "$PWD/contracts/bin/v3/UnifiedSmartWalletV3.nef" \
  --manifest "$PWD/contracts/bin/v3/UnifiedSmartWalletV3.manifest.json" \
  > /tmp/aa-refinement-inventory.json
python3 -m unittest formal/refinement/export/test_export.py
```

For a different installation location, supply
`-p:CompilerToolDirectory=/absolute/tools/net10.0/any` when building and
`--compiler-tool-dir /absolute/tools/net10.0/any` when running. That directory
must remain inside the installed package layout with the original `.nupkg`.
The tool checks the package's audited SHA256, installed DLLs and actually loaded
package dependencies. No new NuGet packages or sibling repositories are needed.

The exporter copies build inputs into a disposable directory, runs the fixed
compiler with its original Basic optimization plus Extended debug and assembly
output, and requires exact NEF bytes and equal complete manifest semantics.
Extended debug defines `DEBUG`; that symbol is reported and a byte difference
rejects the export. The original repository's build outputs are untouched.
Standard output contains one compact JSON document; errors go to standard error
and return a nonzero exit code.

Schema `neoos-aa-refinement-inventory/v1` has these stable fields:

- `inputs`: absolute input paths mapped to original SHA256, including source,
  project/config/lock files, compiler package and consumed references/documents.
- `compiler`: package/assembly identity, actual loaded assembly hashes,
  optimization and parse symbols. Framework runtime assemblies are reported;
  they are not falsely claimed to be byte-identical package reference assemblies.
- `source`: files, types, methods, initializers, recursively typed Roslyn
  operations, bound scalar/symbol/conversion metadata and any unexported metadata.
  All operation kinds remain in `unsupportedOperations` until separately proved.
  Synthesized members and bodies without operations carry explicit obligations.
- `nef`: exact container and script hashes, script bytes, native-call tokens and
  every instruction's absolute offset, opcode, operand, size, bytes and edges.
  Counts and syscall sites are derived from the actual decoder.
- `manifest`: original SHA256 and unaltered ABI descriptors.
- `sourceMap`: exact byte/manifest comparison, full compiler debug data, original
  document identities, assembly text and the reimbursement helper's located body.
- `status: INVENTORY_ONLY` and `proofObligations`: no positive proof status.

The pinned compiler loader reads other source types in the contracts directory;
`compilationScope` says so. The inventory does not claim that every such method
is reachable from this NEF. Compiler debug records can also refer to framework
package source, separately bound in `sourceMap.documentInputs`.

The structural decoder is the compiler package's Neo 3.9.1 / NeoVM 3.9.0. Its
identity is explicit. The independently pinned application runtime uses
Neo/NeoVM 3.10.1 and requires a separate decoder/semantics comparison. Source
locations, successful rebuilds and VM examples do not establish source-to-NEF
semantic preservation. Indirect calls, implicit exception edges, heap aliasing,
native/syscall effects, resource limits and synthesized initialization remain
proof obligations. Identity controls in the exporter tests are not evidence
that a semantic certificate rejects a well-formed miscompilation.

# Retained refinement evidence

`host/result.json` is the fresh aggregate receipt; `host/exit.json` records its
expected exit 2. All four proof lanes passed, while full implementation
verification is false and all 100 public ABI entries remain unproved.

The `host/` and `container/` trees retain exact proof receipts, generated Coq
sources, assumptions checks and positive/negative kernel logs. The standalone
reservation controls and independent alias control are retained separately.
Kernel binaries are not committed; their SHA-256 values are retained in
`kernel-object-sha256.json`, and their source files can be compiled again.
Tool logs and generated certificate sources retain their exact original
formatting, including trailing whitespace or blank lines. Source/documentation
whitespace checks exclude this immutable evidence tree; archived bytes are
verified against their recorded hashes and the staged Git blobs instead.

Raw receipts retain their original absolute execution paths. `path-map.json`
maps retained originals to this archive. Container `/output/` paths correspond
to `container/`. On macOS, `/tmp` and `/private/tmp` denote the same location.
`host/inventory.json.gz` expands to the original inventory bytes; compression
does not change the source receipt's inventory digest. The exporter stdout is
the same JSON inventory and is not retained a second time.

`inventory-parity.json` compares the complete final host inventory with the
container's earlier fresh inventory. Only the exporter's temporary debug
document-root differs. Removing precisely that field yields identical JSON,
including all 254 input identities. Source projection, generated certificates,
models and production proof tools remain byte-identical.

The host 107-test log precedes the test-only fixture portability repair.
`tests/portable-helper-host-23.log` checks the final repaired helper tests in a
minimal copied workspace. Container final test evidence checks the final full
suite without mounting the original contract outputs, SDK, NuGet directories
or the 254 compilation inputs. Production proof runs still validate those
compilation inputs; the portable unit-test fixture is never a release inventory.

`runtime/` contains 38 finite tests against the original NEF in the actual
ApplicationEngine, with explicit private-entry and outer-persistence boundaries.
These results are separate from the reference interpreters' universal theorem.

The file index hashes all retained evidence files except itself. A kernel pass establishes
only the scope and preconditions recorded in its receipt; it does not establish
compiler correctness, actual-engine correspondence or public deployment.

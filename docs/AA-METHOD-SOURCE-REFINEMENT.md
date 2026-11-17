# Full helper source projection

The reimbursement helper certificate needs the entire source body, constructor
initializers and storage-key initializer. Selecting three arithmetic expressions
does not account for a changed guard, reset, assignment, serialization or return.
`formal/refinement/method_source.py` translates the complete typed Roslyn tree
into the independent statement/expression language in `CapMethodVm.v`.

The projection supports only the concrete, explicitly checked Neo framework
intrinsics needed here. It preserves statement and argument evaluation order,
all field writes, conditionals, assertions and return values. It lowers the
conditional budget initializer to an if with one local assignment per branch.
Compound field addition reads that field and emits an addition followed by a
field write. BigInteger expressions retain unbounded source arithmetic; target
integer bounds are proved separately for the certificate's admitted domain.

The source language is the declared Neo-framework contract interpretation, not
arbitrary CLR object execution. ByteString/UInt256 values denote immutable byte
values; record fields have their exported layout; framework storage, transaction
and codec calls have explicit effect contracts. Reference casts require the
declared well-formed record relation. These frontend/framework correspondences
remain named obligations, rather than results of the Coq source interpreter.
Invalid codec objects, actual initializer execution, resources and the real
ApplicationEngine are not supplied by the source projection.

Each node's type, resolved member/operator, conversion flags, semantic metadata
and ordered children are checked. Exported collection metadata binds field
initializers to symbols and makes ignored dimensions/arguments, local lists and
argument positions inspectable. Unknown constructs and unexplained metadata are
errors. Adding a supported statement changes the projected program; it is never
silently omitted. The new projector does not replace the previous arithmetic
certificate or its historical evidence.

The public Python API is `project_method(inventory)`, returning a JSON-serializable
source program, local/type bindings, record layout and the literal storage key.
`render_program(projection)` renders the corresponding Coq `list Stmt`. Input
inventory hashes are checked by the outer fresh gate; the projector does not
turn a caller-supplied JSON tree into independent proof of a C# parser.

Projection is linear in the helper tree and initializer inventory. Unsupported
inputs raise `SourceProjectionError` before a certificate is generated. The
regression suite mutates types, callees, source constants, write order, guards,
constructor/key bindings and hidden collection metadata. No production contract,
storage schema or deployment changes are required.

The framework transaction type is supplied through the pinned framework
reference, not exported as a repository record declaration. Its `Hash`,
`SystemFee` and `NetworkFee` fields are named dialect intrinsics at positions
0, 4 and 5. Each use must carry the exact resolved field ID and declared type.
The projection records that external contract together with immutable-byte
comparison, the 32-byte zero hash, the Array/Struct record relation, native codec
effects and the Buffer-valued storage key. Those contracts contribute to the
projection digest. The user-defined reimbursement record is handled separately:
its exact field order/types, synthesized constructor and both symbol-bound field
initializers are checked from exported source.

The key's initializer is traversed as a typed array allocation with an explicit
one-dimensional size and ordered byte elements. Dimension and element
collections must be complete; a manually supplemented fixture is not accepted
as an actual export. The `InitializedFields` collection identifies each
initializer's field, independently of its line number or neighboring text.

`fixtures/cap-method-source.json` contains an unmodified subset of one actual
export. Its recorded inventory digest identifies where the source tree came
from; fixture tests do not themselves authenticate live C# inputs. The outer
fresh gate authenticates those inputs. Semantic controls alter supported source
arithmetic, guards, return variables, constructor constants and statement order,
and require the resulting Coq program to change. Structural controls reject
missing/extra children, unresolved metadata, misleading collections, wrong types,
callees, conversion flags, field layouts and constructor bindings. The projector
never compares its source program against the NEF before choosing semantics.

The checked fixture is drawn from the inventory with SHA-256
`65a73399659594d72b8ae063f14fc64ed18120719111165b69f03785f81d7195`.
Its 14 top-level statements and eight typed locals produce source projection
`11f8b6974dd5278de323078483fd2d0312a4c6d028465831e83e0cfd96c2af31`.
The focused source-projection suite has 15 passing tests, including the original
missing-module red run and subsequent rejected incomplete array metadata and
malformed semantic-container controls. This result establishes checked frontend
projection and mutation sensitivity; the Coq certificate must still consume the
rendered source program and prove its relation to independently decoded bytes.

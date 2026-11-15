# Static source initialization

This lane extends the initializer bytecode certificate with an independent
projection of all 53 static readonly field initializers in the typed source.
The source frontend reads no NEF bytes, opcode outputs or debugger static slots.
It accepts literal byte and string arrays and typed constant integer expressions;
unknown operations, initializer effects, field dependencies and omitted metadata
are rejected. Primitive integer multiplication retains its signed C# width.
The 34 synthesized event backing fields are checked to have only null
initializers and matching synthesized accessors. Their lowering to notifications
is explicitly outside the 53-slot theorem; an arbitrary delegate initializer
cannot be silently omitted.

The source inventory must include a nonempty explicit-method list and exactly the
supported compiler-synthesized static constructor. An explicit static
constructor, missing constructor metadata or a missing method inventory is
rejected before projecting field values. Constructor bodies require their own
semantics; the field-only theorem cannot discard them. The constructor metadata
is bound into both source projection and source tree identities. Completeness of
the Roslyn export remains a frontend trust assumption.

A separate binder assigns source field identities to debugger static slots,
requiring an exact bijection. The Coq source interpreter evaluates initializers
in their source inventory order, allocates string arrays and assigns static
values. Its complete final heap, stack and static table are compared with the
actual 654-byte initializer execution for every preexisting heap and stack.
The expected initialized values come from source expressions, not target bytes.

Roslyn extraction, the source frontend, debugger field identity mapping and the
declared Neo dialect remain part of the trust boundary. This source-to-reference
certificate does not prove .NET execution, arbitrary mutable Buffer identity,
ApplicationEngine initialization scheduling, instruction costs or public ABI
dispatch. Those obligations remain explicit in the complete implementation gate.

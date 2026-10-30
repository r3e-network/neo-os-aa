# ApplicationEngine fee semantics

This lane checks the complete `AddFee(BigInteger, bool)` body from Neo commit
`d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d`. A small rejecting source frontend
projects its statements, branch order, assignments and exception messages into
an independently interpreted Coq program. The generated certificate must prove
that program agrees with a fee specification for every input, including negative
charges, whitelist contexts, exact-budget success and over-budget failure.

The specification preserves the updated fee counter on insufficient GAS. It
does not erase earlier storage writes. Transaction and context snapshots are a
separate obligation. Negative input is rejected before the whitelist exemption.
Internal counters are mathematical integers in picoGAS; factor application uses
the actual declared `FeeFactor`, rather than a silently assumed datoshi unit.

The trace model checks charges before effects. Its erasure theorem states that
a trace with nonnegative charges and sufficient total budget performs the same
effects as the unmetered trace. An exhausted trace stops before the failing
event's effect. This is not yet a theorem that the complete contract emits that
trace or that the trace prices cover every opcode, syscall and native fee.

The source lexer/parser, Coq printing, C# BigInteger implementation and context
getter interpretation remain trusted. Kernel checking proves the projected
program, not arbitrary C# parsing or the .NET implementation. Source hashes bind
the input but do not discharge this semantic trust boundary. Actual engine
instruction scheduling, policy configuration, price tables, native dynamic fees,
resource limits and full ApplicationEngine correspondence remain separate work.

Validation requires positive `coqc` and `coqchk`, assumption checks for every
declaration, and valid-program mutations that change arithmetic, branch order or
the strict budget comparison. Syntax errors and timeouts do not count as proof
rejection.

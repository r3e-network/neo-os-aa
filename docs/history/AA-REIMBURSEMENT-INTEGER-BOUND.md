# Reimbursement integer boundary

The ordinary contract permits a paymaster that reports this wallet as its
authorized core. Such a paymaster may implement a settlement policy without a
GAS transfer. Consequently, the balance and policy limits of the bundled
`AAPaymaster` cannot establish the integer range precondition of the wallet's
reimbursement helper for every admitted public invocation.

The boundary regression uses the unchanged public ABI, a local test paymaster,
and a base `ApplicationEngine`. In a zero-fee estimation transaction, the first
request is the largest positive NeoVM integer and the second is one. The first
reservation is representable; their sum is not. This test distinguishes an
explicit protocol rejection from an accidental arithmetic exception and checks
that a fault does not commit the enclosing transaction. It is local execution
evidence, not a claim about a persisted zero-fee transaction.

Status: public-path regression under construction. The current helper theorem
still requires the cumulative zero-fee reservation to fit in the VM integer
range. No full public-entrypoint proof may assume that its existing amount guard
establishes this condition.

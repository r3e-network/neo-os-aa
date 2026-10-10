# Pending configuration update reads

The ordinary deployed-contract profile adds two safe methods. They are additive
to the existing pending flags, maturity-time getters, and update/confirm/cancel
methods; they do not change storage or authorization.

| Method | Parameter | Result |
| --- | --- | --- |
| `getPendingVerifierUpdate` | `accountId: Hash160` | `Array` or `null` |
| `getPendingHookUpdate` | `accountId: Hash160` | `Array` or `null` |

Both methods have `safe: true`. A nonzero, valid account ID with no pending
record returns `null`, including an unregistered ID. A null, zero, or malformed
account ID faults. No owner witness is required for these public reads.

A present result is always an explicit four-element array:

1. `newModuleHash`: the proposed verifier or hook, as a 20-byte VM ByteString.
   Zero means removal. Neo RPC exposes Hash160 values in VM byte order; clients
   reverse the bytes when producing the usual display-form hash.
2. `verifierParams`: the proposed verifier parameters as a ByteString. A missing
   verifier parameter value is normalized to empty bytes. Hook results always
   contain empty bytes in this position.
3. `initiatedAt`: an integer Unix timestamp in milliseconds.
4. `matureAt`: an integer Unix timestamp in milliseconds, equal to `initiatedAt`
   plus the configuration timelock (currently 86,400,000 milliseconds).

The internal pending storage object is not the public return layout. Verifier
reads select its verifier field; hook reads select its hook field. Cancellation
or successful confirmation clears the relevant record, so the corresponding
getter subsequently returns `null`.

This ABI describes newly compiled source. Existing deployments that do not
advertise these method names continue to expose only the older reads. A client
must check the manifest or handle a missing-method response; it must not present
the selected target or parameters as chain-verified when only a local form or a
transaction draft supplied them. Build output under `contracts/bin/v3` is local
validation output and is not evidence of a deployed upgrade.

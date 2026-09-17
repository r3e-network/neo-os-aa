# V3 Testnet Paymaster Relay Validation

Date: 2026-03-14
Network: Neo N3 Testnet

Refresh note on 2026-03-15:

- the canonical shared testnet AA core is now `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2`
- the canonical shared testnet `Web3AuthVerifier` is now `0x7147f9a508594a7656a25f45d0a7a7dede7c227f`
- this report remains the historical record of the 2026-03-14 validation run, not the current shared-anchor source of truth

Refresh note on 2026-03-17:

- `frontend/api/relay-transaction.js` was fixed again so paymaster request construction no longer faults with `normalizeHash is not defined`
- the canonical stable paymaster replay path now uses the existing allowlisted account id `0x0c3146e78efc42bfb7d4cc2e06e3efd063c01c56`
- the canonical stable replay signer for that account is `NTmHjwiadq4g3VHpJ5FQigQcD4fF5m8TyX`
- a fresh stable replay succeeded with:
  - `updateVerifier`: `0xee656e2305a224bfcb33d2e0339500ead745801d0b0d5618b98f8ddf13d0cb28`
  - relay-backed `executeUserOp`: `0xa7beaa775bcf9fee4f077f41b4fa3cddc08a66ee8913187e30864d953c99b6dd`
- the current cross-repo direct replay succeeded with:
  - `updateVerifier`: `0xd54fe4813693df0f244ada1c1daf8966ba70d0ced76bcdefc5e9fa6ba05aab2d`
  - relay-backed `executeUserOp`: `0xd433d9dbc435dc83835aa8ff7eb36e757d2a77499728ad6d09cb599044172e20`
- `sdk/js/tests/v3_testnet_paymaster_relay.mjs` replays the fixed allowlisted account only when `PAYMASTER_ACCOUNT_ID` is explicitly provided; otherwise it derives the bootstrap account id from the active test WIF and keeps the remote allowlist mutation path available when needed
- the paymaster policy and relay validators now both fall back to the public testnet runtime endpoint `https://oracle.meshmini.app/testnet/paymaster/authorize` when no runtime URL override is provided

Refresh note on 2026-04-24:

- the direct public paymaster endpoint may require the hosted anti-abuse boundary and return `401` or `403`; local and CI validation should set `MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH` to the Morpheus worker handler when validating policy logic from the monorepo checkout
- `sdk/js/tests/v3_testnet_paymaster_policy.mjs` now redacts runtime tokens from Phala/remote-shell failures, retries through the remote worker path after direct transport failures, and accepts the worker's HTTP `400` shape for unsupported `target_chain`
- `sdk/js/tests/v3_testnet_paymaster_relay.mjs` keeps the allowlist mutation path active when a local handler is supplied, so fresh derived accounts can be validated without requiring an existing `PAYMASTER_ACCOUNT_ID`
- latest full paymaster-only testnet replay succeeded with relay txid `0xed4976c866d1374de25f9c11accde4f4273faf6d05d5fb2dbcf70b4589ffef8e`, policy `testnet-aa`, VM state `HALT`, and GAS return stack

Refresh note on 2026-05-18:

- `v3-testnet-validation-suite.latest.json` verifies the on-chain sponsored execution path with sponsored txid `0x36d42e73dedbdb20f27d2a66c491ae5df4c1e8546cfcaf9fe311788c94135d13`
- the latest standalone relay validation ledger records txid `0x27806fe947c16eb9cf930b35ff242ecb65e4ea4304e8b570ac23384ad9ed6987`
- the suite skips `paymaster_policy` and `paymaster` when `MORPHEUS_RUNTIME_TOKEN`, `PHALA_API_TOKEN`, or `PHALA_SHARED_SECRET` is missing, so product UI must present relay sponsorship as runtime-credential gated rather than unconditionally live

## Scope

This historical report records end-to-end `AbstractAccount -> Morpheus paymaster pre-authorization -> AA relay -> Neo N3 execution` validation on testnet, plus the current runtime-credential gates that determine whether the same path is available from a deployed frontend.

Validated components:

- V3 AA core contract: `0x9cbbfc969f94a5056fd6a658cab090bcb3604724`
- Web3Auth verifier: `0xcd2e4589debfd80449ba9190548c5a7d539ce062`
- Morpheus paymaster worker policy: `testnet-aa`
- Relay signer address: `NTmHjwiadq4g3VHpJ5FQigQcD4fF5m8TyX`
- Reused allowlisted AA account id: `0x0c3146e78efc42bfb7d4cc2e06e3efd063c01c56`

## Root Cause Fixed

The AA relay API constructed the paymaster request with:

- `target_contract: \`0x${sanitizeHex(metaInvocation?.scriptHash || '')}\``

But `sanitizeHex` was not imported in `frontend/api/relay-transaction.js`.

Observed failure before the fix:

- API error: `paymaster_authorization_failed`
- phase: `paymaster`
- raw message: `sanitizeHex is not defined`

This made every paymaster-backed relay submission fail before the Morpheus endpoint was even called correctly.

## Code Fixes

- Imported `sanitizeHex` into `frontend/api/relay-transaction.js`.
- Split relay failure reporting into explicit phases:
  - `simulation`
  - `preview`
  - `paymaster`
  - `relay`
  - `response`
- Added optional operator debug flag:
  - `AA_RELAY_INCLUDE_RAW_ERRORS=1`
- Made `sdk/js/tests/v3_testnet_paymaster_relay.mjs` rerunnable:
  - skip `registerAccount` when the account already exists
  - destroy proxy sockets on shutdown so the local paymaster proxy does not hang on keep-alive connections

## Live Validation Result

Validated live pieces after the fix:

1. Direct Morpheus paymaster authorization against the live CVM worker succeeded.
   - HTTP status: `200`
   - approved: `true`
   - policy id: `testnet-aa`

2. Direct AA relay submission for the same V3 execution path succeeded on testnet.
   - Relay txid: `0xa8492f393bff2f1835cd58aa0117f5ea6594ad5aae71a1effb024899c5ab0022`
   - VM state: `HALT`
   - Gas consumed: `1985658`
   - Return stack: GAS native contract symbol

3. Full live paymaster-backed relay script now succeeds after replacing the unstable stdin SSH bridge with:
   - `phala cp` upload of a helper script to the CVM
   - `phala ssh -- sh /tmp/helper.sh` execution on the CVM

### Successful replay against an existing allowlisted account

- account id: `0x0c3146e78efc42bfb7d4cc2e06e3efd063c01c56`
- relay txid: `0x1d79429b9e8af4115845d7858ddaefcc575dafff2b14a37a000caaea58a0f0bb`
- paymaster approval digest: `bb40b23016f702b3e7e084a977bcba02e595a3054095053294618cf65d630a3c`
- paymaster attestation hash: `e352300442435c80478e09f27328150cdd50dd97e052865f39a410b5cfc5133f`
- execution vmstate: `HALT`
- execution return stack: `GAS`

### Successful full path with new account registration and remote allowlist update

- account id: `0x531a5f4d3a916dffbba3ea372317623fdbbb853c`
- register txid: `0xf79d6a1d3012e9edc64c1a7e40abc932253c7f737873698055ad8f3df8a1869e`
- update verifier txid: `0xed9c97801a757fb0e3d72d641d75a6659c1242c084134234b5e7cd1a81e903d8`
- relay txid: `0x057d4a581efbe815fad0148a3766284da2a33335e72fb50e54d476078d8f40d4`
- paymaster approval digest: `04111a96d6356231c45fdb033ddc91818856c1dc0ac0ce09677ecdb033cae92f`
- paymaster attestation hash: `73849ae405db210d51c28ff63033bc4bb5f2f0886e1a7478c2557e1ac9c39886`
- execution vmstate: `HALT`
- execution return stack: `GAS`

## Final Conclusion

Historical live testnet runs validated the full path:

- `registerAccount`
- `updateVerifier`
- remote paymaster allowlist update
- Morpheus paymaster authorization
- AA relay submission
- on-chain `executeUserOp` execution

The original blocker was an AA relay API bug (`sanitizeHex` missing import), and the remaining intermittent workstation harness failure was resolved by switching the CVM bridge from stdin piping to uploaded helper scripts executed over `phala cp` + `phala ssh`.

Current product readiness should be phrased more narrowly: the on-chain sponsored execution path has testnet evidence, while policy and relay authorization require configured Morpheus/Phala runtime credentials before the frontend can truthfully present gasless relay broadcast as available.

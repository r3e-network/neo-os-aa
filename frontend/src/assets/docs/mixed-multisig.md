# Mixed Multi-Sig (N3 + EVM)

A single Abstract Account can aggregate native Neo witnesses and EVM EIP-712 signatures toward the same threshold.

## Mixed Flow

On the V1/V2 hardened testnet deployment `0x5be915aea3ce85e4752d522632f0a9520e377aaf` (superseded; the canonical shared testnet AA core is now `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2` in `frontend/src/config/generatedMorpheusRegistry.js`), the validator of that time exercised a mixed Neo-relayer + EVM-signer path where:

- the EVM signer authorizes an AA wrapper action with EIP-712 typed data
- the Neo account relays and pays GAS for the transaction
- the contract increments nonces correctly and still enforces whitelist mode and related restrictions

## App Workspace Draft Sharing

The app workspace also supports anonymous share drafts for mixed approval collection. In the frontend, Supabase stores the immutable transaction body, signer requirements, and append-only signatures behind an opaque read-only share slug plus a separate collaborator link for signatures and an operator link for relay/broadcast actions.

That means a coordinator can:

1. stage an AA invocation or transfer in the app workspace
2. persist it to Supabase with a read-only share link plus collaborator and operator links
3. collect EVM approvals or manual Neo signature material from collaborators through the collaborator link while reviewers can stay on the read-only link
4. keep relay checks, final broadcast, and link rotation behind the operator link
5. use the Rotate Collaborator Link or Rotate Operator Link actions when needed to invalidate an older write-capable URL without recreating the draft
6. choose the final client-side wallet broadcast or relay submission path

Shared draft metadata stays intentionally bounded here as well: the frontend keeps only the latest 100 activity entries and the latest 12 submission receipts for each draft so long-lived approval threads stay lightweight.

## Execution Model

Mixed signing does **not** bypass hardening. The combined authorization still has to execute through the canonical V3 runtime entrypoint `executeUserOp` (or `executeUserOps` for a batch). The V1/V2 wrappers `executeUnified` and `executeUnifiedByAddress` were removed and appear in no deployed manifest and no contract source. Direct proxy-signed external calls remain invalid.

## Practical Example

- **Signer A:** Ethereum wallet signs typed data for an AA-managed action routed through `executeUserOp`
- **Signer B:** Neo wallet submits the outer transaction and attaches the native witness
- **Contract:** counts valid authorization across both ecosystems, then enforces whitelist / blacklist / transfer policies before the target call

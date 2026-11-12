# Shared Draft Relay Gate Validation

Date: 2026-06-02

Scope: `frontend/src/views/TransactionInfoView.vue` shared transaction draft relay flow.

## Result

Passed. The shared draft `Submit via Relay` action now requires a successful relay preflight for the exact current relay request payload before it unlocks or submits.

## What Changed

- Replaced the shared draft relay submit gate from `relayReadiness.isReady` to `canRelayBroadcast`.
- Added `currentRelayPreflightRequest` and `relayCheckMatchesCurrentPayload` so stale or missing preflight results cannot unlock relay submission.
- Added a submit-time guard that records a user-visible error receipt when a relay submit is attempted without a matching successful preflight.
- Forwarded `relayPayloadMode`, `morpheusNetwork`, and collected `signatures` into shared draft relay submit so submit uses the same payload family as preflight.

## Verification

- `npm test -- tests/homeOperationsView.test.js tests/transactionDrafts.test.js tests/relayReadiness.test.js tests/relayPreflight.test.js`
  - Result: 295 passing tests.
- `npm run build`
  - Result: production build passed.
- Browser validation through the shared draft UI on `http://127.0.0.1:4197/tx/aa-browser-relay-gate?access=operator-aa-browser-relay-gate`.
  - Initial `Submit via Relay`: disabled.
  - After successful `Check Relay`: enabled.
  - Captured relay preflight request: `simulate: true`, `relayPayloadMode: raw`, raw transaction length `256`.
  - Captured relay submit request: `simulate: false`, `relayPayloadMode: raw`, raw transaction length `256`.
  - Submit receipt and returned txid were visible after submit.
  - Mobile shared draft horizontal overflow: `0`.

Browser evidence:

- `docs/reports/shared-draft-relay-gate-browser/browser-report.json`
- `docs/reports/shared-draft-relay-gate-browser/desktop-before-preflight.png`
- `docs/reports/shared-draft-relay-gate-browser/desktop-after-preflight.png`
- `docs/reports/shared-draft-relay-gate-browser/desktop-after-submit.png`
- `docs/reports/shared-draft-relay-gate-browser/mobile-shared-draft.png`

## Limitation

The browser submit used a mocked relay endpoint to validate frontend behavior and payload integrity. It was not a funded Neo testnet transaction broadcast.

# AA Identity Verification Follow-Up

## Current Deployment Evidence

The canonical https://aa.neoos.network/identity?network=testnet page renders but
reports that Web3Auth is not configured. The frontend Vercel link identifies
neoos-aa-frontend (prj_Des58aLBHoa2Aw31eOZ4KoYff0GF); `vercel env ls production`
reports no production environment variables. Services' AA proxy source targets
https://neoos-aa-frontend.vercel.app. This is not evidence of a functional login,
identity binding, recovery, or private-session workflow.

## Implemented Locally

Previously refreshProfile swallowed server JWT verification failures and fell
back to locally decoded claims or SDK user metadata. bootstrap and the shared
hydration helper also restored browser storage as a connected identity without
authentication. These are frontend trust-boundary defects; this finding does
not assert that a chain verifier accepted a forged identity.

- Require successful server verification with a valid Web3Auth profile before
  setting the connected identity. Verification errors clear previous state and
  propagate instead of falling back to unverified claims.
- Accept token strings and SDK { idToken } results without coercing an object
  into a token string; reject missing/malformed tokens.
- Remove local JWT decoding and local identity derivation fallback code.
- Keep authenticated profile/token state in memory, not localStorage. Remove
  historical aa_connected_did_profile records on hydration/bootstrap. These
  cached login records are intentionally invalidated; users must authenticate
  again. No wallet keys, assets, transaction history, or chain storage is removed.

## Verification

- Targeted identity tests: 11 passed before obsolete source assertions were
  updated to assert the new verified path.
- Full frontend tests after cleanup: 422 passed, 2 skipped, 0 failures.
- Production build: passed.
- Built browser smoke: passed, covering home, identity, app workspace, market,
  and docs. This is local browser coverage, not real Web3Auth authentication.
- Scoped git whitespace check: passed.

At that checkpoint these changes were not deployed. No credentials, provider projects,
allowlists, chain configuration, signatures, or transactions were changed.

## Production Follow-Up (2026-09-12 Asia/Shanghai)

The verified-identity changes and subsequent session lifecycle guards are now
deployed. Client initialization is coalesced and retryable; a generation guard
prevents delayed verification from restoring identity after logout or replacing
a newer profile. Logout clears identity immediately and prevents initialization
or login from continuing through the logout boundary. Six injected-SDK lifecycle
tests exercise the actual service, not a separately reimplemented model.

- Full frontend suite before deployment: 429 passed, 2 skipped, 0 failed.
- Production build and built browser smoke passed.
- Production dependency audit matches the accepted upstream baseline: 16 low,
  13 moderate, no high or critical findings. This is not a zero-vulnerability claim.
- Candidate deployed using `vercel deploy --prod --skip-domain --yes`; READY
  confirmed before promotion. Candidate HTML returned 200; GET verification
  returned 405; forged-token POST returned a configuration error without identity.
- Promoted deployment: `dpl_DLW4gAGwYzXGKsBqpNBm8iEuFYvU`.
- Deployment URL:
  https://neoos-aa-frontend-6qahturu3-jimmys-projects-f05d0acf.vercel.app
- Previous production / rollback: `dpl_SH5WP7sG9YnXkxevas16kFcmrcyR`,
  https://neoos-aa-frontend-1swd2rjmh-jimmys-projects-f05d0acf.vercel.app.
- Rollback, if needed, is a deliberate operation from `frontend`:
  `vercel promote https://neoos-aa-frontend-1swd2rjmh-jimmys-projects-f05d0acf.vercel.app --yes`.

Real Chrome checks on https://aa.neoos.network/identity?network=testnet at
1440x1000 and 390x844 loaded `/assets/index-BLhRr8lS.js`. A seeded forged cached
profile was removed and never rendered as authenticated; no page errors occurred.
The verification API returned GET 405, missing-token POST 400, and forged-token
POST 500 with the specific `WEB3AUTH_CLIENT_ID is not configured` error. The last
response establishes rejection while unconfigured, not working JWT verification.

Reproducible security-only check from `frontend`:
`node tests/identityProduction.e2e.mjs` (optionally set `AA_BROWSER_EXECUTABLE`
to an installed Chrome executable). This script uses real canonical responses,
no request interception, no wallet signing, and no valid user credentials.
JSON and desktop/mobile screenshots are saved under
`.automation-logs/identity-production/1789157218364/` for this successful run.
The script was added after promotion and is local test tooling, not a deployed
runtime change.

Remaining production findings: Web3Auth is still unconfigured, HTML canonical
metadata still points to `neo-aa.org`, and the identity page's mainnet footer
appears even on `?network=testnet`; the latter needs network-routing review, not
an assumption that testnet operations are actually selected. The legacy
`aa_did_connected` auto-reconnect path also remains for subsequent review.
No real login, binding, recovery, private-session, chain write, financial
invariant proof, or all-app acceptance is claimed by these security regressions.

## Network Gate and Canonical Domain Follow-Up

Production now runs `dpl_B86m3x6jxUbTi1WPYSbWyhqRJ4ae`:
https://neoos-aa-frontend-n66x0cqru-jimmys-projects-f05d0acf.vercel.app.
Immediate rollback is `dpl_DLW4gAGwYzXGKsBqpNBm8iEuFYvU`, using the preceding
deployment URL and `vercel promote <url> --yes` from `frontend`.

Investigation confirmed that runtime network comes from deployment configuration;
the URL query previously did not select testnet RPC/contracts. The layout now
blocks child workspaces and connection controls when an explicit network query
differs from that runtime or is malformed/ambiguous. It does not change the
network automatically. An explicit link opens the deployed network's home,
without carrying an operation, account, or draft from the mismatched request.
Both English and Chinese error messages are provided. Full dual-network
frontend/backend operation remains incomplete; the gate is not testnet support
and is not an API authorization boundary.

HTML canonical is now https://aa.neoos.network/. Candidate HTML and served
layout bundle were inspected before promotion. Full frontend unit results:
434 passed, 2 skipped, 0 failed; production build and built browser smoke passed.
The browser smoke now checks mismatch blocking, absent wallet controls, and
explicit return to mainnet at desktop/mobile sizes.

Unintercepted production Chrome checks passed at 1440x1000 and 390x844 using
`tests/identityProduction.e2e.mjs`, loading `/assets/index-BjGUnGuu.js` and the
new canonical metadata. Explicit mainnet opens the identity workspace and
removes forged cached identity. Testnet, invalid, empty and duplicate query
values show the network gate instead of identity/connection controls. Explicit
return opens mainnet home. Evidence and reviewed screenshots:
`.automation-logs/identity-production/1789157573498/`.
Verification API results remain 405 / 400 / missing-provider-config 500;
Web3Auth login is still not accepted.

DevPack `shared/constants/rpc.ts` and MiniApps' vendored copy now use the
canonical AA origin. Their contents match byte-for-byte; two new URL tests cover
all three workspace builders on both networks and preserve the query network.
These shared source changes are not yet published to all application bundles.

Read-only redirect probe also confirmed `explorer.neoos.network` returns 301 to
`https://www.neo3scan.com/address/neo.neo?network=mainnet`, preserving both the
requested path and query. This verifies that redirect case, not all Explorer
functionality or all NNS/Matrix contract aliases.

## Remaining Work

Prepare the existing AA deployment with the correct Web3Auth project client ID,
backend audience/JWKS configuration and canonical origin/redirect whitelist.
Do not borrow another app's identity project blindly or use client-side JWT
decoding as verification. Validate initialization, login cancellation, expired
tokens, logout, account changes, reload, identity binding and recovery with the
real provider, then stage/promote with a recorded rollback deployment. Formal
verification of AA contracts and full platform acceptance remain separate gates.

# Dependency convergence — 2026-10-08

Reviewed against public `main` at `a74e12eec401292c5ba0ebb4a28e19db820f169c` with Node 22.17.1 and npm 10.9.2. Dependency changes were applied to the current manifests and regenerated locks; older bot locks were not used to overwrite intervening security fixes.

## Branch decisions

| PR | Reviewed head | Decision and evidence |
| --- | --- | --- |
| #4 Neon | `ce8c03c8b960550ee0fb59c9408d2195523606e9` | Absorb SDK development dependency 5.10.1. Existing-head CI passed; current public SDK and isolated native SDK package tests also passed. Frontend server dependency remains its separately pinned 5.9.0. |
| #3 TypeScript | `23c9a99b1292fbab3180f07a03a84bf79790e3aa` | Absorb 7.0.2 with compatibility repairs. Reproduced TS5102 for removed `baseUrl`; removed it while preserving relative declaration mappings. Package-consumer tests now resolve the CLI via the package's declared `bin`, because the new exports map rejects the old private subpath. |
| #6 Typography | `a6fb42778f630d546ed46ff00e0d6fbb1c21dfdd` | Absorb 0.5.20 with current lock generation. Original CI failed `npm ci` on missing `utf-8-validate@5.0.10` lock entries. Fresh strict installation passes. |
| #7 Node polyfills | `8dd360e2c5b39203fa8727866faa641d9ab6e9e9` | Absorb 0.28.0 with current lock generation. Same original lock failure; fresh install, Vite build, desktop/mobile browser checks and encrypted recovery pass. |
| #8 Vue Router | `432ee31af5864a9a09ff9c82cf69aba731a06821` | Reject this standalone major upgrade. Published 5.3.1 requires Vite `^7.3.0 || ^8.0.0` and Vue `^3.5.34 || ^4.0.0`; current Vite 6 and plugin-vue 5 produce strict `ERESOLVE`. Keep Router 4; a build-system migration needs its own coordinated change. |
| #9 Web3Auth | `16eb94c60f79f9cfd661586ac924a78faf78e161` | Reject this package-only major upgrade. v11 changes the token API to `getAuthTokenInfo` and changes connector/session behavior. Fix the supported v10 integration in this change instead. Existing PR CI did not test the actual identity API. |

All six reviewed heads had zero submitted reviews and zero review threads at review time. A green bot check alone was not treated as API compatibility evidence. These are integration decisions; closing or deleting remote proposals is a separate repository operation.

## Web3Auth v10 repair

The existing adapter called `authenticateUser`, which is absent from the installed 10.16.0 package. It now calls `getIdentityToken`. Chain settings use `chains` and `defaultChainId`; direct social login passes `authConnection`; login visibility is configured under `modalConfig.connectors.auth.loginMethods`; redirect settings go through `authConnector`.

A real Chromium test loads the installed package's published UMD bundle and exercises its actual identity method through a controlled connector. The old adapter fails before invoking the connector or server verification; the repaired adapter forwards the untrusted token to the mandatory verifier and propagates rejection. A separate test uses a local JWKS server and actual JOSE signatures against the production verification handler: valid tokens pass, while a wrong key, wrong audience, expired token and malformed token fail. Existing stale-login/logout protections remain covered.

These tests prove API compatibility and verification boundaries. They do not prove a live Web3Auth project configuration, OAuth redirect, provider availability or external login. No user credentials or real authentication session were used.

## Security evidence

A fresh all-dependency audit of the original main lock reported frontend 27 low / 2 moderate / 0 high / 0 critical, and SDK zero. The two moderate entries were the typography package and its fixed transitive `postcss-selector-parser@6.0.10` dependency, from [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf). A scoped override to 7.1.6 removes both. All six generated CSS assets remain byte-identical after this parser change.

October 8 checkpoint frontend all-dependency audit: **27 low, zero moderate/high/critical**. Production audit remains the existing reviewed upstream baseline: **19 low, zero moderate/high/critical**. SDK all-dependency and production audits report zero. The normal frontend gate now checks both production and all-dependency audits, with moderate or higher blocking the latter.

GitHub still returned 41 open alerts (13 high / 21 medium / 7 low). Every alert's manifest, package and vulnerable semver range was compared against all corresponding nested lock entries: **zero matched**. Current affected-package versions included baseline-browser-mapping 2.11.21, browserslist 4.28.9, nanoid 3.3.18, stream-json 3.6.0, postcss 8.5.28, DOMPurify 3.4.15, Mermaid 11.17.2, socket.io-parser 4.2.7, Vite 6.4.3, ws 7.5.12/8.21.0/8.21.1, esbuild 0.25.12, uuid 11.1.1 and js-cookie 3.0.8. This establishes that those returned alert ranges did not match this snapshot; it does not claim GitHub has closed them or that low-severity upstream issues have disappeared.

## Validation

- Public SDK: 116 unit tests, declaration check, and four isolated real npm tarball consumer tests passed.
- Current native SDK source copied with its real contract artifacts, docs and frontend fixtures into an isolated directory: 154 unit tests, declaration check and four real package-consumer tests passed with Neon 5.10.1 / TypeScript 7.0.2.
- Frontend: 571 passed, three existing tests skipped; production build passed.
- Desktop/mobile routes, navigation, network-mismatch guard, encrypted operator recovery and published Web3Auth package contract passed in Chromium. The identity page correctly displays the unconfigured state without claiming a logged-in identity.
- The published-package browser regression is part of the normal frontend verification gate. Native-chain admission, signatures and execution remain separate proof obligations.

## October 9 client and security completion

DOMPurify is now pinned to 3.4.16 and Mermaid's KaTeX dependency to 0.18.2. Actual Chromium regressions cover the fixed inherited-trust URL issue and safe Mermaid/math rendering. Production retains 19 low affected packages; the complete tree retains 24. Every remaining finding propagates from the single unpatched Elliptic advisory `GHSA-848j-6mx2-7j84`. The audit gate accepts only that advisory at at most low severity; registry errors, malformed reports, unknown advisories and severity increases fail. See [the security assessment](FRONTEND_DEPENDENCY_SECURITY.md) for actual exposure and why a forced Web3Auth upgrade is not a fix.

The identity provider is deferred at the production bundle boundary. Browser tests verify initial routes do not request the Elliptic-containing chunk, then load and construct the actual bundled Web3Auth provider to catch initialization cycles. Public configuration presets now match shipped ABI types and argument order, use fresh millisecond SessionKey expiry and explicit verifier/hook destinations, and clearly describe public multisignature thresholds as module counts.

The combined public client gate passes without skipped tests, including the required sibling-services checks, SDK declarations and four installed-tarball consumer tests. These local and CI gates do not establish a live OAuth session or public-chain deployment. PR #14 contains these client changes and the four absorbed dependency upgrades; native core and native module acceptance remain separate.

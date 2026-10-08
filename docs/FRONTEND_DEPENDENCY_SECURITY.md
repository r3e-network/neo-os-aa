# Frontend dependency security assessment

Reviewed on 2026-10-09. The frontend's remaining low-severity audit entries
originate from one Elliptic advisory, including findings propagated to dependent
packages. They are a known upstream risk, not a zero-vulnerability result.

## Patched renderers

- DOMPurify is pinned to **3.4.16**, which fixes
  [GHSA-p98j-92pf-mc4p](https://github.com/cure53/DOMPurify/security/advisories/GHSA-p98j-92pf-mc4p)
  and [GHSA-6688-9rhm-gjv2](https://github.com/cure53/DOMPurify/security/advisories/GHSA-6688-9rhm-gjv2).
  These concern `IN_PLACE` sanitization. The reviewed Mermaid code sanitizes a
  serialized SVG string, and the application does not enable `IN_PLACE`.
- Mermaid's KaTeX dependency is overridden to **0.18.2**, fixing
  [GHSA-238p-pmpm-9mq7](https://github.com/KaTeX/KaTeX/security/advisories/GHSA-238p-pmpm-9mq7).
  This flaw requires pre-existing prototype pollution or control of the renderer
  options' prototype; it does not itself introduce prototype pollution.
  The scoped override crosses Mermaid's declared `^0.16.47` range. The application
  uses the stable `renderToString` API through Mermaid and has Chromium coverage
  for flowcharts, sequence diagrams, fractions, square roots, malicious HTML,
  JavaScript links, and inherited `trust` options. See the
  [KaTeX API](https://katex.org/docs/api) and
  [0.18.2 release](https://github.com/KaTeX/KaTeX/releases/tag/v0.18.2).

Documentation renderers are loaded lazily from `DocsView.vue`; document content
comes from the repository's fixed loader registry. Mermaid and KaTeX are listed
as development dependencies but ship in browser chunks, so a production-only
dependency audit is insufficient. Both dependency scopes are checked.

## Remaining Elliptic risk

[GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84)
affects Elliptic through 6.6.1. At review time, 6.6.1 was the latest published
release and the advisory listed no patched version. The upstream
[signature-truncation report](https://github.com/indutny/elliptic/issues/321)
describes incorrect handling of some curve/digest combinations and concern
about attacker-chosen prehashes. An application-specific key-exposure exploit
has not been demonstrated here; this is not evidence that the dependency is safe.

Elliptic is used by the active Web3Auth/Torus dependency tree. In the inspected
installed code, Torus metadata signing uses secp256k1 with 32-byte Keccak digests,
and `@toruslabs/eccrypto` accepts at most 32-byte messages for that curve. Other
transitive paths include Starkware/XRPL support and the `crypto-browserify`
polyfill. Those branches cannot all be declared harmless or unreachable merely
because the application currently exposes an identity login flow.

The native workspace has no direct import of the Web3Auth modal runtime.
`didService` imports it only when initializing the identity client; identity
reconnection is another possible trigger in views using `useDidConnection`.
However, a fresh Chromium visit to the production `/native` route still loads
the shared `identity-runtime` chunk containing Elliptic. Dynamic import at the
service boundary does not establish that all of its cryptographic dependencies
are absent from other routes. Loading that code does not by itself demonstrate
a vulnerable signing call. Native wallet operations are handed to the external wallet. The native Node SDK
accepts caller-provided transaction signers and verifies their P-256 signatures
with Node crypto. This separation does not remove the frontend dependency risk.

Upgrading Web3Auth to 11.4.2 is **not** a complete Elliptic fix: the published
[`@web3auth/no-modal` 11.4.2 manifest](https://registry.npmjs.org/@web3auth/no-modal/11.4.2)
still depends on `ripple-keypairs ^1.3.1` and `xrpl ^2.14.0`;
[`ripple-keypairs` 1.4.0](https://registry.npmjs.org/ripple-keypairs/1.4.0)
still depends on Elliptic. Although newer Torus crypto packages use Noble, forcing
them under older callers is not a verified compatible replacement. The separate
polyfill path also remains. No Web3Auth major migration, custom cryptography patch,
or audit-suggested polyfill downgrade is included in this change.

## Audit policy and validation

`npm run audit:prod` and `npm run audit:all` resolve every reported dependency
finding to its advisory leaves. Only **GHSA-848j-6mx2-7j84 for Elliptic, at most
low severity**, is accepted. There is no package-name or moderate-severity
exception. A new advisory on an already known package also fails. Invalid JSON,
registry error objects, missing or unknown severity, incomplete reports,
inconsistent counts, and unresolved advisory paths fail closed.

The gate requires a fresh successful npm audit report. Exceptions must be removed
when a compatible upstream fix exists; broadening the accepted advisory set
requires a separate review. A passing audit gate does not establish protocol,
deployment, or signing safety.

Reproduce the focused validation from `frontend/`:

```sh
npm ci
node --test tests/frontendAuditPolicy.test.js tests/frontendAuditBaseline.test.js
npm run audit:prod
npm run audit:all
npm run test:docs-security:browser
```

The repository frontend verification command also includes this browser security
test alongside the production build, unit tests, and existing browser tests.

# Dependency remediation — 2026-09-17

## Scope and changes

Reviewed all 41 open GitHub Dependabot alerts against their package-specific
`security_vulnerability.vulnerable_version_range` and every matching package
entry in the frontend and SDK lockfiles (not only top-level versions).

The previous source synchronization already included patched versions for most
alerts. The remaining match was GHSA-w5hq-g745-h8pq: nested uuid 8.3.2 and 9.0.1.
Added an override to uuid 11.1.1, which retains CommonJS and ESM exports, and
removed seven obsolete nested installations. Added regression tests for the
resolved versions and the v4/validate/version/parse/stringify API surface.

## Verification

- All 41 fetched alert ranges: zero matching versions after remediation;
  the two manifest-level Vite ranges also do not intersect the affected range.
- Frontend npm audit (including development dependencies): 34 affected packages
  before (21 low, 13 moderate), 24 after (24 low, zero moderate/high/critical).
  These counts include transitive dependents, not distinct root advisories.
- SDK npm audit: zero vulnerabilities.
- Frontend tests: 436 passed, two skipped, zero failed (438 total).
- Frontend Vite production build: passed.
- No live login/signing end-to-end test or deployment was performed.

## Remaining risk — not fixed or dismissed

GHSA-848j-6mx2-7j84 remains in elliptic 6.6.1, brought in by the
Web3Auth/Torus and browser crypto-polyfill dependency trees. At review time,
6.6.1 was the latest published elliptic version and remained affected.
The 24 low-severity npm audit entries derive from this root advisory.

No advisory was dismissed, no new allowlist exemption was added, and no forced
major SDK upgrade was performed. Removing this risk requires a separately
validated migration away from these elliptic consumers, including authentication,
key derivation and signing interoperability tests. Passing a build or unit tests
does not establish the absence of cryptographic side-channel risk.

GitHub may update alert state asynchronously after the commit is pushed;
local range comparison is not proof that GitHub has closed the alerts.

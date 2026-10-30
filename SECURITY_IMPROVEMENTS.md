# Security & Production Readiness Improvements — Historical Note (2026-03-09)

> **Historical document.** This note records a hardening slice implemented on
> 2026-03-09 against the pre-V3 contract tree. The `contracts/SmartAccount.*`
> files it references were removed in the V3 rewrite
> (`contracts/SmartAccount*.cs`), so individual entries are annotated
> below with where the protection lives today. For the current security
> reference, see `docs/SECURITY_MODEL.md` (threat model, trust assumptions,
> defense-in-depth) and `docs/SECURITY_AUDIT_RESULTS.md`.

## Implemented Changes

### 1. Smart contract input validation
- **File (historical)**: `contracts/SmartAccount.MetaTx.cs` — removed in the V3 rewrite
- **Change**: added explicit 65-byte uncompressed pubkey length validation before signature verification
- **Why**: rejects malformed pubkey payloads earlier in the meta-tx flow
- **Where it lives now**: `contracts/verifiers/Web3AuthVerifier.cs` asserts `uncompressedPubKey.Length == 65` on setup and `pubKey.Length == 65` on verification

### 2. Project isolation for repo-wide C# builds
- **File (historical)**: `contracts/SmartAccount.csproj` — removed in the V3 rewrite
- **Change**: disabled default compile globbing and explicitly included the intended contract sources
- **Why**: prevents `contracts/recovery/obj` intermediates from polluting the main contract build
- **Where it lives now**: `contracts/SmartAccount.csproj` keeps `EnableDefaultCompileItems=false` with explicit `<Compile Include=...>` entries

### 3. Relay and operator API rate limiting
- **Files**: `frontend/api/rateLimiter.js`, `frontend/api/relay-transaction.js`, `frontend/api/draft-operator.js`
- **Change**: added a simple in-memory request limiter and `Retry-After` responses on 429s
- **Why**: reduces abuse risk for relay/operator endpoints and gives clients a usable retry signal

### 4. Relay error sanitization
- **File**: `frontend/api/relay-transaction.js`
- **Change**: normalizes exposed error messages for common VM / auth / nonce / expiry failures
- **Why**: avoids leaking raw internal exception details back to clients

### 5. Frontend security headers
- **File**: `frontend/vercel.json`
- **Change**: adds `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`, and `Permissions-Policy`
- **Why**: improves browser-side baseline protections for the deployed frontend

### 6. Draft query indexes
- **File**: `supabase/migrations/20260309_add_performance_indexes.sql`
- **Change**: adds indexes for `share_slug`, `operator_slug`, `collaboration_slug`, `status`, and descending `created_at`
- **Why**: improves common draft lookup/query paths
- **Note**: the migration chain was later reworked to be replayable on a fresh database; the file remains but its contents have evolved past this entry

## Verification Run At The Time (2026-03-09)

```bash
cd frontend && npm test -- tests/apiSecurity.test.js
cd frontend && npm run build
dotnet test SmartAccount.sln -c Release --nologo
node --test sdk/js/tests/projectIsolation.unit.test.js
```

`sdk/js/tests/projectIsolation.unit.test.js` was removed along with the pre-V3
tree it tested; the remaining commands still exist.

## Notes

- This file is a factual implementation summary, not a formal third-party audit.
- Current security documentation: `docs/SECURITY_MODEL.md`, `docs/SECURITY_AUDIT.md`, `docs/SECURITY_AUDIT_RESULTS.md`, `docs/PLUGIN_MATRIX.md`.

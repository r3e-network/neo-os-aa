# Neo Abstract Account Professionalization Implementation Plan


**Goal:** Refactor the Neo Abstract Account stack so the core account model, plugins, relay, SDK, and docs look like a production AA system rather than a feature-accumulated prototype.

**Architecture:** Keep the current Neo-specific `accountId`-first and zero-deployment model, but align the public contract surface with the lessons that held up in Ethereum AA: one canonical execution boundary, standardized account capability introspection, explicit module lifecycle semantics, simulation-friendly validation, and narrow signer/sponsor trust boundaries. Preserve Neo-native strengths while removing ambiguity and duplicated logic.

**Tech Stack:** Neo N3 smart contracts in C#, Node.js SDK/tests, Vue/Vite frontend, Vercel server routes, ERC-4337 / ERC-7579-inspired account patterns.

### Task 1: Normalize The Account Interface

**Files:**
- Modify: `contracts/UnifiedSmartWallet.State.cs`
- Modify: `contracts/UnifiedSmartWallet.Accounts.cs`
- Modify: `contracts/UnifiedSmartWallet.Models.cs`
- Modify: `sdk/js/src/index.js`
- Test: `sdk/js/tests/v3_flow.unit.test.js`

**Step 1: Write the failing test**

Add tests that expect:
- a stable account implementation identifier,
- explicit support checks for execution modes,
- explicit support checks for verifier/hook module categories,
- explicit installation checks for the currently bound verifier/hook.

**Step 2: Run test to verify it fails**

Run: `cd sdk/js && node --test tests/v3_flow.unit.test.js`
Expected: FAIL because the new account introspection helpers do not exist yet.

**Step 3: Write minimal implementation**

Add read-only methods to the core contract for:
- account implementation identifier,
- supported execution modes,
- supported module types,
- installed verifier/hook checks.

Mirror those helpers in the SDK with thin read-only wrappers.

**Step 4: Run test to verify it passes**

Run: `cd sdk/js && node --test tests/v3_flow.unit.test.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add contracts/UnifiedSmartWallet.State.cs contracts/UnifiedSmartWallet.Accounts.cs contracts/UnifiedSmartWallet.Models.cs sdk/js/src/index.js sdk/js/tests/v3_flow.unit.test.js
git commit -m "feat: add standards-aligned account introspection"
```

### Task 2: Formalize Module Lifecycle Semantics

**Files:**
- Modify: `contracts/UnifiedSmartWallet.Accounts.cs`
- Modify: `contracts/UnifiedSmartWallet.State.cs`
- Modify: `docs/architecture.md`
- Test: `sdk/js/tests/v3_flow.unit.test.js`

**Step 1: Write the failing test**

Add tests that expect clear lifecycle event naming and clear distinction between:
- module installation,
- module replacement initiation,
- module replacement confirmation,
- module removal.

**Step 2: Run test to verify it fails**

Run: `cd sdk/js && node --test tests/v3_flow.unit.test.js`
Expected: FAIL because the current semantics are verifier/hook-specific and not normalized.

**Step 3: Write minimal implementation**

Normalize event names and docs around a single conceptual module lifecycle while preserving backward compatibility where possible.

**Step 4: Run test to verify it passes**

Run: `cd sdk/js && node --test tests/v3_flow.unit.test.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add contracts/UnifiedSmartWallet.Accounts.cs contracts/UnifiedSmartWallet.State.cs docs/architecture.md sdk/js/tests/v3_flow.unit.test.js
git commit -m "refactor: normalize verifier and hook lifecycle semantics"
```

### Task 3: Add Simulation-Grade Validation Surface

**Files:**
- Modify: `contracts/UnifiedSmartWallet.Execution.cs`
- Modify: `contracts/UnifiedSmartWallet.State.cs`
- Modify: `frontend/api/relay-transaction.js`
- Modify: `frontend/src/features/operations/metaTx.js`
- Test: `frontend/tests/relayPreflight.test.js`
- Test: `sdk/js/tests/v3_flow.unit.test.js`

**Step 1: Write the failing test**

Add tests that expect a read-only validation/preflight path which reports:
- deadline validity,
- nonce acceptability,
- verifier presence,
- current verifier/hook bindings.

**Step 2: Run test to verify it fails**

Run:
- `cd sdk/js && node --test tests/v3_flow.unit.test.js`
- `cd frontend && node --test tests/relayPreflight.test.js`

Expected: FAIL because no formal validation preview exists.

**Step 3: Write minimal implementation**

Expose a read-only preview method in the core and consume it from relay/frontend preflight flows instead of inferring readiness from partial RPC calls.

**Step 4: Run test to verify it passes**

Run the same commands and confirm PASS.

**Step 5: Commit**

```bash
git add contracts/UnifiedSmartWallet.Execution.cs contracts/UnifiedSmartWallet.State.cs frontend/api/relay-transaction.js frontend/src/features/operations/metaTx.js frontend/tests/relayPreflight.test.js sdk/js/tests/v3_flow.unit.test.js
git commit -m "feat: add validation preview surface for relay and SDK"
```

### Task 4: Collapse Duplicated Verifier Payload Logic

**Files:**
- Modify: `contracts/verifiers/SessionKeyVerifier.cs`
- Modify: `contracts/verifiers/TEEVerifier.cs`
- Modify: `contracts/verifiers/WebAuthnVerifier.cs`
- Create: `contracts/verifiers/VerifierPayload.cs`
- Test: `sdk/js/tests/v3_flow.unit.test.js`
- Test: `sdk/js/tests/v3_testnet_plugin_matrix.js`

**Step 1: Write the failing test**

Add tests that verify the payload bytes for the secp256r1-based verifier family stay identical after refactor.

**Step 2: Run test to verify it fails**

Run: `cd sdk/js && node --test tests/v3_flow.unit.test.js`
Expected: FAIL because the shared helper does not exist yet.

**Step 3: Write minimal implementation**

Extract the shared payload-building logic into one helper file and rewire the three verifier contracts to use it.

**Step 4: Run test to verify it passes**

Run: `cd sdk/js && node --test tests/v3_flow.unit.test.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add contracts/verifiers/VerifierPayload.cs contracts/verifiers/SessionKeyVerifier.cs contracts/verifiers/TEEVerifier.cs contracts/verifiers/WebAuthnVerifier.cs sdk/js/tests/v3_flow.unit.test.js
git commit -m "refactor: share canonical payload builder across native verifiers"
```

### Task 5: Tighten Production Surface And Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/SECURITY_AUDIT.md`
- Modify: `frontend/src/assets/docs/architecture.md`
- Test: `frontend/tests/docsRendering.test.js`

**Step 1: Write the failing test**

Add tests that require:
- explicit production/runtime boundaries,
- explicit compatibility-only legacy notes,
- explicit unsupported verifier status,
- explicit relay/paymaster trust assumptions.

**Step 2: Run test to verify it fails**

Run: `cd frontend && node --test tests/docsRendering.test.js`
Expected: FAIL if docs drift from the intended professionalized runtime model.

**Step 3: Write minimal implementation**

Update docs to describe the refactored account contract as the canonical surface and remove ambiguous or over-marketing language where it obscures actual guarantees.

**Step 4: Run test to verify it passes**

Run: `cd frontend && node --test tests/docsRendering.test.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add README.md docs/architecture.md docs/SECURITY_AUDIT.md frontend/src/assets/docs/architecture.md frontend/tests/docsRendering.test.js
git commit -m "docs: align AA documentation with production runtime model"
```

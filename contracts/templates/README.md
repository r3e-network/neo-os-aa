# Plugin Templates

The fastest correct path to a new SmartAccount verifier or hook: copy a template,
rename it, replace one method, compile, bind.

| Template | Directory | Replace this | You get |
| --- | --- | --- | --- |
| Verifier | `verifier/` | `validateSignature` | single-key secp256r1 authorization |
| Hook | `hook/` | `preExecute` | fail-closed per-account target gate |

## Three steps

```sh
# 1. Copy the template into your own directory and rename class + DisplayName.
cp -r verifier /path/to/your/plugin/MyVerifier

# 2. Edit the policy: validateSignature (verifier) or preExecute (hook).
#    Keep every ceremony method — the core refuses to bind an incomplete ABI.

# 3. Compile and check the bind-time ABI before deploying.
node ../../scripts/check_plugin_templates.mjs   # if kept in-tree
nccs ./MyVerifier.csproj -o build               # or compile standalone
```

## What the template carries for you

- **Exact binding ABI** — `supportsV3` marker plus `validateSignature` /
  `preExecute` / `postExecute` / `clearAccount` in the shapes the core's
  bind-time gate (`AssertV3Verifier` / `AssertV3Hook`) demands.
- **Authority plumbing** — every configuration write is gated through the SA
  core (`canConfigureVerifier` / `canConfigureHook`), every execution callback
  proves it runs inside the core's context (`canExecuteVerifier` /
  `canExecuteHook`).
- **Lifecycle safety** — `clearAccount` wipes account-scoped state so rotations,
  escapes and market transfers never hand over a dirty shell.
- **Governance rails** — timelocked self-upgrade, timelocked admin rotation and
  timelocked core re-pointing (7 days each), wired through the shared
  `VerifierAuthority` / `HookAuthority` layer the shipped plugins use.
- **Canonical payload** — the verifier template signs
  `VerifierPayload.BuildPayload` output, which already binds network id, account
  id, verifier, core, target, method, args, nonce and deadline.

## The rules that bite

1. **Never widen the manifest permissions.** The wildcard grants in the
   templates point at exactly the core callbacks the authority layer needs.
2. **Validation stays read-only and boolean.** Reject by returning `false`;
   reserve faults for malformed input. A `validateSignature` that writes
   storage is a critical finding (PG-02).
3. **Hooks fail closed.** An unconfigured account must reject, not pass.
4. **Storage is account-scoped.** Every key starts from
   `AccountKey(prefix, accountId)`; no plugin-global admin state.
5. **`clearAccount` must be idempotent and total.** The core calls it on every
   rotation regardless of whether the plugin was ever configured, and a fault
   aborts the enclosing transition.

The full security checklist, payload format and testing guidance live in
[`docs/PLUGIN_DEVELOPER_GUIDE.md`](../../docs/PLUGIN_DEVELOPER_GUIDE.md). The
deployed-spelling rule (manifests carry camelCase names) is explained there in
§3.1; the templates already compile to it.

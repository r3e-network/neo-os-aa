# Plugin Templates

Start with the [common module NEP](../../../docs/proposals/nep-smartaccount-module-interface.mediawiki)
for discovery, lifecycle and callback signatures. Implement the corresponding
[named clause](../../../docs/proposals/nep-smartaccount-module-profiles.mediawiki) only if
your module promises that behavior. A new kind of module can implement the common interface alone.

| Template | Directory | Replace this | You get |
| --- | --- | --- | --- |
| Validator | `validator/` | `ValidateUserOp` | single-key secp256r1 authorization |
| Hook | `hook/` | `PreCheck` | fail-closed per-instance target gate |

## Three steps

```sh
# From the repository root, check the shipped starters.
node scripts/check_plugin_templates.mjs

# In your own project, adapt the template, preserve its shared source references,
# and set the class, manifest name and discovery JSON to describe your module.
nccs /path/to/MyValidator.csproj -o /path/to/build

# Supply the exact UTF-8 bytes your getModuleProfile returns (no trailing newline).
python3 scripts/check_module_neps.py --profile /path/to/MyValidator.profile.json \
  --manifest /path/to/build/MyValidator.manifest.json --nef /path/to/build/MyValidator.nef
```

## What the template carries for you

- **Common module ABI** — `getModuleProfile`, `onInstall` / `onUninstall` /
  `configure`, and the callback pair the core checks at install
  (`AssertCallbackAbi` in `contracts/native/SmartAccount/SmartAccountModulePolicy.cs`).
- **Instance identity** — every key starts from
  `InstanceKey(prefix, accountId, moduleId)`; the instance is resolved from the
  core's writer phase (`RequireLifecycle` / `RequirePreCheck` / `RequirePostCheck` /
  `RequireValidation`), never from a caller-declared id.
- **Canonical capability profile** — the `ModuleProfileJson` literal is sorted-key,
  whitespace-free JSON whose SHA-256 is the profile digest bound at install
  (spec §12). Hooks may not claim message or threshold capabilities.
- **Lifecycle safety** — `OnUninstall` deletes every instance-scoped key so a
  removed policy never leaves a dirty shell behind.
- **Governance rails** — timelocked self-upgrade, timelocked admin rotation and
  timelocked core re-pointing (7 days each), wired through the shared
  `ValidatorAuthority` / `HookAuthority` layer the shipped plugins use.
- **Canonical digest** — the validator template signs
  `ValidatorPayload.SigningDigest`, which binds the core operation digest, account,
  instance and credential generation.

## The rules that bite

1. **Never widen the manifest permissions.** The wildcard grants in the templates
   point at exactly the core callbacks the authority layer needs.
2. **Validation stays read-only and boolean.** Reject by returning `false`; reserve
   faults for malformed input. A `validateUserOp` that writes storage is a critical
   finding.
3. **Hooks fail closed.** An unconfigured instance must reject, not pass.
4. **Storage is instance-scoped.** Every key starts from
   `InstanceKey(prefix, accountId, moduleId)`; no plugin-global admin state.
5. **`OnUninstall` must be idempotent and total.** The core calls it on uninstall
   regardless of whether the instance was ever configured, and a fault aborts the
   enclosing configuration action.
6. **Composition is core-owned.** Do not chain child modules; the core's
   `hookOrder` and threshold policies are the only composition points, and
   `MultiHook` rejects new installs.

The full security checklist, digest format and testing guidance live in the
"Appendix: Module developer guide" of
[`docs/SA-MODULE-PROTOCOL.md`](../../../docs/SA-MODULE-PROTOCOL.md) and in the
protocol chapters above it. Manifests carry
camelCase method names; the templates already compile to that.

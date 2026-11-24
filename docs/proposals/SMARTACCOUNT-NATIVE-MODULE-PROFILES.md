# SmartAccount native module packaging

The core, SDK and module packager use the [current parameters](smartaccount-native-profile-parameters.json). The [package descriptor](../../contracts/plugins/native-profile/profiles.json) identifies the six validators and hooks built by the packager. Packaging preserves compiler NEF and manifest bytes and checks the permission allowlist, callbacks, NEF checksum and `native-smartaccount` marker. See the [standard modules](../../contracts/modules/README.md) for governance, signing and threshold policies.

During installation, the core reads the module's own `getModuleProfile` and binds its code and profile. This module fingerprint is distinct from the kernel's protocol parameter fingerprint. The protocol and modules are unpublished. Two builds producing the same bytes establish reproducibility, not activation or implementation refinement.

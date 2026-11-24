# Native SmartAccount review map

This repository's candidate for the [native SmartAccount discussion](https://github.com/neo-project/proposals/issues/242) uses the [core protocol NEP](nep-smartaccount-entry-verifier.mediawiki), [module interface](nep-smartaccount-module-interface.mediawiki) and [named module profiles](nep-smartaccount-module-profiles.mediawiki). All three are local drafts. This map identifies review evidence; it does not record upstream acceptance.

| Review area | Current rule | Evidence and remaining boundary |
| --- | --- | --- |
| Native identity and activation | The account identifier is distinct from the receiving address. Registration and discovery are specified in §§9 and 14 of the [protocol](../SA-MODULE-PROTOCOL.md). | [Native profile](../../contracts/native/profile.json) identifies the candidate and tracks public activation and artifact readback separately. |
| Account and module state | §§2–3 and 7 define instance identity, limits, state and code bindings. Governance stores confirmed policy bodies; the core enforces mandatory spending. | [Module catalogue](smartaccount-named-module-interfaces.json) and [native tests](../../tests/SmartAccount.Native.Tests) cover different layers. A matching module ABI does not establish policy behavior. |
| UserOperation | §§4–6 specify the 13-field array, digest, nonce channel and generations. §9 defines single and batch execution. | [Operation and nonce vectors](../../tests/fixtures/sa-module-protocol/golden-vectors) aid independent implementations. A match on one vector does not prove all encodings. |
| Resources and fees | §11 specifies callback and aggregate budgets for the execution phases. | [Parameters](smartaccount-native-profile-parameters.json) bind the limits. General fee and resource refinement remains open. |
| Witness and wallet integration | The spending route and the original caller's message-signature domain are distinct. | The [SDK](../SDK.md) describes registration and transaction construction. Local execution does not establish deployed addresses, inclusion or finality. |
| Governance and recovery | §§9–10 specify direct administration, confirmed proposals, mandatory threshold enrollment and the preset delayed recovery path. | The [named governance and recovery clauses](nep-smartaccount-module-profiles.mediawiki) describe the standard providers. Independent consensus acceptance and public activation remain open. |

For the exact public surface, read the [native ABI fixture](../../tests/fixtures/native-smartaccount.manifest.json). For open release gates, read the [implementation profile](../../contracts/native/profile.json). Neither document certifies the separate ordinary-contract NEF.

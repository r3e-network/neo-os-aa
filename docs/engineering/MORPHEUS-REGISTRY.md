# External wallet service registry

These records describe external Morpheus services and experimental contracts. None is a deployment of the unpublished native SmartAccount protocol. Registry labels identify external entries only.

## Canonical Morpheus Network Anchors

When this repo references Morpheus-integrated addresses, treat the following as the current canonical Neo N3 anchors. They restate `frontend/src/config/generatedMorpheusRegistry.js`, which is generated from neo-os-services and wins on any conflict; `frontend/tests/morpheusRegistryDocs.test.js` keeps the addresses and domains below equal to it.

| Item | Mainnet | Testnet |
| --- | --- | --- |
| SA core | `0x0268a387913b250166ddec032b03332690a1ef78` | `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2` |
| SA runtime label | `SmartAccountV3` | `SmartAccountV3` |
| Morpheus Oracle | `0xf54d8584ef82315c1800373272ab08ae0db2d5ef` | `0xf54d8584ef82315c1800373272ab08ae0db2d5ef` |
| Morpheus DataFeed | `0x03013f49c42a14546c8bbe58f9d434c3517fccab` | `0x9bea75cf702f6afc09125aa6d22f082bfd2ee064` |
| Oracle callback consumer | `0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844` | `0x0ac1fa9cdcb66c1672f0642f62d767902f460f2b` |
| NeoDIDRegistry | `0xb81f31ea81e279793b30411b82c2e82078b63105` | unpublished in the shared registry |
| SA Web3AuthVerifier | `0xf5c452cd4ba29dcdc47026383568c0d8b38d9272` | `0x1111f5b6b046a964c75d208998c13945ce172e85` |
| SocialRecoveryVerifier v2 | `0x198b3a9cec9bccc2110d19bd929b10374a9d034d` | unpublished in the shared registry |

The Morpheus Oracle (MiniApp-OS kernel v2) has the same contract hash on mainnet and testnet.

Domain rules:

- mainnet SA domain: `smartwallet.neo`
- mainnet SA additional alias: `sa.morpheus.neo`
- mainnet NeoDID domain: `neodid.morpheus.neo`
- testnet currently has no shared SA / NeoDID NNS aliases
- mainnet oracle domain: `oracle.morpheus.neo`

Current published Morpheus CVM attestation anchors:

- Oracle request/response CVM: `oracle-morpheus-neo-r3e` / `ddff154546fe22d15b65667156dd4b7c611e6093`
- Oracle attestation explorer: `https://cloud.phala.com/explorer/app_ddff154546fe22d15b65667156dd4b7c611e6093`
- DataFeed CVM: `datafeed-morpheus-neo-r3e` / `ac5b6886a2832df36e479294206611652400178f`
- DataFeed attestation explorer: `https://cloud.phala.com/explorer/app_ac5b6886a2832df36e479294206611652400178f`

Do not conflate the SA recovery service with the independent NeoDID registry:

- `SocialRecoveryVerifier` is the registered SA-specific recovery service entry; the registry describes an external service, not a SmartAccount protocol release
- `NeoDIDRegistry` is the independent Morpheus identity / action-ticket registry


Registry identity notes:

- The canonical mainnet SA anchor is `0x0268a387913b250166ddec032b03332690a1ef78` and resolves from `smartwallet.neo` plus `sa.morpheus.neo`.
- The canonical shared testnet SA anchor is `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2`, with shared `Web3AuthVerifier` `0x1111f5b6b046a964c75d208998c13945ce172e85`.

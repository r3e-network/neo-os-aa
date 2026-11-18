# neo-os-sa in the NeoOS architecture

This file is a pointer, not an authority. The enforced binding is the `Architecture authority`
section of `README.md`, declared in `neo-os-web/docs/workspace/neoos-target-architecture.v1.json`
and checked by `npm run check:architecture-sources` in `neo-os-web`. The proposed successor is
`neoos-target-architecture.v2.json` (status `PROPOSED`), checked by `npm run check:architecture:v2`;
its design is `neo-os/claudedocs/NEOOS-TARGET-ARCHITECTURE-V2-20260921.md`.

## v1 binding (enforced)

| Component | Plane | Published interfaces |
| --- | --- | --- |
| `protocol-sa-core` | protocol plane | interfaces: SmartAccountV3, UserOperation, SAAuthorization |

## v2 binding (proposed)

Repository layer: `L1` (chain-protocol).

| Component | Layer | Ownership |
| --- | --- | --- |
| `C03` account | L1 | owns: SmartAccount core, verifiers, hooks, paymaster… | must not own: did-eligibility, network-identity, signer-selection |

### Declared moves out of this repository

| Path | Destination |
| --- | --- |
| `sdk/js` | C10 |
| `frontend` | C23 |
| `frontend/api` | C14 |
| `supabase/migrations` | C14 |

No deployment or production status is asserted here. Status is generated, never written:
see `neo-os-web/docs/workspace/ARCHITECTURE-STATUS.generated.md`.

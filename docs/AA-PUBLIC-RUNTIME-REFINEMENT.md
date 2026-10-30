# Public sponsored-entry runtime refinement

This suite executes the unchanged candidate NEF through its original public
`executeSponsoredUserOp` and `executeSponsoredUserOps` ABI using the base Neo
ApplicationEngine 3.10.1. It retains registration, native owner witness checks,
operation validation, nonce/locking, real AAPaymaster policy and GAS settlement.
The purpose is independent finite runtime evidence for the formal bridge, not a
universal compiler/VM refinement proof.

The tests observe the real core's single serialized reimbursement record at key
`0x21` before paymaster discovery and target callbacks. Two public calls share a
transaction fee budget; different-account nesting must see an outer reservation;
same-account nesting must fail the actual account lock. Later validation,
settlement, parent-script, read-only and gas failures must preserve original
committed account, sponsor and relay state.

Setup uses the existing RuntimeFixture deployment/account/policy facilities.
The measured public invocation uses a genuine base ApplicationEngine with a
separate hosting GAS allowance; TestEngine.Fee cannot supply that allowance
because it changes Transaction.NetworkFee. Transaction signer scopes are supplied
by the harness, and witnesses are not cryptographically verified. A test-only
adversarial target may call the original public ABI; it never substitutes core
validation, private helper execution, or the real paymaster.

Each invocation uses a cloned application snapshot. Successful cross-contract
frames commit to their parent according to the pinned engine. The harness commits
the outer transaction cache only on HALT and discards it on FAULT. Pending parent
writes can therefore exist after an outer abort without reaching the original
store. This is an explicit hosting policy consistent with native application
execution; it does not execute block persistence, sender funding checks, witness
verification, or native fee burning. Zero-fee vectors represent RPC estimation.

Native StdLib serialize/deserialize vectors pin Array/Struct tags and signed
integer wire length/padding. Expected bytes are fixed independently of a host
serializer, then compared with real native execution. Wire padding roundtrips
are canonicalized where observed. Receipts include artifact and runtime identity.

Run `dotnet test tests/SmartAccount.Contracts.Tests --filter
FullyQualifiedName~ImplementationRefinementPublicRuntimeTests`. No deployment,
ABI migration or production source change is required by this test-only addition.
Measured result on 2026-10-13: **12/12 PASS, zero skip**. Initial test-first
RED was 12/12. The codec case checks **33 exact native vectors**: 20 Array/Struct
records at signed integer boundaries, four integer normalization vectors, and
nine framing/tag probes. Integer zero is `2100`; `210100` canonicalizes to `2100`.
`21020700` canonicalizes to `210107` and `2102ffff` to `2101ff`. Buffer hash fields
preserve tag `30`; ByteString hash fields preserve tag `28`. Native deserialization
accepts tested nonminimal uint16/32/64 container counts, uint16 byte/integer lengths,
positive sign padding and trailing bytes. Reserialization emits minimal framing
and drops the trailing suffix. Negative ledger vectors describe codec behavior;
they do not establish the reimbursement invariant or reachable production state.

A successful single call exposes reservation 3 GAS at real paymaster discovery,
target execution and settlement. Single-plus-batch exposes 3 then 5 GAS and advances
three nonces. Different-account nesting reserves 3 then 5 GAS and emits settlements
2 then 3 GAS; same-account nesting reaches reservation 5 GAS but the actual account
lock aborts the whole invocation. Subsequent cap, nonce and real policy failures,
and an explicit outer ABORTMSG, leave the original sponsor deposit, relay GAS,
nonce, spending counter and ledger unchanged. Their parent application cache
retains the first successful child's 3-GAS ledger, demonstrating why HALT-only
outer persistence is necessary. A first-call reentry fault retains no parent ledger.
ReadOnly fails at the real forbidden syscall before callbacks; hosting GAS=1 fails
at the first charge (`FeeConsumed=30` datoshi), so that case is an early out-of-gas
probe, not proof of a failure after Storage.Put.

Receipts are generated under `Path.GetTempPath()` (macOS uses a `/var/folders/…`
directory). This run copied and read back durable evidence at:

- `<tmp>/aa-public-runtime-results/public-final.trx`
- `<tmp>/aa-public-final.log`
- `<tmp>/aa-public-red.log`
- `<tmp>/aa-public-native-codec-vectors.json`, SHA256
  `38cef261e60b5bf08ca11209991e657d919988e40ac5095043dea2e55c116bdd`
- `<tmp>/aa-public-runtime-evidence/`, 11 per-invocation JSON receipts with
  fee fields, independent hosting allowance, actual FeeConsumed, callbacks and
  committed/pending ledgers.

All public execution uses unchanged original NEF and ABI descriptors. The pinned
artifact identities are:

| Artifact | NEF SHA256 | Manifest SHA256 |
| --- | --- | --- |
| SmartAccountV3 | `4e5c8ae0c4b9722ae19e099303b6a61786de97cc4844abbc1ad458c3a76ce198` | `f7203fd84f6d132119df839a13249d73e4fe67644ca7a2e1c4ad6b9a1f6b21ed` |
| AAPaymaster | `c29738ab55d59c28608a6a646e5f36c4746d4158fccbde54079f11c2865d285a` | `49a51b95c284db4f7971b0f049f8e3e208f6a1f0b3cdce8631bcb6fd73ce0a54` |
| MockTransferTarget | `97d853d1f076abda4a1d6e44aa88ebdca01d390594a77ae03df2e164a7e181c0` | `3760aefced22c045b98414368e4c3eac5a6d9dc866a1b6f017c49c01518d401c` |

The SmartAccountV3 row names the *current* artifact. It moved twice after the
dated paths above were captured: the rename to `SmartAccountV3` shortened the
script by 10 bytes (`083ed325…` / `e79fa049…` → `be43cd05…` / `35fbb188…`), and
the helper's VM-integer headroom assertion then grew it by 73 bytes to the
identity above. Those files have not been recopied since either change, so they
are evidence about an earlier build only and must be regenerated before being
cited for the current NEF. AAPaymaster and MockTransferTarget were not affected
by either change and their rows are current.

MockTransferTarget is explicitly a compiled test target, not a production token.
The in-memory nesting adversary is also test-only. Actual GAS reimbursement uses
the native token. The loaded Neo and Neo.VM assemblies are both 3.10.1.0, with
InformationalVersion source commits `d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d`
and `004cd6070a940405818d9357638277dd44407e2e`. Tests fail closed on both loaded
file hashes: Neo `cb1b4db8076847dc23fda920ded773adaeeda07895effd350d2d8a99595a7f3a`,
Neo.VM `cea00a147add3c672bb23ffb5d98a4b1f31da135272efc258fee8fb7805bbfe9`.
These are bounded runtime cross-checks; no compiler-wide equivalence, arbitrary
callbacks, production wallet signer-scope integration or public-chain acceptance
is claimed.

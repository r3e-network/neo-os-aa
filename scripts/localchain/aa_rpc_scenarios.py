#!/usr/bin/env python3
"""AA module: local-chain acceptance scenarios (RPC-driven, published neoxp, no private hardfork).

Variant 'deployed' uses the unchanged contracts/build artifacts assessed on 2026-10-05.
Variant 'source' compiles the current checkout with the pinned published compiler and deploys those
bytes; its expectations follow the build profile read from the compiled core (DEC-AA-1): while the
source still emits System.Contract.CallWithGasLimit every verifier-signed operation must fault on a
published node, and once the public build profile lands the same operations must execute.
"""
import argparse, base64, datetime as dt, hashlib, json, os, shutil, subprocess, sys, time, traceback
import signal, socket, tempfile, random
from collections import Counter
from pathlib import Path

from rpcx import *  # noqa
import source_build as srcbuild

EXPECTED = AA / "tests/localchain/expected-deployed.json"
EXPECTED_SOURCE = AA / "tests/localchain/expected-source.json"
SOURCE_FAULT_MARKER = srcbuild.FAULT_MARKER
NAMES = ["deployer", "owner", "buyer", "merchant", "relay", "sponsor", "stranger"]
# The SDK fixture is a Node program: it composes the sponsored invocation with the SDK's own payload
# builder instead of the harness helpers (AA-11).
NODE = os.environ.get("NODE") or shutil.which("node") or "node"

TL = 604800  # 7 days: the minimum escape timelock


def proxy_script_for(account, core):
    return (b"\x0c\x14" + v.hash_le(account) + bytes.fromhex("11c01f0c06") + b"verify" + b"\x0c\x14" + v.hash_le(core) + bytes.fromhex("41627d5b52"))


class Ctx:
    def __init__(self, c, variant, workdir):
        self.c, self.variant, self.workdir = c, variant, Path(workdir)
        self.core = None
        self.accounts = {}
        self.timelocks = {}
        self.timelock_seq = 0

    def register(self, label, verifier=ZERO, params=b"", hook=ZERO, owner="owner", expect=None, expect_text=None, timelock=None):
        c = self.c
        tl = timelock or (TL + self.timelock_seq)
        self.timelock_seq += 1
        raw = c.read(self.core, "computeRegistrationAccountId", H(verifier), B(params), H(hook), H(c.hashes[owner]), I(tl))
        account = "0x" + raw[::-1].hex()
        rec = c.send(f"register {label}", [{"w": owner if expect is None or expect_text != "Backup owner witness required" else "stranger"}],
                     self.core, "registerAccount", [H(account), H(verifier), B(params), H(hook), H(c.hashes[owner]), I(tl)],
                     expect="HALT" if expect is None else expect, expect_text=expect_text)
        if expect is not None:
            return None, None
        proxy = "0x" + c.read(self.core, "getProxyScriptHash", H(account))[::-1].hex()
        self.accounts[label] = {"id": account, "proxy": proxy, "timelock": tl}
        return account, proxy

    def op(self, target, method, args, nonce, deadline=FAR_DEADLINE, sig=b""):
        return A(H(target), S(method), A(*args), I(nonce), I(deadline), B(sig))

    def nonce(self, account, channel=0):
        return self.c.read(self.core, "getNonce", H(account), I(channel))


def bring_up(c, variant, workdir, bin_dir=None):
    c.create(NAMES)
    c.start()
    c.fund(NAMES, 3000)
    bin_dir = Path(bin_dir) if bin_dir else AA / "contracts/build"
    core = c.deploy("UnifiedSmartWalletV3", bin_dir / "UnifiedSmartWalletV3.nef")
    c.deploy("MockTransferTarget", bin_dir / "MockTransferTarget.nef")
    for name in ("WebAuthnVerifier", "SessionKeyVerifier", "AAPaymaster", "WhitelistHook", "DailyLimitHook"):
        c.deploy(name, bin_dir / f"{name}.nef", data_core=core)
    c.deploy("SocialRecoveryVerifier", bin_dir / "SocialRecoveryVerifier.nef")
    c.send("admin pins the core on the recovery verifier", [{"w": "deployer"}], c.contracts["SocialRecoveryVerifier"], "setAuthorizedCore", [H(core)])
    x = Ctx(c, variant, workdir)
    x.core = core
    return c, x


# ---------------------------------------------------------------- scenarios
def sc_create_and_execute(c, x):
    """AA-01 create a smart account, AA-02 execute operations with the backup-owner (native) witness."""
    c.records.append({"scenario": "AA-01/02 create account and execute with the native owner witness"})
    target = c.contracts["MockTransferTarget"]
    account, proxy = x.register("native", verifier=c.contracts["WebAuthnVerifier"] if x.plant_mismatch else ZERO)
    c.check(c.hash_of(x.core, "getBackupOwner", H(account)) == c.hashes["owner"], "backup owner recorded")
    c.check(c.hash_of(x.core, "getVerifier", H(account)) == ZERO, "no verifier: native fallback")
    # negatives of registration (simulation = what the node would execute)
    x.register("squatter", expect="FAULT", expect_text="Backup owner witness required")
    c.send("duplicate registration", [{"w": "owner"}], x.core, "registerAccount",
           [H(account), H(ZERO), B(b""), H(ZERO), H(c.hashes["owner"]), I(x.accounts["native"]["timelock"])], expect="FAULT", expect_text="Account already exists")
    short = c.read(x.core, "computeRegistrationAccountId", H(ZERO), B(b""), H(ZERO), H(c.hashes["owner"]), I(3600))
    c.send("escape timelock below 7 days", [{"w": "owner"}], x.core, "registerAccount",
           [H("0x" + short[::-1].hex()), H(ZERO), B(b""), H(ZERO), H(c.hashes["owner"]), I(3600)], expect="FAULT", expect_text="at least 7 days")
    buyer = c.hashes["buyer"]
    tx = lambda n, **kw: x.op(target, "transfer", [H(proxy), H(buyer), I(1000), B(b"")], n, **kw)
    rec = c.send("executeUserOp nonce 0 (owner witness)", [{"w": "owner"}], x.core, "executeUserOp", [H(account), tx(0)])
    c.check(x.nonce(account) == 1, "nonce advanced to 1")
    c.send("replay of nonce 0", [{"w": "owner"}], x.core, "executeUserOp", [H(account), tx(0)], expect="FAULT", expect_text="Invalid sequence for channel")
    c.send("stranger submits", [{"w": "stranger"}], x.core, "executeUserOp", [H(account), tx(1)], expect="FAULT", expect_text="Native witness failed")
    c.send("expired deadline", [{"w": "owner"}], x.core, "executeUserOp", [H(account), tx(1, deadline=1)], expect="FAULT", expect_text="UserOp expired")
    c.send("batch of two (nonces 1, 2)", [{"w": "owner"}], x.core, "executeUserOps", [H(account), A(tx(1), tx(2))])
    c.check(x.nonce(account) == 3, "batch consumed two nonces")
    c.send("channel 1 is an independent lane", [{"w": "owner"}], x.core, "executeUserOp", [H(account), tx(1 << 64)])
    c.check(x.nonce(account, 1) == 1 and x.nonce(account, 0) == 3, "2D nonce channels independent")
    return {"account": account}


def sc_native_gas(c, x):
    """AA-03 send native GAS out of an account (the proxy-witness path)."""
    c.records.append({"scenario": "AA-03 send GAS from an AA account"})
    core = x.core
    account, proxy = x.register("gas-account")
    owner, buyer = c.hashes["owner"], c.hashes["buyer"]
    c.send("fund the proxy address with 10 GAS (any wallet can send to it)", [{"w": "owner"}], GAS_HASH, "transfer", [H(owner), H(proxy), I(10 * GAS), B(b"")])
    c.check(c.gas(proxy) == 10 * GAS, "proxy address holds 10 GAS")
    pscript = proxy_script_for(account, core)
    gas_op = lambda n, amount=GAS, target=GAS_HASH: x.op(target, "transfer", [H(proxy), H(buyer), I(amount), B(b"")], n)
    psig = lambda rule_target: {"proxy": proxy, "core": core, "target": rule_target, "script": pscript}
    before = c.gas(buyer)
    rec = c.send("a. GAS.transfer(proxy->buyer) submitted by a plain wallet (what the web wallet's NEP-17 preset and the relay route produce)",
                 [{"w": "owner"}], core, "executeUserOp", [H(account), gas_op(0)])
    x.evidence_a = {"vm": rec["outcome"], "result": rec["result"]}
    c.check(c.gas(proxy) == 10 * GAS and c.gas(buyer) == before, "a. no GAS moved although the operation HALTed (native token refuses: proxy is not a witness)")
    c.check(x.nonce(account) == 1, "a. the nonce was still consumed")
    rec = c.send("b. proxy-witness transaction while no verify-scope target is configured (every self-service account)",
                 [{"w": "owner"}, psig(GAS_HASH)], core, "executeUserOp", [H(account), gas_op(1)], expect="REJECT")
    c.send("admin sets the verify-scope target to GAS (only the contract admin can)", [{"w": "stranger"}], core, "setVerifyScopeTarget", [H(account), H(GAS_HASH)], expect="FAULT", expect_text="Not admin")
    c.send("admin sets the verify-scope target to GAS", [{"w": "deployer"}], core, "setVerifyScopeTarget", [H(account), H(GAS_HASH)])
    c.check(c.hash_of(core, "getVerifyScopeTarget", H(account)) == GAS_HASH, "scope target recorded")
    before = c.gas(buyer)
    rec = c.send("c. proxy-witness transaction after the admin set the scope target", [{"w": "owner"}, psig(GAS_HASH)], core, "executeUserOp", [H(account), gas_op(1)])
    c.check(c.gas(buyer) - before == GAS, "c. buyer received exactly 1 GAS from the AA proxy address")
    c.check(c.gas(proxy) == 9 * GAS, "c. proxy address paid exactly 1 GAS; the owner wallet paid the fees")
    c.check(x.nonce(account) == 2, "c. nonce advanced")
    c.send("d. proxy rules name NEO while the scope target is GAS", [{"w": "owner"}, psig(NEO_HASH)], core, "executeUserOp", [H(account), gas_op(2)], expect="REJECT")
    c.send("e. NEO.transfer needs scope target NEO; the account is scoped to GAS (one target per account)", [{"w": "owner"}, psig(NEO_HASH)], core, "executeUserOp",
           [H(account), gas_op(2, amount=1, target=NEO_HASH)], expect="REJECT")
    sj = [c._signer_json({"w": "owner"}), c._signer_json(psig(GAS_HASH))]
    direct = c.rpc("invokefunction", [GAS_HASH, "transfer", [H(proxy), H(buyer), I(GAS), B(b"")], sj])
    c.send("f. the SEV-0 attack shape: proxy listed as a signer of a script that moves funds directly", [{"w": "owner"}, psig(GAS_HASH)], core, "executeUserOp",
           [H(account), gas_op(2)], expect="REJECT", script_override=base64.b64decode(direct["script"]))
    c.check(c.gas(proxy) == 9 * GAS, "f. proxy balance untouched")
    pm = c.contracts["AAPaymaster"]
    c.send("g. executeSponsoredUserOp tx shape with the proxy as a signer (paymaster + native asset)", [{"w": "owner"}, psig(GAS_HASH)], core, "executeSponsoredUserOp",
           [H(account), gas_op(2), H(pm), H(c.hashes["sponsor"]), I(GAS // 10)], expect="REJECT")
    # h. one scope target per account: switch the same account to NEO and move NEO; GAS then stops working
    c.send("fund the proxy address with 5 NEO", [{"genesis": True}], NEO_HASH, "transfer", [H(c.genesis_hash), H(proxy), I(5), B(b"")])
    c.send("admin re-points the verify-scope target to NEO", [{"w": "deployer"}], core, "setVerifyScopeTarget", [H(account), H(NEO_HASH)])
    nb = c.read(NEO_HASH, "balanceOf", H(buyer))
    c.send("h1. proxy-witness NEO transfer after the scope target was set to NEO", [{"w": "owner"}, psig(NEO_HASH)], core, "executeUserOp",
           [H(account), gas_op(2, amount=1, target=NEO_HASH)])
    c.check(c.read(NEO_HASH, "balanceOf", H(buyer)) - nb == 1, "h1. buyer received 1 NEO from the AA proxy address")
    c.send("h2. GAS transfer with the GAS rules after the scope moved to NEO", [{"w": "owner"}, psig(GAS_HASH)], core, "executeUserOp",
           [H(account), gas_op(3)], expect="REJECT")
    return {"a_result": x.evidence_a}


def sc_key_verifier(c, x):
    """AA-04 an account controlled by a P-256 key (WebAuthnVerifier = bare P-256, not a WebAuthn relying party)."""
    c.records.append({"scenario": "AA-04 key verifier account (P-256) with relay-only submission"})
    verifier, target = c.contracts["WebAuthnVerifier"], c.contracts["MockTransferTarget"]
    key = v.P256Key(x.workdir, "passkeylike")
    account, proxy = x.register("p256", verifier=verifier, params=key.compressed)
    c.check(c.read(verifier, "getPublicKey", H(account)) == key.compressed, "public key stored through registration")
    args = [H(proxy), H(c.hashes["buyer"]), I(1000), B(b"")]
    def signed(nonce, tamper=False):
        payload = c.read(verifier, "getPayload", H(account), H(target), S("transfer"), A(*args), I(nonce), I(FAR_DEADLINE))
        sig = bytearray(key.sign(payload))
        if tamper:
            sig[0] ^= 0xFF
        return x.op(target, "transfer", args, nonce, sig=bytes(sig))
    c.send("relay submits a key-signed op (relay holds no key)", [{"w": "relay"}], x.core, "executeUserOp", [H(account), signed(0)])
    c.check(x.nonce(account) == 1, "nonce advanced")
    c.send("tampered signature", [{"w": "relay"}], x.core, "executeUserOp", [H(account), signed(1, tamper=True)], expect="FAULT", expect_text="Verifier rejected signature")
    c.send("owner witness alone does not authorise while a verifier is set", [{"w": "owner"}], x.core, "executeUserOp", [H(account), x.op(target, "transfer", args, 1)], expect="FAULT")
    return {}


def arm_session_and_whitelist(c, x):
    """Phase 1 of the timelocked configurations (24 h): arm session keys, whitelist, initiate escape."""
    c.records.append({"scenario": "arming timelocked configuration (session keys, hook whitelist, escape)"})
    target = c.contracts["MockTransferTarget"]
    sess_v, hook = c.contracts["SessionKeyVerifier"], c.contracts["WhitelistHook"]
    x.sesskey = v.P256Key(x.workdir, "session")
    x.valid_until = c.now_ms() + 20 * DAY * 1000
    for label in ("session-relay", "session-pm"):
        account, proxy = x.register(label, verifier=sess_v)
        args = [H(account), B(x.sesskey.compressed), H(target), S("transfer"), I(x.valid_until), I(0), S(label)]
        rec = c.send(f"arm setSessionKey for {label} (24h timelock)", [{"w": "owner"}], x.core, "callVerifier", [H(account), S("setSessionKey"), A(*args)])
        c.check(rec["result"] is False, "first call arms the timelock and returns false")
    account, proxy = x.register("hooked", hook=hook)
    rec = c.send("arm setWhitelist (24h timelock)", [{"w": "owner"}], x.core, "callHook", [H(account), S("setWhitelist"), A(H(account), H(target), BOOL(True))])
    c.check(rec["result"] is False, "hook config armed")
    # value flow: session key scoped to GAS.transfer + daily limit hook + admin scope target, funded proxy
    dl = c.contracts["DailyLimitHook"]
    vacc, vproxy = x.register("value-flow", verifier=sess_v, hook=dl)
    vargs = [H(vacc), B(x.sesskey.compressed), H(GAS_HASH), S("transfer"), I(x.valid_until), I(0), S("value-flow")]
    c.send("arm setSessionKey (target GAS, method transfer) for the value-flow account", [{"w": "owner"}], x.core, "callVerifier", [H(vacc), S("setSessionKey"), A(*vargs)])
    c.send("arm setDailyLimit 5 GAS for the value-flow account", [{"w": "owner"}], x.core, "callHook", [H(vacc), S("setDailyLimit"), A(H(vacc), H(GAS_HASH), I(5 * GAS), BOOL(False))])
    c.send("admin sets the verify-scope target GAS for the value-flow account", [{"w": "deployer"}], x.core, "setVerifyScopeTarget", [H(vacc), H(GAS_HASH)])
    c.send("fund the value-flow proxy with 20 GAS", [{"w": "owner"}], GAS_HASH, "transfer", [H(c.hashes["owner"]), H(vproxy), I(20 * GAS), B(b"")])
    v2, v2proxy = x.register("value-flow-nohook", verifier=sess_v)
    v2args = [H(v2), B(x.sesskey.compressed), H(GAS_HASH), S("transfer"), I(x.valid_until), I(0), S("value-flow-nohook")]
    c.send("arm setSessionKey (target GAS) for the no-hook account", [{"w": "owner"}], x.core, "callVerifier", [H(v2), S("setSessionKey"), A(*v2args)])
    c.send("fund the no-hook proxy with 10 GAS", [{"w": "owner"}], GAS_HASH, "transfer", [H(c.hashes["owner"]), H(v2proxy), I(10 * GAS), B(b"")])
    account, proxy = x.register("escaping", timelock=TL + 1000)
    c.send("initiateEscape (backup owner)", [{"w": "owner"}], x.core, "initiateEscape", [H(account)])
    c.check(c.read(x.core, "isEscapeActive", H(account)) is True, "escape active")
    c.send("a stranger cannot initiate an escape", [{"w": "stranger"}], x.core, "initiateEscape", [H(x.accounts["session-pm"]["id"])], expect="FAULT")


def _recovery_digest(x, c, account, proxy, new_owner, nonce_text, expires_text, action_id, master, action_nf):
    seg = lambda t: bytes([len(t)]) + t.encode()
    recovery = c.contracts["SocialRecoveryVerifier"]
    payload = b"neodid-recovery-v1" + seg("neo3-local") + v.hash_le(x.core) + v.hash_le(recovery) + v.hash_le(proxy) + seg(account) \
        + v.hash_le(new_owner) + seg(nonce_text) + seg(expires_text) + seg(action_id) + master + action_nf
    return hashlib.sha256(payload).digest()


def sc_recovery_phase1(c, x):
    """AA-07b social recovery (Morpheus-ticket verifier): setup, owner control, ticket submission; finalized after the timelock."""
    c.records.append({"scenario": "AA-07b social recovery verifier: setup, ticket (phase 1)"})
    recovery, target = c.contracts["SocialRecoveryVerifier"], c.contracts["MockTransferTarget"]
    account, proxy = x.register("recoverable", verifier=recovery)
    x.morpheus = v.P256Key(x.workdir, "morpheus-local")
    x.factor = bytes(range(1, 33))
    x.recov = {"account": account, "proxy": proxy}
    c.send("owner sets up recovery (factor, threshold 1, 7-day timelock, Morpheus verifier key)", [{"w": "owner"}], recovery, "setupRecovery",
           [H(account), S(account), S("neo3-local"), H(c.hashes["owner"]), H(x.core), H(proxy), H(c.hashes["stranger"]), A(B(x.factor)), I(1), I(604_800_000), B(x.morpheus.compressed)])
    c.check(c.hash_of(recovery, "getOwner", H(account)) == c.hashes["owner"], "recovery owner recorded")
    args = [H(proxy), H(c.hashes["buyer"]), I(1000), B(b"")]
    # the verifier checks the owner witness from a nested call, so a CalledByEntry signer is not enough: the signer needs Global or CustomContracts[verifier]
    c.send("owner signs with CalledByEntry only: refused inside the verifier", [{"w": "owner"}], x.core, "executeUserOp", [H(account), x.op(target, "transfer", args, 0)], expect="FAULT")
    c.send("owner operates the account through the recovery verifier (Global scope)", [{"w": "owner", "scope": "Global"}], x.core, "executeUserOp", [H(account), x.op(target, "transfer", args, 0)])
    c.send("a stranger cannot operate it", [{"w": "stranger", "scope": "Global"}], x.core, "executeUserOp", [H(account), x.op(target, "transfer", args, 1)], expect="FAULT")
    expires = str(c.now_ms() + 30 * DAY * 1000)
    nf = bytes([0x41]) * 32
    new_owner = c.hashes["buyer"]
    ticket = lambda sig, nfv=nf, master=x.factor, new=new_owner: [H(account), H(new), S("0"), S(expires), S("recover-1"), B(master), B(nfv), B(sig)]
    good = x.morpheus.sign(_recovery_digest(x, c, account, proxy, new_owner, "0", expires, "recover-1", x.factor, nf))
    c.send("ticket signed by a wrong key", [{"w": "relay"}], recovery, "submitRecoveryTicket", ticket(v.P256Key(x.workdir, "wrongkey").sign(b"x" * 32)), expect="FAULT", expect_text="Invalid Morpheus recovery signature")
    c.send("ticket for an unknown recovery factor", [{"w": "relay"}], recovery, "submitRecoveryTicket", ticket(good, master=bytes([9]) * 32), expect="FAULT", expect_text="Unknown recovery factor")
    rec = c.send("relay submits the Morpheus-signed recovery ticket", [{"w": "relay"}], recovery, "submitRecoveryTicket", ticket(good))
    c.check("RecoveryReady" in rec["events"], "threshold met: RecoveryReady emitted, timelock started")
    c.send("the same ticket cannot be replayed", [{"w": "relay"}], recovery, "submitRecoveryTicket", ticket(good), expect="FAULT", expect_text="Action nullifier already used")
    c.send("finalize before the timelock", [{"w": "relay"}], recovery, "finalizeRecovery", [H(account)], expect="FAULT", expect_text="Recovery timelock not expired")
    return {}


def sc_recovery_phase2(c, x):
    c.records.append({"scenario": "AA-07b social recovery verifier: finalize and new owner (phase 2)"})
    recovery, target = c.contracts["SocialRecoveryVerifier"], c.contracts["MockTransferTarget"]
    account, proxy = x.recov["account"], x.recov["proxy"]
    rec = c.send("anyone finalizes the recovery after the timelock", [{"w": "relay"}], recovery, "finalizeRecovery", [H(account)])
    c.check("RecoveryFinalized" in rec["events"], "RecoveryFinalized emitted")
    c.check(c.hash_of(recovery, "getOwner", H(account)) == c.hashes["buyer"], "recovery owner is now the buyer key")
    args = [H(proxy), H(c.hashes["merchant"]), I(1000), B(b"")]
    c.send("old owner key no longer authorises", [{"w": "owner", "scope": "Global"}], x.core, "executeUserOp", [H(account), x.op(target, "transfer", args, 1)], expect="FAULT")
    c.send("new owner key operates the account", [{"w": "buyer", "scope": "Global"}], x.core, "executeUserOp", [H(account), x.op(target, "transfer", args, 1)])
    c.check(x.nonce(account) == 2, "account nonce continues across the owner change")
    c.check(c.hash_of(x.core, "getBackupOwner", H(account)) == c.hashes["owner"], "core backup owner unchanged (recovery rotates the verifier's owner only)")
    return {}


def sc_session_keys(c, x):
    """AA-05 session keys, AA-06 permissions (whitelist hook), AA-07 escape/recovery (after the 8-day fast-forward)."""
    c.records.append({"scenario": "AA-05/06/07 session key, whitelist hook and escape after the timelocks"})
    target = c.contracts["MockTransferTarget"]
    sess_v = c.contracts["SessionKeyVerifier"]
    key = x.sesskey
    # execute the second phase of each armed call
    for label in ("session-relay", "session-pm"):
        a = x.accounts[label]["id"]
        args = [H(a), B(key.compressed), H(target), S("transfer"), I(x.valid_until), I(0), S(label)]
        c.send(f"execute setSessionKey for {label}", [{"w": "owner"}], x.core, "callVerifier", [H(a), S("setSessionKey"), A(*args)])
        stored = c.read(sess_v, "getSessionKey", H(a))
        c.check(stored[0] == key.compressed, f"session key stored for {label}")
    acct, proxy = x.accounts["session-relay"]["id"], x.accounts["session-relay"]["proxy"]
    args = [H(proxy), H(c.hashes["buyer"]), I(1000), B(b"")]
    def signed(a, p, nonce, method="transfer", tgt=None, tamper=False):
        tgt = tgt or target
        ar = [H(p), H(c.hashes["buyer"]), I(1000), B(b"")]
        payload = c.read(sess_v, "getPayload", H(a), H(tgt), S(method), A(*ar), I(nonce), I(FAR_DEADLINE))
        sig = bytearray(key.sign(payload))
        if tamper:
            sig[5] ^= 0xFF
        return x.op(tgt, method, ar, nonce, sig=bytes(sig))
    rec = c.send("relay submits a session-signed op (relay holds no key)", [{"w": "relay"}], x.core, "executeUserOp", [H(acct), signed(acct, proxy, 0)])
    c.check(x.nonce(acct) == 1, "session op consumed nonce 0")
    c.send("zero signature", [{"w": "relay"}], x.core, "executeUserOp",
           [H(acct), x.op(target, "transfer", args, 1, sig=bytes(64))], expect="FAULT", expect_text="Verifier rejected signature")
    other = c.contracts["WebAuthnVerifier"]
    c.send("session key used for another target/method (overreach)", [{"w": "relay"}], x.core, "executeUserOp",
           [H(acct), signed(acct, proxy, 1, method="supportsV3", tgt=other)], expect="FAULT")
    # hooks
    hooked = x.accounts["hooked"]
    c.send("execute setWhitelist", [{"w": "owner"}], x.core, "callHook", [H(hooked["id"]), S("setWhitelist"), A(H(hooked["id"]), H(target), BOOL(True))])
    c.check(c.read(c.contracts["WhitelistHook"], "isWhitelisted", H(hooked["id"]), H(target)) is True, "target whitelisted")
    hargs = [H(hooked["proxy"]), H(c.hashes["buyer"]), I(1), B(b"")]
    c.send("whitelisted target passes the hook", [{"w": "owner"}], x.core, "executeUserOp", [H(hooked["id"]), x.op(target, "transfer", hargs, 0)])
    c.send("unlisted target is refused by the hook", [{"w": "owner"}], x.core, "executeUserOp",
           [H(hooked["id"]), x.op(c.contracts["WebAuthnVerifier"], "supportsV3", [], 1)], expect="FAULT", expect_text="Target contract not in whitelist")
    # escape
    esc = x.accounts["escaping"]
    c.send("finalizeEscape after the timelock", [{"w": "owner"}], x.core, "finalizeEscape", [H(esc["id"]), H(ZERO)])
    c.check(c.read(x.core, "isEscapeActive", H(esc["id"])) is False, "escape finalized")
    return {}


def sc_value_flow(c, x):
    """AA-03b/05b/06b gasless native-asset send: a session key signs, the relay is the fee payer, the proxy witness moves GAS, a daily-limit hook meters it."""
    c.records.append({"scenario": "AA-03b gasless GAS send with a session key, proxy witness and daily-limit hook"})
    sess_v = c.contracts["SessionKeyVerifier"]
    vacc, vproxy = x.accounts["value-flow"]["id"], x.accounts["value-flow"]["proxy"]
    buyer = c.hashes["buyer"]
    vargs = [H(vacc), B(x.sesskey.compressed), H(GAS_HASH), S("transfer"), I(x.valid_until), I(0), S("value-flow")]
    c.send("execute setSessionKey for the value-flow account", [{"w": "owner"}], x.core, "callVerifier", [H(vacc), S("setSessionKey"), A(*vargs)])
    c.send("execute setDailyLimit 5 GAS", [{"w": "owner"}], x.core, "callHook", [H(vacc), S("setDailyLimit"), A(H(vacc), H(GAS_HASH), I(5 * GAS), BOOL(False))])
    c.check(c.read(c.contracts["DailyLimitHook"], "getDailyLimit", H(vacc), H(GAS_HASH)) == 5 * GAS, "daily limit stored (5 GAS)")
    pscript = proxy_script_for(vacc, x.core)
    psig = {"proxy": vproxy, "core": x.core, "target": GAS_HASH, "script": pscript}
    def signed_gas_op(nonce, amount):
        ar = [H(vproxy), H(buyer), I(amount), B(b"")]
        payload = c.read(sess_v, "getPayload", H(vacc), H(GAS_HASH), S("transfer"), A(*ar), I(nonce), I(FAR_DEADLINE))
        return x.op(GAS_HASH, "transfer", ar, nonce, sig=x.sesskey.sign(payload))
    before_b, before_p, before_r, before_o = c.gas(buyer), c.gas(vproxy), c.gas("relay"), c.gas("owner")
    n0 = x.nonce(vacc)
    rec = c.send("relay (fee payer) + proxy witness submit the session-signed 3 GAS transfer; no owner witness, user holds no GAS",
                 [{"w": "relay"}, psig], x.core, "executeUserOp", [H(vacc), signed_gas_op(n0, 3 * GAS)])
    c.check(c.gas(buyer) - before_b == 3 * GAS and before_p - c.gas(vproxy) == 3 * GAS, "buyer +3 GAS, proxy -3 GAS exactly")
    c.check(c.gas("owner") == before_o, "the owner wallet paid nothing and signed nothing")
    c.check(before_r - c.gas("relay") > 0, "the relay paid the fees")
    c.check(x.nonce(vacc) == n0 + 1, "nonce advanced")
    c.send("a second 3 GAS transfer would exceed the 5 GAS daily limit: the hook refuses", [{"w": "relay"}, psig], x.core, "executeUserOp",
           [H(vacc), signed_gas_op(n0 + 1, 3 * GAS)], expect="FAULT")
    probe = c.rpc("invokefunction", [x.core, "executeUserOp", [H(vacc), signed_gas_op(n0 + 1, 3 * GAS)], [c._signer_json({"w": "relay"}), c._signer_json(psig)]])
    c.records.append({"step": "limit refusal reason", "exception": (probe.get("exception") or "")[:200]})
    c.send("a 2 GAS transfer inside the limit passes", [{"w": "relay"}, psig], x.core, "executeUserOp", [H(vacc), signed_gas_op(n0 + 1, 2 * GAS)])
    c.check(before_p - c.gas(vproxy) == 5 * GAS, "5 GAS moved in total")
    # the same session-signed shape through the AA relay route (relay is the only signer, no proxy witness) on an account without the hook
    v2, v2proxy = x.accounts["value-flow-nohook"]["id"], x.accounts["value-flow-nohook"]["proxy"]
    v2args = [H(v2), B(x.sesskey.compressed), H(GAS_HASH), S("transfer"), I(x.valid_until), I(0), S("value-flow-nohook")]
    c.send("execute setSessionKey for the no-hook account", [{"w": "owner"}], x.core, "callVerifier", [H(v2), S("setSessionKey"), A(*v2args)])
    n1 = x.nonce(v2)
    ar = [H(v2proxy), H(buyer), I(1 * GAS), B(b"")]
    payload = c.read(sess_v, "getPayload", H(v2), H(GAS_HASH), S("transfer"), A(*ar), I(n1), I(FAR_DEADLINE))
    x.gas_fixture = {"accountId": v2, "proxy": v2proxy, "target": GAS_HASH, "method": "transfer",
                     "methodArgs": [{"type": "Hash160", "value": v2proxy}, {"type": "Hash160", "value": buyer}, {"type": "Integer", "value": str(GAS)}, {"type": "ByteArray", "value": "0x"}],
                     "nonce": str(n1), "deadline": str(FAR_DEADLINE), "signatureHex": x.sesskey.sign(payload).hex()}
    return {"relayCost": before_r - c.gas("relay")}


def _notification(c, txid, name):
    """The first notification with this event name in a transaction's application log, or None."""
    deadline = time.time() + 30
    while True:
        try:
            log = c.rpc("getapplicationlog", [txid])
            break
        except Fail:
            if time.time() > deadline:
                raise Fail(f"no application log for {txid}")
            time.sleep(1)
    for entry in log["executions"][0].get("notifications", []):
        if entry["eventname"] == name:
            return entry
    return None


def _event_hash(item):
    """A Hash160/UInt160 field of an event: the node returns it as base64 of the internal order."""
    return "0x" + base64.b64decode(item["value"])[::-1].hex()


def sc_paymaster(c, x):
    """AA-08 on-chain paymaster: the relay fronts the fee, the sponsor deposit reimburses it to the datoshi,
    and the paymaster's own per-operation bound refuses the operation on one side and executes it on the other."""
    c.records.append({"scenario": "AA-08 on-chain paymaster sponsored operation"})
    acct, proxy = x.accounts["session-pm"]["id"], x.accounts["session-pm"]["proxy"]
    target, pm, sess_v = c.contracts["MockTransferTarget"], c.contracts["AAPaymaster"], c.contracts["SessionKeyVerifier"]
    sponsor = c.hashes["sponsor"]
    c.send("sponsor deposits 100 GAS into the paymaster", [{"w": "sponsor"}], GAS_HASH, "transfer", [H(sponsor), H(pm), I(100 * GAS), B(b"")])
    c.check(c.read(pm, "getSponsorDeposit", H(sponsor)) == 100 * GAS, "deposit credited")
    c.send("sponsor sets a per-account policy", [{"w": "sponsor"}], pm, "setPolicy", [H(acct), H(target), S("transfer"), I(5 * GAS), I(0), I(0), I(0)])
    ar = [H(proxy), H(c.hashes["buyer"]), I(1000), B(b"")]
    requested = 5 * GAS

    def sponsored(nonce):
        payload = c.read(sess_v, "getPayload", H(acct), H(target), S("transfer"), A(*ar), I(nonce), I(FAR_DEADLINE))
        return x.op(target, "transfer", ar, nonce, sig=x.sesskey.sign(payload))

    relay_before, dep_before = c.gas("relay"), c.read(pm, "getSponsorDeposit", H(sponsor))
    probe = c.rpc("invokefunction", [x.core, "executeSponsoredUserOp", [H(acct), sponsored(0), H(pm), H(sponsor), I(requested)], [c._signer_json({"w": "relay"})]])
    c.records.append({"step": "invokefunction pre-pricing of executeSponsoredUserOp (what a relay does)", "state": probe.get("state"), "exception": (probe.get("exception") or "")[:200]})
    x.sponsored_probe_state = probe.get("state")
    # The relay pays a fixed 2.5 GAS system fee and 0.5 GAS network fee while it requests 5 GAS back: the
    # on-chain cap (min(requested, systemFee + networkFee)) must settle exactly the 3 GAS it really paid.
    rec = c.send("relay executes the sponsored op with a fixed 2.5 GAS system fee (user holds no GAS)", [{"w": "relay"}], x.core, "executeSponsoredUserOp",
                 [H(acct), sponsored(0), H(pm), H(sponsor), I(requested)], probe_fault_ok=True, fixed_sysfee=GAS * 5 // 2, netfee=GAS // 2)
    c.check("SponsoredUserOpExecuted" in rec["events"], "SponsoredUserOpExecuted emitted")
    relay_after, dep_after = c.gas("relay"), c.read(pm, "getSponsorDeposit", H(sponsor))
    c.check(dep_before - dep_after > 0, "sponsor deposit was debited")
    rec["relayNetGasDatoshi"] = relay_after - relay_before
    rec["depositDebitDatoshi"] = dep_before - dep_after
    c.check(c.read(x.core, "getNonce", H(acct), I(0)) == 1, "sponsored op consumed nonce 0")
    paid = GAS * 5 // 2 + GAS // 2
    reimb = _notification(c, rec["txid"], "Reimbursed")
    c.check(reimb is not None, "Reimbursed event emitted")
    fields = reimb["state"]["value"] if reimb else []
    settled = int(fields[3]["value"]) if len(fields) > 3 else None
    c.records.append({"step": "on-chain settlement of the first sponsored op", "requestedDatoshi": requested,
                      "settledDatoshi": settled, "relayFeePaidDatoshi": paid, "relayNetDatoshi": relay_after - relay_before,
                      "depositDebitDatoshi": dep_before - dep_after,
                      "event": {"sponsor": _event_hash(fields[0]) if fields else None,
                                "account": _event_hash(fields[1]) if len(fields) > 1 else None,
                                "relay": _event_hash(fields[2]) if len(fields) > 2 else None}})
    c.check(settled == paid, "the relay is reimbursed exactly the fee it paid (requested 5 GAS, settled 3 GAS)")
    c.check(settled < requested, "the settled amount is capped below the requested amount")
    c.check(dep_before - dep_after == settled, "the sponsor paid exactly the relay's fee")
    c.check(relay_after == relay_before, "the relay's own GAS balance is unchanged: it is made whole, not more")
    c.check(_event_hash(fields[0]) == sponsor and _event_hash(fields[2]) == c.hashes["relay"], "Reimbursed names the sponsor and the relay")
    # The paymaster's per-operation bound, both sides, on chain: 1 GAS is below the 3 GAS the relay really
    # pays and 4 GAS is above it. A settlement fault is only observable on a broadcast transaction here:
    # the pricing container carries no fees, so the deployed core caps the settlement at zero in simulation.
    c.send("sponsor re-binds the policy to a 1 GAS per-operation bound", [{"w": "sponsor"}], pm, "setPolicy",
           [H(acct), H(target), S("transfer"), I(1 * GAS), I(0), I(0), I(0)])
    dep_probe, relay_probe = c.read(pm, "getSponsorDeposit", H(sponsor)), c.gas("relay")
    refused = c.send("broadcast the sponsored op whose settlement exceeds the on-chain per-operation bound", [{"w": "relay"}], x.core, "executeSponsoredUserOp",
                     [H(acct), sponsored(1), H(pm), H(sponsor), I(requested)], probe_fault_ok=True, fixed_sysfee=GAS * 5 // 2, netfee=GAS // 2,
                     onchain_fault="Exceeds per-operation limit")
    c.check(refused.get("onChain") is True and refused["outcome"] == "FAULT", "the on-chain per-operation bound refused the sponsored op")
    c.check(c.read(pm, "getSponsorDeposit", H(sponsor)) == dep_probe, "the refused op left the sponsor deposit untouched")
    c.check(c.read(x.core, "getNonce", H(acct), I(0)) == 1, "the refused op left the account nonce unconsumed")
    c.check(_notification(c, refused["txid"], "Reimbursed") is None, "the refused op emitted no Reimbursed event")
    c.check(c.gas("relay") == relay_probe - paid, "the refused op cost the relay its own fee and reimbursed nothing")
    c.send("sponsor re-binds the policy to a 4 GAS per-operation bound", [{"w": "sponsor"}], pm, "setPolicy",
           [H(acct), H(target), S("transfer"), I(4 * GAS), I(0), I(0), I(0)])
    relay_before2, dep_before2 = c.gas("relay"), c.read(pm, "getSponsorDeposit", H(sponsor))
    rec2 = c.send("the same sponsored op now settles at 3 GAS, inside the 4 GAS bound", [{"w": "relay"}], x.core, "executeSponsoredUserOp",
                  [H(acct), sponsored(1), H(pm), H(sponsor), I(requested)], probe_fault_ok=True, fixed_sysfee=GAS * 5 // 2, netfee=GAS // 2)
    c.check(c.read(x.core, "getNonce", H(acct), I(0)) == 2, "the allowed sponsored op consumed nonce 1")
    c.check(c.gas("relay") == relay_before2, "the relay is made whole on the allowed side too")
    c.check(dep_before2 - c.read(pm, "getSponsorDeposit", H(sponsor)) == paid, "the sponsor paid the relay's fee again")
    c.check(rec2["outcome"] == "HALT", "the allowed side HALTed on chain")
    return {"relayNet": relay_after - relay_before, "depositDebit": dep_before - dep_after,
            "settled": settled, "requested": requested, "allowedRelayNet": c.gas("relay") - relay_before2,
            "prePricingSimulation": x.sponsored_probe_state}


def sc_sdk_sponsored(c, x):
    """AA-11 the SDK sponsored-operation end to end on the deployed core.

    The invocation is composed by the SDK's own payload builder (scripts/localchain/sdk_paymaster_fixture.mjs)
    rather than by the harness, then driven through the deployed core exactly as a relay would receive it.
    The scenario also records the two halves of the sponsorship bound: the pricing container cannot price the
    sponsored envelope at all, while the inner operation prices cleanly, and the settlement on chain pays the
    relay the fee it actually paid, never the amount it requested."""
    c.records.append({"scenario": "AA-11 SDK sponsored operation end to end (payload built by the SDK)"})
    core, pm, target, sess_v = x.core, c.contracts["AAPaymaster"], c.contracts["MockTransferTarget"], c.contracts["SessionKeyVerifier"]
    buyer, sponsor = c.hashes["buyer"], c.hashes["sponsor"]
    # The SDK account gets its own key: the session key AA-08 and AA-09 use belongs to their accounts
    # and must keep signing for them after this scenario has run.
    sdk_key = v.P256Key(x.workdir, "session-sdk-key")
    valid_until = c.now_ms() + 20 * DAY * 1000
    acct, proxy = x.register("session-sdk", verifier=sess_v)
    sess_args = [H(acct), B(sdk_key.compressed), H(target), S("transfer"), I(valid_until), I(0), S("session-sdk")]
    c.send("arm setSessionKey for the SDK account (24 h timelock)", [{"w": "owner"}], core, "callVerifier",
           [H(acct), S("setSessionKey"), A(*sess_args)])
    c.fastforward(DAY + 3600)
    c.send("execute setSessionKey for the SDK account", [{"w": "owner"}], core, "callVerifier",
           [H(acct), S("setSessionKey"), A(*sess_args)])
    # The shared sponsor still holds change from AA-08, so the deposit is judged by its increase.
    deposit_before = c.read(pm, "getSponsorDeposit", H(sponsor))
    c.send("sponsor deposits 100 GAS into the paymaster", [{"w": "sponsor"}], GAS_HASH, "transfer",
           [H(sponsor), H(pm), I(100 * GAS), B(b"")])
    deposit_after = c.read(pm, "getSponsorDeposit", H(sponsor))
    c.check(deposit_after - deposit_before == 100 * GAS, "the SDK sponsor deposit grows by the 100 GAS deposited")
    c.send("sponsor binds a 5 GAS per-operation policy for the SDK account", [{"w": "sponsor"}], pm, "setPolicy",
           [H(acct), H(target), S("transfer"), I(5 * GAS), I(0), I(0), I(0)])
    # The bound is read through the paymaster's own preflight: a request at the bound is inside it and a
    # request above it is not. The policy record itself is kept for the receipt, not asserted by index,
    # because the deserialised struct's field order is the serialiser's business.
    inside = c.read(pm, "validatePaymasterOp", H(sponsor), H(acct), H(target), S("transfer"), I(5 * GAS))
    outside = c.read(pm, "validatePaymasterOp", H(sponsor), H(acct), H(target), S("transfer"), I(5 * GAS + 1))
    c.check(inside is True and outside is False, "the paymaster preflight accepts the 5 GAS bound and refuses one datoshi above it")
    c.records.append({"step": "the SDK sponsor deposit before the sponsored operation",
                      "depositBeforeDatoshi": deposit_after, "depositGrowthDatoshi": deposit_after - deposit_before,
                      "policyRecord": c.read(pm, "getPolicy", H(sponsor), H(acct))})
    # The second sponsor is the attribution control: nothing in this scenario may touch its deposit.
    c.send("an unrelated sponsor deposits 10 GAS", [{"w": "buyer"}], GAS_HASH, "transfer",
           [H(buyer), H(pm), I(10 * GAS), B(b"")])
    control_before = c.read(pm, "getSponsorDeposit", H(buyer))
    requested = 5 * GAS
    ar = [H(proxy), H(buyer), I(1000), B(b"")]
    inner_script = None

    def sdk_payload(nonce, args=None, amount=requested, overrides=None):
        """Compose the sponsored invocation with the SDK and return (stdout json, exit code)."""
        body = {"rpcUrl": f"http://127.0.0.1:{c.port}", "core": core, "accountId": acct, "target": target,
                "method": "transfer", "args": list(args if args is not None else ar), "nonce": nonce,
                "deadline": FAR_DEADLINE, "signatureHex": "", "paymaster": pm, "sponsor": sponsor,
                "reimbursementAmount": amount}
        if args is None:
            sig_args = [H(proxy), H(buyer), I(1000), B(b"")]
            payload = c.read(sess_v, "getPayload", H(acct), H(target), S("transfer"), A(*sig_args), I(nonce), I(FAR_DEADLINE))
            body["signatureHex"] = sdk_key.sign(payload).hex()
        body.update(overrides or {})
        request_path = c.workdir / f"sdk-request-{nonce}-{amount}.json"
        request_path.write_text(json.dumps(body))
        done = subprocess.run([NODE, str(AA / "scripts/localchain/sdk_paymaster_fixture.mjs"), str(request_path)],
                              capture_output=True, text=True, cwd=str(AA), timeout=180)
        try:
            return json.loads(done.stdout.strip().splitlines()[-1]), done.returncode
        except Exception:
            raise Fail(f"the SDK fixture produced no JSON (exit {done.returncode}): {done.stderr[-300:]}")

    def harness_params(nonce, args=None, amount=requested):
        sig_args = list(args if args is not None else ar)
        payload = c.read(sess_v, "getPayload", H(acct), H(target), S("transfer"), A(*sig_args), I(nonce), I(FAR_DEADLINE))
        op = A(H(target), S("transfer"), A(*sig_args), I(nonce), I(FAR_DEADLINE), B(sdk_key.sign(payload)))
        return [H(acct), op, H(pm), H(sponsor), I(amount)]

    # 1. The SDK builder produces a relay-ready invocation: typed arguments, no untyped carrier.
    first, exit_code = sdk_payload(0)
    if not first.get("ok"):
        raise Fail(f"the SDK refused a valid sponsored payload: {first.get('error')}")
    shape = first.get("argsParameter") or {}
    c.check(exit_code == 0 and shape.get("type") == "Array" and shape.get("value") == 4
            and shape.get("types") == ["Hash160", "Hash160", "Integer", "ByteArray"],
            "the SDK payload carries the inner argument list as 4 typed parameters")
    inner = ((first.get("payload") or {}).get("args") or [None, None])[1]
    encoded = json.dumps(inner)
    c.check('"Any"' not in encoded, "no parameter of the SDK payload is an untyped carrier")
    c.check(encoded == json.dumps(json.loads(encoded)), "the SDK payload survives a JSON round trip unchanged")
    c.records.append({"step": "the SDK payload for nonce 0 (what a relay receives)", "payload": first.get("payload")})

    # 2. The two halves of the bound in the pricing container: the sponsored envelope cannot be priced there,
    # the inner operation can, and the fault text names the deployed core's settlement cap.
    sponsored_probe = c.rpc("invokescript", [first["script"], [c._signer_json({"w": "relay"})]])
    c.check(sponsored_probe.get("state") == "FAULT"
            and "Reimbursement exceeds actual gas cost" in (sponsored_probe.get("exception") or ""),
            "the sponsored envelope faults in the zero-fee pricing container on its settlement cap")
    inner_probe = c.rpc("invokefunction", [core, "executeUserOp", harness_params(0)[:2], [c._signer_json({"w": "relay"})]])
    c.check(inner_probe.get("state") == "HALT", "the inner operation is priced cleanly in the same container")
    c.records.append({"step": "the two containers a relay can price a sponsored operation from",
                      "sponsoredGasConsumed": sponsored_probe.get("gasconsumed"),
                      "sponsoredException": (sponsored_probe.get("exception") or "")[:200],
                      "innerGasConsumed": inner_probe.get("gasconsumed")})

    # 3. The SDK payload is the invocation the harness parameter path produces: same container, same outcome,
    # same gas, so the payload the chain executes is the one the client built.
    harness_probe = c.rpc("invokefunction", [core, "executeSponsoredUserOp", harness_params(0), [c._signer_json({"w": "relay"})]])
    c.check(harness_probe.get("state") == sponsored_probe.get("state")
            and harness_probe.get("gasconsumed") == sponsored_probe.get("gasconsumed")
            and (harness_probe.get("exception") or "") == (sponsored_probe.get("exception") or ""),
            "the SDK payload is byte-equivalent to the harness parameter path")
    c.check(int(harness_probe.get("gasconsumed") or 0) > 0,
            "the equivalent invocation reports the gas it priced")

    # 4. The broadcast: the SDK script with fixed fees, and the settlement the sponsor actually pays.
    fixed_fee = GAS * 5 // 2 + GAS // 2   # 2.5 GAS system fee + 0.5 GAS network fee
    nonce_before = x.nonce(acct)
    dep_before, relay_before = c.read(pm, "getSponsorDeposit", H(sponsor)), c.gas("relay")
    rec = c.send_params("broadcast the SDK sponsored payload (fixed 2.5 GAS system fee, 0.5 GAS network fee)",
                        [{"w": "relay"}], core, "executeSponsoredUserOp", harness_params(0),
                        script=base64.b64decode(first["script"]), probe_fault_ok=True,
                        fixed_sysfee=GAS * 5 // 2, netfee=GAS // 2)
    dep_after, relay_after = c.read(pm, "getSponsorDeposit", H(sponsor)), c.gas("relay")
    settled = dep_before - dep_after
    log = c.rpc("getapplicationlog", [rec["txid"]])["executions"][0]
    reimb = [n for n in log.get("notifications", []) if n["eventname"] == "Reimbursed"]
    c.check(rec.get("outcome") == "HALT", "the SDK sponsored operation HALTed on the deployed core")
    c.check("SponsoredUserOpExecuted" in rec.get("events", []), "the core emitted SponsoredUserOpExecuted")
    c.check(x.nonce(acct) == nonce_before + 1, "the SDK sponsored operation consumed the account nonce")
    c.check(len(reimb) == 1, "the paymaster emitted exactly one Reimbursed event")
    fields = reimb[0]["state"]["value"] if reimb else []
    c.check(len(fields) > 3 and int(fields[3]["value"]) == settled,
            "the Reimbursed amount is the amount the sponsor deposit lost")
    c.check(_event_hash(fields[0]) == sponsor if fields else False, "Reimbursed names the sponsor")
    c.check(_event_hash(fields[2]) == c.hashes["relay"] if len(fields) > 2 else False, "Reimbursed names the relay")
    c.check(0 < settled < requested, "the settlement is positive and below the 5 GAS that was requested")
    c.check(c.read(pm, "getSponsorDeposit", H(buyer)) == control_before,
            "the unrelated sponsor deposit is untouched, so the debit is attributable")
    c.check(relay_after - relay_before == settled - fixed_fee,
            "the relay's net position moves by the settlement minus the fee it paid")
    c.records.append({"step": "settlement of the SDK sponsored operation", "requestedDatoshi": requested,
                      "settledDatoshi": settled, "relayNetDatoshi": relay_after - relay_before,
                      "feePaidDatoshi": fixed_fee, "gasConsumed": rec.get("gas"),
                      "innerGasConsumed": inner_probe.get("gasconsumed"),
                      "reimbursed": int(fields[3]["value"]) if len(fields) > 3 else None})

    # 5. The bound below the real fee refuses on chain and moves nothing; above it, the same payload settles.
    c.send("sponsor re-binds the policy to a 1 GAS per-operation bound", [{"w": "sponsor"}], pm, "setPolicy",
           [H(acct), H(target), S("transfer"), I(1 * GAS), I(0), I(0), I(0)])
    dep_probe, relay_probe = c.read(pm, "getSponsorDeposit", H(sponsor)), c.gas("relay")
    nonce_probe = x.nonce(acct)
    refused, exit_code = sdk_payload(nonce_probe)
    if not refused.get("ok"):
        raise Fail(f"the SDK refused a well-formed payload: {refused.get('error')}")
    refused_rec = c.send_params("broadcast the SDK payload whose settlement exceeds the 1 GAS bound",
                                [{"w": "relay"}], core, "executeSponsoredUserOp", harness_params(nonce_probe),
                                script=base64.b64decode(refused["script"]), probe_fault_ok=True,
                                fixed_sysfee=GAS * 5 // 2, netfee=GAS // 2, onchain_fault="Exceeds per-operation limit")
    c.check(refused_rec.get("outcome") == "FAULT" and refused_rec.get("onChain") is True,
            "the 1 GAS bound refuses the SDK payload on chain")
    c.check(c.read(pm, "getSponsorDeposit", H(sponsor)) == dep_probe, "the refused SDK payload left the deposit untouched")
    c.check(x.nonce(acct) == nonce_probe, "the refused SDK payload left the account nonce unconsumed")
    c.check(_notification(c, refused_rec["txid"], "Reimbursed") is None, "the refused SDK payload emitted no Reimbursed event")
    c.check(c.gas("relay") == relay_probe - fixed_fee, "the refused SDK payload cost the relay its own fee")
    c.send("sponsor re-binds the policy to a 6 GAS per-operation bound", [{"w": "sponsor"}], pm, "setPolicy",
           [H(acct), H(target), S("transfer"), I(6 * GAS), I(0), I(0), I(0)])
    allowed, exit_code = sdk_payload(nonce_probe)
    if not allowed.get("ok"):
        raise Fail(f"the SDK refused a well-formed payload: {allowed.get('error')}")
    dep_allowed, relay_allowed = c.read(pm, "getSponsorDeposit", H(sponsor)), c.gas("relay")
    allowed_rec = c.send_params("the same SDK payload settles inside the 6 GAS bound",
                                [{"w": "relay"}], core, "executeSponsoredUserOp", harness_params(nonce_probe),
                                script=base64.b64decode(allowed["script"]), probe_fault_ok=True,
                                fixed_sysfee=GAS * 5 // 2, netfee=GAS // 2)
    allowed_settled = dep_allowed - c.read(pm, "getSponsorDeposit", H(sponsor))
    c.check(allowed_rec.get("outcome") == "HALT", "the same SDK payload HALTed inside the 6 GAS bound")
    c.check(0 < allowed_settled < requested, "the allowed SDK payload settled below the requested amount again")
    c.check(c.gas("relay") - relay_allowed == allowed_settled - fixed_fee,
            "the relay is made whole on the allowed side of the bound")

    # 6. The SDK refuses a zero or negative sponsorship request before anything is built.
    for label, amount in (("zero", 0), ("negative", -1)):
        body, exit_code = sdk_payload(nonce_probe, amount=amount)
        c.check(exit_code != 0 and body.get("ok") is not True, f"the SDK refuses a {label} reimbursement request")

    return {"sdkScriptSimulation": sponsored_probe.get("state"), "settled": settled, "requested": requested,
            "innerGasConsumed": inner_probe.get("gasconsumed"), "sponsoredGasConsumed": rec.get("gas"),
            "argumentTypes": shape.get("types")}


def sc_timelock_boundaries(c, x):
    """AA-10 the 24 h configuration timelock and the 7 d escape timelock, observed on both sides of the
    boundary: the change is refused strictly before the on-chain deadline and executes at or after it, with
    both observations read from the chain rather than assumed from the jump that was requested."""
    c.records.append({"scenario": "AA-10 timelock boundaries: 24 h configuration and 7 d escape"})
    sess_v, hook = c.contracts["SessionKeyVerifier"], c.contracts["WhitelistHook"]
    target = c.contracts["MockTransferTarget"]
    key = v.P256Key(x.workdir, "boundary-session")
    account, proxy = x.register("boundary-session", verifier=sess_v)
    sess_args = [H(account), B(key.compressed), H(target), S("transfer"), I(c.now_ms() + 20 * DAY * 1000), I(0), S("boundary-session")]
    rec = c.send("arm setSessionKey for the boundary account (24 h timelock)", [{"w": "owner"}], x.core, "callVerifier",
                 [H(account), S("setSessionKey"), A(*sess_args)])
    c.check(rec["result"] is False, "first call arms the 24 h timelock and returns false")
    deadline = c.read(x.core, "getPendingVerifierCallTime", H(account))
    c.check(deadline > c.now_ms(), "the chain records a 24 h deadline in the future for the verifier call")
    hooked, hproxy = x.register("boundary-hook", hook=hook)
    whitelist_args = [H(hooked), H(target), BOOL(True)]
    rec = c.send("arm setWhitelist for the boundary account (24 h timelock)", [{"w": "owner"}], x.core, "callHook",
                 [H(hooked), S("setWhitelist"), A(*whitelist_args)])
    c.check(rec["result"] is False, "first call arms the hook timelock and returns false")
    hook_deadline = c.read(x.core, "getPendingHookCallTime", H(hooked))
    c.check(hook_deadline > c.now_ms(), "the chain records a 24 h deadline in the future for the hook call")
    esc, eproxy = x.register("boundary-escape", timelock=TL, owner="merchant")
    c.send("initiateEscape for the boundary account", [{"w": "merchant"}], x.core, "initiateEscape", [H(esc)])
    initiated = c.read(x.core, "getEscapeTriggeredAt", H(esc))
    escape_timelock = c.read(x.core, "getEscapeTimelock", H(esc))
    escape_deadline = initiated + escape_timelock * 1000
    c.check(escape_timelock == TL and escape_deadline - initiated == 7 * DAY * 1000,
            "the escape deadline is exactly 7 days after initiation")

    def session_denied(step):
        c.send(step, [{"w": "owner"}], x.core, "callVerifier", [H(account), S("setSessionKey"), A(*sess_args)],
               expect="FAULT", expect_text="Timelock not elapsed")

    def hook_denied(step):
        c.send(step, [{"w": "owner"}], x.core, "callHook", [H(hooked), S("setWhitelist"), A(*whitelist_args)],
               expect="FAULT", expect_text="Timelock not elapsed")

    def escape_denied(step):
        c.send(step, [{"w": "merchant"}], x.core, "finalizeEscape", [H(esc), H(ZERO)], expect="FAULT", expect_text="Timelock active")

    # Both sides are read from the chain: the deny side strictly before the earliest 24 h deadline, the
    # allow side at or after the later one, and the 7 d escape has its own pair further out.
    first_deny = c.now_ms()
    session_denied("second setSessionKey call at the start of the timelock")
    hook_denied("second setWhitelist call at the start of the timelock")
    escape_denied("finalizeEscape at the start of the 7 d timelock")
    c.check(first_deny < min(deadline, hook_deadline), "the first deny side is strictly before the 24 h deadlines")
    before24, denied24 = c.jump_to(min(deadline, hook_deadline) - 60_000)
    c.records.append({"step": "24 h boundary deny side", "chainTimeBeforeMs": before24, "chainTimeMs": denied24,
                      "verifierDeadlineMs": deadline, "hookDeadlineMs": hook_deadline})
    c.check(denied24 < min(deadline, hook_deadline), "the deny side is observed strictly before the 24 h deadlines")
    session_denied("second setSessionKey call just before the 24 h deadline")
    hook_denied("second setWhitelist call just before the 24 h deadline")
    c.check(c.read(x.core, "hasPendingVerifierCall", H(account)) is True, "the armed verifier call is still pending, not applied")
    stored = c.read(sess_v, "getSessionKey", H(account))
    c.check((stored[0] if isinstance(stored, (list, tuple)) else stored) != key.compressed,
            "the session key was not stored before the 24 h deadline")
    c.check(c.read(hook, "isWhitelisted", H(hooked), H(target)) is False, "the hook target was not whitelisted before the 24 h deadline")
    _, allowed24 = c.jump_to(max(deadline, hook_deadline) + 60_000)
    c.records.append({"step": "24 h boundary allow side", "chainTimeMs": allowed24,
                      "verifierDeadlineMs": deadline, "hookDeadlineMs": hook_deadline})
    c.check(allowed24 >= max(deadline, hook_deadline), "the allow side is observed at or after both 24 h deadlines")
    c.send("second setSessionKey call after the 24 h deadline", [{"w": "owner"}], x.core, "callVerifier",
           [H(account), S("setSessionKey"), A(*sess_args)])
    c.check(c.read(sess_v, "getSessionKey", H(account))[0] == key.compressed, "the session key is stored after the 24 h deadline")
    c.send("second setWhitelist call after the 24 h deadline", [{"w": "owner"}], x.core, "callHook",
           [H(hooked), S("setWhitelist"), A(*whitelist_args)])
    c.check(c.read(hook, "isWhitelisted", H(hooked), H(target)) is True, "the hook target is whitelisted after the 24 h deadline")
    escape_denied("finalizeEscape after the 24 h deadlines but before the 7 d one")
    before7, denied7 = c.jump_to(escape_deadline - 60_000)
    c.records.append({"step": "7 d boundary deny side", "chainTimeBeforeMs": before7, "chainTimeMs": denied7,
                      "escapeDeadlineMs": escape_deadline})
    c.check(denied7 < escape_deadline, "the deny side is observed strictly before the 7 d escape deadline")
    escape_denied("finalizeEscape just before the 7 d deadline")
    c.check(c.read(x.core, "isEscapeActive", H(esc)) is True, "the escape is still active before the 7 d deadline")
    _, allowed7 = c.jump_to(escape_deadline + 60_000)
    c.records.append({"step": "7 d boundary allow side", "chainTimeMs": allowed7, "escapeDeadlineMs": escape_deadline})
    c.check(allowed7 >= escape_deadline, "the allow side is observed at or after the 7 d escape deadline")
    c.send("finalizeEscape after the 7 d deadline", [{"w": "merchant"}], x.core, "finalizeEscape", [H(esc), H(ZERO)])
    c.check(c.read(x.core, "isEscapeActive", H(esc)) is False, "the escape is finalized after the 7 d deadline")
    x.timelock_boundaries = [
        {"timelock": "24h-config-update", "deadlineMs": max(deadline, hook_deadline),
         "earliestDeadlineMs": min(deadline, hook_deadline), "deniedAtMs": denied24, "allowedAtMs": allowed24,
         "observedDenied": True, "observedAllowed": True},
        {"timelock": "7d-escape", "deadlineMs": escape_deadline, "earliestDeadlineMs": escape_deadline,
         "deniedAtMs": denied7, "allowedAtMs": allowed7, "observedDenied": True, "observedAllowed": True},
    ]
    return {"chainTimeMs": allowed7, "boundaries": x.timelock_boundaries}


def sc_relay_route(c, x):
    """AA-09 the AA frontend's real relay route against the local chain."""
    c.records.append({"scenario": "AA-09 gasless submission through the AA relay route (frontend/api/relay-transaction.js)"})
    acct, proxy = x.accounts["session-relay"]["id"], x.accounts["session-relay"]["proxy"]
    target, sess_v = c.contracts["MockTransferTarget"], c.contracts["SessionKeyVerifier"]
    nonce = x.nonce(acct)
    ar = [H(proxy), H(c.hashes["buyer"]), I(1000), B(b"")]
    payload = c.read(sess_v, "getPayload", H(acct), H(target), S("transfer"), A(*ar), I(nonce), I(FAR_DEADLINE))
    sig = x.sesskey.sign(payload)
    # The paymaster cases below never broadcast on the relay account (they must all be refused), but a
    # preflight reads the nonce, so they use the account's next unused operation.
    payload_next = c.read(sess_v, "getPayload", H(acct), H(target), S("transfer"), A(*ar), I(nonce + 1), I(FAR_DEADLINE))
    sig_next = x.sesskey.sign(payload_next)
    # The sponsored shape the route carries in case 16, signed for the policy account of AA-08 whose sponsor
    # deposit is still funded: a 2 GAS request inside the 4 GAS policy bound the paymaster holds at this point.
    pm_acct, pm_proxy = x.accounts["session-pm"]["id"], x.accounts["session-pm"]["proxy"]
    pm_nonce = x.nonce(pm_acct)
    sar = [H(pm_proxy), H(c.hashes["buyer"]), I(1000), B(b"")]
    spayload = c.read(sess_v, "getPayload", H(pm_acct), H(target), S("transfer"), A(*sar), I(pm_nonce), I(FAR_DEADLINE))
    sponsored_fixture = {"accountId": pm_acct, "target": target, "method": "transfer",
                         "methodArgs": [{"type": "Hash160", "value": pm_proxy}, {"type": "Hash160", "value": c.hashes["buyer"]},
                                        {"type": "Integer", "value": "1000"}, {"type": "ByteArray", "value": "0x"}],
                         "nonce": str(pm_nonce), "deadline": str(FAR_DEADLINE), "signatureHex": x.sesskey.sign(spayload).hex(),
                         "paymaster": c.contracts["AAPaymaster"], "sponsor": c.hashes["sponsor"],
                         "reimbursementAmount": str(2 * GAS)}
    fixture = {"rpcUrl": f"http://127.0.0.1:{c.port}", "core": x.core, "accountId": acct, "target": target, "method": "transfer",
               "methodArgs": [{"type": "Hash160", "value": proxy}, {"type": "Hash160", "value": c.hashes["buyer"]}, {"type": "Integer", "value": "1000"}, {"type": "ByteArray", "value": "0x"}],
               "nonce": str(nonce), "deadline": str(FAR_DEADLINE), "signatureHex": sig.hex(), "otherHash": c.contracts["MockTransferTarget"],
               "nonceNext": str(nonce + 1), "signatureHexNext": sig_next.hex(),
               "gasFixture": getattr(x, "gas_fixture", None), "sponsored": sponsored_fixture}
    fx = x.workdir / "relay-fixture.json"
    fx.write_text(json.dumps(fixture))
    env = {k: os.environ[k] for k in ("PATH", "HOME", "TMPDIR", "LANG") if k in os.environ}
    env["RELAY_PRIVATE_KEY_HEX"] = c.keys["relay"].der.read_bytes()[7:39].hex()  # raw scalar of the throwaway dev key
    env["NODE_ENV"] = "development"
    done = subprocess.run([shutil.which("node") or "node", str(Path(__file__).with_name("relay_probe.mjs")), str(fx)], capture_output=True, text=True, env=env, timeout=180)
    c.records.append({"relayProbeExit": done.returncode, "stderrTail": done.stderr[-500:]})
    if done.returncode != 0:
        raise Fail(f"relay probe failed: {done.stderr[-300:]}")
    results = json.loads(done.stdout.strip().splitlines()[-1])
    c.records.append({"relayResults": results})
    by = {r["case"].split()[0]: r for r in results}
    after = nonce
    for _ in range(30):
        after = x.nonce(acct)
        if after > nonce:
            break
        time.sleep(1)
    c.check(by["1"].get("ok") is True and by["1"].get("vmState") == "HALT", "preflight simulation accepts the valid session-signed op")
    c.check(by["2"].get("ok") is False and by["2"].get("code") == "relay_simulation_fault", "preflight reports a fault for a tampered signature")
    c.check(by["3"].get("status") == 402 and by["3"].get("error") == "paymaster_denied", "default posture (no paymaster, no opt-in) refuses to broadcast")
    c.check(by["4"].get("status") == 400 and by["4"].get("error") == "relay_fee_ceiling_not_configured", "no fee ceiling: refuses to broadcast")
    c.check(by["5"].get("status") == 400 and by["5"].get("error") == "relay_meta_invocation_not_allowed", "op addressed to another contract refused before signing")
    c.check(by["6"].get("txid") is None and by["6"].get("status") in (400, 502), "a fee ceiling below the real cost stops the broadcast")
    c.check(by["7"].get("status") == 200 and bool(by["7"].get("txid")), "gasless broadcast returned a txid")
    if "8" in by and getattr(x, "gas_fixture", None):
        g = x.gas_fixture
        c.check(by["8"].get("ok") is False and by["8"].get("code") == "relay_transfer_returned_false", "8. preflight refuses a session-signed GAS transfer that returns false")
        c.check(by["8"].get("stackFirst") in (False, "false", 0), "8. refusal preserves the false transfer result (proxy is not a witness)")
        c.check(by["9"].get("status") == 200 and by["9"].get("ok") is False and by["9"].get("code") == "relay_transfer_returned_false" and not by["9"].get("txid"), "9. broadcast refuses the false transfer without a txid")
        c.check(x.nonce(g["accountId"]) == int(g["nonce"]), "9. refused transfer leaves the nonce unchanged")
        c.check(c.gas(g["proxy"]) == 10 * GAS, "9. refused transfer leaves the proxy GAS balance unchanged")
    c.check(after == nonce + 1, "the user-operation nonce advanced on chain")
    # 10-15 the paymaster branch of the route: an approval is consulted on a loopback endpoint and must be
    # positive, operation-bound and inside its own fee ceiling before the relay signs anything.
    c.check(by["10"].get("status") == 200 and by["10"].get("ok") is True and by["10"].get("paymaster", {}).get("approved") is True,
            "10. preflight reports the paymaster approval it received")
    c.check(by["10"].get("waitedForCase7") is True and by["10"].get("case7VmState") == "HALT",
            "10. the case-7 broadcast was observed on chain before the paymaster cases")
    c.check(by["10"].get("paymaster", {}).get("operation_hash") == "0x" + by["10"].get("expectedOperationHash", "")
            == by["10"].get("sentOperationHash"),
            "10. the approval echoes the operation hash the route sent")
    c.records.append({"step": "paymaster authorization requests received by the loopback stub", "requests": by["10"].get("paymasterRequests")})
    first = (by["10"].get("paymasterRequests") or [{}])[0]
    c.check(first.get("authorization") == "Bearer loopback-paymaster-token", "10. the paymaster request carries the operator bearer token")
    c.check(first.get("body", {}).get("account_id") == acct.lower() and first.get("body", {}).get("userop_target_contract") == target.lower()
            and first.get("body", {}).get("userop_method") == "transfer" and len(first.get("body", {}).get("operation_hash", "")) == 66,
            "10. the paymaster request is bound to the account, the downstream call and the operation hash")
    c.check(by["11"].get("status") == 502 and by["11"].get("error") == "paymaster_authorization_failed" and not by["11"].get("txid"),
            "11. an approval echoing another operation hash stops the broadcast")
    c.check(by["12"].get("status") == 402 and by["12"].get("error") == "paymaster_denied" and by["12"].get("paymaster", {}).get("approved") is False,
            "12. an explicit paymaster denial stops the broadcast with paymaster_denied")
    c.check(by["13"].get("status") == 502 and by["13"].get("error") == "paymaster_authorization_failed" and not by["13"].get("txid"),
            "13. an answer without a positive approval is not treated as an approval")
    c.check(by["14"].get("status") == 502 and not by["14"].get("txid"), "14. an approval ceiling below the real cost stops the broadcast")
    c.check(by["15"].get("status") == 502 and by["15"].get("error") == "paymaster_authorization_failed" and not by["15"].get("txid"),
            "15. an unreachable paymaster endpoint fails closed")
    c.check(x.nonce(acct) == nonce + 1, "11-15. none of the refused broadcasts touched the account nonce")
    # 16 the route's own pricing simulation of an on-chain sponsored invocation: the deployed core caps
    # the settlement at the transaction's real fees, which are zero in a pricing container, so the route
    # refuses the operation before signing. Recorded as a limit of the deployed stack (CU-162).
    sponsored = fixture["sponsored"]
    sponsored_nonce = x.nonce(sponsored["accountId"])
    sponsor_deposit = c.read(c.contracts["AAPaymaster"], "getSponsorDeposit", H(c.hashes["sponsor"]))
    c.check(by["16"].get("status") == 200 and by["16"].get("ok") is False
            and by["16"].get("code") == "relay_simulation_fault" and not by["16"].get("txid"),
            "16. the deployed route refuses an on-chain sponsored invocation before signing")
    c.check("Reimbursement exceeds actual gas cost" in (by["16"].get("exception") or ""),
            "16. the refusal names the deployed core's settlement cap in the pricing container")
    c.check(x.nonce(sponsored["accountId"]) == sponsored_nonce
            and c.read(c.contracts["AAPaymaster"], "getSponsorDeposit", H(c.hashes["sponsor"])) == sponsor_deposit,
            "16. the refused sponsored invocation touched neither the nonce nor the sponsor deposit")
    return {"relay": results}


# ------------------------------------------------- current-source variant
def sc_source_build_and_native(c, x):
    """SRC-01/02 the build profile of the current source and the native-owner path on a published node."""
    c.records.append({"scenario": "SRC-01/02 current source core: build profile and native-owner execution"})
    profile = x.source_profile
    c.check(profile["coreSha256"] != profile["deployedCoreSha256"],
            "the source variant deploys freshly compiled bytes, not the pinned deployed artifact")
    if profile["profile"] == srcbuild.PROFILE_SYSCALL_PRESENT:
        c.check(profile["validateSignature"] == 1 and profile["postExecute"] == 1,
                "the compiled source core emits System.Contract.CallWithGasLimit for both verifier callbacks")
    else:
        c.check(profile["validateSignature"] == 0 and profile["postExecute"] == 0,
                "the compiled source core emits no gas-bounded verifier callback (DEC-AA-1 is cleared)")
    account, proxy = x.register("source-native")
    c.check(c.hash_of(x.core, "getBackupOwner", H(account)) == c.hashes["owner"], "backup owner recorded")
    c.check(c.hash_of(x.core, "getVerifier", H(account)) == ZERO, "no verifier: native fallback")
    target = c.contracts["MockTransferTarget"]
    c.send("native-owner executeUserOp on the source core", [{"w": "owner"}], x.core, "executeUserOp",
           [H(account), x.op(target, "transfer", [H(proxy), H(c.hashes["buyer"]), I(1000), B(b"")], 0)])
    c.check(x.nonce(account) == 1, "native-witness operation HALTed and advanced the nonce")
    return {"profile": profile["profile"]}


def sc_source_proxy_witness(c, x):
    """SRC-03 the proxy-witness path with no verifier: it never reaches the gas-bounded syscall."""
    c.records.append({"scenario": "SRC-03 current source core: proxy witness without a verifier"})
    core = x.core
    account, proxy = x.register("source-gas")
    owner, buyer = c.hashes["owner"], c.hashes["buyer"]
    c.send("fund the proxy address with 10 GAS", [{"w": "owner"}], GAS_HASH, "transfer",
           [H(owner), H(proxy), I(10 * GAS), B(b"")])
    c.check(c.gas(proxy) == 10 * GAS, "proxy address holds 10 GAS")
    c.send("admin sets the verify-scope target to GAS", [{"w": "deployer"}], core, "setVerifyScopeTarget",
           [H(account), H(GAS_HASH)])
    c.check(c.hash_of(core, "getVerifyScopeTarget", H(account)) == GAS_HASH, "scope target recorded")
    pscript = proxy_script_for(account, core)
    psig = lambda target: {"proxy": proxy, "core": core, "target": target, "script": pscript}
    gas_op = lambda n: x.op(GAS_HASH, "transfer", [H(proxy), H(buyer), I(GAS), B(b"")], n)
    before = c.gas(buyer)
    rec = c.send("proxy-witness GAS transfer on the source core", [{"w": "owner"}, psig(GAS_HASH)], core,
                 "executeUserOp", [H(account), gas_op(0)])
    c.check(rec["outcome"] == "HALT", "the proxy-witness operation HALTed and moved the signed amount")
    c.check(c.gas(buyer) - before == GAS, "buyer received exactly 1 GAS from the AA proxy address")
    c.check(c.gas(proxy) == 9 * GAS, "proxy address paid exactly 1 GAS; the owner wallet paid the fees")
    c.check(x.nonce(account) == 1, "nonce advanced")
    rec = c.send("proxy rules naming another asset are still refused by the node", [{"w": "owner"}, psig(NEO_HASH)],
                 core, "executeUserOp", [H(account), gas_op(1)], expect="REJECT")
    c.check(rec["outcome"] == "REJECTED", "proxy rules naming another asset are still refused by the node")
    return {}


def sc_source_verifier_callback(c, x):
    """SRC-04 the verifier validateSignature callback: the DEC-AA-1 fault, or execution after the profile."""
    c.records.append({"scenario": "SRC-04 current source core: verifier callback (validateSignature)"})
    verifier, target = c.contracts["WebAuthnVerifier"], c.contracts["MockTransferTarget"]
    key = v.P256Key(x.workdir, "source-p256")
    account, proxy = x.register("source-p256", verifier=verifier, params=key.compressed)
    args = [H(proxy), H(c.hashes["buyer"]), I(1000), B(b"")]
    payload = c.read(verifier, "getPayload", H(account), H(target), S("transfer"), A(*args), I(0), I(FAR_DEADLINE))
    op = x.op(target, "transfer", args, 0, sig=key.sign(payload))
    if x.source_profile["profile"] == srcbuild.PROFILE_SYSCALL_PRESENT:
        rec = c.send("verifier-signed operation on the source core (expected DEC-AA-1 fault)", [{"w": "relay"}],
                     x.core, "executeUserOp", [H(account), op], expect="FAULT")
        c.check(SOURCE_FAULT_MARKER in (rec.get("exception") or ""),
                "DEC-AA-1 expected fault: the verifier-signed operation faults on a published node")
        c.check(str(srcbuild.INTEROP_HASH) in (rec.get("exception") or ""),
                "the fault names the unregistered interop 1371299780")
        c.check(x.nonce(account) == 0, "the fault left the account nonce unconsumed")
    else:
        rec = c.send("verifier-signed operation on the source core (public profile landed)", [{"w": "relay"}],
                     x.core, "executeUserOp", [H(account), op])
        c.check(rec["outcome"] == "HALT", "DEC-AA-1 cleared: the verifier-signed operation HALTed")
        c.check(x.nonce(account) == 1, "the verifier path advanced the nonce")
    return {}


def sc_source_verifier_proxy_witness(c, x):
    """SRC-03b the verifier-backed proxy witness: a P-256 owner signs a GAS transfer out of the proxy."""
    c.records.append({"scenario": "SRC-03b current source core: verifier-backed proxy witness (P-256)"})
    core, verifier = x.core, c.contracts["WebAuthnVerifier"]
    key = v.P256Key(x.workdir, "source-p256-proxy")
    account, proxy = x.register("source-p256-proxy", verifier=verifier, params=key.compressed)
    buyer = c.hashes["buyer"]
    c.send("fund the proxy address with 5 GAS", [{"w": "owner"}], GAS_HASH, "transfer",
           [H(c.hashes["owner"]), H(proxy), I(5 * GAS), B(b"")])
    c.send("admin sets the verify-scope target to GAS", [{"w": "deployer"}], core, "setVerifyScopeTarget",
           [H(account), H(GAS_HASH)])
    args = [H(proxy), H(buyer), I(GAS), B(b"")]
    payload = c.read(verifier, "getPayload", H(account), H(GAS_HASH), S("transfer"), A(*args), I(0), I(FAR_DEADLINE))
    op = x.op(GAS_HASH, "transfer", args, 0, sig=key.sign(payload))
    psig = {"proxy": proxy, "core": core, "target": GAS_HASH, "script": proxy_script_for(account, core)}
    before_buyer, before_proxy = c.gas(buyer), c.gas(proxy)
    if x.source_profile["profile"] == srcbuild.PROFILE_SYSCALL_PRESENT:
        rec = c.send("verifier-backed proxy-witness GAS transfer (expected DEC-AA-1 fault)", [{"w": "relay"}, psig],
                     core, "executeUserOp", [H(account), op], expect="FAULT")
        c.check(SOURCE_FAULT_MARKER in (rec.get("exception") or ""),
                "DEC-AA-1 expected fault: the verifier-backed proxy-witness operation faults on a published node")
        c.check(str(srcbuild.INTEROP_HASH) in (rec.get("exception") or ""),
                "the fault names the unregistered interop 1371299780")
        c.check(c.gas(buyer) == before_buyer and c.gas(proxy) == before_proxy and x.nonce(account) == 0,
                "no GAS moved and the nonce is unchanged")
    else:
        c.send("verifier-backed proxy-witness GAS transfer (public profile landed)", [{"w": "relay"}, psig],
               core, "executeUserOp", [H(account), op])
        c.check(c.gas(buyer) - before_buyer == GAS and before_proxy - c.gas(proxy) == GAS,
                "buyer +1 GAS, proxy -1 GAS exactly")
        c.check(x.nonce(account) == 1, "the verifier-backed proxy witness advanced the nonce")
    return {}


def sc_source_proxy_relay(c, x):
    """Fresh-source direct GAS transfer and explicit rejection of unsafe sponsored proxy envelopes."""
    if x.source_profile["profile"] == srcbuild.PROFILE_SYSCALL_PRESENT:
        c.check(True, "public-node relay proof is unavailable for the private-syscall profile")
        return {"supported": False}
    core, verifier, pm = x.core, c.contracts["WebAuthnVerifier"], c.contracts["AAPaymaster"]
    key = v.P256Key(x.workdir, "source-relay-proxy")
    account, proxy = x.register("source-relay-proxy", verifier=verifier, params=key.compressed)
    buyer, sponsor = c.hashes["buyer"], c.hashes["sponsor"]
    c.send("fund source relay proxy with 10 GAS", [{"w": "owner"}], GAS_HASH, "transfer", [H(c.hashes["owner"]), H(proxy), I(10 * GAS), B(b"")])
    c.send("configure source relay proxy GAS scope", [{"w": "deployer"}], core, "setVerifyScopeTarget", [H(account), H(GAS_HASH)])
    c.send("fund source relay sponsor deposit", [{"w": "sponsor"}], GAS_HASH, "transfer", [H(sponsor), H(pm), I(100 * GAS), B(b"")])
    c.send("configure source relay sponsorship policy", [{"w": "sponsor"}], pm, "setPolicy", [H(account), H(GAS_HASH), S("transfer"), I(30 * GAS), I(0), I(0), I(0)])
    ar = [H(proxy), H(buyer), I(GAS), B(b"")]
    def operation(nonce):
        payload = c.read(verifier, "getPayload", H(account), H(GAS_HASH), S("transfer"), A(*ar), I(nonce), I(FAR_DEADLINE))
        return x.op(GAS_HASH, "transfer", ar, nonce, sig=key.sign(payload))
    def invocation(nonce, sponsored=False):
        op = json.loads(json.dumps(operation(nonce)))
        op["type"] = "Struct"
        # rpcx ByteArray values are base64; the route wire protocol carries hex.
        op["value"][-1]["value"] = "0x" + base64.b64decode(op["value"][-1]["value"]).hex()
        op["value"][2]["value"][-1]["value"] = "0x"
        return {"scriptHash": core, "operation": "executeSponsoredUserOp" if sponsored else "executeUserOp",
                "args": [H(account), op] + ([H(pm), H(sponsor), I(30 * GAS)] if sponsored else [])}
    bad = invocation(0)
    bad["args"][1]["value"][-1]["value"] = "0x" + "00" * 64
    fx = {"rpcUrl": f"http://127.0.0.1:{c.port}", "core": core, "accountId": account, "proxy": proxy,
          "buyer": buyer, "owner": c.hashes["owner"], "relay": c.hashes["relay"], "gas": GAS_HASH,
          "paymaster": pm, "sponsor": sponsor, "amount": GAS,
          "invocations": {"invalidSignature": bad, "direct": invocation(0), "sponsored": invocation(1, True)}}
    fixture = x.workdir / "source-proxy-relay.json"
    fixture.write_text(json.dumps(fx))
    env = {k: os.environ[k] for k in ("PATH", "LANG", "TMPDIR") if k in os.environ}
    env["RELAY_PRIVATE_KEY_HEX"] = c.keys["relay"].der.read_bytes()[7:39].hex()
    done = subprocess.run(["node", str(AA / "scripts/localchain/source_proxy_relay_probe.mjs"), str(fixture)],
                          capture_output=True, text=True, env=env, timeout=180)
    if done.returncode:
        raise Fail("source relay probe failed: " + done.stderr[-500:])
    proof = json.loads(done.stdout)
    x.source_proxy_relay = proof
    for case in proof["cases"]:
        if case.get("execution"):
            c.records.append({"step": "source proxy relay " + case["name"], "outcome": case["execution"]["vmstate"], "txid": case["response"].get("txid")})
    c.check(not _source_proxy_relay_failures(proof), "source relay proof binds invalid-signature and fee refusals, direct transfer, nonce, owner and fee payer")
    c.check(proof["cases"][1]["execution"]["vmstate"] == "HALT" and proof["cases"][2]["response"].get("txid") is None, "direct proxy transfer HALTed and sponsored relay transfer was refused")
    psig = {"proxy": proxy, "core": core, "target": GAS_HASH, "script": proxy_script_for(account, core)}
    before = (c.gas(proxy), c.gas(buyer), x.nonce(account), c.read(pm, "getSponsorDeposit", H(sponsor)))
    c.send("correct sponsored proxy envelope remains refused", [{"w": "relay"}, psig], core, "executeSponsoredUserOp",
           [H(account), operation(1), H(pm), H(sponsor), I(GAS)], expect="REJECT")
    c.send("wrong account in sponsored proxy envelope", [{"w": "relay"}, psig], core, "executeSponsoredUserOp",
           [H(c.hashes["stranger"]), operation(1), H(pm), H(sponsor), I(GAS)], expect="REJECT")
    c.send("wrong scope in sponsored proxy envelope", [{"w": "relay"}, dict(psig, target=NEO_HASH)], core, "executeSponsoredUserOp",
           [H(account), operation(1), H(pm), H(sponsor), I(GAS)], expect="REJECT")
    c.check(before == (c.gas(proxy), c.gas(buyer), x.nonce(account), c.read(pm, "getSponsorDeposit", H(sponsor))),
            "all sponsored proxy envelopes are rejected by the node and leave assets, nonce and deposit unchanged")
    return {"supported": True}


def _proxy_data_prefix_only(script):
    cursor = 0
    while cursor < len(script):
        op = script[cursor]
        if op in srcbuild._PUSHDATA_PREFIX:
            width = srcbuild._PUSHDATA_PREFIX[op]
            if cursor + 1 + width > len(script):
                return False
            size = 1 + width + int.from_bytes(script[cursor + 1:cursor + 1 + width], "little")
        elif 0 <= op <= 5:
            size = 1 + srcbuild._OPERAND_SIZE[op]
        elif op in (8, 9, 11, 190, 191, 192, 194, 197, 200) or 15 <= op <= 32:
            size = 1
        elif op == 219:
            size = 2
        else:
            return False
        cursor += size
        if cursor > len(script):
            return False
    return True


def _source_proxy_relay_failures(proof):
    """Load-bearing chain readback; accepting a txid or a green named check alone is insufficient."""
    errors = []
    try:
        proxy_bytes = proxy_script_for(proof["accountId"], proof["core"])
        if proof["proxy"] != "0x" + v.hash160(proxy_bytes)[::-1].hex():
            errors.append("proxy identity derived from this core and account")
        cases = proof["cases"]
        if [r["name"] for r in cases] != ["invalidSignature", "direct", "sponsored"]:
            return ["proxy relay case inventory"]
        bad = cases[0]
        if bad["response"].get("txid") or bad["execution"] is not None or bad["before"] != bad["after"] or bad["response"].get("vmState") != "FAULT":
            errors.append("invalid signature must refuse without state change")
        refusals = proof["refusals"]
        if [row["name"] for row in refusals] != ["missingReserve", "insufficientReserve", "networkFeeCeiling"]:
            errors.append("proxy reserve refusal inventory")
        for row, marker in zip(refusals, ("AA_RELAY_PROXY_NETWORK_FEE_RESERVE", "InsufficientFunds", "AA_RELAY_MAX_NETWORK_FEE")):
            if row["status"] != 502 or row["response"].get("txid") or row["execution"] is not None or row["before"] != row["after"] or marker not in row["response"].get("rawMessage", ""):
                errors.append(row["name"] + " refuses without fee or nonce consumption")
        amount = int(proof["amount"])
        if amount <= 0:
            errors.append("positive transfer amount")
        denied = cases[2]
        if denied["status"] != 502 or denied["response"].get("txid") or denied["execution"] is not None or denied["before"] != denied["after"] or "Sponsored proxy transfers are not supported" not in denied["response"].get("rawMessage", ""):
            errors.append("sponsored proxy relay is explicitly refused without state change")
        for row in cases[1:2]:
            before, after, response, transaction = row["before"], row["after"], row["response"], row["transaction"]
            if row["status"] != 200 or row["execution"]["vmstate"] != "HALT" or transaction["hash"] != response["txid"]:
                errors.append(row["name"] + " persisted HALT")
            if int(after["buyer"]) - int(before["buyer"]) != amount or int(before["proxy"]) - int(after["proxy"]) != amount:
                errors.append(row["name"] + " exact asset movement")
            if int(after["nonce"]) != int(before["nonce"]) + 1 or after["owner"] != before["owner"]:
                errors.append(row["name"] + " nonce and owner unchanged")
            method = "executeSponsoredUserOp" if row["name"] == "sponsored" else "executeUserOp"
            tail = b"\x0c\x14" + v.hash_le(proof["accountId"]) + bytes([0x15 if row["name"] == "sponsored" else 0x12, 0xC0, 0x1F, 0x0C, len(method)]) + method.encode() + b"\x0c\x14" + v.hash_le(proof["core"]) + bytes.fromhex("41627d5b52")
            application_script = base64.b64decode(transaction["script"])
            if not application_script.endswith(tail) or not _proxy_data_prefix_only(application_script[:-len(tail)]):
                errors.append(row["name"] + " exact core/account execution envelope")
            signers = transaction["signers"]
            if len(signers) != 2 or signers[0]["account"] != proof["relay"] or signers[1]["account"] != proof["proxy"]:
                errors.append(row["name"] + " exact fee payer and proxy signers")
            if signers[0]["scopes"] != "CalledByEntry" or signers[1]["scopes"] != "WitnessRules" or signers[1]["rules"] != v.aa_proxy_rules(proof["core"], GAS_HASH):
                errors.append(row["name"] + " exact witness scopes")
            witnesses = transaction["witnesses"]
            if len(witnesses) != 2 or witnesses[1]["invocation"] != "" or base64.b64decode(witnesses[1]["verification"]) != proxy_script_for(proof["accountId"], proof["core"]):
                errors.append(row["name"] + " proxy script identity")
            paid = int(response["systemFee"]) + int(response["networkFee"])
            if paid <= 0 or int(transaction["sysfee"]) + int(transaction["netfee"]) != paid:
                errors.append(row["name"] + " persisted fee accounting")
            debit = int(before["deposit"]) - int(after["deposit"])
            if debit != 0 or int(before["relay"]) - int(after["relay"]) != paid:
                errors.append("direct fee payer balance")
        if cases[0]["after"] != cases[1]["before"] or cases[1]["after"] != cases[2]["before"]:
            errors.append("proxy relay causal state continuity")
    except (KeyError, TypeError, ValueError, IndexError, AttributeError):
        errors.append("complete typed proxy relay evidence")
    return errors


SOURCE_SCENARIOS = [
    ("SRC-01/02 current source core: build profile and native-owner execution", sc_source_build_and_native),
    ("SRC-03 current source core: proxy witness without a verifier", sc_source_proxy_witness),
    ("SRC-04 current source core: verifier callback (validateSignature)", sc_source_verifier_callback),
    ("SRC-03b current source core: verifier-backed proxy witness (P-256)", sc_source_verifier_proxy_witness),
    ("SRC-09 current source relay: proxy GAS and sponsored refusal", sc_source_proxy_relay),
]


# ---------------------------------------------------------------- runner
def _attempt(receipt, c, save, name, fn, *a):
    """Record one scenario: its named checks, its outcome and its failure, then persist the receipt."""
    s0 = time.time()
    row = {"name": name, "status": "PASS"}
    n_before = len(c.records)
    try:
        row["return"] = fn(*a)
    except Fail as e:
        row["status"] = "FAIL"; row["failure"] = str(e)[:700]
    except Exception as e:
        row["status"] = "ERROR"; row["failure"] = f"{type(e).__name__}: {str(e)[:500]}"; row["trace"] = traceback.format_exc()[-900:]
    row["seconds"] = round(time.time() - s0, 1)
    row["checks"] = [r for r in c.records[n_before:] if "check" in r]
    receipt["results"].append(row)
    print(f"[{time.strftime('%H:%M:%S')}] {name}: {row['status']} ({row['seconds']}s) {row.get('failure', '')[:260]}", flush=True)
    save()


def run(variant, workdir, port, receipt_path, plant_mismatch=False):
    t0 = time.time()
    receipt = {"variant": variant, "observedOn": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "results": [], "status": "RUNNING"}
    c, x = Rx(workdir, port), None
    def save():
        receipt["records"] = c.records if c else []
        if x is not None and hasattr(x, "source_proxy_relay"):
            receipt["sourceProxyRelay"] = x.source_proxy_relay
        receipt_path.write_text(json.dumps(receipt, indent=2, default=str) + "\n")
    def attempt(name, fn, *a):
        _attempt(receipt, c, save, name, fn, *a)
    try:
        c, x = bring_up(c, variant, workdir)
        x.plant_mismatch = plant_mismatch
        receipt["tool"] = v.ANSI.sub("", subprocess.run([c.neoxp, "--version"], capture_output=True, text=True, env=c.env).stdout).strip()
        receipt["magic"] = c.magic
        receipt["contracts"] = dict(c.contracts)
        print("up in", round(time.time() - t0, 1), "s; contracts:", len(c.contracts), flush=True)
        attempt("AA-01/02 create + native execute", sc_create_and_execute, c, x)
        attempt("AA-03 send GAS (proxy witness)", sc_native_gas, c, x)
        attempt("AA-04 key verifier (P-256)", sc_key_verifier, c, x)
        attempt("AA-10 timelock boundaries (24 h and 7 d)", sc_timelock_boundaries, c, x)
        receipt["timelockBoundaries"] = getattr(x, "timelock_boundaries", [])
        attempt("arm timelocked configuration", arm_session_and_whitelist, c, x)
        attempt("AA-07b social recovery phase 1", sc_recovery_phase1, c, x)
        c.fastforward(8 * DAY + 3600)
        c.records.append({"step": "chain time advanced 8 days + 1 h offline (neoxp fastfwd) for the 24 h and 7 d timelocks"})
        attempt("AA-05/06/07 session key, hook, escape", sc_session_keys, c, x)
        attempt("AA-07b social recovery phase 2", sc_recovery_phase2, c, x)
        attempt("AA-03b value flow (session key + proxy witness + daily limit)", sc_value_flow, c, x)
        attempt("AA-08 on-chain paymaster", sc_paymaster, c, x)
        attempt("AA-11 SDK sponsored operation end to end", sc_sdk_sponsored, c, x)
        attempt("AA-09 relay route", sc_relay_route, c, x)
        receipt["status"] = "DONE"
    except Exception as e:
        receipt["status"] = "ABORTED"; receipt["abort"] = f"{type(e).__name__}: {str(e)[:700]}"
        print("ABORT", receipt["abort"], flush=True)
    finally:
        if c:
            c.stop()
        receipt["seconds"] = round(time.time() - t0, 1)
        save()
    return receipt


def run_source(workdir, port, receipt_path, source_dir=None):
    """Compile (or reuse) the current source, deploy it, and read the build profile that gates it."""
    t0 = time.time()
    receipt = {"variant": "source", "observedOn": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               "results": [], "status": "RUNNING"}
    c, x = Rx(workdir, port), None
    def save():
        receipt["records"] = c.records if c else []
        if x is not None and hasattr(x, "source_proxy_relay"):
            receipt["sourceProxyRelay"] = x.source_proxy_relay
        receipt_path.write_text(json.dumps(receipt, indent=2, default=str) + "\n")
    def attempt(name, fn, *a):
        _attempt(receipt, c, save, name, fn, *a)
    try:
        if source_dir is None:
            source_dir = srcbuild.build_source_contracts(Path(workdir) / "source")
            receipt["builtFromSource"] = True
        else:
            source_dir = srcbuild.require_artifacts(Path(source_dir))
            receipt["builtFromSource"] = False
        profile = srcbuild.profile_of(source_dir / "UnifiedSmartWalletV3.nef")
        profile["deployedCoreSha256"] = hashlib.sha256(
            (AA / "contracts/build/UnifiedSmartWalletV3.nef").read_bytes()).hexdigest()
        profile["sourceDir"] = str(source_dir)
        receipt["profile"] = profile["profile"]
        receipt["source"] = profile
        c, x = bring_up(c, "source", workdir, bin_dir=source_dir)
        x.source_profile = profile
        receipt["tool"] = v.ANSI.sub("", subprocess.run([c.neoxp, "--version"], capture_output=True, text=True, env=c.env).stdout).strip()
        receipt["magic"] = c.magic
        receipt["contracts"] = dict(c.contracts)
        print(f"source build {profile['profile']}: validateSignature={profile['validateSignature']}, "
              f"postExecute={profile['postExecute']}, {profile['bytes']} bytes", flush=True)
        print("up in", round(time.time() - t0, 1), "s; contracts:", len(c.contracts), flush=True)
        for name, fn in SOURCE_SCENARIOS:
            attempt(name, fn, c, x)
        receipt["sourceProxyRelay"] = getattr(x, "source_proxy_relay", None)
        receipt["status"] = "DONE"
    except Exception as e:
        receipt["status"] = "ABORTED"; receipt["abort"] = f"{type(e).__name__}: {str(e)[:700]}"
        print("ABORT", receipt["abort"], flush=True)
    finally:
        if c:
            c.stop()
        receipt["seconds"] = round(time.time() - t0, 1)
        save()
    return receipt


def validate_artifacts(expected):
    for artifact in expected["artifacts"]:
        name = artifact["path"]
        if hashlib.sha256((AA / name).read_bytes()).hexdigest() != artifact["sha256"]:
            raise Fail(f"deployed artifact mismatch: {name}")


def _inventory_failures(receipt, scenarios, totals, counts_label):
    failures = []

    def check(ok, name):
        if not ok:
            failures.append(name)
    results = receipt["results"]
    check([s["name"] for s in results] == [s["name"] for s in scenarios], "scenario inventory")
    for actual, wanted in zip(results, scenarios):
        check(actual["status"] == "PASS", wanted["name"])
        check(actual["checks"] == [{"check": n, "ok": True} for n in wanted["checks"]],
              f"named checks: {wanted['name']}")
    checks = [r for r in receipt["records"] if "check" in r]
    check(checks == [c for s in results for c in s["checks"]], "recorded checks match scenarios")
    check(len(checks) == totals["checks"] and all(c["ok"] is True for c in checks),
          f"{totals['checks']} successful checks")
    counts = Counter(r["outcome"] for r in receipt["records"] if "outcome" in r)
    wanted_counts = {"HALT": totals["executedTransactions"],
                     "FAULT": totals["simulatedFaults"],
                     "REJECTED": totals["nodeRefusals"]}
    check(all(counts.get(outcome, 0) == count for outcome, count in wanted_counts.items())
          and set(counts) <= set(wanted_counts), counts_label)
    return failures


def _boundary_failures(receipt):
    """The timelock walks must record both sides of each on-chain deadline, with the observed chain time
    strictly before it on the deny side and at or after it on the allow side. A receipt that reports a
    boundary without those four readings is not evidence that the boundary was crossed."""
    boundaries = receipt.get("timelockBoundaries")
    if not isinstance(boundaries, list) or [b.get("timelock") for b in boundaries] != ["24h-config-update", "7d-escape"]:
        return ["timelock boundaries: the 24 h and the 7 d walk are recorded, in order"]
    failures = []
    for boundary in boundaries:
        name = boundary["timelock"]
        if boundary.get("observedDenied") is not True or boundary.get("observedAllowed") is not True:
            failures.append(f"timelock boundaries: {name} observed on both sides")
            continue
        try:
            earliest, deadline = int(boundary["earliestDeadlineMs"]), int(boundary["deadlineMs"])
            denied, allowed = int(boundary["deniedAtMs"]), int(boundary["allowedAtMs"])
        except (KeyError, TypeError, ValueError):
            failures.append(f"timelock boundaries: {name} records the chain time on both sides")
            continue
        if not (denied < earliest <= deadline <= allowed):
            failures.append(f"timelock boundaries: {name} observed times straddle the on-chain deadline")
    return failures


def validate_receipt(receipt, expected):
    failures = []
    if receipt["status"] != "DONE":
        failures.append("suite completed")
    if receipt["variant"] != expected["variant"]:
        failures.append("deployed variant")
    failures += _boundary_failures(receipt)
    totals = expected["totals"]
    failures += _inventory_failures(
        receipt, expected["scenarios"], totals,
        "transaction outcomes: %d executed, %d simulated faults, %d refusals"
        % (totals["executedTransactions"], totals["simulatedFaults"], totals["nodeRefusals"]))
    return failures


def validate_source_receipt(receipt, expected):
    """The source variant's gate: the build profile decides which half of the expectations applies."""
    failures = []
    profile = receipt.get("profile")
    if profile not in expected["profiles"]:
        return [f"known source build profile: {profile!r}"]
    wanted = expected["profiles"][profile]
    if receipt["status"] != "DONE":
        failures.append("suite completed")
    if receipt["variant"] != expected["variant"]:
        failures.append("source variant")
    source = receipt.get("source") or {}
    build = wanted["build"]
    if source.get("validateSignature") != build["validateSignature"]:
        failures.append("validateSignature call sites in the compiled core")
    if source.get("postExecute") != build["postExecute"]:
        failures.append("postExecute call sites in the compiled core")
    if bool(source.get("gasBoundedSyscall")) != (build["gasBounded"] == "present"):
        failures.append("the recorded call sites match the declared build profile")
    if not source.get("coreSha256"):
        failures.append("the source core digest is recorded")
    elif source["coreSha256"] == expected["deployedCore"]["sha256"]:
        failures.append("the source build is not the deployed artifact")
    if profile == srcbuild.PROFILE_SYSCALL_ABSENT:
        proof = receipt.get("sourceProxyRelay") or {}
        failures += _source_proxy_relay_failures(proof)
        if proof.get("core") != (receipt.get("contracts") or {}).get("UnifiedSmartWalletV3"):
            failures.append("proxy relay proof uses the deployed source core")
        if proof.get("amount") != GAS:
            failures.append("proxy relay proof transfers exactly one GAS")
    totals = wanted["totals"]
    failures += _inventory_failures(
        receipt, wanted["scenarios"], totals,
        "transaction outcomes: %d executed, %d simulated faults, %d refusals"
        % (totals["executedTransactions"], totals["simulatedFaults"], totals["nodeRefusals"]))
    return failures


def free_port_pair():
    for _ in range(100):
        port = random.SystemRandom().randrange(20000, 60000)
        with socket.socket() as rpc, socket.socket() as peer:
            try:
                rpc.bind(("127.0.0.1", port))
                peer.bind(("127.0.0.1", port + 1))
                return port
            except OSError:
                continue
    raise Fail("no free loopback port pair")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--variant", choices=["deployed", "source"], required=True)
    ap.add_argument("--receipt", type=Path, help="receipt path (default: out/rpc-<variant>.json)")
    ap.add_argument("--source-dir", type=Path, help="reuse a current-source build (source variant only)")
    ap.add_argument("--plant-mismatch", choices=["verifier"], help="negative control (deployed variant only): register the native account with a verifier")
    a = ap.parse_args()
    if a.variant == "deployed" and a.source_dir:
        ap.error("--source-dir is only for the source variant")
    if a.variant == "source" and a.plant_mismatch:
        ap.error("--plant-mismatch is only for the deployed variant")
    a.receipt = a.receipt or (AA / f"tests/localchain/out/rpc-{a.variant}.json")
    a.receipt.parent.mkdir(parents=True, exist_ok=True)
    # A failed prerequisite must never leave a successful receipt from an earlier invocation.
    a.receipt.unlink(missing_ok=True)
    if a.variant == "deployed":
        expected = json.loads(EXPECTED.read_text())
        validate_artifacts(expected)
    else:
        expected = json.loads(EXPECTED_SOURCE.read_text())
        if expected.get("variant") != "source" or not expected.get("profiles"):
            raise Fail("the source expectations are incomplete")
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f"signal {signum}")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    # This process owns the chain, keys and node PID, including when setup or a scenario fails.
    with tempfile.TemporaryDirectory(prefix="aa-localchain-", dir="/private/tmp" if sys.platform == "darwin" else "/tmp") as workdir:
        port = free_port_pair()
        print(f"Disposable neoxp: 127.0.0.1:{port}, data {workdir}", flush=True)
        if a.variant == "deployed":
            receipt = run(a.variant, workdir, port, a.receipt, bool(a.plant_mismatch))
        else:
            receipt = run_source(workdir, port, a.receipt, a.source_dir)
    failures = validate_receipt(receipt, expected) if a.variant == "deployed" \
        else validate_source_receipt(receipt, expected)
    receipt["gateFailures"] = failures
    if a.variant == "deployed":
        receipt["artifacts"] = expected["artifacts"]
    a.receipt.write_text(json.dumps(receipt, indent=2, default=str) + "\n")
    for failure in failures:
        print(f"FAIL: {failure}")
    counts = Counter(r["outcome"] for r in receipt["records"] if "outcome" in r)
    checks = [r for r in receipt["records"] if "check" in r]
    print(f"{'FAIL' if failures else 'PASS'}: {sum(c['ok'] is True for c in checks)}/{len(checks)} checks; "
          f"{counts['HALT']} executed transactions; {counts['FAULT']} simulated faults; "
          f"{counts['REJECTED']} node refusals; {receipt['seconds']}s")
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Fail, OSError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)

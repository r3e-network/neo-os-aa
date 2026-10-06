#!/usr/bin/env python3
"""AA module: local-chain acceptance scenarios (RPC-driven, published neoxp, no private hardfork).
Variant 'deployed' uses the unchanged contracts/build artifacts assessed on 2026-10-05."""
import argparse, base64, datetime as dt, json, os, shutil, subprocess, sys, time, traceback
import signal, socket, tempfile, random
from collections import Counter
from pathlib import Path

from rpcx import *  # noqa

EXPECTED = AA / "tests/localchain/expected-deployed.json"
NAMES = ["deployer", "owner", "buyer", "merchant", "relay", "sponsor", "stranger"]
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


def bring_up(c, variant, workdir):
    c.create(NAMES)
    c.start()
    c.fund(NAMES, 3000)
    bin_dir = AA / "contracts/build"
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


def sc_paymaster(c, x):
    """AA-08 gasless through the on-chain paymaster: relay fronts the fee, the sponsor deposit reimburses it."""
    c.records.append({"scenario": "AA-08 on-chain paymaster sponsored operation"})
    acct, proxy = x.accounts["session-pm"]["id"], x.accounts["session-pm"]["proxy"]
    target, pm, sess_v = c.contracts["MockTransferTarget"], c.contracts["AAPaymaster"], c.contracts["SessionKeyVerifier"]
    sponsor = c.hashes["sponsor"]
    c.send("sponsor deposits 100 GAS into the paymaster", [{"w": "sponsor"}], GAS_HASH, "transfer", [H(sponsor), H(pm), I(100 * GAS), B(b"")])
    c.check(c.read(pm, "getSponsorDeposit", H(sponsor)) == 100 * GAS, "deposit credited")
    c.send("sponsor sets a per-account policy", [{"w": "sponsor"}], pm, "setPolicy", [H(acct), H(target), S("transfer"), I(5 * GAS), I(0), I(0), I(0)])
    ar = [H(proxy), H(c.hashes["buyer"]), I(1000), B(b"")]
    payload = c.read(sess_v, "getPayload", H(acct), H(target), S("transfer"), A(*ar), I(0), I(FAR_DEADLINE))
    op = x.op(target, "transfer", ar, 0, sig=x.sesskey.sign(payload))
    relay_before, dep_before = c.gas("relay"), c.read(pm, "getSponsorDeposit", H(sponsor))
    probe = c.rpc("invokefunction", [x.core, "executeSponsoredUserOp", [H(acct), op, H(pm), H(sponsor), I(5 * GAS)], [c._signer_json({"w": "relay"})]])
    c.records.append({"step": "invokefunction pre-pricing of executeSponsoredUserOp (what a relay does)", "state": probe.get("state"), "exception": (probe.get("exception") or "")[:200]})
    x.sponsored_probe_state = probe.get("state")
    rec = c.send("relay executes the sponsored op with a fixed 2.5 GAS system fee (user holds no GAS)", [{"w": "relay"}], x.core, "executeSponsoredUserOp",
                 [H(acct), op, H(pm), H(sponsor), I(5 * GAS)], probe_fault_ok=True, fixed_sysfee=GAS * 5 // 2, netfee=GAS // 2)
    c.check("SponsoredUserOpExecuted" in rec["events"], "SponsoredUserOpExecuted emitted")
    relay_after, dep_after = c.gas("relay"), c.read(pm, "getSponsorDeposit", H(sponsor))
    c.check(dep_before - dep_after > 0, "sponsor deposit was debited")
    rec["relayNetGasDatoshi"] = relay_after - relay_before
    rec["depositDebitDatoshi"] = dep_before - dep_after
    c.check(c.read(x.core, "getNonce", H(acct), I(0)) == 1, "sponsored op consumed nonce 0")
    return {"relayNet": relay_after - relay_before, "depositDebit": dep_before - dep_after, "prePricingSimulation": x.sponsored_probe_state}


def sc_relay_route(c, x):
    """AA-09 the AA frontend's real relay route against the local chain."""
    c.records.append({"scenario": "AA-09 gasless submission through the AA relay route (frontend/api/relay-transaction.js)"})
    acct, proxy = x.accounts["session-relay"]["id"], x.accounts["session-relay"]["proxy"]
    target, sess_v = c.contracts["MockTransferTarget"], c.contracts["SessionKeyVerifier"]
    nonce = x.nonce(acct)
    ar = [H(proxy), H(c.hashes["buyer"]), I(1000), B(b"")]
    payload = c.read(sess_v, "getPayload", H(acct), H(target), S("transfer"), A(*ar), I(nonce), I(FAR_DEADLINE))
    sig = x.sesskey.sign(payload)
    fixture = {"rpcUrl": f"http://127.0.0.1:{c.port}", "core": x.core, "accountId": acct, "target": target, "method": "transfer",
               "methodArgs": [{"type": "Hash160", "value": proxy}, {"type": "Hash160", "value": c.hashes["buyer"]}, {"type": "Integer", "value": "1000"}, {"type": "ByteArray", "value": "0x"}],
               "nonce": str(nonce), "deadline": str(FAR_DEADLINE), "signatureHex": sig.hex(), "otherHash": c.contracts["MockTransferTarget"],
               "gasFixture": getattr(x, "gas_fixture", None)}
    fx = x.workdir / "relay-fixture.json"
    fx.write_text(json.dumps(fixture))
    env = {k: os.environ[k] for k in ("PATH", "HOME", "TMPDIR", "LANG") if k in os.environ}
    env["RELAY_PRIVATE_KEY_HEX"] = c.keys["relay"].der.read_bytes()[7:39].hex()  # raw scalar of the throwaway dev key
    env["NODE_ENV"] = "development"
    done = subprocess.run([shutil.which("node") or "node", str(Path(__file__).with_name("relay_probe.mjs")), str(fx)], capture_output=True, text=True, env=env, timeout=90)
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
    return {"relay": results}


# ---------------------------------------------------------------- runner
def run(variant, workdir, port, receipt_path, plant_mismatch=False):
    t0 = time.time()
    receipt = {"variant": variant, "observedOn": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "results": [], "status": "RUNNING"}
    c, x = Rx(workdir, port), None
    def save():
        receipt["records"] = c.records if c else []
        receipt_path.write_text(json.dumps(receipt, indent=2, default=str) + "\n")
    def attempt(name, fn, *a):
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
        attempt("arm timelocked configuration", arm_session_and_whitelist, c, x)
        attempt("AA-07b social recovery phase 1", sc_recovery_phase1, c, x)
        c.fastforward(8 * DAY + 3600)
        c.records.append({"step": "chain time advanced 8 days + 1 h offline (neoxp fastfwd) for the 24 h and 7 d timelocks"})
        attempt("AA-05/06/07 session key, hook, escape", sc_session_keys, c, x)
        attempt("AA-07b social recovery phase 2", sc_recovery_phase2, c, x)
        attempt("AA-03b value flow (session key + proxy witness + daily limit)", sc_value_flow, c, x)
        attempt("AA-08 on-chain paymaster", sc_paymaster, c, x)
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


def validate_artifacts(expected):
    for artifact in expected["artifacts"]:
        name = artifact["path"]
        if hashlib.sha256((AA / name).read_bytes()).hexdigest() != artifact["sha256"]:
            raise Fail(f"deployed artifact mismatch: {name}")


def validate_receipt(receipt, expected):
    failures = []
    def check(ok, name):
        if not ok:
            failures.append(name)
    check(receipt["status"] == "DONE", "suite completed")
    check(receipt["variant"] == expected["variant"], "deployed variant")
    results = receipt["results"]
    check([s["name"] for s in results] == [s["name"] for s in expected["scenarios"]], "scenario inventory")
    for actual, wanted in zip(results, expected["scenarios"]):
        check(actual["status"] == "PASS", wanted["name"])
        check(actual["checks"] == [{"check": n, "ok": True} for n in wanted["checks"]],
              f"named checks: {wanted['name']}")
    checks = [r for r in receipt["records"] if "check" in r]
    check(checks == [c for s in results for c in s["checks"]], "recorded checks match scenarios")
    check(len(checks) == expected["totals"]["checks"] and all(c["ok"] is True for c in checks), "54 successful checks")
    counts = Counter(r["outcome"] for r in receipt["records"] if "outcome" in r)
    check(counts == {"HALT": expected["totals"]["executedTransactions"],
                     "FAULT": expected["totals"]["simulatedFaults"],
                     "REJECTED": expected["totals"]["nodeRefusals"]}, "transaction outcomes: 66 executed, 21 simulated faults, 6 refusals")
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
    ap.add_argument("--variant", choices=["deployed"], required=True)
    ap.add_argument("--receipt", type=Path, default=AA / "tests/localchain/out/rpc-deployed.json")
    ap.add_argument("--plant-mismatch", choices=["verifier"], help="negative control: register the native account with a verifier")
    a = ap.parse_args()
    a.receipt.parent.mkdir(parents=True, exist_ok=True)
    # A failed prerequisite must never leave a successful receipt from an earlier invocation.
    a.receipt.unlink(missing_ok=True)
    expected = json.loads(EXPECTED.read_text())
    validate_artifacts(expected)
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f"signal {signum}")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    # This process owns the chain, keys and node PID, including when setup or a scenario fails.
    with tempfile.TemporaryDirectory(prefix="aa-localchain-", dir="/private/tmp" if sys.platform == "darwin" else "/tmp") as workdir:
        port = free_port_pair()
        print(f"Disposable neoxp: 127.0.0.1:{port}, data {workdir}", flush=True)
        receipt = run(a.variant, workdir, port, a.receipt, bool(a.plant_mismatch))
    failures = validate_receipt(receipt, expected)
    receipt["gateFailures"] = failures
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

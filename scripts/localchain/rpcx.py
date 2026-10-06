#!/usr/bin/env python3
"""RPC-driven local-chain harness for the AA assessment.

One long-lived `neoxp run` node (published neoxp, no private hardfork), every transaction built and signed
here and sent over JSON-RPC, so a step costs a block (1 s) instead of two .NET process starts. Reuses the
serialisation helpers of neo-os-aa/scripts/neoexpress_validate.py. Throwaway dev-chain keys only.
"""
import base64, hashlib, json, os, shutil, subprocess, sys, time, urllib.request
from pathlib import Path

AA = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(AA / "scripts"))
import neoexpress_validate as v  # noqa: E402
from neoexpress_validate import H, B, I, S, BOOL, A, ZERO, DAY, GAS, FAR_DEADLINE  # noqa: E402

GAS_HASH = "0xd2a4cff31913016155e38e474a2c06d08be276cf"
NEO_HASH = "0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5"
CM_HASH = "0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"


class Fail(Exception):
    pass


def _serialize_signer(signer):
    out = v.hash_le(signer["account"])
    sc = signer["scopes"]
    if sc == "CalledByEntry":
        return out + b"\x01"
    if sc == "Global":
        return out + b"\x80"
    if sc == "WitnessRules":
        return v.serialize_signer(signer)
    raise Fail(f"unsupported scope {sc}")


def serialize_unsigned(nonce, sysfee, netfee, valid_until, signers, script):
    out = b"\x00" + nonce.to_bytes(4, "little") + sysfee.to_bytes(8, "little") + netfee.to_bytes(8, "little")
    out += valid_until.to_bytes(4, "little") + v.varint(len(signers))
    for s in signers:
        out += _serialize_signer(s)
    out += v.varint(0) + v.varint(len(script)) + script
    return out


class Rx:
    def __init__(self, workdir, port, neoxp=None):
        self.workdir = Path(workdir)
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.port = port
        self.neoxp = neoxp or os.environ.get("NEOXP") or shutil.which("neoxp") or str(Path.home() / ".dotnet" / "tools" / "neoxp")
        self.file = self.workdir / "aa.neo-express"
        self.env = {k: os.environ[k] for k in ("PATH", "DOTNET_ROOT", "LANG", "TMPDIR") if k in os.environ}
        self.env["HOME"] = str(self.workdir)
        self.env.setdefault("DOTNET_ROOT", v.dotnet_root())
        self.node = None
        self.keys = {}
        self.hashes = {}      # wallet name -> 0x display hash
        self.contracts = {}
        self.records = []
        self.magic = None

    # ---- process plumbing
    def nx(self, *args):
        cmd = [self.neoxp, *args]
        done = subprocess.run(cmd, capture_output=True, text=True, env=self.env, timeout=60)
        text = v.ANSI.sub("", done.stdout + done.stderr)
        if done.returncode != 0:
            raise Fail(f"neoxp {' '.join(args[:3])} failed: {text.strip()[:300]}")
        return text

    def create(self, wallet_names):
        self.nx("create", "-o", str(self.file), "-f")
        cfg = json.loads(self.file.read_text())
        node = cfg["consensus-nodes"][0]
        node["rpc-port"], node["tcp-port"] = self.port, self.port + 1
        # neoxp's default dBFT MaxBlockSystemFee is 20 GAS, below the deploy fee of the 38 KB core (local chain setting only)
        cfg.setdefault("settings", {})["dbft.MaxBlockSystemFee"] = str(5000 * GAS)
        self.file.write_text(json.dumps(cfg, indent=2) + "\n")
        self.magic = cfg["magic"]
        accounts = node["wallet"]["accounts"]
        ms = [a for a in accounts if len(a["contract"]["script"]) == 84][0]
        self.genesis_script = bytes.fromhex(ms["contract"]["script"])
        self.genesis_key = v.RawKey(self.workdir, "genesis-raw", bytes.fromhex(ms["private-key"]))
        self.genesis_hash = "0x" + v.hash160(self.genesis_script)[::-1].hex()
        for name in wallet_names:
            k = v.RawKey(self.workdir, name, os.urandom(32))
            self.keys[name] = k
            self.hashes[name] = "0x" + k.script_hash[::-1].hex()

    def start(self):
        with (self.workdir / "node.log").open("w") as log:
            self.node = subprocess.Popen([self.neoxp, "run", "-i", str(self.file), "-s", "1"], stdout=log, stderr=subprocess.STDOUT, env=self.env)
        for _ in range(120):
            time.sleep(1)
            if self.node.poll() is not None:
                raise Fail(f"node exited {self.node.returncode}; see node.log")
            try:
                self.rpc("getversion", [])
                res = self.rpc("invokefunction", [GAS_HASH, "symbol", [], []])
                if res.get("state") == "HALT" and self.rpc("getblockcount", []) >= 1:
                    return
            except Exception:
                continue
        raise Fail("node did not answer RPC")

    def stop(self):
        node = self.node
        if node and node.poll() is None:
            node.terminate()
            try:
                node.wait(timeout=30)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                node.kill()
                node.wait(timeout=10)
        self.node = None

    def fastforward(self, seconds):
        """Stop the node, advance chain time offline (one neoxp command), restart."""
        self.stop()
        self.nx("fastfwd", "1", "-t", str(int(seconds)), "-i", str(self.file))
        self.start()

    def rpc(self, method, params):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}", data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            reply = json.loads(r.read())
        if "result" not in reply:
            e = reply.get("error") or {}
            raise Fail(f"rpc {method}: {e.get('message', e)} {e.get('data', '')}".strip())
        return reply["result"]

    # ---- reads
    def read(self, contract, method, *args, signers=None):
        res = self.rpc("invokefunction", [contract, method, list(args), signers or []])
        if res.get("state") != "HALT":
            raise Fail(f"{method} read faulted: {res.get('exception')}")
        st = res.get("stack") or []
        return v.decode(st[0]) if st and st[0].get("type") != "Any" else None

    def gas(self, who):
        h = self.hashes.get(who) or self.contracts.get(who) or who
        return self.read(GAS_HASH, "balanceOf", H(h))

    def hash_of(self, contract, method, *args):
        raw = self.read(contract, method, *args)
        return "0x" + raw[::-1].hex() if isinstance(raw, bytes) else raw

    def now_ms(self):
        blk = self.rpc("getblock", [self.rpc("getblockcount", []) - 1, 1])
        return int(blk["time"])

    # ---- transactions
    def _signer_json(self, s):
        if "w" in s:
            return {"account": self.hashes[s["w"]], "scopes": s.get("scope", "CalledByEntry")}
        if "genesis" in s:
            return {"account": self.genesis_hash, "scopes": "CalledByEntry"}
        return {"account": s["proxy"], "scopes": "WitnessRules", "rules": v.aa_proxy_rules(s["core"], s["target"])}

    def send(self, step, signers, contract, method, args, expect="HALT", expect_text=None, script_override=None,
             sysfee_margin=3 * GAS, netfee=3 * GAS, reject_ok=False, probe_fault_ok=False, fixed_sysfee=None):
        """Build, sign and broadcast one transaction. `expect`: HALT | FAULT (judged by simulation, nothing
        broadcast) | REJECT (the node must refuse the transaction at mempool verification)."""
        sj = [self._signer_json(s) for s in signers]
        probe = self.rpc("invokefunction", [contract, method, list(args), sj])
        rec = {"step": step, "call": f"{self.name_of(contract)}.{method}", "signers": [s.get("w") or ("genesis" if "genesis" in s else "proxy") for s in signers],
               "simulation": probe.get("state"), "exception": (probe.get("exception") or "")[:240] or None}
        self.records.append(rec)
        if expect == "FAULT":
            if probe.get("state") != "FAULT":
                rec["outcome"] = "UNEXPECTED-" + str(probe.get("state"))
                raise Fail(f"{step}: expected a fault but the simulation {probe.get('state')} (result {probe.get('stack')})")
            if expect_text and expect_text not in (probe.get("exception") or ""):
                rec["outcome"] = "FAULT-OTHER-REASON"
                raise Fail(f"{step}: fault text mismatch: {probe.get('exception')}")
            rec["outcome"] = "FAULT"
            return rec
        if probe.get("state") != "HALT" and expect == "HALT" and not probe_fault_ok:
            rec["outcome"] = "FAULT"
            raise Fail(f"{step}: simulation faulted: {probe.get('exception')}")
        script = script_override if script_override is not None else base64.b64decode(probe["script"])
        gas = int(probe.get("gasconsumed", 0))
        out = self._broadcast(rec, signers, sj, script, fixed_sysfee if fixed_sysfee is not None else gas + sysfee_margin, netfee, expect)
        out.pop("notifications", None)
        return out

    def _broadcast(self, rec, signers, sj, script, sysfee, netfee, expect="HALT"):
        height = self.rpc("getblockcount", [])
        nonce = int.from_bytes(os.urandom(4), "little")
        unsigned = serialize_unsigned(nonce, sysfee, netfee, height + 100, sj, script)
        digest = hashlib.sha256(unsigned).digest()
        witnesses = []
        for s in signers:
            if "w" in s:
                k = self.keys[s["w"]]
                witnesses.append((b"\x0c\x40" + k.sign(int(self.magic).to_bytes(4, "little") + digest), k.verification))
            elif "genesis" in s:
                witnesses.append((b"\x0c\x40" + self.genesis_key.sign(int(self.magic).to_bytes(4, "little") + digest), self.genesis_script))
            else:
                witnesses.append((b"", s["script"]))
        raw = base64.b64encode(unsigned + v.serialize_witnesses(witnesses)).decode()
        sent, attempts = None, []
        for _ in range(3):
            try:
                sent = self.rpc("sendrawtransaction", [raw]); attempts.append("accepted"); break
            except Fail as e:
                attempts.append(str(e)[:150]); time.sleep(1)
        rec["sendAttempts"] = attempts
        if sent is None:
            rec["outcome"] = "REJECTED"
            if expect == "REJECT":
                return rec
            raise Fail(f"{rec['step']}: node rejected the transaction: {attempts[-1]}")
        if expect == "REJECT":
            rec["outcome"] = "ACCEPTED"
            raise Fail(f"{rec['step']}: expected the node to refuse the transaction but it was accepted")
        txid = sent["hash"]
        execution = None
        for _ in range(90):
            time.sleep(1)
            try:
                execution = self.rpc("getapplicationlog", [txid])["executions"][0]; break
            except Fail:
                continue
        if execution is None:
            raise Fail(f"{rec['step']}: {txid} was not executed")
        rec.update({"txid": txid, "outcome": execution["vmstate"], "gas": int(execution["gasconsumed"]),
                    "events": [n["eventname"] for n in execution.get("notifications", [])], "notifications": execution.get("notifications", [])})
        st = execution.get("stack") or []
        rec["result"] = v.decode(st[0]) if st and st[0].get("type") not in ("Any",) else None
        if isinstance(rec["result"], bytes):
            rec["result"] = rec["result"].hex()
        if execution.get("exception"):
            rec["exception"] = execution["exception"][:240]
        if execution["vmstate"] != "HALT":
            raise Fail(f"{rec['step']}: on-chain fault: {execution.get('exception')}")
        return rec

    def name_of(self, contract):
        for n, h in self.contracts.items():
            if h == contract:
                return n
        return {GAS_HASH: "GAS", NEO_HASH: "NEO", CM_HASH: "ContractManagement"}.get(contract, contract[:10])

    # ---- funding and deployment
    def fund(self, names, amount_gas):
        for n in names:
            self.send(f"fund {n} with {amount_gas} GAS from the genesis account", [{"genesis": True}], GAS_HASH, "transfer",
                      [H(self.genesis_hash), H(self.hashes[n]), I(amount_gas * GAS), B(b"")])

    @staticmethod
    def _push(item):
        if item is None:
            return b"\x0b"
        if len(item) <= 255:
            return b"\x0c" + bytes([len(item)]) + item
        if len(item) <= 65535:
            return b"\x0d" + len(item).to_bytes(2, "little") + item
        return b"\x0e" + len(item).to_bytes(4, "little") + item

    def deploy(self, name, nef_path, data_core=None, signer="deployer"):
        nef = Path(nef_path)
        nef_bytes = nef.read_bytes()
        manifest = nef.with_name(nef.name.replace(".nef", ".manifest.json")).read_bytes()
        data = bytes.fromhex(data_core[2:])[::-1] if data_core else None
        # args [nef, manifest, data] pushed in reverse, PUSH3 PACK, PUSH15 (CallFlags.All), method, hash, SYSCALL System.Contract.Call
        script = (self._push(data) + self._push(manifest) + self._push(nef_bytes) + b"\x13\xc0\x1f"
                  + self._push(b"deploy") + self._push(bytes.fromhex(CM_HASH[2:])[::-1]) + bytes.fromhex("41627d5b52"))
        fee = max(100000 * (len(nef_bytes) + len(manifest)), 10 * GAS)
        sj = [self._signer_json({"w": signer})]
        rec = {"step": f"deploy {name}", "call": "ContractManagement.deploy", "signers": [signer], "simulation": "skipped (deploy fee exceeds the RPC invoke gas cap)"}
        self.records.append(rec)
        self._broadcast(rec, [{"w": signer}], sj, script, fee + 3 * GAS, 3 * GAS)
        deployed = [n for n in rec["notifications"] if n.get("eventname") == "Deploy"]
        h = "0x" + base64.b64decode(deployed[0]["state"]["value"][0]["value"])[::-1].hex()
        self.contracts[name] = h
        rec.pop("notifications", None)
        return h

    def check(self, cond, text):
        self.records.append({"check": text, "ok": bool(cond)})
        if not cond:
            raise Fail(f"assertion failed: {text}")

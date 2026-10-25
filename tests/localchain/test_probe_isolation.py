"""Isolation regressions for the standalone local-chain JavaScript entry points."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]
LOCALCHAIN = ROOT / "scripts/localchain"
sys.path.insert(0, str(LOCALCHAIN))
import aa_rpc_scenarios as suite  # noqa: E402

NODE = shutil.which("node") or "node"
LOOPBACK_ERROR = "Disposable loopback RPC required"
PRODUCTION_ERROR = "Localchain probe refused production context"


class RecordingHandler(BaseHTTPRequestHandler):
    def log_message(self, _format, *args):
        pass

    def reply(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def maybe_redirect(self, rpc_method=None):
        methods = self.server.redirect_methods
        if not self.server.redirect_status or (methods is not None and rpc_method not in methods):
            return False
        self.send_response(self.server.redirect_status)
        self.send_header("location", self.server.redirect_url)
        self.send_header("content-length", "0")
        self.end_headers()
        return True

    def do_GET(self):
        self.server.requests.append((self.command, self.path))
        self.server.request_bodies.append(b"")
        if not self.maybe_redirect():
            self.reply(None)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        self.server.requests.append((self.command, self.path))
        self.server.request_bodies.append(raw)
        request = json.loads(raw) if self.server.is_rpc else None
        method = request.get("method") if request else None
        if method:
            self.server.rpc_methods.append(method)
            self.server.rpc_bodies.append((method, raw))
        if self.maybe_redirect(method):
            return
        if not self.server.is_rpc:
            self.reply([{"result": "OK"}])
            return
        profile = self.server.rpc_profile
        if method == "invokescript":
            if profile == "halt":
                body = {"result": {"state": "HALT", "gasconsumed": "1000000", "exception": None, "stack": []}}
            else:
                body = {"result": {"state": "FAULT", "gasconsumed": "1000",
                                   "exception": "local regression refusal", "stack": []}}
        elif method == "invokefunction" and profile == "source":
            body = {"result": {"state": "HALT", "gasconsumed": "1", "stack": [{"type": "Integer", "value": "0"}]}}
        elif method == "invokefunction" and profile == "wallet":
            body = {"result": {"state": "HALT", "gasconsumed": "1", "stack": [{"type": "Hash160", "value": "0x" + "0" * 40}]}}
        elif method == "getversion":
            body = {"result": {"protocol": {"network": 12345, "addressversion": 53}}}
        elif method == "getblockcount" and profile == "halt":
            body = {"result": 1234}
        elif method == "calculatenetworkfee" and profile == "halt":
            body = {"result": {"networkfee": "1000000"}}
        elif method == "sendrawtransaction" and profile == "halt":
            body = {"result": {"hash": "0x" + "ab" * 32}}
        else:
            body = {"error": {"code": -32601, "message": "not implemented by the local regression node"}}
        self.reply({"jsonrpc": "2.0", "id": request.get("id"), **body})


class ProbeIsolationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aa-probe-isolation-")
        self.addCleanup(self.temp.cleanup)
        self.workdir = Path(self.temp.name)

    def env(self, **overrides):
        env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG") if key in os.environ}
        env["NODE_ENV"] = "test"
        env.update(overrides)
        return env

    def run_entry(self, script, request, env):
        path = self.workdir / f"{script}.json"
        path.write_text(json.dumps(request))
        return subprocess.run([NODE, str(LOCALCHAIN / script), str(path)], cwd=ROOT, env=env,
                              capture_output=True, text=True, timeout=90)

    def start_server(self, is_rpc=False, profile="fault", redirect_status=None, redirect_methods=None, redirect_url=None):
        for _ in range(20):
            server = ThreadingHTTPServer(("127.0.0.1", 0), RecordingHandler)
            if server.server_port > 20000:
                break
            server.server_close()
        else:
            self.fail("could not allocate a disposable loopback port above 20000")
        server.is_rpc = is_rpc
        server.rpc_profile = profile
        server.redirect_status = redirect_status
        server.redirect_methods = set(redirect_methods) if redirect_methods is not None else None
        server.redirect_url = redirect_url
        server.requests = []
        server.request_bodies = []
        server.rpc_methods = []
        server.rpc_bodies = []
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            server.server_close()
            thread.join(timeout=10)
        self.addCleanup(stop)
        return server, f"http://127.0.0.1:{server.server_port}"

    def relay_fixture(self, rpc_url):
        core, account, target = "1" * 40, "2" * 40, "3" * 40
        proxy, buyer, other = "4" * 40, "5" * 40, "6" * 40
        paymaster, sponsor = "7" * 40, "8" * 40
        args = [{"type": "Hash160", "value": proxy}, {"type": "Hash160", "value": buyer},
                {"type": "Integer", "value": "1000"}, {"type": "ByteArray", "value": "0x"}]
        signature = "ab" * 64
        sponsored = {"accountId": account, "target": target, "method": "transfer", "methodArgs": args,
                     "nonce": "2", "deadline": "9999999999999", "signatureHex": signature,
                     "paymaster": paymaster, "sponsor": sponsor, "reimbursementAmount": "1"}
        return {"rpcUrl": rpc_url, "core": core, "accountId": account, "target": target, "method": "transfer",
                "methodArgs": args, "nonce": "0", "deadline": "9999999999999", "signatureHex": signature,
                "otherHash": other, "nonceNext": "1", "signatureHexNext": signature,
                "gasFixture": None, "sponsored": sponsored}

    def neo_script_hash(self, private_key):
        script = """
const { createRequire } = require('node:module');
const sdkRequire = createRequire(process.cwd() + '/frontend/package.json');
const { wallet } = sdkRequire('@cityofzion/neon-js');
process.stdout.write(new wallet.Account(process.env.LOCALCHAIN_TEST_PRIVATE_KEY).scriptHash);
"""
        done = subprocess.run([NODE, "-e", script], cwd=ROOT, env=self.env(LOCALCHAIN_TEST_PRIVATE_KEY=private_key),
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, "could not derive the disposable account script hash")
        return "0x" + done.stdout.strip()

    def source_fixture(self, rpc_url, private_key):
        base = self.relay_fixture(rpc_url)
        operation = {"type": "Struct", "value": [
            {"type": "Hash160", "value": base["target"]}, {"type": "String", "value": "transfer"},
            {"type": "Array", "value": base["methodArgs"]}, {"type": "Integer", "value": "0"},
            {"type": "Integer", "value": base["deadline"]},
            {"type": "ByteArray", "value": "0x" + base["signatureHex"]},
        ]}
        direct = {"scriptHash": base["core"], "operation": "executeUserOp",
                  "args": [{"type": "Hash160", "value": base["accountId"]}, operation]}
        invalid = json.loads(json.dumps(direct))
        invalid["args"][1]["value"][-1]["value"] = "0x" + "00" * 64
        sponsored = {"scriptHash": base["core"], "operation": "executeSponsoredUserOp", "args": [
            *direct["args"], {"type": "Hash160", "value": base["sponsored"]["paymaster"]},
            {"type": "Hash160", "value": base["sponsored"]["sponsor"]}, {"type": "Integer", "value": "1"},
        ]}
        return {"rpcUrl": rpc_url, "core": base["core"], "accountId": base["accountId"],
                "proxy": base["methodArgs"][0]["value"], "buyer": base["methodArgs"][1]["value"],
                "owner": base["otherHash"], "relay": self.neo_script_hash(private_key), "gas": base["target"],
                "paymaster": base["sponsored"]["paymaster"], "sponsor": base["sponsored"]["sponsor"], "amount": "1",
                "invocations": {"invalidSignature": invalid, "direct": direct, "sponsored": sponsored}}

    def wallet_request(self, rpc_url, private_key):
        base = self.relay_fixture(rpc_url)
        der = self.workdir / "wallet-shim-test.der"
        der.write_bytes(suite.v.sec1_der(bytes.fromhex(private_key)))
        return {"rpcUrl": rpc_url, "magic": 12345, "core": base["core"], "accountId": base["accountId"],
                "target": base["target"], "method": "transfer", "args": base["methodArgs"], "nonce": "0",
                "deadline": base["deadline"], "signatureHex": base["signatureHex"],
                "feePayer": self.neo_script_hash(private_key), "feePayerKeyDer": str(der),
                "feePayerAddress": "NWalletShimPayerAddress"}

    def redirect_pair(self, status, is_rpc=True, profile="fault", methods=None):
        target, target_url = self.start_server()
        source, source_url = self.start_server(is_rpc=is_rpc, profile=profile, redirect_status=status,
                                               redirect_methods=methods, redirect_url=target_url)
        return source, source_url, target

    def assert_no_requests(self, server, message):
        self.assertTrue(not server.requests and not server.request_bodies, message)

    def test_non_loopback_urls_fail_before_secret_reads(self):
        rejected = [
            "http://203.0.113.1:20000",
            "http://example.invalid:20000",
            "http://localhost:20000",
            "http://127.0.0.2:20000",
            "https://127.0.0.1:20000",
            "http://127.0.0.1",
            "http://[::1]",
            "http://127.0.0.1:19999",
            "http://127.1:20000",
            "http://2130706433:20000",
            "http://0x7f000001:20000",
            "http://[0:0:0:0:0:0:0:1]:20000",
            "http://user:pass@127.0.0.1:20000",
            "http://127.0.0.1:20000\\@example.invalid",
            "http://127.0.0.1:20000\\path",
            "http://127.0.0.1:020000",
            "http://127.0.0.1:80",
            "http://[::1]:80",
        ]
        for script in ("relay_probe.mjs", "source_proxy_relay_probe.mjs", "wallet_shim_sign_proxy_transfer.mjs"):
            for url in rejected:
                with self.subTest(script=script, url=url):
                    env = self.env(RELAY_PRIVATE_KEY_HEX="not-a-private-key")
                    done = self.run_entry(script, {"rpcUrl": url, "feePayerKeyDer": str(self.workdir / "absent.der")}, env)
                    output = done.stdout + done.stderr
                    self.assertNotEqual(done.returncode, 0, "unsafe RPC URL was accepted")
                    self.assertTrue(LOOPBACK_ERROR in output, "URL guard did not run before key/DER loading")

    def test_production_context_fails_before_secret_reads(self):
        for script in ("relay_probe.mjs", "source_proxy_relay_probe.mjs", "wallet_shim_sign_proxy_transfer.mjs"):
            for name in ("NODE_ENV", "VERCEL_ENV"):
                with self.subTest(script=script, variable=name):
                    env = self.env(RELAY_PRIVATE_KEY_HEX="not-a-private-key", **{name: " Production "})
                    request = {"rpcUrl": "http://127.0.0.1:20000", "feePayerKeyDer": str(self.workdir / "absent.der")}
                    done = self.run_entry(script, request, env)
                    output = done.stdout + done.stderr
                    self.assertNotEqual(done.returncode, 0, "production context was accepted")
                    self.assertTrue(PRODUCTION_ERROR in output, "production guard did not run before key/DER loading")

    def test_missing_or_malformed_relay_key_fails_before_any_post(self):
        cases = [("missing", None), ("empty", ""), ("short", "0" * 63), ("long", "0" * 65),
                 ("prefixed", "0x" + "0" * 64), ("non-hex", "g" * 64), ("whitespace", " " + "0" * 64)]
        for script in ("relay_probe.mjs", "source_proxy_relay_probe.mjs"):
            fixture_key = secrets.token_hex(32)
            for label, private_key in cases:
                with self.subTest(script=script, key=label):
                    rpc, rpc_url = self.start_server(is_rpc=True)
                    fixture = self.relay_fixture(rpc_url) if script == "relay_probe.mjs" \
                        else self.source_fixture(rpc_url, fixture_key)
                    env = self.env()
                    if private_key is not None:
                        env["RELAY_PRIVATE_KEY_HEX"] = private_key
                    done = self.run_entry(script, fixture, env)
                    output = done.stdout + done.stderr
                    self.assertNotEqual(done.returncode, 0, "missing or malformed relay key was accepted")
                    self.assertTrue("RELAY_PRIVATE_KEY_HEX must be exactly 64 hexadecimal characters" in output,
                                    "strict key validation did not run before SDK/account initialization")
                    self.assert_no_requests(rpc, "missing or malformed relay key reached the RPC POST trap")

    def test_literal_loopback_urls_pass_the_guard(self):
        for url in ("http://127.0.0.1:20000", "http://[::1]:20000/path"):
            for script in ("relay_probe.mjs", "source_proxy_relay_probe.mjs", "wallet_shim_sign_proxy_transfer.mjs"):
                with self.subTest(script=script, url=url):
                    env = self.env(RELAY_PRIVATE_KEY_HEX="not-a-private-key")
                    done = self.run_entry(script, {"rpcUrl": url, "feePayerKeyDer": str(self.workdir / "absent.der")}, env)
                    output = done.stdout + done.stderr
                    self.assertNotEqual(done.returncode, 0, "the secret-read negative control unexpectedly succeeded")
                    self.assertFalse(LOOPBACK_ERROR in output or PRODUCTION_ERROR in output,
                                     "a literal loopback URL did not pass the guard")

    def test_relay_clears_inherited_external_configuration(self):
        rpc, rpc_url = self.start_server(is_rpc=True)
        trap, trap_url = self.start_server()
        private_key = secrets.token_hex(32)
        env = self.env(
            RELAY_PRIVATE_KEY_HEX=private_key,
            UPSTASH_REDIS_REST_URL=trap_url,
            UPSTASH_REDIS_REST_TOKEN="local-upstash-token",
            AA_RELAY_MAINNET_RPC_URL=trap_url,
            MORPHEUS_PAYMASTER_ENDPOINT=trap_url,
            MORPHEUS_PAYMASTER_API_TOKEN="local-paymaster-token",
            VITE_AA_RELAY_RPC_URL=trap_url,
            VITE_NEO_RPC_URL=trap_url,
        )
        done = self.run_entry("relay_probe.mjs", self.relay_fixture(rpc_url), env)
        stderr = suite._redact_relay_stderr(done.stderr, private_key)
        self.assertEqual(done.returncode, 0, stderr[-500:])
        results = json.loads(done.stdout.strip().splitlines()[-1])
        expected_cases = [str(number) for number in (*range(1, 8), *range(10, 17))]
        self.assertEqual([row["case"].split()[0] for row in results], expected_cases,
                         "the real relay route did not run all probe cases")
        self.assertTrue("invokescript" in rpc.rpc_methods, "the relay route never reached the loopback RPC node")
        self.assertFalse("sendrawtransaction" in rpc.rpc_methods, "the refusing RPC stub unexpectedly broadcast")
        self.assertFalse(trap.requests, "inherited AA/MORPHEUS/UPSTASH/VITE configuration was used externally")

    def test_source_clears_inherited_external_configuration(self):
        rpc, rpc_url = self.start_server(is_rpc=True, profile="source")
        trap, trap_url = self.start_server()
        private_key = secrets.token_hex(32)
        env = self.env(
            RELAY_PRIVATE_KEY_HEX=private_key,
            UPSTASH_REDIS_REST_URL=trap_url,
            UPSTASH_REDIS_REST_TOKEN="local-upstash-token",
            AA_RELAY_MAINNET_RPC_URL=trap_url,
            MORPHEUS_PAYMASTER_ENDPOINT=trap_url,
            MORPHEUS_PAYMASTER_API_TOKEN="local-paymaster-token",
            VITE_AA_RELAY_RPC_URL=trap_url,
            VITE_NEO_RPC_URL=trap_url,
        )
        done = self.run_entry("source_proxy_relay_probe.mjs", self.source_fixture(rpc_url, private_key), env)
        stderr = suite._redact_relay_stderr(done.stderr, private_key)
        self.assertEqual(done.returncode, 0, stderr[-500:])
        proof = json.loads(done.stdout)
        self.assertEqual([row["name"] for row in proof["cases"]], ["invalidSignature", "direct", "sponsored"])
        self.assertTrue("invokefunction" in rpc.rpc_methods, "the source probe never reached its loopback RPC")
        self.assert_no_requests(trap, "source probe used inherited external configuration")

    def test_wallet_does_not_use_inherited_external_configuration(self):
        rpc, rpc_url = self.start_server(is_rpc=True, profile="wallet")
        trap, trap_url = self.start_server()
        private_key = secrets.token_hex(32)
        env = self.env(
            UPSTASH_REDIS_REST_URL=trap_url,
            UPSTASH_REDIS_REST_TOKEN="local-upstash-token",
            AA_RELAY_MAINNET_RPC_URL=trap_url,
            MORPHEUS_PAYMASTER_ENDPOINT=trap_url,
            MORPHEUS_PAYMASTER_API_TOKEN="local-paymaster-token",
            VITE_AA_RELAY_RPC_URL=trap_url,
            VITE_NEO_RPC_URL=trap_url,
        )
        done = self.run_entry("wallet_shim_sign_proxy_transfer.mjs", self.wallet_request(rpc_url, private_key), env)
        self.assertEqual(done.returncode, 0, "the wallet shim did not reach its local refusal leg")
        result = json.loads(done.stdout.strip().splitlines()[-1])
        self.assertEqual(result.get("leg"), "refused-build")
        self.assertTrue("invokefunction" in rpc.rpc_methods, "the wallet shim never reached its loopback RPC")
        self.assert_no_requests(trap, "wallet shim used inherited external configuration")

    def test_shared_fetch_and_sdk_rpc_reject_307_308(self):
        script = """
import { createRequire } from 'node:module';
import { fetchWithTimeout } from './frontend/src/utils/fetchWithTimeout.js';
import { apiFetch } from './frontend/api/outboundFetch.js';
import { createNoRedirectRpcClient } from './frontend/api/rpcTransport.js';
const mode = process.env.REDIRECT_TEST_MODE;
const url = process.env.REDIRECT_TEST_URL;
try {
  if (mode === 'shared') {
    await fetchWithTimeout(url, { method: 'POST', body: 'shared-payload' });
  } else if (mode === 'api') {
    await apiFetch(url, { method: 'POST', redirect: 'follow', body: 'api-payload' });
  } else {
    const sdkRequire = createRequire(process.cwd() + '/frontend/package.json');
    const { rpc } = sdkRequire('@cityofzion/neon-js');
    const client = createNoRedirectRpcClient({ rpc, rpcUrl: url });
    await client.sendRawTransaction('3q2+7w==');
  }
} catch {
  process.exit(23);
}
process.exit(0);
"""
        for status in (307, 308):
            for mode in ("shared", "api", "sdk"):
                with self.subTest(status=status, transport=mode):
                    source, source_url, target = self.redirect_pair(status, is_rpc=False)
                    done = subprocess.run([NODE, "--input-type=module", "-e", script], cwd=ROOT,
                                          env=self.env(REDIRECT_TEST_MODE=mode, REDIRECT_TEST_URL=source_url),
                                          capture_output=True, text=True, timeout=30)
                    self.assertEqual(done.returncode, 23, "redirect was not refused by the transport")
                    self.assertEqual(len(source.requests), 1, "the first loopback station was not called")
                    self.assertEqual(len(source.request_bodies), 1, "the first loopback station did not receive the POST body")
                    if mode == "sdk":
                        payload = json.loads(source.request_bodies[0])
                        self.assertTrue(payload.get("method") == "sendrawtransaction" and payload.get("params", [""])[0],
                                        "the SDK redirect case did not carry its signed transaction payload")
                    self.assert_no_requests(target, f"{mode} redirect target received a request or body for HTTP {status}")

    def test_localchain_direct_rpc_rejects_307_308(self):
        for status in (307, 308):
            for script in ("source_proxy_relay_probe.mjs", "wallet_shim_sign_proxy_transfer.mjs",
                           "sdk_proxy_builder_fixture.mjs"):
                with self.subTest(status=status, script=script):
                    private_key = secrets.token_hex(32)
                    profile = "wallet" if script.startswith("wallet_") else "source"
                    source, source_url, target = self.redirect_pair(status, is_rpc=True, profile=profile)
                    env = self.env(RELAY_PRIVATE_KEY_HEX=private_key)
                    if script.startswith("source_"):
                        request = self.source_fixture(source_url, private_key)
                    elif script.startswith("wallet_"):
                        request = self.wallet_request(source_url, private_key)
                    else:
                        base = self.relay_fixture(source_url)
                        request = {"rpcUrl": source_url, "core": base["core"], "accountId": base["accountId"],
                                   "target": base["target"], "method": "transfer", "args": base["methodArgs"],
                                   "nonce": "0", "deadline": base["deadline"], "signatureHex": base["signatureHex"],
                                   "feePayer": "0x" + "9" * 40}
                    done = self.run_entry(script, request, env)
                    if script.startswith("wallet_"):
                        self.assertEqual(done.returncode, 0, "wallet direct RPC refusal did not reach its refusal leg")
                    else:
                        self.assertNotEqual(done.returncode, 0, "direct RPC redirect unexpectedly succeeded")
                    self.assertTrue(source.requests and source.request_bodies, "the direct RPC first station was not called")
                    self.assert_no_requests(target, f"{script} direct RPC redirected a request or body for HTTP {status}")

    def test_relay_signed_post_rejects_307_308(self):
        for status in (307, 308):
            with self.subTest(status=status):
                private_key = secrets.token_hex(32)
                rpc, rpc_url, target = self.redirect_pair(status, is_rpc=True, profile="halt",
                                                          methods={"sendrawtransaction"})
                done = self.run_entry("relay_probe.mjs", self.relay_fixture(rpc_url),
                                      self.env(RELAY_PRIVATE_KEY_HEX=private_key))
                stderr = suite._redact_relay_stderr(done.stderr, private_key)
                self.assertEqual(done.returncode, 0, stderr[-500:])
                results = json.loads(done.stdout.strip().splitlines()[-1])
                by = {row["case"].split()[0]: row for row in results}
                self.assertFalse(by["7"].get("txid"), "a redirected signed broadcast returned a transaction id")
                signed = [json.loads(raw) for method, raw in rpc.rpc_bodies if method == "sendrawtransaction"]
                self.assertTrue(signed, "the relay never reached its signed POST negative control")
                self.assertTrue(all(isinstance(payload.get("params", [None])[0], str) and payload["params"][0]
                                    for payload in signed), "the relay signed POST body was empty")
                self.assert_no_requests(target, f"relay signed POST reached the redirect target for HTTP {status}")

    def test_stderr_redaction_uses_raw_key_and_sdk_wif_only(self):
        private_key = secrets.token_hex(32)
        wif = suite._neo_wif(private_key)
        script = """
const { createRequire } = require('node:module');
const sdkRequire = createRequire(process.cwd() + '/sdk/js/package.json');
const { wallet } = sdkRequire('@cityofzion/neon-js');
const account = new wallet.Account(process.env.LOCALCHAIN_TEST_PRIVATE_KEY);
process.exit(account.WIF === process.env.LOCALCHAIN_TEST_WIF ? 0 : 1);
"""
        checked = subprocess.run([NODE, "-e", script], cwd=ROOT,
                                 env=self.env(LOCALCHAIN_TEST_PRIVATE_KEY=private_key, LOCALCHAIN_TEST_WIF=wif),
                                 capture_output=True, text=True, timeout=30)
        self.assertEqual(checked.returncode, 0, "Python WIF derivation disagrees with the Neo SDK")
        txid = hashlib.sha256(b"transaction-id-not-key-material").hexdigest()
        redacted = suite._redact_relay_stderr(
            f"private={private_key}\nwif={wif}\ntxid=0x{txid}\n", private_key)
        secrets_removed = private_key.lower() not in redacted.lower() and wif not in redacted
        self.assertTrue(secrets_removed, "raw private key or derived WIF survived stderr redaction")
        self.assertTrue(txid in redacted, "an unrelated 64-hex transaction id was incorrectly redacted")
        self.assertEqual(redacted.count("[redacted-relay-key]"), 2, "stderr redaction did not hit exactly the two secrets")


if __name__ == "__main__":
    unittest.main()

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

    def do_GET(self):
        self.server.requests.append((self.command, self.path))
        self.reply(None)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        self.server.requests.append((self.command, self.path))
        if not self.server.is_rpc:
            self.reply([{"result": "OK"}])
            return
        request = json.loads(raw)
        method = request.get("method")
        self.server.rpc_methods.append(method)
        if method == "invokescript":
            body = {"result": {"state": "FAULT", "gasconsumed": "1000",
                               "exception": "local regression refusal", "stack": []}}
        elif method == "getversion":
            body = {"result": {"protocol": {"network": 12345, "addressversion": 53}}}
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

    def start_server(self, is_rpc=False):
        for _ in range(20):
            server = ThreadingHTTPServer(("127.0.0.1", 0), RecordingHandler)
            if server.server_port > 20000:
                break
            server.server_close()
        else:
            self.fail("could not allocate a disposable loopback port above 20000")
        server.is_rpc = is_rpc
        server.requests = []
        server.rpc_methods = []
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

#!/usr/bin/env python3
"""Execute a verifier-signed operation from the public source build on published neoxp."""
import signal
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/localchain"))
from aa_rpc_scenarios import Ctx, free_port_pair, sc_key_verifier  # noqa: E402
from rpcx import Rx  # noqa: E402


class PublicProfileTest(unittest.TestCase):
    def test_verifier_signed_public_source_operation(self):
        def interrupted(signum, frame):
            raise KeyboardInterrupt(f"signal {signum}")

        previous = signal.signal(signal.SIGTERM, interrupted)
        try:
            with tempfile.TemporaryDirectory(prefix="aa-public-", dir="/private/tmp" if sys.platform == "darwin" else "/tmp") as workdir:
                chain = Rx(workdir, free_port_pair())
                print(f"Disposable neoxp: 127.0.0.1:{chain.port}, data {workdir}", flush=True)
                try:
                    chain.create(["deployer", "owner", "buyer", "relay"])
                    chain.start()
                    chain.fund(["deployer", "owner", "buyer", "relay"], 3000)
                    artifacts = ROOT / "contracts/bin/v3"
                    core = chain.deploy("UnifiedSmartWalletV3", artifacts / "UnifiedSmartWalletV3.nef")
                    chain.deploy("MockTransferTarget", artifacts / "MockTransferTarget.nef")
                    chain.deploy("WebAuthnVerifier", artifacts / "verifiers/WebAuthnVerifier.nef", data_core=core)
                    context = Ctx(chain, "public", workdir)
                    context.core = core
                    sc_key_verifier(chain, context)
                    checks = [record for record in chain.records if "check" in record]
                    self.assertEqual(len(checks), 2)
                    self.assertTrue(all(record["ok"] for record in checks))
                    print("PASS: public verifier-signed executeUserOp; nonce advances; tampered and unsigned operations fault.", flush=True)
                finally:
                    chain.stop()
        finally:
            signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    unittest.main()

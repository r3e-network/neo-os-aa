"""Offline fail-closed checks for the shared NeoExpress runtime helpers."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
SPEC = importlib.util.spec_from_file_location(
    "activation", Path(__file__).with_name("neoexpress_activation_validate.py"))
activation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(activation)


def probe_bytes():
    """Assemble a minimal NEF the way every validator's own probe builder does."""
    script = b"\x0c\x06verify\x40"  # PUSHDATA1 "verify", RET
    body = (b"NEF3" + b"readback probe".ljust(64, b"\x00") + bytes(5) + bytes([len(script)]) + script)
    return script, body + hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]


class ReadbackTests(unittest.TestCase):
    def state(self):
        script, nef = probe_bytes()
        manifest = {"name": "Probe", "abi": {"methods": [], "events": []}, "permissions": []}
        # The node answers with its own copy; the checker must compare values, never object identity.
        state = {"nef": {"script": base64.b64encode(script).decode(),
                         "checksum": int.from_bytes(nef[-4:], "little")}, "manifest": copy.deepcopy(manifest)}
        return state, script, nef, manifest

    def test_readback_accepts_the_deployed_bytes(self):
        state, script, nef, manifest = self.state()
        self.assertIsNone(activation.check_readback(state, script, nef, manifest))

    def test_readback_refuses_every_drift(self):
        state, script, nef, manifest = self.state()
        changes = {
            "script": lambda: state["nef"].update(script=base64.b64encode(script[:-1]).decode()),
            "checksum": lambda: state["nef"].update(checksum=state["nef"]["checksum"] + 1),
            "boolean checksum": lambda: state["nef"].update(checksum=True),
            "manifest": lambda: state["manifest"].update(permissions=["*"]),
        }
        for label, change in changes.items():
            state, script, nef, manifest = self.state()
            change()
            with self.subTest(change=label), self.assertRaises(activation.ValidationFailure):
                activation.check_readback(state, script, nef, manifest)

    def test_require_raises_the_shared_validation_failure(self):
        with self.assertRaisesRegex(activation.ValidationFailure, "refused"):
            activation.require(False, "refused")
        self.assertIsNone(activation.require(True, "refused"))


class RuntimeTests(unittest.TestCase):
    def test_all_required_runtime_files_are_pinned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in activation.RUNTIME_FILES:
                (root / name).write_bytes(name.encode())
            before = activation.runtime_hashes(root)
            self.assertEqual(set(before), set(activation.RUNTIME_FILES))
            (root / "Neo.dll").write_bytes(b"changed")
            self.assertNotEqual(before, activation.runtime_hashes(root))
            (root / "Neo.dll").unlink()
            with self.assertRaises(activation.ValidationFailure):
                activation.runtime_hashes(root)

    def test_the_shared_setting_is_the_hardfork_a_private_chain_activates(self):
        self.assertEqual("protocol.Hardforks.HF_SmartAccountV1", activation.ACTIVATION_KEY)

    @unittest.skipIf(os.name == "nt", "the neoxp launcher is a #!/usr/bin/env python3 script, which Windows neither finds nor executes")
    def test_runner_executes_exact_program_and_preserves_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime with ' quotes"
            runtime.mkdir()
            (runtime / "neoxp.dll").write_text("import json,sys; print(json.dumps(sys.argv))")
            wrapper = activation.make_runner(runtime, Path(sys.executable), root)
            completed = subprocess.run([wrapper, "argument with spaces"], check=True, text=True, capture_output=True)
            self.assertEqual(json.loads(completed.stdout), [str(runtime / "neoxp.dll"), "argument with spaces"])


if __name__ == "__main__":
    unittest.main()

"""Offline fail-closed checks for the private activation regression harness."""
import base64
import copy
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent))
SPEC = importlib.util.spec_from_file_location(
    "activation", Path(__file__).with_name("neoexpress_activation_validate.py"))
activation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(activation)


class ProbeTests(unittest.TestCase):
    def test_push_rejects_out_of_range_inputs_and_encodes_signed_widths(self):
        for value in (-1, 2**255, b"x" * 256, "string"):
            with self.subTest(value=type(value).__name__), self.assertRaises(activation.ValidationFailure):
                activation.push(value)
        for number, opcode, size in ((127, 0, 1), (128, 1, 2), (32768, 2, 4),
                                     (2**31, 3, 8), (2**63, 4, 16), (2**127, 5, 32)):
            encoded = activation.push(number)
            self.assertEqual(encoded[0], opcode)
            self.assertEqual(len(encoded), size + 1)
            self.assertEqual(int.from_bytes(encoded[1:], "little", signed=True), number)

    def test_probe_has_valid_nef_checksum_and_boolean_return(self):
        script, nef, manifest = activation.probe()
        self.assertEqual(nef[:4], b"NEF3")
        self.assertEqual(nef[-4:], hashlib.sha256(hashlib.sha256(nef[:-4]).digest()).digest()[:4])
        self.assertEqual(script[-3:], b"\x45\x08\x40")
        self.assertIn(hashlib.sha256(b"System.Contract.CallWithGasLimit").digest()[:4], script)
        self.assertEqual(manifest["abi"]["methods"][0]["returntype"], "Boolean")

    def test_readback_checks_script_checksum_and_manifest(self):
        script, nef, manifest = activation.probe()
        state = {"nef": {"script": base64.b64encode(script).decode(),
                         "checksum": int.from_bytes(nef[-4:], "little")}, "manifest": manifest}
        activation.check_readback(state, script, nef, manifest)
        for field in ("script", "checksum", "manifest"):
            bad = copy.deepcopy(state)
            if field == "script":
                bad["nef"][field] = base64.b64encode(script[:-1]).decode()
            elif field == "checksum":
                bad["nef"][field] += 1
            else:
                bad[field]["permissions"] = []
            with self.subTest(field=field), self.assertRaises(activation.ValidationFailure):
                activation.check_readback(bad, script, nef, manifest)

    def test_verification_requires_exact_boolean_true(self):
        activation.check_verification({"state": "HALT", "stack": [{"type": "Boolean", "value": True}]}, "HALT")
        for item in ({"type": "Integer", "value": "1"}, {"type": "Boolean", "value": 1},
                     {"type": "Boolean", "value": False}):
            with self.subTest(item=item), self.assertRaises(activation.ValidationFailure):
                activation.check_verification({"state": "HALT", "stack": [item]}, "HALT")

    def test_unexpected_state_is_never_success(self):
        for state, expected in (("HALT", "FAULT"), ("FAULT", "HALT"), ("BREAK", "FAULT")):
            with self.subTest(state=state), self.assertRaises(activation.ValidationFailure):
                activation.check_verification({"state": state, "stack": []}, expected)


class BoundaryTests(unittest.TestCase):
    def chain(self, indices, results):
        heights = iter(indices)
        states = iter(results)
        chain = Mock()
        chain.rpc.side_effect = lambda name, args: next(heights) if name == "getblockcount" else next(states)
        return chain

    def result(self, state):
        return {"state": state, "gasconsumed": "42", "stack": [{"type": "Boolean", "value": True}] if state == "HALT" else []}

    def test_exact_live_boundary_is_required(self):
        chain = self.chain([8, 8, 9, 9], [self.result("FAULT"), self.result("HALT")])
        samples = activation.sample_boundary(chain, "probe", 8, 5, sleep=lambda _: None)
        self.assertEqual([s["ledgerIndex"] for s in samples], [7, 8])

    def test_block_race_is_discarded(self):
        chain = self.chain([7, 8, 8, 8, 9, 9], [self.result("HALT"), self.result("FAULT"), self.result("HALT")])
        samples = activation.sample_boundary(chain, "probe", 8, 5, sleep=lambda _: None)
        self.assertEqual(len(samples), 2)

    def test_unexpected_early_activation_fails(self):
        chain = self.chain([8, 8], [self.result("HALT")])
        with self.assertRaises(activation.ValidationFailure):
            activation.sample_boundary(chain, "probe", 8, 5, sleep=lambda _: None)

    def test_skipping_exact_boundary_cannot_pass(self):
        chain = self.chain([10, 10], [self.result("HALT")])
        with self.assertRaisesRegex(activation.ValidationFailure, "Missed"):
            activation.sample_boundary(chain, "probe", 8, 5, sleep=lambda _: None)

    def test_timeout_does_not_turn_rejection_into_a_pass(self):
        times = iter([0, 1, 6])
        chain = self.chain([2, 2], [self.result("FAULT")])
        with self.assertRaisesRegex(activation.ValidationFailure, "boundary"):
            activation.sample_boundary(chain, "probe", 8, 5, clock=lambda: next(times), sleep=lambda _: None)

    def test_invalid_boundaries_and_timeouts_fail_before_rpc(self):
        for height, timeout in ((1, 10), (8, 0), (8, -1), (2**32, 10)):
            chain = Mock()
            with self.subTest(height=height), self.assertRaises(activation.ValidationFailure):
                activation.sample_boundary(chain, "probe", height, timeout)
            chain.rpc.assert_not_called()


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

    def test_runner_executes_exact_program_and_preserves_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime with ' quotes"
            runtime.mkdir()
            (runtime / "neoxp.dll").write_text("import json,sys; print(json.dumps(sys.argv))")
            wrapper = activation.make_runner(runtime, Path(sys.executable), root)
            completed = subprocess.run([wrapper, "argument with spaces"], check=True, text=True, capture_output=True)
            self.assertEqual(json.loads(completed.stdout), [str(runtime / "neoxp.dll"), "argument with spaces"])


class LifecycleTests(unittest.TestCase):
    def fake_chain(self, active, fail_at=None):
        script, nef, manifest = activation.probe()
        chain = Mock()
        def factory(runner, scratch):
            chain.file = Path(scratch) / "chain.json"
            def nx(*args):
                if args[0] == "create":
                    chain.file.write_text(json.dumps({"magic": 123, "consensus-nodes": [{}]}))
                return 0, json.dumps({"tx-hash": "tx", "contract-hash": "contract"})
            chain.nx.side_effect = nx
            chain.json_from.side_effect = json.loads
            def rpc(method, args):
                if method == fail_at:
                    raise activation.ValidationFailure("Injected RPC failure")
                if method == "getversion":
                    return {"protocol": {"network": 123}, "useragent": "private-probe"}
                if method == "getnativecontracts":
                    return []
                if method == "getcontractstate":
                    return {"nef": {"script": base64.b64encode(script).decode(),
                                    "checksum": int.from_bytes(nef[-4:], "little")}, "manifest": manifest}
                if method == "getblockcount":
                    return 2
                if method == "invokecontractverify":
                    return {"state": "HALT" if active else "FAULT", "gasconsumed": "42",
                            "stack": [{"type": "Boolean", "value": True}] if active else []}
                if method == "invokescript":
                    exhausted = args[0] == base64.b64encode(activation.bounded_script(1)).decode()
                    return {"state": "HALT" if active and not exhausted else "FAULT",
                            "exception": "The bounded contract call gas limit has been exhausted." if exhausted else ""}
                self.fail("Unexpected RPC method")
            chain.rpc.side_effect = rpc
            return chain
        return factory, chain

    def test_owned_node_is_stopped_after_each_mode(self):
        for height, active in ((None, False), (2**32 - 1, False), (0, True)):
            factory, chain = self.fake_chain(active)
            with self.subTest(height=height), patch.object(activation, "Chain", side_effect=factory):
                result = activation.run_case("case", "local-runner", height, "HALT" if active else "FAULT")
            self.assertEqual(result["verificationState"], "HALT" if active else "FAULT")
            chain.stop_node.assert_called_once()
            self.assertFalse(chain.file.exists())

    def test_owned_node_is_stopped_on_rpc_failure(self):
        factory, chain = self.fake_chain(True, "invokecontractverify")
        with patch.object(activation, "Chain", side_effect=factory), self.assertRaises(activation.ValidationFailure):
            activation.run_case("case", "local-runner", 0, "HALT")
        chain.stop_node.assert_called_once()
        self.assertFalse(chain.file.exists())

    def test_live_case_uses_race_checked_sampler(self):
        factory, chain = self.fake_chain(False)
        with patch.object(activation, "Chain", side_effect=factory), patch.object(activation, "sample_boundary", return_value=[7, 8]) as sampler:
            result = activation.run_case("case", "local-runner", 8, None, 180)
        self.assertEqual(result["samples"], [7, 8])
        sampler.assert_called_once_with(chain, "contract", 8, 180)
        chain.stop_node.assert_called_once()


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        for name in activation.RUNTIME_FILES:
            (self.runtime / name).write_bytes(name.encode())
        self.output = self.root / "receipt.json"

    def run_validation(self, historical=True):
        return activation.validate(self.runtime, self.runtime if historical else None,
                                   Path(sys.executable), self.output)

    def test_historical_control_is_optional_not_implied(self):
        for historical in (False, True):
            with patch.object(activation, "run_case", side_effect=lambda label, *args: {"name": label}), patch("builtins.print"):
                report = self.run_validation(historical)
            self.assertEqual(report["status"], "PASS")
            self.assertEqual(report["diagnosticDeploymentsPersisted"], 5 if historical else 4)
            self.assertIs(report["historicalRegressionReproduced"], historical)
            self.assertNotIn(str(self.root), self.output.read_text())

    def test_failure_replaces_old_pass_without_sensitive_messages(self):
        self.output.write_text('{"status":"PASS"}')
        with patch.object(activation, "run_case", side_effect=RuntimeError("sensitive local path")), self.assertRaises(RuntimeError):
            self.run_validation()
        report = json.loads(self.output.read_text())
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(report["failure"], {"stage": "historical-future", "type": "RuntimeError"})
        self.assertNotIn("sensitive", self.output.read_text())

    def test_old_pass_is_invalidated_before_first_chain_runs(self):
        self.output.write_text('{"status":"PASS"}')
        def observe(label, *args):
            self.assertNotEqual(json.loads(self.output.read_text())["status"], "PASS")
            return {"name": label}
        with patch.object(activation, "run_case", side_effect=observe), patch("builtins.print"):
            self.run_validation()

    def test_runtime_change_fails_closed(self):
        def mutate(label, *args):
            (self.runtime / "Neo.dll").write_bytes(b"modified")
            return {"name": label}
        with patch.object(activation, "run_case", side_effect=mutate), patch("builtins.print"), self.assertRaises(activation.ValidationFailure):
            self.run_validation()
        report = json.loads(self.output.read_text())
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(report["failure"]["stage"], "runtime-stability")


if __name__ == "__main__":
    unittest.main()

import copy
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

import ordinary_entry_proofs as proof


class ArtifactBindingTests(unittest.TestCase):
    def setUp(self):
        # PUSHINT8 5; RET. Offset 1 points into the operand.
        body = b"NEF3" + bytes(69) + bytes.fromhex("03 00 05 40")
        self.nef = body + hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
        self.methods = [dict(name="_initialize", safe=False, offset=2, returntype="Void", parameters=[]),
                        dict(name="read", safe=True, offset=0, returntype="Integer", parameters=[])]

    def manifest(self, methods):
        return json.dumps({"abi":{"methods": methods}}).encode()

    def test_descriptor_must_address_a_real_instruction_and_unique_key(self):
        def bind(methods):
            manifest = self.manifest(methods)
            return proof.bind(self.nef, manifest, proof.digest(self.nef), proof.digest(manifest))
        self.assertEqual(bind(self.methods)[0:2], (self.methods, 2))
        bad = copy.deepcopy(self.methods)
        bad[1]["offset"] = 1
        for rows in (bad, self.methods + [self.methods[1]], self.methods[1:]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                bind(rows)

    def test_failed_recheck_invalidates_old_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            nef, manifest = root/"target.nef", root/"target.json"
            nef.write_bytes(self.nef)
            raw_manifest = self.manifest(self.methods)
            manifest.write_bytes(raw_manifest)
            for nh, mh in ((proof.digest(self.nef), "0"*64), ("0"*64, proof.digest(raw_manifest))):
                receipt = root/"result.json"
                receipt.write_text('{"status":"PASS_SCOPED"}')
                with self.subTest(nh=nh), self.assertRaises(ValueError):
                    proof.run(SimpleNamespace(output=root, nef=nef, manifest=manifest, nef_sha256=nh, manifest_sha256=mh))
                self.assertEqual(json.loads(receipt.read_text())["status"], "INCOMPLETE")

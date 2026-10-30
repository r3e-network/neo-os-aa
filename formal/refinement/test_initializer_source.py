import copy
import json
from pathlib import Path
import unittest

import initializer_source as source


class InitializerSourceTests(unittest.TestCase):
    def setUp(self):
        self.inventory = json.loads((Path(__file__).with_name("fixtures") / "initializer-source.json").read_text())

    def test_every_static_field_source_bound_without_target(self):
        result = source.project_source(self.inventory)
        self.assertEqual(len(result["initializers"]), 53)
        self.assertEqual(len({i["fieldId"] for i in result["initializers"]}), 53)
        self.assertEqual(result["staticConstructor"]["id"], source.STATIC_CONSTRUCTOR)
        self.assertNotIn("nef", self.inventory)

    def test_dimension_and_element_metadata_cannot_hide_elements(self):
        initializer = self.inventory["source"]["initializers"][0]["operations"][0]
        initializer["children"][0]["semanticCollections"]["IArrayCreationOperation.DimensionSizes"]["childIndices"] = []
        with self.assertRaises(ValueError):
            source.project_source(self.inventory)

    def test_missing_duplicate_and_unbound_initializers_rejected(self):
        original = copy.deepcopy(self.inventory)
        for kind in ("missing", "duplicate", "unbound"):
            self.inventory = copy.deepcopy(original)
            items = self.inventory["source"]["initializers"]
            if kind == "missing": items.pop()
            elif kind == "duplicate": items.append(copy.deepcopy(items[0]))
            else: items[0]["operations"][0]["semanticCollections"]["IFieldInitializerOperation.InitializedFields"]["items"][0]["id"] = "F:Unknown"
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                source.project_source(self.inventory)

    def test_supported_arithmetic_changes_remain_in_source_program(self):
        before = source.project_source(self.inventory)
        binary = next(n for n in source.nodes(self.inventory) if n.get("kind") == "Binary")
        # Change every multiplication to addition and remove stale folded metadata;
        # both source operation and metadata must be projected consistently.
        binary["details"]["operator"] = "Add"
        binary["boundMetadata"]["IBinaryOperation.OperatorKind"] = "Add"
        with self.assertRaises(ValueError):
            source.project_source(self.inventory)  # original folded constant now lies
        self.assertEqual(len(before["initializers"]), 53)

    def test_unknown_initializer_effect_rejected(self):
        op = self.inventory["source"]["initializers"][0]["operations"][0]
        op["unexportedMetadata"].append("Unmodeled.InitEffect")
        with self.assertRaises(ValueError):
            source.project_source(self.inventory)

    def test_explicit_or_missing_static_constructor_is_not_silently_omitted(self):
        original = copy.deepcopy(self.inventory)
        constructor = "M:SmartAccount.SmartAccount.#cctor"
        for kind in ("explicit", "missing-synthesized", "missing-method-inventory", "empty-method-inventory"):
            candidate = copy.deepcopy(original)
            if kind == "explicit":
                candidate["source"]["methods"] = [{"id": constructor, "origin": "repository-source",
                    "operations": [{"kind": "Throw"}]}]
            elif kind == "missing-method-inventory":
                candidate["source"].pop("methods", None)
            elif kind == "empty-method-inventory":
                candidate["source"]["methods"] = []
            if kind not in ("missing-method-inventory", "empty-method-inventory"):
                for typ in candidate["source"]["types"]:
                    if typ["id"] == source.TYPE_ID:
                        typ["synthesizedMembers"] = [m for m in typ["synthesizedMembers"] if m["id"] != constructor]
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                source.project_source(candidate)

    def test_constructor_metadata_must_be_complete_and_unambiguous(self):
        for kind in ("explicit-with-synthesized", "duplicate", "unknown-kind", "missing-issue", "invalid-method-list"):
            candidate = copy.deepcopy(self.inventory)
            if kind == "explicit-with-synthesized":
                candidate["source"]["methods"] = [{"id": "M:SmartAccount.SmartAccount.#cctor",
                    "operations": [{"kind": "Throw"}]}]
            elif kind == "invalid-method-list":
                candidate["source"]["methods"] = [{}]
            else:
                for typ in candidate["source"]["types"]:
                    if typ["id"] != source.TYPE_ID:
                        continue
                    constructor = next(m for m in typ["synthesizedMembers"] if m["id"].endswith(".#cctor"))
                    if kind == "duplicate": typ["synthesizedMembers"].append(copy.deepcopy(constructor))
                    elif kind == "unknown-kind": constructor["kind"] = "Field"
                    else: constructor.pop("issue")
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                source.project_source(candidate)


if __name__ == "__main__":
    unittest.main()

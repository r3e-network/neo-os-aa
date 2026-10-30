"""Source-side controls: whole-body projection must not be target-derived."""
import copy
import json
from pathlib import Path
import unittest

import method_source as source

FIXTURE = Path(__file__).with_name("fixtures") / "cap-method-source.json"


def nodes(value):
    if isinstance(value, dict):
        if "kind" in value and "children" in value:
            yield value
        for child in value.values():
            yield from nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from nodes(child)


class MethodSourceTests(unittest.TestCase):
    def setUp(self):
        self.inventory = json.loads(FIXTURE.read_text())

    def project(self):
        return source.project_method(self.inventory)

    def test_complete_source_body_and_initializers_are_projected(self):
        result = self.project()
        self.assertEqual(result["staticKey"], [33])
        self.assertEqual(len(result["statements"]), 14)
        self.assertEqual(result["locals"], ["transactionHash", "data", "budget", "actualCost",
                                            "estimationFlag", "cap", "settled", "vmMax"])
        rendered = source.render_program(result)
        for token in ["SAssert", "EPut", "ESerialize", "EDeserialize", "SSetField", "SReturn", "ETransaction"]:
            self.assertIn(token, rendered)
        self.assertNotIn("actual_bytes", rendered)

    def test_supported_extra_write_is_preserved_not_ignored(self):
        before = self.project()
        block = self.inventory["source"]["methods"][0]["operations"][0]["children"][0]
        # Duplicate the existing compound assignment, with honest child inventory.
        block["children"].insert(-1, copy.deepcopy(block["children"][-3]))
        block["semanticCollections"]["IBlockOperation.Operations"]["childIndices"] = list(range(len(block["children"])))
        after = self.project()
        self.assertEqual(len(after["statements"]), len(before["statements"]) + 1)
        self.assertNotEqual(source.render_program(before), source.render_program(after))

    def test_missing_collection_and_hidden_effect_are_rejected(self):
        original = copy.deepcopy(self.inventory)
        for mutate in ("missing", "ignored", "unexported"):
            self.inventory = copy.deepcopy(original)
            declaration = next(n for n in nodes(self.inventory) if n["kind"] == "VariableDeclarator")
            if mutate == "missing":
                declaration.pop("semanticCollections")
            elif mutate == "ignored":
                declaration["semanticCollections"]["IVariableDeclaratorOperation.IgnoredArguments"]["childIndices"] = [0]
            else:
                declaration["unexportedMetadata"].append("Unmodeled.SideEffect")
            with self.subTest(mutate=mutate), self.assertRaises(source.SourceProjectionError):
                self.project()

    def test_changed_return_source_is_reflected(self):
        before = self.project()
        ret = next(n for n in nodes(self.inventory) if n["kind"] == "Return")
        local = ret["children"][0]
        local["details"]["symbol"] = "actualCost"
        local["boundMetadata"]["ILocalReferenceOperation.Local"]["id"] = "actualCost"
        self.assertNotEqual(source.render_program(before), source.render_program(self.project()))

    def test_unknown_type_callee_and_conversion_are_rejected(self):
        original = copy.deepcopy(self.inventory)
        for mutate in ("type", "callee", "conversion"):
            self.inventory = copy.deepcopy(original)
            if mutate == "type":
                n = next(n for n in nodes(self.inventory) if n["kind"] == "ParameterReference")
                n["type"] = "string"
            elif mutate == "callee":
                n = next(n for n in nodes(self.inventory) if n["kind"] == "Invocation")
                n["details"]["callee"] = "M:Unreviewed.Native.Call()"
                n["boundMetadata"]["IInvocationOperation.TargetMethod"]["id"] = n["details"]["callee"]
            else:
                n = next(n for n in nodes(self.inventory) if n["kind"] == "Conversion")
                n["details"]["tryCast"] = True
                n["boundMetadata"]["IConversionOperation.IsTryCast"] = True
            with self.subTest(mutate=mutate), self.assertRaises(source.SourceProjectionError):
                self.project()

    def test_argument_reordering_is_rejected(self):
        invocation = next(n for n in nodes(self.inventory) if n["kind"] == "Invocation" and ".Storage.Get(" in n["details"]["callee"])
        invocation["children"].reverse()
        with self.assertRaises(source.SourceProjectionError):
            self.project()

    def test_source_arithmetic_mutations_change_program(self):
        before = source.render_program(self.project())
        binary = next(n for n in nodes(self.inventory) if n["kind"] == "Binary" and n["details"].get("operator") == "Subtract")
        binary["details"]["operator"] = "Add"
        binary["details"]["operatorMethod"] = "M:System.Numerics.BigInteger.op_Addition(System.Numerics.BigInteger,System.Numerics.BigInteger)"
        binary["boundMetadata"]["IBinaryOperation.OperatorKind"] = "Add"
        binary["boundMetadata"]["IBinaryOperation.OperatorMethod"]["id"] = binary["details"]["operatorMethod"]
        self.assertNotEqual(before, source.render_program(self.project()))

    def test_guard_and_storage_statement_mutations_are_preserved(self):
        baseline = source.render_program(self.project())
        conditional = next(n for n in nodes(self.inventory) if n["kind"] == "Conditional" and n["type"] is None)
        guard = conditional["children"][0]
        guard["details"]["operator"] = "Equals"
        guard["boundMetadata"]["IBinaryOperation.OperatorKind"] = "Equals"
        self.assertNotEqual(baseline, source.render_program(self.project()))
        block = self.inventory["source"]["methods"][0]["operations"][0]["children"][0]
        block["children"][-2], block["children"][-3] = block["children"][-3], block["children"][-2]
        self.assertNotEqual(baseline, source.render_program(self.project()))

    def test_record_layout_and_constructor_binding_are_checked(self):
        original = copy.deepcopy(self.inventory)
        for mutation in ("layout", "type", "constructor", "initializer-binding", "initializer-symbol-type"):
            self.inventory = copy.deepcopy(original)
            record = next(t for t in self.inventory["source"]["types"] if t["id"] == source.RECORD_ID)
            if mutation == "layout":
                record["fields"].reverse()
            elif mutation == "type":
                record["fields"][0]["type"] = source.BIG
            elif mutation == "constructor":
                record["synthesizedMembers"] = []
            else:
                initializer = next(i for i in self.inventory["source"]["initializers"] if i["operations"][0]["semanticCollections"]["IFieldInitializerOperation.InitializedFields"]["items"][0]["id"].endswith(".Reserved"))
                symbol = initializer["operations"][0]["semanticCollections"]["IFieldInitializerOperation.InitializedFields"]["items"][0]
                symbol["id" if mutation == "initializer-binding" else "type"] = "unbound"
            with self.subTest(mutation=mutation), self.assertRaises(source.SourceProjectionError):
                self.project()

    def test_constructor_constant_is_projected(self):
        before = source.render_program(self.project())
        initializer = next(i for i in self.inventory["source"]["initializers"] if i["operations"][0]["semanticCollections"]["IFieldInitializerOperation.InitializedFields"]["items"][0]["id"].endswith(".Reserved"))
        literal = next(n for n in nodes(initializer) if n["kind"] == "Literal")
        literal["constant"]["value"]["value"] = "2"
        after = self.project()
        self.assertNotEqual(before, source.render_program(after))
        self.assertEqual(after["recordInitializers"][1], ["EVal", ["VInt", 2]])

    def test_static_key_and_array_dimensions_are_bound(self):
        original = copy.deepcopy(self.inventory)
        for mutation in ("key", "dimension", "dimension-collection", "element-collection"):
            self.inventory = copy.deepcopy(original)
            array = next(n for n in nodes(self.inventory) if n["kind"] == "ArrayCreation")
            if mutation == "key":
                value = array["children"][1]["children"][0]
                value["constant"]["value"]["value"] = "34"
                value["children"][0]["constant"]["value"]["value"] = "34"
            elif mutation == "dimension":
                array["children"][0]["constant"]["value"]["value"] = "2"
            elif mutation == "dimension-collection":
                array["semanticCollections"]["IArrayCreationOperation.DimensionSizes"]["childIndices"] = []
            else:
                array["children"][1]["semanticCollections"]["IArrayInitializerOperation.ElementValues"]["childIndices"] = []
            with self.subTest(mutation=mutation), self.assertRaises(source.SourceProjectionError):
                self.project()

    def test_runtime_dialect_contracts_are_explicit_and_hashed(self):
        projected = self.project()
        self.assertIn("frameworkContracts", projected)
        self.assertEqual(projected["frameworkContracts"]["transactionFields"], {"Hash": 0, "SystemFee": 4, "NetworkFee": 5})
        self.assertEqual(len(projected["sourceProjectionSha256"]), 64)
        self.assertIn("not CLR", projected["frameworkContracts"]["referenceEquality"])

    def test_complete_collections_cannot_hide_siblings_or_new_metadata(self):
        original = copy.deepcopy(self.inventory)
        for mutation in ("sibling", "collection", "metadata"):
            self.inventory = copy.deepcopy(original)
            ret = next(n for n in nodes(self.inventory) if n["kind"] == "Return")
            if mutation == "sibling":
                ret["children"].append(copy.deepcopy(ret["children"][0]))
            elif mutation == "collection":
                ret["semanticCollections"]["Unmodeled.Arguments"] = {"kind": "operations", "childIndices": [], "complete": True}
            else:
                ret["boundMetadata"]["Unmodeled.SideEffect"] = True
            with self.subTest(mutation=mutation), self.assertRaises(source.SourceProjectionError):
                self.project()

    def test_semantic_flags_require_boolean_not_integer(self):
        baseline = copy.deepcopy(self.inventory)
        for mutation in ("checked", "complete"):
            self.inventory = copy.deepcopy(baseline)
            if mutation == "checked":
                binary = next(n for n in nodes(self.inventory) if n["kind"] == "Binary")
                binary["details"]["checked"] = 0
                binary["boundMetadata"]["IBinaryOperation.IsChecked"] = 0
            else:
                block = self.inventory["source"]["methods"][0]["operations"][0]["children"][0]
                block["semanticCollections"]["IBlockOperation.Operations"]["complete"] = 1
            with self.subTest(mutation=mutation), self.assertRaises(source.SourceProjectionError):
                self.project()

    def test_malformed_semantic_containers_are_rejected_consistently(self):
        baseline = copy.deepcopy(self.inventory)
        for mutation in ("details", "boundMetadata", "children", "semanticCollections"):
            self.inventory = copy.deepcopy(baseline)
            expression = next(n for n in nodes(self.inventory) if n["kind"] == "Binary")
            expression[mutation] = [] if mutation != "children" else {}
            with self.subTest(mutation=mutation), self.assertRaises(source.SourceProjectionError):
                self.project()


if __name__ == "__main__":
    unittest.main()

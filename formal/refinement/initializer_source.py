"""Source-only pure static initializer projection; target slots are bound later."""
import hashlib
import json
import method_source as source

TYPE_ID = "T:SmartAccount.SmartAccount"
STATIC_CONSTRUCTOR = "M:SmartAccount.SmartAccount.#cctor"
require = source.require


def nodes(value):
    if isinstance(value, dict):
        if "kind" in value and "children" in value:
            yield value
        for child in value.values():
            yield from nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from nodes(child)


def evaluate(expression):
    if expression[0] == "Number":
        return expression[1]
    _, width, operator, left, right = expression
    a, b = evaluate(left), evaluate(right)
    result = {"Add": lambda: a + b, "Subtract": lambda: a - b, "Multiply": lambda: a * b}[operator]()
    half = 1 << (width - 1)
    return (result + half) % (2 * half) - half


class Projector(source.Projector):
    def integer_expression(self, node):
        self.header(node)
        kind, typ, children = node["kind"], node["type"], node["children"]
        if kind == "Literal":
            value = self.literal(node)
            require(value[0] == "EVal" and value[1][0] == "VInt", "Integer literal required")
            return ["Number", value[1][1]]
        if kind == "Conversion":
            require(len(children) == 1, "Conversion child count")
            converted = self.integer_expression(children[0])
            # Reuse the existing strict type/member/constant conversion validator
            # while retaining the operand's arithmetic tree for Coq evaluation.
            super().expr(node)
            return converted
        require(kind == "Binary" and typ in ("int", "long") and len(children) == 2
                and all(child["type"] == typ for child in children), "Unsupported integer initializer expression")
        operator = node["details"].get("operator")
        require(operator in ("Add", "Subtract", "Multiply"), "Unsupported integer operation")
        self.check(node, kind="Binary", typ=typ, count=2, constant=True,
            details={"operator": operator, "checked": False, "lifted": False, "operatorMethod": None},
            meta={"IBinaryOperation.OperatorKind": operator, "IBinaryOperation.LeftOperand": source.CHILD,
                "IBinaryOperation.RightOperand": source.CHILD, "IBinaryOperation.IsLifted": False,
                "IBinaryOperation.IsChecked": False, "IBinaryOperation.IsCompareText": False,
                "IBinaryOperation.OperatorMethod": None, "IBinaryOperation.ConstrainedToType": None})
        expression = ["Primitive", 32 if typ == "int" else 64, operator,
                      self.integer_expression(children[0]), self.integer_expression(children[1])]
        expected = {"hasValue": True, "value": {"runtimeType": "System.Int32" if typ == "int" else "System.Int64",
                                               "value": str(evaluate(expression))}}
        require(source.same(node["constant"], expected), "Contradictory primitive constant")
        return expression

    def expr(self, node):
        # Parent conversion validator expects a constant value representation.
        # This adapter is used only for validating conversion metadata; the
        # emitted Coq arithmetic retains integer_expression's tree above.
        if node["kind"] == "Binary" and node["type"] in ("int", "long"):
            return source.integer(evaluate(self.integer_expression(node)))
        return super().expr(node)

    def static_expression(self, node):
        typ = node["type"]
        if typ == source.BIG:
            return ["StaticInteger", self.integer_expression(node)]
        require(typ in ("byte[]", "string[]"), "Unsupported static field type")
        self.check(node, kind="ArrayCreation", typ=typ, count=2,
            meta={"IArrayCreationOperation.Initializer": source.CHILD},
            collections={"IArrayCreationOperation.DimensionSizes": source.collection([0])})
        dimension, elements = node["children"]
        require(dimension["type"] == "int", "Array dimension type")
        self.check(elements, kind="ArrayInitializer", collections={
            "IArrayInitializerOperation.ElementValues": source.collection(list(range(len(elements["children"]))))})
        require(self.literal(dimension) == source.integer(len(elements["children"])), "Array dimension mismatch")
        if typ == "byte[]":
            require(all(e["type"] == "byte" for e in elements["children"]), "Array element type")
            return ["StaticBuffer", [self.integer_expression(e) for e in elements["children"]]]
        values = [self.literal(e) for e in elements["children"]]
        require(all(e["type"] == "string" for e in elements["children"])
                and all(v[0] == "EVal" and v[1][0] == "VBytes" for v in values), "String array element type")
        return ["StaticStrings", [v[1][1] for v in values]]


def project_source(inventory):
    projector = Projector(inventory)
    types = [t for t in projector.source["types"] if t["id"] == TYPE_ID]
    require(types and all(source.same({k: v for k, v in t.items() if k != "location"},
                                     {k: v for k, v in types[0].items() if k != "location"}) for t in types),
            "Partial contract declarations have inconsistent semantic metadata")
    methods = projector.source.get("methods")
    require(isinstance(methods, list) and methods and all(isinstance(m, dict) and isinstance(m.get("id"), str)
                                            for m in methods), "Missing or invalid source method inventory")
    require(not any(m["id"].startswith(STATIC_CONSTRUCTOR) for m in methods),
            "Explicit static constructor requires separate semantics")
    members = types[0].get("synthesizedMembers")
    require(isinstance(members, list) and all(isinstance(m, dict) and isinstance(m.get("id"), str)
                                            for m in members), "Missing or invalid synthesized member inventory")
    constructors = [m for m in members if m["id"].startswith(STATIC_CONSTRUCTOR)]
    constructor = {"id": STATIC_CONSTRUCTOR, "kind": "Method",
                   "issue": "Compiler-synthesized member has no separately exported source body"}
    require(source.same(constructors, [constructor]),
            "Static constructor is not the supported synthesized initializer")
    all_fields = [f for f in types[0]["fields"] if f["isStatic"] and f["constant"] is None]
    fields = [f for f in all_fields if f["isReadOnly"]]
    synthesized = {m["id"] for m in types[0]["synthesizedMembers"] if m["kind"] == "Method"}
    excluded = [f for f in all_fields if not f["isReadOnly"]]
    excluded_ids = {f["id"] for f in excluded}
    for field in excluded:
        prefix = "M:SmartAccount.SmartAccount."
        typ = field["type"].removeprefix("global::")
        require(all(prefix + action + field["name"] + "(" + typ + ")" in synthesized for action in ("add_", "remove_")),
                "Unknown mutable static field requires separate semantics")
    by_id = {f["id"]: f for f in fields}
    all_by_id = {f["id"]: f for f in all_fields}
    require(len(by_id) == len(fields), "Duplicate static field identity")
    found, bound_nodes = [], []
    seen, event_seen = set(), set()
    for initializer in projector.source["initializers"]:
        for operation in initializer["operations"]:
            ids = operation.get("semanticCollections", {}).get("IFieldInitializerOperation.InitializedFields", {}).get("items", [])
            if not any(item.get("id") in all_by_id for item in ids):
                continue
            require(initializer["origin"] == "repository-source" and initializer["exportIssue"] is None
                    and len(initializer["operations"]) == len(ids) == 1, "Ambiguous initializer")
            identifier = ids[0]["id"]
            require(identifier not in seen and identifier not in event_seen, "Duplicate initializer")
            field = all_by_id[identifier]
            symbol = {k: field[k] for k in ("id", "type", "name", "isStatic", "isReadOnly")}
            symbol["kind"] = "Field"
            projector.check(operation, kind="FieldInitializer", count=1,
                meta={"ISymbolInitializerOperation.Value": source.CHILD},
                collections={"ISymbolInitializerOperation.Locals": source.symbols([]),
                             "IFieldInitializerOperation.InitializedFields": source.symbols([symbol])})
            require(operation["children"][0]["type"] == field["type"], "Initializer field type mismatch")
            if identifier in excluded_ids:
                value = operation["children"][0]
                conversion = source.conv(reference=True)
                projector.check(value, kind="Conversion", typ=field["type"], count=1, constant=True,
                    details={"checked": False, "tryCast": False, "conversion": conversion},
                    meta={"IConversionOperation.Operand": source.CHILD, "IConversionOperation.OperatorMethod": None,
                        "IConversionOperation.ConstrainedToType": None, "IConversionOperation.Conversion": conversion,
                        "IConversionOperation.IsTryCast": False, "IConversionOperation.IsChecked": False})
                require(source.same(value["constant"], {"hasValue": True, "value": None})
                        and projector.literal(value["children"][0]) == ["EVal", ["VNull"]],
                        "Only null event initializer is admitted; event lowering is a separate obligation")
                event_seen.add(identifier)
                continue
            seen.add(identifier)
            found.append({"fieldId": identifier, "fieldName": field["name"], "fieldType": field["type"],
                          "expression": projector.static_expression(operation["children"][0])})
            bound_nodes.append(operation)
    require(seen == set(by_id), "Missing source field initializer")
    require(event_seen == excluded_ids, "Missing source event null initializer")
    serial = json.dumps({"initializers": found, "staticConstructor": constructor},
                        sort_keys=True, separators=(",", ":")).encode()
    tree = {"initializers": bound_nodes, "staticConstructor": constructor,
            "methodIds": [m["id"] for m in methods]}
    return {"schema": "neoos-sa-initializer-source/v1", "initializers": found,
            "staticConstructor": constructor,
            "excludedSynthesizedEventFields": [f["id"] for f in excluded],
            "sourceProjectionSha256": hashlib.sha256(serial).hexdigest(),
            "sourceTreeSha256": hashlib.sha256(json.dumps(tree, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
            "sourceFrontendVerified": False}


def render_integer(expression):
    if expression[0] == "Number":
        return "(SourceNumber (" + str(expression[1]) + "))"
    _, width, operator, left, right = expression
    return "(SourcePrimitive " + str(width) + " " + {"Add": "Add", "Subtract": "Sub", "Multiply": "Mul"}[operator] + " " + render_integer(left) + " " + render_integer(right) + ")"


def render_expression(expression):
    kind, value = expression
    if kind == "StaticInteger":
        return "(SourceInteger " + render_integer(value) + ")"
    if kind == "StaticBuffer":
        return "(SourceBuffer [" + ";".join(map(render_integer, value)) + "])"
    return "(SourceStrings [" + ";".join("[" + ";".join(str(b) + "%nat" for b in v) + "]" for v in value) + "])"

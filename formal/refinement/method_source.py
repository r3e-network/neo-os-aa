"""Fail-closed source-only projection of the complete reimbursement helper.

This is a checked frontend into CapMethodVm's declared Neo-framework dialect,
not a proof of Roslyn or of arbitrary CLR reference/codec semantics. No NEF,
opcodes, offsets, debug map or expected target output is consulted here.
"""
import copy
import hashlib
import json

METHOD = "M:SmartAccount.SmartAccount.CapReimbursementToActualCost(System.Numerics.BigInteger)"
RECORD = "global::SmartAccount.SmartAccount.TransactionReimbursement"
RECORD_ID = "T:SmartAccount.SmartAccount.TransactionReimbursement"
CTOR = "M:SmartAccount.SmartAccount.TransactionReimbursement.#ctor"
PREFIX = "F:SmartAccount.SmartAccount.Prefix_TransactionReimbursement"
FRAMEWORK = "global::Neo.SmartContract.Framework."
BIG = "global::System.Numerics.BigInteger"
UINT = FRAMEWORK + "UInt256"
BYTESTRING = FRAMEWORK + "ByteString"
TRANSACTION = FRAMEWORK + "Services.Transaction"
CONTEXT = FRAMEWORK + "Services.StorageContext"
CHILD = "Operation child; see ordered children"
IDENTITY = dict(Exists=True, IsIdentity=True, IsImplicit=True, IsNullable=False,
                IsNumeric=False, IsReference=False, IsUserDefined=False, method=None)


class SourceProjectionError(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise SourceProjectionError(message)


def same(a, b):
    """JSON equality without Python's True == 1 / False == 0 coercion."""
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return set(a) == set(b) and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return a == b


def symbol(identifier):
    return None if identifier is None else {"id": identifier, "type": None}


def collection(indices):
    return {"kind": "operations", "childIndices": indices, "complete": True}


def symbols(items):
    return {"kind": "symbols", "items": items, "complete": True}


def conv(*, implicit=True, identity=False, numeric=False, reference=False, method=None):
    return dict(Exists=True, IsIdentity=identity, IsImplicit=implicit, IsNullable=False,
                IsNumeric=numeric, IsReference=reference, IsUserDefined=method is not None, method=method)


def integer(value):
    return ["EVal", ["VInt", value]]


def literal_bytes(value):
    return ["EVal", ["VBytes", list(value)]]


class Projector:
    def __init__(self, inventory):
        self.source = inventory["source"]
        self.local_names, self.local_types, self.local_ids = [], {}, {}
        self.initializers = {}
        self.record_values = []
        self.field_table = {}

    def header(self, n):
        require(isinstance(n, dict), "Operation must be an object")
        expected = {"kind", "type", "implicit", "constant", "location", "details", "boundMetadata",
                    "semanticCollections", "unexportedMetadata", "children", "evaluationOrder"}
        require(set(n) == expected, "Missing or unknown operation data: " + str(set(n) ^ expected))
        require(type(n["implicit"]) is bool and isinstance(n["children"], list), "Invalid operation structure")
        require(isinstance(n["kind"], str) and (n["type"] is None or isinstance(n["type"], str)), "Invalid operation kind/type")
        require(isinstance(n["details"], dict) and isinstance(n["boundMetadata"], dict), "Invalid semantic metadata container")
        require(n["constant"] is None or isinstance(n["constant"], dict), "Invalid constant metadata container")
        require(n["unexportedMetadata"] == [], "Unmodeled operation metadata")
        require(n["evaluationOrder"] == "Roslyn ChildOperations order; formal semantics still required", "Unknown evaluation order")
        require(isinstance(n["semanticCollections"], dict), "Missing semantic collection inventory")
        return n["children"]

    def check(self, n, *, kind=None, typ=None, details=None, meta=None, collections=None, count=None, constant=False):
        children = self.header(n)
        if kind is not None:
            require(n["kind"] == kind, "Expected " + kind + ", found " + n["kind"])
        require(n["type"] == typ, "Unexpected " + n["kind"] + " type: " + str(n["type"]))
        require(same(n["details"], (details or {})), "Unsupported or inconsistent " + n["kind"] + " details")
        require(same(n["boundMetadata"], (meta or {})), "Unsupported or inconsistent " + n["kind"] + " semantic metadata")
        require(same(n["semanticCollections"], (collections or {})), "Incomplete or inconsistent " + n["kind"] + " collections")
        if count is not None:
            require(len(children) == count, "Unexpected " + n["kind"] + " child count")
        if not constant:
            require(n["constant"] is None, "Unexpected constant metadata on " + n["kind"])
        return children

    def literal(self, n):
        self.check(n, kind="Literal", typ=n["type"], count=0, constant=True)
        c = n["constant"]
        require(isinstance(c, dict) and set(c) == {"hasValue", "value"} and c["hasValue"] is True, "Missing literal value")
        if n["type"] is None:
            require(c["value"] is None, "Non-null untyped literal")
            return ["EVal", ["VNull"]]
        types = {"int": ("System.Int32", -(1 << 31), 1 << 31),
                 "long": ("System.Int64", -(1 << 63), 1 << 63), "byte": ("System.Byte", 0, 256)}
        v = c["value"]
        require(isinstance(v, dict) and set(v) == {"runtimeType", "value"}, "Invalid literal payload")
        if n["type"] in types:
            runtime, lower, upper = types[n["type"]]
            require(v["runtimeType"] == runtime and isinstance(v["value"], str), "Literal runtime type mismatch")
            try:
                z = int(v["value"])
            except (TypeError, ValueError):
                raise SourceProjectionError("Invalid integer literal") from None
            require(str(z) == v["value"] and lower <= z < upper, "Literal outside declared integer type")
            return integer(z)
        require(n["type"] == "string" and v["runtimeType"] == "System.String" and isinstance(v["value"], str), "Unsupported literal type")
        return literal_bytes(v["value"].encode("utf-8"))

    def member(self, n, *, is_property=False):
        self.header(n)
        identifier = n["details"].get("symbol")
        children = n["children"]
        require(len(children) <= 1, "Indexed or multiple-receiver member unsupported")
        iface = "IPropertyReferenceOperation.Property" if is_property else "IFieldReferenceOperation.Field"
        meta = {"IMemberReferenceOperation.Instance": CHILD if children else None,
                "IMemberReferenceOperation.Member": symbol(identifier), "IMemberReferenceOperation.ConstrainedToType": None,
                iface: symbol(identifier)}
        if not is_property:
            meta["IFieldReferenceOperation.IsDeclaration"] = False
        self.check(n, typ=n["type"], details={"symbol": identifier}, meta=meta,
                   collections={"IPropertyReferenceOperation.Arguments": collection([])} if is_property else {})
        return identifier, children

    def expr(self, n):
        self.header(n)
        k, t, ch = n["kind"], n["type"], n["children"]
        if k == "Literal":
            return self.literal(n)
        if k == "LocalReference":
            name = n["details"].get("symbol")
            require(name in self.local_ids and t == self.local_types[name], "Unknown or mistyped local")
            self.check(n, typ=t, details={"symbol": name}, count=0,
                       meta={"ILocalReferenceOperation.Local": symbol(name), "ILocalReferenceOperation.IsDeclaration": False})
            return ["ELocal", self.local_ids[name]]
        if k == "ParameterReference":
            self.check(n, typ=BIG, details={"symbol": "requested", "ordinal": 0}, count=0,
                       meta={"IParameterReferenceOperation.Parameter": symbol("requested")})
            return ["EArg", 0]
        if k == "PropertyReference":
            identifier, ch = self.member(n, is_property=True)
            properties = {"P:Neo.SmartContract.Framework.Services.Runtime.Transaction": (TRANSACTION, ["ETransaction"]),
                          "P:Neo.SmartContract.Framework.Services.Storage.CurrentContext": (CONTEXT, ["EContext"]),
                          "P:Neo.SmartContract.Framework.UInt256.Zero": (UINT, literal_bytes(bytes(32))),
                          # BigInteger.One is the framework multiplicative identity the
                          # domain-maximum expression is built from; it is an intrinsic,
                          # not a repository member.
                          "P:System.Numerics.BigInteger.One": (BIG, integer(1))}
            require(identifier in properties and not ch, "Unknown source property intrinsic")
            expected_type, expression = properties[identifier]
            require(t == expected_type, "Property result type mismatch")
            return expression
        if k == "FieldReference":
            identifier, ch = self.member(n)
            if identifier == PREFIX:
                require(t == "byte[]" and not ch and self.static_key == [33], "Storage prefix intrinsic mismatch")
                return ["EKey"]
            require(identifier in self.field_table and len(ch) == 1, "Unknown field or receiver")
            receiver_type, index, field_type = self.field_table[identifier]
            require(t == field_type and ch[0]["type"] == receiver_type, "Field layout/type mismatch")
            return ["EField", self.expr(ch[0]), index]
        if k == "Conversion":
            require(len(ch) == 1, "Conversion arity")
            source_type = ch[0]["type"]
            d = n["details"]
            method = d.get("conversion", {}).get("method")
            expected = None
            if t == BIG and source_type in ("int", "long"):
                method_expected = "M:System.Numerics.BigInteger.op_Implicit(System.Int" + ("32" if source_type == "int" else "64") + ")~System.Numerics.BigInteger"
                require(method == method_expected, "Unknown BigInteger conversion")
                expected = conv(implicit=d["conversion"].get("IsImplicit"), method=method)
                require(type(expected["IsImplicit"]) is bool, "Unknown conversion implicit flag")
            elif t == "object" and source_type in (None, BYTESTRING, UINT, RECORD):
                expected = conv(reference=True)
            elif t == RECORD and source_type == "object":
                expected = conv(implicit=False, reference=True)
            elif t == "long" and source_type == "int":
                expected = conv(numeric=True)
            elif t == "byte" and source_type == "int" and ch[0]["kind"] == "Literal":
                expected = conv()
            require(expected is not None, "Unsupported conversion pair")
            self.check(n, typ=t, details={"checked": False, "tryCast": False, "conversion": expected}, count=1, constant=True,
                       meta={"IConversionOperation.Operand": CHILD, "IConversionOperation.OperatorMethod": symbol(method),
                             "IConversionOperation.ConstrainedToType": None, "IConversionOperation.Conversion": expected,
                             "IConversionOperation.IsTryCast": False, "IConversionOperation.IsChecked": False})
            expression = self.expr(ch[0])
            if t == "byte":
                require(expression[0] == "EVal" and expression[1][0] == "VInt" and 0 <= expression[1][1] < 256, "Byte literal range")
            if n["constant"] is not None:
                # Roslyn constant metadata may annotate implicit primitive conversions,
                # but it cannot replace or contradict the operand's semantics.
                payload = None if expression == ["EVal", ["VNull"]] else (
                    {"runtimeType": {"long": "System.Int64", "byte": "System.Byte"}.get(t), "value": str(expression[1][1])}
                    if expression[0] == "EVal" and expression[1][0] == "VInt" else False)
                require(payload is not False and n["constant"] == {"hasValue": True, "value": payload}, "Contradictory conversion constant")
            return expression
        if k == "Binary":
            require(len(ch) == 2, "Binary arity")
            op = n["details"].get("operator")
            method = None
            if op in ("Add", "Subtract", "Multiply"):
                require(t == BIG and all(c["type"] == BIG for c in ch), "BigInteger arithmetic types")
                suffix = {"Add": "Addition", "Subtract": "Subtraction", "Multiply": "Multiply"}[op]
                method = "M:System.Numerics.BigInteger.op_" + suffix + "(System.Numerics.BigInteger,System.Numerics.BigInteger)"
                constructor = ["EBinary", {"Add": "Add", "Subtract": "Sub", "Multiply": "Mul"}[op]]
            elif op in ("Equals", "NotEquals"):
                require(t == "bool" and all(c["type"] == "object" for c in ch), "Reference equality outside declared immutable-byte dialect")
                constructor = ["EEq" if op == "Equals" else "ENeq"]
            elif op == "GreaterThan":
                require(t == "bool" and [c["type"] for c in ch] == [BIG, "long"], "Comparison types")
                method = "M:System.Numerics.BigInteger.op_GreaterThan(System.Numerics.BigInteger,System.Int64)"
                constructor = ["EGT"]
            elif op == "LeftShift":
                # `BigInteger.One << n` is the only shift in the helper: the VM-integer
                # domain maximum is built from 2^254 so that no intermediate is outside
                # the domain. The count is an Int32 literal, which the source dialect
                # reads as a mathematical exponent.
                require(t == BIG and [c["type"] for c in ch] == [BIG, "int"], "Shift operand types")
                method = "M:System.Numerics.BigInteger.op_LeftShift(System.Numerics.BigInteger,System.Int32)"
                constructor = ["EBinary", "Shl"]
            elif op == "LessThanOrEqual":
                require(t == "bool" and all(c["type"] == BIG for c in ch), "Comparison types")
                method = "M:System.Numerics.BigInteger.op_LessThanOrEqual(System.Numerics.BigInteger,System.Numerics.BigInteger)"
                constructor = ["ELE"]
            else:
                raise SourceProjectionError("Unsupported binary operator")
            self.check(n, typ=t, details={"operator": op, "checked": False, "lifted": False, "operatorMethod": method}, count=2,
                       meta={"IBinaryOperation.OperatorKind": op, "IBinaryOperation.LeftOperand": CHILD, "IBinaryOperation.RightOperand": CHILD,
                             "IBinaryOperation.IsLifted": False, "IBinaryOperation.IsChecked": False, "IBinaryOperation.IsCompareText": False,
                             "IBinaryOperation.OperatorMethod": symbol(method), "IBinaryOperation.ConstrainedToType": None})
            return constructor + [self.expr(c) for c in ch]
        if k == "Invocation":
            return self.invocation(n)
        if k == "ObjectCreation":
            self.check(n, typ=RECORD, details={"constructor": CTOR}, count=0,
                       meta={"IObjectCreationOperation.Constructor": symbol(CTOR), "IObjectCreationOperation.Initializer": None},
                       collections={"IObjectCreationOperation.Arguments": collection([])})
            return ["ENew", "ArrayKind", copy.deepcopy(self.record_values)]
        raise SourceProjectionError("Unsupported source expression: " + k)

    def invocation(self, n):
        callee = n["details"].get("callee")
        builtins = {
            "M:Neo.SmartContract.Framework.Services.Storage.Get(Neo.SmartContract.Framework.Services.StorageContext,System.Byte[])": (BYTESTRING, [("context", CONTEXT), ("key", "byte[]")], "EGet"),
            "M:Neo.SmartContract.Framework.Services.Storage.Put(Neo.SmartContract.Framework.Services.StorageContext,System.Byte[],Neo.SmartContract.Framework.ByteString)": ("void", [("context", CONTEXT), ("key", "byte[]"), ("value", BYTESTRING)], "EPut"),
            "M:Neo.SmartContract.Framework.Native.StdLib.Deserialize(Neo.SmartContract.Framework.ByteString)": ("object", [("source", BYTESTRING)], "EDeserialize"),
            "M:Neo.SmartContract.Framework.Native.StdLib.Serialize(System.Object)": (BYTESTRING, [("source", "object")], "ESerialize"),
            "M:Neo.SmartContract.Framework.ExecutionEngine.Assert(System.Boolean,System.String)": ("void", [("condition", "bool"), ("message", "string")], "SAssert"),
            "M:System.Numerics.BigInteger.Min(System.Numerics.BigInteger,System.Numerics.BigInteger)": (BIG, [("left", BIG), ("right", BIG)], "Min"),
            "M:System.Numerics.BigInteger.Max(System.Numerics.BigInteger,System.Numerics.BigInteger)": (BIG, [("left", BIG), ("right", BIG)], "Max"),
        }
        require(callee in builtins, "Unknown source callee")
        typ, parameters, constructor = builtins[callee]
        children = self.check(n, typ=typ, details={"callee": callee, "virtual": False}, count=len(parameters),
                              meta={"IInvocationOperation.TargetMethod": symbol(callee), "IInvocationOperation.ConstrainedToType": None,
                                    "IInvocationOperation.Instance": None, "IInvocationOperation.IsVirtual": False},
                              collections={"IInvocationOperation.Arguments": collection(list(range(len(parameters))))})
        arguments = []
        for child, (name, arg_type) in zip(children, parameters):
            self.check(child, kind="Argument", count=1,
                       details={"argumentKind": "Explicit", "parameter": name, "inConversion": IDENTITY, "outConversion": IDENTITY},
                       meta={"IArgumentOperation.ArgumentKind": "Explicit", "IArgumentOperation.Parameter": symbol(name),
                             "IArgumentOperation.Value": CHILD, "IArgumentOperation.InConversion": IDENTITY, "IArgumentOperation.OutConversion": IDENTITY})
            require(child["children"][0]["type"] == arg_type, "Argument type/order mismatch")
            arguments.append(self.expr(child["children"][0]))
        if constructor == "SAssert":
            require(arguments[1][0] == "EVal" and arguments[1][1][0] == "VBytes", "Assert message must be a string literal")
            return ["SAssert", arguments[0], arguments[1][1][1]]
        if constructor in ("Min", "Max"):
            return ["EBinary", constructor] + arguments
        return [constructor] + arguments

    def conditional(self, n):
        children = n["children"]
        require(len(children) in (2, 3), "Conditional shape")
        self.check(n, typ=n["type"], count=len(children),
                   meta={"IConditionalOperation.Condition": CHILD, "IConditionalOperation.WhenTrue": CHILD,
                         "IConditionalOperation.WhenFalse": CHILD if len(children) == 3 else None, "IConditionalOperation.IsRef": False})
        require(children[0]["type"] == "bool", "Conditional guard type")
        return self.expr(children[0]), children[1:]

    def block(self, n, *, root=False):
        collection_data = n["semanticCollections"].get("IBlockOperation.Locals", {})
        locals_ = collection_data.get("items")
        require(isinstance(locals_, list), "Missing block local inventory")
        if not root:
            require(locals_ == [], "Nested local scope outside supported dialect")
        declarations = []
        for statement in n["children"]:
            if statement["kind"] == "VariableDeclarationGroup":
                for declaration in statement["children"]:
                    for declarator in declaration["children"]:
                        declarations.append(declarator["details"].get("symbol"))
        require([item.get("id") for item in locals_] == declarations, "Block locals do not match ordered declarations")
        if root:
            for item in locals_:
                name = item["id"]
                require(item == {"id": name, "type": item["type"], "kind": "Local", "name": name, "isStatic": False, "isReadOnly": False}, "Unsupported local metadata")
                require(name not in self.local_ids and item["type"] in (UINT, BYTESTRING, RECORD, BIG), "Unknown or duplicate local type")
                self.local_ids[name] = len(self.local_names)
                self.local_names.append(name)
                self.local_types[name] = item["type"]
        self.check(n, kind="Block", collections={"IBlockOperation.Operations": collection(list(range(len(n["children"])))), "IBlockOperation.Locals": symbols(locals_)})
        result = []
        for child in n["children"]:
            result.extend(self.statement(child))
        return result

    def statement(self, n):
        self.header(n)
        k, ch = n["kind"], n["children"]
        if k == "Block":
            return self.block(n)
        if k == "VariableDeclarationGroup":
            self.check(n, collections={"IVariableDeclarationGroupOperation.Declarations": collection(list(range(len(ch))))})
            result = []
            for declaration in ch:
                ds = declaration["children"]
                self.check(declaration, kind="VariableDeclaration", meta={"IVariableDeclarationOperation.Initializer": None},
                           collections={"IVariableDeclarationOperation.Declarators": collection(list(range(len(ds)))), "IVariableDeclarationOperation.IgnoredDimensions": collection([])})
                for d in ds:
                    name = d["details"].get("symbol")
                    require(name in self.local_ids, "Undeclared local")
                    self.check(d, kind="VariableDeclarator", details={"symbol": name}, count=1,
                               meta={"IVariableDeclaratorOperation.Symbol": symbol(name), "IVariableDeclaratorOperation.Initializer": CHILD},
                               collections={"IVariableDeclaratorOperation.IgnoredArguments": collection([])})
                    initializer = d["children"][0]
                    self.check(initializer, kind="VariableInitializer", count=1,
                               meta={"ISymbolInitializerOperation.Value": CHILD}, collections={"ISymbolInitializerOperation.Locals": symbols([])})
                    value = initializer["children"][0]
                    require(value["type"] == self.local_types[name], "Initializer type mismatch")
                    index = self.local_ids[name]
                    if value["kind"] == "Conditional":
                        condition, branches = self.conditional(value)
                        require(len(branches) == 2 and all(b["type"] == value["type"] for b in branches), "Conditional initializer types")
                        result.append(["SIf", condition, [["SLet", index, self.expr(branches[0])]], [["SLet", index, self.expr(branches[1])]]])
                    else:
                        result.append(["SLet", index, self.expr(value)])
            return result
        if k == "Conditional":
            require(n["type"] is None, "Statement conditional type")
            condition, branches = self.conditional(n)
            return [["SIf", condition, self.statement(branches[0]), self.statement(branches[1]) if len(branches) == 2 else []]]
        if k == "ExpressionStatement":
            self.check(n, count=1, meta={"IExpressionStatementOperation.Operation": CHILD})
            value = ch[0]
            if value["kind"] in ("SimpleAssignment", "CompoundAssignment"):
                self.header(value)
                require(len(value["children"]) == 2, "Assignment arity")
                target, rhs = value["children"]
                require(target["kind"] == "FieldReference" and target["type"] == rhs["type"] == value["type"], "Assignment type/target")
                field = self.expr(target)
                require(field[0] == "EField" and target["children"][0]["type"] == RECORD, "Writable source record field required")
                meta = {"IAssignmentOperation.Target": CHILD, "IAssignmentOperation.Value": CHILD}
                details = {}
                expression = self.expr(rhs)
                if value["kind"] == "SimpleAssignment":
                    meta["ISimpleAssignmentOperation.IsRef"] = False
                else:
                    method = "M:System.Numerics.BigInteger.op_Addition(System.Numerics.BigInteger,System.Numerics.BigInteger)"
                    require(value["type"] == BIG and field[1][0] == "ELocal", "Compound assignment needs pure local receiver and BigInteger")
                    details = {"operator": "Add", "checked": False, "operatorMethod": method}
                    meta.update({"ICompoundAssignmentOperation.InConversion": IDENTITY, "ICompoundAssignmentOperation.OutConversion": IDENTITY,
                                 "ICompoundAssignmentOperation.OperatorKind": "Add", "ICompoundAssignmentOperation.IsLifted": False,
                                 "ICompoundAssignmentOperation.IsChecked": False, "ICompoundAssignmentOperation.OperatorMethod": symbol(method),
                                 "ICompoundAssignmentOperation.ConstrainedToType": None})
                    expression = ["EBinary", "Add", field, expression]
                self.check(value, typ=value["type"], details=details, meta=meta, count=2)
                return [["SSetField", field[1], field[2], expression]]
            expression = self.expr(value)
            require(value["type"] == "void", "Unused value statement unsupported")
            return [expression if expression[0] == "SAssert" else ["SExpr", expression]]
        if k == "Return":
            self.check(n, count=1, meta={"IReturnOperation.ReturnedValue": CHILD})
            require(ch[0]["type"] == BIG, "Return type mismatch")
            return [["SReturn", self.expr(ch[0])]]
        raise SourceProjectionError("Unsupported source statement: " + k)

    def bind_layout(self):
        types = [t for t in self.source["types"] if t["id"] == RECORD_ID]
        require(len(types) == 1, "Unique source record required")
        record = types[0]
        require(record["kind"] == "Class" and record["baseType"] == "object" and record["isValueType"] is False, "Record representation changed")
        fields = [dict(id="F:SmartAccount.SmartAccount.TransactionReimbursement." + name, name=name, type=typ,
                       isStatic=False, isReadOnly=False, constant=None) for name, typ in [("TransactionHash", UINT), ("Reserved", BIG)]]
        require(same(record["fields"], fields), "Record field order/type changed")
        require(record["synthesizedMembers"] == [{"id": CTOR, "kind": "Method", "issue": "Compiler-synthesized member has no separately exported source body"}], "Record constructor is not the supported synthesized default")
        require(not any(m["id"].startswith(CTOR) for m in self.source["methods"]), "Explicit constructor body needs proof")
        for i, f in enumerate(fields):
            self.field_table[f["id"]] = (RECORD, i, f["type"])
        # Runtime.Transaction is a framework intrinsic, not a repository record.
        # These positions belong to the named Neo framework dialect contract;
        # no missing framework declaration is presented as exported source.
        transaction_fields = [("Hash", UINT), ("Version", "byte"), ("Nonce", "uint"),
                              ("Sender", FRAMEWORK + "UInt160"), ("SystemFee", "long"),
                              ("NetworkFee", "long"), ("ValidUntilBlock", "uint"), ("Script", BYTESTRING)]
        for i, (name, typ) in enumerate(transaction_fields):
            self.field_table["F:Neo.SmartContract.Framework.Services.Transaction." + name] = (TRANSACTION, i, typ)
        prefix = [f for t in self.source["types"] for f in t["fields"] if f["id"] == PREFIX]
        require(prefix and all(f == dict(id=PREFIX, name="Prefix_TransactionReimbursement", type="byte[]", isStatic=True, isReadOnly=True, constant=None) for f in prefix), "Prefix field identity/type changed")
        wanted = {PREFIX, *(f["id"] for f in fields)}
        for initializer in self.source["initializers"]:
            for op in initializer["operations"]:
                ids = op.get("semanticCollections", {}).get("IFieldInitializerOperation.InitializedFields", {}).get("items", [])
                if any(item.get("id") in wanted for item in ids):
                    require(initializer["exportIssue"] is None and len(initializer["operations"]) == 1 and len(ids) == 1, "Ambiguous field initializer")
                    identifier = ids[0]["id"]
                    require(identifier not in self.initializers, "Duplicate field initializer")
                    expected_field = prefix[0] if identifier == PREFIX else next(f for f in fields if f["id"] == identifier)
                    expected_symbol = {k: expected_field[k] for k in ("id", "type", "name", "isStatic", "isReadOnly")}
                    expected_symbol["kind"] = "Field"
                    self.check(op, kind="FieldInitializer", count=1, meta={"ISymbolInitializerOperation.Value": CHILD},
                               collections={"ISymbolInitializerOperation.Locals": symbols([]), "IFieldInitializerOperation.InitializedFields": symbols([expected_symbol])})
                    self.initializers[identifier] = op["children"][0]
        require(set(self.initializers) == wanted, "Missing bound field initializer")
        key = self.initializers[PREFIX]
        self.check(key, kind="ArrayCreation", typ="byte[]", count=2, meta={"IArrayCreationOperation.Initializer": CHILD},
                   collections={"IArrayCreationOperation.DimensionSizes": collection([0])})
        dim, init = key["children"]
        require(dim["type"] == "int", "Array dimension type")
        dimension = self.literal(dim)
        self.check(init, kind="ArrayInitializer", collections={"IArrayInitializerOperation.ElementValues": collection(list(range(len(init["children"]))))})
        require(all(c["type"] == "byte" for c in init["children"]), "Byte array element types")
        values = [self.expr(c) for c in init["children"]]
        require(dimension == integer(len(values)) and all(v[0] == "EVal" and v[1][0] == "VInt" and 0 <= v[1][1] < 256 for v in values), "Prefix dimension/value mismatch")
        self.static_key = [v[1][1] for v in values]
        require(self.static_key == [33], "Source key differs from declared EKey effect contract")
        require(all(self.initializers[f["id"]]["type"] == f["type"] for f in fields), "Record field initializer types")
        self.record_values = [self.expr(self.initializers[f["id"]]) for f in fields]
        return fields

    def project(self):
        layout = self.bind_layout()
        methods = [m for m in self.source["methods"] if m["id"] == METHOD]
        require(len(methods) == 1, "Unique source helper required")
        method = methods[0]
        require(method["exportIssue"] is None and method["returnType"] == BIG and method["parameters"] == [{"name": "requested", "type": BIG, "ordinal": 0, "refKind": "None"}], "Source helper signature changed")
        require(len(method["operations"]) == 1, "Source method body missing")
        body = method["operations"][0]
        self.check(body, kind="MethodBodyOperation", count=1,
                   meta={"IMethodBodyBaseOperation.BlockBody": CHILD, "IMethodBodyBaseOperation.ExpressionBody": None})
        statements = self.block(body["children"][0], root=True)
        require(len(self.local_names) == 8, "Helper frame local count changed")
        result = dict(schema="neoos-aa-cap-source-program/v1", method=METHOD, statements=statements,
                    locals=self.local_names, localTypes=self.local_types, staticKey=self.static_key,
                    recordLayout=layout, recordInitializers=self.record_values,
                    dialect="Neo framework immutable-byte equality and ordered scalar record intrinsics; unbounded BigInteger",
                    frameworkContracts={
                        "transactionFields": {"Hash": 0, "SystemFee": 4, "NetworkFee": 5},
                        "transactionProjection": "Named external Neo transaction intrinsic; framework layout is not exported repository source",
                        "referenceEquality": "Immutable ByteString/UInt256 byte-value equality and null tests in the Neo contract dialect, not CLR object identity",
                        "recordRepresentation": "Source class ordered fields mapped to Neo Array; well-formed deserialized Array/Struct is an explicit precondition",
                        "storageKey": "Source readonly byte array denotes EKey Buffer [33]; initialization-to-static-slot correspondence requires separate evidence",
                        "codec": "StdLib scalar-record serialize/deserialize effect contracts; no native implementation theorem",
                        "zeroUInt256": "Framework UInt256.Zero denotes 32 zero bytes"},
                    sourceTreeSha256=hashlib.sha256(json.dumps(
                        {"method": method, "recordLayout": layout, "initializers": self.initializers},
                        sort_keys=True, separators=(",", ":")).encode()).hexdigest())
        result["sourceProjectionSha256"] = hashlib.sha256(json.dumps(result, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        return result


def project_method(inventory):
    try:
        return Projector(inventory).project()
    except (KeyError, TypeError, IndexError) as error:
        raise SourceProjectionError("Malformed typed source inventory: " + str(error)) from error


def render_program(projection):
    """Render the source-only JSON IR as a closed Coq list Stmt term."""
    def render(value):
        if isinstance(value, int):
            return f"({value})%Z"
        require(isinstance(value, list) and value, "Invalid IR term")
        tag, *args = value
        if tag in ("ETransaction", "EContext", "EKey", "VNull", "VContext"):
            require(not args, "Invalid nullary IR constructor")
            return tag
        if tag in ("ELocal", "EArg", "VRef"):
            return f"({tag} {args[0]}%nat)"
        if tag == "VInt":
            return f"(VInt ({args[0]})%Z)"
        if tag == "VBool":
            return f"(VBool {'true' if args[0] else 'false'})"
        if tag == "VBytes":
            return "(VBytes [" + "; ".join(f"{x}%nat" for x in args[0]) + "])"
        if tag in ("ENew", "VWire"):
            return f"({tag} {args[0]} [" + "; ".join(render(x) for x in args[1]) + "])"
        if tag == "EBinary":
            return f"(EBinary {args[0]} {render(args[1])} {render(args[2])})"
        if tag in ("EField", "SLet"):
            return (f"(EField {render(args[0])} {args[1]}%nat)" if tag == "EField"
                    else f"(SLet {args[0]}%nat {render(args[1])})")
        if tag == "SSetField":
            return f"(SSetField {render(args[0])} {args[1]}%nat {render(args[2])})"
        if tag == "SIf":
            return f"(SIf {render(args[0])} {render_list(args[1])} {render_list(args[2])})"
        if tag == "SAssert":
            return f"(SAssert {render(args[0])} [" + "; ".join(f"{x}%nat" for x in args[1]) + "])"
        require(tag in ("EVal", "EEq", "ENeq", "EGT", "ELE", "EGet", "EDeserialize", "ESerialize", "EPut", "SExpr", "SReturn"), "Unknown IR constructor")
        return "(" + tag + " " + " ".join(render(x) for x in args) + ")"

    def render_list(items):
        return "[" + ";\n ".join(render(x) for x in items) + "]"

    return render_list(projection["statements"])

#!/usr/bin/env python3
"""Kernel-check an actual NEF arithmetic region against a typed source subtree.

The source frontend/debug mapping and runtime/reference-semantics connection
remain TCB obligations. This gate never reports full implementation refinement.
"""
import argparse
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
MODULES = ("IntegerSemantics.v", "CapArithmetic.v", "ArithmeticVm.v")
METHOD = "SmartAccount.SmartAccount.CapReimbursementToActualCost(System.Numerics.BigInteger)"
BIG = "global::System.Numerics.BigInteger"
PAIR = "(System.Numerics.BigInteger,System.Numerics.BigInteger)"
IDENTITY_CONVERSION = dict(Exists=True, IsIdentity=True, IsImplicit=True,
                          IsNullable=False, IsNumeric=False, IsReference=False,
                          IsUserDefined=False, method=None)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def walk(node):
    yield node
    for child in node.get("children", []):
        yield from walk(child)


def metadata_supported(node):
    """Check duplicate semantic flags; accept only known exported interfaces."""
    kind, details = node["kind"], node.get("details", {})
    known_prefix = {"Binary": ("IBinaryOperation",), "Conversion": ("IConversionOperation",),
        "Invocation": ("IInvocationOperation",), "Argument": ("IArgumentOperation",),
        "LocalReference": ("ILocalReferenceOperation",),
        "ParameterReference": ("IParameterReferenceOperation",),
        "FieldReference": ("IMemberReferenceOperation", "IFieldReferenceOperation"),
        "Literal": ()}.get(kind, ())
    mirrored_children = {"LeftOperand", "RightOperand", "Operand", "Value", "Instance"}
    symbols = {"OperatorMethod": details.get("operatorMethod", details.get("conversion", {}).get("method")),
        "TargetMethod": details.get("callee"), "Parameter": details.get("parameter", details.get("symbol")),
        "Local": details.get("symbol"), "Field": details.get("symbol"), "Member": details.get("symbol")}
    flags = {"OperatorKind": details.get("operator"), "IsLifted": details.get("lifted"),
        "IsChecked": details.get("checked"), "IsVirtual": details.get("virtual"),
        "IsTryCast": details.get("tryCast"), "IsCompareText": False, "IsDeclaration": False,
        "ConstrainedToType": None, "ArgumentKind": details.get("argumentKind"),
        "Conversion": details.get("conversion"), "InConversion": details.get("inConversion"),
        "OutConversion": details.get("outConversion")}
    for name, value in node.get("boundMetadata", {}).items():
        prefix, field = name.split(".", 1)
        require(prefix in known_prefix, "Unsupported source metadata interface: " + name)
        if field in symbols:
            require(value == {"id": symbols[field], "type": None}, "Contradictory source symbol: " + name)
        elif field in flags:
            require(value == flags[field], "Unsupported/contradictory semantic flag: " + name)
        elif field in mirrored_children:
            require(value == "Operation child; see ordered children" or
                    (kind == "Invocation" and field == "Instance" and value is None),
                    "Unexpected hidden operation: " + name)
        else:
            raise ValueError("Unsupported source metadata: " + name)
    for name in node.get("unexportedMetadata", []):
        # Invocation arguments are present as fully validated ordered children.
        require(kind == "Invocation" and name.startswith("IInvocationOperation.Arguments:"),
                "Unexported semantic metadata: " + name)


def expression_from_operation(node, environment):
    kind, children, details = node["kind"], node.get("children", []), node.get("details", {})
    metadata_supported(node)
    if kind == "Literal":
        require(node.get("type") == "int" and not children and not details, "Unsupported source literal")
        value = node.get("constant", {}).get("value", {})
        require(value.get("runtimeType") == "System.Int32", "Literal runtime type changed")
        integer = int(value["value"])
        require(-(2 ** 31) <= integer < 2 ** 31, "Int32 literal overflow")
        return ("constant", integer)
    require(node.get("type") == BIG, "Unsupported arithmetic source type: " + str(node.get("type")))
    if kind == "Conversion":
        expected = dict(Exists=True, IsIdentity=False, IsImplicit=True, IsNullable=False,
                        IsNumeric=False, IsReference=False, IsUserDefined=True,
                        method="M:System.Numerics.BigInteger.op_Implicit(System.Int32)~System.Numerics.BigInteger")
        require(details == {"checked": False, "tryCast": False, "conversion": expected}
                and len(children) == 1 and children[0]["kind"] == "Literal", "Unsupported source conversion")
        return expression_from_operation(children[0], environment)
    if kind == "LocalReference":
        require(set(details) == {"symbol"} and not children and details["symbol"] in environment,
                "Unknown arithmetic source local")
        return environment[details["symbol"]]
    if kind == "ParameterReference":
        require(details == {"symbol": "requested", "ordinal": 0} and not children,
                "Unknown source parameter")
        return ("input", "Requested")
    if kind == "FieldReference":
        require(details == {"symbol": "F:SmartAccount.SmartAccount.TransactionReimbursement.Reserved"}
                and len(children) == 1, "Unsupported source field")
        receiver = children[0]
        require(receiver["kind"] == "LocalReference" and receiver["details"] == {"symbol": "budget"}
                and receiver["type"] == "global::SmartAccount.SmartAccount.TransactionReimbursement"
                and not receiver["children"], "Wrong reserved-field receiver")
        metadata_supported(receiver)
        return ("input", "Reserved")
    if kind == "Binary":
        operators = {"Add": ("Add", "op_Addition"), "Subtract": ("Sub", "op_Subtraction"),
                     "Multiply": ("Mul", "op_Multiply")}
        require(details.get("operator") in operators, "Unsupported arithmetic operator")
        op, method = operators[details["operator"]]
        require(details == {"operator": details["operator"], "checked": False, "lifted": False,
                           "operatorMethod": "M:System.Numerics.BigInteger." + method + PAIR}
                and len(children) == 2, "Unsupported binary source semantics")
        return ("binary", op, *(expression_from_operation(c, environment) for c in children))
    if kind == "Invocation":
        names = {"M:System.Numerics.BigInteger." + name + PAIR: name for name in ("Min", "Max")}
        require(details.get("callee") in names and details == {"callee": details["callee"], "virtual": False}
                and len(children) == 2, "Unsupported arithmetic source invocation")
        operands = []
        for child, parameter in zip(children, ("left", "right")):
            metadata_supported(child)
            require(child["kind"] == "Argument" and len(child["children"]) == 1 and child.get("type") is None,
                    "Invalid arithmetic source argument")
            expected = {"argumentKind": "Explicit", "parameter": parameter,
                        "inConversion": IDENTITY_CONVERSION, "outConversion": IDENTITY_CONVERSION}
            require(child["details"] == expected, "Unsupported source argument conversion/order")
            operands.append(expression_from_operation(child["children"][0], environment))
        return ("binary", names[details["callee"]], *operands)
    raise ValueError("Unsupported arithmetic source operation: " + kind)


def coq_expression(expression):
    if expression[0] == "constant":
        return "(Constant (" + str(expression[1]) + "))"
    if expression[0] == "input":
        return "(Read " + expression[1] + ")"
    return "(Apply " + expression[1] + " " + coq_expression(expression[2]) + " " + coq_expression(expression[3]) + ")"


def declaration_wrapper(node, kind, symbol=None):
    require(node["kind"] == kind and node.get("type") is None and len(node["children"]) == 1,
            "Unsupported declaration wrapper/extra children: " + kind)
    expected_details = {"symbol": symbol} if kind == "VariableDeclarator" else {}
    require(node.get("details", {}) == expected_details, "Unsupported declaration wrapper details")
    expected_metadata = {"VariableDeclarationGroup": {},
        "VariableDeclaration": {"IVariableDeclarationOperation.Initializer": None},
        "VariableDeclarator": {"IVariableDeclaratorOperation.Symbol": {"id": symbol, "type": None},
            "IVariableDeclaratorOperation.Initializer": "Operation child; see ordered children"},
        "VariableInitializer": {"ISymbolInitializerOperation.Value": "Operation child; see ordered children"}}[kind]
    require(node.get("boundMetadata", {}) == expected_metadata, "Unsupported declaration wrapper metadata")
    supported_collections = {"VariableDeclarationGroup": ["IVariableDeclarationGroupOperation.Declarations"],
        "VariableDeclaration": ["IVariableDeclarationOperation.Declarators", "IVariableDeclarationOperation.IgnoredDimensions"],
        "VariableDeclarator": ["IVariableDeclaratorOperation.IgnoredArguments"],
        "VariableInitializer": ["ISymbolInitializerOperation.Locals"]}[kind]
    require(all(item.split(":", 1)[0] in supported_collections for item in node.get("unexportedMetadata", [])),
            "Unsupported declaration collection metadata")
    return node["children"][0]


def source_region(inventory):
    methods = [m for m in inventory["source"]["methods"] if m["id"] == "M:" + METHOD]
    require(len(methods) == 1, "Missing/duplicate exact source method")
    method = methods[0]
    require(method["returnType"] == BIG and method["parameters"] == [
        {"name": "requested", "type": BIG, "ordinal": 0, "refKind": "None"}], "Source method signature changed")
    roots = method["operations"]
    require(len(roots) == 1 and roots[0]["kind"] == "MethodBodyOperation" and len(roots[0]["children"]) == 1,
            "Unsupported source method body")
    block = roots[0]["children"][0]
    require(block["kind"] == "Block", "Unsupported source body")
    declarations = []
    for index, group in enumerate(block["children"]):
        nodes = [n for n in walk(group) if n["kind"] == "VariableDeclarator" and
                 n.get("details", {}).get("symbol") in ("estimationFlag", "cap", "settled")]
        if nodes:
            require(group["kind"] == "VariableDeclarationGroup" and len(nodes) == 1,
                    "Unsupported source declaration/assignment")
            declaration = nodes[0]
            declared = declaration_wrapper(group, "VariableDeclarationGroup")
            selected = declaration_wrapper(declared, "VariableDeclaration")
            require(selected is declaration, "Unexpected source declaration sibling")
            initialized = declaration_wrapper(selected, "VariableDeclarator", declaration["details"]["symbol"])
            expression = declaration_wrapper(initialized, "VariableInitializer")
            declarations.append((index, declaration, expression))
    require([d[1]["details"]["symbol"] for d in declarations] == ["estimationFlag", "cap", "settled"]
            and [d[0] for d in declarations] == list(range(declarations[0][0], declarations[0][0] + 3)),
            "Source region declarations are not exactly consecutive")
    environment = {"actualCost": ("input", "Cost")}
    for _, declaration, expression in declarations:
        environment[declaration["details"]["symbol"]] = expression_from_operation(expression, environment)
    return method, declarations, environment["settled"]


def selected_region(inventory, declarations, actual_instructions=None):
    focuses = [m for m in inventory["sourceMap"]["focusedMethods"] if m["id"] == METHOD]
    require(len(focuses) == 1, "Missing/duplicate debug locator")
    focus = focuses[0]
    expected_locals = ["transactionHash,Hash256,0", "data,ByteArray,1", "budget,Any,2", "actualCost,Integer,3",
                       "estimationFlag,Integer,4", "cap,Integer,5", "settled,Integer,6",
                       # The VM-integer-range margin guard declares a further local after
                       # `settled`. It is not read by the certified arithmetic region, but
                       # the debug frame must match the actual 8-slot INITSLOT.
                       "vmMax,Integer,7"]
    require(focus["source"]["variables"] == expected_locals and
            focus["source"]["params"] == ["requested,Integer,0"], "Unsupported region input/locals mapping")
    documents = inventory["sourceMap"]["debug"]["documents"]
    filename = Path(declarations[0][1]["location"]["path"]).name
    document_ids = [i for i, name in enumerate(documents) if Path(name).name == filename]
    require(len(document_ids) == 1, "Ambiguous source document locator")
    document = document_ids[0]
    lines = [d[1]["location"]["startLine"] for d in declarations]
    require(all(d[1]["location"]["endLine"] == line for d, line in zip(declarations, lines)),
            "Unsupported multiline arithmetic declarations")
    points = []
    for point in focus["source"]["sequence-points"]:
        match = re.fullmatch(r"(\d+)\[(\d+)\](\d+):(\d+)-(\d+):(\d+)", point)
        require(match is not None, "Malformed sequence point")
        pc, doc, begin, _, end, _ = map(int, match.groups())
        if doc == document and begin in lines and end in lines:
            points.append(pc)
    require(points, "No arithmetic source sequence points")
    start, end = min(points), max(points) + 1
    method_start, method_end = map(int, focus["range"].split("-"))
    require(method_start <= start < end <= method_end and end - start == 22,
            "Unsupported actual arithmetic region boundaries")
    script = bytes.fromhex(inventory["nef"]["scriptHex"])
    require(end <= len(script), "Region outside actual script")
    if actual_instructions is None:
        spec = importlib.util.spec_from_file_location("cap_independent_decoder", ROOT / "nef_decode.py")
        decoder = importlib.util.module_from_spec(spec); spec.loader.exec_module(decoder)
        actual_instructions = decoder.decode_script(script, len(inventory["nef"]["tokens"]))
    offsets = {instruction["offset"] for instruction in actual_instructions}
    require(start in offsets and (end in offsets or end == len(script)), "Region is not on actual instruction boundaries")
    covered = [i for i in actual_instructions if start <= i["offset"] < end]
    require([i["offset"] for i in covered] == list(range(start, end)) and
            all(i["size"] == 1 for i in covered), "Region includes data payloads/unsupported operand widths")
    return start, end, script[start:end]


def generated_proof(program, expression, recipe=None):
    vector = ";".join(str(byte) + "%nat" for byte in program)
    tactic = (recipe if recipe is not None else (ROOT / "proof_tactic.txt").read_text()).replace("PROGRAM_LENGTH", str(len(program)))
    return ("From Coq Require Import ZArith List Bool Lia.\n"
        "Require Import IntegerSemantics CapArithmetic ArithmeticVm OrdinarySponsorship.\n"
        "Import ListNotations.\nOpen Scope Z_scope.\n"
        "Definition actual_bytes : list nat := [" + vector + "].\n"
        "Definition actual_source : Expression := " + coq_expression(expression) + ".\n"
        "Theorem actual_semantics : preserves_expression actual_bytes actual_source.\nProof.\n" + tactic + "\nQed.\n"
        "Definition actual_certificate : Certificate actual_source :=\n"
        "  mkCertificate actual_source actual_bytes actual_semantics.\n"
        "Theorem actual_certificate_accepted : check_certificate actual_source actual_bytes actual_certificate = true.\n"
        "Proof. vm_compute. reflexivity. Qed.\n"
        "Theorem source_ir_refines_protocol : forall cost requested reserved,\n"
        "  cap_domain cost requested reserved -> source_eval actual_source cost requested reserved =\n"
        "    OrdinarySponsorship.charge cost requested reserved.\nProof.\n"
        " intros cost requested reserved [Hc [Hq Hr]].\n"
        " cbn [actual_source source_eval binary_value].\n"
        " apply OS_015_branch_free_cap_matches_abstract_charge; lia.\nQed.\n"
        "Print Assumptions actual_semantics.\nPrint Assumptions actual_certificate_accepted.\n"
        "Print Assumptions source_ir_refines_protocol.\n")


def command(args, directory, logfile, expect_success=True):
    completed = subprocess.run(args, cwd=directory, capture_output=True, text=True, timeout=600)
    output = completed.stdout + completed.stderr
    Path(logfile).write_text(output)
    if expect_success:
        require(completed.returncode == 0, "Proof tool failed: " + str(logfile))
    return completed.returncode, output


def declarations(source):
    return re.findall(r"^(?:Lemma|Theorem|Example)\s+(\w+)\s*:", source, re.MULTILINE)


def prepare_models(output_dir):
    output_dir = Path(output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    coqc = shutil.which("coqc")
    require(coqc, "Missing coqc: no simulated kernel success")
    files = [ROOT / "coq" / name for name in MODULES] + [REPO / "formal/coq/OrdinarySponsorship.v"]
    names, hashes = [], {}
    for path in files:
        raw = path.read_bytes()
        hashes[str(path.relative_to(REPO).as_posix())] = hashlib.sha256(raw).hexdigest()
        source = raw.decode("utf-8")
        require(not re.search(r"\b(?:Axiom|Admitted|admit|Abort|Parameter)\b", source), "Untrusted declaration: " + path.name)
        target = output_dir / path.name
        target.write_bytes(raw)
        _, text = command([coqc, "-q", path.name], output_dir, output_dir / (path.stem + ".log"))
        closed = declarations(source)
        require(text.count("Closed under the global context") == len(closed) and "Axioms:" not in text,
                "Proof assumptions audit failed: " + path.name)
        names.extend(closed)
    require(all(digest(REPO / name) == expected for name, expected in hashes.items()), "Model changed during compilation")
    return output_dir, coqc, names, hashes


def run_model_proofs(output_dir):
    directory, coqc, names, hashes = prepare_models(output_dir)
    coqchk = shutil.which("coqchk")
    require(coqchk, "Missing coqchk")
    command([coqchk, "-silent", *(Path(m).stem for m in MODULES), "OrdinarySponsorship"], directory, directory / "coqchk.log")
    return {"kernelChecked": True, "closedDeclarations": names, "modelSha256": hashes,
            "fullImplementationVerified": False}


def certify(directory, coqc, program, expression, filename="CapArtifact.v", expect_success=True, recipe=None):
    source = generated_proof(program, expression, recipe)
    target = directory / filename
    target.write_text(source)
    require(not re.search(r"\b(?:Axiom|Admitted|admit|Abort|Parameter)\b", source), "Generated proof contains admission")
    rc, text = command([coqc, "-q", filename], directory, directory / (target.stem + ".log"), expect_success)
    if expect_success:
        require(text.count("Closed under the global context") == len(declarations(source)) and "Axioms:" not in text,
                "Generated certificate assumptions audit failed")
    return target, rc, text


def run_proofs(inventory, output_dir):
    tool_paths = [Path(__file__), ROOT / "proof_tactic.txt", ROOT / "verify.py", ROOT / "nef_decode.py"]
    tools_before = {path.relative_to(REPO).as_posix(): digest(path) for path in tool_paths}
    recipe = (ROOT / "proof_tactic.txt").read_bytes()
    require(hashlib.sha256(recipe).hexdigest() == tools_before["formal/refinement/proof_tactic.txt"], "Proof recipe read drift")
    # Actual inputs and raw NEF are rechecked here as well as by the outer gate.
    for filename, expected in inventory["inputs"].items():
        require(digest(filename) == expected, "Inventory input drift: " + filename)
    nef_paths = [Path(p) for p, h in inventory["inputs"].items()
                 if p.endswith("SmartAccountV3.nef") and h == inventory["nef"]["sha256"]]
    require(len(nef_paths) == 1, "Ambiguous actual NEF input")
    spec = importlib.util.spec_from_file_location("sa_refinement_binding", ROOT / "verify.py")
    binding = importlib.util.module_from_spec(spec); spec.loader.exec_module(binding)
    decoded = binding.decode_nef(nef_paths[0].read_bytes())
    require(decoded["script"].hex() == inventory["nef"]["scriptHex"] and
            hashlib.sha256(decoded["script"]).hexdigest() == inventory["nef"]["scriptSha256"],
            "Raw script is not the actual NEF script")
    method, source_declarations, expression = source_region(inventory)
    actual_instructions = binding._DECODER.decode_script(decoded["script"], len(decoded["tokens"]))
    start, end, program = selected_region(inventory, source_declarations, actual_instructions)
    directory, coqc, names, hashes = prepare_models(output_dir)
    target, _, _ = certify(directory, coqc, program, expression, recipe=recipe.decode("utf-8"))
    names += declarations(target.read_text())
    coqchk = shutil.which("coqchk"); require(coqchk, "Missing coqchk")
    command([coqchk, "-silent", *(Path(m).stem for m in MODULES), "OrdinarySponsorship", "CapArtifact"],
            directory, directory / "coqchk.log")
    _, version = command([coqc, "--version"], directory, directory / "coqc-version.log")
    require(digest(nef_paths[0]) == inventory["nef"]["sha256"], "NEF changed during proof")
    require(all(digest(REPO / name) == expected for name, expected in hashes.items()), "Model changed during proof")
    require(all(digest(REPO / name) == expected for name, expected in tools_before.items()), "Proof tool changed during proof")
    require(all(digest(filename) == expected for filename, expected in inventory["inputs"].items()), "Input changed during proof")
    return {"schema": "neoos-sa-arithmetic-refinement-proof/v1", "scope": "arithmetic-region",
        "kernelChecked": True, "fullImplementationVerified": False, "sourceMethod": method["id"],
        "nefSha256": inventory["nef"]["sha256"], "scriptSha256": inventory["nef"]["scriptSha256"],
        "verifiedRegions": [{"start": start, "endExclusive": end, "instructionOffsets": list(range(start, end)),
                             "instructionHex": program.hex(), "entryStack": "empty", "outputLocal": 6}],
        "sourceIR": expression, "sourceIRCoq": coq_expression(expression),
        "sourceDeclarations": [d[1]["location"] for d in source_declarations],
        "modelSha256": hashes, "generatedProofSha256": {target.name: digest(target)},
        "proofRecipeSha256": hashlib.sha256(recipe).hexdigest(), "proverSha256": tools_before["formal/refinement/prove.py"],
        "toolInputSha256": tools_before,
        "closedDeclarations": names, "toolVersion": version.splitlines()[0], "kernelRecheck": "coqchk -silent",
        "preconditions": ["0 <= cost < 2^255", "0 < requested < 2^255", "0 <= reserved < 2^255",
            "arg0=Integer(requested), local3=Integer(cost), local2=Array/Struct[hash,Integer(reserved)]",
            "seven existing locals, empty evaluation stack at the arithmetic cutpoint",
            "sufficient ApplicationEngine gas and stack/item resources; resource accounting external"],
        "observations": ["pc reaches exact end, stack empty, local6 equals generated source IR and existing protocol charge",
            "arguments unchanged; locals0..3 unchanged; locals length remains seven"],
        "referenceSemantics": "gas-erased straight-line Integer-typed opcode semantics with bounded Integer/stack/index faults",
        "unproved": ["caller establishes cutpoint/domain", "source parsing/Roslyn extraction/debug mapping correctness",
            "Neo.VM.dll implements reference opcode semantics", "non-Integer numeric coercions and heap/reference identity",
            "instruction gas/pricing and resource bounds",
            "load/deserialize/transaction reset", "assert settled>0", "reserved+=settled/store/rollback",
            "remaining entrypoints and external contracts"],
        "outsideRegionCounterexample": "cost=0,reserved=2^255-1,requested=1: the charge region succeeds; the later headroom assertion at pc13806 aborts before the reservation ADD at pc13812",
        "tcb": ["Coq kernel/toolchain", "validated Roslyn typed-subtree projection and debug/local binding",
                "NEF container/input binding parser", "reference semantics to pinned NeoVM correspondence remains external"]}


def run_semantic_controls(output_dir):
    fixture_raw = (ROOT / "fixtures/cap-region.json").read_bytes()
    fixture = json.loads(fixture_raw)
    program = bytes.fromhex(fixture["hex"])
    environment = {"actualCost": ("input", "Cost")}
    for name, operation in fixture["operations"]:
        environment[name] = expression_from_operation(operation, environment)
    expression = environment["settled"]
    directory, coqc, _, _ = prepare_models(output_dir)
    certify(directory, coqc, program, expression)
    controls = {}
    def rejected_certificate(name, bytes_, ir):
        path, rc, text = certify(directory, coqc, bytes_, ir, name.replace("-", "_") + ".v", False)
        definitions = re.split(r"^Theorem ", path.read_text(), maxsplit=1, flags=re.MULTILINE)[0]
        definition_file = directory / (path.stem + "_definitions.v"); definition_file.write_text(definitions)
        command([coqc, "-q", definition_file.name], directory, directory / (path.stem + "-definitions.log"))
        require(rc != 0 and "Error:" in text and "Syntax error" not in text, "Semantic certificate mutant escaped: " + name)
        controls[name] = True
    for name, index, replacement in (("min-to-max", 3, 186), ("remaining-sub-to-add", 11, 158),
                                    ("estimation-one-to-zero", 0, 16)):
        mutant = bytearray(program); mutant[index] = replacement
        rejected_certificate(name, bytes(mutant), expression)
    rejected_certificate("source-min-to-max", program, ("binary", "Max", expression[2], expression[3]))
    def replace_ir(node, old, new):
        if node == old:
            return new
        if node[0] == "binary":
            return (node[0], node[1], replace_ir(node[2], old, new), replace_ir(node[3], old, new))
        return node
    rejected_certificate("source-sub-to-add", program, replace_ir(expression,
        ("binary", "Sub", ("input", "Cost"), ("input", "Reserved")),
        ("binary", "Add", ("input", "Cost"), ("input", "Reserved"))))
    rejected_certificate("source-constant-one-to-zero", program,
                         replace_ir(expression, ("constant", 1), ("constant", 0)))
    # The return value can be correct while another local is silently changed.
    # The certificate's frame condition rejects this well-formed bytecode.
    rejected_certificate("unexpected-frame-write", program + bytes([17, 112]), expression)
    for name, filename, old, new in (
        ("unchecked-overflow", "IntegerSemantics.v", "if integer_fitsb z then Some z else None", "Some z"),
        ("wrong-operand-order", "ArithmeticVm.v", "checked_binary operation lhs rhs", "checked_binary operation rhs lhs")):
        separate = directory / name; separate.mkdir()
        for model in (*MODULES, "OrdinarySponsorship.v"):
            shutil.copyfile(directory / model, separate / model)
        path = separate / filename; source = path.read_text()
        require(source.count(old) == 1, "Ambiguous semantic mutation")
        path.write_text(source.replace(old, new))
        prefix = re.split(r"^(?:Lemma|Theorem|Example) ", path.read_text(), maxsplit=1, flags=re.MULTILINE)[0]
        (separate / "Definitions.v").write_text(prefix)
        # Imports come from the already independently compiled base directory.
        if filename == "IntegerSemantics.v":
            command([coqc, "-q", "Definitions.v"], separate, separate / "definitions.log")
        if filename == "ArithmeticVm.v":
            for dependency in ("IntegerSemantics", "CapArithmetic"):
                command([coqc, "-q", dependency + ".v"], separate, separate / (dependency + ".log"))
            command([coqc, "-q", "Definitions.v"], separate, separate / "definitions.log")
        rc, text = command([coqc, "-q", filename], separate, separate / "mutation.log", False)
        require(rc != 0 and "Error:" in text and "Syntax error" not in text, "Semantic model mutant escaped: " + name)
        controls[name] = True
    require((ROOT / "fixtures/cap-region.json").read_bytes() == fixture_raw, "Semantic fixture changed during controls")
    return {"definitionsCompiled": True, "rejected": list(controls),
            "fixtureSha256": hashlib.sha256(fixture_raw).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--json-report", type=Path, required=True)
    args = parser.parse_args()
    report = {"scope": "arithmetic-region", "kernelChecked": False, "fullImplementationVerified": False}
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    args.json_report.write_text(json.dumps(report) + "\n")
    try:
        report = run_proofs(json.loads(args.inventory.read_text()), args.output_dir)
        args.json_report.write_text(json.dumps(report, indent=2) + "\n")
        return 0
    except Exception as error:
        report["failure"] = type(error).__name__ + ": " + str(error)
        args.json_report.write_text(json.dumps(report, indent=2) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Check source-derived AddFee semantics; not full ApplicationEngine refinement."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.request

HERE = Path(__file__).resolve().parent
MODEL = HERE / "coq/GasSemantics.v"
COMMIT = "d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d"
SOURCE_SHA256 = "97b08bfe754bc51ed8418316b45d3805dccff76ef51fbd43ac9b663eacb4d5eb"
SOURCE_URL = f"https://raw.githubusercontent.com/neo-project/neo/{COMMIT}/src/Neo/SmartContract/ApplicationEngine.cs"
HEADER = "protected internal void AddFee(BigInteger gas, bool applyFactor)"
TOKEN = re.compile(r'\s+|//[^\n]*|/\*[\s\S]*?\*/|"(?:[^"\\]|\\.)*"|[A-Za-z_]\w*|\d+|\?\.|>=|<=|==|\*=|\+=|-=|[{}();,.<>+*=\-]')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def tokens(source):
    result, position = [], 0
    for match in TOKEN.finditer(source):
        require(match.start() == position, "unsupported source token at " + str(position))
        position = match.end()
        token = match.group()
        if token.isspace() or token.startswith(("//", "/*")):
            continue
        result.append(token)
    require(position == len(source), "unsupported trailing source token")
    return result


class Parser:
    def __init__(self, source):
        self.items, self.position = tokens(source), 0

    def peek(self):
        return self.items[self.position] if self.position < len(self.items) else None

    def take(self, expected=None):
        item = self.peek()
        require(item is not None and (expected is None or item == expected), "expected " + str(expected) + ", got " + str(item))
        self.position += 1
        return item

    def expression(self, minimum=0):
        atom = self.take()
        variables = {"gas": "Gas", "_feeConsumed": "Consumed", "_feeAmount": "Limit", "FeeFactor": "Factor"}
        if atom in variables:
            left = [variables[atom]]
        elif atom.isdecimal():
            left = ["Constant", int(atom)]
        elif atom == "(":
            left = self.expression(); self.take(")")
        else:
            raise ValueError("unsupported expression: " + atom)
        operators = {"+": (1, "Plus"), "-": (1, "Minus"), "*": (2, "Times")}
        while self.peek() in operators and operators[self.peek()][0] >= minimum:
            priority, name = operators[self.take()]
            right = self.expression(priority + 1)
            left = [name, left, right]
        return left

    def condition(self):
        if self.peek() == "applyFactor":
            self.take(); return ["ShouldApplyFactor"]
        if self.peek() == "CurrentContext":
            for token in tokens("CurrentContext?.GetState<ExecutionContextState>()?.WhiteListed == true"):
                self.take(token)
            return ["IsWhitelisted"]
        left = self.expression()
        operator = self.take()
        require(operator in {"<", "<=", ">", ">="}, "unsupported comparison")
        return [{"<": "Less", "<=": "LessEqual", ">": "More", ">=": "MoreEqual"}[operator], left, self.expression()]

    def statement(self):
        item = self.peek()
        if item == "if":
            self.take(); self.take("("); condition = self.condition(); self.take(")")
            body = self.block() if self.peek() == "{" else [self.statement()]
            return ["FeeIf", condition, body]
        if item == "return":
            self.take(); self.take(";"); return ["FeeReturn"]
        if item == "throw":
            for token in ["throw", "new", "InvalidOperationException", "("]:
                self.take(token)
            message = self.take(); self.take(")"); self.take(";")
            failures = {'"AddFee can\'t be negative."': "NegativeFee", '"Insufficient GAS."': "InsufficientGas"}
            require(message in failures, "unsupported exception message")
            return ["FeeThrow", failures[message]]
        require(item in {"gas", "_feeConsumed"}, "unsupported statement: " + str(item))
        self.take(); operator = self.take()
        require(operator in {"=", "*=", "+=", "-="}, "unsupported assignment")
        expression = self.expression(); self.take(";")
        if operator != "=":
            expression = [{"*=": "Times", "+=": "Plus", "-=": "Minus"}[operator], ["Gas" if item == "gas" else "Consumed"], expression]
        return ["SetGas" if item == "gas" else "SetConsumed", expression]

    def block(self):
        self.take("{"); body = []
        while self.peek() != "}":
            body.append(self.statement())
        self.take("}")
        return body


def method_body(source):
    # Header extraction is deliberately exact. Mutants operate on this method's
    # statements, while other overloads/attributes/field types fail closed.
    require(source.count(HEADER) == 1, "expected exactly one AddFee declaration")
    position = source.index(HEADER) + len(HEADER)
    source = source[position:]
    lexer = Parser(source[:source.index("\n        protected override void OnFault")] if "\n        protected override void OnFault" in source else source)
    body = lexer.block()
    require(lexer.peek() is None, "unsupported tokens after AddFee body")
    return body


def project_source(source):
    require(len(re.findall(r"\bprivate\s+readonly\s+BigInteger\s+_feeAmount\s*;", source)) == 1, "expected BigInteger fee limit field")
    require(len(re.findall(r"\bprivate\s+BigInteger\s+_feeConsumed\s*;", source)) == 1, "expected BigInteger consumed field")
    factors = re.findall(r"\bpublic\s+static\s+readonly\s+BigInteger\s+FeeFactor\s*=\s*(\d+)\s*;", source)
    require(len(factors) == 1, "expected exactly one fee factor constant")
    program = method_body(source)
    result = {"schema": "neoos-aa-add-fee-source/v1", "program": program, "feeFactor": int(factors[0]),
              "sourceSha256": digest(source.encode()), "sourceFrontendVerified": False}
    result["projectionSha256"] = digest(json.dumps({"program": program, "feeFactor": result["feeFactor"]}, sort_keys=True, separators=(",", ":")).encode())
    return result


def render(node):
    name = node[0]
    if name == "FeeIf":
        return "(FeeIf " + render(node[1]) + " " + render_program(node[2]) + ")"
    if name == "Constant":
        return f"(Constant ({node[1]}))"
    if name == "FeeThrow":
        return "(FeeThrow " + node[1] + ")"
    if len(node) == 1:
        return name
    return "(" + " ".join([name, *(render(child) for child in node[1:])]) + ")"


def render_program(program):
    return "[" + "; ".join(map(render, program)) + "]"


def certificate(projection):
    return """From Coq Require Import ZArith List Bool Lia.
Require Import GasSemantics.
Import ListNotations.
Open Scope Z_scope.
Definition actual_add_fee : list FeeStatement := %s.
Definition actual_fee_factor : Z := %d.
Theorem actual_add_fee_refines_spec : forall limit factor apply white gas consumed,
 normalize_fee_outcome (fee_program 20 actual_add_fee
   (fee_environment limit factor apply white) (fee_state gas consumed)) =
 Some (add_fee (fee_environment limit factor apply white) (fee_state gas consumed)).
Proof. intros limit factor apply white gas consumed.
 unfold actual_add_fee, normalize_fee_outcome, add_fee.
 cbn [fee_program fee_condition fee_expr gas_argument fee_consumed
   whitelisted apply_factor fee_factor fee_limit charged_gas].
 destruct (gas <? 0); [reflexivity|]. destruct white; [reflexivity|].
 destruct apply; cbn [fee_program fee_condition fee_expr gas_argument fee_consumed
   whitelisted apply_factor fee_factor fee_limit charged_gas];
 repeat match goal with |- context [if ?c then _ else _] => destruct c end; reflexivity.
Qed.
Theorem actual_fee_factor_is_pico_per_datoshi : actual_fee_factor = 10000.
Proof. reflexivity. Qed.
""" % (render_program(projection["program"]), projection["feeFactor"])


def declarations(source):
    return re.findall(r"^(?:Definition|Fixpoint|Inductive|Record|Lemma|Theorem|Example)\s+(\w+)", source, re.MULTILINE)


def command(arguments, directory, log, success=True):
    result = subprocess.run(arguments, cwd=directory, text=True, capture_output=True, timeout=600)
    Path(log).write_text(result.stdout + result.stderr)
    if success:
        require(result.returncode == 0, "kernel/tool failed: " + str(log) + "\n" + (result.stdout + result.stderr)[-2000:])
    return result.returncode, result.stdout + result.stderr


def pinned_source(cache=None):
    cache = Path(cache) if cache else Path(tempfile.gettempdir()) / "aa-pinned-neo-gas-d10e9cee.cs"
    if not cache.exists():
        with urllib.request.urlopen(SOURCE_URL, timeout=30) as response:
            data = response.read()
        require(digest(data) == SOURCE_SHA256, "pinned source download mismatch")
        cache.write_bytes(data)
    data = cache.read_bytes()
    require(digest(data) == SOURCE_SHA256, "pinned source cache mismatch")
    return data.decode("utf-8")


def run_proofs(output_dir, *, source_text=None, controls=True, cache=None):
    directory = Path(output_dir).resolve(); directory.mkdir(parents=True, exist_ok=True)
    require(not any(directory.iterdir()), "proof directory must be empty")
    input_paths = [MODEL, Path(__file__), HERE / "test_gas_proofs.py"]
    raw_inputs = {path: path.read_bytes() for path in input_paths}
    hashes = {str(path): digest(raw) for path, raw in raw_inputs.items()}
    source = source_text if source_text is not None else pinned_source(cache)
    projection = project_source(source)
    (directory / "source.cs").write_text(source)
    (directory / "projection.json").write_text(json.dumps(projection, indent=2) + "\n")
    coqc, coqchk = shutil.which("coqc"), shutil.which("coqchk")
    require(coqc and coqchk, "missing real coqc/coqchk")
    model = raw_inputs[MODEL].decode("utf-8")
    artifact = certificate(projection)
    for name, text in [("GasSemantics", model), ("GasArtifact", artifact)]:
        require(not re.search(r"\b(?:Admitted|Axiom|Parameter|admit|Abort)\b", text), "untrusted proof declaration")
        (directory / (name + ".v")).write_text(text)
        command([coqc, "-q", name + ".v"], directory, directory / (name + ".log"))
    command([coqchk, "-silent", "GasSemantics", "GasArtifact"], directory, directory / "coqchk.log")
    names = {"GasSemantics": declarations(model), "GasArtifact": declarations(artifact)}
    checks = "Require Import GasSemantics GasArtifact.\n" + "\n".join("Print Assumptions " + module + "." + name + "." for module, items in names.items() for name in items)
    (directory / "Assumptions.v").write_text(checks + "\n")
    _, checked = command([coqc, "-q", "Assumptions.v"], directory, directory / "assumptions.log")
    count = sum(map(len, names.values()))
    require(checked.count("Closed under the global context") == count and "Axioms:" not in checked, "assumption audit failed")
    rejected = []
    if controls:
        mutations = {
            "subtract-fee": ("_feeConsumed + gas", "_feeConsumed - gas"),
            "reject-exact-budget": ("_feeConsumed > _feeAmount", "_feeConsumed >= _feeAmount"),
            "reject-zero-charge": ("gas < 0", "gas <= 0"),
            "add-factor": ("gas *= FeeFactor", "gas += FeeFactor"),
            "factor-unit-drift": ("FeeFactor = 10000", "FeeFactor = 10001"),
            "discard-fee-increment": ("_feeConsumed = _feeConsumed + gas", "_feeConsumed = _feeConsumed"),
        }
        mutant_sources = {}
        for name, (old, new) in mutations.items():
            require(source.count(old) == 1, "mutation target ambiguous: " + name)
            mutant_sources[name] = source.replace(old, new)
        negative = re.search(r'if\s*\(gas\s*<\s*0\)\s*\{\s*throw new InvalidOperationException\("AddFee can\'t be negative\."\);\s*\}', source)
        whitelist = re.search(r'if\s*\(CurrentContext\?\.GetState<ExecutionContextState>\(\)\?\.WhiteListed\s*==\s*true\)\s*\{(?:\s|//[^\n]*\n)*return;\s*\}', source)
        require(negative is not None and whitelist is not None and negative.end() < whitelist.start(),
                "negative/whitelist source mutation target missing")
        mutant_sources["whitelist-before-negative-check"] = (source[:negative.start()] + whitelist.group()
            + source[negative.end():whitelist.start()] + negative.group() + source[whitelist.end():])
        for name, mutated_source in mutant_sources.items():
            mutated = certificate(project_source(mutated_source))
            case = directory / name; case.mkdir()
            for suffix in (".v", ".vo"):
                shutil.copyfile(directory / ("GasSemantics" + suffix), case / ("GasSemantics" + suffix))
            definitions = mutated.split("Theorem actual_add_fee_refines_spec", 1)[0]
            (case / "Definitions.v").write_text(definitions)
            command([coqc, "-q", "Definitions.v"], case, case / "definitions.log")
            (case / "GasArtifact.v").write_text(mutated)
            rc, message = command([coqc, "-q", "GasArtifact.v"], case, case / "rejection.log", False)
            require(rc != 0 and "Error:" in message and "Syntax error" not in message, "semantic mutation escaped: " + name)
            rejected.append({"name": name, "definitionsCompiled": True, "certificateRejected": True})
    require(all(digest(Path(path).read_bytes()) == expected for path, expected in hashes.items()), "proof inputs changed during run")
    if source_text is None:
        require(pinned_source(cache) == source, "pinned source changed during run")
    _, version = command([coqc, "--version"], directory, directory / "version.log")
    return {"schema": "neoos-aa-gas-refinement/v1", "scope": "source-derived-add-fee-and-metered-traces",
            "kernelChecked": True, "sourceProjectionVerified": True, "sourceFrontendVerified": False,
            "applicationEngineVerified": False, "fullImplementationVerified": False,
            "productionSourceBound": source_text is None, "sourceCommit": COMMIT if source_text is None else None,
            "sourceUrl": SOURCE_URL if source_text is None else None, "sourceSha256": projection["sourceSha256"],
            "projectionSha256": projection["projectionSha256"], "certificateSha256": digest(artifact.encode()),
            "toolVersion": version.strip(), "inputSha256": hashes, "closedDeclarations": names,
            "closedAssumptionCount": count, "semanticControls": rejected, "outputDirectory": str(directory),
            "unproved": ["C# frontend correctness and .NET BigInteger implementation", "context getter execution",
                         "all actual instruction, syscall and native price traces", "exception scheduling and snapshots",
                         "resource limits and full ApplicationEngine refinement"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--json-report", type=Path, required=True)
    parser.add_argument("--source-cache", type=Path)
    args = parser.parse_args(argv)
    result = {"scope": "source-derived-add-fee-and-metered-traces", "kernelChecked": False,
              "applicationEngineVerified": False, "fullImplementationVerified": False}
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    args.json_report.write_text(json.dumps(result) + "\n")
    try:
        result = run_proofs(args.output_dir, cache=args.source_cache)
        args.json_report.write_text(json.dumps(result, indent=2) + "\n")
        return 0
    except Exception as error:
        result["failure"] = type(error).__name__ + ": " + str(error)
        args.json_report.write_text(json.dumps(result, indent=2) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

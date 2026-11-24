"""Replay the archived C# discovery queries on the 100-entry NEF after its actual initializer."""
import argparse
import gzip
import json
import re
import subprocess
import tempfile
from pathlib import Path

from ordinary_initializer_proofs import HERE, INVENTORY, MANIFEST, NEF, bind, decode_nef, digest, require
from public_pure_proofs import MODULES, kernel, render_certificate

ROOT = HERE.parents[1]
REPORT = ROOT / "docs/reports/smartaccount-current-20261124"
REV = "1371a54e1cb8044bd8aaf3bff6898360c70c3922"
SOURCE = "contracts/UnifiedSmartWallet.State.cs"
INPUT = REPORT / "ordinary-entry/input/UnifiedSmartWalletV3"
TARGETS = {"getAccountImplementationId": None, "supportsExecutionMode": "mode", "supportsModuleType": "moduleType"}


def extract(source, name, param):
    cs = name[0].upper() + name[1:]
    typ = "bool" if param else "string"
    args = "string " + param if param else ""
    expr, = re.findall(r"\[Safe\]\s+public static " + typ + " " + cs + r"\(" + args +
                       r"\)\s*\{\s*return ([^;]+);\s*\}", source)
    def literal(s):
        return ["PBytes", list(s.encode("ascii"))]
    if not param:
        require(re.fullmatch(r"\w+", expr), "unsupported constant")
        value, = re.findall(r'private const string ' + expr + r' = "([\w.\-]+)";', source)
        return literal(value)
    parts = []
    for term in expr.split(" || "):
        match = re.fullmatch(param + r' == "([\w-]+)"', term)
        require(match, "unsupported equality")
        parts.append(["PStringEq", ["PArgument"], literal(match[1])])
    result = parts[0]
    for rhs in parts[1:]:
        result = ["POr", result, rhs]
    return result


def run(output):
    output.mkdir(parents=True, exist_ok=True)
    receipt = output / "result.json"
    receipt.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    inv = gzip.decompress((ROOT / "docs/reports/aa-implementation-refinement-20261013/inventory.json.gz").read_bytes())
    require(digest(inv) == INVENTORY, "wrong inventory")
    inv = json.loads(inv)
    raw = INPUT.with_suffix(".nef").read_bytes()
    abi, _, _ = bind(raw, INPUT.with_suffix(".manifest.json").read_bytes(), NEF, MANIFEST)
    script = decode_nef(raw)["script"]
    src = subprocess.check_output(["git", "show", REV + ":" + SOURCE], cwd=ROOT)
    src_hash, = (v for k, v in inv["inputs"].items() if k.endswith("/" + SOURCE))
    require(digest(src) == src_hash, "wrong source revision")
    bound, summary = {}, {}
    joins = ["""Require Import CapMethodVm CapContext PublicPureMethods OrdinaryInitializerArtifact OrdinaryPureArtifact OrdinaryReturn.
From Coq Require Import List. Import ListNotations.
Definition resume_pure code stored finish :=
  match finish with
  | InitReturned s => match init_slots s with
    | Some fields => Some (run_public 24 code (initial_public (init_stack s)
        (nth_error fields) (init_heap s) stored))
    | None => None end
  | _ => None end.
Definition to_caller outcome tail :=
  match outcome with
  | Some (Halt v _) => ordinary_dynamic_return VNull (Some 1) [v] tail
  | _ => None end."""]
    for name, param in TARGETS.items():
        method, = (m for m in abi if m["name"] == name)
        require(method["safe"] and method["parameters"] == ([{"name":param,"type":"String"}] if param else [])
                and method["returntype"] == ("Boolean" if param else "String"), "ABI differs")
        row, = (m for m in inv["sourceMap"]["debug"]["methods"]
                if m["name"] == "AbstractAccount.UnifiedSmartWallet," + name[0].upper() + name[1:])
        start, end = map(int, row["range"].split("-"))
        require(start == method["offset"] and script[end] == 0x40, "method range differs")
        code = script[start:end+1]
        expression = extract(src.decode("utf-8-sig"), name, param)
        bound[name] = dict(bytes=list(code), source=dict(parameters=[param] if param else [], expression=expression))
        summary[name] = dict(offset=start, length=len(code), sha256=digest(code))
        inputs = "[input]" if param else "[]"
        joins.append(rf"""Theorem {name}_initialized : forall hp input stored,
  exists outcome, resume_pure {name}_code stored
    (run_init 170 OrdinaryInitializerArtifact.code (initializer_entry hp {inputs})) = Some outcome /\
    public_classified (budget_eval {name}_source input) outcome
      (initial_public {inputs} (nth_error (slots hp)) (heap_after hp) stored).
Proof. intros. rewrite init_exact. eexists. split; [reflexivity|apply {name}_execution_classified]. Qed.
Print Assumptions {name}_initialized.""")
        joins.append(rf"""Theorem {name}_caller_stack : forall hp input stored tail,
  to_caller (resume_pure {name}_code stored
    (run_init 170 OrdinaryInitializerArtifact.code (initializer_entry hp {inputs}))) tail =
  option_map (fun v => v :: tail) (budget_eval {name}_source input).
Proof. intros. destruct ({name}_initialized hp input stored) as [out [H C]]. rewrite H.
  destruct (budget_eval {name}_source input), out; simpl in C; try contradiction;
  try reflexivity. destruct C as [-> _]. reflexivity. Qed.
Print Assumptions {name}_caller_stack.""")
    init = (REPORT / "ordinary-initializer/OrdinaryInitializerArtifact.v").read_bytes()
    require(digest(init) == "ce2be7f7097245d8b9e96dc6c18f95a23ebe4d5d40c8775cd91fd11e9755604e", "initializer differs")
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        files = {n:(HERE/"coq"/(n+".v")).read_bytes() for n in (*MODULES, "CapContext", "OrdinaryReturn")}
        files.update(OrdinaryInitializerArtifact=init, OrdinaryPureArtifact=render_certificate({"methods":bound}).encode(),
                     InitializedPure=("\n".join(joins) + "\n").encode())
        for name, code in files.items():
            path = name+".v"
            (work/path).write_bytes(code)
            _, log = kernel(["coqc","-q",path], work, work/(name+".log"))
            if name in ("OrdinaryPureArtifact","InitializedPure"):
                require(log.count("Closed under the global context") == code.count(b"Print Assumptions")
                        and "Axioms:" not in log, "open assumptions")
                (output/path).write_bytes(code)
        kernel(["coqchk","-silent","InitializedPure"], work, work/"check.log")
        # Vary one valid literal byte; it must change the classified return value.
        control = """From Coq Require Import List. Require Import CapMethodVm PublicPureMethods OrdinaryPureArtifact.
Import ListNotations.
Example altered_literal : public_value (run_public 24
  (firstn 2 getAccountImplementationId_code ++ [120] ++ skipn 3 getAccountImplementationId_code)
  (initial_public [] (fun _ => None) [] VNull)) = source_eval getAccountImplementationId_source VNull.
Proof. vm_compute. reflexivity. Qed."""
        (work/"Control.v").write_text(control)
        rc, log = kernel(["coqc","-q","Control.v"], work, work/"control.log", success=False)
        require(rc and "Unable to unify" in log, "literal control not rejected by equality")
    receipt.write_text(json.dumps(dict(status="PASS_SCOPED", implementationVerified=False, methods=summary,
        nefSha256=NEF, manifestSha256=MANIFEST, sourceSha256=src_hash, inventorySha256=INVENTORY,
        proofInputs={n:digest(v) for n,v in files.items()}, coqchkPassed=True, literalControlRejected=True,
        scope="Initializer entry through normal nonvoid return to an arbitrary caller stack in the reference model. None means no normal result, not a rollback proof. Noninterfering unload callbacks, snapshot commit, reference bookkeeping and resources are assumed; excludes GAS, exceptional unwind and rollback."),
        indent=2)+"\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPORT/"ordinary-pure")
    run(parser.parse_args().output)

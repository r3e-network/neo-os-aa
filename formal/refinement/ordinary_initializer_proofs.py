"""Check the entry initializer against the declared static values of the 100-entry artifact."""
import argparse
import gzip
import copy
import json
import math
from pathlib import Path
import re
import subprocess
import tempfile

from ordinary_entry_proofs import HERE, bind, digest
from verify import decode_nef
from nef_decode import decode_script

NEF = "083ed325f9bdaa6b223662042f32d29f398ba055f507bbdde46daf8113c47f2a"
MANIFEST = "e79fa04969ef3f0bdd6b9df6afe41acdd19767968575ea38c1cd011ee97e5156"
INVENTORY = "1504bf3c5c3a72821b40394aa00c4a929081b403a3954ece710c92eea453ae17"
MODELS = ("IntegerSemantics", "CapArithmetic", "CapMethodVm", "CapContext")


def require(ok, message):
    if not ok:
        raise ValueError(message)


def declared_slots(inventory, root):
    # A restricted literal reader for these pinned source files, not a C# frontend.
    fields = {}
    pattern = r"^\s*private static readonly (byte\[\]|string\[\]|BigInteger) (\w+)\s*=\s*([^;]+);"
    hashes = {}
    for name, expected in inventory["inputs"].items():
        file = Path(name)
        if not file.match("contracts/UnifiedSmartWallet*.cs"):
            continue
        data = (root / file.name).read_bytes()
        require(digest(data) == expected, f"source drift: {file.name}")
        hashes[file.name] = expected
        for typ, field, expr in re.findall(pattern, data.decode("utf-8-sig"), re.M):
            require(field not in fields, f"duplicate field {field}")
            if typ == "BigInteger":
                require(re.fullmatch(r"\d+L?(?:\s*\*\s*\d+)*", expr), f"unsupported integer: {field}")
                factors = [int(x.strip().rstrip("L")) for x in expr.split("*")]
                value = math.prod(factors)
                require(value < (1 << (63 if "L" in expr else 31)), "unmodelled integer overflow")
            else:
                body = re.fullmatch(r"new\s+" + re.escape(typ) + r"\s*\{([^{}]+)\}", expr.strip(), re.S)
                require(body, f"unsupported initializer: {field}")
                items = [x.strip() for x in body[1].split(",")]
                if typ == "byte[]":
                    require(all(re.fullmatch("0x[0-9A-Fa-f]{2}", x) for x in items), field)
                    value = [int(x, 16) for x in items]
                else:
                    require(all(re.fullmatch(r'"[a-zA-Z0-9]+"', x) for x in items), field)
                    value = [x[1:-1] for x in items]
            fields[field] = (typ, value)
    rows = {}
    for row in inventory["sourceMap"]["debug"]["static-variables"]:
        field, kind, text = row.split(",")
        typ, value = fields.pop(field)
        index = int(text)
        require(index not in rows and kind == {"byte[]":"ByteArray","string[]":"Array","BigInteger":"Integer"}[typ],
                "invalid debug slot")
        rows[index] = dict(field=field, kind=kind, value=value)
    require(not fields and sorted(rows) == list(range(53)), "incomplete slot map")
    return [rows[i] for i in range(len(rows))], hashes


def vector(values):
    return "[" + ";".join(values) + "]"


def octets(data):
    return vector([f"{x}%nat" for x in data])


def render(code, fuel, slots):
    objects, values = [], []
    for row in slots:
        kind, value = row["kind"], row["value"]
        if kind == "Array":
            elements = vector(["VBytes " + octets(s.encode()) for s in value])
            prefix = "hp" if not objects else "hp ++ " + vector(objects)
            values.append("VRef (length (" + prefix + "))")
            objects.append("obj ArrayKind " + elements)
        elif kind == "Integer":
            values.append(f"VInt {value}")
        else:
            values.append("VBuffer " + octets(value))
    require(len(objects) == 2, "unexpected allocation count")
    return f"""From Coq Require Import List ZArith Lia.
Require Import CapMethodVm CapContext.
Import ListNotations. Open Scope Z_scope.
Definition code : list nat := {octets(code)}.
Definition slots (hp : list Object) := {vector(values)}.
Definition heap_after (hp : list Object) := (hp ++ [{objects[0]}]) ++ [{objects[1]}].
Theorem init_exact : forall hp arguments,
  run_init {fuel}%nat code (initializer_entry hp arguments) =
    InitReturned (init_state {len(code)-1}%nat arguments (heap_after hp) (Some (slots hp))).
Proof. intros. vm_compute. reflexivity. Qed.
Theorem old_references_preserved : forall (hp : list Object) i,
  (i < length hp)%nat -> nth_error (heap_after hp) i = nth_error hp i.
Proof. intros. unfold heap_after. rewrite nth_error_app1 by (rewrite app_length; simpl; lia).
  now apply nth_error_app1. Qed.
Theorem existing_statics_fault : forall hp args existing,
  run_init {fuel}%nat code (init_state 0 args hp (Some existing)) = InitFaulted.
Proof. reflexivity. Qed.
Print Assumptions init_exact.
Print Assumptions old_references_preserved.
Print Assumptions existing_statics_fault.
"""


def check_runtime(script, manifest, rows, work):
    project = HERE / "initializer-probe/InitializerProbe.csproj"
    subprocess.run(["dotnet", "build", str(project), "-p:RestoreLockedMode=true"], check=True)
    (work/"script").write_bytes(script)
    (work/"manifest").write_bytes(manifest)
    expected = work/"slots.json"
    expected.write_text(json.dumps(rows))
    cmd = ["dotnet", str(project.parent/"bin/Debug/net10.0/InitializerProbe.dll"),
           work/"script", work/"manifest", expected]
    result = json.loads(subprocess.check_output(cmd, cwd=work))
    require(result["scriptSha256"] == digest(script) and result["manifestSha256"] == MANIFEST,
            "unexpected VM probe input")
    controls = {}
    for kind in ("ByteArray", "Array"):
        changed = copy.deepcopy(rows)
        i = next(i for i,r in enumerate(changed) if r["kind"] == kind)
        value = changed[i]["value"]
        if kind == "Array":
            value.reverse()
        else:
            value[0] ^= 1
        expected.write_text(json.dumps(changed))
        rejected = subprocess.run(cmd, cwd=work, capture_output=True, text=True)
        require(rejected.returncode != 0 and f"slot {i}: {rows[i]['field']}" in rejected.stderr,
                f"{kind} control did not fail at its changed slot")
        controls[kind] = rows[i]["field"]
    return dict(**result, rejectedControls=controls)


def run(args):
    out = args.output
    out.mkdir(parents=True, exist_ok=True)
    receipt = out / "result.json"
    receipt.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    raw = args.nef.read_bytes()
    manifest = args.manifest.read_bytes()
    methods, entry, script_hash = bind(raw, manifest, NEF, MANIFEST)
    inventory_raw = gzip.decompress(args.inventory.read_bytes())
    require(digest(inventory_raw) == INVENTORY, "inventory digest mismatch")
    inventory = json.loads(inventory_raw)
    nef = decode_nef(raw)
    code = nef["script"][entry:]
    require(len(methods) == 100 and inventory["manifest"]["methods"] == methods and
            inventory["nef"]["scriptHex"] == nef["script"].hex(), "wrong inventory")
    instructions = decode_script(code, len(nef["tokens"]))
    require(instructions[-1]["name"] == "RET" and not any(i["name"] == "RET" for i in instructions[:-1]),
            "initializer must end at its first return")
    rows, hashes = declared_slots(inventory, args.sources)
    certificate = render(code, len(instructions), rows)
    with tempfile.TemporaryDirectory(dir=out) as tmp:
        work = Path(tmp)
        runtime = check_runtime(nef["script"], manifest, rows, work.resolve())
        (out/"runtime.json").write_text(json.dumps(runtime,indent=2)+"\n")
        for name in (*MODELS, "OrdinaryInitializerArtifact"):
            content = (HERE/"coq"/(name+".v")).read_text() if name in MODELS else certificate
            (work/(name+".v")).write_text(content)
            with (out/(name+".log")).open("w") as log:
                subprocess.run(["coqc","-q",name+".v"],cwd=work,stdout=log,stderr=log,check=True)
        log = (out/"OrdinaryInitializerArtifact.log").read_text()
        require(log.count("Closed under the global context") == 3 and "Axioms:" not in log, "open assumptions")
        subprocess.run(["coqchk","-silent","OrdinaryInitializerArtifact"],cwd=work,check=True)
    (out/"OrdinaryInitializerArtifact.v").write_text(certificate)
    (out/"slots.json").write_text(json.dumps(rows,indent=2)+"\n")
    receipt.write_text(json.dumps(dict(status="PASS_SCOPED", implementationVerified=False, nefSha256=NEF,
        manifestSha256=MANIFEST, scriptSha256=script_hash, inventorySha256=digest(inventory_raw),
        sourceSha256=hashes, modelSha256={n:digest((HERE/"coq"/(n+".v")).read_bytes()) for n in MODELS},
        certificateSha256=digest(certificate.encode()), initOffset=entry, byteCount=len(code),
        instructionCount=len(instructions), staticSlotCount=len(rows), coqchkPassed=True, runtime=runtime,
        boundary="Initializer opcode reference semantics; byte buffers represented by value. VM fees, limits, "
                 "fault rollback, RET context unload and actual method execution are separate obligations."),indent=2)+"\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("nef","manifest","inventory","sources","output"):
        parser.add_argument("--"+key, type=Path, required=True)
    run(parser.parse_args())

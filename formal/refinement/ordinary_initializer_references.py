"""Check the archived initializer's reference limit against its NEF and the locked VM."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from ordinary_initializer_proofs import HERE, MANIFEST, MODELS, NEF, bind, decode_nef, decode_script, digest, require

REPORT = HERE.parents[1] / "docs/reports/smartaccount-current-20261124"
INPUT = REPORT / "ordinary-entry/input/UnifiedSmartWalletV3"
VM = "cea00a147add3c672bb23ffb5d98a4b1f31da135272efc258fee8fb7805bbfe9"


def project(rows):
    actions, heights, stack, written = [], [], [], set()
    slots = children = 0
    for index, row in enumerate(rows):
        name, arg = row["name"], bytes.fromhex(row["operandHex"])
        if name == "INITSSLOT" and index == 0:
            slots, = arg
            action = f"InitSlots {slots}"
        elif name == "PUSHDATA1":
            stack.append("bytes")
            action = "Push"
        elif name.startswith("PUSHINT"):
            stack.append(int.from_bytes(arg, "little", signed=True))
            action = "Push"
        elif name in ("PUSH6", "PUSH8"):
            stack.append(int(name[4:]))
            action = "Push"
        elif name == "PACK":
            n = stack.pop()
            require(type(n) is int and 0 < n <= len(stack) and stack[-n:] == ["bytes"] * n,
                    "PACK must consume exactly its own scalar items")
            del stack[-n:]
            stack.append("array")
            children += n
            action = f"Pack {n}"
        elif name == "CONVERT" and arg == b"\x30" and stack[-1:] == ["bytes"]:
            stack[-1] = "buffer"
            action = "Preserve"
        elif name.startswith("STSFLD"):
            slot = arg[0] if name == "STSFLD" else int(name[6:])
            require(0 <= slot < slots and slot not in written and stack, "unexpected static write")
            stack.pop()
            written.add(slot)
            action = "Store"
        elif name == "RET" and index == len(rows) - 1 and not stack and len(written) == slots:
            action = "Preserve"
        else:
            raise ValueError(f"unmodelled initializer instruction: {row}")
        actions.append(action)
        heights.append(slots + len(stack) + children)
    require(actions[0].startswith("InitSlots") and rows[-1]["name"] == "RET", "missing initializer frame")
    return actions, heights


def certificate(actions, code, peak=68, final=67):
    return """From Coq Require Import List PeanoNat.
Require Import CapMethodVm CapContext InitializerReferences.
Import ListNotations.
Open Scope nat_scope.
Definition program := [%s].
Definition counts_after := trace program (counts 0 0 0).
Definition raw_initializer : list nat := [%s].
(* Count the stack roots, static roots and element slots allocated by these
   exact bytes. The two allocated arrays remain reachable through RET. *)
Definition measured s :=
  length (init_stack s) + length (match init_slots s with Some xs => xs | None => [] end)
  + fold_right (fun o n => length (fields o) + n) 0 (init_heap s).
Fixpoint measured_run fuel (s : InitState) : option (list nat) :=
  match fuel with
  | O => None
  | S rest =>
    match init_decode raw_initializer (init_pc s) with
    | Some (op, size) =>
      match init_step op size s with
      | InitNext t => option_map (cons (measured t)) (measured_run rest t)
      | InitHalt t => if Nat.eqb (init_pc t + size) (length raw_initializer)
                      then Some [measured t] else None
      | InitFault => None end
    | None => None end end.
Theorem bytecode_reference_trace :
  measured_run %d (initializer_entry [] []) = Some counts_after.
Proof. vm_compute. reflexivity. Qed.
Print Assumptions bytecode_reference_trace.
Lemma peak : fold_right Nat.max 0 counts_after = %d.
Proof. reflexivity. Qed.
Theorem all_steps_fit : forall base limit, base <= limit ->
  (fits base limit counts_after = true <-> base + %d <= limit).
Proof. intros. now rewrite fit_iff_peak, peak by assumption. Qed.
Theorem final_usage : last counts_after 0 = %d.
Proof. reflexivity. Qed.
Print Assumptions peak.
Print Assumptions all_steps_fit.
Print Assumptions final_usage.
""" % (";".join(actions), ";".join(map(str, code)), len(actions), peak, peak, final)


def run(out):
    out.mkdir(parents=True, exist_ok=True)
    receipt = out / "result.json"
    receipt.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    raw, manifest = INPUT.with_suffix(".nef").read_bytes(), INPUT.with_suffix(".manifest.json").read_bytes()
    methods, entry, script_sha = bind(raw, manifest, NEF, MANIFEST)
    nef = decode_nef(raw)
    rows = decode_script(nef["script"][entry:], len(nef["tokens"]))
    actions, heights = project(rows)
    ordinary = {(m["name"], len(m["parameters"])) for m in methods if not m["name"].startswith("_")}
    require(len(ordinary) == 98 and len(heights) == 170, "entry roster changed")
    expected = {(name, arity, free) for name, arity in ordinary for free in
                (range(70) if name == "getAccountImplementationId" else (67, 68))}
    project_file = HERE / "initializer-probe/InitializerProbe.csproj"
    subprocess.run(["dotnet", "build", str(project_file), "-p:RestoreLockedMode=true", "--nologo"], check=True)
    model = HERE / "coq/InitializerReferences.v"
    cert = certificate(actions, nef["script"][entry:])
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d/"script").write_bytes(nef["script"])
        probe = project_file.parent/"bin/Debug/net10.0/InitializerProbe.dll"
        runtime = json.loads(subprocess.check_output(["dotnet", str(probe), "--reference-limits",
            str(d/"script"), str(INPUT.with_suffix(".manifest.json"))]))
        require((runtime["vmSha256"],runtime["manifestSha256"],runtime["scriptSha256"]) == (VM, MANIFEST, script_sha),
                "probe input mismatch")
        limit = runtime["limit"]
        require(limit == 2048, "unexpected VM reference limit")
        for r in runtime["rows"]:
            key = (r["name"], r["arity"], r["free"])
            require(key in expected, "unexpected or duplicate reference case")
            expected.remove(key)
            free = r["free"]
            j = next((i for i,n in enumerate(heights) if n > free), None)
            k = len(heights)-1 if j is None else j
            error = None if j is None else f"MaxStackSize exceed: {limit-free+heights[j]}/{limit}"
            require(r["deltas"] == heights[:k+1] and r["last"] == rows[k]["offset"] and
                    r["returned"] == (j is None) and r["error"] == error, f"reference divergence {key}")
        require(not expected, "missing VM observations")
        for name in MODELS:
            f = HERE/"coq"/(name+".v")
            (d/f.name).write_bytes(f.read_bytes())
            subprocess.run(["coqc", "-q", f.name], cwd=d, check=True, stdout=subprocess.DEVNULL)
        (d/model.name).write_bytes(model.read_bytes())
        (d/"ReferenceArtifact.v").write_text(cert)
        for module, declarations in ((model.name, 2), ("ReferenceArtifact.v", 4)):
            log = subprocess.check_output(["coqc", "-q", module], cwd=d, text=True, stderr=subprocess.STDOUT)
            require(log.count("Closed under the global context") == declarations and "Axioms:" not in log,
                    "open assumptions")
        subprocess.run(["coqchk", "-silent", "ReferenceArtifact"], cwd=d, check=True)
    (out/"ReferenceArtifact.v").write_text(cert)
    (out/"runtime.json").write_text(json.dumps(runtime, separators=(",", ":"))+"\n")
    receipt.write_text(json.dumps(dict(status="PASS_SCOPED", implementationVerified=False, nefSha256=NEF,
        manifestSha256=MANIFEST, scriptSha256=script_sha, modelSha256=digest(model.read_bytes()),
        certificateSha256=digest(cert.encode()), checkerSha256=digest(Path(__file__).read_bytes()),
        valueModelSha256={n:digest((HERE/"coq"/(n+".v")).read_bytes()) for n in MODELS},
        probeSourceSha256={p.name:digest(p.read_bytes()) for p in
                           [project_file, project_file.parent/"packages.lock.json",
                            *sorted(project_file.parent.glob("*.cs"))]},
        probeDllSha256=digest(probe.read_bytes()), maximumHealthyStartingReferences=limit-max(heights),
        initializerOffset=entry, initializerSha256=digest(nef["script"][entry:]),
        vmSha256=VM, runtimeSha256=digest((out/"runtime.json").read_bytes()), coqchkPassed=True,
        ordinaryEntryCount=len(ordinary), instructionCount=len(rows), runtimeCases=len(runtime["rows"]),
        peakAdditionalReferences=max(heights), finalAdditionalReferences=heights[-1],
        firstPeakRelativeOffset=rows[heights.index(max(heights))]["offset"],
        scope="Post-instruction reference count of the fresh initialized frame only. The raw bytes produce the projected trace in the Coq value model; "
              "correspondence to the locked VM is independently trace-tested, not proved for the CLR. "
              "No method body, gas, transaction rollback or arbitrary heap interference claim."),indent=2)+"\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPORT/"ordinary-initializer-references")
    run(parser.parse_args().output)

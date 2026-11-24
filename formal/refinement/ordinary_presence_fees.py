"""Price the bounded invocation shapes independently and compare every sampled instruction."""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import re
import subprocess
import tempfile

from gas_trace import extract_fees, integer_price, pinned_sources
from ordinary_initializer_proofs import HERE, NEF, MANIFEST, bind, decode_nef, decode_script, digest, require
from ordinary_presence_proofs import TARGETS, project


def run(a):
    a.output.mkdir(parents=True, exist_ok=True)
    result = a.output / "result.json"
    result.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    raw = a.nef.read_bytes()
    methods, entry, _ = bind(raw, a.manifest.read_bytes(), NEF, MANIFEST)
    nef = decode_nef(raw)
    ops = decode_script(nef["script"], len(nef["tokens"]))
    init = [i for i in ops if i["offset"] >= entry]
    require(len(init) == 170 and init[-1]["name"] == "RET" and
            all(i["edges"] == [{"kind":"fallthrough","target":i["offset"]+i["size"]}] for i in init[:-1]),
            "initializer is not straight-line")
    sources = pinned_sources()
    table = extract_fees(sources)
    expression, = re.findall(r'System_Contract_Call = Register\("System\.Contract\.Call", nameof\(CallContract\), '
                             r'([^,]+), CallFlags\.ReadStates \| CallFlags\.AllowCall\);', sources["ApplicationEngine.Contract.cs"])
    symbol = "System.Contract.Call"
    table["syscalls"][symbol] = dict(fixed=integer_price(expression),
        hash=int.from_bytes(bytes.fromhex(digest(symbol.encode()))[:4], "little"))
    data = a.runtime.read_bytes()
    runtime = json.loads(data)
    require(runtime["status"] == "PASS_SAMPLED" and runtime["nefSha256"] == NEF and
            runtime["manifestSha256"] == MANIFEST and runtime["engineSha256"] ==
            "cb1b4db8076847dc23fda920ded773adaeeda07895effd350d2d8a99595a7f3a" and runtime["vmSha256"] ==
            "cea00a147add3c672bb23ffb5d98a4b1f31da135272efc258fee8fb7805bbfe9", "wrong runtime")
    source = ["From Coq Require Import List NArith Lia. Require Import PathFee. Import ListNotations. Open Scope N_scope."]
    paths, results, seen, amounts = {}, {}, defaultdict(set), defaultdict(set)
    for r in runtime["feeRuns"]:
        name, flags, budget = r["method"], r["flags"], r["budget"]
        require(name in TARGETS and 0 <= flags <= 15 and budget >= 0, "unexpected scenario")
        key = (name, flags, r["script"])
        if key not in paths:
            driver = decode_script(bytes.fromhex(r["script"]), 0)
            require([i["name"] for i in driver] == ["PUSHDATA1","PUSH1","PACK","PUSH"+str(flags),
                    "PUSHDATA1","PUSHDATA1","SYSCALL","RET"] and
                    bytes.fromhex(driver[4]["operandHex"]) == name.encode() and
                    len(bytes.fromhex(driver[0]["operandHex"])) == len(bytes.fromhex(driver[5]["operandHex"])) == 20,
                    "wrong invocation script")
            start, = (m["offset"] for m in methods if m["name"] == name)
            body = []
            for i in ops:
                if i["offset"] < start: continue
                body.append(i)
                if i["name"] == "RET": break
            terms = project(body)
            require(terms == ["InitSlot 1 1",terms[1],"LdArg","Convert 48","Concat","StLoc 0","LdLoc 0",
                    "GetContext","StorageGet","Push GNull","NotEqualIns","Jump 12","Ret"] and
                    terms[1].startswith("LdStatic "), "unpriced branch/body")
            steps = []
            for phase, seq in (("driver",driver[:-1]),("initializer",init),("method",body),("driver",driver[-1:])):
                for i in seq:
                    weights = [table["opcodes"][i["name"]]]
                    denied = False
                    if i["name"] == "SYSCALL":
                        symbol = {"driver":"System.Contract.Call"}.get(phase)
                        if phase == "method":
                            symbol = {"GetContext":"System.Storage.GetContext","StorageGet":"System.Storage.Get"}[terms[body.index(i)]]
                        desc = table["syscalls"][symbol]
                        require(int.from_bytes(bytes.fromhex(i["operandHex"]), "little") == desc["hash"], "syscall binding")
                        denied = phase == "method" and not flags & 1
                        if not denied: weights.append(desc["fixed"])
                    steps.append((phase, i, weights, denied))
                    if denied: break
                if steps[-1][-1]: break
            paths[key] = steps
        steps = paths[key]
        used, points, cause = 0, [], None
        for phase,i,weights,denied in steps:
            points.append(dict(target=phase!="driver",pc=i["offset"],opcode=i["opcode"],feeBefore=used))
            for weight in weights:
                used += 30*weight
                if used > budget:
                    cause = "gas"
                    break
            if cause: break
            if denied:
                cause = "flags"
                break
        actual = runtime["traces"][r["traceId"]]
        require(points == actual and used == r["fee"], f"{name}/{flags}/{budget}: fee or execution path differs")
        require(r["state"] == ("FAULT" if cause else "HALT") and
                (r["error"] is None if not cause else
                 ("Insufficient GAS" if cause=="gas" else "Cannot call this SYSCALL") in r["error"]), "unexpected outcome")
        seen[name].add((flags, r["label"], budget))
        if flags == 5 and r["label"] == "missing": amounts[name].add(budget)
        if flags != 5 or name in results: continue
        ws = [w for _,_,weights,_ in steps for w in weights]
        total = sum(ws)
        parts = {p:sum(sum(weights) for ph,_,weights,_ in steps if ph==p) for p in ("driver","initializer","method")}
        results[name] = dict(units=total, phaseUnits=parts, instructionCount=len(steps))
        source.append(f"""Definition {name}_fees : list N := [{';'.join(map(str,ws))}].
Example {name}_total : units {name}_fees = {total}. Proof. reflexivity. Qed.
Theorem {name}_budget : forall factor budget amount,
  settle factor budget 0 {name}_fees = Paid amount <->
  factor * {total} <= budget /\\ amount = factor * {total}.
Proof. intros. rewrite settle_paid by lia. rewrite {name}_total. reflexivity. Qed.
Print Assumptions {name}_budget.""")
    require(results.keys() == TARGETS.keys() and runtime["calls"] == len(runtime["feeRuns"]), "missing methods or runs")
    for (name,flags,_),steps in paths.items():
        if flags != 5: continue
        cost = 0
        boundaries = {0}
        for _,_,weights,_ in steps:
            for weight in weights:
                cost += weight*30
                boundaries.update([cost,max(0,cost-1)])
        require(boundaries <= amounts[name], f"{name}: missing budget transition")
        require(all((f,"empty",100_00000000) in seen[name] for f in range(16)), "missing flag combination")
        require(all((5,label,b) in seen[name] for label in ("empty","nonempty","missing","backing","deleted")
                    for b in (100_00000000,cost,cost-1)), "missing storage or fee boundary")
    cert = "\n".join(source)+"\nPrint Assumptions exhausted_at_first_overrun.\n"
    model = (HERE/"coq/PathFee.v").read_bytes()
    with tempfile.TemporaryDirectory(dir=a.output) as tmp:
        work = Path(tmp)
        for name,content in (("PathFee",model),("PresenceFeeArtifact",cert.encode())):
            (work/(name+".v")).write_bytes(content)
            p = subprocess.run(["coqc","-q",name+".v"],cwd=work,check=True,capture_output=True,text=True)
        require(p.stdout.count("Closed under the global context") == 4 and "Axioms:" not in p.stdout, "open assumptions")
        subprocess.run(["coqchk","-silent","PresenceFeeArtifact"],cwd=work,check=True)
    (a.output/"PresenceFeeArtifact.v").write_text(cert)
    result.write_text(json.dumps(dict(status="PASS_SCOPED",implementationVerified=False, coqchkPassed=True,
        methods=results,calls=runtime["calls"],runtimeSha256=digest(data),modelSha256=digest(model),
        certificateSha256=digest(cert.encode()),nefSha256=NEF,manifestSha256=MANIFEST,
        priceSources=table["sourceHashes"],priceCommit=table["sourceCommit"],
        boundary="Symbolic nonnegative integral tariff for the verified read path; runtime cross-check at factor 30. "
                 "No whitelist discount, non-fee faults or arbitrary outer scripts modelled."),indent=2)+"\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("nef","manifest","runtime","output"):
        parser.add_argument("--"+arg, type=Path, required=True)
    run(parser.parse_args())

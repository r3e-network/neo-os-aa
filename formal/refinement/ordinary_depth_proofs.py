"""Verify ordinary invocation capacity against the pinned 100-entry artifact and runtime."""
import json
import subprocess
import tempfile
from pathlib import Path

from entry_dispatch_source import SOURCES, TEMPLATES, HEADERS, body, mirror_source, download_pinned, source_url
from ordinary_pure_proofs import INPUT, REPORT, HERE, NEF, MANIFEST, bind, digest, require


def run():
    dest = REPORT / "ordinary-entry"
    receipt = dest / "depth.json"
    receipt.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    abi, init, _ = bind(INPUT.with_suffix(".nef").read_bytes(), INPUT.with_suffix(".manifest.json").read_bytes(), NEF, MANIFEST)
    ordinary = {(m["name"],len(m["parameters"])):m["offset"] for m in abi if not m["name"].startswith("_")}
    require(len(ordinary)==98 and init is not None, "unexpected manifest")
    cases = {(name,arity,free) for name,arity in ordinary for free in (0,1)}
    controls = {"getAccountImplementationId","supportsExecutionMode","supportsModuleType"}
    cases.update((name,arity,2) for name,arity in ordinary if name in controls)
    data = (dest/"depth-runtime.json").read_bytes()
    sample = json.loads(data)
    require((sample["status"],sample["nefSha256"],sample["manifestSha256"])==("PASS_SAMPLED",NEF,MANIFEST)
            and sample["engineSha256"]=="cb1b4db8076847dc23fda920ded773adaeeda07895effd350d2d8a99595a7f3a"
            and sample["vmSha256"]=="cea00a147add3c672bb23ffb5d98a4b1f31da135272efc258fee8fb7805bbfe9", "runtime drift")
    for row in sample["rows"]:
        name,arity,free = row["name"],row["arity"],row["free"]
        require((name,arity,free) in cases, "unexpected or duplicate case")
        cases.remove((name,arity,free))
        offset = ordinary[name,arity]
        require(row["limit"]==1024 and row["loaded"]==[offset,init][:free], "wrong loaded frames")
        require((row["state"]=="FAULT" and row["executed"]==0 and row["error"]=="MaxInvocationStackSize exceed: 1024")
                if free<2 else (row["state"]=="HALT" and row["executed"]>170 and row["error"] is None), "unexpected execution")
    require(not cases, "missing capacity cases")
    source_hashes = {}
    for method in ("VmLoadContext","LoadContract","LoadScript","CoreLoadContext"):
        key,header = HEADERS[method]
        pin = SOURCES[key]
        if key not in source_hashes:
            raw = mirror_source(key,pin) or download_pinned(source_url(pin))
            require(digest(raw)==pin["sha256"], "source drift")
            source_hashes[key] = raw
        require(body(source_hashes[key].decode("utf-8-sig"),header)==TEMPLATES[method], "frame construction differs")
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        models = {}
        for module in ("EntryDispatch","OrdinaryDepth"):
            model = (HERE/"coq"/(module+".v")).read_bytes()
            models[module] = digest(model)
            (work/(module+".v")).write_bytes(model)
            log = subprocess.check_output(["coqc","-q",module+".v"],cwd=work,text=True)
        require(log.count("Closed under the global context")==4 and "Axioms:" not in log,"open assumptions")
        subprocess.run(["coqchk","-silent","OrdinaryDepth"],cwd=work,check=True)
    receipt.write_text(json.dumps(dict(status="PASS_SCOPED",implementationVerified=False,coqchkPassed=True,
        ordinaryEntries=len(ordinary), runtimeCases=len(sample["rows"]), runtimeSha256=digest(data),
        nefSha256=NEF,manifestSha256=MANIFEST,modelHashes=models,sourceHashes={k:digest(v) for k,v in source_hashes.items()},
        scope="Invocation depth after admission only. Fault rows describe frames loaded before the limit check failed, not rollback or final ledger state."),
        indent=2)+"\n")


if __name__=="__main__":
    run()

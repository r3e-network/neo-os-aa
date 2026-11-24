"""Verify the canonical address call's fixed-price path and its local VM observations."""
import argparse
import hashlib
import json
from itertools import accumulate
from pathlib import Path
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent


def check(ok, message):
    if not ok:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(dll, fees, dispatch, out):
    out.mkdir(parents=True, exist_ok=True)
    report = out / "result.json"
    report.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    e = json.loads(fees.read_bytes())
    d = json.loads(dispatch.read_bytes())
    check(sha(dll) == e["assemblySha256"] == d["assemblySha256"], "mixed assemblies")
    core = bytes.fromhex("398dc3f0227d7efac5533ed5ce9937390c158084")
    account = bytes.fromhex(e["account"].removeprefix("0x"))
    check(len(account) == 20 and any(account) and e["core"] == "0x"+core.hex(), "identity")
    script = b"\x0c\x14"+account[::-1]+b"\x11\xc0\x11\x0c\x11getAccountAddress\x0c\x14"+core[::-1]+b"\x41\x62\x7d\x5b\x52"
    check(bytes.fromhex(e["script"]) == script, "different invocation")
    row, = (r for r in d["methods"] if r["name"] == "getAccountAddress")
    check(row["flags"] == 1 and row["cpu"] == 32768 and row["storage"] == 0, "different native fee")
    prices = [8, 1, 2048, 1, 8, 8, 32768, 1, row["cpu"]]
    check(e["prices"] == prices and type(e["factor"]) is int and e["factor"] > 0, "different price path")
    steps = list(accumulate(p*e["factor"] for p in prices))
    check(e["total"] == e["invalidFee"] == steps[-1] and e["deniedFee"] == steps[-2], "fee mismatch")
    budgets = sorted({0, steps[-1]+1, *steps, *(s-1 for s in steps)})
    expected = [dict(budget=b, charged=next((s for s in steps if s > b), steps[-1]),
                     state="HALT" if b >= steps[-1] else "FAULT") for b in budgets]
    check(e["cases"] == expected, "missing or incorrect budget boundary")
    h = e["huyao"]
    weights = [1685,2187,173+2649,2187,1685,1685,32768*1000,2187,row["cpu"]*1000,1085]
    scale = 10000000
    check(h["coefficients"] == weights and h["scale"] == scale and type(h["picoFactor"]) is int
          and h["picoFactor"] > 0, "Huyao coefficient or scale mismatch")
    thresholds = [(s*h["picoFactor"] + scale-1)//scale for s in accumulate(weights)]
    minimum = thresholds[-1]
    hb = sorted({0, minimum+1, *thresholds, *(t-1 for t in thresholds)})
    check(h["minimum"] == h["charged"] == minimum and h["cases"] ==
          [dict(budget=b, charged=next((s for s in thresholds if s>b), minimum),
                state="HALT" if b>=minimum else "FAULT") for b in hb], "Huyao fee or boundary mismatch")
    with tempfile.TemporaryDirectory(dir=out) as tmp:
        work = Path(tmp)
        for src in (HERE/"coq/PathFee.v", HERE/"ReceivingAddressFee.v"):
            shutil.copy(src, work)
            proc = subprocess.run(["coqc","-q",src.name], cwd=work, capture_output=True, text=True, check=True)
        check(proc.stdout.count("Closed under the global context") == 4, "open assumptions")
        subprocess.run(["coqchk","-silent","ReceivingAddressFee"], cwd=work, check=True)
        for old,new in (("[32768]", "[32767]"), ("[8;1;2048", "[8;1;1024"),
                        ("173+2649", "173+2648"), ("65551523 * pico + 9999999", "65551523 * pico + 0")):
            source = (HERE/"ReceivingAddressFee.v").read_text()
            check(source.count(old) == 1, "ambiguous mutation")
            (work/"Wrong.v").write_text(source.replace(old,new))
            bad = subprocess.run(["coqc","-q","Wrong.v"], cwd=work, text=True, capture_output=True)
            expected_error = "Cannot find witness" if new.endswith("+ 0") else "Unable to unify"
            check(bad.returncode != 0 and expected_error in bad.stderr, "ineffective mutation: "+bad.stderr)
    report.write_text(json.dumps(dict(status="PASS_SCOPED", implementationVerified=False, assemblySha256=sha(dll),
        runtimeSha256=sha(fees), dispatchSha256=sha(dispatch), theoremSha256=sha(HERE/"ReceivingAddressFee.v"),
        modelSha256=sha(HERE/"coq/PathFee.v"), coqchkPassed=True, mutationsRejected=4,
        fixedPriceBudgetCases=len(budgets), huyaoBudgetCases=len(hb), fixedPriceUnits=sum(prices),
        huyaoCoefficientSum=sum(weights), huyaoDenominator=scale, huyaoMinimum=minimum,
        boundary="Canonical non-whitelisted invocation, successful argument/handler path, no host overflow or "
                 "other fault. Fixed schedule uses integral fee factors; Huyao uses pico factors and rounds the "
                 "total once. Opcode prices, run statistics and VM correspondence are trusted."),
        indent=2)+"\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("assembly","fees","dispatch","output"):
        parser.add_argument("--"+name, type=Path, required=True)
    args = parser.parse_args()
    run(args.assembly,args.fees,args.dispatch,args.output)

"""Compare an isolated Core candidate to the pinned source and published runtime receipt."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
PROBE = HERE.parent / "presence-probe"
REPORT = HERE.parents[2] / "docs/reports/smartaccount-current-20261124"
CORE = "d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d"


def run(*cmd, **kwargs):
    return subprocess.run(cmd, check=True, **kwargs)


def check(ok, reason):
    if not ok:
        raise ValueError(reason)


def normalized(receipt):
    rows = receipt["result"]["rows"]
    return [{**row, "transactions": [
        {k: v for k, v in tx.items() if k != "ledgerState"}
        for tx in row["transactions"]]} for row in rows]


def compare(repo, out):
    published = json.loads((REPORT / "ordinary-pure/block-rollback.json").read_bytes())
    out.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    with tempfile.TemporaryDirectory(prefix="sa-ledger-") as temp:
        work = Path(temp).resolve()
        core = work / "core"
        core.mkdir()
        archive = work / "core.tar"
        run("git", "-C", repo, "archive", "-o", archive, CORE)
        run("tar", "-xf", archive, "-C", core)
        runner = work / "runner"
        runner.mkdir()
        for name in ("PresenceProbe.csproj", "packages.lock.json", "BlockRollback.cs"):
            shutil.copy(PROBE / name, runner / name)
        shutil.copy(HERE / "Compare.cs", runner)
        run("dotnet", "build", runner / "PresenceProbe.csproj", "-c", "Release",
            "-p:RestoreLockedMode=true", "-p:NuGetAudit=false", "-v:q")
        exe = runner / "bin/Release/net10.0"
        inputs = REPORT / "ordinary-entry/input"
        results = {}
        for mode in ("original", "candidate"):
            if mode == "candidate":
                run("git", "apply", HERE / "candidate.patch", cwd=core)
            run("dotnet", "build", core / "src/Neo/Neo.csproj", "-c", "Release",
                "-p:NuGetAudit=false", "-v:q")
            built = core / "src/Neo/bin/Release/net10.0/Neo.dll"
            shutil.copy(built, exe / "Neo.dll")
            output = work / (mode + ".json")
            run("dotnet", exe / "PresenceProbe.dll", inputs / "UnifiedSmartWalletV3.nef",
                inputs / "UnifiedSmartWalletV3.manifest.json", output)
            obs = json.loads(output.read_bytes())
            check(obs["engineSha256"] == hashlib.sha256(built.read_bytes()).hexdigest(), "wrong Core loaded")
            check(all(obs[k] == published[k] for k in ("vmSha256", "nefSha256", "manifestSha256")),
                  "runtime or contract input drift")
            check(normalized(obs) == normalized(published), "transaction, balance, fee or execution event drift")
            txs = [tx for row in obs["result"]["rows"] for tx in row["transactions"]]
            check(len(txs) == 13 and sum(tx["state"] == "HALT" for tx in txs) == 6 and
                  sum(tx["state"] == "FAULT" for tx in txs) == 7, "incomplete observations")
            candidate = mode == "candidate"
            check(obs["result"]["eventLedgerStateAgreement"] is candidate and
                  all(tx["ledgerState"] == (tx["state"] if candidate else "NONE") for tx in txs),
                  "unexpected ledger readback")
            results[mode] = obs
        check(results["original"]["engineSha256"] != results["candidate"]["engineSha256"], "identical engines")
        out.write_text(json.dumps(dict(status="PASS_SAMPLED", implementationVerified=False,
            sourceCommit=CORE, patchSha256=hashlib.sha256((HERE / "candidate.patch").read_bytes()).hexdigest(),
            **results), indent=2) + "\n")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("neo_checkout", type=Path)
    compare(p.parse_args().neo_checkout.resolve(), REPORT / "ordinary-pure/ledger-readback.json")

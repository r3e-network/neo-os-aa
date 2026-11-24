"""Check the two discovery CIL bodies against the current native protocol."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def check(condition, reason):
    if not condition:
        raise ValueError(reason)


def render(rows, version):
    lines = ['From Coq Require Import List NArith String. Require Import DiscoveryIL.',
             'Import ListNotations. Open Scope string_scope.']
    check([r["name"] for r in rows] == ["GetAccountImplementationId", "GetProtocolInfo"], "unexpected exports")
    for r in rows:
        name = r["name"]
        code = bytes.fromhex(r["il"])
        lines.append(f'Definition {name}_code : list nat := [' + ';'.join(str(b) for b in code) + '].')
        terms = {}
        for s in r["symbols"]:
            if s["kind"] == "text":
                check(re.fullmatch('[a-zA-Z0-9]+', s['value']), "unsupported identity literal")
                term = 'Text "' + s['value'] + '"'
            else:
                term = {"vmInt":"ToItem","singleton":"MakeSingleton","vmArray":"MakeArray"}[s["kind"]]
            check(s["token"] not in terms, "duplicate reference")
            terms[s["token"]] = term
        resolver = ''.join(f'if N.eqb token {t}%N then Some ({term}) else ' for t,term in terms.items())+"None"
        lines.append(f'Definition {name}_symbols (token:N) : option symbol := {resolver}.')
        expected = 'Str "NativeSmartAccount"' if name == "GetAccountImplementationId" else f'Array1 {version}'
        lines.extend([f'Theorem {name}_returns : eval {len(code)} {name}_symbols {name}_code [] = Some ({expected}).',
                      'Proof. vm_compute. reflexivity. Qed.', f'Print Assumptions {name}_returns.'])
    return '\n'.join(lines)+'\n'


def run(assembly, out):
    out.mkdir(parents=True, exist_ok=True)
    receipt = out/"result.json"
    receipt.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    parameters = (ROOT/"docs/proposals/smartaccount-native-profile-parameters.json").read_bytes()
    manifest = (ROOT/"tests/fixtures/native-smartaccount.manifest.json").read_bytes()
    spec = json.loads(parameters)
    abi = json.loads(manifest)
    version = spec["abiVersion"]
    check(type(version) is int and 0 <= version <= 8 and spec["protocolInfoFields"] == 1 and
          abi["extra"]["smartAccount"]["abiVersion"] == version, "unsupported protocol")
    for name, typ in (("getAccountImplementationId","String"), ("getProtocolInfo","Array")):
        m, = (m for m in abi["abi"]["methods"] if m["name"] == name)
        check(m["safe"] is True and m["parameters"] == [] and m["returntype"] == typ, "ABI mismatch")
    project = HERE/"native-discovery/NativeDiscovery.csproj"
    subprocess.run(["dotnet","build",str(project),"-p:RestoreLockedMode=true"],check=True)
    with tempfile.TemporaryDirectory(dir=out) as tmp:
        work = Path(tmp)
        # Pin the exact bytes used by both the PE and metadata readers.
        raw = assembly.read_bytes()
        (work/"Neo.dll").write_bytes(raw)
        subprocess.run(["dotnet",str(project.parent/"bin/Debug/net10.0/NativeDiscovery.dll"),
                        str(work/"Neo.dll"),str(work/"il.json")],check=True)
        exported = json.loads((work/"il.json").read_bytes())
        check(sha(raw) == exported["assemblySha256"], "extractor read different assembly")
        model = (HERE/"coq/DiscoveryIL.v").read_bytes()
        (work/"DiscoveryIL.v").write_bytes(model)
        cert = render(exported["methods"],version)
        (work/"NativeDiscoveryArtifact.v").write_text(cert)
        for name in ("DiscoveryIL", "NativeDiscoveryArtifact"):
            p = subprocess.run(["coqc","-q",name+".v"],cwd=work,text=True,capture_output=True)
            check(p.returncode == 0, p.stderr)
        check(p.stdout.count("Closed under the global context") == 2 and "Axioms:" not in p.stdout, "open assumptions")
        subprocess.run(["coqchk","-silent","NativeDiscoveryArtifact"],cwd=work,check=True)
        controls = []
        for label, before, after in (("wrong identity",'Text "NativeSmartAccount"','Text "OtherAccount"'),
                                     ("wrong version literal",f'GetProtocolInfo_code : list nat := [{22+version};',
                                      f'GetProtocolInfo_code : list nat := [{22+((version+1)%9)};'),
                                     ("wrong constructor mapping", "then Some (MakeArray)", "then Some (MakeSingleton)")):
            check(cert.count(before) == 1, "negative control missed its input")
            (work/"Incorrect.v").write_text(cert.replace(before,after))
            rejected = subprocess.run(["coqc","-q","Incorrect.v"],cwd=work,capture_output=True,text=True)
            check(rejected.returncode and "Unable to unify" in rejected.stderr, f"ineffective control: {label}")
            controls.append(label)
    (out/"NativeDiscoveryArtifact.v").write_text(cert)
    receipt.write_text(json.dumps(dict(**exported,status="PASS_SCOPED",implementationVerified=False,
        coqchkPassed=True,rejectedControls=controls,manifestSha256=sha(manifest),parametersSha256=sha(parameters),
        modelSha256=sha(model),certificateSha256=sha(cert.encode()),
        boundary="Direct parameterless CIL body return, successful allocations, trusted metadata reader and "
                 "three library operation summaries. Native dispatch, CLR/JIT correspondence, host metering, "
                 "activation and return marshalling are outside this theorem."),indent=2)+"\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assembly",required=True,type=Path)
    parser.add_argument("--output",required=True,type=Path)
    args = parser.parse_args()
    run(args.assembly,args.output)

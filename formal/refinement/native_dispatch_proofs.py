"""Check the local active SmartAccount native wrappers against the SDK-facing manifest."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

from native_discovery_proofs import ROOT, sha, check


def certify(args):
    out = args.output
    out.mkdir(parents=True, exist_ok=True)
    receipt = out/"result.json"
    receipt.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    raw = args.dispatch.read_bytes()
    exported = json.loads(raw)
    assembly = sha(args.assembly.read_bytes())
    check(assembly == exported["assemblySha256"], "different native DLL")
    manifest = (ROOT/"tests/fixtures/native-smartaccount.manifest.json").read_bytes()
    methods = json.loads(manifest)["abi"]["methods"]
    rows = exported["methods"]
    script = bytes.fromhex(exported["script"])
    check(len(rows) == len(methods) == 29 and len(script) == 7*len(rows), "incomplete export")
    check(len({r["pc"] for r in rows}) == len({r["handler"] for r in rows}) ==
          len({r["token"] for r in rows}) == len(rows), "ambiguous method binding")
    check(exported["deniedRuntimeCases"] == 311, "missing runtime checks")
    def vec(items):
        return "["+";".join(map(str,items))+"]"
    clr = {"Neo.SmartContract.ApplicationEngine":"Engine", "Neo.Persistence.IReadOnlyStore":"Snapshot",
           "Neo.UInt160":"Address", "Neo.UInt160[]":"Addresses", "System.Byte[]":"Bytes",
           "System.Byte[][]":"ByteArrays", "Neo.VM.Types.Array":"VMArray", "Neo.VM.Types.StackItem":"VMItem",
           "System.String":"Text", "System.Int32":"Int32", "System.Numerics.BigInteger":"BigInt",
           "System.Boolean":"Bit", "System.Void":"Unit"}
    abi = {"Hash160":"Hash160", "ByteArray":"ByteArray", "Array":"ArrayType", "Any":"AnyType",
           "String":"StringType", "Integer":"IntegerType", "Boolean":"BooleanType", "Void":"VoidType"}
    def returned(name):
        if name == "Neo.SmartContract.ContractTask":
            return "(Task Unit)"
        prefix = "Neo.SmartContract.ContractTask" + chr(96) + "1["
        if name.startswith(prefix) and name.endswith("]"):
            return "(Task "+clr[name[len(prefix):-1]]+")"
        return "(Direct "+clr[name]+")"
    def flag(b):
        check(type(b) is bool, "invalid host injection flag")
        return "true" if b else "false"
    wrapper = bytes([0x10,0x41])+hashlib.sha256(b"System.Contract.CallNative").digest()[:4]+bytes([0x40])
    source = ['''From Coq Require Import List NArith String Bool.
Import ListNotations. Open Scope string_scope.
Record row := mk { pc:nat; handler:string; need:N; cpu:N; storage:N; arity:nat }.
Fixpoint lookup (pos:nat) (xs:list row) := match xs with
| [] => None | x::rest => if Nat.eqb pos (pc x) then Some x else lookup pos rest end.
Fixpoint bytes_equal (a b:list nat) := match a,b with
| [],[] => true | x::xs,y::ys => andb (Nat.eqb x y) (bytes_equal xs ys) | _,_ => false end.
Definition wrapper : list nat := '''+vec(wrapper)+'.',
             'Definition script : list nat := '+vec(script)+'.']
    records = []
    for row in rows:
        check(re.fullmatch("[A-Za-z][A-Za-z0-9]*",row["handler"]), "invalid handler")
        check(type(row["arity"]) is int and row["arity"] >= 0, "invalid dispatch arity")
        records.append(f'mk {row["pc"]} "{row["handler"]}" {row["flags"]}%N {row["cpu"]}%N {row["storage"]}%N {row["arity"]}')
    source += ['Definition table := '+vec(records)+'.', '''
Definition valid_entry start target mask argc :=
  andb (bytes_equal (firstn 7 (skipn start script)) wrapper)
    (match lookup (S start) table with
     | Some r => andb (Nat.eqb (arity r) argc) (andb (String.eqb (handler r) target)
         (andb (N.eqb (need r) mask) (andb (N.eqb (cpu r) 32768) (N.eqb (storage r) 0))))
     | None => false end).
Definition admits (start f:nat) := match lookup (S start) table with
| Some r => N.eqb (N.land (N.of_nat f) (need r)) (need r) | None => false end.
Definition agree (start:nat) (allowed:list nat) :=
  forallb (fun f => Bool.eqb (admits start f) (existsb (Nat.eqb f) allowed)) (seq 0 16).
''']
    source.append(Path(__file__).with_name("NativeSignatureShape.v.in").read_text())
    shapes = []
    for r in rows:
        args = vec(clr[t] for t in r["handlerParameters"])
        routed = vec(clr[t] for t in r["dispatchParameters"])
        shapes.append(f'sigrow {r["pc"]} {args} {routed} {returned(r["handlerReturn"])} '
                      + flag(r["injectEngine"]) + " " + flag(r["injectSnapshot"]))
    source.append('Definition signatures := '+vec(shapes)+'.')
    for m in methods:
        name, start = m["name"], m["offset"]
        check(re.fullmatch("[a-z][a-zA-Z0-9]*",name), "invalid ABI name")
        handler = name[:1].upper()+name[1:]
        # ReadOnly = ReadStates | AllowCall; the immutable witness entry needs both.
        mask, allowed = (0, list(range(16))) if name in ("getProtocolInfo","getAccountImplementationId") else (
            (5, [5,7,13,15]) if name == "verify" else (1, list(range(1,16,2))) if m["safe"] else (15,[15]))
        source.append(f'''Example {name}_dispatch : valid_entry {start} "{handler}" {mask}%N {len(m["parameters"])} = true /\\
  valid_signature signatures {start+1} {vec(abi[p["type"]] for p in m["parameters"])} {abi[m["returntype"]]} = true /\\
  agree {start} {vec(allowed)} = true. Proof. vm_compute. auto. Qed.
Print Assumptions {name}_dispatch.''')
    certificate = "\n".join(source)+"\n"
    controls = {}
    with tempfile.TemporaryDirectory(dir=out) as temp:
        work = Path(temp)
        def compile(name, content):
            (work/(name+".v")).write_text(content)
            return subprocess.run(["coqc","-q",name+".v"],cwd=work,capture_output=True,text=True)
        p = compile("NativeDispatch",certificate)
        check(p.returncode == 0,p.stderr)
        check(p.stdout.count("Closed under the global context") == len(rows) and "Axioms:" not in p.stdout, "open assumptions")
        subprocess.run(["coqchk","-silent","NativeDispatch"],cwd=work,check=True)
        for label,old,new in (("wrong handler",'mk 1 "ApplyConfigurationActions" 15%N','mk 1 "ResetAccount" 15%N'),
                              ("weakened permission",'mk 1 "ApplyConfigurationActions" 15%N','mk 1 "ApplyConfigurationActions" 1%N'),
                              ("shifted pc",'mk 1 "ApplyConfigurationActions"','mk 2 "ApplyConfigurationActions"'),
                              ("wrong argument count",'mk 1 "ApplyConfigurationActions" 15%N 32768%N 0%N 2',
                               'mk 1 "ApplyConfigurationActions" 15%N 32768%N 0%N 3'),
                              ("swapped routed parameters","sigrow 1 [Engine;Address;VMArray] [Address;VMArray]",
                               "sigrow 1 [Engine;Address;VMArray] [VMArray;Address]"),
                              ("wrong wire type","valid_signature signatures 1 [Hash160;ArrayType]",
                               "valid_signature signatures 1 [ByteArray;ArrayType]"),
                              ("wrong task result","sigrow 1 [Engine;Address;VMArray] [Address;VMArray] (Task Unit)",
                               "sigrow 1 [Engine;Address;VMArray] [Address;VMArray] (Task Bit)"),
                              ("missing host injection","sigrow 1 [Engine;Address;VMArray] [Address;VMArray] (Task Unit) true",
                               "sigrow 1 [Engine;Address;VMArray] [Address;VMArray] (Task Unit) false")):
            check(certificate.count(old) == 1, "ambiguous mutation")
            bad = compile("Changed",certificate.replace(old,new))
            check(bad.returncode != 0 and "incomplete proof" in bad.stderr.lower(), "incorrect rejection: "+bad.stderr)
            controls[label] = "rejected"
    (out/"NativeDispatch.v").write_text(certificate)
    receipt.write_text(json.dumps(dict(status="PASS_SCOPED",implementationVerified=False, methods=len(methods),
        checkedArgumentCounts=len(methods),checkedSignatures=len(methods),
        checkedParameterSlots=sum(len(m["parameters"]) for m in methods),
        flagCombinations=16*len(methods),deniedRuntimeCases=exported["deniedRuntimeCases"],coqchkPassed=True,
        assemblySha256=assembly,dispatchSha256=sha(raw),manifestSha256=sha(manifest),
        certificateSha256=sha(certificate.encode()), controls=controls,
        boundary="Active local dispatch table, wrapper and metadata. Does not prove CLR dispatch code, "
                 "argument conversion, host charging, method bodies, activation or rollback."),indent=2)+"\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("assembly","dispatch","output"):
        parser.add_argument("--"+key,type=Path,required=True)
    certify(parser.parse_args())

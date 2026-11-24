"""Check the receiving-address script model against reviewed CIL and the engine readback."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CORE = "0x398dc3f0227d7efac5533ed5ce9937390c158084"
PINS = dict(zip(("SmartAccount.GetAccountAddress", "SmartAccount.RequireAccountId",
                 "SmartAccountProtocol.GetAccountAddress", "SmartAccountProtocol.RequireIdentity",
                 "SmartAccountProtocol.CreateVerificationScript", "SmartAccountProtocol.get_ServiceHash",
                 "ScriptBuilderExtensions.EmitDynamicCall", "Helper.ToScriptHash"), (
    "89c89d6c122c281ed7ce76a191f78892b3b7b728414ca4a7897acb713484e664",
    "dfb8df18f9cd8ee7c7486c5982dc742ba964cd255501c2ca1c742d3672661a78",
    "92a34684007ef73b26e268c54ef7ee9635041fa06eae2fb46d0137654b864fa7",
    "9f45ece33ae014c6ecb80b03cca6aee4ba37996eb6145b1a8d7496441a7081c5",
    "34adafcde0690c37ded82864a5e66b82a1ef91fb7735288cdf272bb6752c7656",
    "7a4c49e0e8d0e6390448a7d033f5a2d306ce5a88b42bfcf0266d9c4159d91688",
    "f9f183a0aa8a7639d45993ec4069e2f769e571a8ab471f4b506f5508c631648f",
    "8d7de6a1d9c6dcbebc4054627cffef072430b69a8eb06f3553b54310d0864688")))


def check(ok, message):
    if not ok:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def vec(items):
    return "[" + ";".join(map(str, items)) + "]"


def run(dll, vectors, out):
    out.mkdir(parents=True, exist_ok=True)
    receipt = out / "result.json"
    receipt.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    export = out / "methods.json"
    subprocess.run(["dotnet", "run", "--project", str(HERE/"native-discovery"), "-p:RestoreLockedMode=true",
                    "--", str(dll), str(export), "--receiving-address"], check=True)
    artifact = json.loads(export.read_bytes())
    evidence = json.loads(vectors.read_bytes())
    sha = digest(dll.read_bytes())
    check(evidence["assemblySha256"] == artifact["assemblySha256"] == sha and evidence["core"] == CORE,
          "different build or native service")
    subprocess.run(["node", str(ROOT/"scripts/check_native_receiving_addresses.cjs"), str(vectors)], check=True)
    methods = {".".join(m["id"].split(".")[-2:]): m for m in artifact["methods"]}
    check(len(methods) == len(artifact["methods"]) and methods.keys() == PINS.keys(), "wrong method roster")
    for key, method in methods.items():
        check(digest(json.dumps(method, sort_keys=True, separators=(",", ":")).encode()) == PINS[key],
              "review changed compiled instructions/metadata/handlers: " + key)
    build = {i["pc"]: i for i in methods["SmartAccountProtocol.CreateVerificationScript"]["instructions"]}
    # Positions and overload signatures come from the fail-closed method pins above.
    parts = {3: "Args", 16: "Flags", 24: "Method", 32: "Core", 49: "Syscall"}
    emit = methods["ScriptBuilderExtensions.EmitDynamicCall"]["instructions"]
    substitutions = {"ORDER": vec(parts[i["pc"]] for i in emit if i["pc"] in parts),
                     "METHOD": vec(build[19]["operand"].encode()),
                     "FLAG": str(int(build[24]["op"].removeprefix("ldc.i4."))),
                     "CORE": vec(bytes.fromhex(CORE[2:])[::-1])}
    template = (HERE/"ReceivingAddress.v.in").read_text()
    def render(fields):
        text = template
        for key, value in fields.items():
            text = text.replace("@" + key + "@", value)
        return text
    cert = render(substitutions)
    controls = {"flag": ("FLAG", "15"), "method": ("METHOD", vec(b"Verify")),
                "order": ("ORDER", "[Args;Method;Flags;Core;Syscall]"),
                "service endianness": ("CORE", vec(bytes.fromhex(CORE[2:])))}
    with tempfile.TemporaryDirectory(dir=out) as tmp:
        work = Path(tmp)
        def compile(name, text):
            (work/(name+".v")).write_text(text)
            return subprocess.run(["coqc", "-q", name+".v"], cwd=work, text=True, capture_output=True)
        ok = compile("ReceivingAddress", cert)
        check(ok.returncode == 0, ok.stderr)
        check(ok.stdout.count("Closed under the global context") == 6, "open theorem")
        subprocess.run(["coqchk", "-silent", "ReceivingAddress"], check=True, cwd=work)
        for name, (field, value) in controls.items():
            bad = compile("Incorrect", render({**substitutions, field: value}))
            check(bad.returncode and "Unable to unify" in bad.stderr, "ineffective negative control: " + name)
    (out/"ReceivingAddress.v").write_text(cert)
    receipt.write_text(json.dumps(dict(status="PASS_SCOPED", implementationVerified=False,
        assemblySha256=sha, extractedMethodsSha256=digest(export.read_bytes()),
        runtimeVectorsSha256=digest(vectors.read_bytes()), certificateSha256=digest(cert.encode()),
        compiledMethodCount=len(methods), coqDeclarations=6, rejectedControls=list(controls), coqchkPassed=True,
        boundary="CIL extraction, control-flow review and lowering are trusted. Assumes UInt160 equality/serialization, "
        "NeoVM push/pack/syscall encoders, native service identity, Hash160 and successful allocation/disposal. "
        "No CLR/JIT, hash collision, fee or rollback theorem."), indent=2)+"\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("assembly", "vectors", "output"):
        parser.add_argument("--"+name, type=Path, required=True)
    args = parser.parse_args()
    run(args.assembly.resolve(), args.vectors.resolve(), args.output.resolve())

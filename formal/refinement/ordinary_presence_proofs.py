"""Certify the three direct storage-presence getters on the original 100-entry artifact."""
import argparse
import gzip
import json
import re
import subprocess
import tempfile
from pathlib import Path

from ordinary_initializer_proofs import (HERE, INVENTORY, MANIFEST, NEF, bind, declared_slots,
                                         decode_nef, digest, octets, require)
from nef_decode import decode_script
from storage_view_source import load as load_storage_view
import ordinary_initializer_proofs as initializer

TARGETS = {
    "isExecutionActive": "UnifiedSmartWallet.Internal.cs",
    "hasPendingVerifierUpdate": "UnifiedSmartWallet.State.cs",
    "hasPendingHookUpdate": "UnifiedSmartWallet.State.cs",
}
MODELS = ("IntegerSemantics", "NumericCoercions", "StorageGetter", "StorageGetterVm", "StorageView")


def project(instructions):
    positions = {op["offset"]: i for i, op in enumerate(instructions)}
    simple = {"570101": "InitSlot 1 1", "78": "LdArg", "db30": "Convert 48", "8b": "Concat",
              "70": "StLoc 0", "68": "LdLoc 0", "419bf667ce": "GetContext",
              "41925de831": "StorageGet", "0b": "Push GNull", "98": "NotEqualIns", "40": "Ret"}
    terms = []
    for op in instructions:
        raw = bytes.fromhex(op["instructionHex"])
        if raw.hex() in simple:
            t = simple[raw.hex()]
        elif len(raw) == 1 and 0x58 <= raw[0] <= 0x5e:
            t = f"LdStatic {raw[0]-0x58}"
        elif len(raw) == 2 and raw[0] == 0x5f:
            t = f"LdStatic {raw[1]}"
        elif len(raw) == 2 and raw[0] == 0x22:
            t = f"Jump {positions[op['offset'] + int.from_bytes(raw[1:], 'little', signed=True)]}"
        else:
            raise ValueError(f"unsupported opcode at {op['offset']}")
        terms.append(t)
    return terms


def main(args):
    out = args.output
    out.mkdir(parents=True, exist_ok=True)
    receipt = out/"result.json"
    receipt.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    core = load_storage_view(args.core)
    raw = args.nef.read_bytes()
    inventory = gzip.decompress(args.inventory.read_bytes())
    require(digest(inventory) == INVENTORY, "wrong inventory")
    d = json.loads(inventory)
    methods, entry, script_hash = bind(raw, args.manifest.read_bytes(), NEF, MANIFEST)
    rows, hashes = declared_slots(d, args.sources)
    fields = {r["field"]: r for r in rows}
    nef = decode_nef(raw)
    ops = decode_script(nef["script"], len(nef["tokens"]))
    init_code = nef["script"][entry:]
    init_steps = len([op for op in ops if op["offset"] >= entry])
    init_certificate = initializer.render(init_code, init_steps, rows)
    join = ["""From Coq Require Import List.
Require Import CapMethodVm CapContext StorageGetter StorageGetterVm StorageView PresenceArtifact OrdinaryInitializerArtifact.
Import ListNotations. Open Scope nat_scope.
Definition byte_fields (values:list Value) i : option GVal :=
  match nth_error values i with Some (VBuffer b) => Some (GBytes b) | _ => None end.
Definition resume_getter fuel program store finish :=
  match finish with
  | InitReturned s => match init_slots s, init_stack s with
    | Some values, [VBytes account] =>
        StorageGetterVm.run fuel 0 program
          (machine [] [] [GBytes account] (byte_fields values) store [] (fun _ _ => GNull))
    | _,_ => Thrown end
  | _ => Thrown end."""]
    parts = ["""From Coq Require Import List.
Require Import StorageGetter StorageGetterVm StorageView.
Import ListNotations. Open Scope nat_scope.
Definition statics (i:nat) : option GVal := match i with"""]
    for i, r in enumerate(rows):
        if r["kind"] == "ByteArray":
            parts.append(f"| {i} => Some (GBytes {octets(r['value'])})")
    parts.append("| _ => None end.")
    results = {}
    for name, file in TARGETS.items():
        method, = (m for m in methods if m["name"] == name)
        start = method["offset"]
        require(method["safe"] and method["returntype"] == "Boolean" and method["parameters"] ==
                [{"name": "accountId", "type": "Hash160"}], f"{name}: ABI")
        debug, = (m for m in d["sourceMap"]["debug"]["methods"] if m["range"].startswith(f"{start}-"))
        end = int(debug["range"].split("-")[1])
        body = [i for i in ops if start <= i["offset"] <= end]
        require(body[-1]["offset"] == end and body[-1]["name"] == "RET", f"{name}: incomplete region")
        terms = project(body)
        raw_source = (args.sources/file).read_bytes()
        require(digest(raw_source) == hashes[file], "source drift")
        pattern = (r"\[Safe\]\s+public static bool " + name[0].upper() + name[1:] +
                   r"\(UInt160 accountId\)\s*\{\s*byte\[\] key = Helper\.Concat\((\w+), \(byte\[\]\)accountId\);"
                   r"\s*return Storage\.Get\(Storage\.CurrentContext, key\) != null;\s*\}")
        field, = re.findall(pattern, raw_source.decode("utf-8-sig"))
        prefix = fields[field]["value"]
        join.append(f"""Theorem {name}_from_initializer : forall hp account (store:storage),
  resume_getter {len(terms)} (fun pc => nth pc {name}_ops Unsupported) store
    (run_init {init_steps} OrdinaryInitializerArtifact.code (initializer_entry hp [VBytes account])) =
  Done (GBool (exists_at (store ({octets(prefix)} ++ account)))).
Proof. intros. rewrite init_exact. lazy.
  destruct (store ({octets(prefix)} ++ account)) eqn:E; simpl in E; rewrite ?E; reflexivity. Qed.
Corollary {name}_from_snapshot : forall hp account o b id,
  resume_getter {len(terms)} (fun pc => nth pc {name}_ops Unsupported) (visible o b id)
    (run_init {init_steps} OrdinaryInitializerArtifact.code (initializer_entry hp [VBytes account])) =
  Done (GBool (exists_at (visible o b id ({octets(prefix)} ++ account)))).
Proof. intros. apply {name}_from_initializer. Qed.
Print Assumptions {name}_from_snapshot.""")
        parts.append(f"""Definition {name}_ops : list Ins := [{'; '.join(terms)}].
Theorem {name}_exact : forall (sto:storage) (account:bytes),
  run {len(terms)} 0 (fun pc => nth pc {name}_ops Unsupported)
      (machine [] [] [GBytes account] statics sto [] (fun _ _ => GNull)) =
  Done (GBool (match sto ({octets(prefix)} ++ account) with Some _ => true | None => false end)).
Proof. intros sto account.
  lazy. destruct (sto ({octets(prefix)} ++ account)) eqn:E; simpl in E; rewrite ?E; reflexivity.
Qed.
Print Assumptions {name}_exact.
Definition {name}_read o b id account :=
  run {len(terms)} 0 (fun pc => nth pc {name}_ops Unsupported)
      (machine [] [] [GBytes account] statics (visible o b id) [] (fun _ _ => GNull)).
Theorem {name}_visible : forall o b id account, {name}_read o b id account =
  Done (GBool (exists_at (visible o b id ({octets(prefix)} ++ account)))).
Proof. intros. apply {name}_exact. Qed.
Theorem {name}_isolated : forall o b o' b' id account,
  o id ({octets(prefix)} ++ account) = o' id ({octets(prefix)} ++ account) ->
  b id ({octets(prefix)} ++ account) = b' id ({octets(prefix)} ++ account) ->
  {name}_read o b id account = {name}_read o' b' id account.
Proof. intros. rewrite !{name}_visible.
  now rewrite (key_isolation o b o' b' id _ H H0). Qed.
Print Assumptions {name}_visible.
Print Assumptions {name}_isolated.""")
        results[name] = dict(offset=start, end=end, prefix=prefix, field=field, byteCount=end-start+1,
                             instructionCount=len(body), bodySha256=digest(nef["script"][start:end+1]))
    certificate = "\n".join(parts)+"\n"
    joined = "\n".join(join)+"\n"
    with tempfile.TemporaryDirectory(dir=out) as tmp:
        work = Path(tmp)
        model_hashes = {}
        generated = {"PresenceArtifact":certificate, "OrdinaryInitializerArtifact":init_certificate, "InitializedPresence":joined}
        for name in (*dict.fromkeys((*MODELS, *initializer.MODELS)), *generated):
            data = generated[name].encode() if name in generated else (HERE/"coq"/(name+".v")).read_bytes()
            if name not in generated:
                model_hashes[name] = digest(data)
            (work/(name+".v")).write_bytes(data)
            with (out/(name+".log")).open("w") as log:
                subprocess.run(["coqc","-q",name+".v"], cwd=work, check=True, stdout=log, stderr=log)
        log = (out/"PresenceArtifact.log").read_text()
        require(log.count("Closed under the global context") == 3 * len(TARGETS) and "Axioms:" not in log,
                "open assumptions")
        joinlog = (out/"InitializedPresence.log").read_text()
        require(joinlog.count("Closed under the global context") == len(TARGETS) and "Axioms:" not in joinlog,
                "open composed assumptions")
        subprocess.run(["coqchk","-silent","InitializedPresence"], cwd=work, check=True)
        controls = []
        for name in TARGETS:
            # Change a valid load to another initialized byte-array slot. The
            # certificate must then fail on value semantics, not opcode shape.
            pattern = rf"(Definition {name}_ops : list Ins := \[InitSlot 1 1; LdStatic )\d+"
            bad, count = re.subn(pattern, r"\g<1>0", certificate)
            require(count == 1 and bad != certificate, "control missed its static load")
            (work/"WrongSlot.v").write_text(bad)
            p = subprocess.run(["coqc","-q","WrongSlot.v"],cwd=work,capture_output=True,text=True)
            require(p.returncode != 0 and "Unable to unify" in p.stderr, f"{name}: invalid control")
            controls.append(name)
    (out/"PresenceArtifact.v").write_text(certificate)
    (out/"OrdinaryInitializerArtifact.v").write_text(init_certificate)
    (out/"InitializedPresence.v").write_text(joined)
    receipt.write_text(json.dumps(dict(status="PASS_SCOPED", implementationVerified=False, methods=results,
        nefSha256=NEF, manifestSha256=MANIFEST, inventorySha256=INVENTORY, scriptSha256=script_hash,
        modelSha256=model_hashes, sourceSha256={file:hashes[file] for file in TARGETS.values()},
        certificateSha256=digest(certificate.encode()), coqchkPassed=True, wrongSlotRejected=controls,
        coreStorageView=core,
        initializerCertificateSha256=digest(init_certificate.encode()), joinedCertificateSha256=digest(joined.encode()),
        boundary="Storage.Get uses the resolved deployment ID and logical DataCache view. Assumes valid "
                 "key equality, backend reads, noninterfering callbacks, typed ABI argument and successful frame handoff. "
                 "Source shape checks do not prove CLR execution; no universal fee or rollback proof."),indent=2)+"\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("nef", "manifest", "inventory", "sources", "output", "core"):
        parser.add_argument("--"+key, type=Path, required=True)
    main(parser.parse_args())

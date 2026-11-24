"""Price discovery queries from the bound NEF and check the runtime trace at every sampled budget."""
import base64
import gzip
import json
import re
import subprocess
import tempfile
from pathlib import Path

from gas_trace import extract_fees, integer_price, pinned_sources
from nef_decode import decode_script
from ordinary_pure_proofs import INPUT, REPORT, HERE, NEF, MANIFEST, bind, digest, decode_nef, require

FOLDER = REPORT / "ordinary-pure"
WORDS = {"getAccountImplementationId": [], "supportsExecutionMode": ["single", "batch", "batch-atomic"],
         "supportsModuleType": ["validator", "verifier", "hook"]}


def symbolic(name, words, region, prices):
    positions = {i["offset"]:pc for pc,i in enumerate(region)}
    code = []
    for i in region:
        op = i["name"]
        if op in ("JMP","JMPIFNOT"):
            dest = i["offset"] + int.from_bytes(bytes.fromhex(i["operandHex"]), "little", signed=True)
            term = ("Go" if op=="JMP" else "BrFalse") + f" {positions[dest]}%nat"
        elif op == "PUSHDATA1":
            literal = bytes.fromhex(i["operandHex"]).decode("ascii")
            require(re.fullmatch(r"[\w.\-]+", literal), "unsupported literal")
            term = f'Lit "{literal}"'
        else:
            term = {"INITSLOT":"Start","LDARG0":"Arg","EQUAL":"Eqv","PUSHT":"Yes","RET":"Return"}[op]
        code.append(f"({term},{prices[op]}%N)")
    start = region[0]["offset"]
    def cost(arg):
        path, _ = method_path({i["offset"]:i for i in region}, start, arg)
        return sum(prices[i["name"]] for i in path)
    if words:
        expected = f"(Returned (Bit false),{cost(b'')}%N)"
        for word in reversed(words):
            expected = f'if equal "{word}" then (Returned (Bit true),{cost(word.encode())}%N) else {expected}'
        expected = f"if large then (Oversize,{cost(bytes(65537))}%N) else {expected}"
    else:
        expected = f'(Returned (Text "org.r3e.neo.aa.unified-smart-wallet.v3"),{cost(None)}%N)'
    params = " ".join(f"b{i}" for i in range(len(words)))
    lookup = "false"
    for i,word in reversed(list(enumerate(words))):
        lookup = f'if String.eqb s "{word}" then b{i} else {lookup}'
    equal = f"(fun s : string => {lookup})"
    arguments = " ".join(f'(String.eqb bytes "{w}")' for w in words)
    tactics = " ".join(f"destruct b{i};" for i in range(len(words)))
    return f"""Definition {name}_program : list (op*N) := [{';'.join(code)}].
Definition {name}_expected (large:bool) (equal:string->bool) : exit*N := {expected}.
Definition {name}_lookup {('('+params+':bool)') if words else ''} := {equal}.
Theorem {name}_any_input : forall (large {params}:bool),
 walk 24 0 {name}_program [] large ({name}_lookup {params}) 0 = {name}_expected large ({name}_lookup {params}).
Proof. intros. destruct large; {tactics} vm_compute; reflexivity. Qed.
Corollary {name}_any_bytes : forall bytes,
 let large := Nat.ltb 65536 (String.length bytes) in
 walk 24 0 {name}_program [] large ({name}_lookup {arguments}) 0 = {name}_expected large (String.eqb bytes).
Proof. intro bytes. cbv zeta. rewrite {name}_any_input. reflexivity. Qed.
Print Assumptions {name}_any_bytes.
Theorem {name}_trace_price : forall (large {params}:bool),
 let actual := trace 24 0 {name}_program [] large ({name}_lookup {params}) [] in
 (fst actual, units (snd actual)) = {name}_expected large ({name}_lookup {params}).
Proof. intros. destruct large; {tactics} vm_compute; reflexivity. Qed.
Definition {name}_body bytes :=
 trace 24 0 {name}_program [] (Nat.ltb 65536 (String.length bytes)) ({name}_lookup {arguments}) [].
Definition {name}_cost bytes := {name}_expected (Nat.ltb 65536 (String.length bytes)) (String.eqb bytes).
Lemma {name}_body_exact : forall bytes,
 (fst ({name}_body bytes), units (snd ({name}_body bytes))) = {name}_cost bytes.
Proof. intro bytes. unfold {name}_body, {name}_cost. rewrite {name}_trace_price. reflexivity. Qed.
Definition {name}_charges bytes :=
 List.app (prefix {str(bool(words)).lower()} bytes) (List.app (snd ({name}_body bytes)) (suffix (fst ({name}_body bytes)))).
Theorem {name}_whole_budget : forall bytes factor budget paid,
 let '(outcome,body_units) := {name}_cost bytes in
 settle factor budget 0 ({name}_charges bytes) = Paid paid <->
 let required := factor * (prefix_units {str(bool(words)).lower()} bytes + body_units + units (suffix outcome)) in
 required <= budget /\\ paid = required.
Proof. intros. pose proof ({name}_body_exact bytes) as E.
 destruct ({name}_cost bytes) as [o w]. cbn [fst snd] in E.
 inversion E; subst. unfold {name}_charges. rewrite settle_paid by lia.
 rewrite !units_append, prefix_exact. cbn [N.add]. rewrite N.add_assoc. reflexivity. Qed.
Print Assumptions {name}_whole_budget.
Corollary {name}_pico_budget : forall bytes rate budget paid,
 let '(outcome,body_units) := {name}_cost bytes in
 let total := rate * (prefix_units {str(bool(words)).lower()} bytes + body_units + units (suffix outcome)) in
 settle rate (budget * 10000) 0 ({name}_charges bytes) = Paid paid <->
 datoshi total <= budget /\\ paid = total.
Proof. intros. pose proof ({name}_whole_budget bytes rate (budget * 10000) paid) as H.
 destruct ({name}_cost bytes) as [o w]. cbv zeta in H |- *. rewrite datoshi_budget in H. exact H. Qed.
Print Assumptions {name}_pico_budget.
Lemma {name}_body_bound : forall large eq,
 snd ({name}_expected large eq) <= {196 if words else 10}.
Proof. intros l e. unfold {name}_expected. destruct l;
 repeat match goal with |- context [if ?cond then _ else _] => destruct cond end;
 vm_compute; discriminate || reflexivity. Qed.
Lemma {name}_cost_bound : forall b, snd ({name}_cost b) <= {196 if words else 10}.
Proof. intro b. unfold {name}_cost. apply {name}_body_bound. Qed.
Local Opaque {name}_body {name}_cost push_weight.
Lemma {name}_units_bound : forall bytes, units ({name}_charges bytes) <= {420663 if words else 414348}.
Proof. intro b. unfold {name}_charges. rewrite !units_append, prefix_exact.
 rewrite suffix_free, N.add_0_r.
 pose proof (f_equal (@snd exit N) ({name}_body_exact b)) as E.
 change (units (snd ({name}_body b)) = snd ({name}_cost b)) in E. rewrite E.
 change ({'push_weight b + 416371' if words else '414338'} + snd ({name}_cost b) <= {420663 if words else 414348}).
 change ({'push_weight b + 416371' if words else '414338'} + snd ({name}_cost b) <=
   {('4096 + 416371' if words else '414338')} + {196 if words else 10}).
 apply N.add_le_mono; [ {('apply N.add_le_mono; [apply push_ceiling | reflexivity]' if words else 'reflexivity')} | apply {name}_cost_bound ]. Qed.
Theorem {name}_readback : forall bytes rate budget prior, rate <= 1000000 ->
 prior + {1000000*(420663 if words else 414348)} <= max_long * 10000 ->
 let used := amount (settle rate (budget * 10000) prior ({name}_charges bytes)) in
 datoshi used <= max_long /\\ fee_readback used budget = datoshi used.
Proof. intros. apply (readback_headroom _ {420663 if words else 414348}); auto using {name}_units_bound. Qed.
Print Assumptions {name}_readback."""


def method_path(ops, start, arg):
    pc, path, stack = start, [], []
    while len(path) < 24:
        i = ops[pc]
        path.append(i)
        op, operand = i["name"], bytes.fromhex(i["operandHex"])
        pc += i["size"]
        if op == "INITSLOT":
            require(operand == b"\x00\x01", "unexpected slot count")
        elif op == "LDARG0": stack.append(arg)
        elif op == "PUSHDATA1": stack.append(operand)
        elif op == "PUSHT": stack.append(True)
        elif op == "EQUAL":
            rhs, lhs = stack.pop(), stack.pop()
            if isinstance(lhs, bytes) and len(lhs) > 65536:
                return path, None
            stack.append(lhs == rhs)
        elif op in ("JMPIFNOT", "JMP"):
            if op == "JMP" or not stack.pop():
                pc = i["offset"] + int.from_bytes(operand, "little", signed=True)
        elif op == "RET":
            require(len(stack) == 1, "bad return stack")
            return path, stack[0]
        else: raise ValueError("unsupported instruction: " + op)
    raise ValueError("path did not terminate")


def verify():
    receipt = FOLDER / "fees.json"
    receipt.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    raw = INPUT.with_suffix(".nef").read_bytes()
    methods, init, _ = bind(raw, INPUT.with_suffix(".manifest.json").read_bytes(), NEF, MANIFEST)
    n = decode_nef(raw)
    ops = {i["offset"]:i for i in decode_script(n["script"], len(n["tokens"]))}
    initializer = [i for pc,i in ops.items() if pc >= init]
    require(len(initializer) == 170 and initializer[-1]["name"] == "RET" and all(
        i["edges"] == [{"kind":"fallthrough","target":i["offset"]+i["size"]}] for i in initializer[:-1]), "initializer branches")
    sources = pinned_sources(extra={"Native/PolicyContract.cs":"bde31f8af6df23a66b563081ef4f866d80ffb318ce4a1b01d7289a12f14fea62"})
    policy = sources.pop("Native/PolicyContract.cs")
    require(all(s in policy for s in ("public const ulong MaxExecFeeFactor = 100;",
            "ApplicationEngine.FeeFactor * MaxExecFeeFactor : MaxExecFeeFactor", "value == 0 || value > maxValue"))
            and all(s in sources["ApplicationEngine.cs"] for s in ("BigInteger FeeFactor = 10000;",
            "_feeConsumed.DivideCeiling(FeeFactor)", "if (consumed > long.MaxValue)", "return (long)(_feeAmount / FeeFactor);")),
            "policy rate or readback rule differs")
    table = extract_fees(sources)
    expr, = re.findall(r'System_Contract_Call = Register\("System\.Contract\.Call", nameof\(CallContract\), '
                        r'([^,]+), CallFlags\.ReadStates \| CallFlags\.AllowCall\);', sources["ApplicationEngine.Contract.cs"])
    fixed = integer_price(expr)
    data = (FOLDER/"runtime-fees.json").read_bytes()
    runtime = json.loads(data)
    require(runtime["status"] == "PASS_SAMPLED" and (runtime["nefSha256"],runtime["manifestSha256"]) == (NEF,MANIFEST)
            and runtime["engineSha256"] == "cb1b4db8076847dc23fda920ded773adaeeda07895effd350d2d8a99595a7f3a"
            and runtime["vmSha256"] == "cea00a147add3c672bb23ffb5d98a4b1f31da135272efc258fee8fb7805bbfe9", "runtime identity")
    expected = {(name,label) for name,words in WORDS.items() for label in
                (words + ["empty","unknown","integer","bytes255","bytes256","bytes65535","limit","over limit"] if words else ["no argument"])}
    pico_data = (FOLDER/"runtime-fees-pico.json").read_bytes()
    pico = json.loads(pico_data)
    require(all(pico[k] == runtime[k] for k in ("status","nefSha256","manifestSha256","engineSha256","vmSha256"))
            and len(pico["rows"]) == len(expected), "fractional runtime identity or case count")
    pico_rows = {(r["name"],r["label"]): r for r in pico["rows"]}
    require(pico_rows.keys() == expected, "fractional runtime scenarios differ")
    max_data = (FOLDER/"runtime-fees-max.json").read_bytes()
    max_rt = json.loads(max_data)
    max_rows = {(r["name"],r["label"]): r for r in max_rt["rows"]}
    require(all(max_rt[k] == runtime[k] for k in ("status","nefSha256","manifestSha256","engineSha256","vmSha256"))
            and len(max_rt["rows"]) == len(expected) and max_rows.keys() == expected, "maximum rate runtime mismatch")
    flat_data = (FOLDER/"runtime-fees-fixed.json").read_bytes()
    flat_rt = json.loads(flat_data)
    flat_rows = {(r["name"],r["label"]): r for r in flat_rt["rows"]}
    require(all(flat_rt[k] == runtime[k] for k in ("status","nefSha256","manifestSha256","engineSha256","vmSha256"))
            and len(flat_rt["rows"]) == len(expected) and flat_rows.keys() == expected, "fixed fee runtime mismatch")
    flat_fees = dict(zip(WORDS, (0,12345,54321)))
    source = ["From Coq Require Import NArith List Lia String. Require Import PathFee QueryFee. Import ListNotations. Open Scope string_scope. Open Scope N_scope."]
    prices = table["opcodes"]
    def weights(names):
        return "[" + ";".join(str(prices[n]) for n in names) + "]"
    init_costs = [prices[i["name"]] for i in initializer]
    common = [prices[n] for n in ("PUSH0","PUSHDATA1","PUSHDATA1","SYSCALL")] + [fixed] + init_costs
    source.append(f"""Definition push_weight bytes := let n := N.of_nat (String.length bytes) in
 if n <=? 255 then {prices['PUSHDATA1']} else if n <=? 65535 then {prices['PUSHDATA2']} else {prices['PUSHDATA4']}.
Definition common_prefix : list N := [{';'.join(map(str,common))}].
Definition prefix (has_arg:bool) bytes := List.app
 (if has_arg then push_weight bytes :: {weights(['PUSH1','PACK'])} else {weights(['NEWARRAY0'])}) common_prefix.
Definition prefix_units (has_arg:bool) bytes := if has_arg then
 push_weight bytes + {sum(common)+prices['PUSH1']+prices['PACK']} else {sum(common)+prices['NEWARRAY0']}.
Lemma prefix_exact : forall h b, units (prefix h b) = prefix_units h b.
Proof. intros [] b; unfold prefix, prefix_units; cbn [List.app units]; reflexivity. Qed.
Definition suffix outcome : list N := match outcome with Returned _ => {weights(['RET'])} | _ => [] end.
Lemma suffix_free : forall o, units (suffix o) = 0. Proof. destruct o; reflexivity. Qed.
Lemma push_ceiling : forall b, push_weight b <= 4096.
Proof. intro b. unfold push_weight. generalize (N.of_nat (String.length b)). intro n.
 destruct (n <=? 255), (n <=? 65535); vm_compute; discriminate || reflexivity. Qed.""")
    for name,words in WORDS.items():
        start, = (m["offset"] for m in methods if m["name"]==name)
        region = []
        for pc,i in ops.items():
            if pc < start: continue
            region.append(i)
            if i["name"]=="RET": break
        source.append(symbolic(name, words, region, table["opcodes"]))
    results = []
    for r in runtime["rows"]:
        name,label = r["name"],r["label"]
        require((name,label) in expected, "unknown or duplicate case")
        expected.remove((name,label))
        driver = decode_script(gzip.decompress(base64.b64decode(r["scriptGzip"])), 0)
        arg = {"integer":7, "empty":b"", "unknown":b"other", "limit":bytes(65536),
               "over limit":bytes(65537)}.get(label, label.encode())
        if label.startswith("bytes"): arg = bytes(int(label[5:]))
        argop = ("PUSH7" if label=="integer" else "PUSHDATA1" if len(arg) <= 255 else
                 "PUSHDATA2" if len(arg) <= 65535 else "PUSHDATA4")
        shape = ([argop,"PUSH1","PACK"] if WORDS[name] else ["NEWARRAY0"]) + ["PUSH0","PUSHDATA1","PUSHDATA1","SYSCALL","RET"]
        require([i["name"] for i in driver] == shape and bytes.fromhex(driver[-4]["operandHex"]) == name.encode()
                and len(bytes.fromhex(driver[-3]["operandHex"])) == 20 and
                driver[-2]["operandHex"] == digest(b"System.Contract.Call")[:8], "wrong invocation")
        if WORDS[name] and isinstance(arg, bytes):
            require(driver[0]["operandHex"] == arg.hex(), "wrong argument")
        start, = (m["offset"] for m in methods if m["name"]==name)
        body, result = method_path(ops, start, arg)
        if isinstance(result, bytes): result = result.decode()
        require(result == r["expected"], "incorrect method result")
        steps = [(False,i) for i in driver[:-1]] + [(True,i) for i in initializer+body]
        if result is not None: steps.append((False,driver[-1]))
        costs = [[table["opcodes"][i["name"]]] + ([fixed] if not target and i["name"]=="SYSCALL" else [])
                 for target,i in steps]
        ws = [w for weights in costs for w in weights]
        total = sum(ws)
        def datoshi(p): return (p + 9999) // 10000
        for rate, observation, flat in ((300000,r,None),(300001,pico_rows[name,label],None),
                (1000000,max_rows[name,label],None),(300000,flat_rows[name,label],flat_fees[name])):
            require(observation["expected"] == result and gzip.decompress(base64.b64decode(observation["scriptGzip"])) ==
                    gzip.decompress(base64.b64decode(r["scriptGzip"])), "fractional driver differs")
            charges = [[rate*w for w in weights] for weights in costs]
            if flat is not None:
                charges = [[] if target else charge + ([flat*10000] if i["name"]=="SYSCALL" else [])
                           for (target,i),charge in zip(steps,charges)]
            exact = datoshi(sum(map(sum,charges)))
            require([s["budget"] for s in observation["samples"]] == [exact,exact-1,0], "missing fee boundary")
            for sample in [dict(observation,budget=100_00000000), *observation["samples"]]:
                used, points, exhausted = 0, [], False
                for (target,i),charge in zip(steps,charges):
                    points.append(f"{int(target)},{i['offset']},{i['opcode']},{datoshi(used)}")
                    for increment in charge:
                        used += increment
                        if used > sample["budget"]*10000:
                            exhausted = True
                            break
                    if exhausted: break
                cause = "Insufficient GAS" if exhausted else "maximum comparable size" if result is None else None
                require(sample["fee"] == datoshi(used) and sample["trace"].lower() == digest(";".join(points).encode()) and
                        sample["state"] == ("FAULT" if cause else "HALT") and
                        (cause in sample["error"] if cause else sample["error"] is None), f"{name}/{label}/{rate}: trace or outcome")
        key = name+"_"+label.replace(" ","_").replace("-","_")
        source.append(f"""Definition {key}_weights : list N := [{';'.join(map(str,ws))}].
Theorem {key}_budget : forall factor budget paid,
 settle factor budget 0 {key}_weights = Paid paid <->
 factor * {total} <= budget /\ paid = factor * {total}.
Proof. intros. rewrite settle_paid by lia. change (units {key}_weights) with {total}. reflexivity. Qed.
Print Assumptions {key}_budget.""")
        results.append(dict(method=name, case=label, units=total, outcome="comparison fault" if result is None else "return"))
    require(not expected, "missing cases")
    cert = "\n".join(source)+"\nPrint Assumptions exhausted_at_first_overrun.\nPrint Assumptions fixed_method_budget.\n"
    model = (HERE/"coq/PathFee.v").read_bytes()
    query = (HERE/"coq/QueryFee.v").read_bytes()
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for name,content in (("PathFee",model),("QueryFee",query),("PureFees",cert.encode())):
            (work/(name+".v")).write_bytes(content)
            log = subprocess.check_output(["coqc","-q",name+".v"], cwd=work, text=True)
        require(log.count("Closed under the global context")==len(results)+4*len(WORDS)+2 and "Axioms:" not in log, "open assumptions")
        subprocess.run(["coqchk","-silent","PureFees"],cwd=work,check=True)
    (FOLDER/"PureFees.v").write_text(cert)
    receipt.write_text(json.dumps(dict(status="PASS_SCOPED",implementationVerified=False,coqchkPassed=True,
        calls=len(results)*16, picoRates=[300000,300001,1000000], paths=results, runtimeSha256=digest(data),
        fixedRateRuntimeSha256=digest(flat_data), methodFixedFees=flat_fees,
        maxRateRuntimeSha256=digest(max_data), policySourceSha256=digest(policy.encode()),
        fractionalRuntimeSha256=digest(pico_data), modelSha256=digest(model),
        certificateSha256=digest(cert.encode()), queryFeeModelSha256=digest(query), nefSha256=NEF,manifestSha256=MANIFEST,
        priceSources=table["sourceHashes"], priceCommit=table["sourceCommit"],
        scope="Whole canonical driver budget threshold for any admitted byte string, using the specified PUSHDATA width and the extracted initializer and method path. "
              "Paid includes comparison faults. For an ordinary caller and a fixed-price target, the separate fixed_method_budget theorem covers the metered driver followed by the fixed charge. "
              "No general proof of call-frame exemption propagation, script admission, other VM resource limits or arbitrary outer scripts."),indent=2)+"\n")


if __name__ == "__main__":
    verify()

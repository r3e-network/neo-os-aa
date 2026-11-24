"""Prove the scalar reference peak through initialization, query execution and RET."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from ordinary_initializer_references import INPUT, REPORT, VM, certificate, project
from ordinary_initializer_proofs import HERE, MANIFEST, MODELS, NEF, bind, decode_nef, decode_script, digest, require
from ordinary_pure_fees import WORDS, method_path
from public_pure_proofs import NORMALIZE


def render(methods, final):
    parts = ["""From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import InitializerReferences CapMethodVm PublicPureMethods QueryReferences ReferenceArtifact.
Import ListNotations. Open Scope Z_scope.
""", NORMALIZE, """Ltac count_drive := repeat first [progress pure_norm
 | progress cbv [roots] in *
 | multimatch goal with H : ?lhs = ?rhs |- _ => progress rewrite H end
 | match goal with |- context[Z.to_nat ?z] => let n := eval vm_compute in (Z.to_nat z) in progress change (Z.to_nat z) with n end
 | rewrite counts_unroll]."""]
    for name, body in methods.items():
        words = WORDS[name]
        a = int(bool(words))
        n = final + 1 + a
        code = ';'.join(f'{b}%nat' for b in body)
        parts.append(f'Definition {name}_bytes := [{code}].')
        parts.append(f'''Definition {name}_counts (x:option (list nat)) sf hp st :=
  checked_counts 24 {name}_bytes (last counts_after 0%nat) {a}
    (initial_public {('[match x with Some b => VBytes b | None => VNull end]' if a else '[]')} sf hp st).
Theorem {name}_body_peak : forall x sf hp st,
 fold_right Nat.max 0%nat ({name}_counts x sf hp st) = {n}%nat.
Proof. intros. unfold {name}_counts, {name}_bytes. rewrite final_usage.''')
        if words:
            parts.append('destruct x as [bytes|]; [ | count_drive; reflexivity ].')
            for term in ['0 <? 65536', *(f'Z.of_nat {size} <=? 65536' for size in sorted(set(map(len, words))))]:
                parts.append(f'assert (({term}) = true) by (vm_compute; reflexivity).')
            parts.append('destruct (Z.of_nat (length bytes) <=? 65536) eqn:Esize.')
            for i, w in enumerate(words):
                parts.append('all: destruct (bytes_eqb bytes ['+';'.join(f'{b}%nat' for b in w.encode())+f']) eqn:E{i}.')
        parts.append(f'''all: count_drive; reflexivity. Qed.
Theorem {name}_through_return : forall x sf hp st base limit, (base <= limit)%nat ->
 (fits base limit (counts_after ++ {name}_counts x sf hp st) = true <-> (base + {n} <= limit)%nat).
Proof. intros. rewrite fit_iff_peak by assumption.
 rewrite peak_app, peak, {name}_body_peak. reflexivity. Qed.
Print Assumptions {name}_through_return.''')
    return '\n'.join(parts)+'\n'


def application_trace(d, runtime, artifact, pins):
    engine = 'cb1b4db8076847dc23fda920ded773adaeeda07895effd350d2d8a99595a7f3a'
    path = d/'application.json'
    app_project = HERE/'presence-probe/PresenceProbe.csproj'
    subprocess.run(['dotnet', 'run', '--project', str(app_project), '-p:RestoreLockedMode=true', '--',
                    str(artifact.with_suffix('.nef')), str(artifact.with_suffix('.manifest.json')),
                    str(path), '--query-references'], check=True)
    data = json.loads(path.read_bytes())
    require((data['status'],data['engineSha256'],data['vmSha256'],data['nefSha256'],data['manifestSha256']) ==
            ('PASS_SAMPLED', engine, VM, *pins), 'application runtime/input mismatch')
    def key(r):
        return r['name'],r['arg'],r['free']
    cases = {key(r):r for r in runtime['rows']}
    for r in data['rows']:
        case = key(r)
        require(case in cases, 'duplicate or unknown application case')
        ref = cases.pop(case)
        before = r['before']
        baseline = runtime['limit']-r['free']
        require(before and before[0][1] == baseline, 'wrong first instruction baseline')
        after = [pair[1] for pair in before[1:]]+[r['terminalCount']]
        require([[pair[0],n-baseline] for pair,n in zip(before,after)] == ref['points'] and
                (r['result'],r['error']) == (ref['result'],ref['error']), f'application diverged: {case}')
    require(not cases, 'missing application executions')
    return path.read_bytes(), engine


MAIN = ('c634ab9821c83bdb53b342d64359183cff2b917ac2dc5bdd9b57613494d09b4b',
        '24c4710a8ac00a3df236d2a08509726dbe2745174abf833dd52e26d89b03b1b4')


def run(out, target, work, compiled):
    pins = MAIN if target=='main' else (NEF,MANIFEST)
    revision = None
    artifact = INPUT
    if target == 'main':
        revision = subprocess.check_output(['git','rev-parse','origin/main'],cwd=HERE,text=True).strip()
        artifact = work/'SmartAccount'
        for ext in ('.nef','.manifest.json'):
            artifact.with_suffix(ext).write_bytes(subprocess.check_output(
                ['git','show',revision+':contracts/build/SmartAccount'+ext],cwd=HERE))
    out.mkdir(parents=True, exist_ok=True)
    receipt = out/'result.json'
    receipt.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    nef, manifest = artifact.with_suffix('.nef').read_bytes(), artifact.with_suffix('.manifest.json').read_bytes()
    abi, init, script_hash = bind(nef, manifest, *pins)
    parsed = decode_nef(nef)
    script, ntokens = parsed['script'], len(parsed['tokens'])
    init_ops = decode_script(script[init:], ntokens)
    actions, heights = project(init_ops)
    offsets = {m['name']:m['offset'] for m in abi if m['name'] in WORDS}
    require(offsets.keys() == WORDS.keys() and max(heights) == heights[-1]+1, 'entry binding')
    for m in (m for m in abi if m['name'] in offsets):
        words = WORDS[m['name']]
        require(m['safe'] and [p['type'] for p in m['parameters']] == (['String'] if words else [])
                and m['returntype'] == ('Boolean' if words else 'String'), 'query ABI drift')
    ops = {i['offset']:i for i in decode_script(script, ntokens)}
    bodies = {name:script[pc:min(m['offset'] for m in abi if m['offset'] > pc)] for name,pc in offsets.items()}
    init_cert = certificate(actions, script[init:], max(heights), heights[-1])
    query_cert = render(bodies, heights[-1])
    code = {n:(HERE/'coq'/(n+'.v')).read_bytes() for n in
            (*MODELS, 'PublicPureMethods', 'InitializerReferences', 'QueryReferences')}
    code.update(ReferenceArtifact=init_cert.encode(), QueryArtifact=query_cert.encode())
    project_file = HERE/'initializer-probe/InitializerProbe.csproj'
    probe = project_file.parent/'bin/Debug/net10.0/InitializerProbe.dll'
    subprocess.run(['dotnet','build',str(project_file),'-p:RestoreLockedMode=true','--nologo'],check=True)
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d/'script').write_bytes(script)
        runtime = json.loads(subprocess.check_output(['dotnet',str(probe),'--query-limits',str(d/'script'),
                                                     str(artifact.with_suffix('.manifest.json')),str(heights[-1])]))
        require((runtime['limit'], runtime['vmSha256'], runtime['manifestSha256'], runtime['scriptSha256'])
                == (2048, VM, pins[1], script_hash), 'VM/input drift')
        targets = {(name,arg,free) for name,words in WORDS.items()
                   for arg in ([*words,'',None,'bytes:65536','bytes:65537'] if words else [None]) for free in range(heights[-1],heights[-1]+4)}
        for row in runtime['rows']:
            name,arg,free = key = row['name'],row['arg'],row['free']
            require(key in targets, 'missing/duplicated query path')
            targets.remove(key)
            data = bytes(int(arg[6:])) if arg and arg.startswith('bytes:') else (arg.encode() if arg is not None else None)
            path, result = method_path(ops, offsets[name], data)
            expected = [[init+i['offset'],v] for i,v in zip(init_ops,heights)]
            h = heights[-1]
            for i in path:
                op = i['name']
                if op == 'EQUAL' and result is None:
                    h -= 2  # both operands were popped before the exception; no Boolean was pushed
                elif op == 'RET':
                    h = 1-int(bool(WORDS[name]))
                else:
                    h += {'INITSLOT':0,'LDARG0':1,'PUSHDATA1':1,'EQUAL':-1,'JMPIFNOT':-1,'JMP':0,'PUSHT':1}[op]
                expected.append([i['offset'],h])
            bad = next((i for i,(_,v) in enumerate(expected) if v>free),None)
            message = None if bad is None else f'MaxStackSize exceed: {2048-free+expected[bad][1]}/2048'
            if result is None and bad is None:
                message = 'The operand exceeds the maximum comparable size, 65537/65536.'
            value = (result.decode() if isinstance(result, bytes) else str(result).lower()) if message is None else None
            require(row['points']==(expected if bad is None else expected[:bad+1]) and
                    row['result']==value and row['error']==message, f'query reference mismatch: {key}')
        require(not targets,'missing query observations')
        app_data, engine = application_trace(d,runtime,artifact,pins)
        for name,data in code.items():
            if name not in ('ReferenceArtifact', 'QueryArtifact') and compiled.get(name)==digest(data):
                continue
            (work/(name+'.v')).write_bytes(data)
            p = subprocess.run(['coqc','-q',name+'.v'],cwd=work,capture_output=True,text=True)
            require(p.returncode==0, f'{name}: {p.stdout[-1000:]} {p.stderr[-2200:]}')
            compiled[name] = digest(data)
            if name=='QueryArtifact':
                require(p.stdout.count('Closed under the global context')==3 and 'Axioms:' not in p.stdout,'open assumption')
        subprocess.run(['coqchk','-silent','QueryArtifact'],cwd=work,check=True)
    (out/'application.json').write_bytes(app_data)
    (out/'QueryArtifact.v').write_text(query_cert)
    (out/'ReferenceArtifact.v').write_text(init_cert)
    observed = json.dumps(runtime,separators=(',',':'))+'\n'
    (out/'runtime.json').write_text(observed)
    receipt.write_text(json.dumps(dict(status='PASS_SCOPED', implementationVerified=False, target=target, gitRevision=revision, abiEntries=len(abi), initializerInstructions=len(init_ops),
        initializerPeak=max(heights), initializerFinal=heights[-1], nefSha256=pins[0], manifestSha256=pins[1], scriptSha256=script_hash, vmSha256=VM, probeDllSha256=digest(probe.read_bytes()),
        checkerSha256=digest(Path(__file__).read_bytes()), modelSha256={k:digest(v) for k,v in code.items()},
        probeSourceSha256={p.name:digest(p.read_bytes()) for p in [project_file, project_file.parent/'packages.lock.json',
            *sorted(project_file.parent.glob('*.cs'))]}, applicationEngineSha256=engine,
        applicationProbe={p.name:digest(p.read_bytes()) for p in (HERE/'presence-probe').iterdir()
                          if p.suffix in ('.cs','.csproj') or p.name=='packages.lock.json'},
        applicationTraceSha256=digest(app_data), applicationCases=len(runtime['rows']),
        rocq=subprocess.check_output(['coqc','--version'],text=True).strip(), coqchkPassed=True, runtimeSha256=digest(observed.encode()), runtimeCases=len(runtime['rows']),
        requiredFreeReferences={k:heights[-1]+1+int(bool(WORDS[k])) for k in bodies},
        scope='Post-instruction reference limit for scalar bytes/null from fresh initializer to method return, '
              'or the last successful instruction before a comparison exception. Separate caller context, '
              'successful frame construction, no gas or other interfering faults. No CLR/VM universal correspondence.'),indent=2)+'\n')


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--target', choices=('main','archive','both'), default='both')
    p.add_argument('--output-root',type=Path,default=REPORT)
    args=p.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        compiled={}
        for target in (('main','archive') if args.target=='both' else (args.target,)):
            folder = 'main-query-references' if target=='main' else 'ordinary-query-references'
            run(args.output_root/folder,target,Path(tmp),compiled)

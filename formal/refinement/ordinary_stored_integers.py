"""Check signed storage reads and delayed additions on remote and archived ordinary artifacts."""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path

from ordinary_initializer_proofs import HERE, MODELS, bind, decode_nef, decode_script, digest, octets, require
from ordinary_query_references import INPUT, MAIN, MANIFEST, NEF, REPORT, VM
from storage_getter_proofs import render_vm_program

FIELDS = {'getMarketEscrowListingId': 7, 'getAdminTransferAvailableAt': 22, 'getPlatformRegistrarAvailableAt': 25}
DELAY = 604800000
ENGINE = 'cb1b4db8076847dc23fda920ded773adaeeda07895effd350d2d8a99595a7f3a'
HEADER = '''From Coq Require Import ZArith List Bool.
Require Import IntegerSemantics CapMethodVm CapContext StorageGetter StorageGetterVm.
Import ListNotations. Open Scope Z_scope.
Definition lookup_slot (s:InitOutcome) (i:nat) :=
 match s with InitReturned r => match init_slots r with
 | Some xs => nth_error xs i | _ => None end | _ => None end.
Definition expected (payload:option bytes) (delay:Z) :=
 match payload with None => Done (GInt 0)
 | Some b => match NumericCoercions.byte_string_integer b with
 | Some z => match checked_integer (z + delay) with Some v => Done (GInt v) | None => Thrown end
 | None => Thrown end end.
Definition expected_read (payload:option bytes) :=
 match payload with None => Done (GInt 0) | Some b => match NumericCoercions.byte_string_integer b with
 | Some z => Done (GInt z) | None => Thrown end end.
Definition read_field (s:InitOutcome) i :=
 match lookup_slot s i with Some (VBuffer b) => Some (GBytes b)
 | Some (VInt z) => Some (GInt z) | _ => None end.
Local Opaque integer_fitsb.
'''


def theorem(name, region, init_steps):
    terms, _ = render_vm_program(region)
    listing = name == 'getMarketEscrowListingId'
    slots = [int(t.split()[1]) for t in terms if t.startswith('LdStatic ')]
    prefix = FIELDS[name]
    require(len(slots) == (1 if listing else 2), 'unexpected static accesses')
    args = '[VBytes account]' if listing else '[]'
    key = f'({prefix}%nat :: account)' if listing else f'[{prefix}%nat]'
    expected = f'expected_read (store {key})' if listing else f'expected (store {key}) {DELAY}'
    checks = [(slots[0], f'GBytes [{prefix}%nat]')]
    if not listing:
        checks.append((slots[1], f'GInt {DELAY}'))
    code = f'''Definition {name}_ops : list Ins := [{';'.join(terms)}].
Definition {name}_init hp (account:bytes) := run_init {init_steps} init_code (initializer_entry hp {args}).
'''
    for i, v in checks:
        code += f'''Lemma {name}_slot{i} : forall hp account,
 read_field ({name}_init hp account) {i} = Some ({v}).
Proof. intros; vm_compute; reflexivity. Qed.
'''
    code += f'''Theorem {name}_result : forall hp (account:bytes) (store:storage),
 run {len(terms)} 0 (fun pc => nth pc {name}_ops Unsupported)
 (machine [] [] {('[GBytes account]' if listing else '[]')} (read_field ({name}_init hp account)) store [] (fun _ _ => GNull))
 = {expected}.
Proof. intros hp account store.
'''
    # Rewrite the symbolic lookup before reducing the opaque initializer.
    code += f' remember (read_field ({name}_init hp account)) as fields eqn:F.\n'
    for i, v in checks:
        code += f' assert (H{i}: fields {i}%nat = Some ({v})) by (rewrite F; apply {name}_slot{i}).\n'
    code += f''' clear F. destruct (store {key}) as [b|] eqn:Hstore.
 - destruct (NumericCoercions.byte_string_integer b) as [z|] eqn:E.
   1: assert (D: decode_integer b = OK (GInt z)) by (unfold decode_integer; rewrite E; reflexivity).
   2: assert (D: decode_integer b = Fault) by (unfold decode_integer; rewrite E; reflexivity).
'''
    # Do not use unrestricted lazy normalization: it would expand symbolic byte lists.
    code += '   all: '+('try destruct (integer_fitsb (z + 604800000)) eqn:B; ' if not listing else '')+'unfold expected, expected_read, checked_integer; unfold '+name+'_ops;\n'
    drive = '''repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
       mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gbytes_eqb gval_eqb negb Nat.eqb andb]
       | multimatch goal with H : ?l = ?r |- _ => progress rewrite H end
       | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end]; reflexivity.'''
    code += '   '+drive+'\n - unfold expected, expected_read, '+name+'_ops; '+drive+'\nQed.\nPrint Assumptions '+name+'_result.\n'
    return code


def check_trace(rows, regions):
    max_int = 2**255-1
    inputs = [None,b'',b'\x01\0',b'\0\x01',b'\0\x80',b'\x80\0',b'\xff\xff',bytes(32),
              max_int.to_bytes(32,'little'),(1<<255).to_bytes(32,'little'),(max_int-DELAY).to_bytes(32,'little'),
              (max_int-DELAY+1).to_bytes(32,'little'),bytes(33),b'\xff'*33]
    remaining = {(name,b) for name in FIELDS for b in inputs}
    for r in rows:
        n, b = r['name'], None if r['input'] is None else bytes.fromhex(r['input'])
        remaining.remove((n,b))
        value = 0 if b is None else int.from_bytes(b,'little',signed=True) + (DELAY if FIELDS[n]!=7 else 0)
        fault = 'CONVERT' if b is not None and len(b)>32 else ('ADD' if value>max_int else None)
        if fault:
            pc, = [i['offset'] for i in regions[n] if i['name']==fault and (fault!='CONVERT' or i['operandHex']=='21')]
            require((r['state'],r['value'],r['pc'])==('FAULT',None,pc) and
                    ('33/32' if fault=='CONVERT' else 'Integer size 33 bytes') in r['error'], f'wrong fault: {r}')
        else:
            require((r['state'],r['value'],r['error'])==('HALT',str(value),None), f'wrong result: {r}')
    require(not remaining, 'missing engine cases')


def input_hashes():
    names = ('ordinary_stored_integers.py', 'ordinary_query_references.py',
             'ordinary_initializer_proofs.py', 'ordinary_entry_proofs.py', 'nef_decode.py', 'verify.py',
             'storage_getter_proofs.py', 'presence-probe/StoredIntegerCalls.cs',
             'presence-probe/Program.cs', 'presence-probe/PresenceProbe.csproj',
             'presence-probe/packages.lock.json')
    return {name: digest((HERE/name).read_bytes()) for name in names}


def verify(out):
    out.mkdir(parents=True, exist_ok=True)
    receipt=out/'result.json'
    receipt.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    inputs = input_hashes()
    results={}
    with tempfile.TemporaryDirectory() as tmp:
        d=Path(tmp)
        models={}
        for n in [*MODELS, 'NumericCoercions','StorageGetter','StorageGetterVm']:
            data=(HERE/'coq'/(n+'.v')).read_bytes()
            (d/(n+'.v')).write_bytes(data)
            subprocess.run(['coqc','-q',n+'.v'],cwd=d,check=True,stdout=subprocess.DEVNULL)
            models[n]=digest(data)
        revision=subprocess.check_output(['git','rev-parse','origin/main'],cwd=HERE,text=True).strip()
        for target, pins in [('archive',(NEF,MANIFEST)), ('main',MAIN)]:
            stem=INPUT if target=='archive' else d/'SmartAccount'
            if target=='main':
                for ext in ('.nef','.manifest.json'):
                    stem.with_suffix(ext).write_bytes(subprocess.check_output(['git','show',revision+':contracts/build/SmartAccount'+ext],cwd=HERE))
            paths=[stem.with_suffix(ext) for ext in ('.nef','.manifest.json')]
            nef, manifest=[p.read_bytes() for p in paths]
            abi,init,_=bind(nef,manifest,*pins)
            raw=decode_nef(nef);script=raw['script'];ops=decode_script(script,len(raw['tokens']))
            init_steps=sum(i['offset']>=init for i in ops)
            cert=HEADER+'Definition init_code : list nat := '+octets(script[init:])+'.\n'
            regions={}
            for n,prefix in FIELDS.items():
                m,=[m for m in abi if m['name']==n]
                require(m['safe'] and m['returntype']=='Integer' and [p['type'] for p in m['parameters']]==(['Hash160'] if prefix==7 else []),'unexpected ABI')
                # Each body here is a single forward DAG ending at its first RET.
                region=[]
                for i in ops:
                    if i['offset']<m['offset']:continue
                    region.append(i)
                    if i['name']=='RET':break
                require(region[-1]['name']=='RET','missing terminal RET')
                cert+=theorem(n,region,init_steps);regions[n]=region
            proof=d/'StorageReads.v';proof.write_text(cert)
            p=subprocess.run(['coqc','-q',proof.name],cwd=d,capture_output=True,text=True)
            require(p.returncode==0 and p.stdout.count('Closed under the global context')==3 and 'Axioms:' not in p.stdout, p.stderr[-3000:] or 'open theorem')
            subprocess.run(['coqchk','-silent','StorageReads'],cwd=d,check=True)
            trace=d/'runtime.json'
            subprocess.run(['dotnet','run','--project',str(HERE/'presence-probe'),'-p:RestoreLockedMode=true','--',*map(str,paths),str(trace),'--stored-integers'],check=True)
            obs=json.loads(trace.read_bytes())
            require((obs['nefSha256'],obs['manifestSha256'],obs['engineSha256'],obs['vmSha256'])==(*pins,ENGINE,VM),'engine/artifact mismatch')
            check_trace(obs['rows'],regions)
            (out/(target+'.v')).write_text(cert);(out/(target+'.json')).write_bytes(trace.read_bytes())
            results[target]=dict(abiEntries=len(abi),nefSha256=pins[0],manifestSha256=pins[1],methods=list(regions),
                                 kernelChecked=True,calls=len(obs['rows']),certificateSha256=digest(cert.encode()),runtimeSha256=digest(trace.read_bytes()))
    require(inputs == input_hashes() and all(digest((HERE/'coq'/(n+'.v')).read_bytes()) == h for n,h in models.items()),
            'proof inputs changed during verification')
    receipt.write_text(json.dumps(dict(status='PASS_SCOPED',implementationVerified=False,remoteMain=revision,targets=results,
        models=models,sources=inputs,
        scope='Post-admission getter bodies under the storage-lookup and VM instruction model, initialized prefix and delay slots, signed conversion and addition. No arbitrary invocation, GAS, rollback, JIT or node refinement.'),indent=2)+'\n')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=REPORT/'stored-integers')
    verify(parser.parse_args().output)

"""Certify five address-returning getter bodies against each pinned ordinary NEF."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from ordinary_stored_integers import (HEADER, HERE, INPUT, MAIN,
    MANIFEST, MODELS, NEF, REPORT, bind, decode_nef, decode_script, digest, octets,
    render_vm_program, require)

PREFIX = {'getContractAdmin': 0x11, 'getPendingContractAdmin': 0x15,
          'getPlatformRegistrar': 0x17, 'getPendingPlatformRegistrar': 0x18,
          'getMarketEscrowContract': 0x06}
DRIVE = '''repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
  mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gval_size
  gbytes_eqb gval_eqb negb Nat.eqb andb] | multimatch goal with H : ?l = ?r |- _ =>
  progress rewrite H end | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end];
  reflexivity.'''


def render(nef, manifest, pins):
    abi, init, _ = bind(nef, manifest, *pins)
    raw = decode_nef(nef)
    ops = decode_script(raw['script'], len(raw['tokens']))
    count = sum(i['offset'] >= init for i in ops)
    cert = HEADER + 'Definition init_code : list nat := ' + octets(raw['script'][init:]) + '.\n'
    for name, prefix in PREFIX.items():
        m, = [m for m in abi if m['name'] == name]
        keyed = name == 'getMarketEscrowContract'
        require(m['safe'] and m['returntype'] == 'Hash160' and [p['type'] for p in m['parameters']]
                == (['Hash160'] if keyed else []), 'address getter ABI mismatch: ' + name)
        end = min(i['offset'] for i in ops if i['offset'] >= m['offset'] and i['name'] == 'RET')
        body = [i for i in ops if m['offset'] <= i['offset'] <= end]
        terms, _ = render_vm_program(body)
        slot, = [int(t.split()[1]) for t in terms if t.startswith('LdStatic ')]
        key = f'({prefix}%nat :: account)' if keyed else f'[{prefix}%nat]'
        args = '[GBytes account]' if keyed else '[]'
        cert += f'''Definition {name}_ops : list Ins := [{';'.join(terms)}].
Definition {name}_fields hp (account : bytes) :=
 read_field (run_init {count} init_code (initializer_entry hp {('[VBytes account]' if keyed else '[]')})).
Lemma {name}_prefix : forall hp account,
 {name}_fields hp account {slot}%nat = Some (GBytes [{prefix}%nat]).
Proof. intros; vm_compute; reflexivity. Qed.
Theorem {name}_result : forall hp (account : bytes) (store : storage),
 run {len(terms)} 0 (fun pc => nth pc {name}_ops Unsupported)
 (machine [] [] {args} ({name}_fields hp account) store [] (fun _ _ => GNull)) =
 match store {key} with None => Done (GBytes (repeat 0%nat 20))
 | Some b => if Z.eqb (Z.of_nat (length b)) 20 then Done (GBytes b) else Thrown end.
Proof. intros. remember ({name}_fields hp account) as fields eqn:F.
 assert (P:fields {slot}%nat = Some (GBytes [{prefix}%nat])) by (rewrite F; apply {name}_prefix).
 clear F. unfold {name}_ops. destruct (store {key}) as [b|] eqn:E.
 - destruct (Z.eqb (Z.of_nat (length b)) 20) eqn:B; {DRIVE}
 - {DRIVE}
Qed.
Print Assumptions {name}_result.
'''
    return cert


def verify(out):
    out.mkdir(parents=True, exist_ok=True)
    receipt = out/'result.json'
    receipt.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    revision = subprocess.check_output(['git','rev-parse','origin/main'], cwd=HERE, text=True).strip()
    sources = [Path(__file__).resolve(), *(HERE/n for n in ('ordinary_stored_integers.py',
        'ordinary_entry_proofs.py','ordinary_initializer_proofs.py','ordinary_query_references.py',
        'storage_getter_proofs.py','nef_decode.py','verify.py'))]
    model_paths = [HERE/'coq'/(n+'.v') for n in (*MODELS,'NumericCoercions','StorageGetter','StorageGetterVm')]
    pins = {p: digest(p.read_bytes()) for p in sources + model_paths}
    results = {}
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for path in model_paths:
            (work/path.name).write_bytes(path.read_bytes())
            subprocess.run(['coqc','-q',path.name],cwd=work,check=True,stdout=subprocess.DEVNULL)
        for tag, identity in [('archive',(NEF,MANIFEST)), ('main',MAIN)]:
            def read(suffix):
                if tag == 'archive':
                    return INPUT.with_suffix(suffix).read_bytes()
                return subprocess.check_output(['git','show',revision+':contracts/build/SmartAccount'+suffix],cwd=HERE)
            cert = render(read('.nef'),read('.manifest.json'),identity)
            stem = 'AddressReads' + tag
            (work/(stem+'.v')).write_text(cert)
            output = subprocess.check_output(['coqc','-q',stem+'.v'],cwd=work,text=True)
            require(output.count('Closed under the global context') == len(PREFIX) and 'Axioms:' not in output,
                    'open address theorem')
            subprocess.run(['coqchk','-silent',stem],cwd=work,check=True)
            (out/(stem+'.v')).write_text(cert)
            results[tag] = dict(nefSha256=identity[0],manifestSha256=identity[1],
                                certificateSha256=digest(cert.encode()),methods=list(PREFIX))
    require(all(digest(p.read_bytes()) == h for p,h in pins.items()), 'inputs changed during verification')
    receipt.write_text(json.dumps(dict(status='PASS_SCOPED',implementationVerified=False,
        remoteMain=revision,targets=results,sourceSha256={str(p.relative_to(HERE)):h for p,h in pins.items()},
        scope='Initialized slots and getter bodies under modeled storage and instruction execution only. '
              'No resource, external call admission, storage engine or rollback correspondence.'),indent=2)+'\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=REPORT/'stored-addresses')
    verify(parser.parse_args().output)

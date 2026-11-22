#!/usr/bin/env python3
"""Recheck the actual helper certificate and finite caller/ledger composition."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
MODEL = ROOT / 'coq/ReimbursementComposition.v'
MODULES = ['IntegerSemantics', 'CapArithmetic', 'CapMethodVm', 'CapMethodArtifact']
MUTATIONS = {
 'lose-cumulative-reservation': (
   'Some (amount,PresentBudget kind hash spent)',
   'Some (amount,PresentBudget kind hash amount)',
   '''Example rejects_lost_cumulative : helper_step (repeat 1%nat 32) 5 0 3
 (PresentBudget ArrayKind (repeat 1%nat 32) 3) CapMethodArtifact.reviewed_statics =
 Some (2,PresentBudget ArrayKind (repeat 1%nat 32) 5).
 Proof. vm_compute. reflexivity. Qed.'''),
 'reentrant-old-ledger': (
   'Definition callback_ledger (before reserved : BudgetInput) := reserved.',
   'Definition callback_ledger (before reserved : BudgetInput) := before.',
   '''Example rejects_reused_callback_balance : helper_step (repeat 1%nat 32) 5 0 3
 (callback_ledger AbsentBudget (PresentBudget ArrayKind (repeat 1%nat 32) 3))
 CapMethodArtifact.reviewed_statics = Some (2,PresentBudget ArrayKind (repeat 1%nat 32) 5).
 Proof. vm_compute. reflexivity. Qed.'''),
 'commit-after-fault': (
   'if outer_uncaught_fault transaction then outer_snapshot transaction else outer_working transaction.',
   'if outer_uncaught_fault transaction then outer_working transaction else outer_working transaction.',
   '''Example rejects_fault_commit : finish_outer (outer_transaction AbsentBudget
 (PresentBudget ArrayKind (repeat 1%nat 32) 3) [3] true) = AbsentBudget.
 Proof. reflexivity. Qed.'''),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def portable_hashes(hashes):
    """Return stable input identities without host-specific absolute paths."""
    result = {}
    root = REPO.resolve()
    for path, expected in hashes.items():
        candidate = Path(path).resolve()
        try:
            name = candidate.relative_to(root).as_posix()
        except ValueError:
            name = "external/" + candidate.name
        if name in result:
            name = name + "#" + sha(str(candidate).encode())[:12]
        result[name] = expected
    return result


def declarations(source):
    return re.findall(r'^(?:Definition|Fixpoint|Inductive|Record|Lemma|Theorem|Example)\s+(\w+)', source, re.M)


def trusted_source(raw):
    source = raw.decode('utf-8')
    stripped = re.sub(r'\(\*.*?\*\)', '', source, flags=re.S)
    require(not re.search(r'\b(?:Axiom|Axioms|Admitted|admit|Abort|Parameter|Parameters)\b', stripped),
            'Untrusted proof escape')
    return source


def helper_inputs(report, report_directory):
    require(report.get('kernelChecked') is True and report.get('referenceRefinementVerified') is True,
            'Missing verified complete helper certificate')
    require(report.get('scope') == 'complete-helper-reference-refinement' and report.get('byteCount') == 281,
            'Unsupported helper certificate scope')
    directory = Path(report.get('kernelDirectory', ''))
    certificate = directory / 'CapMethodArtifact.v'
    if not certificate.is_file():
        candidates = []
        for path in Path(report_directory).glob('**/CapMethodArtifact.v'):
            raw = path.read_bytes()
            if sha(raw) == report.get('certificateSha256'):
                candidates.append((path, raw))
        require(len(candidates) == 1, 'Cannot resolve unique exact helper certificate')
        certificate, raw_certificate = candidates[0]
        directory = certificate.parent
    else:
        raw_certificate = certificate.read_bytes()
    require(sha(raw_certificate) == report.get('certificateSha256'),
            'Helper certificate hash mismatch')
    inputs = {certificate: raw_certificate}
    for module in MODULES[:-1]:
        current = ROOT / 'coq' / (module + '.v')
        raw = current.read_bytes()
        require(sha(raw) == report.get('modelSha256', {}).get(module), 'Helper semantic model hash mismatch: '+module)
        require((directory / current.name).read_bytes() == raw, 'Helper model/certificate dependency mismatch')
        inputs[current] = raw
    text = trusted_source(inputs[certificate])
    match = re.search(r'Definition artifact\s*:\s*list nat\s*:=\s*\[(.*?)\]\.', text, re.S)
    require(match is not None, 'Missing literal actual helper bytes')
    tokens = re.findall(r'(\d+)%nat', match.group(1))
    code = bytes(int(token) for token in tokens)
    require(len(code) == 281 and sha(code) == report.get('methodSha256'), 'Helper artifact byte identity mismatch')
    for path, expected in report.get('toolInputSha256', {}).items():
        current = Path(path)
        if not current.is_absolute():
            # Resolve relative tool names against this lane's own directory: under
            # closure those are the pinned snapshot copies, never whatever the
            # inherited host working directory happens to hold.
            current = ROOT / current.name
        require(current.is_file(), 'Missing helper proof tool: '+str(current))
        raw = current.read_bytes()
        require(sha(raw) == expected, 'Helper proof tool drift: '+str(current))
        inputs[current] = raw
    require('Theorem vm_method_classified' in text and 'Theorem complete_helper_reference_refinement' in text,
            'Missing complete helper theorem')
    return inputs, certificate


# Kernel checking is the long pole, and this host is shared with unrelated
# workloads. A fixed 600s budget turned a loaded host into a gate failure twice
# (2026-10-15 for the helper lane, 2026-10-20 here: coqc CapMethodArtifact.v
# needed 649s). The budget is a liveness limit, not a claim - a proof that
# finishes late is still kernel-checked, and a genuine hang still fails closed.
KERNEL_TIMEOUT = 3600


def command(args, work, name, positive=True):
    result = subprocess.run(args, cwd=work, capture_output=True, text=True, timeout=KERNEL_TIMEOUT)
    output = result.stdout + result.stderr
    (work / name).write_text(output)
    if positive:
        require(result.returncode == 0, 'Kernel check failed: '+str(work/name))
    return result.returncode, output


def prepare(helper_report, output_dir):
    report_path = Path(helper_report).resolve()
    raw_report = report_path.read_bytes()
    report = json.loads(raw_report)
    inputs, certificate = helper_inputs(report, report_path.parent)
    inputs[report_path] = raw_report
    for path in [MODEL, Path(__file__), ROOT/'test_composition_proofs.py']:
        inputs[path] = path.read_bytes()
    hashes = {str(path):sha(raw) for path, raw in inputs.items()}
    work = Path(output_dir).resolve(); work.mkdir(parents=True, exist_ok=True)
    coqc, coqchk = shutil.which('coqc'), shutil.which('coqchk')
    require(coqc and coqchk, 'Missing actual coqc/coqchk')
    for module in MODULES:
        path = certificate if module == 'CapMethodArtifact' else ROOT/'coq'/(module+'.v')
        trusted_source(inputs[path])
        (work/(module+'.v')).write_bytes(inputs[path])
        command([coqc,'-q',module+'.v'],work,module+'.log')
    source = trusted_source(inputs[MODEL])
    (work/MODEL.name).write_bytes(inputs[MODEL])
    command([coqc,'-q',MODEL.name],work,MODEL.stem+'.log')
    command([coqchk,'-silent',*MODULES,MODEL.stem],work,'coqchk.log')
    inventory = {module:declarations((work/(module+'.v')).read_text()) for module in MODULES+[MODEL.stem]}
    assumption_source = 'Require Import '+' '.join(MODULES+[MODEL.stem])+'.\n'
    assumption_source += '\n'.join('Print Assumptions '+module+'.'+name+'.'
        for module,names in inventory.items() for name in names)+'\n'
    (work/'CompositionAssumptions.v').write_bytes(assumption_source.encode())
    _, audit = command([coqc,'-q','CompositionAssumptions.v'],work,'assumptions.log')
    count = audit.count('Closed under the global context')
    require(count == sum(map(len,inventory.values())) and 'Axioms:' not in audit,
            'Incomplete closed-assumptions audit')
    return report, inputs, hashes, work, coqc, count, inventory


def unchanged(inputs):
    require(all(path.read_bytes() == raw for path,raw in inputs.items()), 'Proof input changed during run')


def proof_receipt(bundle):
    report, inputs, hashes, work, coqc, count, inventory = bundle
    _, version = command([coqc,'--version'],work,'tool-version.log')
    unchanged(inputs)
    return {'schema':'neoos-sa-reimbursement-composition/v1','scope':'caller-ledger-composition',
      'kernelChecked':True,'actualHelperTheoremApplied':True,'helperByteCount':281,
      'helperCertificateSha256':report['certificateSha256'],'helperMethodSha256':report['methodSha256'],
      'actualApplicationEngineVerified':False,'fullImplementationVerified':False,
      'newClosedDeclarations':inventory[MODEL.stem],'closedAssumptionCount':count,
      'assumptionDeclarations':inventory,'inputSha256':portable_hashes(hashes),
      'toolVersion':version.splitlines()[0],
      'preconditions':['the supplied helper certificate has fresh source/NEF provenance from the aggregate gate',
          'Integer-typed request and fee fields, valid 32-byte hash and Array/Struct ledger',
          'static slot 58 is Buffer[0x21] (the v4 slot for Prefix_TransactionReimbursement), with the helper native environment contracts',
          'each invocation satisfies legal_inputs; zero-fee updated sum must fit signed256',
          'paid final ledger bound requires initial effective reserved <= transaction fee',
          'callbacks only affect this ledger through successful helper calls or an uncaught outer fault'],
      'covered':['actual full-helper reservation transition','finite serial and successful nested calls',
                 'positive reservations and cumulative conservation','paid transaction fee bound',
                 'missing ledger and different transaction reset','safe zero-fee caller conditions',
                 'declared outer transaction snapshot commit/discard'],
      'excluded':['caught child-context fault and cache semantics','actual native codec',
                  'actual ApplicationEngine and gas','actual transaction rollback implementation',
                  'caller domain establishment and all public ABI methods','arbitrary callback storage effects']}


def run_proofs(helper_report, output_dir):
    return proof_receipt(prepare(helper_report, output_dir))


def semantic_controls(bundle):
    report, inputs, hashes, work, coqc, count, inventory = bundle
    source = inputs[MODEL].decode()
    prefix = re.split(r'^Lemma ',source,maxsplit=1,flags=re.M)[0]
    rejected, details = [], {}
    for name,(old,new,claim) in MUTATIONS.items():
        require(prefix.count(old) == 1, 'Mutation selector mismatch: '+name)
        case = work/'semantic-controls'/name; case.mkdir(parents=True)
        for module in MODULES:
            for extension in ['.v','.vo']:
                shutil.copyfile(work/(module+extension),case/(module+extension))
        mutant = prefix.replace(old,new)
        (case/'Definitions.v').write_bytes(mutant.encode())
        command([coqc,'-q','Definitions.v'],case,'definitions.log')
        (case/'Reject.v').write_bytes(('Require Import Definitions.\nFrom Coq Require Import ZArith List.\n'
           'Require Import CapMethodVm CapMethodArtifact IntegerSemantics.\nImport ListNotations.\nOpen Scope Z_scope.\n'+claim+'\n').encode())
        code, log = command([coqc,'-q','Reject.v'],case,'rejection.log',False)
        require(code > 0 and 'Error:' in log and 'Syntax error' not in log,
                'Mutation did not receive semantic proof rejection: '+name)
        rejected.append(name)
        details[name] = {'definitionsCompiled': True, 'certificateRejected': True, 'kernelExitCode': code}
    unchanged(inputs)
    return {'schema':'neoos-sa-reimbursement-composition-controls/v1','scope':'caller-ledger-composition',
        'definitionsCompiled':True,'rejected':rejected,'controls':details,
        'inputSha256':portable_hashes(hashes),
        'actualApplicationEngineVerified':False,'fullImplementationVerified':False}


def run_semantic_controls(helper_report, output_dir):
    return semantic_controls(prepare(helper_report, output_dir))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper-proof-report',type=Path,required=True)
    parser.add_argument('--output-dir',type=Path,required=True)
    parser.add_argument('--json-report',type=Path,required=True)
    parser.add_argument('--controls',action='store_true')
    args=parser.parse_args()
    result={'scope':'caller-ledger-composition','kernelChecked':False,'fullImplementationVerified':False}
    args.json_report.parent.mkdir(parents=True,exist_ok=True)
    args.json_report.write_text(json.dumps(result)+'\n')
    try:
        bundle=prepare(args.helper_proof_report,args.output_dir)
        result=proof_receipt(bundle)
        if args.controls:
            controls=semantic_controls(bundle)
            result['semanticControls']=controls
        args.json_report.write_text(json.dumps(result,indent=2)+'\n')
        return 0
    except Exception as error:
        result['failure']=type(error).__name__+': '+str(error)
        args.json_report.write_text(json.dumps(result,indent=2)+'\n')
        return 1


if __name__=='__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Exact public pure-method source/bytecode reference certificate lane."""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
try:
    from . import nef_decode, public_source
except ImportError:
    import nef_decode, public_source

ROOT = Path(__file__).resolve().parent
MODULES = ('IntegerSemantics', 'CapArithmetic', 'CapMethodVm', 'PublicPureMethods')


def require(condition, message):
    if not condition: raise ValueError(message)


def sha(data): return hashlib.sha256(data).hexdigest()


def bind_methods(inventory):
    snapshots = {filename: Path(filename).read_bytes() for filename in inventory['inputs']}
    for filename, expected in inventory['inputs'].items():
        require(sha(snapshots[filename]) == expected, 'Inventory input drift: ' + filename)
    candidates = [name for name, expected in inventory['inputs'].items()
                  if name.endswith('SmartAccountV3.nef') and expected == inventory['nef']['sha256']]
    require(len(candidates) == 1, 'Ambiguous actual NEF')
    spec = importlib.util.spec_from_file_location('public_pure_nef_binding', ROOT / 'verify.py')
    gate = importlib.util.module_from_spec(spec); spec.loader.exec_module(gate)
    raw = snapshots[candidates[0]]
    require(sha(raw) == inventory['nef']['sha256'], 'Actual NEF container identity mismatch')
    nef = gate.decode_nef(raw); script = nef['script']
    require(script.hex() == inventory['nef']['scriptHex'] and sha(script) == inventory['nef']['scriptSha256'],
            'Actual NEF differs from exported script')
    instructions = nef_decode.decode_script(script, len(nef['tokens']))
    require(len(instructions) == len(inventory['nef']['instructions']) and
            all(all(record.get(k) == v for k, v in actual.items())
                for actual, record in zip(instructions, inventory['nef']['instructions'])), 'Instruction inventory differs')
    require(inventory['sourceMap']['exactByteMatch'] is True and inventory['sourceMap']['exactManifestMatch'] is True,
            'Source rebuild correspondence unavailable')
    manifests = [name for name, expected in inventory['inputs'].items()
                 if name.endswith('SmartAccountV3.manifest.json')
                 and expected == inventory['manifest']['sha256']]
    require(len(manifests) == 1 and json.loads(snapshots[manifests[0]])['abi']['methods'] == inventory['manifest']['methods'],
            'Actual full manifest differs from inventory')
    projection = public_source.project_methods(inventory)
    methods = {}
    for name, source in projection.items():
        abis = [m for m in inventory['manifest']['methods'] if m['name'] == name]
        require(len(abis) == 1, 'Missing/ambiguous public ABI')
        abi = abis[0]
        require(abi['safe'] is True and abi['returntype'] == ('String' if source['returnType'] == 'string' else 'Boolean')
                and abi['parameters'] == [dict(name=p, type='String') for p in source['parameters']], 'Public ABI mismatch')
        debug = [m for m in inventory['sourceMap']['debug']['methods'] if m['id'] == source['displayName']]
        require(len(debug) == 1 and debug[0]['abi'] == abi, 'Public ABI/source debug binding mismatch')
        start, last = map(int, debug[0]['range'].split('-')); end = last + 1
        region = [item for item in instructions if start <= item['offset'] < end]
        require(region and start == abi['offset'] == region[0]['offset']
                and region[-1]['offset'] + region[-1]['size'] == end and region[-1]['opcode'] == 0x40,
                'Invalid full method boundary')
        require(all(item['opcode'] in {8,12,34,38,64,87,120,151} for item in region),
                'Pure method has unsupported instruction/static/effect dependency')
        require(all(edge['target'] is None or start <= edge['target'] < end
                    for item in region for edge in item.get('edges', []) if edge['kind'] != 'fallthrough'
                    or item['opcode'] != 64), 'Method escapes certified range')
        methods[name] = dict(abi=abi, source=source, start=start, end=end, bytes=list(script[start:end]),
                             methodSha256=sha(script[start:end]), instructionCount=len(region))
    return dict(nefSha256=sha(raw), scriptSha256=sha(script), methods=methods)


NORMALIZE = r"""Ltac pure_norm := cbv [public_classified return_frame_preserved environment_preserved public_value budget_eval source_eval eval_pure
 limited_equal comparison_allowed comparable_limit decode_public decode
 step_public vm_step initial_public with_stack change pc stack arguments locals heap
 storage effects statics jump_target signed_byte value_eqb
 firstn skipn nth_error length app repeat Nat.add Nat.sub Nat.mul Nat.eqb Nat.leb Nat.ltb
 Bool.eqb andb orb negb] in *.
Ltac pure_drive := repeat first [progress pure_norm
 | multimatch goal with H : ?lhs = ?rhs |- _ => progress rewrite H end
 | match goal with |- context[Z.to_nat ?z] => let n := eval vm_compute in (Z.to_nat z) in progress change (Z.to_nat z) with n end
 | rewrite run_public_one_step].
"""


def render_certificate(bound, projections=None):
    projections = projections or {name: entry['source'] for name, entry in bound['methods'].items()}
    out = ['From Coq Require Import ZArith List Bool Lia PeanoNat.\n'
           'Require Import IntegerSemantics CapArithmetic CapMethodVm PublicPureMethods.\n'
           'Import ListNotations. Open Scope Z_scope.\n', NORMALIZE]
    for name, entry in bound['methods'].items():
        expr = public_source.render_expr(projections[name]['expression'])
        code = '[' + ';'.join(str(b)+'%nat' for b in entry['bytes']) + ']'
        out.append(f'Definition {name}_code := {code}.\nDefinition {name}_source := {expr}.\n')
        inputs = '[]' if not entry['source']['parameters'] else '[input]'
        proof = f'''Theorem {name}_execution_classified : forall input static_values objects stored,
 public_classified (budget_eval {name}_source input)
 (run_public 24 {name}_code (initial_public {inputs} static_values objects stored))
 (initial_public {inputs} static_values objects stored).
Proof. intros. unfold {name}_code, {name}_source.
'''
        if not entry['source']['parameters']:
            proof += 'pure_drive. repeat split; reflexivity. Qed.\n'
        else:
            literals = []
            def scan(e):
                if e[0] == 'PBytes': literals.append(e[1])
                elif len(e) == 3: scan(e[1]); scan(e[2])
            scan(projections[name]['expression'])
            proof += 'assert (Hpositive : (0 <? 65536) = true) by (vm_compute; reflexivity).\n'
            for length in sorted(set(map(len, literals))):
                proof += f'assert (Hlen{length} : (Z.of_nat {length} <=? 65536) = true) by (vm_compute; reflexivity).\n'
            proof += 'destruct input as [z|boolean| |bytes|buffer|ref| |kind values].\n- pure_drive; repeat split; reflexivity.\n- pure_drive; repeat split; reflexivity.\n- pure_drive; repeat split; reflexivity.\n- '
            proof += 'destruct (Z.of_nat (length bytes) <=? 65536) eqn:Hsize.\n'
            for i, literal in enumerate(literals):
                bs = '[' + ';'.join(str(b)+'%nat' for b in literal) + ']'
                proof += f'all: destruct (bytes_eqb bytes {bs}) eqn:H{i}.\n'
            proof += 'all: pure_drive; repeat split; reflexivity.\n- pure_drive; repeat split; reflexivity.\n- pure_drive; repeat split; reflexivity.\n- pure_drive; repeat split; reflexivity.\n- pure_drive; repeat split; reflexivity.\nQed.\n'

        out += [proof, f'Print Assumptions {name}_execution_classified.\n', render_composition(name, entry, projections[name])]
    return ''.join(out)


def source_cases(expression):
    literals = []
    def scan(e):
        if e[0] == 'PBytes': literals.append(e[1])
        elif len(e) == 3: scan(e[1]); scan(e[2])
    scan(expression)
    return literals


def render_composition(name, entry, source):
    inputs = '[]' if not source['parameters'] else '[input]'
    initial = f'(initial_public {inputs} static_values objects stored)'
    run = f'(run_public 24 {name}_code {initial})'
    out = fr"""
Theorem {name}_budget_reference : forall input static_values objects stored,
 public_value {run} = budget_eval {name}_source input.
Proof. intros. eapply classification_value. apply {name}_execution_classified. Qed.
Print Assumptions {name}_budget_reference.
Theorem {name}_source_domain : forall input,
 typed_string_argument input -> budget_eval {name}_source input = source_eval {name}_source input.
Proof. intros input Htyped. apply budget_eval_refines_source.
- unfold {name}_source. vm_compute. repeat split; congruence.
- apply typed_string_is_comparable. exact Htyped. Qed.
Print Assumptions {name}_source_domain.
Theorem {name}_source_refinement : forall input static_values objects stored,
 typed_string_argument input -> public_classified (source_eval {name}_source input) {run} {initial}.
Proof. intros. rewrite <- {name}_source_domain by assumption. apply {name}_execution_classified. Qed.
Print Assumptions {name}_source_refinement.
Theorem {name}_no_timeout : forall (input : Value) static_values objects stored,
 terminal_public {run}.
Proof. intros input static_values objects stored. exact (classification_terminal (budget_eval {name}_source input) {run} {initial} ({name}_execution_classified input static_values objects stored)). Qed.
Print Assumptions {name}_no_timeout.
Theorem {name}_source_total : forall input, exists value, source_eval {name}_source input = Some value.
Proof. intros. unfold {name}_source.
"""
    if not source['parameters']:
        out += 'eexists. reflexivity. Qed.\n'
    else:
        out += 'destruct input as [z|boolean| |bytes|buffer|ref| |kind values]; try solve [pure_norm; eexists; reflexivity].\n'
        for i, literal in enumerate(source_cases(source['expression'])):
            bs = '[' + ';'.join(str(b)+'%nat' for b in literal) + ']'
            out += f'destruct (bytes_eqb bytes {bs}) eqn:H{i};\n'
        out += 'pure_drive; eexists; reflexivity. Qed.\n'
    out += fr"""Print Assumptions {name}_source_total.
Theorem {name}_source_halts_preserves_frame : forall input static_values objects stored,
 typed_string_argument input -> exists value after,
 source_eval {name}_source input = Some value /\ {run} = Halt value after /\ return_frame_preserved after {initial}.
Proof. intros input static_values objects stored Htyped.
 destruct ({name}_source_total input) as [value Esource].
 pose proof ({name}_source_refinement input static_values objects stored Htyped) as Hrefine.
 rewrite Esource in Hrefine. apply classification_returns in Hrefine.
 destruct Hrefine as [after [Hrun Henv]]. exists value,after. auto. Qed.
Print Assumptions {name}_source_halts_preserves_frame.
"""
    if source['parameters']:
        out += fr"""Theorem {name}_oversized_fault_preserves_frame : forall bytes static_values objects stored,
 comparable_limit < Z.of_nat (length bytes) -> exists after,
 (run_public 24 {name}_code (initial_public [VBytes bytes] static_values objects stored)) = Fault after /\
 environment_preserved after (initial_public [VBytes bytes] static_values objects stored).
Proof. intros bytes static_values objects stored Hsize.
 eapply classification_faults.
 pose proof ({name}_execution_classified (VBytes bytes) static_values objects stored) as Hclass.
 assert (Esize : (Z.of_nat (length bytes) <=? 65536) = false) by (apply Z.leb_gt; exact Hsize).
 assert (Epositive : (0 <? 65536) = true) by (vm_compute; reflexivity).
 unfold {name}_source in Hclass. pure_norm. rewrite Esize,Epositive in Hclass. pure_norm. exact Hclass. Qed.
Print Assumptions {name}_oversized_fault_preserves_frame.
Theorem {name}_missing_argument_fault : forall static_values objects stored,
 run_public 24 {name}_code (initial_public [] static_values objects stored) = Fault (initial_public [] static_values objects stored).
Proof. intros. unfold {name}_code. rewrite run_public_one_step. pure_norm. reflexivity. Qed.
Print Assumptions {name}_missing_argument_fault.
Theorem {name}_non_string_returns_false : forall input static_values objects stored,
 (match input with VBytes _ => False | _ => True end) ->
 public_value {run} = Some (VBool false).
Proof. intros input static_values objects stored Htag. rewrite {name}_budget_reference.
 unfold {name}_source. destruct input; pure_norm; try reflexivity; contradiction. Qed.
Print Assumptions {name}_non_string_returns_false.
"""
    return out


def kernel(command, directory, log, success=True):
    result = subprocess.run(command, cwd=directory, capture_output=True, text=True, timeout=600)
    text = result.stdout + result.stderr; Path(log).write_text(text)
    if success: require(result.returncode == 0, 'Kernel command failed: ' + ' '.join(command) + '\n' + text[-3500:])
    return result.returncode, text


def declarations(text):
    return re.findall(r'^(?:Lemma|Theorem|Example)\s+(\w+)\s*:', text, re.MULTILINE)


def run_proofs(inventory, output_dir, controls=True):
    require(shutil.which('coqc') and shutil.which('coqchk'), 'coqc and coqchk are required')
    tool_paths = [ROOT / p for p in ('public_pure_proofs.py', 'public_source.py', 'method_source.py', 'nef_decode.py', 'verify.py')]
    tools = {str(p): sha(p.read_bytes()) for p in tool_paths}
    bound = bind_methods(inventory)
    directory = Path(output_dir)
    require(not directory.exists() or (directory.is_dir() and not any(directory.iterdir())),
            'Output directory must be new or empty')
    directory.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='public-pure-kernel-', dir=directory))
    models, names = {}, {}
    for module in MODULES:
        path = ROOT / 'coq' / (module + '.v'); raw = path.read_bytes(); source = raw.decode()
        require(not re.search(r'\b(?:Admitted|Axiom|Axioms|admit|Parameter|Parameters|Abort)\b', source), 'Proof escape')
        models[str(path)] = sha(raw); names[module] = declarations(source)
        (work / path.name).write_bytes(raw)
        kernel(['coqc', '-q', path.name], work, work / (module + '.log'))
    certificate = render_certificate(bound)
    (work / 'PublicPureArtifact.v').write_text(certificate)
    names['PublicPureArtifact'] = declarations(certificate)
    kernel(['coqc', '-q', 'PublicPureArtifact.v'], work, work / 'artifact.log')
    kernel(['coqchk', '-silent', 'PublicPureArtifact'], work, work / 'coqchk.log')
    audit = 'Require Import ' + ' '.join(names) + '.\n' + '\n'.join(
        'Print Assumptions ' + module + '.' + name + '.' for module, decls in names.items() for name in decls)
    (work / 'Assumptions.v').write_text(audit)
    _, assumptions = kernel(['coqc', '-q', 'Assumptions.v'], work, work / 'assumptions.log')
    require(assumptions.count('Closed under the global context') == sum(map(len, names.values())), 'Incomplete assumption audit')
    results = semantic_controls(bound, work, inventory) if controls else []
    require(bind_methods(inventory) == bound, 'Artifact changed during proof')
    require(all(sha(Path(p).read_bytes()) == h for p, h in {**models, **tools}.items()), 'Model/tool changed during proof')
    return dict(schema='neoos-aa-public-pure-refinement/v1', scope='public-pure-reference-refinement',
                kernelChecked=True, fullImplementationVerified=False, vmCorrespondenceProven=False,
                referenceVerifiedEntrypoints=list(bound['methods']), fullUnprovedEntrypointCount=len(inventory['manifest']['methods']), nefSha256=bound['nefSha256'],
                scriptSha256=bound['scriptSha256'], methods=bound['methods'],
                sourceProjectionSha256=public_source.projection_hash({n:e['source'] for n,e in bound['methods'].items()}),
                certificateSha256=sha(certificate.encode()), modelSha256=models, toolInputSha256=tools,
                sourceInputSha256=inventory['inputs'],
                sourceTreeSha256=sha(json.dumps(inventory['source'], sort_keys=True, separators=(',', ':')).encode()),
                closedDeclarations=names, semanticControls=results, kernelDirectory=str(work),
                openObligations=['SOURCE_FRONTEND_SEMANTIC_BINDING','NEO_DIALECT_TO_COMPILER_CORRESPONDENCE',
                                 'APPLICATION_ENGINE_AND_ABI_DISPATCH','GAS_AND_RESOURCE_FAULTS','CONTRACT_STATIC_INITIALIZATION',
                                 'ALL_REMAINING_PUBLIC_ENTRYPOINTS'])


def semantic_controls(bound, work, inventory):
    cases = []
    def add(name, method, witness, mutated=None, projections=None):
        cases.append((name, method, witness, mutated or copy.deepcopy(bound), projections))
    projections = {name: entry['source'] for name, entry in bound['methods'].items()}
    for method in bound['methods']:
        entry = bound['methods'][method]
        # Change an actual literal payload without changing opcode or length.
        decoded = nef_decode.decode_script(bytes(entry['bytes']), 0)
        push = next(i for i in decoded if i['opcode'] == 12)
        literal = bytes.fromhex(push['operandHex'])
        changed = copy.deepcopy(bound)
        changed['methods'][method]['bytes'][push['offset']+2] ^= 1
        add('byte-literal-'+method, method, list(literal), changed)
        # Mutate honest source operation constants, then rerun the source-only
        # frontend. The target bytes are held unchanged for this control.
        source = copy.deepcopy(inventory)
        selected = next(m for m in source['source']['methods'] if m['id'] == entry['source']['sourceId'])
        def nodes(node):
            yield node
            for child in node['children']: yield from nodes(child)
        node = next(n for n in nodes(selected['operations'][0]) if n['kind'] in ('Literal','FieldReference'))
        node['constant']['value']['value'] += '-mutated'
        if node['kind'] == 'FieldReference':
            for type_ in source['source']['types']:
                for field in type_['fields']:
                    if field['id'] == node['details']['symbol']:
                        field['constant']['value'] = node['constant']['value']['value']
        add('source-literal-'+method, method, list(literal), projections=public_source.project_methods(source))
    method = 'supportsExecutionMode'
    changed = copy.deepcopy(bound)
    changed['methods'][method]['bytes'][13] = 0x24  # valid JMPIF, original is JMPIFNOT
    add('branch-polarity', method, list(b'single'), changed)
    changed = copy.deepcopy(bound)
    changed['methods'][method]['bytes'][14] = 6  # existing PUSHDATA1 boundary at pc19
    add('branch-target', method, list(b'unknown'), changed)
    reports = []
    for index, (name, method, witness, changed, projected) in enumerate(cases):
        entry = changed['methods'][method]
        # Require legal decoding and all branches still target actual boundaries.
        nef_decode.decode_script(bytes(entry['bytes']), 0)
        text = render_certificate(changed, projected)
        definition_lines = [line for line in text.splitlines() if line.startswith('Definition ')]
        module = 'PublicDefinitions' + str(index)
        definitions = ('From Coq Require Import ZArith List Bool.\n'
                       'Require Import IntegerSemantics CapArithmetic CapMethodVm PublicPureMethods.\n'
                       'Import ListNotations. Open Scope Z_scope.\n' + '\n'.join(definition_lines) + '\n')
        (work / (module+'.v')).write_text(definitions)
        kernel(['coqc','-q',module+'.v'], work, work / (module+'.log'))
        value = 'VNull' if not entry['source']['parameters'] else 'VBytes ['+';'.join(str(b)+'%nat' for b in witness)+']'
        inputs = '[]' if not entry['source']['parameters'] else '['+value+']'
        initial = f'(initial_public {inputs} (fun _ => None) [] VNull)'
        reject_module = 'PublicCounterexample' + str(index)
        assertion = (f'From Coq Require Import ZArith List Bool.\n'
                     f'Require Import CapMethodVm PublicPureMethods {module}.\n'
                     'Import ListNotations. Open Scope Z_scope.\n'
                     f'Example original_semantics : public_classified (budget_eval {method}_source ({value}))\n'
                     f'(run_public 24 {method}_code {initial}) {initial}.\n'
                     'Proof. vm_compute. repeat split; reflexivity. Qed.\n')
        (work / (reject_module+'.v')).write_text(assertion)
        code, output = kernel(['coqc','-q',reject_module+'.v'], work, work / (reject_module+'.log'), success=False)
        require(code != 0 and 'Error:' in output, 'Semantic control did not fail a valid theorem: '+name)
        reports.append(dict(name=name, method=method, definitionsAccepted=True, proofRejected=True,
                            kernelExitCode=code, definitionSha256=sha(definitions.encode()),
                            assertionSha256=sha(assertion.encode()), mutatedMethodSha256=sha(bytes(entry['bytes'])),
                            sourceProjectionSha256=public_source.projection_hash((projected or projections)[method])))
    require(len(reports) >= 4, 'Insufficient semantic controls')
    return reports


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--json-report', type=Path, required=True)
    args = parser.parse_args()
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    failure = dict(schema='neoos-aa-public-pure-refinement/v1', scope='public-pure-reference-refinement',
                   kernelChecked=False, fullImplementationVerified=False, vmCorrespondenceProven=False,
                   referenceVerifiedEntrypoints=[], status='FAIL', error='Verification has not completed')
    args.json_report.write_text(json.dumps(failure, indent=2)+'\n')
    try:
        raw = args.inventory.read_bytes()
        result = run_proofs(json.loads(raw), args.output_dir)
        require(args.inventory.read_bytes() == raw, 'Inventory changed during proof')
        result['inventorySha256'] = sha(raw)
        args.json_report.write_text(json.dumps(result, indent=2)+'\n')
        return 0
    except Exception as exc:
        failure['error'] = str(exc)
        args.json_report.write_text(json.dumps(failure, indent=2)+'\n')
        print(str(exc), file=sys.stderr); return 1


if __name__ == '__main__': sys.exit(main())

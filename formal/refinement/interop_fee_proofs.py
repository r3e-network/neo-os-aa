#!/usr/bin/env python3
"""Kernel certificates for the interop descriptor charge.

Binds the record projected from the pinned C# to canonical_fee, re-derives every
reviewed field for that record, instantiates the ordering and charge theorems at
it, and re-checks one observable per pinned decision. No handler execution and no
VM correspondence claim.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
try:
    from . import interop_fee_source as source
except ImportError:
    import interop_fee_source as source
HERE = Path(__file__).resolve().parent
MODULE = 'InteropFee'
ARTIFACT = 'InteropFeeArtifact'
EXPECTED_CONTROLS = source.EXPECTED_CONTROLS
PRECONDITIONS, UNPROVED, TCB = source.PRECONDITIONS, source.UNPROVED, source.TCB
require, sha, canonical = source.require, source.sha, source.canonical
PRELUDE = ('From Coq Require Import NArith ZArith PeanoNat List Bool Lia.\n'
           'Require Import InteropFee.\nImport ListNotations.\n')

# The projected step names, in the order the model names its constructors.
STEP_CONSTRUCTORS = {'validate-call-flags': 'ValidateFlags',
                     'charge': 'Charge',
                     'allocate-vector': 'Allocate',
                     'pop-and-convert': 'ConvertArgs',
                     'invoke-handler': 'Invoke',
                     'push-result': 'Push'}

# The record's binder order, the projected field each one corresponds to, and how
# a rendered literal keeps the declared type: '' is a bool, 'steps' is the
# ordered step list.
FIELDS = [('fp_order', 'step_order', 'steps'),
          ('fp_price_member', 'charge_reads_the_declared_price', ''),
          ('fp_exec_factor_member', 'charge_uses_the_exec_factor', ''),
          ('fp_skips_the_inner_factor', 'charge_skips_the_inner_factor', ''),
          ('fp_vector_from_descriptor', 'vector_length_from_descriptor', ''),
          ('fp_one_pop_per_parameter', 'pops_one_item_per_parameter', ''),
          ('fp_arity_from_handler', 'arity_from_the_handler_signature', ''),
          ('fp_price_type_long', 'declared_price_type_is_long', ''),
          ('fp_price_may_be_zero', 'declared_price_may_be_zero', ''),
          ('fp_negative_rejected', 'negative_fee_is_rejected', ''),
          ('fp_whitelist_bypass', 'whitelist_bypasses_the_charge', ''),
          ('fp_factor_branch_only', 'factor_applied_only_when_requested', ''),
          ('fp_consumed_before_limit', 'consumed_incremented_before_the_limit_check', ''),
          ('fp_limit_strict', 'limit_check_is_strict', ''),
          ('fp_no_fee_inside', 'no_fee_inside_the_conversion_window', '')]

LIST_FIELDS = frozenset(('fp_order',))


def declarations(text):
    return re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:', text, re.M)


def render_steps(steps):
    require(isinstance(steps, list), 'Unsupported field value: step_order')
    require(steps, 'Empty step order')
    rendered = []
    for name in steps:
        require(name in STEP_CONSTRUCTORS, 'Unknown step name: ' + str(name))
        rendered.append(STEP_CONSTRUCTORS[name])
    return '[' + '; '.join(rendered) + ']'


def program_expression(program):
    require(set(program) == {projected for _, projected, _ in FIELDS},
            'Incomplete/extra projected program')
    rendered = []
    for name, projected, suffix in FIELDS:
        value = program[projected]
        if name in LIST_FIELDS:
            require(suffix == 'steps', 'Wrong suffix for the step order')
            rendered.append(render_steps(value))
        else:
            # `1 == True` in Python, so a record whose bool slot held 1 would
            # render as a number and only fail much later.
            require(suffix == '' and isinstance(value, bool),
                    'Unsupported field value: ' + projected)
            require(type(value) is bool, 'Unsupported field value: ' + projected)
            rendered.append('true' if value else 'false')
    return '(fee_program ' + ' '.join(rendered) + ')'


# One concrete observation per mutant. The expression reads only the decision the
# mutant moves, and `expected` is what the pinned program yields on it.
CONTROL_CASES = {
 'charge-before-the-flag-check':
    ('o_charged (on_syscall mutant_program false false true 3%N 5%N 2 None)', '0%N'),
 'charge-after-the-conversion-loop':
    ('o_charged (on_syscall mutant_program true false true 3%N 5%N 2 (Some 0))', '15%N'),
 'charge-reads-another-price-member':
    ('charge_amount mutant_program 3%N 5%N', '15%N'),
 'charge-multiplies-by-the-base-factor':
    ('charge_amount mutant_program 3%N 5%N', '15%N'),
 'ask-add-fee-to-apply-the-factor-again':
    ('charge_amount mutant_program 3%N 5%N', '15%N'),
 'size-the-vector-from-a-constant':
    ('fp_vector_from_descriptor mutant_program', 'true'),
 'convert-every-parameter-from-the-first-descriptor':
    ('fp_one_pop_per_parameter mutant_program', 'true'),
 'take-the-arity-from-an-empty-signature':
    ('fp_arity_from_handler mutant_program', 'true'),
 'narrow-the-declared-price-to-int':
    ('price_representable mutant_program 3000000000%N', 'true'),
 'declare-the-price-always-nonzero':
    ('zero_price_is_accepted mutant_program 0%N', 'true'),
 'accept-a-negative-fee':
    ('negative_gas_rejected mutant_program (-1)%Z', 'true'),
 'charge-a-whitelisted-context':
    ('o_charged (on_syscall mutant_program true true true 3%N 5%N 2 None)', '0%N'),
 'always-apply-the-factor-branch':
    ('charge_amount mutant_program 3%N 5%N', '15%N'),
 'check-the-limit-before-counting-the-charge':
    ('fee_gate mutant_program 3%N 5%N 3%N', 'false'),
 'reject-a-call-at-exactly-the-limit':
    ('fee_gate mutant_program 3%N 5%N 2%N', 'true'),
 'charge-a-fee-inside-the-conversion-window':
    ('window_fee mutant_program', '0%N'),
}
require(set(CONTROL_CASES) == set(EXPECTED_CONTROLS),
        'Control case inventory differs from the mutation set')


def render_probes():
    return ''


def render_certificate(projection):
    require(projection['entryBoundary'] == source.ENTRY_BOUNDARY, 'Unsupported entry boundary')
    lines = [PRELUDE,
     'Definition actual_program := ' + program_expression(projection['program']) + '.',
     'Theorem actual_program_matches_reviewed_semantics : actual_program = canonical_fee.\n'
     'Proof. reflexivity. Qed.',
     # The correspondence claims proper: every value read out of the C# has to
     # land on the reviewed constant, not merely be well typed.
     'Theorem actual_step_order :\n'
     '  fp_order actual_program =\n'
     '  [ValidateFlags; Charge; Allocate; ConvertArgs; Invoke; Push].\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_charge_reads_the_declared_price :\n'
     '  fp_price_member actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_charge_uses_the_exec_factor :\n'
     '  fp_exec_factor_member actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_charge_skips_the_inner_factor :\n'
     '  fp_skips_the_inner_factor actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_vector_length_is_read_from_the_descriptor :\n'
     '  fp_vector_from_descriptor actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_converts_one_parameter_per_step :\n'
     '  fp_one_pop_per_parameter actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_arity_is_read_from_the_handler_signature :\n'
     '  fp_arity_from_handler actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_price_is_declared_as_a_long :\n'
     '  fp_price_type_long actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_price_may_be_zero :\n'
     '  fp_price_may_be_zero actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_negative_fee_is_rejected :\n'
     '  fp_negative_rejected actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_whitelist_bypasses_the_charge :\n'
     '  fp_whitelist_bypass actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_factor_lives_in_the_asked_branch :\n'
     '  fp_factor_branch_only actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_counter_moves_before_the_limit_check :\n'
     '  fp_consumed_before_limit actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_limit_comparison_is_strict :\n'
     '  fp_limit_strict actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_conversion_window_adds_no_fee :\n'
     '  fp_no_fee_inside actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     # The ordering theorems, instantiated at the projected record rather than at
     # a record the certificate itself chose.
     'Theorem actual_charge_precedes_the_first_pop :\n'
     '  forall whitelisted price factor arity k,\n'
     '    o_charged (on_syscall actual_program true whitelisted true price factor\n'
     '                             arity (Some k))\n'
     '      = charged actual_program whitelisted price factor.\n'
     'Proof.\n'
     '  intros. apply (the_charge_is_paid_before_the_first_pop\n'
     '                   actual_program whitelisted price factor arity k);\n'
     '    reflexivity.\n'
     'Qed.',
     'Theorem actual_a_faulting_conversion_charges_the_same :\n'
     '  forall whitelisted price factor arity k,\n'
     '    o_charged (on_syscall actual_program true whitelisted true price factor\n'
     '                             arity (Some k))\n'
     '      = o_charged (on_syscall actual_program true whitelisted true price factor\n'
     '                             arity None).\n'
     'Proof.\n'
     '  intros. apply (a_conversion_fault_does_not_refund_the_charge\n'
     '                   actual_program whitelisted price factor arity k);\n'
     '    reflexivity.\n'
     'Qed.',
     'Theorem actual_a_rejected_call_charges_nothing :\n'
     '  forall whitelisted add_fee_ok price factor arity fault_at,\n'
     '    o_charged (on_syscall actual_program false whitelisted add_fee_ok\n'
     '                             price factor arity fault_at) = 0%N.\n'
     'Proof.\n'
     '  intros. apply (a_rejected_call_charges_nothing_when_the_flag_check_comes_first\n'
     '                   actual_program whitelisted add_fee_ok price factor arity fault_at).\n'
     '  reflexivity.\n'
     'Qed.',
     'Theorem actual_a_fee_shortfall_pops_nothing :\n'
     '  forall flags_ok whitelisted price factor arity fault_at,\n'
     '    o_pops (on_syscall actual_program flags_ok whitelisted false\n'
     '                          price factor arity fault_at) = 0.\n'
     'Proof.\n'
     '  intros. apply (a_fee_shortfall_pops_nothing actual_program flags_ok\n'
     '                   whitelisted price factor arity fault_at). reflexivity.\n'
     'Qed.',
     'Theorem actual_a_whitelisted_context_charges_nothing :\n'
     '  forall add_fee_ok price factor arity fault_at,\n'
     '    o_charged (on_syscall actual_program true true add_fee_ok\n'
     '                             price factor arity fault_at) = 0%N.\n'
     'Proof.\n'
     '  intros. apply (a_whitelisted_context_pays_nothing actual_program add_fee_ok\n'
     '                   price factor arity fault_at); reflexivity.\n'
     'Qed.',
     'Theorem actual_the_handler_waits_for_the_conversion :\n'
     '  forall whitelisted price factor arity k,\n'
     '    o_handler_invoked (on_syscall actual_program true whitelisted true\n'
     '                                 price factor arity (Some k)) = false.\n'
     'Proof.\n'
     '  intros. apply (the_handler_runs_only_after_the_conversion\n'
     '                   actual_program whitelisted price factor arity k);\n'
     '    reflexivity.\n'
     'Qed.',
     'Theorem actual_a_zero_price_charges_nothing :\n'
     '  forall whitelisted factor arity fault_at,\n'
     '    o_charged (on_syscall actual_program true whitelisted true 0%N factor\n'
     '                             arity fault_at) = 0%N.\n'
     'Proof.\n'
     '  intros. apply (a_zero_price_charges_nothing actual_program whitelisted\n'
     '                   factor arity fault_at); reflexivity.\n'
     'Qed.',
     'Theorem actual_the_charge_ignores_the_arity :\n'
     '  forall whitelisted price factor m n fault_at,\n'
     '    o_charged (on_syscall actual_program true whitelisted true price factor\n'
     '                             m fault_at)\n'
     '      = o_charged (on_syscall actual_program true whitelisted true price factor\n'
     '                             n fault_at).\n'
     'Proof.\n'
     '  intros. apply (the_charge_does_not_depend_on_the_arity actual_program\n'
     '                   whitelisted price factor m n fault_at). reflexivity.\n'
     'Qed.',
     'Theorem actual_a_call_exactly_on_the_limit_is_accepted :\n'
     '  fee_gate actual_program 3%N 5%N 2%N = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_a_call_one_above_the_limit_is_refused :\n'
     '  fee_gate actual_program 3%N 5%N 3%N = false.\n'
     'Proof. reflexivity. Qed.',
     ]
    text = '\n'.join(lines) + '\n'
    return text + '\n'.join('Print Assumptions ' + n + '.' for n in declarations(text)) + '\n'


def render_control_sources(name, mutant):
    expression, expected = CONTROL_CASES[name]
    header = PRELUDE
    return {
     'Definitions.v': header + 'Definition mutant_program := '
                      + program_expression(mutant['program']) + '.\n',
     'OriginalBehavior.v': PRELUDE + 'Require Import Definitions.\nExample original_behavior : '
                           + expression + ' = ' + expected + '.\nProof. vm_compute. reflexivity. Qed.\n',
     'Counterexample.v': PRELUDE + 'Require Import Definitions.\nExample changed_behavior : '
                         + expression + ' <> ' + expected + '.\nProof. vm_compute. discriminate. Qed.\n'
                         'Print Assumptions changed_behavior.\n',
    }


CONTROL_PROOF_FILES = ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')
CONTROL_LOG_FILES = ('definitions.log', 'rejection.log', 'counterexample.log',
                     'counterexample-coqchk.log')


def run_command(command, directory, log, *, expect_rejection=False):
    try:
        result = subprocess.run(command, cwd=directory, text=True, capture_output=True, timeout=1800)
    except subprocess.TimeoutExpired as error:
        Path(log).write_text(str(error))
        raise ValueError('Kernel command timed out') from error
    Path(log).write_text(result.stdout + result.stderr)
    require(result.returncode > 0 if expect_rejection else result.returncode == 0,
            'Unexpected kernel exit ' + str(result.returncode) + ': ' + str(log))
    return result.returncode


def input_paths():
    return [HERE / 'interop_fee_source.py', HERE / 'interop_fee_proofs.py',
            HERE / 'coq/InteropFee.v']


def regenerate_certificate(report, evidence_dir):
    projection = source.project_captured(report['pinnedSource'])
    require((Path(evidence_dir) / 'source-projection.json').read_bytes() == canonical(projection),
            'Source projection bytes differ from actual complete sources')
    require(report['sourceProjectionSha256'] == sha(canonical(projection)),
            'Source projection hash mismatch')
    for field, value in [('preconditions', PRECONDITIONS), ('unproved', UNPROVED), ('tcb', TCB),
                         ('entryBoundary', source.ENTRY_BOUNDARY),
                         ('program', projection['program']),
                         ('reasonOnlyGuards', projection['reasonOnlyGuards'])]:
        require(report.get(field) == value, 'Changed interop charge domain: ' + field)
    require(report.get('coreSourceCommit') == source.CORE_COMMIT, 'Wrong core source pin')
    require(report.get('modelSha256') == {MODULE: sha((HERE / 'coq/InteropFee.v').read_bytes())},
            'Wrong model inventory')
    expected = {MODULE: declarations((HERE / 'coq/InteropFee.v').read_text()),
                ARTIFACT: declarations(render_certificate(projection))}
    require(report.get('closedDeclarations') == expected, 'Wrong declaration inventory')
    return render_certificate(projection).encode()


def regenerate_controls(report, evidence_dir):
    source.project_captured(report['pinnedSource'])
    contents = {k: Path(v['path']).read_text(encoding='utf-8') for k, v in report['pinnedSource'].items()}
    rows = report.get('semanticControls')
    require(isinstance(rows, list) and len(rows) == len(EXPECTED_CONTROLS),
            'Incomplete semantic controls')
    require([row.get('name') for row in rows] == list(EXPECTED_CONTROLS),
            'Wrong semantic control inventory')
    expected = {}
    logs = {}
    directory = Path(evidence_dir)
    for name, row in zip(EXPECTED_CONTROLS, rows):
        mutant, mutation_hash = source.mutated_projection(contents, name)
        require(row.get('sourceMutationSha256') == mutation_hash,
                'Changed source mutation: ' + name)
        require(row.get('projectionSha256') == sha(canonical(mutant)),
                'Changed mutant projection: ' + name)
        rendered = render_control_sources(name, mutant)
        for filename, text in rendered.items():
            data = text.encode()
            require((directory / name / filename).read_bytes() == data,
                    'Changed control proof: ' + name + '/' + filename)
            expected[name + '/' + filename] = sha(data)
        require(row.get('definitionsSha256') == expected[name + '/Definitions.v'],
                'Wrong definitions hash')
        require(row.get('counterexampleSha256') == expected[name + '/Counterexample.v'],
                'Wrong counterexample hash')
        for filename in CONTROL_LOG_FILES:
            logs[name + '/' + filename] = sha((directory / name / filename).read_bytes())
        require(row.get('rejectionLogSha256') == logs[name + '/rejection.log'],
                'Wrong rejection log hash')
    require(report.get('controlProofSha256') == expected,
            'Incomplete/changed control proof hash inventory')
    require(report.get('controlLogSha256') == logs,
            'Incomplete/changed control log hash inventory')
    return expected


def semantic_controls(rows, directory):
    contents = {k: Path(v['path']).read_text(encoding='utf-8') for k, v in rows.items()}
    reports = []
    generated = {}
    logs = {}
    for name in EXPECTED_CONTROLS:
        mutant, source_hash = source.mutated_projection(contents, name)
        case = directory / name
        case.mkdir()
        shutil.copy2(directory / (MODULE + '.vo'), case / (MODULE + '.vo'))
        rendered = render_control_sources(name, mutant)
        for filename, text in rendered.items():
            (case / filename).write_bytes(text.encode())
        definitions = rendered['Definitions.v']
        counter = rendered['Counterexample.v']
        run_command(['coqc', '-q', 'Definitions.v'], case, case / 'definitions.log')
        rejection = run_command(['coqc', '-q', 'OriginalBehavior.v'], case,
                                case / 'rejection.log', expect_rejection=True)
        run_command(['coqc', '-q', 'Counterexample.v'], case, case / 'counterexample.log')
        run_command(['coqchk', '-silent', 'Counterexample'], case,
                    case / 'counterexample-coqchk.log')
        require((case / 'counterexample.log').read_text().count(
            'Closed under the global context') == 1, 'Open semantic counterexample')
        reports.append(dict(name=name, definitionsCompiled=True,
                            definitionLanguage='Coq source projection',
                            certificateRejected=True, kernelExitCode=rejection,
                            kernelCounterexampleChecked=True, timedOut=False,
                            sourceMutationSha256=source_hash,
                            projectionSha256=sha(canonical(mutant)),
                            definitionsSha256=sha(definitions.encode()),
                            counterexampleSha256=sha(counter.encode()),
                            rejectionLogSha256=sha((case / 'rejection.log').read_bytes())))
        for filename in CONTROL_PROOF_FILES:
            generated[name + '/' + filename] = sha((case / filename).read_bytes())
        for filename in CONTROL_LOG_FILES:
            logs[name + '/' + filename] = sha((case / filename).read_bytes())
    return reports, generated, logs


def run(output, report_path):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    inputs = {str(p.resolve()): sha(p.read_bytes()) for p in input_paths()}
    projection, rows = source.project_production(output / 'source')
    (output / 'source-projection.json').write_bytes(canonical(projection))
    model = (HERE / 'coq/InteropFee.v').read_bytes()
    require(not re.search(rb'\b(?:Admitted|Axiom|admit|Abort)\b', model),
            'Unclosed interop charge model')
    require(b'Parameter' not in model,
            'Unexpected capitalised parameter declaration in the interop charge model')
    (output / (MODULE + '.v')).write_bytes(model)
    certificate = render_certificate(projection)
    (output / (ARTIFACT + '.v')).write_bytes(certificate.encode())
    run_command(['coqc', '-q', MODULE + '.v'], output, output / 'model.log')
    run_command(['coqc', '-q', ARTIFACT + '.v'], output, output / 'certificate.log')
    run_command(['coqchk', '-silent', ARTIFACT], output, output / 'coqchk.log')
    closed = {MODULE: declarations(model.decode()), ARTIFACT: declarations(certificate)}
    for filename, names in [('model.log', closed[MODULE]), ('certificate.log', closed[ARTIFACT])]:
        text = (output / filename).read_text()
        require(text.count('Closed under the global context') == len(names)
                and 'Axioms:' not in text, 'Assumption inventory not closed')
    controls, generated, logs = semantic_controls(rows, output)
    for path, expected in inputs.items():
        require(sha(Path(path).read_bytes()) == expected, 'Tool/model changed during proof')
    require(source.project_captured(rows) == projection, 'Source changed during proof')
    result = dict(schema='neoos-aa-interop-charge-proof/v1', scope=source.SCOPE,
                  entryBoundary=source.ENTRY_BOUNDARY, kernelChecked=True, coqchkChecked=True,
                  assumptionsClosed=True, productionSourceBound=True,
                  implementationVerified=False, fullImplementationVerified=False,
                  sourceFrontendVerified=False, applicationEngineVerified=False,
                  vmCorrespondenceProven=False, coreSourceCommit=source.CORE_COMMIT,
                  pinnedSource=rows, program=projection['program'],
                  reasonOnlyGuards=projection['reasonOnlyGuards'],
                  sourceProjectionSha256=sha(canonical(projection)),
                  certificateSha256=sha(certificate.encode()),
                  modelSha256={MODULE: sha(model)}, inputSha256=inputs,
                  closedDeclarations=closed,
                  closedAssumptionCount=sum(map(len, closed.values())),
                  kernelDeclarations=declarations(certificate),
                  semanticControls=controls, controlProofSha256=generated,
                  controlLogSha256=logs, preconditions=PRECONDITIONS, unproved=UNPROVED, tcb=TCB,
                  outputDirectory=str(output.resolve()))
    require(regenerate_certificate(result, output) == certificate.encode(),
            'Regenerated certificate mismatch')
    regenerate_controls(result, output)
    Path(report_path).parent.mkdir(parents=True, exist_ok=True)
    Path(report_path).write_text(json.dumps(result, indent=2) + '\n')
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--json-report', type=Path, required=True)
    args = parser.parse_args(argv)
    failure = dict(schema='neoos-aa-interop-charge-proof/v1', scope=source.SCOPE, status='FAIL',
                   kernelChecked=False, fullImplementationVerified=False)
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    args.json_report.write_text(json.dumps(failure) + '\n')
    try:
        run(args.output_dir, args.json_report)
        return 0
    except Exception as error:
        failure['error'] = str(error)
        args.json_report.write_text(json.dumps(failure, indent=2) + '\n')
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Kernel certificates for exception identity and catchability.

Binds the record projected from the pinned C# to `reviewed_program`, re-derives
every reviewed field for that record, instantiates the admission and surfacing
theorems at it, and re-checks one observable per pinned decision. No instruction
semantics, no transaction layer, and no VM correspondence claim.
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
    from . import exception_identity_source as source
except ImportError:
    import exception_identity_source as source
HERE = Path(__file__).resolve().parent
MODULE = 'ExceptionIdentity'
ARTIFACT = 'ExceptionIdentityArtifact'
EXPECTED_CONTROLS = source.EXPECTED_CONTROLS
PRECONDITIONS, UNPROVED, TCB = source.PRECONDITIONS, source.UNPROVED, source.TCB
require, sha, canonical = source.require, source.sha, source.canonical
PRELUDE = ('From Coq Require Import List Bool Arith.\n'
           'Require Import ExceptionIdentity.\nImport ListNotations.\n')

# The projected step names, in the order the model names its constructors.
STEP_CONSTRUCTORS = {'read-instruction': 'ReadInstruction',
                     'guarded-catch': 'GuardedCatch',
                     'post-hook': 'PostHook',
                     'advance-pointer': 'AdvancePointer',
                     'fault-handler': 'FaultHandler'}

# The record's binder order, the projected field each one corresponds to, and how
# a rendered literal keeps the declared type: '' is a bool, 'steps' is the
# ordered step list.
FIELDS = [('cp_steps', 'step_order', 'steps'),
          ('cp_catch_names_the_catchable_type', 'catch_names_the_catchable_type', ''),
          ('cp_catch_is_guarded_by_the_limit', 'catch_is_guarded_by_the_limit', ''),
          ('cp_generic_handler_is_untyped', 'the_generic_handler_is_untyped', ''),
          ('cp_caught_value_is_the_message', 'the_caught_value_is_the_message', ''),
          ('cp_fault_sets_the_state', 'the_fault_sets_the_state', ''),
          ('cp_thrown_value_is_recorded_at_entry', 'the_thrown_value_is_recorded_at_entry', ''),
          ('cp_a_handler_clears_the_recorded_value', 'a_handler_clears_the_recorded_value', ''),
          ('cp_the_handler_receives_the_thrown_value', 'the_handler_receives_the_thrown_value', ''),
          ('cp_the_walk_skips_the_finally_and_consumed_catch',
           'the_walk_skips_the_finally_and_consumed_catch', ''),
          ('cp_an_absent_handler_wraps_the_value', 'an_absent_handler_wraps_the_value', ''),
          ('cp_a_dedicated_catchable_type_exists', 'a_dedicated_catchable_type_exists', ''),
          ('cp_the_wrapper_keeps_the_thrown_object', 'the_wrapper_keeps_the_thrown_object', ''),
          ('cp_the_engine_records_the_fault', 'the_engine_records_the_fault', ''),
          ('cp_the_engine_clears_the_notifications', 'the_engine_clears_the_notifications', ''),
          ('cp_the_limit_defaults_to_catching', 'the_limit_defaults_to_catching', '')]

LIST_FIELDS = frozenset(('cp_steps',))

# Certificate declarations that read one projected field and assert the reviewed
# value. The key is the field's projected name.
FIELD_DECLARATIONS = {
    'catch_names_the_catchable_type': 'actual_the_catch_names_the_catchable_type',
    'catch_is_guarded_by_the_limit': 'actual_the_catch_is_guarded_by_the_limit',
    'the_generic_handler_is_untyped': 'actual_the_generic_handler_is_untyped',
    'the_caught_value_is_the_message': 'actual_the_caught_value_is_the_message',
    'the_fault_sets_the_state': 'actual_the_fault_sets_the_state',
    'the_thrown_value_is_recorded_at_entry': 'actual_the_thrown_value_is_recorded_at_entry',
    'a_handler_clears_the_recorded_value': 'actual_a_handler_clears_the_recorded_value',
    'the_handler_receives_the_thrown_value': 'actual_the_handler_receives_the_thrown_value',
    'the_walk_skips_the_finally_and_consumed_catch':
        'actual_the_walk_skips_the_finally_and_consumed_catch',
    'an_absent_handler_wraps_the_value': 'actual_an_absent_handler_wraps_the_value',
    'a_dedicated_catchable_type_exists': 'actual_a_dedicated_catchable_type_exists',
    'the_wrapper_keeps_the_thrown_object': 'actual_the_wrapper_keeps_the_thrown_object',
    'the_engine_records_the_fault': 'actual_the_engine_records_the_fault',
    'the_engine_clears_the_notifications': 'actual_the_engine_clears_the_notifications',
    'the_limit_defaults_to_catching': 'actual_the_limit_defaults_to_catching',
}
require(set(FIELD_DECLARATIONS) == {projected for name, projected, kind in FIELDS if kind == ''},
        'Field declaration inventory does not cover the projected bool fields')


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
    return '(catch_program ' + ' '.join(rendered) + ')'


# One concrete observation per mutant. The expression reads only the decision the
# mutant moves, and `expected` is what the pinned program yields on it.
CONTROL_CASES = {
 'drop-the-limit-guard':
    ('admits mutant_program Catchable false', 'false'),
 'name-the-base-type-in-the-guarded-clause':
    ('cp_catch_names_the_catchable_type mutant_program', 'true'),
 'throw-the-exception-object-instead-of-its-message':
    ('o_the_contract_received_the_message (surfaced mutant_program Catchable true true)', 'true'),
 'make-the-outer-handler-typed':
    ('cp_generic_handler_is_untyped mutant_program', 'true'),
 'fault-without-setting-the-state':
    ('o_state_is_fault (surfaced mutant_program Uncatchable true false)', 'true'),
 'skip-recording-the-thrown-value':
    ('cp_thrown_value_is_recorded_at_entry mutant_program', 'true'),
 'never-clear-the-recorded-value':
    ('cp_a_handler_clears_the_recorded_value mutant_program', 'true'),
 'push-a-null-instead-of-the-thrown-value':
    ('cp_the_handler_receives_the_thrown_value mutant_program', 'true'),
 'treat-the-finally-frame-as-a-catch':
    ('cp_the_walk_skips_the_finally_and_consumed_catch mutant_program', 'true'),
 'let-the-unhandled-value-escape-unwrapped':
    ('o_the_host_recorded_the_wrapper (surfaced mutant_program Catchable true false)', 'true'),
 'give-the-catchable-exception-no-dedicated-type':
    ('cp_a_dedicated_catchable_type_exists mutant_program', 'true'),
 'drop-the-wrapped-object':
    ('cp_the_wrapper_keeps_the_thrown_object mutant_program', 'true'),
 'fault-without-recording-the-exception':
    ('o_the_host_recorded_the_original (surfaced mutant_program Uncatchable true false)', 'true'),
 'keep-the-notifications-on-fault':
    ('o_the_notifications_were_cleared (surfaced mutant_program Uncatchable true false)', 'true'),
 'default-the-limit-to-off':
    ('cp_the_limit_defaults_to_catching mutant_program', 'true'),
 'swap-the-hook-and-the-pointer-advance':
    ('earlier AdvancePointer PostHook (cp_steps mutant_program)', 'false'),
}
require(set(CONTROL_CASES) == set(EXPECTED_CONTROLS),
        'Control case inventory differs from the mutation set')


def field_declaration(name, projected):
    return ('Theorem %s :\n  %s actual_program = true.\nProof. reflexivity. Qed.'
            % (FIELD_DECLARATIONS[projected], name))


def render_certificate(projection):
    require(projection['entryBoundary'] == source.ENTRY_BOUNDARY, 'Unsupported entry boundary')
    lines = [PRELUDE,
     'Definition actual_program := ' + program_expression(projection['program']) + '.',
     'Theorem actual_program_matches_reviewed_semantics : actual_program = reviewed_program.\n'
     'Proof. reflexivity. Qed.',
     # The correspondence claims proper: every value read out of the C# has to
     # land on the reviewed constant, not merely be well typed.
     'Theorem actual_step_order :\n'
     '  cp_steps actual_program =\n'
     '  [ReadInstruction; GuardedCatch; PostHook; AdvancePointer; FaultHandler].\n'
     'Proof. reflexivity. Qed.',
     ]
    for name, projected, kind in FIELDS:
        if kind == '':
            lines.append(field_declaration(name, projected))
    # The admission and surfacing theorems, instantiated at the projected record
    # rather than at a record the certificate itself chose.
    lines.extend([
     'Theorem actual_the_catch_sits_before_the_fault_handler :\n'
     '  earlier GuardedCatch FaultHandler (cp_steps actual_program) = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_turning_the_limit_off_removes_catchability :\n'
     '  admits actual_program Catchable false = false.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_an_uncatchable_exception_never_reaches_a_handler :\n'
     '  forall limit handler,\n'
     '    o_a_handler_ran (surfaced actual_program Uncatchable limit handler) = false.\n'
     'Proof.\n'
     '  intros. apply (an_uncatchable_exception_never_reaches_a_handler\n'
     '                   actual_program limit handler).\n'
     'Qed.',
     'Theorem actual_the_contract_receives_the_message :\n'
     '  forall limit, admits actual_program Catchable limit = true ->\n'
     '    o_the_contract_received_the_message\n'
     '      (surfaced actual_program Catchable limit true) = true.\n'
     'Proof.\n'
     '  intros limit admitted.\n'
     '  rewrite (a_caught_turn_receives_the_message actual_program Catchable limit admitted).\n'
     '  reflexivity.\n'
     'Qed.',
     'Theorem actual_a_caught_turn_is_not_a_fault :\n'
     '  forall limit, admits actual_program Catchable limit = true ->\n'
     '    o_state_is_fault (surfaced actual_program Catchable limit true) = false.\n'
     'Proof.\n'
     '  intros limit admitted.\n'
     '  apply (a_caught_turn_is_not_a_fault actual_program Catchable limit admitted).\n'
     'Qed.',
     'Theorem actual_a_caught_turn_records_no_wrapper :\n'
     '  forall limit, admits actual_program Catchable limit = true ->\n'
     '    o_the_host_recorded_the_wrapper\n'
     '      (surfaced actual_program Catchable limit true) = false.\n'
     'Proof.\n'
     '  intros limit admitted.\n'
     '  apply (a_caught_turn_records_no_wrapper actual_program Catchable limit admitted).\n'
     'Qed.',
     'Theorem actual_a_caught_turn_records_no_exception :\n'
     '  forall limit, admits actual_program Catchable limit = true ->\n'
     '    o_the_host_recorded_the_original\n'
     '      (surfaced actual_program Catchable limit true) = false.\n'
     'Proof.\n'
     '  intros limit admitted.\n'
     '  apply (a_caught_turn_records_no_exception_at_all actual_program Catchable limit admitted).\n'
     'Qed.',
     'Theorem actual_a_caught_throw_leaves_the_notifications_alone :\n'
     '  forall limit, admits actual_program Catchable limit = true ->\n'
     '    o_the_notifications_were_cleared\n'
     '      (surfaced actual_program Catchable limit true) = false.\n'
     'Proof.\n'
     '  intros limit admitted.\n'
     '  apply (a_caught_throw_leaves_the_notifications_alone\n'
     '           actual_program Catchable limit admitted).\n'
     'Qed.',
     'Theorem actual_the_fault_path_clears_the_notifications :\n'
     '  forall kind limit handler, admits actual_program kind limit = false ->\n'
     '    o_the_notifications_were_cleared\n'
     '      (surfaced actual_program kind limit handler) = true.\n'
     'Proof.\n'
     '  intros kind limit handler refused.\n'
     '  rewrite (the_fault_path_always_clears_the_notifications\n'
     '             actual_program kind limit handler refused).\n'
     '  reflexivity.\n'
     'Qed.',
     'Theorem actual_a_faulted_turn_skips_the_pointer_advance :\n'
     '  forall kind limit handler, admits actual_program kind limit = false ->\n'
     '    o_the_pointer_advanced (surfaced actual_program kind limit handler) = false.\n'
     'Proof.\n'
     '  intros kind limit handler refused.\n'
     '  apply (a_faulted_turn_skips_the_pointer_advance\n'
     '           actual_program kind limit handler refused).\n'
     '  reflexivity.\n'
     'Qed.',
     'Theorem actual_the_wrapper_and_the_original_are_never_both_recorded :\n'
     '  forall kind limit handler,\n'
     '    o_the_host_recorded_the_wrapper\n'
     '      (surfaced actual_program kind limit handler) = true ->\n'
     '    o_the_host_recorded_the_original\n'
     '      (surfaced actual_program kind limit handler) = false.\n'
     'Proof.\n'
     '  intros kind limit handler wrapper.\n'
     '  apply (the_wrapper_and_the_original_are_never_both_recorded\n'
     '           actual_program kind limit handler wrapper).\n'
     'Qed.',
     'Theorem actual_failures_the_engine_does_not_catch_are_indistinguishable :\n'
     '  forall limit handler (k1 k2 : FaultKind),\n'
     '    admits actual_program k1 limit = false ->\n'
     '    admits actual_program k2 limit = false ->\n'
     '    surfaced actual_program k1 limit handler\n'
     '      = surfaced actual_program k2 limit handler.\n'
     'Proof.\n'
     '  intros limit handler k1 k2 first second.\n'
     '  apply (failures_the_engine_does_not_catch_are_indistinguishable\n'
     '           actual_program limit handler k1 k2 first second).\n'
     'Qed.',
     'Theorem actual_the_reviewed_record_admits_a_catchable_throw :\n'
     '  admits actual_program Catchable true = true.\n'
     'Proof. reflexivity. Qed.',
     ])
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
    return [HERE / 'exception_identity_source.py', HERE / 'exception_identity_proofs.py',
            HERE / 'coq/ExceptionIdentity.v']


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
        require(report.get(field) == value, 'Changed exception identity domain: ' + field)
    require(report.get('coreSourceCommit') == source.CORE_COMMIT, 'Wrong core source pin')
    require(report.get('vmSourceCommit') == source.VM_COMMIT, 'Wrong VM source pin')
    require(report.get('modelSha256') == {MODULE: sha((HERE / 'coq/ExceptionIdentity.v').read_bytes())},
            'Wrong model inventory')
    expected = {MODULE: declarations((HERE / 'coq/ExceptionIdentity.v').read_text()),
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
    model = (HERE / 'coq/ExceptionIdentity.v').read_bytes()
    require(not re.search(rb'\b(?:Admitted|Axiom|admit|Abort)\b', model),
            'Unclosed exception identity model')
    require(b'Parameter' not in model,
            'Unexpected capitalised parameter declaration in the exception identity model')
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
    result = dict(schema='neoos-sa-exception-identity-proof/v1', scope=source.SCOPE,
                  entryBoundary=source.ENTRY_BOUNDARY, kernelChecked=True, coqchkChecked=True,
                  assumptionsClosed=True, productionSourceBound=True,
                  implementationVerified=False, fullImplementationVerified=False,
                  sourceFrontendVerified=False, applicationEngineVerified=False,
                  vmCorrespondenceProven=False, coreSourceCommit=source.CORE_COMMIT,
                  vmSourceCommit=source.VM_COMMIT,
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
    failure = dict(schema='neoos-sa-exception-identity-proof/v1', scope=source.SCOPE, status='FAIL',
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

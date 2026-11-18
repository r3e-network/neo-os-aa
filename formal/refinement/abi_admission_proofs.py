#!/usr/bin/env python3
"""Kernel certificates for load-time manifest and method-token admission.

Binds the record projected from the pinned C# to `reviewed_program`, re-derives
every reviewed field for that record, instantiates the guard and bound theorems
at it, and re-checks one observable per pinned decision. No deployment path, no
gas, and no compiler correspondence claim.
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
    from . import abi_admission_source as source
except ImportError:
    import abi_admission_source as source
HERE = Path(__file__).resolve().parent
MODULE = 'LoadAdmission'
ARTIFACT = 'LoadAdmissionArtifact'
EXPECTED_CONTROLS = source.EXPECTED_CONTROLS
PRECONDITIONS, UNPROVED, TCB = source.PRECONDITIONS, source.UNPROVED, source.TCB
require, sha, canonical = source.require, source.sha, source.canonical
PRELUDE = ('From Coq Require Import List Bool Arith.\n'
           'Require Import LoadAdmission.\nImport ListNotations.\n')

# The projected step names, in the order the model names its constructors.
STEP_CONSTRUCTORS = {'read-magic': 'ReadMagic',
                     'read-compiler': 'ReadCompiler',
                     'read-source': 'ReadSource',
                     'read-reserve-byte': 'ReadReserveByte',
                     'read-tokens': 'ReadTokens',
                     'read-reserve-short': 'ReadReserveShort',
                     'read-script': 'ReadScript',
                     'verify-checksum': 'VerifyChecksum'}

# The record's binder order, the projected field each one corresponds to, and
# how a rendered literal keeps the declared type: '' is a bool, 'steps' is the
# ordered step list, 'nat' is a declared bound.
FIELDS = [
    ('ap_steps', 'step_order', 'steps'),
    ('ap_magic_is_the_declared_nef3_constant', 'magic_is_the_declared_nef3_constant', ''),
    ('ap_the_reserved_fields_must_be_zero', 'the_reserved_fields_must_be_zero', ''),
    ('ap_token_array_cap', 'token_array_cap', 'nat'),
    ('ap_the_script_cannot_be_empty', 'the_script_cannot_be_empty', ''),
    ('ap_the_checksum_is_compared_for_inequality',
     'the_checksum_is_compared_for_inequality', ''),
    ('ap_the_checksum_check_is_guarded_by_the_verify_flag',
     'the_checksum_check_is_guarded_by_the_verify_flag', ''),
    ('ap_a_token_method_cannot_start_with_underscore',
     'a_token_method_cannot_start_with_underscore', ''),
    ('ap_token_method_name_limit', 'token_method_name_limit', 'nat'),
    ('ap_a_token_flag_byte_must_be_a_declared_flag',
     'a_token_flag_byte_must_be_a_declared_flag', ''),
    ('ap_the_manifest_name_cannot_be_empty', 'the_manifest_name_cannot_be_empty', ''),
    ('ap_the_features_field_must_be_empty', 'the_features_field_must_be_empty', ''),
    ('ap_the_manifest_names_cannot_repeat', 'the_manifest_names_cannot_repeat', ''),
    ('ap_manifest_length_cap', 'manifest_length_cap', 'nat'),
    ('ap_the_manifest_length_cap_is_enforced_before_parsing',
     'the_manifest_length_cap_is_enforced_before_parsing', ''),
    ('ap_the_abi_needs_at_least_one_method', 'the_abi_needs_at_least_one_method', ''),
    ('ap_the_exact_lookup_is_keyed_by_name_and_arity',
     'the_exact_lookup_is_keyed_by_name_and_arity', ''),
    ('ap_the_arity_is_range_checked', 'the_arity_is_range_checked', ''),
    ('ap_the_wildcard_lookup_ignores_the_arity', 'the_wildcard_lookup_ignores_the_arity', ''),
    ('ap_the_exact_lookup_returns_null_when_absent',
     'the_exact_lookup_returns_null_when_absent', ''),
    ('ap_a_method_name_cannot_be_empty', 'a_method_name_cannot_be_empty', ''),
    ('ap_a_method_parameter_name_cannot_repeat', 'a_method_parameter_name_cannot_repeat', ''),
    ('ap_a_method_return_type_must_be_defined', 'a_method_return_type_must_be_defined', ''),
    ('ap_a_method_offset_cannot_be_negative', 'a_method_offset_cannot_be_negative', ''),
]

LIST_FIELDS = frozenset(('ap_steps',))
NAT_FIELDS = frozenset(name for name, _, kind in FIELDS if kind == 'nat')

# Certificate declarations that read one projected boolean and assert the
# reviewed value. The key is the field's projected name.
FIELD_DECLARATIONS = {projected: 'actual_' + projected
                      for _, projected, kind in FIELDS if kind == ''}
require(set(FIELD_DECLARATIONS) == {projected for _, projected, kind in FIELDS if kind == ''},
        'Field declaration inventory does not cover the projected bool fields')

# The reviewed value of each declared bound, pinned here rather than read from
# the projection: a projection that agreed with a weakened constant would prove
# nothing about the source.
BOUND_DECLARATIONS = {'token_array_cap': 128,
                      'token_method_name_limit': 32,
                      'manifest_length_cap': 65535}
require(set(BOUND_DECLARATIONS) == {projected for _, projected, kind in FIELDS if kind == 'nat'},
        'Bound declaration inventory does not cover the declared bounds')


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
        elif name in NAT_FIELDS:
            # `True` is `1` in Python, so a bound that held a bool would render
            # as a nat and only fail much later.
            require(suffix == 'nat' and type(value) is int, 'Unsupported field value: ' + projected)
            require(0 <= value < 2 ** 32, 'Bound out of the declared nat range: ' + projected)
            rendered.append(str(value))
        else:
            require(suffix == '' and type(value) is bool, 'Unsupported field value: ' + projected)
            rendered.append('true' if value else 'false')
    return '(admission_program ' + ' '.join(rendered) + ')'


# One concrete observation per mutant. The expression reads only the decision the
# mutant moves, and `expected` is what the pinned program yields on it.
CONTROL_CASES = {
 'accept-a-foreign-magic': ('guard mutant_program GMagic', 'true'),
 'accept-a-nonzero-reserve-byte': ('guard mutant_program GReserves', 'true'),
 'accept-a-nonzero-reserve-short': ('guard mutant_program GReserves', 'true'),
 'raise-the-token-array-cap': ('ap_token_array_cap mutant_program', '128'),
 'accept-an-empty-script': ('guard mutant_program GScript', 'true'),
 'compare-the-checksum-for-equality': ('guard mutant_program GChecksumForm', 'true'),
 'verify-past-the-declared-flag': ('guard mutant_program GVerifyFlag', 'true'),
 'allow-a-underscore-method': ('guard mutant_program GUnderscore', 'true'),
 'raise-the-method-name-limit': ('ap_token_method_name_limit mutant_program', '32'),
 'mask-the-flag-byte-against-one-flag': ('guard mutant_program GFlagByte', 'true'),
 'accept-an-empty-manifest-name': ('guard mutant_program GManifestName', 'true'),
 'accept-a-populated-features-field': ('guard mutant_program GFeatures', 'true'),
 'accept-repeated-standards': ('guard mutant_program GRepeatedNames', 'true'),
 'accept-repeated-permission-subjects': ('guard mutant_program GRepeatedNames', 'true'),
 'accept-repeated-trusts': ('guard mutant_program GRepeatedNames', 'true'),
 'raise-the-manifest-length-cap': ('ap_manifest_length_cap mutant_program', '65535'),
 'read-the-reserve-before-the-source':
    ('earlier ReadSource ReadReserveByte (ap_steps mutant_program)', 'true'),
 'accept-a-zero-length-manifest': ('guard mutant_program GManifestLength', 'true'),
 'accept-an-empty-abi': ('guard mutant_program GAbiNonEmpty', 'true'),
 'key-the-exact-lookup-by-the-name-only': ('guard mutant_program GArityKey', 'true'),
 'drop-the-arity-range-check': ('guard mutant_program GArityRange', 'true'),
 'make-the-wildcard-respect-the-arity': ('guard mutant_program GWildcard', 'true'),
 'hand-back-a-method-when-the-lookup-misses': ('guard mutant_program GMissIsNull', 'true'),
 'accept-an-empty-method-name': ('guard mutant_program GMethodName', 'true'),
 'accept-repeated-parameter-names': ('guard mutant_program GParamNames', 'true'),
 'accept-an-undeclared-return-type': ('guard mutant_program GReturnType', 'true'),
 'accept-a-negative-offset': ('guard mutant_program GOffset', 'true'),
}
require(set(CONTROL_CASES) == set(EXPECTED_CONTROLS),
        'Control case inventory differs from the mutation set')


def render_certificate(projection):
    require(projection['entryBoundary'] == source.ENTRY_BOUNDARY, 'Unsupported entry boundary')
    lines = [PRELUDE,
     'Definition actual_program := ' + program_expression(projection['program']) + '.',
     'Theorem actual_program_matches_reviewed_semantics : actual_program = reviewed_program.\n'
     'Proof. reflexivity. Qed.',
     # The correspondence claims proper: every value read out of the C# has to
     # land on the reviewed constant, not merely be well typed.
     'Theorem actual_step_order :\n'
     '  ap_steps actual_program =\n'
     '  [ReadMagic; ReadCompiler; ReadSource; ReadReserveByte;\n'
     '   ReadTokens; ReadReserveShort; ReadScript; VerifyChecksum].\n'
     'Proof. reflexivity. Qed.',
     ]
    for name, projected, kind in FIELDS:
        if kind == '':
            lines.append('Theorem %s :\n  %s actual_program = true.\nProof. reflexivity. Qed.'
                         % (FIELD_DECLARATIONS[projected], name))
        elif kind == 'nat':
            lines.append('Theorem actual_%s :\n  %s actual_program = %d.\nProof. reflexivity. Qed.'
                         % (projected, name, BOUND_DECLARATIONS[projected]))
    # The guard and bound theorems, instantiated at the projected record rather
    # than at a record the certificate itself chose.
    lines.extend([
     'Theorem actual_admitted : admitted actual_program = true.\nProof. reflexivity. Qed.',
     'Theorem actual_every_guard_holds :\n'
     '  forall g, In g guards -> guard actual_program g = true.\n'
     'Proof.\n'
     '  intros g Hin.\n'
     '  exact (an_admitted_program_passes_every_guard\n'
     '           actual_program actual_admitted g Hin).\n'
     'Qed.',
     'Theorem actual_a_refused_guard_refuses_the_declaration :\n'
     '  forall g, In g guards -> guard actual_program g = false ->\n'
     '    admitted actual_program = false.\n'
     'Proof.\n'
     '  intros g Hin Hfalse.\n'
     '  exact (a_single_false_guard_refuses actual_program g Hin Hfalse).\n'
     'Qed.',
     'Theorem actual_the_magic_is_read_before_the_tokens :\n'
     '  earlier ReadMagic ReadTokens (ap_steps actual_program) = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_the_tokens_are_read_before_the_script :\n'
     '  earlier ReadTokens ReadScript (ap_steps actual_program) = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_the_script_is_read_before_the_checksum :\n'
     '  earlier ReadScript VerifyChecksum (ap_steps actual_program) = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_the_checksum_is_the_last_read :\n'
     '  forall s, In s (ap_steps actual_program) ->\n'
     '    s = VerifyChecksum \\/ earlier s VerifyChecksum (ap_steps actual_program) = true.\n'
     'Proof.\n'
     '  intros s Hin.\n'
     '  apply (the_checksum_is_the_last_read s).\n'
     '  rewrite actual_step_order in Hin. exact Hin.\n'
     'Qed.',
     'Theorem actual_the_token_cap_is_inclusive :\n'
     '  within (ap_token_array_cap actual_program) 128 = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_one_past_the_token_cap_is_refused :\n'
     '  within (ap_token_array_cap actual_program) 129 = false.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_the_name_limit_is_inclusive :\n'
     '  within (ap_token_method_name_limit actual_program) 32 = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_the_manifest_cap_is_inclusive :\n'
     '  within (ap_manifest_length_cap actual_program) 65535 = true.\n'
     'Proof. vm_compute. reflexivity. Qed.',
     'Theorem actual_the_reviewed_maxima_load :\n'
     '  loads actual_program 128 32 65535 = true.\n'
     'Proof. vm_compute. reflexivity. Qed.',
     'Theorem actual_one_token_past_the_cap_is_not_loaded :\n'
     '  loads actual_program 129 32 65535 = false.\n'
     'Proof. vm_compute. reflexivity. Qed.',
     'Theorem actual_loads_requires_the_guards :\n'
     '  forall t n m, loads actual_program t n m = true -> admitted actual_program = true.\n'
     'Proof.\n'
     '  intros t n m H.\n'
     '  exact (loads_requires_the_guards actual_program t n m H).\n'
     'Qed.',
     'Theorem actual_loads_requires_every_bound :\n'
     '  forall t n m, loads actual_program t n m = true ->\n'
     '    t <= ap_token_array_cap actual_program\n'
     '    /\\ n <= ap_token_method_name_limit actual_program\n'
     '    /\\ m <= ap_manifest_length_cap actual_program.\n'
     'Proof.\n'
     '  intros t n m H.\n'
     '  exact (loads_requires_every_bound actual_program t n m H).\n'
     'Qed.',
     'Theorem actual_a_count_past_the_token_cap_is_refused :\n'
     '  forall t n m, within (ap_token_array_cap actual_program) t = false ->\n'
     '    loads actual_program t n m = false.\n'
     'Proof.\n'
     '  intros t n m H.\n'
     '  exact (a_count_past_the_token_cap_is_refused actual_program t n m H).\n'
     'Qed.',
     'Theorem actual_a_name_past_the_limit_is_refused :\n'
     '  forall t n m, within (ap_token_method_name_limit actual_program) n = false ->\n'
     '    loads actual_program t n m = false.\n'
     'Proof.\n'
     '  intros t n m H.\n'
     '  exact (a_name_past_the_limit_is_refused actual_program t n m H).\n'
     'Qed.',
     'Theorem actual_the_guards_alone_do_not_admit_a_long_name :\n'
     '  forall n, within (ap_token_method_name_limit actual_program) n = false ->\n'
     '    loads actual_program 0 n 0 = false.\n'
     'Proof.\n'
     '  intros n H.\n'
     '  exact (the_guards_alone_do_not_admit_a_long_name actual_program n actual_admitted H).\n'
     'Qed.',
     ])
    text = '\n'.join(lines) + '\n'
    return text + '\n'.join('Print Assumptions ' + n + '.' for n in declarations(text)) + '\n'


def render_control_sources(name, mutant):
    expression, expected = CONTROL_CASES[name]
    header = PRELUDE
    if expected.isdigit():
        # A nat counterexample whose mutant value can be large (the manifest cap
        # mutant is 131070) must not ask the kernel to convert a deep unary
        # numeral: `vm_compute` on `x <> 65535` leaves `discriminate` a proof
        # whose final kernel re-check recurses to the full magnitude and
        # overflows the smaller Windows process stack. The decidable equality
        # keeps the whole computation inside the bytecode VM, so the kernel only
        # checks `eq_refl : false = false`.
        changed = ('Example changed_behavior : Nat.eqb (' + expression + ') (' + expected + ') = false.\n'
                   'Proof. vm_compute. reflexivity. Qed.\n')
    else:
        changed = ('Example changed_behavior : ' + expression + ' <> ' + expected + '.\n'
                   'Proof. vm_compute. discriminate. Qed.\n')
    return {
     'Definitions.v': header + 'Definition mutant_program := '
                      + program_expression(mutant['program']) + '.\n',
     'OriginalBehavior.v': PRELUDE + 'Require Import Definitions.\nExample original_behavior : '
                           + expression + ' = ' + expected + '.\nProof. vm_compute. reflexivity. Qed.\n',
     'Counterexample.v': PRELUDE + 'Require Import Definitions.\n' + changed +
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
    return [HERE / 'abi_admission_source.py', HERE / 'abi_admission_proofs.py',
            HERE / 'coq/LoadAdmission.v']


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
        require(report.get(field) == value, 'Changed load admission domain: ' + field)
    require(report.get('coreSourceCommit') == source.CORE_COMMIT, 'Wrong core source pin')
    require(report.get('modelSha256') == {MODULE: sha((HERE / 'coq/LoadAdmission.v').read_bytes())},
            'Wrong model inventory')
    expected = {MODULE: declarations((HERE / 'coq/LoadAdmission.v').read_text()),
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
    model = (HERE / 'coq/LoadAdmission.v').read_bytes()
    require(not re.search(rb'\b(?:Admitted|Axiom|admit|Abort)\b', model),
            'Unclosed load admission model')
    require(b'Parameter' not in model,
            'Unexpected capitalised parameter declaration in the load admission model')
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
    result = dict(schema='neoos-sa-load-admission-proof/v1', scope=source.SCOPE,
                  entryBoundary=source.ENTRY_BOUNDARY, kernelChecked=True, coqchkChecked=True,
                  assumptionsClosed=True, productionSourceBound=True,
                  implementationVerified=False, fullImplementationVerified=False,
                  sourceFrontendVerified=False, applicationEngineVerified=False,
                  vmCorrespondenceProven=False, deploymentPathVerified=False,
                  coreSourceCommit=source.CORE_COMMIT,
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
    failure = dict(schema='neoos-sa-load-admission-proof/v1', scope=source.SCOPE, status='FAIL',
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

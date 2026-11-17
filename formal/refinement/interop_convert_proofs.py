#!/usr/bin/env python3
"""Kernel certificates for the interop argument-conversion layer.

Binds the record projected from the pinned C# to canonical_convert, re-derives
every reviewed field for that record, instantiates the structural theorems at it,
and re-checks one semantic mutant per pinned decision. No handler execution and
no VM correspondence claim.
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
    from . import interop_convert_source as source
except ImportError:
    import interop_convert_source as source
HERE = Path(__file__).resolve().parent
MODULE = 'InteropConvert'
ARTIFACT = 'InteropConvertArtifact'
EXPECTED_CONTROLS = source.EXPECTED_CONTROLS
PRECONDITIONS, UNPROVED, TCB = source.PRECONDITIONS, source.UNPROVED, source.TCB
require, sha, canonical = source.require, source.sha, source.canonical
PRELUDE = ('From Coq Require Import NArith PeanoNat List Bool Lia.\n'
           'Require Import InteropConvert.\nImport ListNotations.\n')

# The record's binder order, the projected field each one corresponds to, and the
# numeric suffix a rendered literal needs so the term keeps the declared type.
FIELDS = [('ic_arity', 'argument_count', ''),
          ('ic_arity_from_descriptor', 'argument_count_from_descriptor', ''),
          ('ic_one_pop_per_parameter', 'pops_one_item_per_parameter', ''),
          ('ic_reverse_index', 'pop_order_is_reversed', ''),
          ('ic_push_only_nonvoid', 'return_pushes_only_for_nonvoid_handler', ''),
          ('ic_return_drops_nulls', 'return_payload_drops_nulls', ''),
          ('ic_byte_excluded', 'array_branch_excludes_byte_element', ''),
          ('ic_element_converter', 'array_element_converter_from_element_type', ''),
          ('ic_enum_converter', 'enum_converter_from_underlying_type', ''),
          ('ic_unknown_is_interface', 'unknown_type_is_interface', ''),
          ('ic_plain_array_identity', 'identity_converter_for_plain_array', ''),
          ('ic_payload_length', 'payload_branch_length_is_item_count', ''),
          ('ic_payload_order', 'payload_branch_fills_in_index_order', ''),
          ('ic_counted_order', 'counted_branch_fills_in_index_order', ''),
          ('ic_counted_pops', 'counted_branch_pops_the_count', ''),
          ('ic_max_length', 'counted_branch_max_length', '%N'),
          ('ic_null_argument_check', 'null_argument_rejected', ''),
          ('ic_null_payload_check', 'null_element_rejected_in_payload_branch', ''),
          ('ic_null_counted_check', 'null_element_rejected_in_counted_branch', '')]

def declarations(text):
    return re.findall(r'^(?:Theorem|Lemma|Example)\s+(\w+)\s*:',text,re.M)

# `1 == True` in Python, so a record whose numeric slot holds `True` would
# render as a boolean and only fail much later. The two numeric fields are named
# here so every other field has to be a bool.
NUMERIC_FIELDS = frozenset(('ic_arity', 'ic_max_length'))

def program_expression(program):
    require(set(program) == {projected for _,projected,_ in FIELDS},
            'Incomplete/extra projected program')
    rendered = []
    for name, projected, suffix in FIELDS:
        value = program[projected]
        if name in NUMERIC_FIELDS:
            require(type(value) is int and value >= 0, 'Unsupported field value: '+projected)
            rendered.append(str(value)+suffix)
        else:
            require(suffix == '' and isinstance(value, bool),
                    'Unsupported field value: '+projected)
            rendered.append('true' if value else 'false')
    return '(convert_program '+' '.join(rendered)+')'

# Every descriptor entry spells out all eight fields, so no default can slip in.
ENTRIES = {
 # A known, non-nullable scalar type: the ordinary argument shape.
 'entry_int': ('{| pa_is_array_type := false; pa_element_type := EOther; '
               'pa_element_nullable := false; pa_nullable := false; '
               'pa_is_stack_item := false; pa_known := true; pa_enum := false; '
               'pa_interface := false |}'),
 # The same shape, but the caller may pass null.
 'entry_nullable': ('{| pa_is_array_type := false; pa_element_type := EOther; '
                    'pa_element_nullable := false; pa_nullable := true; '
                    'pa_is_stack_item := false; pa_known := true; pa_enum := false; '
                    'pa_interface := false |}'),
 # An enumeration: rewritten through its underlying type.
 'entry_enum': ('{| pa_is_array_type := false; pa_element_type := EOther; '
                'pa_element_nullable := false; pa_nullable := false; '
                'pa_is_stack_item := false; pa_known := true; pa_enum := true; '
                'pa_interface := false |}'),
 # A type the converter table does not name: it goes through the interface path.
 'entry_unknown': ('{| pa_is_array_type := false; pa_element_type := EOther; '
                   'pa_element_nullable := false; pa_nullable := false; '
                   'pa_is_stack_item := false; pa_known := false; pa_enum := false; '
                   'pa_interface := false |}'),
 # A byte array: the type is an array, but IsArray excludes a byte element.
 'entry_bytes': ('{| pa_is_array_type := true; pa_element_type := EByte; '
                 'pa_element_nullable := false; pa_nullable := false; '
                 'pa_is_stack_item := false; pa_known := true; pa_enum := false; '
                 'pa_interface := false |}'),
 # A real array with a non-byte element, whose elements may not be null.
 'entry_array': ('{| pa_is_array_type := true; pa_element_type := EOther; '
                 'pa_element_nullable := false; pa_nullable := false; '
                 'pa_is_stack_item := false; pa_known := true; pa_enum := false; '
                 'pa_interface := false |}'),
}

# One call site per observable shape. `cs_window` is the window as the caller
# left it, before OnSysCall pops anything, and `cs_result` is what the handler
# would hand back.
PROBES = {
 # Two plain arguments, exactly filling the window.
 'probe_two': ('[entry_int; entry_int]', '[IntItem 11; IntItem 13]', 'ReturnVoid'),
 # Three items for two arguments: one is left over, so the drain is visible.
 'probe_three': ('[entry_int; entry_int]', '[IntItem 2; IntItem 11; IntItem 13]', 'ReturnVoid'),
 # The window supplies a null where a non-nullable argument is expected.
 'probe_null': ('[entry_int]', '[NullItem]', 'ReturnVoid'),
 # An enumeration argument.
 'probe_enum': ('[entry_enum]', '[IntItem 5]', 'ReturnVoid'),
 # A type the table does not name.
 'probe_unknown': ('[entry_unknown]', '[PlainItem]', 'ReturnVoid'),
 # A nested array handed to a scalar argument converted by the array entry.
 'probe_array_element': ('[entry_unknown]', '[ArrayItem []]', 'ReturnVoid'),
 # A byte array argument standing exactly on the excluded branch.
 'probe_bytes': ('[entry_bytes]', '[ArrayItem []]', 'ReturnVoid'),
 # An empty payload.
 'probe_payload_empty': ('[entry_array]', '[ArrayItem []]', 'ReturnVoid'),
 # A two-element payload, so the filling order is visible.
 'probe_payload_two': ('[entry_array]', '[ArrayItem [IntItem 1; IntItem 2]]', 'ReturnVoid'),
 # A payload with a null element.
 'probe_payload_null': ('[entry_array]', '[ArrayItem [NullItem]]', 'ReturnVoid'),
 # A counted argument of length two: the count is popped, then the items.
 'probe_counted': ('[entry_array]', '[IntItem 2; IntItem 1; IntItem 2]', 'ReturnVoid'),
 # A counted argument of length one whose single item is null.
 'probe_counted_null': ('[entry_array]', '[IntItem 1; NullItem]', 'ReturnVoid'),
 # A counted argument one past the canonical stack limit, with enough items.
 'probe_over_the_limit': ('[entry_array]',
                          'IntItem 3000 :: repeat (IntItem 1) 3000', 'ReturnVoid'),
 # No arguments at all, and a handler that returns an array holding a null.
 'probe_return': ('[]', '[]', 'ReturnPayload [IntItem 1; NullItem]'),
}

def render_probes():
    lines = ["Definition argument_vector (result : option (list (option Value) * list Item))"
             " : option (list (option Value)) :=",
             "  match result with None => None | Some (values, _) => Some values end.",
             "Definition leftover_window (result : option (list (option Value) * list Item))"
             " : option (list Item) :=",
             "  match result with None => None | Some (_, rest) => Some rest end.",
             "Definition faults (result : option (list (option Value) * list Item)) : bool :=",
             "  match result with None => true | Some _ => false end."]
    for name, text in ENTRIES.items():
        lines.append('Definition '+name+' : Param := '+text+'.')
    for name, (entries, window, result) in PROBES.items():
        lines.append('Definition '+name+' : CallSite := {| cs_entries := '+entries
                     +'; cs_window := '+window+'; cs_result := '+result+' |}.')
    return '\n'.join(lines)+'\n'

# One concrete observation per mutant. The expression reads only the field the
# mutant moves, and `expected` is what the pinned program yields on that probe.
CONTROL_CASES = {
 'read-arg-count-from-the-stack':
    ('leftover_window (on_syscall mutant_program probe_three)', 'Some [IntItem 13]'),
 'pop-twice-per-parameter':
    ('leftover_window (on_syscall mutant_program probe_three)', 'Some [IntItem 13]'),
 'fill-parameters-backwards':
    ('argument_vector (on_syscall mutant_program probe_two)',
     'Some [Some (VInt 11); Some (VInt 13)]'),
 'push-void-return':
    ('leftover_window (on_syscall mutant_program probe_two)', 'Some []'),
 'keep-null-return-elements':
    ('leftover_window (on_syscall mutant_program probe_return)',
     'Some [ArrayItem [IntItem 1]]'),
 'include-byte-arrays':
    ('argument_vector (on_syscall mutant_program probe_bytes)', 'Some [Some VPlain]'),
 'convert-elements-with-the-array-converter':
    ('argument_vector (on_syscall mutant_program probe_two)',
     'Some [Some (VInt 11); Some (VInt 13)]'),
 'convert-enums-as-integers':
    ('argument_vector (on_syscall mutant_program probe_enum)', 'Some [Some (VEnum 0)]'),
 'unknown-types-are-not-interfaces':
    ('argument_vector (on_syscall mutant_program probe_unknown)',
     'Some [Some VInterface]'),
 'copy-plain-array-elements':
    ('argument_vector (on_syscall mutant_program probe_array_element)',
     'Some [Some VPlain]'),
 'payload-length-is-not-the-item-count':
    ('argument_vector (on_syscall mutant_program probe_payload_empty)',
     'Some [Some (VArray [])]'),
 'fill-payload-elements-backwards':
    ('argument_vector (on_syscall mutant_program probe_payload_two)',
     'Some [Some (VArray [VInt 1; VInt 2])]'),
 'fill-counted-elements-backwards':
    ('argument_vector (on_syscall mutant_program probe_counted)',
     'Some [Some (VArray [VInt 1; VInt 2])]'),
 'keep-the-counted-items-on-the-stack':
    ('leftover_window (on_syscall mutant_program probe_counted)', 'Some []'),
 'weaken-the-stack-size-limit':
    ('faults (on_syscall mutant_program probe_over_the_limit)', 'true'),
 'allow-a-null-argument':
    ('faults (on_syscall mutant_program probe_null)', 'true'),
 'allow-a-null-payload-element':
    ('faults (on_syscall mutant_program probe_payload_null)', 'true'),
 'allow-a-null-counted-element':
    ('faults (on_syscall mutant_program probe_counted_null)', 'true'),
}
require(set(CONTROL_CASES) == set(EXPECTED_CONTROLS),
        'Control case inventory differs from the mutation set')

def render_certificate(projection):
    require(projection['entryBoundary'] == source.ENTRY_BOUNDARY, 'Unsupported entry boundary')
    lines = [PRELUDE,
     'Definition actual_program := '+program_expression(projection['program'])+'.',
     # The one variant the count-dropping theorem needs: everything as reviewed
     # except the pop, so the theorem is about that field alone.
     'Definition without_the_counted_pop :=\n'
     '  convert_program 4 true true true true true true true true true true true\n'
     '                  true true false 2048%N true true true.',
     'Theorem the_counted_pop_variant_only_drops_the_pop :\n'
     '  ic_counted_pops without_the_counted_pop = false.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_program_matches_reviewed_semantics : actual_program = canonical_convert.\n'
     'Proof. reflexivity. Qed.',
     # The correspondence claims proper: every value read out of the C# has to
     # land on the reviewed constant, not merely be well typed.
     'Theorem actual_argument_count : ic_arity actual_program = 4.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_reads_the_arity_from_the_descriptor :\n'
     '  ic_arity_from_descriptor actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_pops_one_item_per_argument :\n'
     '  ic_one_pop_per_parameter actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_fills_in_forward_index_order :\n'
     '  ic_reverse_index actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_pushes_only_a_value_return :\n'
     '  ic_push_only_nonvoid actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_return_drops_null_elements :\n'
     '  ic_return_drops_nulls actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_excludes_byte_arrays : ic_byte_excluded actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_keys_the_element_converter_by_element_type :\n'
     '  ic_element_converter actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_keys_the_enum_converter_by_underlying_type :\n'
     '  ic_enum_converter actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_unknown_type_goes_to_the_interface :\n'
     '  ic_unknown_is_interface actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_plain_array_converter_is_the_identity :\n'
     '  ic_plain_array_identity actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_payload_length_is_the_item_count :\n'
     '  ic_payload_length actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_payload_fills_in_index_order :\n'
     '  ic_payload_order actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_counted_fills_in_index_order :\n'
     '  ic_counted_order actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_counted_pops_the_count : ic_counted_pops actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_max_length_is_2048 : ic_max_length actual_program = 2048%N.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_rejects_a_null_argument :\n'
     '  ic_null_argument_check actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_rejects_a_null_payload_element :\n'
     '  ic_null_payload_check actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     'Theorem actual_rejects_a_null_counted_element :\n'
     '  ic_null_counted_check actual_program = true.\n'
     'Proof. reflexivity. Qed.',
     # The structural theorems, instantiated at the projected record rather than
     # at a record the certificate itself chose.
     'Theorem actual_vector_has_one_slot_per_declared_argument :\n'
     '  forall entries window values rest,\n'
     '    build_parameters actual_program entries window = Some (values, rest) ->\n'
     '    length values = length entries.\n'
     'Proof. apply the_vector_has_one_slot_per_declared_argument. Qed.',
     'Theorem actual_conversion_never_grows_the_window :\n'
     '  forall entry item window value rest,\n'
     '    convert_argument actual_program entry item window = Some (value, rest) ->\n'
     '    length rest <= length window.\n'
     'Proof. apply conversion_never_grows_the_window. Qed.',
     'Theorem actual_window_shrinks_by_the_arity :\n'
     '  forall entries window values rest,\n'
     '    build_parameters actual_program entries window = Some (values, rest) ->\n'
     '    length rest + length entries <= length window.\n'
     'Proof.\n'
     '  intros entries window values rest Hbuilt.\n'
     '  apply (the_window_shrinks_by_the_arity actual_program entries window values rest);\n'
     '    [reflexivity | exact Hbuilt].\n'
     'Qed.',
     'Theorem actual_byte_element_leaves_the_array_branch :\n'
     '  forall entry, element_is_byte entry = true ->\n'
     '  is_array_branch actual_program entry = false.\n'
     'Proof.\n'
     '  intros entry Hbyte. apply byte_element_leaves_the_array_branch;\n'
     '    [reflexivity | exact Hbyte].\n'
     'Qed.',
     'Theorem actual_counted_length_above_the_limit_faults :\n'
     '  forall entry count window, N.ltb 2048%N count = true ->\n'
     '  convert_counted actual_program entry count window = None.\n'
     'Proof.\n'
     '  intros entry count window Hlimit.\n'
     '  apply counted_length_above_the_limit_faults. exact Hlimit.\n'
     'Qed.',
     'Theorem actual_counted_length_at_the_limit_is_accepted :\n'
     '  forall entry window,\n'
     '    Nat.leb 2048 (length window) = true ->\n'
     '    convert_counted actual_program entry 2048%N window\n'
     '      = match convert_all actual_program entry\n'
     '                          (ic_null_counted_check actual_program) (firstn 2048 window) with\n'
     '        | None => None\n'
     '        | Some values =>\n'
     '            Some ((if ic_counted_order actual_program then values else rev values),\n'
     '                  (if ic_counted_pops actual_program then skipn 2048 window\n'
     '                   else window))\n'
     '        end.\n'
     'Proof.\n'
     '  intros entry window Hfit.\n'
     '  apply (counted_length_at_the_limit_is_accepted actual_program entry window).\n'
     '  exact Hfit.\n'
     'Qed.',
     'Theorem actual_counted_length_one_above_the_limit_faults :\n'
     '  forall entry window,\n'
     '    convert_counted actual_program entry (N.succ 2048%N) window = None.\n'
     'Proof. apply counted_length_one_above_the_limit_faults. Qed.',
     'Theorem actual_counted_items_stay_when_the_pop_is_dropped :\n'
     '  forall entry count window values,\n'
     '    convert_all without_the_counted_pop entry\n'
     '                (ic_null_counted_check actual_program)\n'
     '                (firstn (N.to_nat count) window) = Some values ->\n'
     '    N.ltb 2048%N count = false ->\n'
     '    Nat.leb (N.to_nat count) (length window) = true ->\n'
     '    convert_counted without_the_counted_pop entry count window\n'
     '      = Some ((if ic_counted_order actual_program then values else rev values),\n'
     '              window).\n'
     'Proof.\n'
     '  intros entry count window values Hvalues Hlimit Hfit.\n'
     '  apply (counted_items_stay_when_the_pop_is_dropped without_the_counted_pop\n'
     '           entry count window values);\n'
     '    [reflexivity | reflexivity | exact Hvalues | exact Hlimit | exact Hfit].\n'
     'Qed.',
     'Theorem actual_a_null_argument_faults :\n'
     '  forall entry window, entry.(pa_nullable) = false ->\n'
     '  entry.(pa_is_stack_item) = false ->\n'
     '  convert_argument actual_program entry NullItem window = None.\n'
     'Proof.\n'
     '  intros entry window Hnullable Hstack.\n'
     '  apply a_null_argument_faults_when_the_check_is_on;\n'
     '    [reflexivity | exact Hnullable | exact Hstack].\n'
     'Qed.',
     'Theorem actual_a_nullable_argument_accepts_null :\n'
     '  forall entry window, entry.(pa_nullable) = true -> entry.(pa_enum) = false ->\n'
     '  entry.(pa_interface) = false -> is_array_branch actual_program entry = false ->\n'
     '  convert_argument actual_program entry NullItem window = Some (Some VNull, window).\n'
     'Proof.\n'
     '  intros entry window Hnullable Henum Hinterface Hbranch.\n'
     '  apply a_nullable_argument_accepts_null;\n'
     '    try reflexivity; assumption.\n'
     'Qed.',
     'Theorem actual_a_void_return_pushes_nothing :\n'
     '  forall stack, tail_stack actual_program ReturnVoid stack = stack.\n'
     'Proof. intros stack. apply a_void_return_pushes_nothing. reflexivity. Qed.',
     'Theorem actual_returned_nulls_are_dropped :\n'
     '  forall payload,\n'
     '    payload_items actual_program payload\n'
     '      = filter (fun item => negb (is_null_item item)) payload.\n'
     'Proof. intros payload. apply returned_nulls_are_dropped. reflexivity. Qed.',
     'Theorem actual_enum_arguments_use_the_underlying_converter :\n'
     '  forall entry item, entry.(pa_enum) = true ->\n'
     '  convert_element actual_program entry item = Some VPlain ->\n'
     '  convert_scalar actual_program entry item = Some (VEnum 0).\n'
     'Proof.\n'
     '  intros entry item Henum Helement.\n'
     '  apply enum_arguments_use_the_underlying_converter;\n'
     '    [exact Henum | reflexivity | exact Helement].\n'
     'Qed.',
     'Theorem actual_unknown_types_need_the_interface_flag :\n'
     '  forall entry, entry.(pa_known) = false -> entry.(pa_is_array_type) = false ->\n'
     '  convert_element actual_program entry PlainItem = Some VInterface.\n'
     'Proof.\n'
     '  intros entry Hunknown Harray.\n'
     '  apply an_unknown_type_goes_to_the_interface;\n'
     '    try reflexivity; assumption.\n'
     'Qed.',
     ]
    text = '\n'.join(lines)+'\n'
    return text+'\n'.join('Print Assumptions '+n+'.' for n in declarations(text))+'\n'

def render_control_sources(name, mutant):
    expression, expected = CONTROL_CASES[name]
    header = PRELUDE+render_probes()
    return {
     'Definitions.v': header+'Definition mutant_program := '
                      +program_expression(mutant['program'])+'.\n',
     'OriginalBehavior.v': PRELUDE+'Require Import Definitions.\nExample original_behavior : '
                           +expression+' = '+expected+'.\nProof. vm_compute. reflexivity. Qed.\n',
     'Counterexample.v': PRELUDE+'Require Import Definitions.\nExample changed_behavior : '
                         +expression+' <> '+expected+'.\nProof. vm_compute. discriminate. Qed.\n'
                         'Print Assumptions changed_behavior.\n',
    }

CONTROL_PROOF_FILES = ('Definitions.v', 'OriginalBehavior.v', 'Counterexample.v')
CONTROL_LOG_FILES = ('definitions.log', 'rejection.log', 'counterexample.log',
                     'counterexample-coqchk.log')

def run_command(command,directory,log,*,expect_rejection=False):
    try:
        result=subprocess.run(command,cwd=directory,text=True,capture_output=True,timeout=1800)
    except subprocess.TimeoutExpired as error:
        Path(log).write_text(str(error));raise ValueError('Kernel command timed out') from error
    Path(log).write_text(result.stdout+result.stderr)
    require(result.returncode>0 if expect_rejection else result.returncode==0,
            'Unexpected kernel exit '+str(result.returncode)+': '+str(log))
    return result.returncode

def input_paths():
    return [HERE/'interop_convert_source.py',HERE/'interop_convert_proofs.py',
            HERE/'coq/InteropConvert.v']

def regenerate_certificate(report,evidence_dir):
    projection=source.project_captured(report['pinnedSource'])
    require((Path(evidence_dir)/'source-projection.json').read_bytes()==canonical(projection),
            'Source projection bytes differ from actual complete sources')
    require(report['sourceProjectionSha256']==sha(canonical(projection)),
            'Source projection hash mismatch')
    for field,value in [('preconditions',PRECONDITIONS),('unproved',UNPROVED),('tcb',TCB),
                        ('entryBoundary',source.ENTRY_BOUNDARY),('program',projection['program']),
                        ('reasonOnlyGuards',projection['reasonOnlyGuards'])]:
        require(report.get(field)==value,'Changed interop conversion domain: '+field)
    require(report.get('coreSourceCommit')==source.CORE_COMMIT,'Wrong core source pin')
    require(report.get('neoVmSourceCommit')==source.VM_COMMIT,'Wrong vm source pin')
    require(report.get('modelSha256')=={MODULE:sha((HERE/'coq/InteropConvert.v').read_bytes())},
            'Wrong model inventory')
    expected={MODULE:declarations((HERE/'coq/InteropConvert.v').read_text()),
              ARTIFACT:declarations(render_certificate(projection))}
    require(report.get('closedDeclarations')==expected,'Wrong declaration inventory')
    return render_certificate(projection).encode()

def regenerate_controls(report,evidence_dir):
    source.project_captured(report['pinnedSource'])
    contents={k:Path(v['path']).read_text(encoding='utf-8') for k,v in report['pinnedSource'].items()}
    rows=report.get('semanticControls')
    require(isinstance(rows,list) and len(rows)==len(EXPECTED_CONTROLS),
            'Incomplete semantic controls')
    require([row.get('name') for row in rows]==list(EXPECTED_CONTROLS),
            'Wrong semantic control inventory')
    expected={};logs={};directory=Path(evidence_dir)
    for name,row in zip(EXPECTED_CONTROLS,rows):
        mutant,mutation_hash=source.mutated_projection(contents,name)
        require(row.get('sourceMutationSha256')==mutation_hash,
                'Changed source mutation: '+name)
        require(row.get('projectionSha256')==sha(canonical(mutant)),
                'Changed mutant projection: '+name)
        rendered=render_control_sources(name,mutant)
        for filename,text in rendered.items():
            data=text.encode()
            require((directory/name/filename).read_bytes()==data,
                    'Changed control proof: '+name+'/'+filename)
            expected[name+'/'+filename]=sha(data)
        require(row.get('definitionsSha256')==expected[name+'/Definitions.v'],
                'Wrong definitions hash')
        require(row.get('counterexampleSha256')==expected[name+'/Counterexample.v'],
                'Wrong counterexample hash')
        for filename in CONTROL_LOG_FILES:
            logs[name+'/'+filename]=sha((directory/name/filename).read_bytes())
        require(row.get('rejectionLogSha256')==logs[name+'/rejection.log'],
                'Wrong rejection log hash')
    require(report.get('controlProofSha256')==expected,
            'Incomplete/changed control proof hash inventory')
    require(report.get('controlLogSha256')==logs,
            'Incomplete/changed control log hash inventory')
    return expected

def semantic_controls(rows,directory):
    contents={k:Path(v['path']).read_text(encoding='utf-8') for k,v in rows.items()}
    reports=[];generated={};logs={}
    for name in EXPECTED_CONTROLS:
        mutant,source_hash=source.mutated_projection(contents,name)
        case=directory/name;case.mkdir()
        shutil.copy2(directory/(MODULE+'.vo'),case/(MODULE+'.vo'))
        rendered=render_control_sources(name,mutant)
        for filename,text in rendered.items():(case/filename).write_bytes(text.encode())
        definitions=rendered['Definitions.v'];counter=rendered['Counterexample.v']
        run_command(['coqc','-q','Definitions.v'],case,case/'definitions.log')
        rejection=run_command(['coqc','-q','OriginalBehavior.v'],case,case/'rejection.log',
                              expect_rejection=True)
        run_command(['coqc','-q','Counterexample.v'],case,case/'counterexample.log')
        run_command(['coqchk','-silent','Counterexample'],case,case/'counterexample-coqchk.log')
        require((case/'counterexample.log').read_text().count('Closed under the global context')==1,
                'Open semantic counterexample')
        reports.append(dict(name=name,definitionsCompiled=True,
            definitionLanguage='Coq source projection',certificateRejected=True,
            kernelExitCode=rejection,kernelCounterexampleChecked=True,timedOut=False,
            sourceMutationSha256=source_hash,projectionSha256=sha(canonical(mutant)),
            definitionsSha256=sha(definitions.encode()),counterexampleSha256=sha(counter.encode()),
            rejectionLogSha256=sha((case/'rejection.log').read_bytes())))
        for filename in CONTROL_PROOF_FILES:
            generated[name+'/'+filename]=sha((case/filename).read_bytes())
        for filename in CONTROL_LOG_FILES:
            logs[name+'/'+filename]=sha((case/filename).read_bytes())
    return reports,generated,logs

def run(output,report_path):
    output=Path(output);output.mkdir(parents=True,exist_ok=True)
    inputs={str(p.resolve()):sha(p.read_bytes()) for p in input_paths()}
    projection,rows=source.project_production(output/'source')
    (output/'source-projection.json').write_bytes(canonical(projection))
    model=(HERE/'coq/InteropConvert.v').read_bytes()
    require(not re.search(rb'\b(?:Admitted|Axiom|admit|Abort)\b',model),
            'Unclosed interop conversion model')
    require(b'Parameter' not in model,
            'Unexpected Parameter declaration in the interop conversion model')
    (output/(MODULE+'.v')).write_bytes(model)
    certificate=render_certificate(projection);(output/(ARTIFACT+'.v')).write_bytes(certificate.encode())
    run_command(['coqc','-q',MODULE+'.v'],output,output/'model.log')
    run_command(['coqc','-q',ARTIFACT+'.v'],output,output/'certificate.log')
    run_command(['coqchk','-silent',ARTIFACT],output,output/'coqchk.log')
    closed={MODULE:declarations(model.decode()),ARTIFACT:declarations(certificate)}
    for filename,names in [('model.log',closed[MODULE]),('certificate.log',closed[ARTIFACT])]:
        text=(output/filename).read_text()
        require(text.count('Closed under the global context')==len(names) and 'Axioms:' not in text,
                'Assumption inventory not closed')
    controls,generated,logs=semantic_controls(rows,output)
    for path,expected in inputs.items():
        require(sha(Path(path).read_bytes())==expected,'Tool/model changed during proof')
    require(source.project_captured(rows)==projection,'Source changed during proof')
    result=dict(schema='neoos-aa-interop-conversion-proof/v1',scope=source.SCOPE,
        entryBoundary=source.ENTRY_BOUNDARY,kernelChecked=True,coqchkChecked=True,
        assumptionsClosed=True,productionSourceBound=True,implementationVerified=False,
        fullImplementationVerified=False,sourceFrontendVerified=False,
        applicationEngineVerified=False,vmCorrespondenceProven=False,
        coreSourceCommit=source.CORE_COMMIT,neoVmSourceCommit=source.VM_COMMIT,pinnedSource=rows,
        program=projection['program'],reasonOnlyGuards=projection['reasonOnlyGuards'],
        parameters=projection['parameters'],
        sourceProjectionSha256=sha(canonical(projection)),
        certificateSha256=sha(certificate.encode()),
        modelSha256={MODULE:sha(model)},inputSha256=inputs,closedDeclarations=closed,
        closedAssumptionCount=sum(map(len,closed.values())),
        kernelDeclarations=declarations(certificate),
        semanticControls=controls,controlProofSha256=generated,controlLogSha256=logs,
        preconditions=PRECONDITIONS,unproved=UNPROVED,tcb=TCB,
        outputDirectory=str(output.resolve()))
    require(regenerate_certificate(result,output)==certificate.encode(),
            'Regenerated certificate mismatch')
    regenerate_controls(result,output)
    Path(report_path).parent.mkdir(parents=True,exist_ok=True)
    Path(report_path).write_text(json.dumps(result,indent=2)+'\n');return result

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',type=Path,required=True)
    parser.add_argument('--json-report',type=Path,required=True)
    args=parser.parse_args(argv)
    failure=dict(schema='neoos-aa-interop-conversion-proof/v1',scope=source.SCOPE,status='FAIL',
                 kernelChecked=False,fullImplementationVerified=False)
    args.json_report.parent.mkdir(parents=True,exist_ok=True)
    args.json_report.write_text(json.dumps(failure)+'\n')
    try:run(args.output_dir,args.json_report);return 0
    except Exception as error:
        failure['error']=str(error);args.json_report.write_text(json.dumps(failure,indent=2)+'\n')
        print(str(error),file=sys.stderr);return 1
if __name__=='__main__':raise SystemExit(main())

"""Tests for the declared-argument face.

Two halves, and they are different. First, that the encoder this face rebuilds a
call frame with produces the bytes the VM uses — pinned against literal hex, not
against the exporter. Second, and the half that matters: that the face would
notice if the dump stopped describing the scenario, because a face that always
returns zero problems is indistinguishable from no face at all.

Both sides are mutated on purpose. A face that only distrusts the dump would pass
a scenario file edited after the run; a face that only distrusts the scenario
would pass an engine that answered something else.

The fixtures are synthetic: four methods, six steps, one deployment. The real
artifact is measured by the gate.
"""

import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import abi_scenario as sc

ADDRESS = '0x' + '11' * 20
OTHER = '0x' + '22' * 20
CONTRACT = '0x' + 'ab' * 20


def internal(address):
    return bytes(reversed(bytes.fromhex(address[2:])))


class EncoderTests(unittest.TestCase):
    """The frame this face rebuilds has to be the frame the VM executes."""

    def test_small_integers_use_the_single_byte_opcodes(self):
        self.assertEqual(sc.push_integer(0).hex(), '10')
        self.assertEqual(sc.push_integer(-1).hex(), '0f')
        self.assertEqual(sc.push_integer(1).hex(), '11')
        self.assertEqual(sc.push_integer(15).hex(), '1f')
        self.assertEqual(sc.push_integer(16).hex(), '20')

    def test_a_wide_integer_is_padded_to_the_declared_operand_width(self):
        # 604800 is three two's-complement bytes; PUSHINT32 takes four.
        self.assertEqual(sc.push_integer(604800).hex(), '02' + '803a0900')
        self.assertEqual(sc.push_integer(1_700_000_000_000).hex(), '03' + '0068e5cf8b010000')

    def test_a_byte_string_is_pushed_with_a_data_prefix_not_a_length_opcode(self):
        # Neo N3 has no PUSHBYTES opcodes: 0x14 is PUSH4, so a twenty-byte push
        # cannot be encoded as a length byte.
        self.assertEqual(sc.push_bytes(b'').hex(), '0c00')
        self.assertEqual(sc.push_bytes(b'\xab').hex(), '0c01ab')
        self.assertEqual(sc.push_bytes(b'\x11' * 20).hex(), '0c14' + '11' * 20)
        self.assertEqual(sc.push_bytes(b'\x11' * 256)[:3].hex(), '0d0001')

    def test_an_address_argument_is_pushed_little_endian(self):
        self.assertEqual(sc.argument_bytes({'type': 'Hash160', 'value': ADDRESS}).hex(), '11' * 20)
        self.assertEqual(sc.argument_bytes({'type': 'Hash160', 'value': '0x' + '11223344' + '55' * 16}).hex(),
                         '55555555555555555555555555555555' + '44332211')

    def test_an_address_of_the_wrong_width_is_refused(self):
        with self.assertRaises(AssertionError):
            sc.argument_bytes({'type': 'Hash160', 'value': '0x1122'})

    def test_a_whole_frame_is_the_bytes_the_vm_runs(self):
        step = {'id': 'x', 'method': 'm',
                'args': [{'type': 'Integer', 'value': '7'}, {'type': 'ByteString', 'value': 'ab'}]}
        # Arguments are packed in reverse, so the last declared one is pushed
        # first; PACK then fills index 0 from the top of the stack.
        expected = ('0c01ab' '17' '12' 'c0' '1f' '0c016d' '0c14' + 'ab' * 20
                    + '41' + '627d5b52')
        self.assertEqual(sc.step_script(step, CONTRACT).hex(), expected)

    def test_the_syscall_operand_is_derived_from_the_name(self):
        self.assertEqual(sc.syscall_operand('System.Contract.Call').hex(), '627d5b52')

    def test_a_nested_array_is_packed_in_the_same_reverse_order(self):
        step = {'id': 'x', 'method': 'm',
                'args': [{'type': 'Array', 'items': [{'type': 'Integer', 'value': '1'},
                                                     {'type': 'Integer', 'value': '2'}]}]}
        frame = sc.step_script(step, CONTRACT).hex()
        # inner: push 2, push 1, PUSH2, PACK ; outer: PUSH1, PACK
        self.assertTrue(frame.startswith('1211' + '12' + 'c0' + '11' + 'c0'), frame[:20])


class ScenarioFaceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix='sa-scenario-')
        self.addCleanup(shutil.rmtree, self.directory, True)
        self.scenario_path = os.path.join(self.directory, 'scenario.json')
        self.dump_path = os.path.join(self.directory, 'dump.json')
        self.manifest_path = os.path.join(self.directory, 'manifest.json')
        self.scenario = {
            'schema': sc.INPUT_SCHEMA,
            'name': 'fixture',
            'contractAddress': CONTRACT,
            'blockTimestamp': 1_700_000_000_000,
            'defaultSigner': ADDRESS,
            'steps': [
                {'id': 'derive', 'method': 'probe',
                 'args': [{'type': 'Hash160', 'value': OTHER}, {'type': 'ByteString', 'value': ''}],
                 'expect': 'HALT', 'readsForward': {'step': 'write', 'arg': 0}},
                {'id': 'write', 'method': 'store',
                 'args': [{'type': 'Hash160', 'value': ADDRESS}, {'type': 'String', 'value': 'hi'}],
                 'expect': 'HALT'},
                {'id': 'read', 'method': 'probe',
                 'args': [{'type': 'Hash160', 'value': ADDRESS}, {'type': 'ByteString', 'value': ''}],
                 'expect': 'HALT', 'readsBack': {'step': 'write', 'arg': 0}},
                {'id': 'count', 'method': 'count',
                 'args': [{'type': 'Integer', 'value': '3'}],
                 'expect': 'HALT', 'integer': '7'},
                {'id': 'flag', 'method': 'flag',
                 'args': [{'type': 'Hash160', 'value': ADDRESS}],
                 'expect': 'HALT', 'boolean': True},
                {'id': 'maybe', 'method': 'maybe',
                 'args': [{'type': 'Hash160', 'value': ADDRESS}], 'expect': 'HALT'},
                {'id': 'deny', 'method': 'deny', 'args': [],
                 'expect': 'FAULT', 'reason': 'not allowed'},
            ],
        }
        self.manifest = {'abi': {'methods': [
            {'name': 'probe', 'offset': 10, 'returntype': 'Hash160',
             'parameters': [{'name': 'a', 'type': 'Hash160'}, {'name': 'b', 'type': 'ByteString'}]},
            {'name': 'count', 'offset': 20, 'returntype': 'Integer',
             'parameters': [{'name': 'a', 'type': 'Integer'}]},
            {'name': 'flag', 'offset': 30, 'returntype': 'Boolean',
             'parameters': [{'name': 'a', 'type': 'Hash160'}]},
            {'name': 'maybe', 'offset': 40, 'returntype': 'Array',
             'parameters': [{'name': 'a', 'type': 'Hash160'}]},
            {'name': 'deny', 'offset': 50, 'returntype': 'Void', 'parameters': []},
            {'name': 'store', 'offset': 60, 'returntype': 'Void',
             'parameters': [{'name': 'a', 'type': 'Hash160'}, {'name': 'b', 'type': 'String'}]},
        ]}}

    # -- fixtures ---------------------------------------------------------

    def _address_of(self, step, scenario):
        """The address a step's frame carries: a named plugin's, or the account's."""
        name = step.get('target')
        if not name:
            return scenario['contractAddress']
        return next(entry['address'] for entry in scenario['modules']
                    if entry['name'] == name)

    def _results(self):
        """Per step: (state, result stack, extra fields)."""
        return {
            'derive': ('HALT', {'count': 1, 'type': 'ByteString', 'bytes': 20,
                                'hex': internal(ADDRESS).hex()}),
            'write': ('HALT', {'count': 1, 'type': 'Any'}),
            'read': ('HALT', {'count': 1, 'type': 'ByteString', 'bytes': 20,
                              'hex': internal(ADDRESS).hex()}),
            'count': ('HALT', {'count': 1, 'type': 'Integer', 'integer': '7', 'hex': '07'}),
            'flag': ('HALT', {'count': 1, 'type': 'Boolean', 'hex': '01'}),
            'maybe': ('HALT', {'count': 1, 'type': 'Any'}),
            'maybe-later': ('FAULT', {'count': 0}),
            'deny': ('FAULT', {'count': 0}),
        }

    def _dump(self, scenario=None):
        scenario = scenario or self.scenario
        results = self._results()
        rows = []
        for step in scenario['steps']:
            state, result = results.get(step['id'], ('HALT', {'count': 1, 'type': 'Any'}))
            row = {'id': step['id'], 'method': step['method'], 'state': state,
                   'target': step.get('target', 'account'),
                   'scriptHex': sc.step_script(step, self._address_of(step, scenario)).hex(),
                   'timestamp': int(step.get('timestamp', scenario['blockTimestamp'])),
                   'signer': str(step.get('signer') or scenario.get('defaultSigner')).lower()}
            row['scriptSha256'] = hashlib.sha256(bytes.fromhex(row['scriptHex'])).hexdigest()
            if state == 'FAULT':
                row['fault'] = 'ABORTMSG is executed. Reason: not allowed'
            for key, value in result.items():
                row['result' + key[0].upper() + key[1:]] = value
            rows.append(row)
        raw = json.dumps(scenario, sort_keys=True).encode()
        modules = []
        for entry in scenario.get('modules') or []:
            path = os.path.join(self.directory, entry['nef'])
            manifest = os.path.join(self.directory, entry['manifest'])
            with open(path, 'rb') as handle:
                nef_sha = hashlib.sha256(handle.read()).hexdigest()
            with open(manifest, 'rb') as handle:
                manifest_sha = hashlib.sha256(handle.read()).hexdigest()
            modules.append({'name': entry['name'], 'address': entry['address'],
                            'signer': entry['signer'], 'nef': entry['nef'],
                            'manifest': entry['manifest'], 'nefSha256': nef_sha,
                            'manifestSha256': manifest_sha})
        return {
            'schema': sc.SCHEMA,
            'scenario': {'name': scenario.get('name'), 'sha256': hashlib.sha256(raw).hexdigest()},
            'nef': {'sha256': 'n' * 64},
            'manifest': {'sha256': 'm' * 64},
            'deployed': {'hash': scenario['contractAddress']},
            'block': {'timestamp': scenario['blockTimestamp'],
                      'timestamps': sorted({row['timestamp'] for row in rows})},
            'engine': {},
            'modules': modules,
            'steps': rows,
        }

    def _write(self, scenario=None, dump=None, seal=True):
        scenario = scenario if scenario is not None else self.scenario
        dump = dump if dump is not None else self._dump(scenario)
        raw = json.dumps(scenario, sort_keys=False).encode()
        # The receipt compares the dump's note of the scenario against the bytes
        # on disk, so the dump is rebuilt against exactly those bytes - unless a
        # test is deliberately presenting a dump from another scenario.
        if seal:
            dump['scenario']['sha256'] = hashlib.sha256(raw).hexdigest()
        with open(self.scenario_path, 'wb') as handle:
            handle.write(raw)
        with open(self.manifest_path, 'w') as handle:
            json.dump(self.manifest, handle)
        with open(self.manifest_path, 'rb') as handle:
            dump['manifest']['sha256'] = hashlib.sha256(handle.read()).hexdigest()
        with open(self.dump_path, 'w') as handle:
            json.dump(dump, handle)
        return dump

    def _receipt(self, scenario=None, dump=None, seal=True):
        self._write(scenario, dump, seal)
        return sc.correspond(self.scenario_path, self.dump_path, self.manifest_path)

    def _problems(self, receipt):
        return [row[1] for row in receipt['problems']]

    # -- a step that lands on a deployed plugin --------------------------

    def _with_module(self):
        """The fixture plus one plugin: real bytes on disk, a declared address."""
        module_manifest = {'abi': {'methods': [
            {'name': 'core', 'offset': 5, 'returntype': 'Hash160', 'parameters': []},
            {'name': 'version', 'offset': 9, 'returntype': 'Integer', 'parameters': []},
        ]}}
        # The plugin lives beside the scenario, not in it: the path is relative to
        # the scenario file's own directory, which is what the exporter resolves it
        # against and what a consumer of the receipt has to resolve it against too.
        os.makedirs(os.path.join(self.directory, 'plugins'), exist_ok=True)
        with open(os.path.join(self.directory, 'plugins', 'plugin.nef'), 'wb') as handle:
            handle.write(b'\xef\x33\x0dplugin-nef')
        with open(os.path.join(self.directory, 'plugins', 'plugin.manifest.json'), 'w') as handle:
            json.dump(module_manifest, handle)
        scenario = json.loads(json.dumps(self.scenario))
        scenario['modules'] = [{'name': 'plugin', 'nef': 'plugins/plugin.nef',
                                'manifest': 'plugins/plugin.manifest.json',
                                'signer': OTHER, 'address': '0x' + 'cd' * 20}]
        # `core` is not in the account's manifest at all: a step that lands on the
        # plugin can only be measured against the plugin's own declarations, so a
        # face that read the account's manifest would report it as undeclared.
        scenario['steps'].insert(0, {'id': 'ask-plugin', 'target': 'plugin',
                                     'method': 'core', 'args': [], 'expect': 'HALT',
                                     'readsBack': None})
        scenario['steps'][0].pop('readsBack')
        return scenario

    def _module_dump(self, scenario):
        dump = self._dump(scenario)
        row = next(item for item in dump['steps'] if item['id'] == 'ask-plugin')
        row['resultHex'] = internal('0x' + '11' * 20).hex()
        row['resultType'] = 'ByteString'
        row['resultBytes'] = 20
        row['resultCount'] = 1
        return dump

    def test_a_step_that_lands_on_a_plugin_is_measured_against_it(self):
        scenario = self._with_module()
        receipt = self._receipt(scenario, self._module_dump(scenario))
        self.assertTrue(sc.agrees(receipt), receipt['problems'])
        stats = receipt['stats']
        self.assertEqual(stats['moduleSteps'], 1)
        self.assertEqual(stats['distinctTargets'], 2)
        self.assertEqual(stats['moduleAddressMatched'], 1)
        self.assertEqual(stats['moduleArtifactMatched'], stats['moduleArtifactChecked'])
        self.assertEqual(stats['moduleSignerMatched'], 1)

    def test_a_plugin_deployed_at_another_address_is_a_failure(self):
        scenario = self._with_module()
        dump = self._module_dump(scenario)
        dump['modules'][0]['address'] = '0x' + '99' * 20
        receipt = self._receipt(scenario, dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('module-address', self._problems(receipt))

    def test_a_plugin_deployed_from_other_bytes_is_a_failure(self):
        scenario = self._with_module()
        dump = self._module_dump(scenario)
        dump['modules'][0]['nefSha256'] = 'a' * 64
        receipt = self._receipt(scenario, dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('module-nef-sha256', self._problems(receipt))

    def test_a_plugin_the_scenario_does_not_declare_is_a_failure(self):
        scenario = self._with_module()
        dump = self._module_dump(scenario)
        dump['modules'].append(dict(dump['modules'][0], name='extra'))
        receipt = self._receipt(scenario, dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('module-undeclared', self._problems(receipt))

    def test_a_step_aimed_at_a_plugin_the_scenario_does_not_deploy_is_a_failure(self):
        scenario = self._with_module()
        # The dump is built first: renaming the target afterwards is what a scenario
        # edit after the run looks like, and the face has to refuse it rather than
        # measure the frame against whatever contract it can still find.
        dump = self._module_dump(scenario)
        scenario['steps'][0]['target'] = 'nowhere'
        receipt = self._receipt(scenario, dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('unknown-target', self._problems(receipt))

    def test_a_plugin_path_is_relative_to_the_scenario_file_not_the_package(self):
        # The receipt carries the path the scenario declared, and that path means
        # "relative to the scenario file's own directory". A consumer that resolved
        # it against some other root would look in the wrong place - which is
        # exactly the mistake the first gate-35 attempt made, and the reason this
        # rule is pinned here rather than left to whoever reads the receipt next.
        scenario = self._with_module()
        receipt = self._receipt(scenario, self._module_dump(scenario))
        entry = next(item for item in receipt['modules'] if item['name'] == 'plugin')
        self.assertEqual(entry['nef'], 'plugins/plugin.nef')
        self.assertEqual(entry['manifest'], 'plugins/plugin.manifest.json')
        # And the bytes are the ones that path names, resolved the same way.
        resolved = os.path.join(os.path.dirname(self.scenario_path), entry['nef'])
        with open(resolved, 'rb') as handle:
            self.assertEqual(entry['nefSha256'], hashlib.sha256(handle.read()).hexdigest())

    # -- the face accepts a scenario the engine ran ----------------------

    def test_a_scenario_the_engine_ran_agrees(self):
        receipt = self._receipt()
        self.assertTrue(sc.agrees(receipt), receipt['problems'])
        self.assertEqual(receipt['stats']['scriptBytesMatched'], len(self.scenario['steps']))
        # One block time declared, so nothing in this run is time sensitive.
        self.assertEqual(receipt['stats']['distinctTimestamps'], 1)
        self.assertEqual(receipt['stats']['timeSensitivePairs'], 0)
        self.assertEqual(receipt['stats']['signersMatched'], len(self.scenario['steps']))

    # -- the time each call ran at, and who signed it --------------------

    def test_a_step_that_ran_at_another_time_is_a_failure(self):
        dump = self._dump()
        dump['steps'][0]['timestamp'] = dump['steps'][0]['timestamp'] + 1
        receipt = self._receipt(dump=dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('timestamp', self._problems(receipt))

    def test_a_dump_that_does_not_say_when_a_call_ran_is_a_failure(self):
        dump = self._dump()
        dump['steps'][0].pop('timestamp')
        receipt = self._receipt(dump=dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('no-timestamp', self._problems(receipt))

    def test_a_step_signed_by_another_account_is_a_failure(self):
        dump = self._dump()
        dump['steps'][0]['signer'] = OTHER
        receipt = self._receipt(dump=dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('signer', self._problems(receipt))

    def test_the_same_call_at_two_times_ending_differently_is_counted(self):
        # The pair nothing else in the receipt can produce: identical frame, so
        # identical bytes, and a different ending because the declared time moved.
        scenario = json.loads(json.dumps(self.scenario))
        scenario['steps'].append({'id': 'maybe-later', 'method': 'maybe', 'args': [
            {'type': 'Hash160', 'value': ADDRESS}], 'expect': 'FAULT', 'reason': 'not allowed',
            'timestamp': scenario['blockTimestamp'] + 1})
        receipt = self._receipt(scenario, self._dump(scenario))
        self.assertTrue(sc.agrees(receipt), receipt['problems'])
        self.assertEqual(receipt['stats']['distinctTimestamps'], 2)
        self.assertEqual(receipt['stats']['timeSensitivePairs'], 1)
        self.assertEqual(receipt['stats']['timeSensitiveSteps'], ['maybe', 'maybe-later'])

    def test_the_same_call_at_one_time_is_not_a_time_sensitive_pair(self):
        # The fixture's `probe` is called twice with different arguments, and
        # `deny` faults; neither is evidence that time matters.
        stats = self._receipt()['stats']
        self.assertEqual(stats['timeSensitivePairs'], 0)

    def test_the_face_reports_which_declared_types_it_exercised(self):
        stats = self._receipt()['stats']
        self.assertEqual(stats['declaredTypesExercised'],
                         ['Boolean', 'Hash160', 'Integer', 'Void'])
        # Array was declared by `maybe` and the call answered null: allowed, and
        # not counted as having applied the rule.
        self.assertEqual(stats['declaredReturnNull'], 1)
        self.assertIn('Array', stats['declaredTypesUnexercised'])

    def test_a_null_where_a_value_type_was_declared_is_a_failure(self):
        dump = self._dump()
        row = next(item for item in dump['steps'] if item['id'] == 'count')
        row['resultType'] = 'Any'
        row.pop('resultInteger', None)
        receipt = self._receipt(dump=dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('return-type', self._problems(receipt))

    # -- the dump is refused when it is not the scenario's dump ----------

    def test_a_frame_that_is_not_this_encoder_s_bytes_is_a_failure(self):
        dump = self._dump()
        dump['steps'][0]['scriptHex'] = dump['steps'][0]['scriptHex'] + '00'
        receipt = self._receipt(dump=dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('script-bytes', self._problems(receipt))

    def test_a_step_that_ended_elsewhere_is_a_failure(self):
        dump = self._dump()
        dump['steps'][0]['state'] = 'FAULT'
        dump['steps'][0]['fault'] = 'ABORTMSG is executed. Reason: invented'
        receipt = self._receipt(dump=dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('ending', self._problems(receipt))

    def test_a_fault_with_another_reason_is_a_failure(self):
        dump = self._dump()
        next(item for item in dump['steps'] if item['id'] == 'deny')['fault'] = \
            'ABORTMSG is executed. Reason: something else'
        receipt = self._receipt(dump=dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('fault-reason', self._problems(receipt))

    def test_a_fault_can_be_pinned_to_what_the_host_recorded_underneath_it(self):
        # Two layers, two strings. The script aborted with a generic host message;
        # what actually refused is in the detail, and a scenario that declares only
        # the generic message is not saying which refusal it measured.
        scenario = json.loads(json.dumps(self.scenario))
        for step in scenario['steps']:
            if step['id'] == 'deny':
                step['reason'] = 'Exception has been thrown by the target'
                step['detail'] = 'clearHookDependencies'
        dump = self._dump(scenario)
        row = next(item for item in dump['steps'] if item['id'] == 'deny')
        row['fault'] = 'Exception has been thrown by the target of an invocation.'
        row['faultDetail'] = ("System.InvalidOperationException: Method "
                              '"clearHookDependencies" with 1 parameter(s) doesn\'t exist')
        receipt = self._receipt(scenario, dump)
        self.assertTrue(sc.agrees(receipt), receipt['problems'])
        self.assertEqual(receipt['stats']['faultsAsExpected'], 1)

    def test_a_detail_the_dump_does_not_carry_is_a_failure(self):
        scenario = json.loads(json.dumps(self.scenario))
        for step in scenario['steps']:
            if step['id'] == 'deny':
                step['detail'] = 'clearHookDependencies'
        dump = self._dump(scenario)
        row = next(item for item in dump['steps'] if item['id'] == 'deny')
        row['faultDetail'] = 'System.Exception: something else entirely'
        receipt = self._receipt(scenario, dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('fault-detail', self._problems(receipt))

    def test_a_fault_the_scenario_did_not_predict_is_a_failure(self):
        scenario = json.loads(json.dumps(self.scenario))
        scenario['steps'].append({'id': 'surprise', 'method': 'probe', 'args': [], 'expect': 'HALT'})
        dump = self._dump(scenario)
        dump['steps'][-1]['state'] = 'FAULT'
        dump['steps'][-1]['fault'] = 'ABORTMSG is executed. Reason: unexpected'
        receipt = self._receipt(scenario, dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('ending', self._problems(receipt))

    def test_a_missing_step_is_a_failure(self):
        dump = self._dump()
        dump['steps'].pop()
        receipt = self._receipt(dump=dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('count', self._problems(receipt))

    def test_a_reordered_dump_is_a_failure(self):
        dump = self._dump()
        dump['steps'][0], dump['steps'][1] = dump['steps'][1], dump['steps'][0]
        receipt = self._receipt(dump=dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('order', self._problems(receipt))

    def test_a_deployment_other_than_the_one_the_scenario_names_is_a_failure(self):
        dump = self._dump()
        dump['deployed']['hash'] = '0x' + 'cd' * 20
        receipt = self._receipt(dump=dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('contract', self._problems(receipt))

    def test_a_dump_produced_from_another_scenario_is_a_failure(self):
        dump = self._dump()
        dump['scenario']['sha256'] = '0' * 64
        receipt = self._receipt(dump=dump, seal=False)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('sha256', self._problems(receipt))

    # -- the values the scenario declares --------------------------------

    def test_an_integer_the_scenario_does_not_declare_is_a_failure(self):
        dump = self._dump()
        next(item for item in dump['steps'] if item['id'] == 'count')['resultInteger'] = '8'
        receipt = self._receipt(dump=dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('integer', self._problems(receipt))

    def test_a_boolean_the_scenario_does_not_declare_is_a_failure(self):
        dump = self._dump()
        next(item for item in dump['steps'] if item['id'] == 'flag')['resultHex'] = '00'
        receipt = self._receipt(dump=dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('boolean', self._problems(receipt))

    def test_an_array_length_the_scenario_does_not_declare_is_a_failure(self):
        scenario = json.loads(json.dumps(self.scenario))
        step = next(item for item in scenario['steps'] if item['id'] == 'flag')
        step['items'] = 3
        dump = self._dump(scenario)
        next(item for item in dump['steps'] if item['id'] == 'flag').pop('resultItems', None)
        receipt = self._receipt(scenario, dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('items', self._problems(receipt))

    def test_a_read_that_returns_another_value_is_a_failure(self):
        dump = self._dump()
        next(item for item in dump['steps'] if item['id'] == 'read')['resultHex'] = 'ff' * 20
        receipt = self._receipt(dump=dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('readsBack', self._problems(receipt))

    def test_a_forward_read_that_returns_another_value_is_a_failure(self):
        dump = self._dump()
        next(item for item in dump['steps'] if item['id'] == 'derive')['resultHex'] = 'ff' * 20
        receipt = self._receipt(dump=dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('readsForward', self._problems(receipt))

    def test_a_step_that_builds_on_a_fault_is_a_failure(self):
        scenario = json.loads(json.dumps(self.scenario))
        scenario['steps'].append({'id': 'after', 'method': 'deny', 'args': [],
                                  'expect': 'HALT', 'readsBack': {'step': 'deny', 'arg': 0}})
        dump = self._dump(scenario)
        dump['steps'].append({'id': 'after', 'method': 'deny', 'state': 'HALT',
                              'resultCount': 1, 'resultType': 'Any',
                              'scriptHex': sc.step_script(scenario['steps'][-1], CONTRACT).hex()})
        receipt = self._receipt(scenario, dump)
        self.assertFalse(sc.agrees(receipt))
        self.assertTrue(any('reads a call that faulted' in str(row)
                            for row in receipt['problems']), receipt['problems'])

    def test_the_face_refuses_a_scenario_with_no_steps(self):
        scenario = json.loads(json.dumps(self.scenario))
        scenario['steps'] = []
        receipt = self._receipt(scenario, self._dump(self.scenario))
        self.assertFalse(sc.agrees(receipt))
        self.assertIn('steps', self._problems(receipt))

    # -- the face can tell the difference at all -------------------------

    def test_the_self_test_catches_every_mutation(self):
        receipt = self._receipt()
        self.assertEqual(receipt['selfTest']['failed'], [])
        self.assertEqual(receipt['selfTest']['skipped'], [])
        self.assertGreaterEqual(receipt['selfTest']['checks'], 15)

    def test_a_mutation_that_could_not_be_built_is_a_failure(self):
        # Not an absence: a self test that shrinks to what still fits would
        # certify the input it never examined.
        receipt = self._receipt()
        self.assertTrue(sc.agrees(receipt))
        receipt['selfTest']['skipped'] = ['a mutation this pair could not express']
        self.assertFalse(sc.agrees(receipt))

    def test_the_receipt_never_claims_the_implementation_is_verified(self):
        claims = self._receipt()['claims']
        self.assertFalse(claims['fullImplementationVerified'])
        self.assertFalse(claims['semanticsProven'])
        self.assertTrue(claims['scenarioMeasured'])


if __name__ == '__main__':
    unittest.main()

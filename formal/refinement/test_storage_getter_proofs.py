"""Unit tests for the storage-getter source frontend and binding (no kernel)."""
import copy
import json
import os
from pathlib import Path
import unittest
try:
    from . import storage_getter_source as getter_source, storage_getter_proofs as proofs
except ImportError:
    import storage_getter_source as getter_source, storage_getter_proofs as proofs

ROOT = Path(__file__).resolve().parent
INVENTORY_PATH = os.environ.get('STORAGE_GETTER_INVENTORY')
# A minimal synthetic inventory is used when no real artifact is provided;
# it exercises only the frontend grammar, never kernel or binding status.
SYNTHETIC_PREFIX_FILE = 'contracts/SmartAccount.Internal.cs'


def synthetic_inventory():
    return {
        'inputs': {SYNTHETIC_PREFIX_FILE: '0' * 64},
        'source': {'methods': [], 'types': []},
        'manifest': {'methods': []},
    }


class PrefixResolutionTests(unittest.TestCase):
    def test_prefix_parsed_from_source_bytes(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / SYNTHETIC_PREFIX_FILE
            source.parent.mkdir(parents=True)
            source.write_text('private static readonly byte[] Prefix_MarketEscrowListing '
                              '= new byte[] { 0x07 };\n')
            inventory = {'inputs': {str(source): '0' * 64}}
            self.assertEqual(getter_source.resolve_prefix(inventory,
                'F:SmartAccount.SmartAccount.Prefix_MarketEscrowListing'), [7])

    def test_missing_or_ambiguous_prefix_rejects(self):
        inventory = {'inputs': {}}
        with self.assertRaises(Exception):
            getter_source.resolve_prefix(inventory,
                'F:SmartAccount.SmartAccount.Prefix_MarketEscrowListing')
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'duplicate.cs'
            source.write_text('private static readonly byte[] Prefix_MarketEscrowListing '
                              '= new byte[] { 0x07 };\n'
                              'private static readonly byte[] Prefix_MarketEscrowListing '
                              '= new byte[] { 0x08 };\n')
            with self.assertRaises(Exception):
                getter_source.resolve_prefix({'inputs': {str(source): '0' * 64}},
                    'F:SmartAccount.SmartAccount.Prefix_MarketEscrowListing')

    def test_non_hex_or_multi_byte_literal_rejects(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'bad.cs'
            source.write_text('private static readonly byte[] Prefix_MarketEscrowListing '
                              '= new byte[] { 300 };\n')
            with self.assertRaises(Exception):
                getter_source.resolve_prefix({'inputs': {str(source): '0' * 64}},
                    'F:SmartAccount.SmartAccount.Prefix_MarketEscrowListing')


class GrammarRejectionTests(unittest.TestCase):
    """Feed structurally broken bodies; the frontend must fail closed."""

    @staticmethod
    def method_tree(body_block):
        return {'id': getter_source.TARGETS['getMarketEscrowListingId']['source_id'],
                'origin': 'repository-source', 'parameters': [
                    {'name': 'accountId', 'type': 'x', 'ordinal': 0, 'refKind': 'None'}],
                'operations': [{'children': [body_block]}]}

    def base_block(self):
        # A real-shaped listing body (copied structure, shortened metadata).
        def node(kind, children=None, details=None, constant=None):
            return {'kind': kind, 'children': children or [], 'details': details or {},
                    'constant': constant}
        conversion = lambda child, implicit=True: node('Conversion', [child], {
            'checked': False, 'tryCast': False,
            'conversion': {'Exists': True, 'IsIdentity': implicit, 'IsImplicit': implicit,
                           'IsNullable': False}})
        concat = node('Invocation', [
            node('Argument', [node('FieldReference', [], {'symbol': getter_source.TARGETS[
                'getMarketEscrowListingId']['prefix_symbol']})],
                {'argumentKind': 'Explicit', 'parameter': 'first',
                 'inConversion': {'Exists': True}}),
            node('Argument', [conversion(node('ParameterReference', [], {
                'symbol': 'accountId', 'ordinal': 0}), implicit=False)],
                {'argumentKind': 'Explicit', 'parameter': 'second',
                 'inConversion': {'Exists': True}})],
            {'callee': getter_source.CONCAT_CALLEE, 'virtual': False})
        storage = node('Invocation', [
            node('Argument', [node('PropertyReference', [], {
                'symbol': getter_source.CURRENT_CONTEXT_SYMBOL})],
                {'argumentKind': 'Explicit', 'parameter': 'context',
                 'inConversion': {'Exists': True}}),
            node('Argument', [node('LocalReference', [], {'symbol': 'key'})],
                {'argumentKind': 'Explicit', 'parameter': 'key',
                 'inConversion': {'Exists': True}})],
            {'callee': getter_source.STORAGE_GET_CALLEE, 'virtual': False})
        literal_zero = node('Literal', [], {},
                            {'hasValue': True, 'value': {'runtimeType': 'System.Int32',
                                                         'value': '0'}})
        return node('Block', [
            node('VariableDeclarationGroup', [node('VariableDeclaration', [node(
                'VariableDeclarator', [node('VariableInitializer', [concat])],
                {'symbol': 'key'})])]),
            node('VariableDeclarationGroup', [node('VariableDeclaration', [node(
                'VariableDeclarator', [node('VariableInitializer', [storage])],
                {'symbol': 'listing'})])]),
            node('Return', [node('Conditional', [
                node('Binary', [conversion(node('LocalReference', [], {'symbol': 'listing'}),
                                           implicit=False),
                                conversion(node('Literal', [], {},
                                                {'hasValue': True, 'value': None}),
                                           implicit=False)],
                      {'operator': 'Equals', 'checked': False, 'operatorMethod': None}),
                literal_zero,
                conversion(node('LocalReference', [], {'symbol': 'listing'}), implicit=False)])]),
        ])

    def project_listing(self, block):
        import tempfile
        self._prefix_temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._prefix_temp.cleanup)
        source = Path(self._prefix_temp.name) / 'prefixes.cs'
        source.write_text('private static readonly byte[] Prefix_MarketEscrowListing '
                          '= new byte[] { 0x07 };\n')
        inventory = {'source': {'methods': [self.method_tree(block)]},
                     'inputs': {str(source): '0' * 64}}
        # Only the listing target is resolvable in this synthetic inventory.
        saved = dict(getter_source.TARGETS)
        getter_source.TARGETS = {'getMarketEscrowListingId': saved['getMarketEscrowListingId']}
        try:
            return getter_source.project(inventory)
        finally:
            getter_source.TARGETS = saved

    def test_wellformed_listing_body_projects(self):
        projection = self.project_listing(self.base_block())
        self.assertEqual(projection['getMarketEscrowListingId']['prefixBytes'], [7])
        self.assertEqual(projection['getMarketEscrowListingId']['decode'], 'integer')

    def test_mutations_fail_closed(self):
        base = self.base_block()
        def find_and_replace(block, kind, mutate):
            # Depth-first replacement of the first node of `kind`.
            for index, child in enumerate(block.get('children', [])):
                if child.get('kind') == kind:
                    block['children'][index] = mutate(child)
                    return True
                if find_and_replace(child, kind, mutate):
                    return True
            return False
        mutations = {
            'wrong-prefix-symbol': lambda n: {**n, 'details': {**n['details'],
                'symbol': 'F:SmartAccount.SmartAccount.Prefix_Nonce'}},
            'wrong-concat-callee': lambda n: {**n, 'details': {**n['details'],
                'callee': 'M:System.Array.Empty()'}},
            'missing-null-check': lambda n: {**n, 'details': {**n['details'],
                'operator': 'NotEquals'}},
            'wrong-default': lambda n: {**n, 'constant': {'hasValue': True,
                'value': {'runtimeType': 'System.Int32', 'value': '7'}}},
        }
        for name, mutate in mutations.items():
            kind = {'wrong-prefix-symbol': 'FieldReference',
                    'wrong-concat-callee': 'Invocation',
                    'missing-null-check': 'Binary',
                    'wrong-default': 'Literal'}[name]
            block = self.base_block()
            self.assertTrue(find_and_replace(block, kind, mutate), name)
            with self.subTest(mutation=name), self.assertRaises(Exception):
                self.project_listing(block)

    def test_render_expr_shapes(self):
        from pathlib import Path
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'p.cs'
            source.write_text('private static readonly byte[] Prefix_MarketEscrowListing '
                              '= new byte[] { 0x07 };\n')
            inventory = {'source': {'methods': [self.method_tree(self.base_block())]},
                         'inputs': {str(source): '0' * 64}}
            saved = dict(getter_source.TARGETS)
            getter_source.TARGETS = {'getMarketEscrowListingId': saved['getMarketEscrowListingId']}
            try:
                projection = getter_source.project(inventory)
            finally:
                getter_source.TARGETS = saved
            self.assertIn('GInt 0%Z', getter_source.render_expr(
                projection['getMarketEscrowListingId']))

    @unittest.skipUnless(INVENTORY_PATH, 'Actual artifact binding needs STORAGE_GETTER_INVENTORY')
    def test_actual_binding_regions_end_at_ret(self):
        inventory = json.loads(Path(INVENTORY_PATH).read_text())
        projection = getter_source.project(inventory)
        bound = proofs.bind_entries(inventory, projection,
                                    getter_source.project_callee(inventory))
        # One verified entry per target in the storage-getter lane; the count is
        # asserted against the target table so the two can never drift apart.
        self.assertEqual(len(getter_source.TARGETS), 31)
        self.assertEqual(sorted(bound['methods']), sorted(getter_source.TARGETS))
        # Three shared private callees now back the lane: the debug-only state
        # reader, the pending-module-call record reader, and the
        # legacy-compatibility reader.
        self.assertEqual(sorted(bound['callees']),
                         ['getAccountState', 'getMarketEscrowOwnerCancelInitiated',
                          'getPendingModuleCallRecord'])
        for name, entry in bound['methods'].items():
            self.assertTrue(entry['abi']['safe'], name)
            self.assertGreater(entry['instructionCount'], 0, name)
        for name, callee in bound['callees'].items():
            self.assertGreater(callee['instructionCount'], 0, name)
            self.assertTrue(callee['debugName'].startswith('SmartAccount.SmartAccount,'), name)
        # Kinds map onto exactly the callee each one is proved to call.
        for name, entry in projection.items():
            # The two legacy raw/listing getters carry no explicit kind; the
            # binder treats them as 'direct' and they must not call.
            kind = entry.get('kind', 'direct')
            expected = proofs.CALLEE_KINDS.get(kind)
            self.assertEqual(bound['methods'][name]['kind'], kind, name)
            self.assertEqual(bound['methods'][name]['calleeName'], expected, name)
            self.assertEqual(entry.get('callee'), expected, name)
        # The delegating record projections bind the extracted field ordinal.
        # The Time pair additionally pins the timelock constant, while the Hash
        # pair returns the ByteString field verbatim under no width contract.
        records = {name: entry for name, entry in projection.items()
                   if entry.get('kind') == 'presence-call-item'}
        self.assertEqual(sorted(records), [
            'getPendingHookCallHash', 'getPendingHookCallModule',
            'getPendingHookCallTime', 'getPendingVerifierCallHash',
            'getPendingVerifierCallModule', 'getPendingVerifierCallTime'])
        for name, entry in records.items():
            self.assertEqual(entry['callee'], 'getPendingModuleCallRecord', name)
            self.assertIn('itemIndex', entry, name)
            self.assertIsInstance(entry['itemIndex'], int, name)
            if name.endswith('CallTime'):
                self.assertEqual(entry['offset'], 86400000, name)
                self.assertEqual(entry['decode'], 'integer', name)
            elif name.endswith('CallHash'):
                # The null branch is the compiled `new byte[0]`: a zero-length
                # allocation, not a push literal, and no projection width.
                self.assertNotIn('offset', entry, name)
                self.assertEqual(entry['decode'], 'raw-bytes', name)
                self.assertEqual(entry['default'], {'kind': 'empty-bytes'}, name)
            else:
                self.assertNotIn('offset', entry, name)
                self.assertEqual(entry['decode'], 'hash160', name)
        # The inline epoch getters build their own key and deserialize in place
        # instead of delegating, so they pin the prefix bytes, the
        # PendingConfigUpdate field ordinal and the ConfigUpdateTimelockMs
        # delay while naming no callee at all.
        inline = {name: entry for name, entry in projection.items()
                  if entry.get('kind') == 'inline-record-time'}
        self.assertEqual(sorted(inline), ['getPendingHookUpdateTime',
                                          'getPendingVerifierUpdateTime'])
        for name, entry in inline.items():
            self.assertNotIn('callee', entry, name)
            self.assertNotIn('record_owner', entry, name)
            self.assertEqual(entry['itemIndex'], 3, name)
            self.assertEqual(entry['decode'], 'integer', name)
            self.assertEqual(entry['offset'], 86400000, name)
            self.assertEqual(entry['default'], {'kind': 'integer', 'value': 0}, name)
            self.assertEqual(len(entry['prefixBytes']), 1, name)
            self.assertTrue(entry['itemSymbol'].endswith('PendingConfigUpdate.InitiatedAt'),
                            name)
        # They read distinct prefixes, so neither can stand in for the other.
        self.assertNotEqual(inline['getPendingHookUpdateTime']['prefixBytes'],
                            inline['getPendingVerifierUpdateTime']['prefixBytes'])
        # The legacy-compatibility family pins BOTH keys: the active prefix and
        # the historical one its read falls back to. The inline accessor pins
        # them in its own projection; the two delegating accessors pin neither
        # and read them out of the shared reader they call, so the projection
        # has to be resolved from the callee - while still binding the pair
        # separately for each caller.
        fallback = {name: entry for name, entry in projection.items()
                    if entry.get('kind') in ('inline-fallback',
                                             'fallback-call-presence',
                                             'fallback-call-offset')}
        self.assertEqual(sorted(fallback), [
            'getMarketEscrowOwnerCancelTime', 'getVerifyScopeTarget',
            'hasMarketEscrowOwnerCancel'])
        scope = fallback['getVerifyScopeTarget']
        self.assertEqual(scope['prefixBytes'], [28])
        self.assertEqual(scope['legacyBytes'], [18])
        self.assertEqual(scope['decode'], 'hash160')
        self.assertEqual(scope['default'], {'kind': 'bytes', 'value': [0] * 20})
        self.assertNotIn('offset', scope)
        # The epoch accessor casts the raw payload and adds the pinned timelock;
        # the presence accessor only tests the raw result against null.
        epoch = fallback['getMarketEscrowOwnerCancelTime']
        self.assertEqual(epoch['offset'], 604800000)
        self.assertEqual(epoch['decode'], 'integer')
        self.assertEqual(epoch['default'], {'kind': 'integer', 'value': 0})
        presence = fallback['hasMarketEscrowOwnerCancel']
        self.assertNotIn('offset', presence)
        self.assertNotIn('decode', presence)
        reader = getter_source.project_callee(inventory)
        self.assertEqual(reader['getMarketEscrowOwnerCancelInitiated']['prefixBytes'], [29])
        self.assertEqual(reader['getMarketEscrowOwnerCancelInitiated']['legacyBytes'], [19])
        self.assertTrue(reader['getMarketEscrowOwnerCancelInitiated']['nullOnMissingKey'])
        # A fallback accessor must not read its fallback key from the byte string
        # it prefers: that would make the fallback dead code.
        for name, active, legacy in (('getVerifyScopeTarget', [28], [18]),
                                     ('hasMarketEscrowOwnerCancel', [29], [19]),
                                     ('getMarketEscrowOwnerCancelTime', [29], [19])):
            bound_active, bound_legacy = proofs._fallback_prefixes(bound, name)
            self.assertEqual(bound_active, active, name)
            self.assertEqual(bound_legacy, legacy, name)
            self.assertNotEqual(bound_active, bound_legacy, name)
        # The static table must be rendered in canonical role order, so a
        # program's table depends on which roles it pins rather than on the
        # order its loads appear in: the delegating epoch accessor adds the
        # timelock in its OWN frame, after the shared reader's two prefix loads.
        rows = proofs.nef_decode.decode_script(
            bytes.fromhex(inventory['nef']['scriptHex']),
            len(inventory['nef']['tokens']))
        for name, roles in (('getVerifyScopeTarget', ['prefix', 'legacy']),
                            ('hasMarketEscrowOwnerCancel', ['prefix', 'legacy']),
                            ('getMarketEscrowOwnerCancelTime',
                             ['prefix', 'legacy', 'delay'])):
            parts, _, statics, _ = proofs.build_program(bound, rows, name)
            plan = proofs._static_plan(bound, name, parts)
            self.assertEqual([role for _, role in plan], roles, name)
            self.assertEqual(sorted(slot for slot, _ in plan), sorted(statics), name)

    @unittest.skipUnless(INVENTORY_PATH, 'Actual artifact binding needs STORAGE_GETTER_INVENTORY')
    def test_record_ordinal_is_cross_checked_against_bytecode(self):
        """The rendered PICKITEM index must agree with the extracted ordinal."""
        inventory = json.loads(Path(INVENTORY_PATH).read_text())
        projection = getter_source.project(inventory)
        callee_projection = getter_source.project_callee(inventory)
        rows = proofs.nef_decode.decode_script(
            bytes.fromhex(inventory['nef']['scriptHex']),
            len(inventory['nef']['tokens']))
        bound = proofs.bind_entries(inventory, projection, callee_projection)
        # A record projection whose ordinal drifts from the bytecode index is
        # refused, for the hash160 shape, the delegating offset Time shape and
        # the inline epoch shape alike.
        for name in ('getPendingVerifierCallModule', 'getPendingVerifierCallTime',
                     'getPendingVerifierUpdateTime'):
            drifted = copy.deepcopy(bound)
            drifted['methods'][name]['projection']['itemIndex'] += 1
            with self.assertRaises(Exception):
                proofs.build_program(drifted, rows, name)
        # A record projection whose default disagrees with the branch literal
        # is refused as well.
        drifted = copy.deepcopy(bound)
        drifted['methods']['getPendingVerifierCallTime']['projection']['default'] = {
            'kind': 'integer', 'value': 1}
        with self.assertRaises(Exception):
            proofs.build_program(drifted, rows, 'getPendingVerifierCallTime')


    @unittest.skipUnless(INVENTORY_PATH, 'Actual artifact binding needs STORAGE_GETTER_INVENTORY')
    def test_legacy_compatibility_drift_is_refused(self):
        """A fallback projection that drifts from its bytecode fails closed."""
        inventory = json.loads(Path(INVENTORY_PATH).read_text())
        projection = getter_source.project(inventory)
        callee_projection = getter_source.project_callee(inventory)
        rows = proofs.nef_decode.decode_script(
            bytes.fromhex(inventory['nef']['scriptHex']),
            len(inventory['nef']['tokens']))
        bound = proofs.bind_entries(inventory, projection, callee_projection)
        build = lambda state, name: proofs.build_program(state, rows, name)

        # The inline reader performs TWO reads, so a projection that forgets the
        # historical key describes a program with one static load.
        drifted = copy.deepcopy(bound)
        drifted['methods']['getVerifyScopeTarget']['projection'].pop('legacyBytes')
        with self.assertRaises(Exception):
            build(drifted, 'getVerifyScopeTarget')
        # ... and one that adds an offset it does not encode.
        drifted = copy.deepcopy(bound)
        drifted['methods']['getVerifyScopeTarget']['projection']['offset'] = 1
        with self.assertRaises(Exception):
            build(drifted, 'getVerifyScopeTarget')
        # A shared reader that forgets its historical prefix describes three
        # loads for a program that makes three (the caller's delay included).
        drifted = copy.deepcopy(bound)
        drifted['callees']['getMarketEscrowOwnerCancelInitiated'][
            'projection'].pop('legacyBytes')
        with self.assertRaises(Exception):
            build(drifted, 'getMarketEscrowOwnerCancelTime')
        # The delegating epoch accessor casts the payload and adds a delay: a
        # decode contract that disagrees with the rendered CONVERT is refused.
        drifted = copy.deepcopy(bound)
        drifted['methods']['getMarketEscrowOwnerCancelTime'][
            'projection']['decode'] = 'hash160'
        with self.assertRaises(Exception):
            build(drifted, 'getMarketEscrowOwnerCancelTime')
        # The delegating presence accessor pins no prefix of its own; claiming
        # one makes the expected static inventory disagree with the region.
        drifted = copy.deepcopy(bound)
        drifted['methods']['hasMarketEscrowOwnerCancel'][
            'projection']['prefixBytes'] = [29]
        with self.assertRaises(Exception):
            build(drifted, 'hasMarketEscrowOwnerCancel')
        # The two delegating accessors must call the reader their kind binds:
        # naming a bound-but-wrong shared callee is refused at bind time,
        # because the region's certified CALL edge does not target it.
        drifted = copy.deepcopy(projection)
        drifted['hasMarketEscrowOwnerCancel']['callee'] = 'getAccountState'
        with self.assertRaises(Exception):
            proofs.bind_entries(inventory, drifted, callee_projection)
        # ... and re-labelling it as the pending-module-call presence kind is
        # refused when the program is rendered, because that callee pins no
        # prefix of its own and expects a two-operand call the region is not.
        drifted = copy.deepcopy(bound)
        row = drifted['methods']['hasMarketEscrowOwnerCancel']['projection']
        row['kind'] = 'presence-call'
        row.pop('callee', None)
        drifted['methods']['hasMarketEscrowOwnerCancel']['calleeName'] = \
            'getPendingModuleCallRecord'
        with self.assertRaises(Exception):
            build(drifted, 'hasMarketEscrowOwnerCancel')


class StateFieldIndexTests(unittest.TestCase):
    def test_declaration_order_derives_indices(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'models.cs'
            source.write_text(
                'public class AccountState\n'
                '{\n'
                '    public UInt160 Verifier = UInt160.Zero;\n'
                '    public UInt160 HookId = UInt160.Zero;\n'
                '    public UInt160 BackupOwner = UInt160.Zero;\n'
                '    public uint EscapeTimelock;\n'
                '    public BigInteger EscapeTriggeredAt;\n'
                '}\n')
            inventory = {'inputs': {str(source): '0' * 64}}
            self.assertEqual(getter_source.resolve_state_field_index(
                inventory, 'F:SmartAccount.SmartAccount.AccountState.Verifier'), 0)
            self.assertEqual(getter_source.resolve_state_field_index(
                inventory, 'F:SmartAccount.SmartAccount.AccountState.EscapeTriggeredAt'), 4)

    def test_unknown_field_rejects(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'models.cs'
            source.write_text('public class AccountState\n{\n    public UInt160 Verifier;\n}\n')
            inventory = {'inputs': {str(source): '0' * 64}}
            with self.assertRaises(Exception):
                getter_source.resolve_state_field_index(
                    inventory, 'F:SmartAccount.SmartAccount.AccountState.HookId')


class RecordFieldIndexTests(unittest.TestCase):
    """PendingModuleCall ordinals come from the declaration order only."""

    RECORD = ('public class PendingModuleCall\n'
              '{\n'
              '    public UInt160 ModuleHash = UInt160.Zero;\n'
              '    public ByteString CallHash = (ByteString)new byte[0];\n'
              '    public BigInteger InitiatedAt;\n'
              '}\n')

    def test_declaration_order_derives_indices(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'models.cs'
            source.write_text(self.RECORD)
            inventory = {'inputs': {str(source): '0' * 64}}
            self.assertEqual(getter_source.resolve_record_field_index(
                inventory, 'PendingModuleCall',
                'F:SmartAccount.SmartAccount.PendingModuleCall.ModuleHash'), 0)
            self.assertEqual(getter_source.resolve_record_field_index(
                inventory, 'PendingModuleCall',
                'F:SmartAccount.SmartAccount.PendingModuleCall.InitiatedAt'), 2)

    def test_foreign_owner_or_field_rejects(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'models.cs'
            source.write_text(self.RECORD)
            inventory = {'inputs': {str(source): '0' * 64}}
            # A field of another owner must not be resolved through this class.
            with self.assertRaises(Exception):
                getter_source.resolve_record_field_index(
                    inventory, 'PendingModuleCall',
                    'F:SmartAccount.SmartAccount.AccountState.Verifier')
            # An unknown field of the right owner must reject as well.
            with self.assertRaises(Exception):
                getter_source.resolve_record_field_index(
                    inventory, 'PendingModuleCall',
                    'F:SmartAccount.SmartAccount.PendingModuleCall.NotAField')
            # A missing declaration must not silently resolve to anything.
            with self.assertRaises(Exception):
                getter_source.resolve_record_field_index(
                    {'inputs': {}}, 'PendingModuleCall',
                    'F:SmartAccount.SmartAccount.PendingModuleCall.ModuleHash')


class VmProgramRendererTests(unittest.TestCase):
    """Slot-model rendering of decoded region rows, fail-closed checks."""

    @staticmethod
    def row(offset, name, operand_hex='', size=None):
        if size is None:
            size = 1 + len(bytes.fromhex(operand_hex)) if operand_hex else 1
        return {'offset': offset, 'opcode': 0, 'name': name, 'operandHex': operand_hex,
                'size': size, 'instructionHex': '', 'edges': []}

    def real_contract_rows(self):
        # The pinned getMarketEscrowContract region, transcribed from the
        # decoded inventory bytes (offsets 3226..3290).
        return [
            self.row(3226, 'INITSLOT', '0201', 3),
            self.row(3229, 'LDSFLD4'),
            self.row(3230, 'LDARG0'),
            self.row(3231, 'CONVERT', '30', 2),
            self.row(3233, 'CAT'),
            self.row(3234, 'STLOC0'),
            self.row(3235, 'LDLOC0'),
            self.row(3236, 'SYSCALL', '9bf667ce', 5),
            self.row(3241, 'SYSCALL', '925de831', 5),
            self.row(3246, 'STLOC1'),
            self.row(3247, 'LDLOC1'),
            self.row(3248, 'PUSHNULL'),
            self.row(3249, 'EQUAL'),
            self.row(3250, 'JMPIFNOT', '1a', 2),
            self.row(3252, 'PUSHDATA1', '14' + '00' * 20, 22),
            self.row(3274, 'JMP', '0e', 2),
            self.row(3276, 'LDLOC1'),
            self.row(3277, 'DUP'),
            self.row(3278, 'ISNULL'),
            self.row(3279, 'JMPIF', '09', 2),
            self.row(3281, 'DUP'),
            self.row(3282, 'SIZE'),
            self.row(3283, 'PUSHINT8', '14', 2),
            self.row(3285, 'JMPEQ', '03', 2),
            self.row(3287, 'THROW'),
            self.row(3288, 'JMP', '02', 2),
            self.row(3290, 'RET'),
        ]

    def test_contract_region_maps_to_slots(self):
        parts, meta = proofs.render_vm_program(self.real_contract_rows())
        self.assertEqual(parts[0], 'InitSlot 2 1')
        self.assertEqual(parts[1], 'LdStatic 4')
        self.assertIn('Convert 48', parts)
        self.assertIn('GetContext', parts)
        self.assertIn('StorageGet', parts)
        # Branch operands are rewritten to slot indices.
        self.assertEqual(parts[13], 'JumpIfNot 16')
        self.assertEqual(parts[15], 'Jump 25')
        self.assertEqual(parts[19], 'JumpIf 25')
        self.assertEqual(parts[23], 'JumpEq 25')
        self.assertEqual(parts[25], 'Jump 26')
        self.assertEqual(parts[-1], 'Ret')
        self.assertEqual(meta['nlocals'], 2)
        self.assertEqual(meta['static_slots'], {4})
        self.assertEqual(meta['cast_width'], 20)

    def test_branch_target_outside_region_rejects(self):
        rows = self.real_contract_rows()
        rows[13] = self.row(3250, 'JMPIFNOT', '7f', 2)  # target 3250+127
        with self.assertRaises(Exception):
            proofs.render_vm_program(rows)

    def test_unexpected_syscall_rejects(self):
        rows = self.real_contract_rows()
        rows[8] = self.row(3241, 'SYSCALL', 'e63f1884', 5)  # System.Storage.Put
        with self.assertRaises(Exception):
            proofs.render_vm_program(rows)

    def test_unexpected_opcode_rejects(self):
        rows = self.real_contract_rows()
        rows[5] = self.row(3234, 'NOP')
        with self.assertRaises(Exception):
            proofs.render_vm_program(rows)

    def test_missing_ret_rejects(self):
        rows = self.real_contract_rows()[:-1]
        with self.assertRaises(Exception):
            proofs.render_vm_program(rows)

    def test_integer_convert_maps_to_33(self):
        rows = self.real_contract_rows()
        rows[3] = self.row(3231, 'CONVERT', '21', 2)
        parts, _ = proofs.render_vm_program(rows)
        self.assertIn('Convert 33', parts)

    def test_listing_region_shape(self):
        rows = [
            self.row(3291, 'INITSLOT', '0201', 3),
            self.row(3294, 'LDSFLD5'),
            self.row(3295, 'LDARG0'),
            self.row(3296, 'CONVERT', '30', 2),
            self.row(3298, 'CAT'),
            self.row(3299, 'STLOC0'),
            self.row(3300, 'LDLOC0'),
            self.row(3301, 'SYSCALL', '9bf667ce', 5),
            self.row(3306, 'SYSCALL', '925de831', 5),
            self.row(3311, 'STLOC1'),
            self.row(3312, 'LDLOC1'),
            self.row(3313, 'PUSHNULL'),
            self.row(3314, 'EQUAL'),
            self.row(3315, 'JMPIFNOT', '05', 2),
            self.row(3317, 'PUSH0'),
            self.row(3318, 'JMP', '0d', 2),
            self.row(3320, 'LDLOC1'),
            self.row(3321, 'DUP'),
            self.row(3322, 'ISNULL'),
            self.row(3323, 'JMPIFNOT', '06', 2),
            self.row(3325, 'DROP'),
            self.row(3326, 'PUSH0'),
            self.row(3327, 'JMP', '04', 2),
            self.row(3329, 'CONVERT', '21', 2),
            self.row(3331, 'JMP', '02', 2),
            self.row(3333, 'RET'),
        ]
        parts, meta = proofs.render_vm_program(rows)
        self.assertEqual(parts[1], 'LdStatic 5')
        self.assertEqual(parts[13], 'JumpIfNot 16')
        self.assertEqual(parts[19], 'JumpIfNot 23')
        self.assertEqual(parts[23], 'Convert 33')
        self.assertEqual(parts[24], 'Jump 25')
        self.assertEqual(meta['static_slots'], {5})
        self.assertIsNone(meta['cast_width'])

    def callee_region_rows(self):
        # The pinned shared GetAccountState region, transcribed from the
        # decoded inventory bytes (offsets 2986..3039).
        return [
            self.row(2986, 'INITSLOT', '0201', 3),
            self.row(2989, 'LDSFLD1'),
            self.row(2990, 'LDARG0'),
            self.row(2991, 'CONVERT', '30', 2),
            self.row(2993, 'CAT'),
            self.row(2994, 'STLOC0'),
            self.row(2995, 'LDLOC0'),
            self.row(2996, 'SYSCALL', '9bf667ce', 5),
            self.row(3001, 'SYSCALL', '925de831', 5),
            self.row(3006, 'STLOC1'),
            self.row(3007, 'LDLOC1'),
            self.row(3008, 'PUSHNULL'),
            self.row(3009, 'NOTEQUAL'),
            self.row(3010, 'JMPIF', '16', 2),
            self.row(3012, 'PUSHDATA1', '41' + '6162', 20),
            self.row(3031, 'ABORTMSG'),
            self.row(3032, 'LDLOC1'),
            self.row(3033, 'CALLT', '0400', 3),
            self.row(3036, 'JMP', '02', 2),
            self.row(3038, 'RET'),
        ]

    def test_callee_region_renders_frames(self):
        parts, meta = proofs.render_vm_program(
            self.callee_region_rows(), token_index=proofs.DESERIALIZE_TOKEN_INDEX)
        self.assertEqual(parts[0], 'InitSlot 2 1')
        self.assertEqual(parts[1], 'LdStatic 1')
        self.assertEqual(parts[12], 'NotEqualIns')
        self.assertEqual(parts[13], 'JumpIf 16')
        self.assertEqual(parts[15], 'AbortMsg')
        self.assertEqual(parts[17], 'CallToken 4')
        self.assertEqual(parts[18], 'Jump 19')
        self.assertEqual(parts[-1], 'Ret')
        self.assertEqual(meta['static_slots'], {1})
        self.assertEqual(meta['token_calls'], [4])
        self.assertEqual(meta['calls'], [])

    def test_call_l_binds_only_to_pinned_callee(self):
        rows = [
            self.row(18389, 'INITSLOT', '0001', 3),
            self.row(18392, 'LDARG0'),
            self.row(18393, 'CALL_L', 'd1c3ffff', 5),
            self.row(18398, 'PUSH0'),
            self.row(18399, 'PICKITEM'),
            self.row(18400, 'JMP', '02', 2),
            self.row(18402, 'RET'),
        ]
        with self.assertRaises(Exception):
            proofs.render_vm_program(rows)
        parts, meta = proofs.render_vm_program(rows, callee_start=2986)
        self.assertEqual(parts[2], 'Call CALLEE')
        self.assertEqual(meta['calls'], [18393])

    def test_callt_token_identity_enforced(self):
        rows = self.callee_region_rows()
        rows[17] = self.row(3033, 'CALLT', '0500', 3)
        with self.assertRaises(Exception):
            proofs.render_vm_program(rows, token_index=proofs.DESERIALIZE_TOKEN_INDEX)

    def test_combine_program_patches_frames(self):
        caller_parts = ['InitSlot 0 1', 'LdArg', 'Call CALLEE',
                        'Push (GInt 0)', 'PickItem', 'Jump 6', 'Ret']
        caller_meta = {'nlocals': 0, 'nparams': 1, 'static_slots': set(),
                       'branch_slots': {}, 'cast_width': None, 'calls': [0],
                       'token_calls': []}
        callee_parts, callee_meta = proofs.render_vm_program(
            self.callee_region_rows(), token_index=proofs.DESERIALIZE_TOKEN_INDEX)
        parts, nlocals, statics = proofs.combine_program(
            caller_parts, caller_meta, callee_parts, callee_meta)
        self.assertEqual(parts[2], 'Call 7')
        self.assertEqual(parts[20], 'JumpIf 23')  # 16 + 7
        self.assertEqual(parts[25], 'Jump 26')    # 19 + 7
        self.assertEqual(parts[-1], 'Ret')
        self.assertEqual(nlocals, 2)
        self.assertEqual(statics, {1})

    def test_combine_program_refuses_shared_static_slot(self):
        """A slot number used by both frames would alias two constants."""
        caller_parts = ['InitSlot 0 1', 'LdStatic 3', 'Call CALLEE', 'Ret']
        caller_meta = {'nlocals': 0, 'nparams': 1, 'static_slots': {3},
                       'branch_slots': {}, 'cast_width': None, 'calls': [0],
                       'token_calls': []}
        callee_parts = ['InitSlot 0 2', 'LdStatic 3', 'Ret']
        callee_meta = {'nlocals': 0, 'nparams': 2, 'static_slots': {3},
                       'branch_slots': {}, 'cast_width': None, 'calls': [],
                       'token_calls': []}
        with self.assertRaises(Exception):
            proofs.combine_program(caller_parts, caller_meta,
                                   callee_parts, callee_meta)

    def test_combine_program_static_limit_is_checked(self):
        """The two-slot callers must opt in; anything wider still fails."""
        caller_parts = ['InitSlot 0 1', 'LdStatic 3', 'LdStatic 7',
                        'Call CALLEE', 'Ret']
        caller_meta = {'nlocals': 0, 'nparams': 1, 'static_slots': {3, 7},
                       'branch_slots': {}, 'cast_width': None, 'calls': [0],
                       'token_calls': []}
        callee_parts = ['InitSlot 0 2', 'Ret']
        callee_meta = {'nlocals': 0, 'nparams': 2, 'static_slots': set(),
                       'branch_slots': {}, 'cast_width': None, 'calls': [],
                       'token_calls': []}
        with self.assertRaises(Exception):
            proofs.combine_program(caller_parts, caller_meta,
                                   callee_parts, callee_meta)
        _, _, statics = proofs.combine_program(
            caller_parts, caller_meta, callee_parts, callee_meta, static_limit=2)
        self.assertEqual(statics, {3, 7})

    def test_arithmetic_and_push_opcodes_render(self):
        rows = [
            self.row(0, 'INITSLOT', '0101', 3),
            self.row(3, 'PUSH1'),
            self.row(4, 'PUSH4'),
            self.row(5, 'GT'),
            self.row(6, 'ADD'),
            self.row(7, 'PUSH16'),
            self.row(8, 'JMP', '02', 2),
            self.row(10, 'RET'),
        ]
        parts, _ = proofs.render_vm_program(rows)
        self.assertEqual(parts[1], 'Push (GInt 1)')
        self.assertEqual(parts[2], 'Push (GInt 4)')
        self.assertEqual(parts[3], 'Greater')
        self.assertEqual(parts[4], 'AddIns')
        self.assertEqual(parts[5], 'Push (GInt 16)')


if __name__ == '__main__':
    unittest.main()

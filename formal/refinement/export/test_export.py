"""Actual artifact inventory and fail-closed controls; no semantic proof claims."""
import hashlib
import json
from pathlib import Path
import subprocess
import shutil
import tempfile
import time
import uuid
import unittest

ROOT = Path(__file__).resolve().parents[3]
PROJECT = Path(__file__).with_name('RefinementExport.csproj')
COMPILER = Path.home() / '.dotnet/tools/.store/neo.compiler.csharp/3.9.1/neo.compiler.csharp/3.9.1/tools/net10.0/any'
NEF = ROOT / 'contracts/bin/v3/SmartAccountV3.nef'
MANIFEST = NEF.with_suffix('.manifest.json')


def walk_operation(node):
    yield node
    for child in node['children']:
        yield from walk_operation(child)


class ExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        build = subprocess.run(['dotnet', 'build', str(PROJECT), '--nologo',
                                '-p:CompilerToolDirectory=' + str(COMPILER)],
                               capture_output=True, text=True, timeout=90)
        if build.returncode:
            raise AssertionError(build.stdout + build.stderr)
        cls.command = ['dotnet', str(PROJECT.parent / 'bin/Debug/net10.0/RefinementExport.dll'),
                       '--compiler-tool-dir', str(COMPILER),
                       '--source-root', str(ROOT), '--project',
                       str(ROOT / 'contracts/custom/SmartAccount.csproj'),
                       '--nef', str(NEF), '--manifest', str(MANIFEST)]

    def actual_inventory(self):
        if not hasattr(type(self), '_inventory'):
            result = subprocess.run(self.command, capture_output=True, text=True, timeout=240)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout[-2000:])
            type(self)._inventory = json.loads(result.stdout)
        return type(self)._inventory

    def test_actual_candidate_complete_inventory(self):
        report = self.actual_inventory()
        self.assertEqual(report['schema'], 'neoos-sa-refinement-inventory/v1')
        self.assertEqual(report['status'], 'INVENTORY_ONLY')
        self.assertEqual(report['nef']['sha256'], hashlib.sha256(NEF.read_bytes()).hexdigest())
        self.assertEqual(report['manifest']['methods'], json.loads(MANIFEST.read_text())['abi']['methods'])
        instructions = report['nef']['instructions']
        self.assertEqual(sum(i['size'] for i in instructions), len(bytes.fromhex(report['nef']['scriptHex'])))
        self.assertEqual(sum(report['nef']['opcodeCounts'].values()), len(instructions))
        self.assertTrue(report['sourceMap']['exactByteMatch'])
        self.assertTrue(report['sourceMap']['exactManifestMatch'])
        for document in report['sourceMap']['documentInputs']:
            self.assertEqual(document['sha256'], hashlib.sha256(Path(document['path']).read_bytes()).hexdigest())
        methods = report['source']['methods']
        self.assertTrue(any('CapReimbursementToActualCost' in m['displayName'] for m in methods))
        self.assertTrue(any('CapReimbursementToActualCost' in m['id'] for m in report['sourceMap']['focusedMethods']))
        self.assertTrue(report['source']['unsupportedOperations'])
        self.assertTrue(report['proofObligations'])

    def test_static_field_initializers_bind_exact_symbols_types_and_source_order(self):
        source = self.actual_inventory()['source']
        fields = {field['id']: field for type_ in source['types'] for field in type_['fields']}
        bound = []
        by_file = {}
        for initializer in source['initializers']:
            for root in initializer['operations']:
                if root['kind'] != 'FieldInitializer':
                    continue
                collection = root['semanticCollections']['IFieldInitializerOperation.InitializedFields']
                self.assertEqual(collection['kind'], 'symbols')
                self.assertIs(collection['complete'], True)
                self.assertTrue(collection['items'])
                for item in collection['items']:
                    declared = fields[item['id']]
                    self.assertEqual(item['kind'], 'Field')
                    for name in ['name', 'type', 'isStatic', 'isReadOnly']:
                        self.assertEqual(item[name], declared[name], (item['id'], name))
                    bound.append((item, root))
                location = root['location']
                by_file.setdefault(location['path'], []).append(location['start'])
        prefix = [(item, root) for item, root in bound
                  if item['id'] == 'F:SmartAccount.SmartAccount.Prefix_TransactionReimbursement']
        self.assertEqual(len(prefix), 1)
        item, root = prefix[0]
        self.assertEqual(item['type'], 'byte[]')
        self.assertTrue(item['isStatic'] and item['isReadOnly'])
        self.assertEqual(root['children'][0]['kind'], 'ArrayCreation')
        literals = [node['constant']['value']['value'] for node in walk_operation(root)
                    if node['kind'] == 'Literal' and node.get('constant')]
        self.assertIn('33', literals, 'Prefix_TransactionReimbursement initializer must retain 0x21')
        for path, starts in by_file.items():
            self.assertEqual(starts, sorted(starts), path)
        synthesized = [member for type_ in source['types'] for member in type_['synthesizedMembers']
                       if member['id'].endswith('.#cctor')]
        self.assertTrue(synthesized)
        self.assertTrue(all('no separately exported source body' in member['issue'] for member in synthesized))

    def test_known_operation_collections_reference_direct_children_in_order(self):
        source = self.actual_inventory()['source']
        expected = {
            'IBlockOperation.Operations': ('Block', lambda children: list(range(len(children)))),
            'IVariableDeclarationGroupOperation.Declarations': ('VariableDeclarationGroup', lambda children: list(range(len(children)))),
            'IVariableDeclarationOperation.Declarators': ('VariableDeclaration', lambda children: [i for i, child in enumerate(children) if child['kind'] == 'VariableDeclarator']),
            'IInvocationOperation.Arguments': ('Invocation', lambda children: [i for i, child in enumerate(children) if child['kind'] == 'Argument']),
            'IPropertyReferenceOperation.Arguments': ('PropertyReference', lambda children: [i for i, child in enumerate(children) if child['kind'] == 'Argument']),
            'IObjectCreationOperation.Arguments': ('ObjectCreation', lambda children: [i for i, child in enumerate(children) if child['kind'] == 'Argument']),
            'IArrayCreationOperation.DimensionSizes': ('ArrayCreation', lambda children: [i for i, child in enumerate(children) if child['kind'] != 'ArrayInitializer']),
            'IArrayInitializerOperation.ElementValues': ('ArrayInitializer', lambda children: list(range(len(children)))),
        }
        seen = set()
        for record in source['methods'] + source['initializers']:
            for root in record['operations']:
                for node in walk_operation(root):
                    collections = node['semanticCollections']
                    for name, (kind, indices) in expected.items():
                        if node['kind'] != kind:
                            continue
                        collection = collections[name]
                        self.assertEqual(collection, {'kind': 'operations', 'childIndices': indices(node['children']), 'complete': True}, name)
                        seen.add(name)
                    if node['kind'] == 'VariableDeclaration':
                        self.assertEqual(collections['IVariableDeclarationOperation.IgnoredDimensions']['childIndices'], [])
                    if node['kind'] == 'VariableDeclarator':
                        self.assertEqual(collections['IVariableDeclaratorOperation.IgnoredArguments']['childIndices'], [])
                    for name, collection in collections.items():
                        self.assertFalse(any(value.startswith(name + ':') for value in node['unexportedMetadata']), name)
                        self.assertIs(collection['complete'], True)
                        if collection['kind'] == 'operations':
                            self.assertEqual(len(collection['childIndices']), len(set(collection['childIndices'])))
                            self.assertTrue(all(0 <= i < len(node['children']) for i in collection['childIndices']))
                        else:
                            for item in collection['items']:
                                self.assertTrue(item['id'] and item['type'])
        self.assertEqual(seen, set(expected))

    def test_local_symbol_collections_and_unknown_metadata_obligations_remain_explicit(self):
        source = self.actual_inventory()['source']
        populated_locals = 0
        unknown_indices = []
        for record in source['methods'] + source['initializers']:
            for root in record['operations']:
                for node in walk_operation(root):
                    for name in ['IBlockOperation.Locals', 'ISymbolInitializerOperation.Locals']:
                        collection = node['semanticCollections'].get(name)
                        if collection is not None:
                            self.assertEqual(collection['kind'], 'symbols')
                            for item in collection['items']:
                                self.assertEqual(item['kind'], 'Local')
                                self.assertTrue(item['id'] and item['type'])
                                populated_locals += 1
                    unknown_indices.extend(value for value in node['unexportedMetadata']
                                           if value.startswith('IArrayElementReferenceOperation.Indices:'))
        self.assertGreater(populated_locals, 0)
        self.assertTrue(unknown_indices, 'unrecognized enumerable metadata must stay as an explicit obligation')

    def test_storage_prefix_array_dimensions_and_elements_bind_exact_child_identity(self):
        source = self.actual_inventory()['source']
        roots = [root for initializer in source['initializers'] for root in initializer['operations']
                 if root['kind'] == 'FieldInitializer'
                 and any(item['id'] == 'F:SmartAccount.SmartAccount.Prefix_TransactionReimbursement'
                         for item in root['semanticCollections']['IFieldInitializerOperation.InitializedFields']['items'])]
        self.assertEqual(len(roots), 1)
        array = roots[0]['children'][0]
        dimensions = array['semanticCollections']['IArrayCreationOperation.DimensionSizes']['childIndices']
        self.assertEqual(dimensions, [0])
        self.assertEqual(array['children'][dimensions[0]]['constant']['value']['value'], '1')
        initializer = array['children'][1]
        elements = initializer['semanticCollections']['IArrayInitializerOperation.ElementValues']['childIndices']
        self.assertEqual(elements, [0])
        literal = next(node for node in walk_operation(initializer['children'][elements[0]])
                       if node['kind'] == 'Literal')
        self.assertEqual(literal['constant']['value']['value'], '33')

    def test_collection_resolution_rejects_missing_ambiguous_and_duplicate_children(self):
        # Invoke the exporter on real Roslyn argument objects with adversarial
        # child lists. This checks fail-closed identity binding, not a second
        # hand-written implementation of collection-to-child projection.
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            project = directory / 'CollectionControls.csproj'
            references = ''.join(
                f'<Reference Include="{name}"><HintPath>{COMPILER / (name + ".dll")}</HintPath></Reference>'
                for name in ['Microsoft.CodeAnalysis', 'Microsoft.CodeAnalysis.CSharp'])
            project.write_text('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>'
                               '<OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework>'
                               '<ImplicitUsings>enable</ImplicitUsings></PropertyGroup>'
                               '<ItemGroup>' + references + '</ItemGroup></Project>')
            (directory / 'Program.cs').write_text(r'''
using System.Reflection;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
var tree = CSharpSyntaxTree.ParseText("class C { static int Sum(int x, int y) => x+y; static int F() => Sum(2,1); }");
var compilation = CSharpCompilation.Create("Controls", new[] { tree },
    new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) });
var invocation = (IInvocationOperation)compilation.GetSemanticModel(tree).GetOperation(
    tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>().Single());
var method = Assembly.LoadFrom(args[0]).GetType("Program").GetMethod(
    "TryExportSemanticCollection", BindingFlags.NonPublic | BindingFlags.Static);
var children = invocation.ChildOperations.ToArray();
object[] Valid(object value, IOperation[] ordered) => new object[] { "IInvocationOperation.Arguments", value, ordered, null };
var valid = Valid(invocation.Arguments, children);
if (!(bool)method.Invoke(null, valid)) throw new Exception("Known arguments were omitted");
var collection = JsonDocument.Parse(JsonSerializer.Serialize(valid[3])).RootElement;
if (collection.GetProperty("kind").GetString() != "operations" || !collection.GetProperty("complete").GetBoolean()
    || !collection.GetProperty("childIndices").EnumerateArray().Select(x => x.GetInt32()).SequenceEqual(new[] { 0, 1 }))
    throw new Exception("Argument identity or order changed");
void Reject(object[] values, string expected) {
    try { method.Invoke(null, values); }
    catch (TargetInvocationException error) when (error.InnerException is InvalidDataException
        && error.InnerException.Message.Contains(expected)) { return; }
    throw new Exception("Invalid collection was not rejected: " + expected);
}
Reject(Valid(invocation.Arguments, Array.Empty<IOperation>()), "Missing");
Reject(Valid(invocation.Arguments, new[] { children[0], children[0], children[1] }), "Ambiguous");
Reject(Valid(new[] { children[0], children[0] }, children), "duplicate");
Reject(Valid(new object[] { "not-an-operation" }, children), "Non-operation");
var unknown = new object[] { "IUnknownOperation.Values", invocation.Arguments, children, null };
if ((bool)method.Invoke(null, unknown) || unknown[3] != null) throw new Exception("Unknown collection claimed exported");
Console.WriteLine("COLLECTION_IDENTITY_CONTROLS_PASS");
''')
            build = subprocess.run(['dotnet', 'build', str(project), '--nologo'],
                                   capture_output=True, text=True, timeout=90)
            self.assertEqual(build.returncode, 0, build.stdout + build.stderr)
            result = subprocess.run(['dotnet', str(directory / 'bin/Debug/net10.0/CollectionControls.dll'),
                                     str(PROJECT.parent / 'bin/Debug/net10.0/RefinementExport.dll')],
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('COLLECTION_IDENTITY_CONTROLS_PASS', result.stdout)

    def test_bad_checksum_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            bad = Path(temp) / 'bad.nef'
            data = bytearray(NEF.read_bytes()); data[-1] ^= 1; bad.write_bytes(data)
            command = list(self.command); command[command.index('--nef') + 1] = str(bad)
            result = subprocess.run(command, capture_output=True, text=True, timeout=60)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('checksum', result.stderr.lower())

    def test_bad_abi_offset_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            bad = Path(temp) / 'bad.manifest.json'
            data = json.loads(MANIFEST.read_text()); data['abi']['methods'][0]['offset'] = 999999
            bad.write_text(json.dumps(data))
            command = list(self.command); command[command.index('--manifest') + 1] = str(bad)
            result = subprocess.run(command, capture_output=True, text=True, timeout=60)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('abi', result.stderr.lower())

    def test_legal_changed_manifest_is_not_bound_to_source(self):
        with tempfile.TemporaryDirectory() as temp:
            bad = Path(temp) / 'different.manifest.json'
            data = json.loads(MANIFEST.read_text())
            data['abi']['methods'][0]['safe'] = not data['abi']['methods'][0]['safe']
            bad.write_text(json.dumps(data))
            command = list(self.command); command[command.index('--manifest') + 1] = str(bad)
            result = subprocess.run(command, capture_output=True, text=True, timeout=120)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('source/manifest pair mismatch', result.stderr.lower())

    def test_legal_changed_source_is_not_bound_to_candidate(self):
        with tempfile.TemporaryDirectory() as temp:
            mirror = Path(temp)
            shutil.copytree(ROOT / 'contracts', mirror / 'contracts',
                            ignore=shutil.ignore_patterns('bin', 'obj', 'build'))
            for name in ['Directory.Build.props', 'nuget.config']:
                shutil.copy2(ROOT / name, mirror / name)
            changed = mirror / 'contracts/custom/SmartAccount.Paymaster.cs'
            source = changed.read_text()
            old = 'BigInteger cap = BigInteger.Max(actualCost - budget.Reserved, 0) + estimationFlag * requested;'
            self.assertIn(old, source)
            changed.write_text(source.replace(old, old.replace(' + estimationFlag', ' - estimationFlag')))
            command = list(self.command)
            command[command.index('--source-root') + 1] = str(mirror)
            command[command.index('--project') + 1] = str(mirror / 'contracts/custom/SmartAccount.csproj')
            result = subprocess.run(command, capture_output=True, text=True, timeout=120)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('source/nef pair mismatch', result.stderr.lower())

    def test_source_changed_after_snapshot_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            mirror = Path(temp)
            shutil.copytree(ROOT / 'contracts', mirror / 'contracts',
                            ignore=shutil.ignore_patterns('bin', 'obj', 'build'))
            for name in ['Directory.Build.props', 'nuget.config']:
                shutil.copy2(ROOT / name, mirror / name)
            original = mirror / 'contracts/custom/SmartAccount.Paymaster.cs'
            marker = '// race-control-' + uuid.uuid4().hex
            original.write_text(original.read_text() + '\n' + marker + '\n')
            command = list(self.command)
            command[command.index('--source-root') + 1] = str(mirror)
            command[command.index('--project') + 1] = str(mirror / 'contracts/custom/SmartAccount.csproj')
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 30
            changed = False
            while time.monotonic() < deadline and process.poll() is None:
                for scratch in Path(tempfile.gettempdir()).glob('sa-refinement-export-*/contracts/custom/SmartAccount.Paymaster.cs'):
                    try:
                        if marker in scratch.read_text():
                            original.write_text(original.read_text() + '// changed after snapshot\n')
                            changed = True
                            break
                    except FileNotFoundError:
                        continue
                if changed:
                    break
                time.sleep(0.01)
            stdout, stderr = process.communicate(timeout=120)
            self.assertTrue(changed, 'Exporter scratch source was not observed')
            self.assertNotEqual(process.returncode, 0, stdout[-500:])
            self.assertTrue('input changed' in stderr.lower() or 'typed tree differs' in stderr.lower(), stderr)


if __name__ == '__main__':
    unittest.main()

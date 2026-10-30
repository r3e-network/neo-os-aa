"""Independent source-only projection of the hook operation tuple constructor.

This frontend binds the real record layout and every array element. It never
consults target offsets, opcodes or expected VM results.
"""
import hashlib
import json
try:
    from .method_source import Projector, SourceProjectionError, require, symbol, collection, symbols, CHILD, conv
except ImportError:
    from method_source import Projector, SourceProjectionError, require, symbol, collection, symbols, CHILD, conv

METHOD = 'M:SmartAccount.SmartAccount.BuildHookOperationParams(SmartAccount.SmartAccount.UserOperation,System.Object[])'
RECORD_ID = 'T:SmartAccount.SmartAccount.UserOperation'
RECORD = 'global::SmartAccount.SmartAccount.UserOperation'
BIG = 'global::System.Numerics.BigInteger'


class HookProjector(Projector):
    def __init__(self, inventory):
        super().__init__(inventory)
        types = [t for t in self.source['types'] if t['id'] == RECORD_ID]
        require(types and all(t['fields'] == types[0]['fields'] for t in types), 'Ambiguous operation record layout')
        require(all(t['kind'] == 'Class' and t['baseType'] == 'object' and t['isValueType'] is False for t in types),
                'Unknown operation record interpretation')
        self.record_fields = types[0]['fields']
        require(len(self.record_fields) == 6 and len({f['id'] for f in self.record_fields}) == 6,
                'Incomplete operation record layout')
        require(all(f['isStatic'] is False and f['constant'] is None for f in self.record_fields),
                'Unsupported operation record fields')
        self.field_indices = {f['id']: i for i, f in enumerate(self.record_fields)}

    def hook_expr(self, node):
        self.header(node)
        kind, typ = node['kind'], node['type']
        if kind == 'ParameterReference':
            ordinal = node['details'].get('ordinal')
            require(ordinal in (0,1), 'Unknown hook parameter')
            name, expected_type = ('op', RECORD) if ordinal == 0 else ('args', 'object[]')
            self.check(node, typ=expected_type, count=0, details={'symbol': name, 'ordinal': ordinal},
                       meta={'IParameterReferenceOperation.Parameter': symbol(name)})
            return ['EArg', ordinal]
        if kind == 'FieldReference':
            identifier, children = self.member(node)
            require(identifier in self.field_indices and len(children) == 1 and children[0]['type'] == RECORD,
                    'Unknown operation field or receiver')
            index = self.field_indices[identifier]
            require(typ == self.record_fields[index]['type'], 'Operation field type mismatch')
            return ['EField', self.hook_expr(children[0]), index]
        if kind == 'Conversion':
            require(len(node['children']) == 1, 'Invalid boxing arity')
            operand_type = node['children'][0]['type']
            require(operand_type in ('global::Neo.SmartContract.Framework.UInt160', 'string', 'object[]', BIG,
                                     'global::Neo.SmartContract.Framework.ByteString'), 'Unknown boxing source type')
            conversion = conv(reference=operand_type != BIG)
            self.check(node, typ='object', count=1,
                       details={'checked': False, 'tryCast': False, 'conversion': conversion},
                       meta={'IConversionOperation.Operand': CHILD, 'IConversionOperation.OperatorMethod': None,
                             'IConversionOperation.ConstrainedToType': None, 'IConversionOperation.Conversion': conversion,
                             'IConversionOperation.IsTryCast': False, 'IConversionOperation.IsChecked': False})
            return self.hook_expr(node['children'][0])
        require(kind == 'ArrayCreation', 'Unsupported hook source expression: ' + kind)
        self.check(node, typ='object[]', count=2, meta={'IArrayCreationOperation.Initializer': CHILD},
                   collections={'IArrayCreationOperation.DimensionSizes': collection([0])})
        dimension, initializer = node['children']
        count = len(initializer['children'])
        require(self.literal(dimension) == ['EVal', ['VInt', count]], 'Array dimension differs from initializer')
        self.check(initializer, kind='ArrayInitializer', count=count,
                   collections={'IArrayInitializerOperation.ElementValues': collection(list(range(count)))})
        return ['ENew', 'ArrayKind', [self.hook_expr(child) for child in initializer['children']]]

    def project(self, method):
        require(method['returnType'] == 'object[]' and method['exportIssue'] is None and len(method['operations']) == 1,
                'Incomplete hook method source')
        require(method['parameters'] == [dict(name='op', type=RECORD, ordinal=0, refKind='None'),
                                         dict(name='args', type='object[]', ordinal=1, refKind='None')],
                'Hook parameter metadata mismatch')
        body = method['operations'][0]
        self.check(body, kind='MethodBodyOperation', count=1,
                   meta={'IMethodBodyBaseOperation.BlockBody': CHILD, 'IMethodBodyBaseOperation.ExpressionBody': None})
        block = body['children'][0]
        self.check(block, kind='Block', count=1,
                   collections={'IBlockOperation.Operations': collection([0]), 'IBlockOperation.Locals': symbols([])})
        ret = block['children'][0]
        self.check(ret, kind='Return', count=1, meta={'IReturnOperation.ReturnedValue': CHILD})
        require(ret['children'][0]['type'] == 'object[]', 'Hook return expression type mismatch')
        expression = self.hook_expr(ret['children'][0])
        require(expression[0] == 'ENew', 'Hook return must construct an array')
        return dict(sourceId=METHOD, displayName=method['displayName'], recordFields=self.record_fields,
                    expression=expression, runtimeStaticDependencies=[])


def project_method(inventory):
    candidates = [m for m in inventory['source']['methods'] if m['id'] == METHOD]
    require(len(candidates) == 1 and candidates[0]['origin'] == 'repository-source', 'Missing/ambiguous hook source')
    projection = HookProjector(inventory).project(candidates[0])
    projection['sourceProjectionSha256'] = hashlib.sha256(
        json.dumps(projection, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return projection


def render_expr(expression):
    kind = expression[0]
    if kind == 'EArg': return '(EArg '+str(expression[1])+'%nat)'
    if kind == 'EField': return '(EField '+render_expr(expression[1])+' '+str(expression[2])+'%nat)'
    require(kind == 'ENew' and expression[1] == 'ArrayKind', 'Unknown hook source IR')
    return '(ENew ArrayKind ['+';'.join(render_expr(e) for e in expression[2])+'])'

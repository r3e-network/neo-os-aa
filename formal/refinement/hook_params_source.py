"""Fail-closed source-only projection of the v4 hook/validator argument view.

`BuildCanonicalOperationView` is the constructor every v4 module callback
receives (validateUserOp, onUserOpComplete, preCheck and postCheck): the 13
protocol fields in wire order, with the two array fields (arguments and hook
proofs) deep-copied so a callback cannot alias the signed envelope. This
frontend binds the field symbols, their constant indices and the copy sites; it
never consults target offsets, opcodes or expected VM results.
"""
import hashlib
import json
try:
    from .method_source import Projector, SourceProjectionError, require, symbol, collection, CHILD, conv
except ImportError:
    from method_source import Projector, SourceProjectionError, require, symbol, collection, CHILD, conv

METHOD = 'M:SmartAccount.SmartAccount.BuildCanonicalOperationView(System.Object[])'
CLONE = 'M:SmartAccount.SmartAccount.CloneOperationArguments(System.Object[])'
PARAMETER = 'operation'
FIELD_PREFIX = 'F:SmartAccount.SmartAccount.'
INDICES_METADATA = 'IArrayElementReferenceOperation.Indices:'

# Protocol order (spec §4.1). The last two are the deep-copied array fields.
VIEW_FIELDS = ('OpVersion', 'OpTarget', 'OpMethod', 'OpArgs', 'OpNonce', 'OpNonceSubkey', 'OpDeadline',
               'OpValidatorId', 'OpCredentialGeneration', 'OpAuthorityEpoch', 'OpConfigurationNonce',
               'OpSignature', 'OpHookProofs')
DEEP_COPIED = (3, 12)

# The exporter keeps Roslyn's array-index list out of the modeled semantic
# collections on purpose; the index expression is the operation's second child,
# so the marker is accepted only in its exact, pinned shape.
IDENTITY = conv(identity=True)


def field_id(index):
    return FIELD_PREFIX + VIEW_FIELDS[index]


class HookViewProjector(Projector):
    def view_expr(self, node):
        self.check(node, kind='ArrayCreation', typ='object[]', count=2,
                   meta={'IArrayCreationOperation.Initializer': CHILD},
                   collections={'IArrayCreationOperation.DimensionSizes': collection([0])})
        dimension, initializer = node['children']
        count = len(initializer['children'])
        require(count == len(VIEW_FIELDS), 'Canonical view must carry the complete 13-field protocol view')
        require(self.literal(dimension) == ['EVal', ['VInt', count]], 'Array dimension differs from initializer')
        self.check(initializer, kind='ArrayInitializer', count=count,
                   collections={'IArrayInitializerOperation.ElementValues': collection(list(range(count)))})
        return ['ENew', 'ArrayKind', [self.element(child, index)
                                      for index, child in enumerate(initializer['children'])]]

    def element(self, node, index):
        expected = field_id(index)
        if index in DEEP_COPIED:
            self.check(node, kind='Conversion', typ='object', count=1,
                       details={'checked': False, 'tryCast': False,
                                'conversion': conv(implicit=True, reference=True)},
                       meta={'IConversionOperation.Operand': CHILD, 'IConversionOperation.OperatorMethod': None,
                             'IConversionOperation.ConstrainedToType': None,
                             'IConversionOperation.Conversion': conv(implicit=True, reference=True),
                             'IConversionOperation.IsTryCast': False, 'IConversionOperation.IsChecked': False})
            self.clone_invocation(node['children'][0], expected, index)
            return ['EField', ['EArg', 0], index]
        require(node['kind'] == 'ArrayElementReference', 'Expected a protocol field read, found ' + node['kind'])
        return ['EField', self.index_reference(node, expected, index), index]

    def clone_invocation(self, node, expected, index):
        self.check(node, kind='Invocation', typ='object[]', count=1,
                   details={'callee': CLONE, 'virtual': False},
                   meta={'IInvocationOperation.TargetMethod': symbol(CLONE),
                         'IInvocationOperation.ConstrainedToType': None,
                         'IInvocationOperation.Instance': None, 'IInvocationOperation.IsVirtual': False},
                   collections={'IInvocationOperation.Arguments': collection([0])})
        argument = node['children'][0]
        self.check(argument, kind='Argument', count=1,
                   details={'argumentKind': 'Explicit', 'parameter': 'args',
                            'inConversion': IDENTITY, 'outConversion': IDENTITY},
                   meta={'IArgumentOperation.ArgumentKind': 'Explicit',
                         'IArgumentOperation.Parameter': symbol('args'),
                         'IArgumentOperation.Value': CHILD,
                         'IArgumentOperation.InConversion': IDENTITY,
                         'IArgumentOperation.OutConversion': IDENTITY})
        operand = argument['children'][0]
        self.check(operand, kind='Conversion', typ='object[]', count=1,
                   details={'checked': False, 'tryCast': False,
                            'conversion': conv(implicit=False, reference=True)},
                   meta={'IConversionOperation.Operand': CHILD, 'IConversionOperation.OperatorMethod': None,
                         'IConversionOperation.ConstrainedToType': None,
                         'IConversionOperation.Conversion': conv(implicit=False, reference=True),
                         'IConversionOperation.IsTryCast': False, 'IConversionOperation.IsChecked': False})
        return self.index_reference(operand['children'][0], expected, index)

    def index_reference(self, node, expected, index):
        marker = node['unexportedMetadata']
        require(len(marker) == 1 and isinstance(marker[0], str) and marker[0].startswith(INDICES_METADATA),
                'Unmodeled array index metadata')
        clean = dict(node, unexportedMetadata=[])
        self.check(clean, kind='ArrayElementReference', typ='object', count=2,
                   meta={'IArrayElementReferenceOperation.ArrayReference': CHILD})
        array, key = clean['children']
        self.check(array, kind='ParameterReference', typ='object[]', count=0,
                   details={'symbol': PARAMETER, 'ordinal': 0},
                   meta={'IParameterReferenceOperation.Parameter': symbol(PARAMETER)})
        self.check(key, kind='FieldReference', typ='int', count=0,
                   details={'symbol': expected},
                   meta={'IMemberReferenceOperation.Instance': None,
                         'IMemberReferenceOperation.Member': symbol(expected),
                         'IMemberReferenceOperation.ConstrainedToType': None,
                         'IFieldReferenceOperation.Field': symbol(expected),
                         'IFieldReferenceOperation.IsDeclaration': False},
                   constant=True)
        require(int_constant(key) == index, 'Field index differs from its protocol position')
        return ['EArg', 0]

    def project(self, method):
        require(method['returnType'] == 'object[]' and method['exportIssue'] is None and len(method['operations']) == 1,
                'Incomplete canonical view source')
        require(method['parameters'] == [dict(name=PARAMETER, type='object[]', ordinal=0, refKind='None')],
                'Canonical view parameter metadata mismatch')
        body = method['operations'][0]
        self.check(body, kind='MethodBodyOperation', count=1,
                   meta={'IMethodBodyBaseOperation.BlockBody': CHILD, 'IMethodBodyBaseOperation.ExpressionBody': None})
        block = body['children'][0]
        self.check(block, kind='Block', count=1,
                   collections={'IBlockOperation.Operations': collection([0]), 'IBlockOperation.Locals': {"kind": "symbols", "items": [], "complete": True}})
        ret = block['children'][0]
        self.check(ret, kind='Return', count=1, meta={'IReturnOperation.ReturnedValue': CHILD})
        require(ret['children'][0]['type'] == 'object[]', 'Canonical view return expression type mismatch')
        expression = self.view_expr(ret['children'][0])
        require(expression[0] == 'ENew', 'Canonical view must construct an array')
        return dict(sourceId=METHOD, displayName=method['displayName'], viewFields=list(VIEW_FIELDS),
                    deepCopiedFields=list(DEEP_COPIED), expression=expression, runtimeStaticDependencies=[])


def int_constant(node):
    constant = node['constant']
    require(isinstance(constant, dict) and set(constant) == {'hasValue', 'value'}
            and constant['hasValue'] is True, 'Missing field index constant')
    payload = constant['value']
    require(isinstance(payload, dict) and set(payload) == {'runtimeType', 'value'}
            and payload['runtimeType'] == 'System.Int32' and isinstance(payload['value'], str),
            'Invalid field index payload')
    try:
        value = int(payload['value'])
    except (TypeError, ValueError):
        raise SourceProjectionError('Invalid field index literal') from None
    require(str(value) == payload['value'], 'Non-canonical field index literal')
    return value


def project_method(inventory):
    candidates = [m for m in inventory['source']['methods'] if m['id'] == METHOD]
    require(len(candidates) == 1 and candidates[0]['origin'] == 'repository-source',
            'Missing/ambiguous canonical view source')
    projection = HookViewProjector(inventory).project(candidates[0])
    projection['sourceProjectionSha256'] = hashlib.sha256(
        json.dumps(projection, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return projection


def render_expr(expression):
    kind = expression[0]
    if kind == 'EArg': return '(EArg '+str(expression[1])+'%nat)'
    if kind == 'EField': return '(EField '+render_expr(expression[1])+' '+str(expression[2])+'%nat)'
    require(kind == 'ENew' and expression[1] == 'ArrayKind', 'Unknown view source IR')
    return '(ENew ArrayKind ['+';'.join(render_expr(e) for e in expression[2])+'])'

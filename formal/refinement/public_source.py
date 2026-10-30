"""Independent typed-source frontend for effect-free public method returns.

Only `inventory.source` is read. Unsupported semantic metadata fails closed.
This declares Neo string-value semantics, not a general CLR interpreter.
"""
import hashlib
import json
try:
    from .method_source import Projector, SourceProjectionError, require, symbol, collection, symbols, CHILD
except ImportError:
    from method_source import Projector, SourceProjectionError, require, symbol, collection, symbols, CHILD

METHODS = {
    'getAccountImplementationId': ('M:SmartAccount.SmartAccount.GetAccountImplementationId', [], 'string'),
    'supportsExecutionMode': ('M:SmartAccount.SmartAccount.SupportsExecutionMode(System.String)', ['mode'], 'bool'),
    'supportsModuleType': ('M:SmartAccount.SmartAccount.SupportsModuleType(System.String)', ['moduleType'], 'bool'),
}


class PureProjector(Projector):
    def __init__(self, inventory, parameters):
        super().__init__(inventory)
        self.parameters = parameters

    def string_constant(self, node):
        c = node['constant']
        require(isinstance(c, dict) and set(c) == {'hasValue', 'value'} and c['hasValue'] is True,
                'Missing string constant')
        v = c['value']
        require(isinstance(v, dict) and set(v) == {'runtimeType', 'value'}
                and v['runtimeType'] == 'System.String' and type(v['value']) is str,
                'Mistyped string constant')
        try:
            return list(v['value'].encode('utf-8', errors='strict'))
        except UnicodeError:
            raise SourceProjectionError('Unsupported unpaired surrogate string') from None

    def pure_expr(self, n):
        self.header(n)
        kind, children = n['kind'], n['children']
        if kind == 'Literal':
            self.check(n, typ='string', count=0, constant=True)
            return ['PBytes', self.string_constant(n)]
        if kind == 'ParameterReference':
            name = n['details'].get('symbol')
            require(self.parameters == [name], 'Unknown public method parameter')
            self.check(n, typ='string', details={'symbol': name, 'ordinal': 0}, count=0,
                       meta={'IParameterReferenceOperation.Parameter': symbol(name)})
            return ['PArgument']
        if kind == 'FieldReference':
            identifier, receiver = self.member(n)
            value = self.string_constant(n)
            require(not receiver and n['type'] == 'string', 'Nonconstant static string field')
            candidates = [f for t in self.source['types'] for f in t['fields'] if f['id'] == identifier]
            require(candidates and all(f == candidates[0] for f in candidates), 'Ambiguous field declaration')
            field = candidates[0]
            require(field['type'] == 'string' and field['isStatic'] is True and field['constant'] == n['constant']['value'],
                    'Field constant and reference differ')
            return ['PBytes', value]
        require(kind == 'Binary', 'Unsupported pure expression: ' + kind)
        operator = n['details'].get('operator')
        require(operator in ('Equals', 'ConditionalOr'), 'Unsupported pure operator')
        self.check(n, typ='bool', count=2,
                   details={'operator': operator, 'checked': False, 'lifted': False, 'operatorMethod': None},
                   meta={'IBinaryOperation.OperatorKind': operator, 'IBinaryOperation.LeftOperand': CHILD,
                         'IBinaryOperation.RightOperand': CHILD, 'IBinaryOperation.IsLifted': False,
                         'IBinaryOperation.IsChecked': False, 'IBinaryOperation.IsCompareText': False,
                         'IBinaryOperation.OperatorMethod': None, 'IBinaryOperation.ConstrainedToType': None})
        require(all(c['type'] == ('string' if operator == 'Equals' else 'bool') for c in children),
                'Binary operand type mismatch')
        return ['PStringEq' if operator == 'Equals' else 'POr', *(self.pure_expr(c) for c in children)]

    def project(self, method):
        require(method['exportIssue'] is None and len(method['operations']) == 1, 'Incomplete method source')
        body = method['operations'][0]
        self.check(body, kind='MethodBodyOperation', count=1,
                   meta={'IMethodBodyBaseOperation.BlockBody': CHILD, 'IMethodBodyBaseOperation.ExpressionBody': None})
        block = body['children'][0]
        self.check(block, kind='Block', count=1, collections={'IBlockOperation.Operations': collection([0]),
                                                           'IBlockOperation.Locals': symbols([])})
        ret = block['children'][0]
        self.check(ret, kind='Return', count=1, meta={'IReturnOperation.ReturnedValue': CHILD})
        return self.pure_expr(ret['children'][0])

    def member(self, n, *, is_property=False):
        # Base member checker excludes constants. Retain every metadata check,
        # while checking the typed compile-time constant separately.
        constant = n['constant']
        copied = dict(n, constant=None)
        result = super().member(copied, is_property=is_property)
        require(constant is not None, 'Public static field must be a typed constant')
        return result


def project_methods(inventory):
    result = {}
    for abi, (identifier, parameters, return_type) in METHODS.items():
        candidates = [m for m in inventory['source']['methods'] if m['id'] == identifier]
        require(len(candidates) == 1, 'Missing or ambiguous source method: ' + identifier)
        m = candidates[0]
        require(m['origin'] == 'repository-source' and m['returnType'] == return_type,
                'Method origin/return type mismatch')
        require(m['parameters'] == [dict(name=name, type='string', ordinal=i, refKind='None')
                                    for i, name in enumerate(parameters)], 'Method parameter mismatch')
        expression = PureProjector(inventory, parameters).project(m)
        result[abi] = dict(sourceId=identifier, displayName=m['displayName'],
                           parameters=parameters, returnType=return_type, expression=expression,
                           runtimeStaticDependencies=[])
    return result


def render_expr(expr):
    tag = expr[0]
    if tag == 'PBytes': return '(PBytes [' + ';'.join(str(b)+'%nat' for b in expr[1]) + '])'
    if tag == 'PArgument': return 'PArgument'
    require(tag in ('PStringEq', 'POr') and len(expr) == 3, 'Unknown source IR')
    return '(' + tag + ' ' + render_expr(expr[1]) + ' ' + render_expr(expr[2]) + ')'


def projection_hash(projection):
    return hashlib.sha256(json.dumps(projection, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

#!/usr/bin/env python3
"""Strict, deliberately limited C# handler extraction; parser remains TCB."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import tempfile
import urllib.request

COMMIT = '004cd6070a940405818d9357638277dd44407e2e'
SOURCE_HASHES = {
    'JumpTable/JumpTable.Numeric.cs': '2d7c3ecad798bb3a8e015e6913c941ca800320f44ad120a8c43684ca583e6ebf',
    'JumpTable/JumpTable.Stack.cs': '45a5767f58141f157fbc584a0bc3c5eca97f3f6880e93da1f2fe89263bdebcec',
    'JumpTable/JumpTable.Slot.cs': '771273cbcfc23aa28207494539fe1e994e5f360a21b1c356a070499aaa48175a',
    'JumpTable/JumpTable.Control.cs': 'a0ac51ff220abbfcf8fb8c19bb0f2b8be4680169ba8ba33f6ededfc5e5e6a2ec',
    'JumpTable/JumpTable.cs': '7c652697f69f766e8b4e17b3ccc82c9fae51d404b157b6f1f3f2fceae96e3c7c',
    'ExecutionEngine.cs': 'ea906436ec48408abe92826547041859fb6195553f8e585816f1d96695663445',
    'EvaluationStack.cs': '7190a363cd8c71010c2a98987f5aadd331adeff4d3551b1bc9e1d8cd7a56ac3e',
    'Slot.cs': '4f017425c8b649ad2a2eddb4d405af85d2d78c0b868bcf243f492cbd33b82014',
}
HANDLERS = {name.upper(): ('JumpTable/JumpTable.Numeric.cs', name)
            for name in ('Add', 'Sub', 'Mul', 'Min', 'Max', 'Gt')}
HANDLERS.update({name.upper(): ('JumpTable/JumpTable.Stack.cs', name)
                 for name in ('Drop', 'Dup', 'Tuck', 'Swap', 'Rot')})
HANDLERS.update({name.upper(): ('JumpTable/JumpTable.Slot.cs', name)
                 for prefix in ('LdLoc', 'StLoc', 'LdArg') for name in (prefix + str(i) for i in range(7))})
HANDLERS['LDSFLD'] = ('JumpTable/JumpTable.Slot.cs', 'LdSFld')
HANDLERS.update({name.upper(): ('JumpTable/JumpTable.Control.cs', name) for name in ('Jmp', 'JmpIf', 'JmpIfNot')})


def require(condition, message):
    if not condition:
        raise ValueError(message)


def pinned_sources(cache=None):
    cache = Path(cache) if cache else Path(tempfile.gettempdir()) / 'aa-pinned-neovm-runtime-004cd607'
    result = {}
    for path, expected in SOURCE_HASHES.items():
        target = cache / path
        if not target.exists():
            data = urllib.request.urlopen(f'https://raw.githubusercontent.com/neo-project/neo-vm/{COMMIT}/src/Neo.VM/{path}', timeout=30).read()
            require(hashlib.sha256(data).hexdigest() == expected, 'Pinned source download mismatch: ' + path)
            target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
        raw = target.read_bytes()
        require(hashlib.sha256(raw).hexdigest() == expected, 'Pinned source mismatch: ' + path)
        result[path] = raw.decode('utf-8')
    return result


TOKEN = re.compile(r'\s+|//[^\n]*|/\*[\s\S]*?\*/|\$?"(?:\\.|[^"\\])*"|'
                   r'[A-Za-z_][A-Za-z_0-9]*|[0-9]+|==|!=|<=|>=|&&|\|\||'
                   r'[{}()\[\];,.!+*\-/<>=?:]')


def tokens(source):
    result, end = [], 0
    for match in TOKEN.finditer(source):
        require(match.start() == end, 'Unknown C# token near ' + source[end:end + 40])
        end = match.end(); token = match.group()
        if token.isspace() or token.startswith(('//', '/*')):
            continue
        result.append(token)
    require(end == len(source), 'Unknown C# tail: ' + source[end:end + 40])
    return result


class Parser:
    precedence = {'||': 1, '&&': 2, 'is': 3, '==': 3, '!=': 3, '<': 4, '>': 4,
                  '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6}

    def __init__(self, source):
        self.items, self.position = tokens(source), 0

    def peek(self):
        return self.items[self.position] if self.position < len(self.items) else None

    def take(self, expected=None):
        value = self.peek(); require(value is not None, 'Truncated C# body')
        require(expected is None or value == expected, f'Expected {expected}, got {value}')
        self.position += 1; return value

    def expression(self, minimum=0):
        token = self.take()
        if token in ('!', '-'):
            node = dict(kind='unary', operator=token, operand=self.expression(7))
        elif token == '(':
            node = self.expression(); self.take(')')
        elif token in ('true', 'false', 'null'):
            node = dict(kind='literal', value={'true': True, 'false': False, 'null': None}[token])
        elif token.isdigit():
            node = dict(kind='literal', value=int(token))
        elif token.startswith(('"', '$"')):
            node = dict(kind='string', text=token)
        else:
            require(re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', token), 'Unknown expression token')
            node = dict(kind='variable', name=token)
        while True:
            op = self.peek()
            if op == '.':
                self.take(); member = self.take()
                require(re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', member), 'Invalid member')
                node = dict(kind='member', receiver=node, name=member)
            elif op == '!' and node['kind'] == 'member':
                self.take(); node = dict(kind='null-forgiving', operand=node)
            elif op == '(':
                self.take(); args = []
                if self.peek() != ')':
                    while True:
                        args.append(self.expression())
                        if self.peek() != ',': break
                        self.take(',')
                self.take(')'); node = dict(kind='call', target=node, arguments=args)
            elif op == '[':
                self.take(); index = self.expression(); self.take(']')
                node = dict(kind='index', receiver=node, index=index)
            elif op in self.precedence and self.precedence[op] >= minimum:
                self.take(); node = dict(kind='binary', operator=op, left=node,
                                        right=self.expression(self.precedence[op] + 1))
            else:
                break
        return node

    def statement(self):
        token = self.peek()
        if token == '{':
            self.take(); result = []
            while self.peek() != '}': result += self.statement()
            self.take('}'); return result
        if token == 'var':
            self.take(); name = self.take(); self.take('='); value = self.expression(); self.take(';')
            return [dict(kind='declare', name=name, expression=value)]
        if token == 'if':
            self.take(); self.take('('); condition = self.expression(); self.take(')')
            yes = self.statement(); no = []
            if self.peek() == 'else': self.take(); no = self.statement()
            return [dict(kind='if', condition=condition, then=yes, otherwise=no)]
        if token == 'throw':
            self.take(); self.take('new'); exception = self.take(); self.take('(')
            message = self.expression(); self.take(')'); self.take(';')
            return [dict(kind='throw', exception=exception, message=message)]
        require(token not in ('while', 'for', 'foreach', 'try', 'return', 'lock', 'using'), 'Unsupported C# statement: ' + str(token))
        expression = self.expression()
        if self.peek() == '=':
            self.take(); value = self.expression(); self.take(';')
            return [dict(kind='assign', target=expression, expression=value)]
        self.take(';'); return [dict(kind='expression', expression=expression)]

    def body(self):
        result = []
        while self.peek() is not None: result += self.statement()
        return result


def path_of(node):
    if node['kind'] == 'variable': return node['name']
    if node['kind'] == 'null-forgiving': return path_of(node['operand'])
    if node['kind'] == 'member':
        before = path_of(node['receiver']); return before + '.' + node['name'] if before else None
    return None


def validate_body(body, helper=False):
    symbols = {'engine': 'engine', 'instruction': 'instruction'}
    if helper: symbols.update(slot='slot', index='integer', position='integer', offset='integer')

    def expr(node):
        kind = node['kind']
        if kind == 'literal': return 'null' if node['value'] is None else 'boolean' if isinstance(node['value'], bool) else 'integer'
        if kind == 'string':
            if node['text'].startswith('$'):
                holes = re.findall(r'\{([^{}]*)\}', node['text'])
                require(all(re.fullmatch(r'(?:stack|slot)\.Count|index|position', h) for h in holes), 'Unsupported interpolation effects')
            return 'string'
        if kind == 'variable':
            require(node['name'] in symbols, 'Unbound C# variable: ' + node['name']); return symbols[node['name']]
        if kind == 'null-forgiving': return expr(node['operand'])
        if kind == 'member':
            path = path_of(node)
            if path in {'engine.CurrentContext.EvaluationStack'}: return 'stack'
            if path in {'engine.CurrentContext.LocalVariables', 'engine.CurrentContext.Arguments', 'engine.CurrentContext.StaticFields'}: return 'slot'
            if path in {'engine.CurrentContext.InstructionPointer', 'engine.CurrentContext.Script.Length', 'instruction.TokenI8', 'instruction.TokenU8'}: return 'integer'
            parent = expr(node['receiver'])
            require((parent, node['name']) in {('stack', 'Count'), ('slot', 'Count'), ('value', 'IsNull')}, 'Unknown property access: ' + str(path))
            return 'boolean' if node['name'] == 'IsNull' else 'integer'
        if kind == 'unary':
            sort = expr(node['operand']); require(sort == ('boolean' if node['operator'] == '!' else 'integer'), 'Unary operand type mismatch'); return sort
        if kind == 'binary':
            left, right, op = expr(node['left']), expr(node['right']), node['operator']
            if op == 'is': require(left == 'slot' and right == 'null', 'Unsupported type pattern'); return 'boolean'
            require(left == right and left in ('integer', 'boolean'), 'Binary type mismatch')
            require((op in ('&&', '||')) == (left == 'boolean'), 'Unsupported Boolean/integer operator')
            return 'boolean' if op in ('<', '>', '<=', '>=', '==', '!=', '&&', '||') else 'integer'
        if kind == 'index': require(expr(node['receiver']) == 'slot' and expr(node['index']) == 'integer', 'Unsupported indexer'); return 'value'
        require(kind == 'call', 'Unknown expression node')
        target, args = node['target'], node['arguments']; path = path_of(target)
        if path == 'engine.Pop': require(not args, 'Pop arity'); return 'value'
        if path == 'engine.Peek': require(len(args) <= 1 and all(expr(a) == 'integer' for a in args), 'Peek arity/type'); return 'value'
        if path == 'engine.Push': require(len(args) == 1 and expr(args[0]) in ('value', 'integer', 'boolean'), 'Push type'); return 'void'
        if path in ('BigInteger.Min', 'BigInteger.Max'): require(len(args) == 2 and all(expr(a) == 'integer' for a in args), 'BigInteger call signature'); return 'integer'
        if path in ('ExecuteLoadFromSlot', 'ExecuteStoreToSlot'):
            require(len(args) == 3 and [expr(a) for a in args] == ['engine', 'slot', 'integer'], 'Slot helper binding'); return 'void'
        if path in ('ExecuteJumpOffset', 'ExecuteJump'):
            require(len(args) == 2 and [expr(a) for a in args] == ['engine', 'integer'], 'Jump helper binding'); return 'void'
        if path == 'checked': require(len(args) == 1 and expr(args[0]) == 'integer', 'Checked expression'); return 'integer'
        require(target['kind'] == 'member', 'Unknown C# call: ' + str(path))
        receiver, name = target['receiver'], target['name']
        if name in ('GetInteger', 'GetBoolean'):
            require(not args and expr(receiver) == 'value', 'Value coercion binding'); return 'integer' if name == 'GetInteger' else 'boolean'
        if name in ('Swap', 'Insert'):
            require(expr(receiver) == 'stack' and len(args) == 2 and expr(args[0]) == 'integer', 'Stack helper binding')
            require(expr(args[1]) == ('integer' if name == 'Swap' else 'value'), 'Stack helper second operand'); return 'void'
        raise ValueError('Unknown C# method: ' + str(path))

    def visit(statements):
        for stmt in statements:
            kind = stmt['kind']
            if kind == 'declare':
                require(stmt['name'] not in symbols and stmt['name'] not in {'BigInteger','checked','ExecuteLoadFromSlot','ExecuteStoreToSlot','ExecuteJump','ExecuteJumpOffset'}, 'Duplicate/shadowed C# symbol')
                symbols[stmt['name']] = expr(stmt['expression'])
            elif kind == 'expression': expr(stmt['expression'])
            elif kind == 'if':
                require(expr(stmt['condition']) == 'boolean', 'If condition type')
                before = dict(symbols)
                visit(stmt['then']); symbols.clear(); symbols.update(before)
                visit(stmt['otherwise']); symbols.clear(); symbols.update(before)
            elif kind == 'throw':
                require(stmt['exception'] in ('InvalidOperationException', 'ArgumentOutOfRangeException') and expr(stmt['message']) == 'string', 'Unknown throw semantics')
            elif kind == 'assign':
                target = stmt['target']; value_type = expr(stmt['expression'])
                allowed = target['kind'] == 'index' and expr(target) == 'value' and value_type == 'value'
                allowed |= path_of(target) == 'engine.CurrentContext.InstructionPointer' and value_type == 'integer'
                allowed |= path_of(target) == 'engine.isJumping' and value_type == 'boolean'
                require(allowed, 'Unknown assignment effects')
            else: raise ValueError('Unknown statement node')
    visit(body)


def parse_handler(source, method, helper=False):
    prefix = source[:source.find('partial class JumpTable')]
    require('namespace Neo.VM;' in prefix, 'Unexpected runtime namespace')
    imports = re.findall(r'^using ([^;]+);', prefix, re.MULTILINE)
    require(set(imports) <= {'System', 'System.Numerics', 'System.Runtime.CompilerServices', 'Neo.VM.Types', 'System.Collections.Generic', 'System.Linq'}, 'Unknown C# binding/alias')
    matches = list(re.finditer(r'public virtual void\s+' + re.escape(method) + r'\s*\(([^)]*)\)\s*\{', source))
    require(len(matches) == 1, 'Missing/duplicate handler declaration: ' + method)
    match = matches[0]
    parameters = re.sub(r'\s+', ' ', match.group(1).strip())
    require(parameters in {'ExecutionEngine engine, Instruction instruction', 'ExecutionEngine engine, Slot? slot, int index', 'ExecutionEngine engine, int position', 'ExecutionEngine engine, int offset'}, 'Unknown handler signature')
    # Lexing avoids treating braces in strings/comments as method delimiters.
    text = source[match.end() - 1:]; depth, cursor, rest = 0, 0, []
    while cursor < len(text):
        token_match = TOKEN.match(text, cursor)
        require(token_match is not None, 'Unknown token inside handler')
        token = token_match.group(); cursor = token_match.end()
        if token.isspace() or token.startswith(('//', '/*')): continue
        rest.append(token)
        if token == '{': depth += 1
        if token == '}':
            depth -= 1
            if depth == 0: break
    require(depth == 0, 'Unterminated handler')
    parser = Parser(' '.join(rest[1:-1])); body = parser.body(); validate_body(body, helper)
    return body


def extract_runtime(cache=None):
    sources = pinned_sources(cache)
    handlers = {opcode: {'path': path, 'method': method, 'body': parse_handler(sources[path], method)}
                for opcode, (path, method) in HANDLERS.items()}
    helpers = {name: parse_handler(sources[path], name, True) for path, names in
               [('JumpTable/JumpTable.Slot.cs', ('ExecuteLoadFromSlot', 'ExecuteStoreToSlot')),
                ('JumpTable/JumpTable.Control.cs', ('ExecuteJump', 'ExecuteJumpOffset'))] for name in names}
    return {'schema': 'neoos-aa-runtime-handler-source/v1', 'sourceCommit': COMMIT,
        'sourceSha256': SOURCE_HASHES, 'handlers': handlers, 'helpers': helpers,
        'sourceExtractionTrusted': True, 'runtimeImplementationProven': False,
        'unsupported': ['InitSlot/Pack/PickItem/SetItem heap operations', 'Equal/NotEqual comparison limits',
                        'syscall/native call/return dispatch', 'opcode dispatch and engine scheduling',
                        'unrecognized C# syntax/API', 'resource limits and exception payload/unwinding']}


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--source-cache', type=Path)
    args = parser.parse_args()
    print(json.dumps(extract_runtime(args.source_cache), separators=(',', ':')))


if __name__ == '__main__': main()

"""Correspondence between the shared C# front end and an independent reader.

Seven refinement lanes read their pinned C# with one shared tokenizer and slice
method bodies by counting braces over that token stream. Those two functions
carry the trust item this project calls

    SOURCE_FRONTEND_AND_COMPILER_CORRESPONDENCE

because every projection lane's anchors are substrings of the normalized text
and every field is read out of a sliced body. If the front end reads a file
differently than the pinned source means, every downstream receipt is still
internally consistent and still wrong.

What the front end *is* moved during this work. It used to be a regular
expression that seven modules carried verbatim, and this module read that table
out of their text. A single expression cannot read an interpolated literal —
the hole is an expression and can hold a quote — so the lanes now share
`csharp_tokens.TOKENIZER`, and what this module reads out of the seven modules
is the declaration that names it. The declaration is a census (seven modules
naming one reader); the reader itself is loaded and executed, because the faces
below have to measure what the lanes do and not a second opinion about it.

This module does not prove that item. It makes it measurable. It carries a
second reader, written as a character state machine that shares no code with the
scanner, and runs both over the pinned sources a gate actually used. Five faces
compare the two readers:

    normalize   the joined text. Joining is concatenation, so `a == b` and
                `a = =b` normalize alike; equality here says only that both
                readers dropped the same characters, which is whitespace and
                comments and nothing else.
    tokens      the token sequence item by item. This face can see a boundary
                drawn in the wrong place.
    bodies      the body each reader slices for every complete method it can
                name independently. The header is taken verbatim out of the
                file, so both readers receive the same bytes.
    anchors     whether both readers accept and join the fragments the lane
                modules name, since an anchor joined differently lands in a
                different place and every field after it is read from wrong.
    needles     the same three questions asked of the short literals the
                projection code reads a field with — `if needle in text`,
                `text.count(needle) == 1`. No length floor, because a needle
                that is seven characters long still decides which region of
                which file a lane is looking at, and the anchor face cannot see
                it at all.

A sixth face, and the only one that is not ours, asks the C# lexer itself
(Roslyn, with trivia removed) two questions:

    lexer       whole files: does the front end join the same characters the
                compiler joins? And anchors: does every fragment a lane locates
                survive the compiler's view? The second is not negotiable.

A seventh, `strict`, asks the prior question — is there a reader here that
reproduces the compiler on every file? — and only once it does is its
disagreement with the front end a defect with an offset and a length rather than
an opinion. `knownGaps` records any that remain, with the reproducer, and the
list is frozen in the gate: a new gap fails the run and a closed one has to be
deleted on purpose. It is empty.

Alongside them a census records which token classes the corpus actually spells,
because an operator no file contains is not evidence of anything, and a
self-test perturbs the independent reader on constructed snippets, so a run of
zero disagreements cannot be confused with a harness that compares nothing.

What this module will never report: that the grammar is proven, that the
compiler correspondence is established, or that the implementation is verified.
It reports counts. A caller that wants a proof of this item has to produce one.
"""

import ast
import hashlib
import importlib.util
import json
import os
import re

SCHEMA = 'sa-frontend-correspondence/1'
SCOPE = 'source-frontend-and-compiler-correspondence'

# The seven modules that share one reader. `private_tables()` finds the rest:
# modules that still bind `TOKEN` to a table of their own read a narrower
# character set, so they are named as outside these faces rather than merged
# into them. `VARIANT_MODULES` is the narrower pair whose declared fragments are
# checked anyway, because their anchors are applied to pinned C# like everyone
# else's.
CANONICAL_MODULES = (
    'abi_admission_source.py',
    'contract_handoff_source.py',
    'entry_dispatch_source.py',
    'exception_identity_source.py',
    'interop_convert_source.py',
    'interop_fee_source.py',
    'syscall_dispatch_source.py',
)
VARIANT_MODULES = ('gas_proofs.py', 'runtime_collection_source.py')

# The character classes the independent reader knows. Kept as data so the
# census can name what the corpus never exercises.
WHITESPACE = frozenset(' \t\r\n\f\v')
LETTERS = frozenset('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_')
IDENTIFIER_PART = LETTERS | frozenset('0123456789')
DIGITS = frozenset('0123456789')
OPERATORS = ('==', '!=', '<=', '>=', '&&', '||', '++', '--', '=>', '??=')
SINGLE = frozenset('{}()[];,.!+-*/<>=?:@&|~^%')


class UnsupportedSource(ValueError):
    """A fragment the independent reader has no rule for."""


# ---------------------------------------------------------------------------
# the independent reader
# ---------------------------------------------------------------------------

def spans(text):
    """Yield (kind, value, start, end) for one source fragment.

    Kinds are `word`, `number`, `literal` and `operator`. Comments and
    whitespace yield nothing, which is exactly what the shared table drops. The
    span is what lets a caller hand both readers a header that is a verbatim
    substring of the file.
    """
    out = []
    index, length = 0, len(text)
    while index < length:
        char = text[index]
        if char in WHITESPACE:
            index += 1
            continue
        if char == '/' and index + 1 < length and text[index + 1] == '/':
            while index < length and text[index] != '\n':
                index += 1
            continue
        if char == '/' and index + 1 < length and text[index + 1] == '*':
            close = text.find('*/', index + 2)
            if close < 0:
                raise UnsupportedSource('unterminated block comment')
            index = close + 2
            continue
        if char == '$':
            if index + 1 >= length or text[index + 1] != '"':
                raise UnsupportedSource("unsupported '$' at %d" % index)
            # A hole is an expression, and an expression can hold a quote. The
            # reader treats the literal as one piece; a reader that stops at the
            # first quote inside a hole drops characters the compiler keeps.
            end = _strict_end_of_interpolated(text, index + 1)
            out.append(('literal', text[index:end], index, end))
            index = end
            continue
        if char == '"':
            end = _end_of_string(text, index)
            out.append(('literal', text[index:end], index, end))
            index = end
            continue
        if char == "'":
            end = _end_of_char(text, index)
            out.append(('literal', text[index:end], index, end))
            index = end
            continue
        if char in DIGITS:
            end = index
            while end < length and text[end] in DIGITS:
                end += 1
            out.append(('number', text[index:end], index, end))
            index = end
            continue
        if char in LETTERS:
            end = index
            while end < length and text[end] in IDENTIFIER_PART:
                end += 1
            out.append(('word', text[index:end], index, end))
            index = end
            continue
        for operator in OPERATORS:
            if text.startswith(operator, index):
                out.append(('operator', operator, index, index + len(operator)))
                index += len(operator)
                break
        else:
            if char not in SINGLE:
                raise UnsupportedSource('unsupported %r at %d' % (char, index))
            out.append(('operator', char, index, index + 1))
            index += 1
    return out


def pieces(text):
    """Yield (kind, value) for one source fragment."""
    return [(kind, value) for kind, value, _, _ in spans(text)]


def _end_of_string(text, quote):
    """Return the index just past the closing quote, escapes included."""
    index, length = quote + 1, len(text)
    while index < length:
        if text[index] == '\\':
            index += 2
            continue
        if text[index] == '"':
            return index + 1
        index += 1
    raise UnsupportedSource('unterminated string literal')


def _end_of_char(text, quote):
    """Return the index just past the closing quote of one character literal.

    The shared table matches exactly one character between the quotes, so an
    empty `''` is a fragment it refuses. This reader refuses it too, rather than
    accepting something the table cannot read and calling the difference a
    correspondence.
    """
    if quote + 1 < len(text) and text[quote + 1] == "'":
        raise UnsupportedSource('empty character literal')
    index, length = quote + 1, len(text)
    while index < length:
        if text[index] == '\\':
            index += 2
            continue
        if text[index] == "'":
            return index + 1
        index += 1
    raise UnsupportedSource('unterminated character literal')


def normalize(text):
    """Join the pieces of a fragment the way the shared reader joins a body."""
    return ''.join(value for _, value in pieces(text))


def strip_directives(text):
    """Drop every line whose first non-space character is `#`, keeping the body.

    This is no longer how any lane reads a file — `active_text` is. It is kept
    because it is the exact reading the lanes used before conditional semantics
    were added, and `_cause` needs that reading as a counterfactual: to say a
    defect is about strings rather than directives, it has to try the directive
    remedy alone and see what is left.
    """
    kept = []
    for line in text.split('\n'):
        if line.lstrip(' \t').startswith('#'):
            continue
        kept.append(line)
    return '\n'.join(kept)


# ---------------------------------------------------------------------------
# the strict reader: the one the compiler is asked to confirm
# ---------------------------------------------------------------------------

# What the compiler is told when it reads these bytes. Nothing is defined, so a
# `#if VMPERF` region is disabled text the lexer never sees. This is a receipt
# field rather than a hidden default, because a different symbol set is a
# different reading of the same bytes and the two must not be confused.
STRICT_SYMBOLS = ()


def _strict_end_of_plain(text, quote):
    """`"..."`: a backslash escapes the next character, a quote ends the token."""
    index, length = quote + 1, len(text)
    while index < length:
        if text[index] == '\\':
            index += 2
            continue
        if text[index] == '"':
            return index + 1
        index += 1
    raise UnsupportedSource('unterminated string literal')


def _strict_end_of_verbatim(text, quote):
    """`@"..."`: a doubled quote is the escape and a backslash is a character."""
    index, length = quote + 1, len(text)
    while index < length:
        if text[index] == '"':
            if index + 1 < length and text[index + 1] == '"':
                index += 2
                continue
            return index + 1
        index += 1
    raise UnsupportedSource('unterminated verbatim string literal')


def _strict_end_of_interpolated(text, quote):
    """`$"..."`: a hole is transparent and `{{`/`}}` are literal braces.

    The shared table ends an interpolated literal at the first unescaped quote,
    which is the opening quote of a nested literal inside a hole. That is how a
    hole loses characters. Here the hole is read as the expression it is.
    """
    index, length = quote + 1, len(text)
    while index < length:
        char = text[index]
        if char == '\\':
            index += 2
            continue
        if char == '"':
            return index + 1
        if char == '{':
            if index + 1 < length and text[index + 1] == '{':
                index += 2
                continue
            index = _strict_end_of_hole(text, index)
            continue
        index += 1
    raise UnsupportedSource('unterminated interpolated string literal')


def _strict_end_of_hole(text, opening):
    """Return the index past the `}` that closes one interpolation hole.

    A hole holds an expression, so it may contain braces, literals, characters
    and comments. A `:` at depth zero starts a format specifier, which is raw
    text up to the closing brace and is treated that way by not being parsed.
    """
    index, length = opening + 1, len(text)
    depth = 0
    while index < length:
        char = text[index]
        if char == '"':
            index = _strict_end_of_plain(text, index)
            continue
        if char == "'":
            index = _end_of_char(text, index)
            continue
        if char == '@' and index + 1 < length and text[index + 1] == '"':
            index = _strict_end_of_verbatim(text, index + 1)
            continue
        if char == '$' and index + 1 < length and text[index + 1] == '"':
            index = _strict_end_of_interpolated(text, index + 1)
            continue
        if char == '/' and index + 1 < length and text[index + 1] == '/':
            while index < length and text[index] != '\n':
                index += 1
            continue
        if char == '/' and index + 1 < length and text[index + 1] == '*':
            close = text.find('*/', index + 2)
            if close < 0:
                raise UnsupportedSource('unterminated block comment in a hole')
            index = close + 2
            continue
        if char == '{':
            depth += 1
        elif char == '}':
            if depth == 0:
                return index + 1
            depth -= 1
        index += 1
    raise UnsupportedSource('unterminated interpolation hole')


def strict_spans(text):
    """Yield (kind, value, start, end) for the way C# actually reads a fragment.

    The same four kinds as `spans`, and the same literal rules for everything
    the plain reader handles. What it adds is the verbatim literal: `@"..."`
    escapes by doubling a quote and a backslash is an ordinary character. The
    front end's scanner has that rule and the plain reader does not — it reads
    the `@` as an operator and the rest as an ordinary literal — so verbatim is
    the one literal shape where the two readers can still disagree, and the
    lexer face is what says whether the corpus contains one.
    """
    out = []
    index, length = 0, len(text)
    while index < length:
        char = text[index]
        if char in WHITESPACE:
            index += 1
            continue
        if char == '/' and index + 1 < length and text[index + 1] == '/':
            while index < length and text[index] != '\n':
                index += 1
            continue
        if char == '/' and index + 1 < length and text[index + 1] == '*':
            close = text.find('*/', index + 2)
            if close < 0:
                raise UnsupportedSource('unterminated block comment')
            index = close + 2
            continue
        if char == '$':
            if index + 1 < length and text[index + 1] == '"':
                end = _strict_end_of_interpolated(text, index + 1)
                out.append(('literal', text[index:end], index, end))
                index = end
                continue
            if (index + 2 < length and text[index + 1] == '@'
                    and text[index + 2] == '"'):
                end = _strict_end_of_verbatim(text, index + 2)
                out.append(('literal', text[index:end], index, end))
                index = end
                continue
            raise UnsupportedSource("unsupported '$' at %d" % index)
        if char == '@':
            if index + 1 < length and text[index + 1] == '"':
                end = _strict_end_of_verbatim(text, index + 1)
                out.append(('literal', text[index:end], index, end))
                index = end
                continue
            if (index + 2 < length and text[index + 1] == '$'
                    and text[index + 2] == '"'):
                end = _strict_end_of_interpolated(text, index + 2)
                out.append(('literal', text[index:end], index, end))
                index = end
                continue
        if char == '"':
            end = _strict_end_of_plain(text, index)
            out.append(('literal', text[index:end], index, end))
            index = end
            continue
        if char == "'":
            end = _end_of_char(text, index)
            out.append(('literal', text[index:end], index, end))
            index = end
            continue
        if char in DIGITS:
            end = index
            while end < length and text[end] in DIGITS:
                end += 1
            out.append(('number', text[index:end], index, end))
            index = end
            continue
        if char in LETTERS:
            end = index
            while end < length and text[end] in IDENTIFIER_PART:
                end += 1
            out.append(('word', text[index:end], index, end))
            index = end
            continue
        for operator in OPERATORS:
            if text.startswith(operator, index):
                out.append(('operator', operator, index, index + len(operator)))
                index += len(operator)
                break
        else:
            if char not in SINGLE:
                raise UnsupportedSource('unsupported %r at %d' % (char, index))
            out.append(('operator', char, index, index + 1))
            index += 1
    return out


def strict_normalize(text):
    """Join the pieces the way the compiler's lexer joins them."""
    return ''.join(value for _, value, _, _ in strict_spans(text))


DIRECTIVE = re.compile(r'^\s*#\s*([A-Za-z_]+)\s*(.*)$')
PREPROCESSOR = re.compile(r'\(|\)|!|&&|\|\||==|!=|[A-Za-z_][A-Za-z_0-9]*')


def preprocessor_value(expression, symbols):
    """Evaluate one `#if` expression. An undefined symbol is false.

    The grammar is the small one the directive allows: `!`, `&&`, `||`, `==`,
    `!=`, parentheses, `true`, `false` and identifiers. Anything else is
    refused rather than guessed, because a guess here would silently enable or
    disable a region and change what every lane reads.
    """
    tokens = PREPROCESSOR.findall(expression)
    position = [0]

    def peek():
        return tokens[position[0]] if position[0] < len(tokens) else None

    def take():
        token = peek()
        position[0] += 1
        return token

    def parse_or():
        value = parse_and()
        while peek() == '||':
            take()
            right = parse_and()
            value = value or right
        return value

    def parse_and():
        value = parse_unary()
        while peek() == '&&':
            take()
            right = parse_unary()
            value = value and right
        return value

    def parse_unary():
        if peek() == '!':
            take()
            return not parse_unary()
        if peek() == '(':
            take()
            value = parse_or()
            if peek() != ')':
                raise UnsupportedSource('unbalanced parenthesis in a directive')
            take()
            return value
        token = take()
        if token is None:
            raise UnsupportedSource('empty preprocessor expression')
        if token in ('true', 'false'):
            return token == 'true'
        if token in ('==', '!=', '&&', '||', ')'):
            raise UnsupportedSource('misplaced %r in a directive' % token)
        return token in symbols

    value = parse_or()
    if position[0] != len(tokens):
        raise UnsupportedSource('trailing tokens in a directive')
    return value


def active_text(text, symbols=STRICT_SYMBOLS):
    """Drop directive lines and everything inside a disabled region.

    `strip_directives` removes the `#` lines and keeps the bodies, which is the
    reading a reader without conditional semantics is forced into. The compiler
    is not forced into it: with `VMPERF` undefined the region between `#if` and
    `#endif` is disabled text and contributes no token.
    """
    symbols = set(symbols)
    kept = []
    stack = []           # [parent active, any branch taken, this branch active]
    active = True
    for line in text.split('\n'):
        match = DIRECTIVE.match(line)
        if not match:
            if active:
                kept.append(line)
            continue
        name, argument = match.group(1).lower(), match.group(2).strip()
        if name == 'if':
            condition = active and preprocessor_value(argument, symbols)
            stack.append([active, bool(condition), bool(condition)])
            active = bool(condition)
        elif name == 'elif':
            if not stack:
                raise UnsupportedSource('#elif without #if')
            parent, taken, _ = stack[-1]
            if taken:
                stack[-1][2] = False
            else:
                condition = parent and preprocessor_value(argument, symbols)
                stack[-1][1] = bool(condition)
                stack[-1][2] = bool(condition)
            active = stack[-1][2]
        elif name == 'else':
            if not stack:
                raise UnsupportedSource('#else without #if')
            parent, taken, _ = stack[-1]
            stack[-1][2] = parent and not taken
            stack[-1][1] = True
            active = stack[-1][2]
        elif name == 'endif':
            if not stack:
                raise UnsupportedSource('#endif without #if')
            active = stack.pop()[0]
        elif name == 'define':
            if active and argument:
                symbols.add(argument.split()[0])
        elif name == 'undef':
            if active and argument:
                symbols.discard(argument.split()[0])
        # every other directive contributes no text
    if stack:
        raise UnsupportedSource('unterminated #if region')
    return '\n'.join(kept)


def block(text, header):
    """Return the normalized body of the unique complete method `header`.

    The scan starts at the first `{` after the header and stops at the brace
    that closes it; a literal is one opaque piece, so a brace inside a string is
    never counted.
    """
    if text.count(header) != 1:
        raise UnsupportedSource('missing/ambiguous complete method: ' + header)
    tail = text[text.index(header) + len(header):]
    seen = []
    depth = 0
    started = False
    for kind, value in pieces(tail):
        if not started:
            if value != '{':
                raise UnsupportedSource('expected complete method block: ' + header)
            started = True
        seen.append(value)
        if kind == 'operator':
            if value == '{':
                depth += 1
            elif value == '}':
                depth -= 1
                if depth == 0:
                    return ''.join(seen)
    raise UnsupportedSource('unterminated method body: ' + header)


def positions(text, anchors):
    """Return {name: index} for each anchor, computed on the normalized text."""
    joined = normalize(text)
    found = {}
    for name, anchor in anchors:
        spot = joined.find(anchor)
        if spot < 0:
            raise UnsupportedSource('missing anchor: ' + anchor)
        if joined.count(anchor) != 1:
            raise UnsupportedSource('ambiguous anchor: ' + anchor)
        found[name] = spot
    return found


def order(text, anchors):
    """Return the anchor names sorted by where they sit in the normalized text."""
    found = positions(text, anchors)
    return [name for name, _ in sorted(found.items(), key=lambda pair: pair[1])]


# ---------------------------------------------------------------------------
# the front end: what the lane modules declare, loaded and executed
# ---------------------------------------------------------------------------

# Every canonical module binds its token reader with this one line. What the
# census reads is the declaration, not the algorithm: seven modules naming one
# reader is the property that has to hold, and the algorithm itself is measured
# against the compiler rather than read out of a string here.
READER_PATTERN = re.compile(
    r'^from\s+([A-Za-z_][A-Za-z_0-9]*)\s+import\s+([A-Za-z_][A-Za-z_0-9]*)\s+as\s+TOKEN\s*$',
    re.M)

# A module that binds `TOKEN` to anything else keeps a private table, and the
# faces in this module do not measure it.
TABLE_ASSIGNMENT = 'TOKEN'


class SharedReader:
    """The tokenizer the lane modules name, loaded and run as they run it.

    Reading the declaration is a census: a lane that stops sharing the reader is
    a different front end and the gate says so. Executing the declared reader is
    what keeps the faces below a measurement — a second implementation here
    would be a second opinion, and the compiler is the one that has to disagree
    with the front end, not this module.
    """

    def __init__(self, declaration, path, symbol, module, modules):
        self.declaration = declaration
        self.path = path
        self.module = os.path.splitext(os.path.basename(path))[0]
        self.symbol = symbol
        self.modules = modules
        self._reader = getattr(module, symbol)
        with open(path, 'rb') as handle:
            self.sha256 = hashlib.sha256(handle.read()).hexdigest()

    def tokens(self, text):
        """The reader's token sequence, comments and whitespace dropped.

        A reader that refuses a fragment is a refusal here too, not a crash:
        the faces below distinguish "both readers refuse this" from "one of
        them does", so the refusal has to arrive as this module's own type.
        """
        out = []
        position = 0
        while position < len(text):
            try:
                token = self._reader.match(text, position)
            except ValueError as error:
                raise UnsupportedSource('front end refused at %d: %s' % (position, error))
            if token is None:
                raise UnsupportedSource('shared reader stalled at %d' % position)
            position = token.end()
            value = token.group()
            if value.isspace() or value.startswith(('//', '/*')):
                continue
            out.append(value)
        return out

    def join(self, text):
        """The characters the lanes keep for one fragment already directive-read."""
        return ''.join(self.tokens(text))

    def describe(self):
        return {'declaration': self.declaration,
                'readerModule': self.module,
                'readerSymbol': self.symbol,
                'readerSha256': self.sha256}


def declared_readers(directory):
    """Return {module: (reader module, symbol, declaration line)}."""
    found = {}
    for name in sorted(os.listdir(directory)):
        if not name.endswith('.py'):
            continue
        with open(os.path.join(directory, name), encoding='utf-8') as handle:
            text = handle.read()
        match = READER_PATTERN.search(text)
        if match is not None:
            found[name] = (match.group(1), match.group(2), match.group(0))
    return found


def _load_module_file(path, name):
    """Execute a module from a path, without touching the import search path."""
    specification = importlib.util.spec_from_file_location(name, path)
    if specification is None or specification.loader is None:
        raise UnsupportedSource('cannot load module file: ' + path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def canonical_reader(directory):
    """Return the shared reader, or raise when there is not one.

    Raises on three different faults, because they are three different facts: a
    canonical module that declares nothing, a set of modules that declare
    different readers, and a declared reader that cannot be loaded or does not
    answer `match()`. None of them may be reported as a correspondence.
    """
    found = declared_readers(directory)
    missing = [name for name in CANONICAL_MODULES if name not in found]
    if missing:
        raise UnsupportedSource('missing canonical reader module(s): ' + ', '.join(missing))
    declarations = {found[name][2] for name in CANONICAL_MODULES}
    if len(declarations) != 1:
        raise UnsupportedSource('canonical reader is not shared: %d distinct'
                                % len(declarations))
    source, symbol, declaration = found[CANONICAL_MODULES[0]]
    path = os.path.join(directory, source + '.py')
    if not os.path.isfile(path):
        raise UnsupportedSource('declared reader module is missing: ' + source)
    module = _load_module_file(path, 'frontend_declared_' + source)
    reader = getattr(module, symbol, None)
    if reader is None or not callable(getattr(reader, 'match', None)):
        raise UnsupportedSource('%s.%s is not a reader with match()' % (source, symbol))
    return SharedReader(declaration, path, symbol, module, list(CANONICAL_MODULES))


def private_tables(directory):
    """Modules that still bind `TOKEN` to a table of their own, named not merged.

    Their lanes read a narrower character set, so they are not part of the
    canonical front end and these faces do not cover them. Naming them is the
    difference between a scope limit and a silent gap.
    """
    names = []
    for name in sorted(os.listdir(directory)):
        if not name.endswith('.py') or name in CANONICAL_MODULES:
            continue
        with open(os.path.join(directory, name), encoding='utf-8') as handle:
            try:
                tree = ast.parse(handle.read())
            except SyntaxError:
                continue
        for node in tree.body:
            if not isinstance(node, ast.Assign):
                continue
            if any(isinstance(target, ast.Name) and target.id == TABLE_ASSIGNMENT
                   for target in node.targets):
                names.append(name)
                break
    return names


# ---------------------------------------------------------------------------
# naming complete methods without the shared reader
# ---------------------------------------------------------------------------

# Type punctuation a declaration may carry between the return type and the
# parameter list.
LEAD = frozenset(['.', ',', '<', '>', '[', ']', '?'])

# Tokens that prove the walk back out of a parameter list is inside an
# expression rather than at a declaration: an object initializer
# (`new Struct() {`), an assignment, a `return`.
STOP = frozenset(['=', '=>', 'return', 'new', 'await', 'in', 'is'])

# Tokens that end the declaration instead: the previous member's closing brace,
# a field terminated by `;`, or the enclosing type's opening brace. These are
# where a declaration legitimately starts.
BOUNDARY = frozenset(['{', '}', ';'])


def headers(text):
    """Return the verbatim declaration headers of every complete method.

    A `)` whose next token is `{` closes a parameter list only if the walk back
    reaches a method name and a return type without crossing anything that
    starts an expression. That excludes object initializers, lambdas,
    `if`/`foreach`/`catch` headers and `return` statements, which share the
    `(` `)` `{` shape.
    """
    tokens = spans(text)
    values = [value for _, value, _, _ in tokens]
    kinds = [kind for kind, _, _, _ in tokens]
    out = []
    for index in range(len(values) - 1):
        if values[index] != ')' or values[index + 1] != '{':
            continue
        depth = 0
        cursor = index
        while cursor >= 0:
            if values[cursor] == ')':
                depth += 1
            elif values[cursor] == '(':
                depth -= 1
                if depth == 0:
                    break
            cursor -= 1
        if cursor <= 0 or kinds[cursor - 1] != 'word':
            continue
        start = cursor - 1
        rejected = False
        while start - 1 >= 0:
            previous = values[start - 1]
            if previous in STOP:
                rejected = True
                break
            if previous in BOUNDARY:
                break
            if kinds[start - 1] == 'word' or previous in LEAD:
                start -= 1
                continue
            break
        if rejected or start == 0:
            continue
        # A single word before the `(` is a keyword header, not a declaration
        # with a return type.
        if kinds[start] != 'word' or start == cursor - 1:
            continue
        out.append(text[tokens[start][2]:tokens[index][3]])
    return out


# ---------------------------------------------------------------------------
# the census and the self-test
# ---------------------------------------------------------------------------

def census(texts):
    """Count how often each operator and single character is actually spelled."""
    counts = {operator: 0 for operator in OPERATORS}
    for char in sorted(SINGLE):
        counts[char] = 0
    for text in texts:
        for kind, value in pieces(text):
            if kind == 'operator' and value in counts:
                counts[value] += 1
    return counts


# (source, header, label, discriminates). `discriminates` says whether a reader
# that ignores literals and comments would slice a different body, so the
# self-test only demands a catch where a catch is possible.
SYNTHETIC = (
    ('void F(){S("}");T();}', 'void F()', 'literal closes early', True),
    ('void G(){S("{");T();}', 'void G()', 'literal opens early', True),
    ('void H(){/* } */T();}', 'void H()', 'block comment brace', True),
    ('void I(){// }\nT();}', 'void I()', 'line comment brace', True),
    ('void K(){S("a\\"b}");T();}', 'void K()', 'escaped quote', True),
    ("void L(){C('}');T();}", 'void L()', 'char literal brace', True),
    ('void J(){if(x){y();}else{z();}}', 'void J()', 'nested depth', False),
)


def _blind_block(text, header):
    """A deliberately literal-blind, comment-blind body reader."""
    if text.count(header) != 1:
        raise UnsupportedSource('missing/ambiguous complete method: ' + header)
    tail = text[text.index(header) + len(header):]
    if not tail:
        raise UnsupportedSource('no body')
    depth = 0
    started = False
    seen = []
    while tail:
        piece = tail[0]
        tail = tail[1:]
        if not started:
            if piece != '{':
                continue
            started = True
        seen.append(piece)
        if piece == '{':
            depth += 1
        elif piece == '}':
            depth -= 1
            if depth == 0:
                return ''.join(seen)
    raise UnsupportedSource('unterminated body')


def self_test():
    """Return [(label, ok)] for the checks that keep this harness honest.

    Every snippet is read by the independent reader, which must agree with the
    shared reader, and by a blind reader, which must disagree wherever a blind
    reader can. Both facts are needed: agreement alone could mean the snippet is
    trivial.
    """
    rows = []
    for source, header, label, discriminates in SYNTHETIC:
        try:
            mine = block(source, header)
        except UnsupportedSource as error:
            rows.append(('independent reads ' + label, False, str(error)))
            continue
        rows.append(('independent reads ' + label, True, mine))
        if not discriminates:
            continue
        try:
            blind = _blind_block(source, header)
        except UnsupportedSource:
            blind = None
        rows.append(('blind reader differs on ' + label, blind != mine, blind))
    return rows


# ---------------------------------------------------------------------------
# the corpus and the receipt
# ---------------------------------------------------------------------------

def collect(directories):
    """Return ({sha: (names, text)}, {name: {sha}}, sorted mirror labels).

    The same pinned file appears in several lanes' source directories; identical
    bytes collapse. A name carrying two byte sequences is a pin inconsistency
    and is reported rather than silently chosen between.
    """
    by_sha = {}
    names = {}
    mirrors = set()
    for directory in directories:
        normalised = os.path.normpath(directory)
        # Two levels, because every lane writes its mirrors into a directory
        # called `source`; the basename alone collapses them all into one.
        label = os.path.join(os.path.basename(os.path.dirname(normalised)),
                             os.path.basename(normalised))
        if not os.path.isdir(directory):
            continue
        seen_here = False
        for name in sorted(os.listdir(directory)):
            if not name.endswith('.cs'):
                continue
            seen_here = True
            with open(os.path.join(directory, name), 'rb') as handle:
                raw = handle.read()
            digest = hashlib.sha256(raw).hexdigest()
            if digest not in by_sha:
                by_sha[digest] = (set(), raw.decode('utf-8'))
            by_sha[digest][0].add(name)
            names.setdefault(name, set()).add(digest)
        if seen_here:
            mirrors.add(label)
    return by_sha, names, sorted(mirrors)


def compare(by_sha, front):
    """Run every face and return (stats, problems)."""
    stats = {'files': 0, 'normalize': 0, 'normalizeMismatch': 0,
             'tokens': 0, 'tokenFiles': 0, 'tokenMismatch': 0,
             'methods': 0, 'bodyMismatch': 0, 'ambiguousSkipped': 0,
             'unreadable': 0}
    problems = []
    for digest, (names, raw) in sorted(by_sha.items()):
        short = sorted(names)[0]
        stats['files'] += 1
        text = active_text(raw)
        try:
            if normalize(text) != front.join(text):
                stats['normalizeMismatch'] += 1
                problems.append([short, 'normalize'])
            stats['normalize'] += 1
        except UnsupportedSource as error:
            stats['unreadable'] += 1
            problems.append([short, 'normalize', str(error)])
            continue
        try:
            mine = [value for _, value in pieces(text)]
            theirs = front.tokens(text)
        except UnsupportedSource as error:
            stats['unreadable'] += 1
            problems.append([short, 'tokens', str(error)])
            continue
        stats['tokens'] += len(theirs)
        stats['tokenFiles'] += 1
        if mine != theirs:
            stats['tokenMismatch'] += 1
            where = 0
            for where in range(min(len(mine), len(theirs))):
                if mine[where] != theirs[where]:
                    break
            problems.append([short, 'tokens', where, theirs[where:where + 3],
                             mine[where:where + 3]])
        try:
            found = headers(text)
        except UnsupportedSource as error:
            problems.append([short, 'headers', str(error)])
            continue
        for header in found:
            if text.count(header) != 1:
                stats['ambiguousSkipped'] += 1
                continue
            stats['methods'] += 1
            label = ' '.join(header.split())[:60]
            try:
                # The front end stops at the first depth-zero brace of its own
                # token stream, so the slice is taken by a second walk rather
                # than by a guess.
                theirs = _shared_body(front, text, header)
            except UnsupportedSource as error:
                problems.append([short, 'shared-body', label, str(error)])
                continue
            try:
                mine = block(text, header)
            except UnsupportedSource as error:
                problems.append([short, 'ind-body', label, str(error)])
                continue
            if mine != theirs:
                stats['bodyMismatch'] += 1
                problems.append([short, 'body', label])
    return stats, problems


def _shared_body(front, text, header):
    """Slice a body with the front end's rules, written out here.

    The lane modules expose `body()` only as a private detail of their own
    projection, so the correspondence check re-applies the same two rules — the
    reader, then a depth count over its tokens — from the reader itself.
    """
    if text.count(header) != 1:
        raise UnsupportedSource('missing/ambiguous complete method: ' + header)
    tail = text[text.index(header) + len(header):]
    seen = []
    depth = 0
    for token in front.tokens(tail):
        if not seen and token != '{':
            raise UnsupportedSource('expected complete method block: ' + header)
        seen.append(token)
        depth += int(token == '{') - int(token == '}')
        if depth == 0:
            return ''.join(seen)
    raise UnsupportedSource('unterminated method body: ' + header)


ANCHOR_MINIMUM_LENGTH = 10

# The functions of a lane module that are plumbing rather than projection: they
# pin a URL, check a hash, look up a name, or slice a body. The strings inside
# them are not needles the field-projection code reads a value with, so the
# needle face skips them. The set is named here and reported in the receipt, and
# a unit test refuses it if a name stops existing — a rename must not quietly
# widen the filter.
NEEDLE_PLUMBING = ('body', 'canonical', 'download_pinned', 'mirror_source',
                   'normalize', 'require', 'sha', 'source_url')


def _lane_modules(directory):
    """The lane modules that exist on disk, and their parsed trees."""
    out = []
    for name in list(CANONICAL_MODULES) + list(VARIANT_MODULES):
        path = os.path.join(directory, name)
        if not os.path.isfile(path):
            continue
        with open(path, encoding='utf-8') as handle:
            out.append((name, ast.parse(handle.read())))
    return out


def declared_fragments(directory):
    """Return the long string constants the lane modules declare.

    The modules are parsed, never imported: importing one can start a download,
    and this face is about the text the lanes name, not about running them.
    A constant qualifies when it is at least `ANCHOR_MINIMUM_LENGTH` characters,
    which is a superset of the anchors the lanes use — error messages and names
    are in there too, and that is fine, because the question is only whether the
    two readers read the same fragment the same way.
    """
    fragments = set()
    read = []
    for name, tree in _lane_modules(directory):
        read.append(name)
        for node in ast.walk(tree):
            if (isinstance(node, ast.Constant) and isinstance(node.value, str)
                    and len(node.value) >= ANCHOR_MINIMUM_LENGTH):
                fragments.add(node.value)
    return fragments, read


def needle_literals(directory):
    """Return every non-empty string constant the projection code reads with.

    The anchor face stops at `ANCHOR_MINIMUM_LENGTH`, and that threshold is a
    real hole: a field is read as `if needle in text` or `text.count(needle) ==
    1`, and the needle is often shorter than ten characters — `if(verify)`,
    `returnnull;`, `_=x`. Those needles decide which region of which file a lane
    believes it is looking at, so a front end that split one of them differently
    would move the lane without moving any anchor.

    This face closes that hole by taking the literals out of the functions that
    do the reading, with no length floor at all. Only function bodies are read,
    and only the ones that are projection rather than plumbing; both facts are
    reported, because a filter that is not named cannot be reviewed.
    """
    fragments = set()
    read = []
    for name, tree in _lane_modules(directory):
        read.append(name)
        for node in tree.body:
            if not isinstance(node, ast.FunctionDef):
                continue
            if node.name in NEEDLE_PLUMBING:
                continue
            for child in ast.walk(node):
                if (isinstance(child, ast.Constant) and isinstance(child.value, str)
                        and child.value):
                    fragments.add(child.value)
    return fragments, read


def fragments_face(front, by_sha, fragments, modules, label, reader=None):
    """Read the same fragment with both readers and compare the two answers.

    Three questions per fragment, in order: do both readers accept it, do they
    produce the same text, and — when `reader` is given — does the fragment
    occur the same number of times in the two versions of each corpus file? The
    third question is the one a short needle needs: two readers can agree on the
    extracted text of a needle and still disagree about how many times the corpus
    contains it.
    """
    joined = {digest: front.join(active_text(text))
              for digest, (file_names, text) in by_sha.items()}
    theirs_text = {}
    if reader is not None:
        for digest, (file_names, text) in by_sha.items():
            try:
                theirs_text[digest] = reader(active_text(text))
            except UnsupportedSource:
                continue
    stats = {'modules': modules, 'candidates': len(fragments), 'readable': 0,
             'refusedByBoth': 0, 'divergentAcceptance': 0, 'joinMismatch': 0,
             'countMismatch': 0, 'located': 0, 'uniquelyLocated': 0}
    problems = []
    for fragment in sorted(fragments):
        try:
            mine = normalize(fragment)
            mine_ok = True
        except UnsupportedSource:
            mine, mine_ok = None, False
        try:
            theirs = front.join(fragment)
            theirs_ok = True
        except UnsupportedSource:
            theirs, theirs_ok = None, False
        if not mine_ok and not theirs_ok:
            stats['refusedByBoth'] += 1
            continue
        if mine_ok != theirs_ok:
            stats['divergentAcceptance'] += 1
            problems.append([label, 'acceptance', fragment[:60],
                             'independent ' + str(mine_ok), 'shared ' + str(theirs_ok)])
            continue
        stats['readable'] += 1
        if mine != theirs:
            stats['joinMismatch'] += 1
            problems.append([label, 'join', fragment[:60], theirs[:40], mine[:40]])
            continue
        if not mine:
            continue
        hits = [digest for digest, text in joined.items() if mine in text]
        if hits:
            stats['located'] += 1
            if any(joined[digest].count(mine) == 1 for digest in hits):
                stats['uniquelyLocated'] += 1
            for digest in hits:
                if digest not in theirs_text:
                    continue
                if joined[digest].count(mine) != theirs_text[digest].count(mine):
                    stats['countMismatch'] += 1
                    problems.append([label, 'count', fragment[:60], digest[:12]])
                    break
    return stats, problems


def anchor_face(front, directory, by_sha, reader=None):
    """The long declared constants, read both ways."""
    fragments, read = declared_fragments(directory)
    return fragments_face(front, by_sha, fragments, read, 'anchor', reader)


def needle_face(front, directory, by_sha, reader=None):
    """The short literals the projection code reads a field with, read both ways.

    The counts carried alongside the comparison are the ones that make the hole
    this face closes visible: how many of the needles the anchor face could not
    see, and which plumbing functions were left out on purpose.
    """
    fragments, read = needle_literals(directory)
    stats, problems = fragments_face(front, by_sha, fragments, read, 'needle', reader)
    stats['shortOfAnchorThreshold'] = sum(
        1 for fragment in fragments if len(fragment) < ANCHOR_MINIMUM_LENGTH)
    stats['plumbingSkipped'] = list(NEEDLE_PLUMBING)
    return stats, problems


def sliced_files(directory):
    """Which pinned file does each lane take a whole method body out of?

    Read statically, because importing a lane can start a download. Only a
    module that calls `body(text, header)` tokenizes; a module that checks
    `text.count(needle) == 1` reads raw bytes and cannot be moved by a change to
    the tokenizer at all. The distinction matters here, because one of the three
    lanes that pin `EvaluationStack.cs` is a needle reader.

    Modules with no body slicer are named rather than counted as checked, so an
    empty result cannot be mistaken for a silent skip.

    Returns ({basename: [module, ...]}, [module, ...] without a body slicer).
    """
    sliced, plain = {}, []
    for name in list(CANONICAL_MODULES) + list(VARIANT_MODULES):
        path = os.path.join(directory, name)
        try:
            with open(path, encoding='utf-8') as handle:
                tree = ast.parse(handle.read())
        except (OSError, SyntaxError):
            plain.append(name)
            continue
        sources = _constant_dict(tree, 'SOURCES')
        signatures = _constant_dict(tree, 'SIGNATURES')
        slices = any(isinstance(node, ast.FunctionDef) and node.name == 'body'
                     for node in tree.body)
        if sources is None or signatures is None or not slices:
            plain.append(name)
            continue
        keys = set()
        for value in signatures.values():
            if isinstance(value, (tuple, list)) and value and isinstance(value[0], str):
                keys.add(value[0])
        for key in sorted(keys):
            row = sources.get(key)
            if not isinstance(row, dict):
                continue
            relative = row.get('relativePath')
            if isinstance(relative, str):
                sliced.setdefault(os.path.basename(relative), []).append(name)
    return sliced, plain


def _constant_dict(tree, name):
    """Return {key: value} for a module-level dict literal, or None."""
    for node in tree.body:
        if not (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id == name):
            continue
        if not isinstance(node.value, ast.Dict):
            return None
        out = {}
        for key, value in zip(node.value.keys, node.value.values):
            if not (isinstance(key, ast.Constant) and isinstance(key.value, str)):
                continue
            if isinstance(value, ast.Dict):
                inner = {}
                for k, v in zip(value.keys, value.values):
                    if isinstance(k, ast.Constant) and isinstance(v, ast.Constant):
                        inner[k.value] = v.value
                out[key.value] = inner
            elif isinstance(value, ast.Call) and isinstance(value.func, ast.Name) \
                    and value.func.id == 'dict':
                inner = {kw.arg: kw.value.value for kw in value.keywords
                         if kw.arg and isinstance(kw.value, ast.Constant)}
                out[key.value] = inner
            elif isinstance(value, ast.Tuple):
                out[key.value] = tuple(item.value for item in value.elts
                                       if isinstance(item, ast.Constant))
        return out
    return None


LEXER_FACE_NAME = 'lexer'



def lexer_face(by_sha, directory, dump_path, front):
    """Compare the front end against the C# lexer itself.

    A third reader, and the only one that is not ours: Microsoft's Roslyn, asked
    for its token stream with trivia removed. Two things are measured, and they
    are different questions.

    whole files: does the front end join the same characters the lexer joins?
    It need not, because no lane reads a whole file. Where it does not, the
    receipt records the file, the offset and the length difference.

    Anchors: does every fragment a lane locates survive the lexer's view? This
    one is not negotiable. An anchor the front end finds and the compiler's
    lexer does not is an anchor the lane would apply to text the compiler never
    saw, or to text it re-joined differently, and either way the fields read
    after it come from the wrong place.
    """
    if dump_path is None or not os.path.isfile(dump_path):
        return {'available': False}, []
    with open(dump_path, encoding='utf-8') as handle:
        rows = json.load(handle)
    lexed = {}
    for row in rows:
        # A file name may appear in several lanes' mirrors; identical bytes
        # collapse, so the first spool wins and duplicates must agree.
        name = row['file']
        if name in lexed and lexed[name] != row['joined']:
            raise UnsupportedSource('lexer disagreeing with itself on ' + name)
        lexed[name] = row['joined']

    joined = {}
    names_by_digest = {}
    for digest, (file_names, text) in by_sha.items():
        joined[digest] = front.join(active_text(text))
        names_by_digest[digest] = sorted(file_names)

    stats = {'available': True, 'filesLexed': len(lexed), 'filesCompared': 0,
             'filesIdentical': 0, 'fileDivergences': [],
             'anchorsChecked': 0, 'anchorDivergences': 0}
    problems = []
    for digest in sorted(joined):
        candidates = [name for name in names_by_digest[digest] if name in lexed]
        if not candidates:
            continue
        theirs = lexed[candidates[0]]
        stats['filesCompared'] += 1
        mine = joined[digest]
        if mine == theirs:
            stats['filesIdentical'] += 1
            continue
        offset = next((index for index in range(min(len(mine), len(theirs)))
                       if mine[index] != theirs[index]), min(len(mine), len(theirs)))
        stats['fileDivergences'].append({
            'file': candidates[0], 'offset': offset,
            'frontEndLength': len(mine), 'lexerLength': len(theirs),
        })

    fragments, _ = declared_fragments(directory)
    for fragment in sorted(fragments):
        try:
            anchor = normalize(fragment)
        except UnsupportedSource:
            continue
        if not anchor:
            continue
        for digest in sorted(joined):
            mine = joined[digest]
            count = mine.count(anchor)
            if not count:
                continue
            stats['anchorsChecked'] += 1
            candidates = [name for name in names_by_digest[digest] if name in lexed]
            if not candidates:
                break
            if lexed[candidates[0]].count(anchor) != count:
                stats['anchorDivergences'] += 1
                problems.append(['lexer', 'anchor', candidates[0], anchor[:60],
                                 'front end %d, lexer %d'
                                 % (count, lexed[candidates[0]].count(anchor))])
            break
    return stats, problems


STRICT_FACE_NAME = 'strict'

# Two defects this front end used to have, kept in executable form. Each is the
# fragment that reproduced it; what the receipt records is that the front end and
# the confirmed reader now read it the same way. A reproducer that stops
# agreeing is a regression, and the gate says so.
REPRODUCERS = (
    ('interpolation-hole', '$"[{string.Join(", ", items)}]"'),
    ('disabled-region', '#if VMPERF\nHidden();\n#endif\nVisible();'),
)


def reproducers(front):
    """Read each historical defect with both readers and record the answer."""
    rows = []
    for name, source in REPRODUCERS:
        try:
            front_join = front.join(active_text(source, STRICT_SYMBOLS))
        except UnsupportedSource as error:
            front_join = 'refused: %s' % error
        try:
            confirmed_join = strict_normalize(active_text(source, STRICT_SYMBOLS))
        except UnsupportedSource as error:
            confirmed_join = 'refused: %s' % error
        rows.append({'name': name, 'source': source,
                     'frontEndJoin': front_join, 'confirmedJoin': confirmed_join,
                     'agrees': front_join == confirmed_join})
    return rows


def _lexed_rows(dump_path):
    """Read the lexer dump into {file: joined}, refusing a self-contradiction."""
    with open(dump_path, encoding='utf-8') as handle:
        rows = json.load(handle)
    lexed = {}
    for row in rows:
        name = row['file']
        if name in lexed and lexed[name] != row['joined']:
            raise UnsupportedSource('lexer disagreeing with itself on ' + name)
        lexed[name] = row['joined']
    return lexed


def _cause(raw, lexer):
    """Name what explains one file's divergence, by trial.

    One rule is still separately switchable: whether a directive is evaluated or
    merely dropped. If the dropped reading reproduces the lexer while the
    evaluated one does not, the divergence is about conditionals.

    Anything else is `unclassified`, and that is the honest answer now. The
    string rules used to be the other candidate, and they are not one any more:
    the front end reads an interpolation hole and a verbatim literal the way the
    compiler does, so a classifier that could still blame them would be naming a
    remedy that no longer exists.
    """
    dropped = normalize(strip_directives(raw))
    evaluated = normalize(active_text(raw, STRICT_SYMBOLS))
    # Both halves are needed. A file with no conditional compiles the same either
    # way, so "the dropped reading matches the lexer" alone is evidence of
    # nothing; the two readings have to disagree before the directive rule can
    # be the explanation.
    if dropped == lexer and evaluated != dropped:
        return 'disabled-region'
    return 'unclassified'


def strict_face(by_sha, directory, dump_path, front, front_end_divergences=()):
    """Compare the front end with a reader the compiler has confirmed.

    `lexer_face` asks whether the front end joins what the lexer joins and lets
    it differ on whole files. This asks the prior question: is there a reader
    here that joins what the lexer joins on every file? Once there is, its
    disagreement with the front end stops being an opinion — it is a defect with
    an offset, a length and a reproducing fragment.

    The two questions are kept apart on purpose. A run where the front end
    differs on two files and the strict reader differs on none says something
    the reverse arrangement cannot say.

    `front_end_divergences` is the lexer face's list. Each row is enriched here
    with what the divergence costs: the cause, tried on rather than guessed, the
    length the correct reading gives, and whether any anchor a lane names lands
    in a different number of places because of it.
    """
    if dump_path is None or not os.path.isfile(dump_path):
        return {'available': False}, []
    lexed = _lexed_rows(dump_path)

    stats = {'available': True, 'symbols': list(STRICT_SYMBOLS),
             'filesCompared': 0, 'filesIdentical': 0, 'fileDivergences': [],
             'anchorsChecked': 0, 'anchorDivergences': 0,
             'reproducers': reproducers(front)}
    problems = []
    strict_join = {}
    names_by_digest = {}
    for digest, (file_names, text) in sorted(by_sha.items()):
        names_by_digest[digest] = sorted(file_names)
        strict_join[digest] = strict_normalize(active_text(text, STRICT_SYMBOLS))

    for digest in sorted(strict_join):
        candidates = [name for name in names_by_digest[digest] if name in lexed]
        if not candidates:
            continue
        theirs = lexed[candidates[0]]
        stats['filesCompared'] += 1
        mine = strict_join[digest]
        if mine == theirs:
            stats['filesIdentical'] += 1
            continue
        offset = next((index for index in range(min(len(mine), len(theirs)))
                       if mine[index] != theirs[index]), min(len(mine), len(theirs)))
        raw = by_sha[digest][1]
        row = {'file': candidates[0], 'offset': offset,
               'strictLength': len(mine), 'lexerLength': len(theirs),
               'cause': _cause(raw, theirs)}
        stats['fileDivergences'].append(row)
        problems.append(['strict', 'file', candidates[0], offset, row['cause']])

    # What each recorded front-end defect costs. `anchorsAffected` is the only
    # number here that a lane can feel: an anchor that occurs a different number
    # of times is an anchor whose fields come from another place.
    gaps = []
    for row in front_end_divergences:
        digest = next((key for key in names_by_digest
                       if row['file'] in names_by_digest[key]), None)
        if digest is None:
            continue
        raw = by_sha[digest][1]
        theirs = lexed[row['file']]
        gaps.append({
            'file': row['file'],
            'offset': row['offset'],
            'frontEndLength': row['frontEndLength'],
            'lexerLength': row['lexerLength'],
            'strictLength': len(strict_join[digest]),
            'strictAgreesWithLexer': strict_join[digest] == theirs,
            'cause': _cause(raw, theirs),
        })
    sliced, unreadable = sliced_files(directory)
    for row in gaps:
        row['slicedBy'] = sorted(set(sliced.get(row['file'], [])))
    stats['knownGaps'] = gaps
    stats['slicedGaps'] = [row['file'] for row in gaps if row['slicedBy']]
    stats['lanesWithoutBodySlicer'] = unreadable

    fragments, _ = declared_fragments(directory)
    stats['anchorsAffected'] = 0
    stats['anchorsAffectedUnique'] = 0
    stats['affectedAnchors'] = []
    front_join = {digest: front.join(active_text(by_sha[digest][1]))
                  for digest in strict_join}
    for fragment in sorted(fragments):
        try:
            strict_anchor = strict_normalize(active_text(fragment, STRICT_SYMBOLS))
            front_anchor = normalize(fragment)
        except UnsupportedSource:
            continue
        if not strict_anchor or not front_anchor:
            continue
        for digest in sorted(strict_join):
            if strict_join[digest].count(strict_anchor) == front_join[digest].count(front_anchor):
                continue
            stats['anchorsAffected'] += 1
            front_count = front_join[digest].count(front_anchor)
            strict_count = strict_join[digest].count(strict_anchor)
            # A fragment that is ambiguous on both sides locates nothing, so a
            # count change cannot move a location. One that is unique on either
            # side is a location, and a location that moved is not a footnote.
            if front_count == 1 or strict_count == 1:
                stats['anchorsAffectedUnique'] += 1
            if len(stats['affectedAnchors']) < 8:
                stats['affectedAnchors'].append({
                    'file': names_by_digest[digest][0],
                    'anchor': fragment[:60],
                    'frontEnd': front_count,
                    'strict': strict_count,
                })
    for fragment in sorted(fragments):
        try:
            anchor = strict_normalize(active_text(fragment, STRICT_SYMBOLS))
        except UnsupportedSource:
            continue
        if not anchor:
            continue
        for digest in sorted(strict_join):
            count = strict_join[digest].count(anchor)
            if not count:
                continue
            stats['anchorsChecked'] += 1
            candidates = [name for name in names_by_digest[digest] if name in lexed]
            if not candidates:
                break
            if lexed[candidates[0]].count(anchor) != count:
                stats['anchorDivergences'] += 1
                problems.append(['strict', 'anchor', candidates[0], anchor[:60]])
            break
    return stats, problems


def correspond(directory, roots, lexer_dump=None):
    """Build the correspondence receipt for one corpus.

    `directory` is the refinement source directory that holds the lane modules,
    so the front end is loaded from what those modules declare rather than
    copied here. `roots` is the explicit list of directories holding pinned C#,
    because a corpus that silently shrinks is worse than no corpus at all.
    """
    if not roots:
        raise UnsupportedSource('no corpus directories given')
    front = canonical_reader(directory)
    variants = private_tables(directory)
    by_sha, names, mirrors = collect(roots)
    if not by_sha:
        raise UnsupportedSource('empty correspondence corpus')
    stats, problems = compare(by_sha, front)

    texts = [active_text(text) for _, (_, text) in sorted(by_sha.items())]
    counts = census(texts)
    never = sorted(token for token, value in counts.items() if not value)
    rarest = sorted((value, token) for token, value in counts.items() if value)[:8]

    anchors, anchor_problems = anchor_face(front, directory, by_sha, normalize)
    needles, needle_problems = needle_face(front, directory, by_sha, normalize)
    lexed, lexer_problems = lexer_face(by_sha, directory, lexer_dump, front)
    stricted, strict_problems = strict_face(
        by_sha, directory, lexer_dump, front, lexed.get('fileDivergences', ()))
    problems = (problems + anchor_problems + needle_problems + lexer_problems
                + strict_problems)[:40]

    rows = self_test()
    failed = [label for label, ok, _ in rows if not ok]

    inconsistent = {name: sorted(digests) for name, digests in names.items()
                    if len(digests) > 1}

    receipt = {
        'schema': SCHEMA,
        'scope': SCOPE,
        'sharedReader': dict(front.describe(),
                             canonicalModules=front.modules,
                             privateTableModules=variants),
        'independentReader': {
            'sha256': _module_sha(),
        },
        'corpus': {
            'files': stats['files'],
            'names': sorted(names),
            'mirrors': mirrors,
            'tokens': stats['tokens'],
            # One digest over every (sha, names) pair, so the receipt binds the
            # bytes it read and not just how many of them there were.
            'digest': hashlib.sha256('\n'.join(
                digest + '  ' + ','.join(sorted(file_names))
                for digest, (file_names, _) in sorted(by_sha.items())).encode()).hexdigest(),
        },
        'faces': {
            'normalize': {'files': stats['normalize'],
                          'mismatch': stats['normalizeMismatch'],
                          'note': 'dropped-character set only'},
            'tokens': {'files': stats['tokenFiles'],
                       'tokens': stats['tokens'],
                       'mismatch': stats['tokenMismatch']},
            'bodies': {'methods': stats['methods'],
                       'mismatch': stats['bodyMismatch'],
                       'ambiguousSkipped': stats['ambiguousSkipped']},
            'anchors': anchors,
            'needles': needles,
            'lexer': lexed,
            'strict': {key: value for key, value in stricted.items()
                       if key not in ('knownGaps', 'affectedAnchors', 'slicedGaps',
                                      'lanesWithoutBodySlicer')},
        },
        # A defect recorded here is not a pass. It is a named disagreement with
        # the compiler, with a reproducer and a count of anchors that follow it,
        # so that the next run can say whether it grew, shrank or stayed.
        'knownGaps': {
            'files': sorted(row['file'] for row in stricted.get('knownGaps', [])),
            'rows': stricted.get('knownGaps', []),
            'anchorsAffected': stricted.get('anchorsAffected', 0),
            'anchorsAffectedUnique': stricted.get('anchorsAffectedUnique', 0),
            'slicedGaps': stricted.get('slicedGaps', []),
            'lanesWithoutBodySlicer': stricted.get('lanesWithoutBodySlicer', []),
            'affectedAnchors': stricted.get('affectedAnchors', []),
            'reproducers': stricted.get('reproducers', []),
            'note': 'front-end readings that differ from the C# lexer; empty is '
                    'the only acceptable value, and a closed one is deleted here '
                    'on purpose',
        },
        'selfTest': {'checks': len(rows), 'failed': failed},
        'tokenCensus': {
            'neverSpelled': never,
            'rarest': [[token, count] for count, token in rarest],
        },
        'pinConsistency': not inconsistent,
        'inconsistentNames': inconsistent,
        'problems': problems[:40],
    }
    receipt['receiptSha256'] = hashlib.sha256(
        json.dumps(receipt, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return receipt


def _module_sha():
    """The hash of this reader's own bytes, so a receipt names its reader."""
    with open(os.path.abspath(__file__), 'rb') as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def agrees(receipt, require_lexer=True):
    """True when every face matched and the harness caught its own mutants.

    `require_lexer` is on by default: a receipt with no C# lexer face has not
    been checked against the only reader that is not ours, so it does not
    count as agreement. A caller without dotnet has to say so explicitly.
    """
    faces = receipt['faces']
    return (receipt['schema'] == SCHEMA
            and receipt['pinConsistency']
            and receipt['corpus']['files'] > 0
            and faces['normalize']['mismatch'] == 0
            and faces['tokens']['mismatch'] == 0
            and faces['bodies']['mismatch'] == 0
            and faces['anchors']['divergentAcceptance'] == 0
            and faces['anchors']['joinMismatch'] == 0
            and faces['needles']['divergentAcceptance'] == 0
            and faces['needles']['joinMismatch'] == 0
            and faces['needles']['countMismatch'] == 0
            and (not require_lexer or (faces['lexer']['available']
                                       and faces['lexer']['anchorDivergences'] == 0
                                       and faces['strict']['available']
                                       and faces['strict']['anchorDivergences'] == 0
                                       and faces['strict']['filesIdentical']
                                       == faces['strict']['filesCompared']))
            and receipt['knownGaps']['anchorsAffectedUnique'] == 0
            and all(row['agrees'] for row in receipt['knownGaps']['reproducers'])
            and not receipt['selfTest']['failed']
            and not receipt['problems'])

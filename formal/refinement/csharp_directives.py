"""C# conditional compilation, as a reading rule rather than a line filter.

Two lanes read pinned C# and sliced method bodies out of it. Both used to strip
comment-like directive lines and keep whatever was underneath, which is the only
reading available to a reader that has no idea what `#if` means. The compiler is
not in that position: with `VMPERF` undefined, the lines between `#if VMPERF` and
`#endif` are disabled text and contribute no token at all.

This module is the reading the lanes now use. It is deliberately small, has one
dependency (`re`), and knows exactly three things: which lines are directives,
how to evaluate a directive condition, and which regions are therefore active.

The symbol set is a parameter with an empty default. Empty is the reading that
matches a lexer with nothing defined — which is what the C# lexer in
`export/` is given, and what `frontend_correspondence.active_text` assumes. It is
not a claim about how the upstream project is built; `#if VMPERF` guards a
tracing switch, and a build that defines it sees the other branch. Callers that
know better can pass the set, and the receipt of any lane that does should say
so.
"""

import re

DIRECTIVE = re.compile(r'^\s*#\s*([A-Za-z_]+)\s*(.*)$')
PREPROCESSOR = re.compile(r'\(|\)|!|&&|\|\||==|!=|[A-Za-z_][A-Za-z_0-9]*')


class DirectiveError(ValueError):
    """A directive this reader will not guess about."""


def preprocessor_value(expression, symbols=()):
    """Evaluate one `#if` expression. An undefined symbol is false.

    The grammar is the small one a directive allows: `!`, `&&`, `||`, `==`,
    `!=`, parentheses, `true`, `false` and identifiers. Anything else is refused
    rather than guessed, because a guess here silently enables or disables a
    region and changes what the lane reads.
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
                raise DirectiveError('unbalanced parenthesis in a directive')
            take()
            return value
        token = take()
        if token is None:
            raise DirectiveError('empty preprocessor expression')
        if token in ('true', 'false'):
            return token == 'true'
        if token in ('==', '!=', '&&', '||', ')'):
            raise DirectiveError('misplaced %r in a directive' % token)
        return token in symbols

    value = parse_or()
    if position[0] != len(tokens):
        raise DirectiveError('trailing tokens in a directive')
    return value


def active_text(text, symbols=()):
    """Drop directive lines and everything inside a disabled region."""
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
                raise DirectiveError('#elif without #if')
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
                raise DirectiveError('#else without #if')
            parent, taken, _ = stack[-1]
            stack[-1][2] = parent and not taken
            stack[-1][1] = True
            active = stack[-1][2]
        elif name == 'endif':
            if not stack:
                raise DirectiveError('#endif without #if')
            active = stack.pop()[0]
        elif name == 'define':
            if active and argument:
                symbols.add(argument.split()[0])
        elif name == 'undef':
            if active and argument:
                symbols.discard(argument.split()[0])
        # every other directive contributes no text
    if stack:
        raise DirectiveError('unterminated #if region')
    return '\n'.join(kept)


def strip_directives(text, symbols=()):
    """The name the lanes already call. Reads the conditions, keeps no body.

    Kept as an alias so a lane reads this module's rule without changing its
    call sites; the ambiguous name is the old one, the behaviour is the new.
    """
    return active_text(text, symbols)

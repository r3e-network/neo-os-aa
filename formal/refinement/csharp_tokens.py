"""The shared C# tokenizer, as a scanner instead of one regular expression.

Seven lanes used to carry the same `TOKEN = re.compile(...)` and slice method
bodies with it. A single regular expression cannot model an interpolated string,
because a hole is an expression and can contain quotes:

    return $"[{string.Join(", ", _innerList.Select(p => $"{p.Type}({p})"))}]";

C# lexes the quotes inside the hole as a nested literal. The regular expression
sees the first of them as the end of the outer literal, emits the separator `,`
as an operator, drops the content space as whitespace, and opens a new literal at
the next quote. The result is one character shorter than the source, and every
position after it is off by one.

This module is the same tokenization, written as a scanner, with the two rules a
regular expression cannot express:

    interpolation   `$"..."` is one token, holes transparent, `{{`/`}}` literal
    verbatim        `@"..."` escapes by doubling, backslash is a character

Everything else is deliberately identical to the expression it replaces —
whitespace, comments, plain strings, character literals, identifiers, digits, the
two-character operators in the same order, and the same single-character set. The
differential test compares the two token by token on the whole corpus, so "same
except the holes" is measured rather than asserted.

`Tokenizer.match(text, position)` is the only interface the lanes use, which is
why the call sites did not change. It returns a `Token` that answers the three
questions a `re.Match` answers — `group()`, `start()`, `end()` — so a lane that
was written against the expression keeps working unedited, and `None` at the end
of the text means what `re.Match` means by it.
"""

import re

WHITESPACE = frozenset(' \t\r\n\f\v')
LETTERS = frozenset('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_')
IDENTIFIER_PART = LETTERS | frozenset('0123456789')
DIGITS = frozenset('0123456789')
# Ordered longest-first, exactly as the expression listed them.
OPERATORS = ('==', '!=', '<=', '>=', '&&', '||', '++', '--', '=>', '??=')
SINGLE = frozenset('{}()[];,.!+-*/<>=?:@&|~^%')

LINE_COMMENT = '//'
BLOCK_COMMENT = '/*'


class UnsupportedToken(ValueError):
    """A character the tokenizer has no rule for. Never silently skipped."""


class Token:
    """One token, answering the questions a lane asks a `re.Match`.

    The lanes were written against `re.compile(...).match(text, position)`, so
    they call `group()` and `end()`. Those are methods here for the same reason
    they are methods there: an attribute called `end` and a method called `end`
    cannot both exist, and the call sites are the thing that must not change.
    """

    __slots__ = ('text', '_start', '_end')

    def __init__(self, text, start, end):
        self.text = text
        self._start = start
        self._end = end

    def group(self, number=0):
        if number != 0:
            raise IndexError('this tokenizer has one group, not %d' % (number + 1))
        return self.text

    def start(self, number=0):
        self.group(number)
        return self._start

    def end(self, number=0):
        self.group(number)
        return self._end

    def span(self):
        return self._start, self._end

    def __repr__(self):
        return 'Token(%r, %d, %d)' % (self.text, self._start, self._end)


def _end_of_plain(text, quote):
    index, length = quote + 1, len(text)
    while index < length:
        if text[index] == '\\':
            index += 2
            continue
        if text[index] == '"':
            return index + 1
        index += 1
    raise UnsupportedToken('unterminated string literal')


def _end_of_verbatim(text, quote):
    index, length = quote + 1, len(text)
    while index < length:
        if text[index] == '"':
            if index + 1 < length and text[index + 1] == '"':
                index += 2
                continue
            return index + 1
        index += 1
    raise UnsupportedToken('unterminated verbatim string literal')


def _end_of_char(text, quote):
    index, length = quote + 1, len(text)
    while index < length:
        if text[index] == '\\':
            index += 2
            continue
        if text[index] == "'":
            return index + 1
        index += 1
    raise UnsupportedToken('unterminated character literal')


def _end_of_interpolated(text, quote):
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
            index = _end_of_hole(text, index)
            continue
        index += 1
    raise UnsupportedToken('unterminated interpolated string literal')


def _end_of_hole(text, opening):
    index, length = opening + 1, len(text)
    depth = 0
    while index < length:
        char = text[index]
        if char == '"':
            index = _end_of_plain(text, index)
            continue
        if char == "'":
            index = _end_of_char(text, index)
            continue
        if char == '@' and index + 1 < length and text[index + 1] == '"':
            index = _end_of_verbatim(text, index + 1)
            continue
        if char == '$' and index + 1 < length and text[index + 1] == '"':
            index = _end_of_interpolated(text, index + 1)
            continue
        if char == '/' and index + 1 < length and text[index + 1] == '/':
            while index < length and text[index] != '\n':
                index += 1
            continue
        if char == '/' and index + 1 < length and text[index + 1] == '*':
            close = text.find('*/', index + 2)
            if close < 0:
                raise UnsupportedToken('unterminated block comment in a hole')
            index = close + 2
            continue
        if char == '{':
            depth += 1
        elif char == '}':
            if depth == 0:
                return index + 1
            depth -= 1
        index += 1
    raise UnsupportedToken('unterminated interpolation hole')


class Tokenizer:
    """Split C# text into the same tokens the shared expression produced."""

    def match(self, text, position=0):
        """Return the token starting at `position`, or None at end of text.

        None means end of text. A character with no rule raises, because a
        tokenizer that silently skips is a tokenizer whose output cannot be
        compared with anything.
        """
        if position >= len(text):
            return None
        char = text[position]
        if char in WHITESPACE:
            end = position + 1
            while end < len(text) and text[end] in WHITESPACE:
                end += 1
            return Token(text[position:end], position, end)
        if text.startswith(LINE_COMMENT, position):
            end = text.find('\n', position)
            if end < 0:
                end = len(text)
            return Token(text[position:end], position, end)
        if text.startswith(BLOCK_COMMENT, position):
            close = text.find('*/', position + 2)
            if close < 0:
                raise UnsupportedToken('unterminated block comment')
            return Token(text[position:close + 2], position, close + 2)
        if char == '$' and position + 1 < len(text) and text[position + 1] == '"':
            end = _end_of_interpolated(text, position + 1)
            return Token(text[position:end], position, end)
        if (char == '$' and position + 2 < len(text) and text[position + 1] == '@'
                and text[position + 2] == '"'):
            end = _end_of_verbatim(text, position + 2)
            return Token(text[position:end], position, end)
        if char == '"':
            end = _end_of_plain(text, position)
            return Token(text[position:end], position, end)
        if char == '@' and position + 1 < len(text) and text[position + 1] == '"':
            end = _end_of_verbatim(text, position + 1)
            return Token(text[position:end], position, end)
        if (char == '@' and position + 2 < len(text) and text[position + 1] == '$'
                and text[position + 2] == '"'):
            end = _end_of_interpolated(text, position + 2)
            return Token(text[position:end], position, end)
        if char == "'":
            end = _end_of_char(text, position)
            return Token(text[position:end], position, end)
        if char in DIGITS:
            end = position + 1
            while end < len(text) and text[end] in DIGITS:
                end += 1
            return Token(text[position:end], position, end)
        if char in LETTERS:
            end = position + 1
            while end < len(text) and text[end] in IDENTIFIER_PART:
                end += 1
            return Token(text[position:end], position, end)
        for operator in OPERATORS:
            if text.startswith(operator, position):
                return Token(operator, position, position + len(operator))
        if char in SINGLE:
            return Token(char, position, position + 1)
        raise UnsupportedToken('unsupported %r at %d' % (char, position))

    def finditer(self, text):
        position = 0
        while position < len(text):
            token = self.match(text, position)
            position = token.end()
            yield token

    def findall(self, text):
        return [token.text for token in self.finditer(text)]


TOKENIZER = Tokenizer()

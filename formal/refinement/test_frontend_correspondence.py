"""Tests for the front-end correspondence harness.

The harness exists to make the project's largest trust item measurable. These
tests therefore check two different things: that the independent reader behaves
as documented, and that the harness would actually notice if it stopped
agreeing with the shared table. A harness that always says zero is worse than
no harness, so the negative controls here matter as much as the positive ones.
"""

import ast
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import frontend_correspondence as fc


class ReaderTests(unittest.TestCase):
    def test_a_literal_hides_its_braces_from_the_body_scan(self):
        self.assertEqual('{S("}");T();}', fc.block('void F(){S("}");T();}', 'void F()'))
        self.assertEqual('{S("{");T();}', fc.block('void G(){S("{");T();}', 'void G()'))
        self.assertEqual("{C('}');T();}", fc.block("void L(){C('}');T();}", 'void L()'))

    def test_a_comment_hides_its_braces_too(self):
        self.assertEqual('{T();}', fc.block('void H(){/* } */T();}', 'void H()'))
        self.assertEqual('{T();}', fc.block('void I(){// }\nT();}', 'void I()'))

    def test_an_escaped_quote_does_not_end_the_literal(self):
        self.assertEqual('{S("a\\"b}");T();}',
                         fc.block('void K(){S("a\\"b}");T();}', 'void K()'))

    def test_an_interpolated_string_is_one_literal(self):
        # The shared table and this reader agree on `$"..."`; a bare `$` with no
        # quote after it is the case neither can read.
        self.assertEqual([('literal', '$"a"')], fc.pieces('$"a"'))
        with self.assertRaises(fc.UnsupportedSource):
            fc.pieces('$x')

    def test_an_empty_character_literal_is_refused_like_the_shared_table(self):
        # The shared table matches exactly one character between the quotes.
        with self.assertRaises(fc.UnsupportedSource):
            fc.pieces("''")

    def test_an_unterminated_literal_is_refused(self):
        with self.assertRaises(fc.UnsupportedSource):
            fc.pieces('"abc')
        with self.assertRaises(fc.UnsupportedSource):
            fc.pieces("'a")

    def test_an_unknown_character_is_refused_rather_than_dropped(self):
        with self.assertRaises(fc.UnsupportedSource):
            fc.pieces('a # b')
        with self.assertRaises(fc.UnsupportedSource):
            fc.pieces('a ` b')

    def test_normalize_is_blind_to_where_the_boundaries_are(self):
        # This is the documented weakness of the normalize face: joining is
        # concatenation, so a split operator normalizes alike. The token face is
        # what sees it, and the receipt says so.
        self.assertEqual(fc.normalize('a == b'), fc.normalize('a = =b'))
        self.assertEqual([value for _, value in fc.pieces('a == b')], ['a', '==', 'b'])
        self.assertEqual([value for _, value in fc.pieces('a = =b')], ['a', '=', '=', 'b'])

    def test_numbers_are_read_as_digits_only(self):
        self.assertEqual([('number', '1'), ('operator', '.'), ('number', '5')],
                         fc.pieces('1.5'))

    def test_strip_directives_drops_only_hash_leading_lines(self):
        source = '#if X\nint a;\n  #pragma warning\nint b; // #\n'
        self.assertEqual('int a;\nint b; // #\n', fc.strip_directives(source))

    def test_positions_and_order_read_the_normalized_text(self):
        source = 'A();\nB();\nC();'
        anchors = [('b', 'B()'), ('a', 'A()'), ('c', 'C()')]
        self.assertEqual(['a', 'b', 'c'], fc.order(source, anchors))
        # Indices are into the normalized text, where the newlines are gone.
        self.assertEqual({'a': 0, 'b': 4, 'c': 8}, fc.positions(source, anchors))

    def test_a_missing_or_ambiguous_anchor_is_refused(self):
        with self.assertRaises(fc.UnsupportedSource):
            fc.positions('A();', [('x', 'B()')])
        with self.assertRaises(fc.UnsupportedSource):
            fc.positions('A();A();', [('x', 'A()')])

    def test_an_ambiguous_or_missing_method_is_refused(self):
        with self.assertRaises(fc.UnsupportedSource):
            fc.block('void F(){} void F(){}', 'void F()')
        with self.assertRaises(fc.UnsupportedSource):
            fc.block('void G(){}', 'void F()')
        with self.assertRaises(fc.UnsupportedSource):
            fc.block('void F()', 'void F()')


class HeaderTests(unittest.TestCase):
    SOURCE = '\n'.join([
        'class C',
        '{',
        '    public static JumpTable ComposeDefaultJumpTable()',
        '    {',
        '        if (x) { y(); }',
        '        foreach (var v in xs) { z(); }',
        '        return new Struct() { A = 1 };',
        '    }',
        '    protected internal void ExecuteNext()',
        '    {',
        '        while (true) { break; }',
        '    }',
        '}',
    ])

    def test_a_declaration_with_modifiers_and_a_return_type_is_found(self):
        found = fc.headers(self.SOURCE)
        self.assertIn('public static JumpTable ComposeDefaultJumpTable()', found)
        self.assertIn('protected internal void ExecuteNext()', found)

    def test_keyword_headers_and_initializers_are_not_declarations(self):
        found = fc.headers(self.SOURCE)
        for wrong in ('if (x)', 'foreach (var v in xs)', 'while (true)',
                      'new Struct()'):
            self.assertNotIn(wrong, found)

    def test_a_constructor_is_a_declaration_and_is_found(self):
        # A constructor has no return type, so the walk back reaches the
        # modifier list instead; it is still a method with a body both readers
        # must slice, so it belongs in the corpus.
        self.assertEqual(['public C()'], fc.headers('class C { public C() { } }'))

    def test_a_bare_name_before_the_parenthesis_is_not_a_declaration(self):
        # With nothing but the name, the shape is `if (x) {` and friends.
        self.assertEqual([], fc.headers('void M() { if (x) { } }'))


class SelfTestTests(unittest.TestCase):
    def test_the_harness_catches_its_own_mutants(self):
        rows = fc.self_test()
        failed = [row for row in rows if not row[1]]
        self.assertEqual([], failed)

    def test_every_discriminating_snippet_is_actually_discriminating(self):
        # A snippet that a blind reader also reads correctly proves nothing, so
        # the count is pinned: six snippets can catch a blind reader.
        rows = fc.self_test()
        caught = [row for row in rows if row[0].startswith('blind reader differs')]
        self.assertEqual(6, len(caught))

    def test_the_nested_depth_snippet_is_not_claimed_as_discriminating(self):
        rows = fc.self_test()
        labels = [row[0] for row in rows]
        self.assertIn('independent reads nested depth', labels)
        self.assertNotIn('blind reader differs on nested depth', labels)


class ReaderCensusTests(unittest.TestCase):
    """The front end is one scanner, and the seven lanes have to name it.

    What is read out of the modules is the declaration, not the algorithm. That
    is a weaker claim than reading the table was, and it is the one the code
    supports: the algorithm is measured against the compiler, the declaration is
    measured against the other six modules.
    """

    def test_the_seven_canonical_modules_name_one_reader(self):
        front = fc.canonical_reader(HERE)
        self.assertEqual(list(fc.CANONICAL_MODULES), front.modules)
        self.assertEqual('csharp_tokens', front.module)
        self.assertEqual('TOKENIZER', front.symbol)
        self.assertIn('as TOKEN', front.declaration)
        self.assertEqual(64, len(front.sha256))

    def test_the_declared_reader_is_the_one_that_is_executed(self):
        import csharp_tokens as ct
        front = fc.canonical_reader(HERE)
        source = 'void F() { S("a"); T(1.5); } // note'
        self.assertEqual([token.text for token in ct.TOKENIZER.finditer(source)
                          if not token.text.isspace()
                          and not token.text.startswith('//')],
                         front.tokens(source))

    def test_a_missing_canonical_module_is_refused(self):
        with tempfile.TemporaryDirectory() as scratch:
            with self.assertRaises(fc.UnsupportedSource):
                fc.canonical_reader(scratch)

    def test_a_divergent_declaration_is_refused(self):
        declaration = 'from csharp_tokens import TOKENIZER as TOKEN\n'
        with tempfile.TemporaryDirectory() as scratch:
            for name in fc.CANONICAL_MODULES:
                with open(os.path.join(scratch, name), 'w', encoding='utf-8') as handle:
                    handle.write(declaration)
            walked = os.path.join(scratch, fc.CANONICAL_MODULES[-1])
            with open(walked, 'w', encoding='utf-8') as handle:
                handle.write('from csharp_tokens import Tokenizer as TOKEN\n')
            with self.assertRaises(fc.UnsupportedSource):
                fc.canonical_reader(scratch)

    def test_a_declared_module_that_is_not_there_is_refused(self):
        with tempfile.TemporaryDirectory() as scratch:
            for name in fc.CANONICAL_MODULES:
                with open(os.path.join(scratch, name), 'w', encoding='utf-8') as handle:
                    handle.write('from absent_reader import TOKENIZER as TOKEN\n')
            with self.assertRaises(fc.UnsupportedSource):
                fc.canonical_reader(scratch)

    def test_a_declared_symbol_that_is_not_a_reader_is_refused(self):
        # A module that exists but does not answer `match()` is not a front end,
        # and the receipt must not be built as if it were.
        with tempfile.TemporaryDirectory() as scratch:
            with open(os.path.join(scratch, 'csharp_tokens.py'), 'w',
                      encoding='utf-8') as handle:
                handle.write('TOKENIZER = 7\n')
            for name in fc.CANONICAL_MODULES:
                with open(os.path.join(scratch, name), 'w', encoding='utf-8') as handle:
                    handle.write('from csharp_tokens import TOKENIZER as TOKEN\n')
            with self.assertRaises(fc.UnsupportedSource):
                fc.canonical_reader(scratch)

    def test_the_private_tables_are_named_not_silently_merged(self):
        receipt = fc.correspond(HERE, _corpus_roots() or _fixture_root())
        named = receipt['sharedReader']['privateTableModules']
        for name in fc.VARIANT_MODULES:
            self.assertIn(name, named)
        # A runner that keeps its own narrower table is named too, rather than
        # being left out of the census entirely.
        self.assertIn('runtime_source.py', named)
        self.assertNotIn(fc.CANONICAL_MODULES[0], named)


class AnchorFaceTests(unittest.TestCase):
    """The lanes locate their anchors in normalized text; both readers must
    accept and join the same fragments, or an anchor lands somewhere else."""

    def _modules(self, scratch, fragments):
        for name in list(fc.CANONICAL_MODULES) + list(fc.VARIANT_MODULES):
            with open(os.path.join(scratch, name), 'w', encoding='utf-8') as handle:
                handle.write('X = %r\n' % fragments.get(name, 'void F() { }'))

    def test_a_fragment_both_readers_refuse_is_counted_not_failed(self):
        front = fc.canonical_reader(HERE)
        with tempfile.TemporaryDirectory() as scratch:
            self._modules(scratch, {fc.CANONICAL_MODULES[0]: 'x \\ y; z();'})
            stats, problems = fc.anchor_face(front, scratch, {})
        self.assertEqual(1, stats['refusedByBoth'])
        self.assertEqual(0, stats['divergentAcceptance'])
        self.assertEqual([], problems)

    def test_an_acceptance_divergence_is_reported(self):
        front = fc.canonical_reader(HERE)
        original = fc.SINGLE
        try:
            fc.SINGLE = original - frozenset('&')
            with tempfile.TemporaryDirectory() as scratch:
                self._modules(scratch, {fc.CANONICAL_MODULES[0]: 'a & b; c();'})
                stats, problems = fc.anchor_face(front, scratch, {})
        finally:
            fc.SINGLE = original
        self.assertEqual(1, stats['divergentAcceptance'])
        self.assertEqual(1, len(problems))

    def test_the_corpus_reports_the_anchor_face(self):
        receipt = fc.correspond(HERE, _corpus_roots() or _fixture_root())
        face = receipt['faces']['anchors']
        self.assertGreater(face['candidates'], 100)
        self.assertGreater(face['readable'], 100)
        self.assertEqual(0, face['divergentAcceptance'])
        self.assertEqual(0, face['joinMismatch'])
        self.assertEqual(len(list(fc.CANONICAL_MODULES) + list(fc.VARIANT_MODULES)),
                         len(face['modules']))

    def test_agreement_requires_the_anchor_face(self):
        receipt = fc.correspond(HERE, _corpus_roots() or _fixture_root())
        self.assertTrue(fc.agrees(receipt, require_lexer=False))
        for field in ('divergentAcceptance', 'joinMismatch'):
            broken = json.loads(json.dumps(receipt))
            broken['faces']['anchors'][field] = 1
            self.assertFalse(fc.agrees(broken, require_lexer=False), field)


class NeedleFaceTests(unittest.TestCase):
    """A field is read with a short literal — `if needle in text`,
    `text.count(needle) == 1` — and the anchor face has a ten-character floor.
    The controls below are the point: the same defect must be invisible to one
    face and caught by the other, or the new face is decoration."""

    def _modules(self, scratch, needle, anchor='void F(uint a) { }'):
        """Write the nine lane modules with one projection function each."""
        for name in list(fc.CANONICAL_MODULES) + list(fc.VARIANT_MODULES):
            with open(os.path.join(scratch, name), 'w', encoding='utf-8') as handle:
                handle.write('ANCHOR = %r\n\n\ndef projection(text):\n'
                             '    return %r\n' % (anchor, needle))

    def test_the_short_literals_the_projection_code_reads_are_in_the_face(self):
        fragments, modules = fc.needle_literals(HERE)
        self.assertEqual(len(list(fc.CANONICAL_MODULES) + list(fc.VARIANT_MODULES)),
                         len(modules))
        short = [fragment for fragment in fragments
                 if len(fragment) < fc.ANCHOR_MINIMUM_LENGTH]
        # The hole this face closes is not hypothetical: the projection code
        # reads with literals the anchor face cannot see.
        self.assertGreater(len(short), 0)
        # Not a discovery — a change detector on the threshold itself. If
        # `ANCHOR_MINIMUM_LENGTH` were ever lowered to cover these, the two
        # faces would stop being different questions and this would say so.
        for fragment in short:
            self.assertNotIn(fragment, fc.declared_fragments(HERE)[0])

    def test_the_needle_face_names_what_it_skipped(self):
        front = fc.canonical_reader(HERE)
        with tempfile.TemporaryDirectory() as scratch:
            self._modules(scratch, 'if(a)')
            stats, problems = fc.needle_face(front, scratch, {})
        self.assertEqual(list(fc.NEEDLE_PLUMBING), stats['plumbingSkipped'])
        self.assertEqual([], problems)
        self.assertEqual(len(list(fc.CANONICAL_MODULES) + list(fc.VARIANT_MODULES)),
                         len(stats['modules']))

    def test_a_defect_in_a_short_needle_is_invisible_to_the_anchor_face(self):
        # A front end that is right on every long fragment and wrong on short
        # ones: the anchor face cannot fail, because it never looks that small.
        class ShortBlind(object):
            def __init__(self, inner):
                self.inner = inner

            def join(self, text):
                joined = self.inner.join(text)
                return joined.replace('(', '') if len(text) < fc.ANCHOR_MINIMUM_LENGTH \
                    else joined

        front = fc.canonical_reader(HERE)
        blind = ShortBlind(front)
        with tempfile.TemporaryDirectory() as scratch:
            self._modules(scratch, 'a(x)')
            anchors, anchor_problems = fc.anchor_face(blind, scratch, {})
            needles, needle_problems = fc.needle_face(blind, scratch, {})
        self.assertEqual([], anchor_problems)
        self.assertEqual(0, anchors['joinMismatch'])
        self.assertEqual(0, anchors['divergentAcceptance'])
        self.assertEqual(1, needles['joinMismatch'])
        self.assertEqual(1, len(needle_problems))
        self.assertEqual('needle', needle_problems[0][0])
        self.assertEqual('join', needle_problems[0][1])

    def test_a_needle_counted_differently_in_the_two_readings_is_reported(self):
        # The two readers can agree on the needle and still disagree about how
        # many times the file contains it, which is what `count == 1` reads. The
        # front end below reads every fragment correctly and only misreads whole
        # files, so the acceptance and join questions cannot catch it.
        class Duplicating(object):
            def __init__(self, inner):
                self.inner = inner

            def join(self, text):
                joined = self.inner.join(text)
                if len(text) <= fc.ANCHOR_MINIMUM_LENGTH:
                    return joined
                return joined.replace('a(x)', 'a(x)a(x)')

        front = fc.canonical_reader(HERE)
        by_sha = {'0' * 64: (['F.cs'], 'void F() { a(x); }')}
        with tempfile.TemporaryDirectory() as scratch:
            self._modules(scratch, 'a(x)')
            needles, problems = fc.needle_face(
                Duplicating(front), scratch, by_sha, fc.normalize)
        self.assertEqual(0, needles['joinMismatch'])
        self.assertEqual(1, needles['countMismatch'])
        self.assertEqual(1, len(problems))
        self.assertEqual('count', problems[0][1])
        self.assertEqual('0' * 12, problems[0][3])

    def test_the_corpus_reports_the_needle_face(self):
        receipt = fc.correspond(HERE, _corpus_roots() or _fixture_root())
        face = receipt['faces']['needles']
        self.assertGreater(face['candidates'], 100)
        self.assertGreater(face['readable'], 100)
        self.assertGreater(face['shortOfAnchorThreshold'], 0)
        self.assertGreater(face['located'], 0)
        self.assertEqual(0, face['divergentAcceptance'])
        self.assertEqual(0, face['joinMismatch'])
        self.assertEqual(0, face['countMismatch'])

    def test_agreement_requires_the_needle_face(self):
        receipt = fc.correspond(HERE, _corpus_roots() or _fixture_root())
        self.assertTrue(fc.agrees(receipt, require_lexer=False))
        for field in ('divergentAcceptance', 'joinMismatch', 'countMismatch'):
            broken = json.loads(json.dumps(receipt))
            broken['faces']['needles'][field] = 1
            self.assertFalse(fc.agrees(broken, require_lexer=False), field)

    def test_the_plumbing_names_still_exist_in_the_lane_modules(self):
        # A renamed helper must not quietly shrink what the face reads.
        found = set()
        for name in list(fc.CANONICAL_MODULES) + list(fc.VARIANT_MODULES):
            with open(os.path.join(HERE, name), encoding='utf-8') as handle:
                tree = ast.parse(handle.read())
            found.update(node.name for node in tree.body
                         if isinstance(node, ast.FunctionDef))
        self.assertEqual(set(), set(fc.NEEDLE_PLUMBING) - found)


class CorpusTests(unittest.TestCase):
    def test_the_corpus_agrees_on_every_face(self):
        roots = _corpus_roots()
        if not roots:
            self.skipTest('no pinned mirrors on this machine')
        receipt = fc.correspond(HERE, roots)
        self.assertTrue(fc.agrees(receipt, require_lexer=False), receipt['problems'][:3])
        self.assertGreater(receipt['corpus']['files'], 0)
        self.assertGreater(receipt['corpus']['tokens'], 1000)
        self.assertGreater(receipt['faces']['bodies']['methods'], 50)

    def test_the_receipt_is_deterministic(self):
        roots = _corpus_roots()
        if not roots:
            self.skipTest('no pinned mirrors on this machine')
        first = fc.correspond(HERE, roots)
        second = fc.correspond(HERE, roots)
        self.assertEqual(first['receiptSha256'], second['receiptSha256'])

    def test_an_empty_corpus_is_refused_rather_than_reported_as_agreement(self):
        with tempfile.TemporaryDirectory() as scratch:
            with self.assertRaises(fc.UnsupportedSource):
                fc.correspond(HERE, [scratch])
            with self.assertRaises(fc.UnsupportedSource):
                fc.correspond(HERE, [])

    def test_the_corpus_digest_binds_the_bytes_not_the_paths(self):
        roots = _corpus_roots() or _fixture_root()
        first = fc.correspond(HERE, roots)
        copied = _copy_corpus(roots)
        second = fc.correspond(HERE, [copied])
        # The mirror labels differ, so the receipts differ, but the digest is
        # over bytes and names only.
        self.assertEqual(first['corpus']['digest'], second['corpus']['digest'])
        self.assertNotEqual(first['corpus']['mirrors'], second['corpus']['mirrors'])

    def test_one_changed_byte_moves_the_corpus_digest(self):
        roots = _corpus_roots() or _fixture_root()
        before = fc.correspond(HERE, roots)
        copied = _copy_corpus(roots)
        victim = sorted(name for name in os.listdir(copied) if name.endswith('.cs'))[0]
        with open(os.path.join(copied, victim), 'r+', encoding='utf-8') as handle:
            text = handle.read()
            handle.seek(0)
            handle.write(text.replace('\n', '\n// moved\n', 1))
            handle.truncate()
        after = fc.correspond(HERE, [copied])
        self.assertEqual(before['corpus']['files'], after['corpus']['files'])
        self.assertNotEqual(before['corpus']['digest'], after['corpus']['digest'])

    def test_a_broken_independent_reader_is_caught(self):
        roots = _corpus_roots()
        if not roots:
            self.skipTest('no pinned mirrors on this machine')
        original = fc.block
        try:
            fc.block = lambda text, header: '{broken}'
            receipt = fc.correspond(HERE, roots)
        finally:
            fc.block = original
        self.assertFalse(fc.agrees(receipt, require_lexer=False))
        self.assertGreater(receipt['faces']['bodies']['mismatch'], 0)

    def test_a_dropped_character_is_caught(self):
        roots = _corpus_roots()
        if not roots:
            self.skipTest('no pinned mirrors on this machine')
        original = fc.pieces

        def lossy(text):
            return [(kind, value) for kind, value in original(text) if value != '{']

        try:
            fc.pieces = lossy
            receipt = fc.correspond(HERE, roots)
        finally:
            fc.pieces = original
        self.assertFalse(fc.agrees(receipt, require_lexer=False))
        self.assertGreater(receipt['faces']['tokens']['mismatch'], 0)


class StrictReaderTests(unittest.TestCase):
    """The reader that is compared with the compiler, and nothing else."""

    def test_an_interpolation_hole_keeps_the_text_inside_it(self):
        source = '$"[{string.Join(", ", items)}]"'
        self.assertEqual(source, fc.strict_normalize(source))
        # The plain reader reads the hole the same way, which is the rule the
        # front end used to lack: the separator space used to be dropped, so
        # every position after it was off by one.
        self.assertEqual(source, fc.normalize(source))
        self.assertEqual(1, len(fc.spans(source)))

    def test_a_hole_may_hold_a_nested_interpolated_string(self):
        source = '$"{$"{a}"}"'
        self.assertEqual([source], [value for kind, value, _, _ in fc.strict_spans(source)])
        self.assertEqual(source, fc.strict_normalize(source))

    def test_doubled_braces_are_text_and_not_holes(self):
        source = '$"{{literal}}"'
        self.assertEqual(source, fc.strict_normalize(source))
        self.assertEqual(1, len(fc.strict_spans(source)))

    def test_a_format_specifier_does_not_end_the_hole(self):
        source = '$"{value:0.00}"'
        self.assertEqual(source, fc.strict_normalize(source))

    def test_a_character_literal_inside_a_hole_is_not_a_quote(self):
        source = "$\"{(flag ? '{' : '}')}\""
        self.assertEqual(source, fc.strict_normalize(source))
        self.assertEqual(1, len(fc.strict_spans(source)))

    def test_a_comment_inside_a_hole_hides_its_brace(self):
        source = '$"{value /* } */}"'
        self.assertEqual(source, fc.strict_normalize(source))

    def test_a_verbatim_string_escapes_by_doubling(self):
        source = '@"a""b"'
        self.assertEqual([source], [value for kind, value, _, _ in fc.strict_spans(source)])

    def test_an_unterminated_hole_is_refused(self):
        with self.assertRaises(fc.UnsupportedSource):
            fc.strict_normalize('$"{ value ')

    def test_an_unterminated_interpolated_literal_is_refused(self):
        with self.assertRaises(fc.UnsupportedSource):
            fc.strict_normalize('$"abc')

    def test_the_strict_reader_leaves_ordinary_source_alone(self):
        source = 'void F() { S("a"); T(1.5); }'
        self.assertEqual(fc.normalize(source), fc.strict_normalize(source))


class PreprocessorTests(unittest.TestCase):
    """Conditional compilation is a reading rule, so it is read, not guessed."""

    def test_an_undefined_symbol_disables_the_region(self):
        source = '#if VMPERF\nHidden();\n#endif\nVisible();'
        self.assertEqual('Visible();', fc.active_text(source, ()))

    def test_the_else_branch_is_kept_when_the_condition_is_false(self):
        source = '#if VMPERF\nA();\n#else\nB();\n#endif'
        self.assertEqual('B();', fc.active_text(source, ()))

    def test_a_symbol_can_be_given_and_then_the_region_is_kept(self):
        source = '#if VMPERF\nA();\n#else\nB();\n#endif'
        self.assertEqual('A();', fc.active_text(source, ('VMPERF',)))

    def test_the_symbol_set_is_a_parameter_and_not_a_claim(self):
        self.assertEqual((), fc.STRICT_SYMBOLS)
        self.assertEqual(['Visible();'],
                         [line for line in
                          fc.active_text('#if X\nA();\n#endif\nVisible();', ()).split('\n')
                          if line])

    def test_a_define_inside_the_file_is_honoured(self):
        source = '#define ON\n#if ON\nA();\n#endif'
        self.assertEqual('A();', fc.active_text(source, ()))

    def test_an_undef_turns_it_off_again(self):
        source = '#define ON\n#undef ON\n#if ON\nA();\n#else\nB();\n#endif'
        self.assertEqual('B();', fc.active_text(source, ()))

    def test_an_elif_chain_picks_the_first_true_branch(self):
        source = '#if A\nA();\n#elif B\nB();\n#elif C\nC();\n#else\nD();\n#endif'
        self.assertEqual('C();', fc.active_text(source, ('C',)))

    def test_a_nested_region_inside_disabled_text_does_not_close_early(self):
        source = '#if OFF\n#if ON\nA();\n#endif\nB();\n#endif\nC();'
        self.assertEqual('C();', fc.active_text(source, ('ON',)))

    def test_directive_lines_contribute_no_text(self):
        source = '#region X\nA();\n#endregion'
        self.assertEqual('A();', fc.active_text(source, ()))

    def test_an_unterminated_region_is_refused(self):
        with self.assertRaises(fc.UnsupportedSource):
            fc.active_text('#if ON\nA();', ())

    def test_an_unbalanced_condition_is_refused(self):
        with self.assertRaises(fc.UnsupportedSource):
            fc.active_text('#if (ON\nA();\n#endif', ())

    def test_the_expression_grammar_is_the_documented_one(self):
        self.assertTrue(fc.preprocessor_value('!OFF && (ON || NEVER)', ('ON',)))
        self.assertFalse(fc.preprocessor_value('ON && !ON', ('ON',)))
        self.assertTrue(fc.preprocessor_value('true', ()))
        self.assertFalse(fc.preprocessor_value('false', ()))

    def test_an_unknown_token_in_a_condition_is_refused(self):
        with self.assertRaises(fc.UnsupportedSource):
            fc.preprocessor_value('@', ())


class StrictFaceTests(unittest.TestCase):
    """The face that judges the judge."""

    def _corpus(self, scratch, text):
        corpus = os.path.join(scratch, 'source')
        os.mkdir(corpus)
        with open(os.path.join(corpus, 'fixture.cs'), 'w', encoding='utf-8') as handle:
            handle.write(text)
        return corpus

    def _dump(self, scratch, joined):
        path = os.path.join(scratch, 'dump.json')
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump([{'file': 'fixture.cs', 'directory': 'source', 'joined': joined,
                        'tokens': 0, 'joinedLength': len(joined),
                        'joinedSha256': '0' * 64}], handle)
        return path

    def test_a_confirmed_reader_matches_the_lexer_on_every_file(self):
        source = 'void F() { S("}"); }\n'
        with tempfile.TemporaryDirectory() as scratch:
            corpus = self._corpus(scratch, source)
            dump = self._dump(scratch, fc.strict_normalize(source))
            receipt = fc.correspond(HERE, [corpus], lexer_dump=dump)
        face = receipt['faces']['strict']
        self.assertTrue(face['available'])
        self.assertEqual([], face['symbols'])
        self.assertEqual(1, face['filesCompared'])
        self.assertEqual(1, face['filesIdentical'])
        self.assertEqual([], face['fileDivergences'])
        self.assertTrue(fc.agrees(receipt))

    def test_a_front_end_gap_is_named_with_its_cause(self):
        # The front end no longer has the interpolation defect, so the gap is
        # produced by losing a character on purpose: what is under test is the
        # bookkeeping, not the defect.
        source = 'void F() { A(); }\nvoid G() { B("x"); }\n'
        real = fc.canonical_reader

        def lossy(directory):
            inner = real(directory)

            class Lossy:
                def __getattr__(self, name):
                    return getattr(inner, name)

                def join(self, text):
                    out = inner.join(text)
                    cut = len(out) // 2
                    return out[:cut] + out[cut + 1:]

            return Lossy()

        try:
            fc.canonical_reader = lossy
            with tempfile.TemporaryDirectory() as scratch:
                corpus = self._corpus(scratch, source)
                dump = self._dump(scratch, fc.strict_normalize(source))
                receipt = fc.correspond(HERE, [corpus], lexer_dump=dump)
        finally:
            fc.canonical_reader = real
        self.assertEqual(1, receipt['faces']['strict']['filesIdentical'])
        self.assertEqual(['fixture.cs'], receipt['knownGaps']['files'])
        # Neither remedy explains a character dropped out of the middle, and the
        # receipt says so instead of forcing it into a category.
        self.assertEqual('unclassified', receipt['knownGaps']['rows'][0]['cause'])
        self.assertTrue(receipt['knownGaps']['rows'][0]['strictAgreesWithLexer'])

    def test_a_fragment_inside_a_disabled_region_is_not_a_location(self):
        fragment = None
        fragments, _ = fc.declared_fragments(HERE)
        for candidate in sorted(fragments):
            if '\n' not in candidate and '(' in candidate and len(candidate) >= 12:
                try:
                    fc.normalize(candidate)
                except fc.UnsupportedSource:
                    continue
                fragment = candidate
                break
        self.assertIsNotNone(fragment)
        # The fragment exists only inside a region the compiler never reads, so
        # the front end locates something that is not there.
        source = ('#if VMPERF\nvoid Hidden() { ' + fragment + ' }\n#endif\n'
                  'void F() { T(); }\n')
        with tempfile.TemporaryDirectory() as scratch:
            corpus = self._corpus(scratch, source)
            dump = self._dump(scratch, fc.strict_normalize(fc.active_text(source, ())))
            receipt = fc.correspond(HERE, [corpus], lexer_dump=dump)
        self.assertEqual(0, receipt['knownGaps']['anchorsAffectedUnique'])
        self.assertTrue(fc.agrees(receipt))
        # The check that would have caught it is wired, not decorative: a
        # uniquely located fragment that moved blocks agreement outright.
        broken = json.loads(json.dumps(receipt))
        broken['knownGaps']['anchorsAffectedUnique'] = 1
        self.assertFalse(fc.agrees(broken))

    def test_the_reproducers_record_the_two_closed_defects(self):
        source = 'void F() { T(); }\n'
        with tempfile.TemporaryDirectory() as scratch:
            corpus = self._corpus(scratch, source)
            dump = self._dump(scratch, fc.strict_normalize(source))
            receipt = fc.correspond(HERE, [corpus], lexer_dump=dump)
        rows = receipt['knownGaps']['reproducers']
        self.assertEqual(['disabled-region', 'interpolation-hole'],
                         sorted(row['name'] for row in rows))
        # Both fragments used to be read differently by the front end than by the
        # compiler. If either stops agreeing, the defect is back.
        for row in rows:
            self.assertTrue(row['agrees'], row['name'])
            self.assertEqual(row['frontEndJoin'], row['confirmedJoin'])
        broken = json.loads(json.dumps(receipt))
        broken['knownGaps']['reproducers'][0]['agrees'] = False
        self.assertFalse(fc.agrees(broken))



class DirectiveModuleTests(unittest.TestCase):
    """The one shared implementation, and the fact that the lanes use it.

    There are two copies of this rule — `csharp_directives` for the lanes and
    `active_text` in the harness, which must not depend on the thing it
    measures. Two copies are two chances to drift, so the agreement between them
    is a test and not an assumption.
    """

    BATTERY = (
        '#if VMPERF\nHidden();\n#endif\nVisible();',
        '#if A\nA();\n#else\nB();\n#endif',
        '#define ON\n#if ON\nA();\n#endif',
        '#region X\nA();\n#endregion',
        '#pragma warning disable IDE0051\nA();',
        '#if A\n#if B\nX();\n#endif\nY();\n#endif\nZ();',
        'plain();\nmore();',
    )

    def test_the_shared_rule_and_the_harness_rule_agree(self):
        import csharp_directives as cd
        for source in self.BATTERY:
            self.assertEqual(fc.active_text(source, ()), cd.active_text(source, ()),
                             source)
            self.assertEqual(fc.active_text(source, ('VMPERF', 'B')),
                             cd.active_text(source, ('VMPERF', 'B')), source)

    def test_the_agreement_covers_the_real_corpus(self):
        roots = _corpus_roots()
        if not roots:
            self.skipTest('no mirrors')
        import csharp_directives as cd
        seen = 0
        for root in roots:
            for name in sorted(os.listdir(root)):
                if not name.endswith('.cs'):
                    continue
                with open(os.path.join(root, name), encoding='utf-8') as handle:
                    raw = handle.read()
                self.assertEqual(fc.active_text(raw, ()), cd.active_text(raw, ()),
                                 name)
                seen += 1
        self.assertGreater(seen, 0)

    def test_the_lanes_no_longer_carry_their_own_copy(self):
        import ast
        for name in ('abi_admission_source.py', 'exception_identity_source.py'):
            with open(os.path.join(HERE, name), encoding='utf-8') as handle:
                source = handle.read()
            tree = ast.parse(source)
            defined = [node.name for node in tree.body
                       if isinstance(node, ast.FunctionDef)]
            self.assertNotIn('strip_directives', defined, name)
            self.assertIn('from csharp_directives import strip_directives', source, name)




class TokenizerTests(unittest.TestCase):
    """The scanner the lanes now share, and the reader it has to agree with.

    The claim is no longer "switching the lanes over would change one file"; it
    is that the front end and the independent reader read the pinned corpus
    alike. If that stops being true, this test says so before anyone reads the
    receipt that says every face is zero.
    """

    def test_plain_source_tokenizes_like_the_shared_expression(self):
        import csharp_tokens as ct
        source = 'void F() { S("a"); T(1.5); } // note\n/* block */ x += 1;'
        # The expression emitted comments and whitespace as tokens and the
        # slicer skipped them; the scanner does the same, so the comparison
        # drops them the way the slicer does.
        kept = [token.text for token in ct.TOKENIZER.finditer(source)
                if not token.text.isspace() and not token.text.startswith(('//', '/*'))]
        self.assertEqual([value for _, value in fc.pieces(source)], kept)

    def test_a_hole_is_one_token_for_the_scanner(self):
        import csharp_tokens as ct
        source = '$"[{string.Join(", ", x)}]"'
        tokens = [t.text for t in ct.TOKENIZER.finditer(source)]
        self.assertEqual([source], tokens)
        # The independent reader keeps it whole too, which is what lets the two
        # be compared on this file at all.
        self.assertEqual([source], [value for _, value in fc.pieces(source)])

    def test_a_doubled_quote_stays_inside_a_verbatim_literal(self):
        import csharp_tokens as ct
        source = '@"a""b"'
        self.assertEqual([source], [t.text for t in ct.TOKENIZER.finditer(source)])

    def test_an_unknown_character_is_refused_rather_than_skipped(self):
        import csharp_tokens as ct
        with self.assertRaises(ct.UnsupportedToken):
            list(ct.TOKENIZER.finditer('void F() { # }'))

    def test_the_scanner_reads_the_corpus_like_the_independent_reader(self):
        import csharp_tokens as ct
        roots = _corpus_roots()
        if not roots:
            self.skipTest('no mirrors')
        seen = set()
        differing = set()
        compared = 0
        for root in roots:
            for name in sorted(os.listdir(root)):
                if not name.endswith('.cs'):
                    continue
                with open(os.path.join(root, name), encoding='utf-8') as handle:
                    raw = handle.read()
                if (name, len(raw)) in seen:
                    continue
                seen.add((name, len(raw)))
                text = fc.active_text(raw)
                try:
                    kept = [value for _, value in fc.pieces(text)]
                except (fc.UnsupportedSource, ValueError):
                    # Text the independent reader refuses is not text the scanner
                    # has to agree on; the faces report that refusal instead.
                    continue
                scanned = [token.text for token in ct.TOKENIZER.finditer(text)
                           if not token.text.isspace()
                           and not token.text.startswith(('//', '/*'))]
                compared += 1
                if kept != scanned:
                    differing.add(name)
        self.assertGreater(compared, 20)
        # No file differs. This is the file that used to: the interpolation hole
        # in `vm-stack.cs`, where the expression dropped one character.
        self.assertEqual(set(), differing)


class SlicedFileTests(unittest.TestCase):
    """Which files a lane actually takes a body out of.

    The remaining front-end divergence is only harmless because the file it
    sits in is never sliced. That is a claim about the modules, so it is read
    out of the modules.
    """

    def test_a_body_slicing_lane_is_recognised(self):
        sliced, _ = fc.sliced_files(HERE)
        self.assertIn('ExecutionEngine.cs', sliced)
        self.assertIn('exception_identity_source.py', sliced['ExecutionEngine.cs'])

    def test_a_pinned_file_nobody_slices_is_absent(self):
        sliced, _ = fc.sliced_files(HERE)
        # Three lanes pin EvaluationStack.cs; none of them calls body() on it.
        self.assertNotIn('EvaluationStack.cs', sliced)

    def test_modules_without_a_body_slicer_are_named_not_counted(self):
        _, plain = fc.sliced_files(HERE)
        self.assertIn('gas_proofs.py', plain)
        self.assertIn('entry_dispatch_source.py', plain)

    def test_an_unreadable_table_is_named_rather_than_guessed(self):
        with tempfile.TemporaryDirectory() as scratch:
            with open(os.path.join(scratch, 'abi_admission_source.py'), 'w',
                      encoding='utf-8') as handle:
                handle.write('SOURCES = [1, 2, 3]\n')
            sliced, plain = fc.sliced_files(scratch)
        self.assertEqual({}, sliced)
        self.assertIn('abi_admission_source.py', plain)


class ReceiptShapeTests(unittest.TestCase):
    def test_the_receipt_never_claims_a_proof(self):
        receipt = fc.correspond(HERE, _corpus_roots() or _fixture_root())
        text = json.dumps(receipt, sort_keys=True)
        for overclaim in ('implementationVerified', 'fullImplementationVerified',
                          'grammarProven', 'compilerCorrespondenceProven',
                          'deploymentPathVerified', 'verified": true'):
            self.assertNotIn(overclaim, text)

    def test_the_receipt_names_its_reader_and_the_modules_sharing_it(self):
        receipt = fc.correspond(HERE, _corpus_roots() or _fixture_root())
        self.assertEqual(fc.SCHEMA, receipt['schema'])
        self.assertEqual(fc.SCOPE, receipt['scope'])
        self.assertEqual(64, len(receipt['independentReader']['sha256']))
        self.assertEqual(64, len(receipt['sharedReader']['readerSha256']))
        self.assertEqual(64, len(receipt['receiptSha256']))
        self.assertEqual(list(fc.CANONICAL_MODULES),
                         receipt['sharedReader']['canonicalModules'])
        self.assertIn('as TOKEN', receipt['sharedReader']['declaration'])

    def test_agreement_requires_every_face_and_the_self_test(self):
        receipt = fc.correspond(HERE, _corpus_roots() or _fixture_root())
        self.assertTrue(fc.agrees(receipt, require_lexer=False))
        for face, field in (('normalize', 'mismatch'), ('tokens', 'mismatch'),
                            ('bodies', 'mismatch')):
            broken = json.loads(json.dumps(receipt))
            broken['faces'][face][field] = 1
            self.assertFalse(fc.agrees(broken, require_lexer=False), face)
        broken = json.loads(json.dumps(receipt))
        broken['selfTest']['failed'] = ['something']
        self.assertFalse(fc.agrees(broken, require_lexer=False))
        broken = json.loads(json.dumps(receipt))
        broken['pinConsistency'] = False
        self.assertFalse(fc.agrees(broken, require_lexer=False))


class LexerFaceTests(unittest.TestCase):
    """The C# lexer is the only reader in this file that is not ours."""

    def _corpus(self, scratch, text):
        corpus = os.path.join(scratch, 'source')
        os.mkdir(corpus)
        with open(os.path.join(corpus, 'fixture.cs'), 'w', encoding='utf-8') as handle:
            handle.write(text)
        return corpus

    def _dump(self, scratch, joined):
        path = os.path.join(scratch, 'dump.json')
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump([{'file': 'fixture.cs', 'directory': 'source', 'joined': joined,
                        'tokens': 0, 'joinedLength': len(joined),
                        'joinedSha256': '0' * 64}], handle)
        return path

    def _fragment(self):
        fragments, _ = fc.declared_fragments(HERE)
        usable = sorted(fragment for fragment in fragments
                        if '\n' not in fragment and '(' in fragment
                        and len(fragment) >= 12
                        and _readable(fragment))
        self.assertTrue(usable, 'no usable declared fragment')
        return usable[0]

    def test_no_dump_is_not_agreement(self):
        roots = _corpus_roots() or _fixture_root()
        receipt = fc.correspond(HERE, roots)
        self.assertFalse(receipt['faces']['lexer']['available'])
        self.assertFalse(fc.agrees(receipt))
        self.assertTrue(fc.agrees(receipt, require_lexer=False))

    def test_an_anchor_the_lexer_cannot_see_is_a_divergence(self):
        fragment = self._fragment()
        source = 'void F() { ' + fragment + ' }\n'
        with tempfile.TemporaryDirectory() as scratch:
            corpus = self._corpus(scratch, source)
            joined = fc.normalize(fc.strip_directives(source))
            anchor = fc.normalize(fragment)
            # Lose one character of the anchor, the way an interpolation hole or a
            # dropped content space would.
            victim = joined.index(anchor) + 3
            dump = self._dump(scratch, joined[:victim] + joined[victim + 1:])
            receipt = fc.correspond(HERE, [corpus], lexer_dump=dump)
        face = receipt['faces']['lexer']
        self.assertTrue(face['available'])
        self.assertEqual(1, face['filesCompared'])
        self.assertEqual(0, face['filesIdentical'])
        self.assertGreater(face['anchorsChecked'], 0)
        self.assertGreater(face['anchorDivergences'], 0)
        self.assertFalse(fc.agrees(receipt))

    def test_a_whole_file_divergence_is_recorded_with_its_offset(self):
        fragment = self._fragment()
        source = 'void F() { ' + fragment + ' }\n'
        with tempfile.TemporaryDirectory() as scratch:
            corpus = self._corpus(scratch, source)
            joined = fc.normalize(fc.active_text(source, ()))
            # Text no reader would produce: the front end is the only reader that
            # agrees with this dump, and one reader agreeing with itself is not a
            # correspondence.
            dump = self._dump(scratch, joined + 'voidG(){}')
            receipt = fc.correspond(HERE, [corpus], lexer_dump=dump)
        face = receipt['faces']['lexer']
        self.assertEqual(1, face['filesCompared'])
        self.assertEqual(0, face['filesIdentical'])
        # The extra text is appended, so no anchor a lane names moves.
        self.assertEqual(0, face['anchorDivergences'])
        self.assertEqual(1, len(face['fileDivergences']))
        self.assertEqual(len(joined), face['fileDivergences'][0]['offset'])
        self.assertEqual(len(joined), face['fileDivergences'][0]['frontEndLength'])
        self.assertEqual(0, receipt['faces']['strict']['filesIdentical'])
        self.assertFalse(fc.agrees(receipt))

    def test_a_divergence_with_no_confirmed_reader_does_not_agree(self):
        fragment = self._fragment()
        source = 'void F() { ' + fragment + ' }\n'
        with tempfile.TemporaryDirectory() as scratch:
            corpus = self._corpus(scratch, source)
            joined = fc.normalize(fc.strip_directives(source))
            # Text the strict reader would never produce: the front end is now
            # the only reader that agrees with this dump, and one reader
            # agreeing with itself is not a correspondence.
            dump = self._dump(scratch, joined + 'voidG(){}')
            receipt = fc.correspond(HERE, [corpus], lexer_dump=dump)
        self.assertEqual(0, receipt['faces']['strict']['filesIdentical'])
        self.assertFalse(fc.agrees(receipt))

    def test_a_matching_dump_passes_and_counts_the_file(self):
        fragment = self._fragment()
        source = 'void F() { ' + fragment + ' }\n'
        with tempfile.TemporaryDirectory() as scratch:
            corpus = self._corpus(scratch, source)
            joined = fc.normalize(fc.strip_directives(source))
            dump = self._dump(scratch, joined)
            receipt = fc.correspond(HERE, [corpus], lexer_dump=dump)
        face = receipt['faces']['lexer']
        self.assertEqual(1, face['filesIdentical'])
        self.assertEqual([], face['fileDivergences'])
        self.assertEqual(0, face['anchorDivergences'])
        self.assertTrue(fc.agrees(receipt))

    def test_a_missing_dump_file_is_unavailable_rather_than_empty(self):
        with tempfile.TemporaryDirectory() as scratch:
            corpus = self._corpus(scratch, 'void F() { A(); }\n')
            receipt = fc.correspond(HERE, [corpus],
                                    lexer_dump=os.path.join(scratch, 'absent.json'))
        self.assertFalse(receipt['faces']['lexer']['available'])


def _readable(fragment):
    try:
        fc.normalize(fragment)
        return True
    except fc.UnsupportedSource:
        return False


MIRRORS = (
    '/tmp/loadadm/src',
    '/tmp/excid/src',
    '/tmp/syscall1/source',
    '/tmp/chsource',
    '/tmp/interop-src',
    '/tmp/closure14/out/entry-dispatch/source',
)


def _corpus_roots():
    return [path for path in MIRRORS if os.path.isdir(path)]


def _copy_corpus(roots):
    """Copy every .cs from `roots` into one flat scratch directory."""
    scratch = tempfile.mkdtemp(prefix='sa-corpus-copy-')
    for path in roots:
        for name in sorted(os.listdir(path)):
            if not name.endswith('.cs'):
                continue
            with open(os.path.join(path, name), 'rb') as source:
                raw = source.read()
            with open(os.path.join(scratch, name), 'wb') as target:
                target.write(raw)
    return scratch


def _fixture_root():
    """A one-file corpus, so the shape tests run even with no mirrors."""
    scratch = tempfile.mkdtemp(prefix='sa-correspondence-')
    with open(os.path.join(scratch, 'fixture.cs'), 'w', encoding='utf-8') as handle:
        handle.write('class C\n{\n    void F()\n    {\n        S("}");\n    }\n}\n')
    return [scratch]


if __name__ == '__main__':
    unittest.main()

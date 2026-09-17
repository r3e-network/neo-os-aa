#!/usr/bin/env python3
"""Validate draft structure, not consensus correctness or implementation conformance."""
from pathlib import Path
import re

text = Path(__file__).with_name('nep-aa-entry-verifier.mediawiki').read_text()
for tag in ('pre', 'code'):
    assert text.count(f'<{tag}>') == text.count(f'</{tag}>'), f'unbalanced {tag}'
assert text.count('{|') == text.count('|}')
for section in ('Abstract', 'Motivation', 'Specification', 'Rationale',
                'Backwards Compatibility', 'Test Cases', 'Implementation'):
    assert f'=={section}==' in text, section
for line in text.splitlines():
    if line.startswith('='):
        assert re.fullmatch(r'(={2,6})([^=]+)\1', line), line
spec = text.split('==Specification==', 1)[1].split('==Rationale==', 1)[0]
for legacy in ('executeUnifiedByAddress', 'verifyMetaTx'):
    assert legacy not in spec, f'legacy entrypoint still normative: {legacy}'
for required in ('executeUserOp(accountId: Hash160, op: Array)',
                 'executeUserOps(accountId: Hash160, ops: Array)',
                 'validateSignature(accountId: Hash160, op: Array)',
                 'preExecute(accountId: Hash160, op: Array)',
                 'postExecute(accountId: Hash160, op: Array, result: Any)',
                 'channel  = nonce >> 64', '0 <= nonce < 2^256',
                 'An installed verifier MUST implement',
                 'Requirements on the proposed native AccountManagement profile'):
    assert required in spec, required
assert 'not an implementation of a node-native' in text
print('PASS: AA foundation document structure and interface assertions')
print('Not a protocol proof, conformance test, or native-contract implementation test.')

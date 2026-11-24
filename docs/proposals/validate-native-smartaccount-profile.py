#!/usr/bin/env python3
"""Verify that the native core and its clients admit the same current protocol."""
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from native_module_profile import profile_digest


def validate(root):
    metadata = json.loads((root / 'contracts/native/profile.json').read_text())
    parameters = root / 'docs/proposals/smartaccount-native-profile-parameters.json'
    if metadata['protocolParameters'] != parameters.relative_to(root).as_posix():
        raise ValueError('The current protocol parameter path does not match the native profile')
    data = json.loads(parameters.read_text())
    if metadata['protocolVersion'] != data['abiVersion'] or metadata['version'] != data['profileVersion']:
        raise ValueError('The native profile and its parameters disagree')
    digest = profile_digest(parameters)
    for name, constant in (
            ('contracts/native/SmartAccount/SmartAccount.cs', 'ParameterDigest'),
            ('shared/nativeSmartAccountClient.mjs', 'NATIVE_PROFILE_PARAMETER_DIGEST'),
            ('frontend/src/shared/nativeSmartAccountClient.mjs', 'NATIVE_PROFILE_PARAMETER_DIGEST')):
        text = (root / name).read_text()
        if re.findall(r'\b' + constant + r'\s*=\s*"([a-f0-9]{64})"', text) != [digest]:
            raise ValueError('Current protocol fingerprint mismatch: ' + name)
    return digest


if __name__ == '__main__':
    print('Verified current SmartAccount parameter fingerprint: ' + validate(ROOT))

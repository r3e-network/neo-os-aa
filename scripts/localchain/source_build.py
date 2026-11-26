"""Read a compiled NEF the way Neo's NefFile does, including the trailing checksum.

This module used to build the SA contracts from the checkout with the pinned published `nccs`
and to read the verifier-callback build profile from the compiled bytes, for the local-chain
suite's `source` variant. That variant drove the custom protocol-v4 kernel, whose sources are
gone: no default project builds it and SAPaymaster has no source, so the variant could not run.
The builder and the profile reader were retired with it. Only this NEF reader remains;
`scripts/check_module_neps.py` imports it. Nothing here touches a network, builds or deploys
anything.
"""
import hashlib
from pathlib import Path

NEF_MAGIC = b"NEF3"


class NefError(Exception):
    pass


def _varint(data, offset):
    """Neo's variable-length integer: a single byte below 0xFD, otherwise a 0xFD/0xFE/0xFF tag
    followed by a fixed-width little-endian value."""
    if offset >= len(data):
        raise NefError("truncated variable-length integer")
    first = data[offset]
    if first < 0xFD:
        return first, offset + 1
    width = {0xFD: 2, 0xFE: 4, 0xFF: 8}[first]
    if offset + 1 + width > len(data):
        raise NefError("truncated variable-length integer")
    return int.from_bytes(data[offset + 1:offset + 1 + width], "little"), offset + 1 + width


def _varstring(data, offset, limit):
    length, offset = _varint(data, offset)
    if length > limit:
        raise NefError("variable-length string exceeds its limit")
    if offset + length > len(data):
        raise NefError("variable-length string overruns the file")
    return data[offset:offset + length].decode("utf-8", "replace"), offset + length


def read_nef(path):
    """Parse a NEF the way Neo's NefFile does, including the trailing checksum."""
    data = Path(path).read_bytes()
    if len(data) < 4 + 64 + 1 + 1 + 2 + 1 + 4:
        raise NefError("%s: too short to be a NEF" % path)
    if data[0:4] != NEF_MAGIC:
        raise NefError("%s: not a NEF3 file" % path)
    offset = 4
    compiler = data[offset:offset + 64].decode("ascii", "replace")
    offset += 64
    source, offset = _varstring(data, offset, 256)
    if data[offset] != 0:
        raise NefError("%s: reserved byte is not zero" % path)
    offset += 1
    token_count, offset = _varint(data, offset)
    if token_count > 128:
        raise NefError("%s: too many method tokens" % path)
    tokens = []
    for _ in range(token_count):
        if offset + 20 > len(data):
            raise NefError("%s: truncated method token" % path)
        token_hash = data[offset:offset + 20]
        offset += 20
        method, offset = _varstring(data, offset, 32)
        if offset + 4 > len(data):
            raise NefError("%s: truncated method token" % path)
        tokens.append({"hash": "0x" + token_hash[::-1].hex(), "method": method,
                       "parameters": int.from_bytes(data[offset:offset + 2], "little"),
                       "hasReturnValue": bool(data[offset + 2]), "callFlags": data[offset + 3]})
        offset += 4
    if data[offset:offset + 2] != b"\x00\x00":
        raise NefError("%s: reserved bytes are not zero" % path)
    offset += 2
    script_length, offset = _varint(data, offset)
    if offset + script_length + 4 > len(data):
        raise NefError("%s: script overruns the file" % path)
    script = data[offset:offset + script_length]
    offset += script_length
    if offset + 4 != len(data):
        raise NefError("%s: unexpected trailing bytes" % path)
    checksum = int.from_bytes(data[offset:offset + 4], "little")
    expected = int.from_bytes(hashlib.sha256(hashlib.sha256(data[:offset]).digest()).digest()[:4], "little")
    if checksum != expected:
        raise NefError("%s: checksum mismatch" % path)
    return {"compiler": compiler, "source": source, "tokens": tokens, "script": script}

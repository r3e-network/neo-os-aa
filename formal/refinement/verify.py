#!/usr/bin/env python3
"""Bind refinement evidence to current inputs without promoting partial proofs."""
import hashlib
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

_DECODER_SPEC = importlib.util.spec_from_file_location("sa_refinement_nef_decode", Path(__file__).with_name("nef_decode.py"))
_DECODER = importlib.util.module_from_spec(_DECODER_SPEC)
_DECODER_SPEC.loader.exec_module(_DECODER)


class RefinementError(ValueError):
    """Invalid or insufficiently bound verification evidence."""


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def tool_snapshot(directory, dependencies=()):
    snapshot = {str(p): sha256(p) for p in directory.rglob("*") if p.is_file()
            and not any(part in {"bin", "obj", "__pycache__"} for part in p.relative_to(directory).parts)
            and p.suffix in {".py", ".cs", ".csproj", ".v", ".txt", ".json"}}
    snapshot.update({str(p): sha256(p) for p in dependencies})
    return snapshot


def project_snapshot(root):
    """Bind source membership as well as bytes, matching exporter CollectInputs.

    NCCS recursively includes contract sources. Hashing only recorded paths
    misses a newly added partial class or build configuration during a run.
    Generated outputs are excluded by the same directory rules as the exporter.
    """
    root = Path(root).resolve()
    ignored = {".git", "node_modules", "bin", "obj", ".codegraph", ".next", "build"}
    suffixes = {".cs", ".csproj", ".props", ".targets", ".json", ".config"}
    result = {}
    for directory, subdirectories, filenames in os.walk(root):
        current = Path(directory)
        subdirectories[:] = sorted(name for name in subdirectories if name not in ignored
                                   and (current != root or name == "contracts"))
        for name in sorted(filenames):
            path = current / name
            if path.suffix in suffixes:
                result[str(path)] = sha256(path)
    return result


def require(condition, message):
    if not condition:
        raise RefinementError(message)


# The retired custom kernel carried a public NEF build, a source project and a
# sponsorship model, and this lane bound all three. Phase 3 deleted them, so the
# lane has no live implementation to bind. Re-pointing it at the native overlay
# would certify a different build under a different compiler pipeline, so the
# lane is archived instead: the historical receipts under refinement/fixtures
# stay verbatim and the receipt validators below still audit their shape.
ARCHIVED_LANE = ("the custom kernel was retired in Phase 3 and its public NEF build no longer exists; "
                 "historical receipts are kept verbatim under formal/refinement/fixtures and "
                 "native coverage is claimed by formal/verify.py")


def decode_nef(raw):
    """Strictly decode a canonical NEF3 for independent byte-identity checks.

    This is evidence binding, not a formally verified container parser. The
    NCCS-bundled Neo decoder is also executed by the C# exporter. This binding
    parser applies the target Neo/VM 3.10.1 limits independently of that older
    compiler tool dependency. It is not a semantics/refinement theorem.
    """
    require(len(raw) >= 79, "truncated NEF container")
    # Neo.VM 3.10.1, commit 004cd607: Default.MaxItemSize = ushort.MaxValue * 2.
    require(len(raw) <= _DECODER.VM_MAX_ITEM_SIZE, "NEF container exceeds runtime size limit")
    require(raw[:4] == b"NEF3", "invalid NEF magic")
    expected = hashlib.sha256(hashlib.sha256(raw[:-4]).digest()).digest()[:4]
    require(raw[-4:] == expected, "NEF checksum mismatch")
    compiler = raw[4:68]
    text, separator, padding = compiler.partition(b"\x00")
    require(not separator or padding == bytes(len(padding)), "nonzero compiler padding")
    try:
        text.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise RefinementError("invalid compiler UTF-8") from exc
    body = memoryview(raw[:-4])
    pos = 68

    def take(length):
        nonlocal pos
        require(length >= 0 and pos + length <= len(body), "truncated NEF field")
        data = bytes(body[pos:pos + length]); pos += length
        return data

    def varint():
        first = take(1)[0]
        if first < 253:
            return first
        size, minimum = {253: (2, 253), 254: (4, 65536), 255: (8, 4294967296)}[first]
        value = int.from_bytes(take(size), "little")
        require(value >= minimum, "noncanonical NEF length")
        return value

    def string(limit):
        length = varint()
        require(length <= limit, "NEF string exceeds field limit")
        try:
            return take(length).decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise RefinementError("invalid UTF-8 in NEF") from exc

    source = string(256)
    require(take(1) == b"\x00", "nonzero NEF reserved byte")
    count = varint()
    require(count <= 128, "NEF token count exceeds runtime limit")
    require(count <= len(body) // 25, "invalid NEF token count")
    tokens = []
    for _ in range(count):
        script_hash = take(20).hex()
        method = string(32)
        require(not method.startswith("_"), "reserved NEF token method")
        parameters = int.from_bytes(take(2), "little")
        returned, flags = take(2)
        require(returned in (0, 1), "invalid NEF token return flag")
        require(flags & ~15 == 0, "invalid NEF token call flags")
        tokens.append({"hashLittleEndian": script_hash, "method": method,
                       "parametersCount": parameters, "hasReturnValue": bool(returned), "callFlags": flags})
    require(take(2) == b"\x00\x00", "nonzero NEF reserved word")
    length = varint()
    require(length > 0, "empty NEF script")
    script = take(length)
    require(pos == len(body), "trailing bytes after NEF script")
    return {"script": script, "tokens": tokens, "source": source, "checksum": raw[-4:].hex()}


def validate_inventory(inventory, nef_path, manifest_path, source_root):
    """Recheck exact current inputs, byte coverage and complete ABI inventory."""
    require(inventory.get("schema") == "neoos-sa-refinement-inventory/v1", "unsupported inventory schema")
    require(inventory.get("status") == "INVENTORY_ONLY", "inventory cannot assert proof status")
    nef_path, manifest_path, source_root = map(lambda p: Path(p).resolve(), (nef_path, manifest_path, source_root))
    inputs = inventory.get("inputs", {})
    require(isinstance(inputs, dict) and inputs, "missing input hash inventory")
    paths = {}
    for name, digest in inputs.items():
        p = Path(name)
        p = (source_root / p).resolve() if not p.is_absolute() else p.resolve()
        require(p not in paths, "duplicate normalized input path")
        require(p.is_file() and sha256(p) == digest, "input hash mismatch: " + str(p))
        paths[p] = digest
    require(nef_path in paths and manifest_path in paths, "NEF/manifest missing from input hash inventory")
    require(any(p.suffix == ".cs" and source_root in p.parents for p in paths), "missing bound C# source")
    require(inventory.get("source", {}).get("methods"), "missing typed source methods")
    require(inventory.get("sourceMap", {}).get("exactByteMatch") is True, "source mapping does not match exact NEF")
    decoded = decode_nef(nef_path.read_bytes())
    target = inventory.get("nef", {})
    require(target.get("sha256") == sha256(nef_path), "NEF inventory hash mismatch")
    require(target.get("scriptHex") == decoded["script"].hex(), "NEF script bytes mismatch")
    require(target.get("scriptSha256") == hashlib.sha256(decoded["script"]).hexdigest(), "NEF script hash mismatch")
    instructions = target.get("instructions", [])
    require(isinstance(instructions, list) and instructions, "empty instruction inventory")
    try:
        independently_decoded = _DECODER.decode_script(decoded["script"], len(decoded["tokens"]))
    except ValueError as exc:
        raise RefinementError("independent instruction decode: " + str(exc)) from exc
    require(len(independently_decoded) == len(instructions), "instruction count mismatch")
    for actual, exported in zip(independently_decoded, instructions):
        require(isinstance(exported, dict) and all(exported.get(key) == value for key, value in actual.items()),
                "instruction/operand/control-flow target inventory mismatch at " + str(actual["offset"]))
    tokens = [{"hash": "0x" + bytes.fromhex(t["hashLittleEndian"])[::-1].hex(),
               "method": t["method"], "parametersCount": t["parametersCount"],
               "hasReturnValue": t["hasReturnValue"], "callFlags": t["callFlags"]} for t in decoded["tokens"]]
    require(target.get("tokens", []) == tokens, "NEF token inventory mismatch")
    offset, boundaries = 0, set()
    for instruction in instructions:
        size = instruction.get("size")
        require(type(size) is int and size > 0, "invalid instruction size")
        require(instruction.get("offset") == offset and offset + size <= len(decoded["script"]), "instruction byte coverage mismatch")
        require(type(instruction.get("opcode")) is int and instruction["opcode"] == decoded["script"][offset], "instruction opcode mismatch")
        boundaries.add(offset); offset += size
    require(offset == len(decoded["script"]), "incomplete instruction byte coverage")
    for instruction in instructions:
        for edge in instruction.get("edges", []):
            if edge["kind"] == "unresolved-indirect-call":
                continue  # Exact raw-byte decoder already checked this explicit unresolved edge.
            require(type(edge.get("target")) is int and edge["target"] in boundaries, "control-flow target is not an instruction boundary")
    try:
        manifest = json.loads(manifest_path.read_text())
        methods = manifest["abi"]["methods"]
    except (ValueError, KeyError, TypeError) as exc:
        raise RefinementError("invalid ABI manifest") from exc
    require(inventory.get("manifest", {}).get("sha256") == sha256(manifest_path), "manifest hash mismatch")
    require(methods and inventory["manifest"].get("methods") == methods, "manifest methods omitted or changed")
    signatures = set()
    for method in methods:
        require(type(method.get("offset")) is int and method["offset"] in boundaries, "ABI entry is not an instruction boundary")
        require(isinstance(method.get("name"), str) and isinstance(method.get("parameters"), list), "invalid ABI method descriptor")
        signature = (method["name"], len(method["parameters"]))
        require(signature not in signatures, "duplicate ABI dispatch signature")
        signatures.add(signature)
    return {"abiEntries": len(methods), "instructions": len(instructions),
            "scriptBytes": len(decoded["script"]), "sourceMethods": len(inventory["source"]["methods"]),
            "sourceMethodScope": "Compilation inventory including framework and non-target types; not target reachability",
            "distinctOpcodes": len({i["opcode"] for i in independently_decoded}),
            "structuralEdges": sum(len(i["edges"]) for i in independently_decoded),
            "nativeCallTokens": len(decoded["tokens"]),
            "boundInputs": len(paths)}


def coverage_report(inventory, proof, *, supporting_proofs=None, helper_inventory=None,
                    expected_source_projection_sha256=None):
    """Account for the exact scope implemented by this proof backend.

    These receipts are generated by fresh subprocesses in main, not accepted
    from callers as release certificates. Even complete private-helper reference
    refinement cannot certify public entrypoints or the actual ApplicationEngine.
    """
    require(proof.get("scope") == "arithmetic-region", "unsupported semantic certificate scope")
    require(proof.get("kernelChecked") is True, "proof kernel has not accepted the region certificate")
    require(proof.get("fullImplementationVerified") is None or proof.get("fullImplementationVerified") is False,
            "region proof cannot certify full implementation")
    methods = inventory["manifest"]["methods"]
    report = {
        "implementationVerified": False,
        "status": "PARTIAL-PROOF-FULL-REFINEMENT-OPEN",
        "verifiedEntrypoints": [],
        "unprovedEntrypoints": [m["name"] + "/" + str(len(m["parameters"])) for m in methods],
        "regionProof": proof,
        "openObligations": [
            "SOURCE_FRONTEND_SEMANTIC_BINDING", "ALL_ENTRYPOINTS_AND_REACHABLE_HELPERS",
            "NEO_DIALECT_TO_COMPILER_CORRESPONDENCE", "CALLER_STATIC_AND_LEDGER_INVARIANTS",
            "HEAP_CONTEXTUAL_FRAME_AND_CALLER_COMPOSITION",
            "REGION_ENTRY_STATE_AND_EXIT_EFFECTS", "STORAGE_AND_SERIALIZATION",
            "EXCEPTIONS_AND_TRANSACTION_ROLLBACK", "EXTERNAL_CALLS_AND_REENTRANCY",
            "GAS_AND_RESOURCE_FAULTS", "APPLICATION_ENGINE_REFINEMENT",
            "PROTOCOL_MODEL_TO_IMPLEMENTATION_COMPOSITION",
        ],
    }
    if supporting_proofs is not None:
        require(isinstance(supporting_proofs, dict) and set(supporting_proofs) == {"method", "numeric", "reservation"},
                "complete-helper gate requires all three supporting proof lanes")
        scopes = {"method": "complete-helper-reference-refinement", "numeric": "numeric-coercions",
                  "reservation": "reservation-arithmetic"}
        for name, scope in scopes.items():
            receipt = supporting_proofs[name]
            require(isinstance(receipt, dict) and receipt.get("scope") == scope, "unsupported " + name + " proof scope")
            require(receipt.get("kernelChecked") is True, name + " proof is not kernel checked")
            require(receipt.get("fullImplementationVerified") is False, name + " proof cannot certify full implementation")
        method = supporting_proofs["method"]
        require(isinstance(helper_inventory, dict), "missing independently decoded helper inventory")
        require(method.get("referenceRefinementVerified") is True, "complete helper reference refinement is not proved")
        for field in ("nefSha256", "scriptSha256"):
            require(method.get(field) == helper_inventory.get(field) == inventory["nef"].get("sha256" if field == "nefSha256" else field),
                    "helper proof artifact identity mismatch: " + field)
        require(method.get("methodSha256") == helper_inventory.get("methodBytesSha256"), "helper proof byte identity mismatch")
        require(method.get("methodRange") == [helper_inventory.get("start"), helper_inventory.get("endExclusive")],
                "helper proof range mismatch")
        for field in ("byteCount", "instructionCount"):
            require(type(method.get(field)) is int and method[field] == helper_inventory.get(field),
                    "helper proof coverage mismatch: " + field)
        require(isinstance(method.get("sourceProjectionSha256"), str)
                and re.fullmatch(r"[0-9a-f]{64}", method["sourceProjectionSha256"]), "missing source projection identity")
        require(method["sourceProjectionSha256"] == expected_source_projection_sha256,
                "helper proof source projection identity mismatch")
        report["supportingProofs"] = supporting_proofs
        report["helperInventory"] = helper_inventory
        report["openObligations"].remove("REGION_ENTRY_STATE_AND_EXIT_EFFECTS")
        report["closedScopedObligations"] = ["COMPLETE_CAP_HELPER_REFERENCE_BODY_UNDER_DECLARED_CONTRACTS"]
    return report


def _run(command, output_path, timeout):
    """Retain complete tool diagnostics and reject nonzero/timeout outcomes."""
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        def as_text(value):
            return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else (value or "")
        output_path.write_text(as_text(exc.stdout) + as_text(exc.stderr) + "\nTool timeout\n")
        raise RefinementError("tool timed out; see " + str(output_path)) from exc
    except OSError as exc:
        output_path.write_text(str(exc) + "\n")
        raise RefinementError("tool unavailable or timed out: " + command[0]) from exc
    output_path.write_text(result.stdout + result.stderr)
    require(result.returncode == 0, "tool failed; see " + str(output_path))
    return result.stdout


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output-dir", type=Path, required=True, help="New or empty evidence directory")
    parser.add_argument("--compiler-tool-dir", type=Path)
    parser.add_argument("--allow-partial", action="store_true", help="Return success for checked partial proofs while keeping full refinement unverified")
    parser.add_argument("--arithmetic-only", action="store_true", help="Reproduce the earlier arithmetic-region lane only; never certify full refinement")
    parser.add_argument("--timeout-seconds", type=int, default=300)
    parser.parse_args(argv)
    # Fail closed: an archived lane must never emit a receipt, not even a stale
    # one, because any receipt it produced would name a build that no longer
    # exists. Exit 1 is the same code the lane returned for invalid evidence.
    print("Refinement verification archived: " + ARCHIVED_LANE, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

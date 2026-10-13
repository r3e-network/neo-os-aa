"""Complete-method structural accounting, never a semantics/proof checker.

Instruction bytes and local edges come from nef_decode's independently attested
Neo.VM table. Method/source identity comes from bound exporter debug metadata;
its compiler correspondence is an explicit open obligation. The environment
plan targets ordinary Neo 3.10.1, not the native AA fork. No syscall/native
handler, exception, gas, storage, or whole-method theorem is proved here.
"""
import argparse
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parent
METHOD = "AbstractAccount.UnifiedSmartWallet.CapReimbursementToActualCost(System.Numerics.BigInteger)"
NEO_CORE_COMMIT = "d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d"
STDLIB_HASH = "0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0"
SYSCALLS = {
    hashlib.sha256(name.encode()).digest()[:4].hex(): name for name in (
        "System.Runtime.GetScriptContainer", "System.Storage.GetContext",
        "System.Storage.Get", "System.Storage.Put")}


def module(name):
    spec = importlib.util.spec_from_file_location("method_inventory_" + name, ROOT / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def require(condition, message):
    if not condition:
        raise ValueError(message)


def interval(text):
    require(isinstance(text, str) and re.fullmatch(r"\d+-\d+", text), "invalid inclusive method range")
    start, last = map(int, text.split("-"))
    require(start <= last, "reversed method range")
    return start, last + 1


def build_method_inventory(inventory, method_id=METHOD):
    require(isinstance(inventory, dict), "invalid inventory")
    target = inventory.get("nef", {})
    try:
        script = bytes.fromhex(target["scriptHex"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("invalid raw script") from exc
    require(hashlib.sha256(script).hexdigest() == target.get("scriptSha256"), "raw script hash mismatch")
    require(isinstance(target.get("sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", target["sha256"]), "missing NEF identity")
    tokens = target.get("tokens", [])
    require(isinstance(tokens, list), "invalid token inventory")
    decoder = module("nef_decode")
    decoded = decoder.decode_script(script, len(tokens))
    exported = target.get("instructions", [])
    require(isinstance(exported, list) and len(exported) == len(decoded), "independent instruction count mismatch")
    require(all(isinstance(e, dict) and all(e.get(k) == v for k, v in d.items()) for d, e in zip(decoded, exported)),
            "independent instruction metadata mismatch")
    source_map = inventory.get("sourceMap", {})
    require(source_map.get("exactByteMatch") is True, "missing exact-byte source mapping")
    focused = [r for r in source_map.get("focusedMethods", []) if r.get("id") == method_id]
    debug = source_map.get("debug", {})
    matches = [r for r in debug.get("methods", []) if r.get("id") == method_id]
    require(len(focused) == len(matches) == 1, "ambiguous or missing method mapping")
    focused, declared = focused[0], matches[0]
    require(focused.get("source") == declared and focused.get("range") == declared.get("range"), "debug/focused method disagreement")
    start, end = interval(declared.get("range"))
    boundaries = {r["offset"] for r in decoded} | {len(script)}
    require(start in boundaries and end in boundaries and 0 <= start < end <= len(script), "method range is not exact instruction boundaries")
    rows = [dict(r) for r in decoded if start <= r["offset"] < end]
    require(rows and rows[0]["name"] == "INITSLOT" and rows[-1]["name"] == "RET", "missing complete method prefix/return suffix")
    require(rows[-1]["offset"] + rows[-1]["size"] == end, "incomplete method byte coverage")
    frame = bytes.fromhex(rows[0]["operandHex"])
    require(len(frame) == 2 and frame[0] == len(declared.get("variables", [])) and frame[1] == len(declared.get("params", [])), "method frame/debug mismatch")
    for other in debug.get("methods", []):
        if other is declared:
            continue
        a, b = interval(other.get("range"))
        require(b <= start or end <= a, "overlapping debug method ranges")
    documents = debug.get("documents", [])
    require(isinstance(documents, list) and all(isinstance(d, str) for d in documents), "invalid source documents")
    points = {}
    for point in declared.get("sequence-points", []):
        match = re.fullmatch(r"(\d+)\[(\d+)\](\d+):(\d+)-(\d+):(\d+)", point) if isinstance(point, str) else None
        require(match is not None, "invalid source point")
        pc, document, line, column, last_line, last_column = map(int, match.groups())
        require(start <= pc < end and pc in boundaries and document < len(documents), "source point is not an instruction/document boundary")
        require(min(line, column, last_line, last_column) > 0 and (line, column) <= (last_line, last_column), "invalid source location")
        points.setdefault(pc, []).append({"documentIndex": document, "document": documents[document],
                                         "startLine": line, "startColumn": column, "endLine": last_line, "endColumn": last_column})
    for row in rows:
        row["sourcePoints"] = points.get(row["offset"], [])
    external, calls, indirect, handlers, outgoing = [], [], [], [], []
    conditional, unconditional = [], []
    for row in rows:
        pc, name = row["offset"], row["name"]
        for edge in row["edges"]:
            if edge["kind"] == "call":
                calls.append({"offset": pc, "target": edge["target"], "insideMethod": start <= edge["target"] < end})
            elif edge["kind"] == "unresolved-indirect-call":
                indirect.append({"offset": pc, "target": None})
            elif edge["kind"] in {"catch", "finally"}:
                handlers.append({"offset": pc, **edge})
            elif edge["kind"] == "branch":
                record = {"offset": pc, "target": edge["target"]}
                (unconditional if name in {"JMP", "JMP_L", "ENDTRY", "ENDTRY_L"} else conditional).append(record)
            if edge["target"] is not None and not start <= edge["target"] < end:
                outgoing.append({"offset": pc, **edge})
        if name == "SYSCALL":
            identifier = row["operandHex"]
            external.append({"offset": pc, "kind": "syscall", "identifierHex": identifier,
                             "name": SYSCALLS.get(identifier),
                             "classification": "pinned-handler-correspondence-open" if identifier in SYSCALLS else "unresolved-syscall",
                             "handlerSemanticsProved": False})
        elif name == "CALLT":
            index = int.from_bytes(bytes.fromhex(row["operandHex"]), "little")
            token = tokens[index]
            require(isinstance(token, dict), "invalid method token")
            known = token.get("hash") == STDLIB_HASH and token.get("method") in {"serialize", "deserialize"}
            external.append({"offset": pc, "kind": "native-call", "tokenIndex": index, "token": dict(token),
                             "classification": "pinned-stdlib-correspondence-open" if known else "unresolved-token-effect",
                             "handlerSemanticsProved": False})
    source_methods = inventory.get("source", {}).get("methods", [])
    locations = [r.get("location") for r in source_methods if r.get("id") == "M:" + method_id]
    counts = dict(sorted(Counter(r["name"] for r in rows).items()))
    return {"schema": "neoos-aa-complete-method-inventory/v1", "status": "STRUCTURAL_INVENTORY_ONLY",
            "methodId": method_id, "nefSha256": target["sha256"], "scriptSha256": target["scriptSha256"],
            "methodBytesSha256": hashlib.sha256(script[start:end]).hexdigest(), "start": start, "endExclusive": end,
            "byteCount": end - start, "instructionCount": len(rows), "distinctOpcodeCount": len(counts),
            "opcodeCounts": counts, "frame": {"localCount": frame[0], "argumentCount": frame[1]},
            "instructions": rows, "sourceLocations": locations, "conditionalBranches": conditional,
            "unconditionalBranches": unconditional, "internalCalls": calls, "unresolvedIndirectCalls": indirect,
            "declaredExceptionHandlers": handlers, "outgoingEdges": outgoing, "externalEffects": external,
            "normalReturns": [r["offset"] for r in rows if r["name"] == "RET"],
            "explicitFaultTerminals": [r["offset"] for r in rows if r["name"] in {"ABORT", "ABORTMSG", "THROW"}],
            "openExternalCorrespondence": bool(external or indirect or outgoing or handlers),
            "neoCoreSourceCommit": NEO_CORE_COMMIT, "neoVmSourceCommit": decoder.NEO_VM_SOURCE_COMMIT,
            "opcodeTableSha256": decoder.OPCODE_TABLE_SHA256,
            "wholeMethodVerified": False, "implementationVerified": False,
            "openObligations": ["COMPILER_DEBUG_AND_SOURCE_MAPPING", "ALL_OPCODE_SEMANTICS_AND_FAULTS",
                                "HANDLER_ENVIRONMENT_CORRESPONDENCE", "GAS_AND_RESOURCE_BOUNDS",
                                "CALLER_STATE_AND_STATIC_INITIALIZATION", "TRANSACTION_ROLLBACK_AND_COMPOSITION"]}


def assess_certificate_coverage(report, certificate):
    """Account for claimed region intervals; neither authenticate nor prove them."""
    require(isinstance(certificate, dict) and certificate.get("scope") == "arithmetic-region", "whole-method certificate checker is not implemented here")
    # Exporter debug IDs omit Roslyn's documented method-kind prefix; existing
    # actual proof receipts retain that exact M: prefix. Accept only these two
    # known spellings, never suffix/name-only or overload-insensitive matching.
    require(certificate.get("sourceMethod") in {report["methodId"], "M:" + report["methodId"]}, "certificate method identity mismatch")
    require(certificate.get("nefSha256") == report["nefSha256"] and certificate.get("scriptSha256") == report["scriptSha256"], "certificate artifact identity mismatch")
    require(all(certificate.get(field) is None or certificate.get(field) is False
                for field in ("fullImplementationVerified", "implementationVerified", "wholeMethodVerified")),
            "region certificate cannot assert whole implementation")
    start, end = report["start"], report["endExclusive"]
    boundaries = {r["offset"] for r in report["instructions"]} | {end}
    regions = certificate.get("verifiedRegions", [])
    require(isinstance(regions, list) and regions, "missing claimed regions")
    ranges = []
    for region in regions:
        require(isinstance(region, dict), "invalid claimed region")
        a, b = region.get("start"), region.get("endExclusive")
        require(type(a) is type(b) is int and start <= a < b <= end and a in boundaries and b in boundaries, "claimed region is not exact method instruction boundaries")
        ranges.append((a, b))
    merged = []
    for a, b in sorted(ranges):
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
        else:
            merged.append((a, b))
    missing, cursor = [], start
    for a, b in merged:
        if cursor < a: missing.append({"start": cursor, "endExclusive": a})
        cursor = b
    if cursor < end: missing.append({"start": cursor, "endExclusive": end})
    claimed = [r["offset"] for r in report["instructions"] if any(a <= r["offset"] and r["offset"] + r["size"] <= b for a, b in merged)]
    return {"status": "CLAIMED_REGION_ACCOUNTING_ONLY", "claimedInstructionCount": len(claimed),
            "claimedInstructionOffsets": claimed, "uncoveredByteRanges": missing,
            "uncoveredInstructionOffsets": [r["offset"] for r in report["instructions"] if r["offset"] not in claimed],
            "wholeByteRangeClaimed": not missing, "wholeMethodVerified": False, "implementationVerified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, default=ROOT.parent.parent)
    parser.add_argument("--nef", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--certificate", type=Path)
    parser.add_argument("--json-report", type=Path, required=True)
    args = parser.parse_args()
    root = args.source_root.resolve()
    report = {"status": "FAIL", "wholeMethodVerified": False, "implementationVerified": False}
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    args.json_report.write_text(json.dumps(report) + "\n")
    try:
        tool_paths = [Path(__file__), ROOT / "nef_decode.py", ROOT / "verify.py"]
        tools_before = {str(p.relative_to(ROOT.parent.parent)): hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in tool_paths}
        raw_inventory = args.inventory.read_bytes()
        inventory = json.loads(raw_inventory)
        binding = module("verify")
        source_before = binding.project_snapshot(root)
        require(all(inventory.get("inputs", {}).get(path) == digest for path, digest in source_before.items()),
                "source membership/content missing from inventory")
        nef = args.nef or root / "contracts/bin/v3/UnifiedSmartWalletV3.nef"
        manifest = args.manifest or root / "contracts/bin/v3/UnifiedSmartWalletV3.manifest.json"
        binding.validate_inventory(inventory, nef, manifest, root)
        report = build_method_inventory(inventory)
        if args.certificate:
            report["certificateCoverage"] = assess_certificate_coverage(report, json.loads(args.certificate.read_text()))
        binding.validate_inventory(inventory, nef, manifest, root)
        require(binding.project_snapshot(root) == source_before, "source membership/content changed during inventory")
        require(args.inventory.read_bytes() == raw_inventory, "inventory changed during accounting")
        require(all(hashlib.sha256((ROOT.parent.parent / name).read_bytes()).hexdigest() == digest
                    for name, digest in tools_before.items()), "inventory tool changed during accounting")
        report["inventorySha256"] = hashlib.sha256(raw_inventory).hexdigest()
        report["sourceMembershipSha256"] = hashlib.sha256(json.dumps(source_before, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        report["toolInputSha256"] = tools_before
        args.json_report.write_text(json.dumps(report, indent=2) + "\n")
        return 0
    except Exception as exc:
        args.json_report.write_text(json.dumps({"status": "FAIL", "wholeMethodVerified": False,
                                              "implementationVerified": False, "failure": type(exc).__name__ + ": " + str(exc)}, indent=2) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

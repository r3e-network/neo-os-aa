#!/usr/bin/env python3
"""Freeze check for the SmartAccount v4.1 IDL against the native source of truth.

Read-only. It never rewrites the IDL, the manifest fixture or the C# sources.
It proves that the machine-readable contract matches the current attributes and
fixture, and that the frozen v4.1 surface has no rename, alias or retired entry.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IDL = ROOT / "docs/proposals/smartaccount-v4.1.idl.json"
FIXTURE = ROOT / "tests/fixtures/native-smartaccount.manifest.json"
NATIVE = ROOT / "contracts/native/SmartAccount"
SPEC = ROOT / "docs/SA-SPEC.zh-CN.md"
PROTOCOL = [ROOT / "docs/SA-MODULE-PROTOCOL.md", ROOT / "docs/SA-MODULE-PROTOCOL.zh-CN.md"]
ARCHITECTURE = ROOT / "docs/ARCHITECTURE.md"
MODULES_README = ROOT / "contracts/modules/README.md"

# The approved native ABI. Order is the IDL order and must not drift. The kernel
# exposes exactly one execution entry; a multi-operation surface is retired, not
# reserved behind a gate.
FROZEN = """createAccount createAccounts getAccount getAccountAddress freezeAccount unfreezeAccount
executeUserOp validateUserOp validateMember verify getOperationDigest getNonce getNonceSequence
installModule removeModule configureModule setBuiltinAuthorization applyConfigurationActions revokeModuleCredentials
resetAccount getModules getModule isModuleInstalled getAuthorizedModuleId getProtocolInfo
getAccountImplementationId""".split()

FORBIDDEN_ADDITIONS = {"getConfigurationNonce", "getUserOpDigest", "getOperationDomain", "listModules", "getAddress"}
RETIRED_METHODS = {"isValidSignature", "executeUserOps", "setRecoveryPolicy", "getMessageSubjects", "getThresholdPolicy",
                   "beginRecovery", "cancelRecovery", "executeRecovery", "getRecoveryStatus",
                   "getHookOrder", "setHookOrder"}
EVENT_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 16, 17]
RETIRED_EVENT_IDS = [11, 14, 15]
REQUIRED_SECTIONS = ["schema", "protocol", "authority", "nativeContract", "responsibilityBoundary",
                     "types", "methods", "events", "retiredEvents", "retiredNativeSurface",
                     "canonicalOperation", "digestDomains", "nonce", "configuration", "lifecycle",
                     "storage", "hardfork", "reset", "errors", "p256", "assets", "verification"]

# Phrases that must not survive in active normative prose after the v4.1 pass.
PROTO_FORBIDDEN = [
    "28 public methods",
    "29 core methods",
    "isValidSignature(accountId, hash, signatureEnvelope)",
    "direct administration has no 24-hour delay",
    "Direct administration of actions 1, 2, 5 and 8 has no 24-hour delay",
]

EVENT_RE = re.compile(
    r'\[ContractEvent\(\s*Hardfork\.\w+\s*,\s*(\d+)\s*,\s*"(\w+)"'
    r'((?:\s*,\s*"[^"]*"\s*,\s*ContractParameterType\.\w+)*)\s*\)\]')
EVENT_PAIR_RE = re.compile(r'"([^"]*)"\s*,\s*ContractParameterType\.(\w+)')
METHOD_RE = re.compile(
    r'\[ContractMethod\(([^\]]*)\)\]\s*(?:private|public|internal|protected)[^\n;{]*?\b(\w+)\s*\(')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def idl_methods(data):
    return {m["name"]: m for m in data["methods"]}


def gather_flags():
    flags = {}
    for path in NATIVE.glob("*.cs"):
        text = path.read_text(encoding="utf-8")
        for attr, name in METHOD_RE.findall(text):
            match = re.search(r'RequiredCallFlags\s*=\s*CallFlags\.(\w+)', attr)
            key = name[:1].lower() + name[1:]
            require(key not in flags, f"duplicate ContractMethod attribute: {key}")
            flags[key] = match.group(1) if match else "None"
    return flags


def gather_events():
    events = {}
    for path in NATIVE.glob("*.cs"):
        text = path.read_text(encoding="utf-8")
        for event_id, name, tail in EVENT_RE.findall(text):
            require(name not in events, f"duplicate ContractEvent attribute: {name}")
            fields = [(field, kind) for field, kind in EVENT_PAIR_RE.findall(tail)]
            events[name] = (int(event_id), fields)
    return events


def check_structure(data):
    missing = [section for section in REQUIRED_SECTIONS if section not in data]
    require(not missing, f"IDL is missing sections: {missing}")
    require(data["schema"] == "smartaccount-idl/v4.1", "unexpected IDL schema tag")
    require(data["nativeContract"]["implementationId"] == "NativeSmartAccount", "implementation id drifted")
    require(data["nativeContract"]["hash"] == "0x398dc3f0227d7efac5533ed5ce9937390c158084", "native hash drifted")


def check_names(data):
    names = [m["name"] for m in data["methods"]]
    require(len(names) == len(set(names)), "duplicate method name in IDL")
    require(names == FROZEN, f"IDL methods differ from the frozen 26: {sorted(set(names) ^ set(FROZEN))}")
    overlap = set(names) & (RETIRED_METHODS | FORBIDDEN_ADDITIONS)
    require(not overlap, f"retired or forbidden method present: {sorted(overlap)}")
    retired = {m["name"] for m in data["retiredNativeSurface"]["methods"]}
    require(retired >= {"isValidSignature", "executeUserOps"}, "the retired native entries must stay listed as retired")
    require(retired.isdisjoint(FROZEN), "a retired method reappears in the active ABI")
    require(set(data["retiredNativeSurface"]["forbiddenAdditions"]) == FORBIDDEN_ADDITIONS,
            "forbidden-additions list drifted from the approved plan")


def check_against_fixture(data, fixture):
    methods = {m["name"]: m for m in fixture["abi"]["methods"]}
    extra = set(methods) - set(FROZEN)
    require(not extra, f"fixture exposes unapproved methods: {sorted(extra)}")
    missing = set(FROZEN) - set(methods)
    require(not missing, f"fixture is missing approved methods: {sorted(missing)}")
    for name, entry in idl_methods(data).items():
        require(name in methods, f"IDL method absent from the native fixture: {name}")
        actual = methods[name]
        require([p["type"] for p in entry["parameters"]] == [p["type"] for p in actual["parameters"]],
                f"{name}: parameter types differ from the fixture")
        require([p["name"] for p in entry["parameters"]] == [p["name"] for p in actual["parameters"]],
                f"{name}: parameter names differ from the fixture")
        require(entry["returnType"] == actual["returntype"], f"{name}: return type differs from the fixture")
        require(bool(entry["safe"]) == bool(actual["safe"]), f"{name}: safe flag differs from the fixture")
    return False


def check_flags(data, flags):
    for name, entry in idl_methods(data).items():
        require(name in flags, f"no ContractMethod attribute found for {name}")
        require(entry["callFlags"] == flags[name],
                f"{name}: IDL callFlags {entry['callFlags']} != C# {flags[name]}")
        require(entry["cpuFee"] == 1 << 15, f"{name}: cpu fee must be the base native fee")


def check_events(data, events):
    ids = [e["id"] for e in data["events"]]
    require(len(ids) == len(set(ids)), "duplicate active event id")
    require(sorted(ids) == EVENT_IDS, f"active event ids differ: {sorted(ids)}")
    retired = [e["id"] for e in data["retiredEvents"]]
    require(sorted(retired) == RETIRED_EVENT_IDS, f"retired event ids differ: {sorted(retired)}")
    require(set(ids).isdisjoint(retired), "an event id is both active and retired")
    for entry in data["events"]:
        name = entry["name"]
        require(name in events, f"active event {name} has no ContractEvent attribute")
        event_id, fields = events[name]
        require(event_id == entry["id"], f"{name}: id {entry['id']} != C# {event_id}")
        pairs = [(p["name"], p["type"]) for p in entry["parameters"]]
        require(pairs == fields, f"{name}: payload differs from C# {fields}")
    require(set(events) == {e["name"] for e in data["events"]},
            f"C# event set differs: {sorted(set(events) ^ {e['name'] for e in data['events']})}")
    require(all(e["id"] not in RETIRED_EVENT_IDS for e in data["events"]), "retired event id is active")


def check_documentation():
    spec = SPEC.read_text(encoding="utf-8")
    require("smartaccount-v4.1.idl.json" in spec, "SA-SPEC does not name the authoritative IDL")
    # The frozen IDL is the active machine contract; the prose manuscript keeps
    # its own historical wording and is not a count source for this gate.
    require("PDF" in spec or "pdf" in spec, "SA-SPEC does not mark the PDF as historical")
    for path in PROTOCOL:
        text = path.read_text(encoding="utf-8")
        for phrase in PROTO_FORBIDDEN:
            require(phrase not in text, f"{path.name} keeps retired claim: {phrase}")
        require("SigningModule" in text, f"{path.name} does not name the sole message entry")
    require("smartaccount-v4.1.idl.json" in ARCHITECTURE.read_text(encoding="utf-8"),
            "ARCHITECTURE does not name the authoritative IDL")
    require("smartaccount-v4.1.idl.json" in MODULES_README.read_text(encoding="utf-8"),
            "contracts/modules/README.md does not name the authoritative IDL")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--idl", type=Path, default=IDL, help="IDL file to check (default: frozen path)")
    parser.add_argument("--fixture", type=Path, default=FIXTURE, help="native manifest fixture")
    parser.add_argument("--skip-docs", action="store_true", help="only check the IDL against C# and the fixture")
    args = parser.parse_args()

    data = load(args.idl)
    fixture = load(args.fixture)
    check_structure(data)
    check_names(data)
    pending = check_against_fixture(data, fixture)
    check_flags(data, gather_flags())
    check_events(data, gather_events())
    if not args.skip_docs:
        check_documentation()

    message = f"SmartAccount v4.1 IDL verified: {len(data['methods'])} methods, {len(data['events'])} events, " \
              f"{len(data['retiredEvents'])} retired event ids"
    if pending:
        message += f"; fixture still exposes {', '.join(pending)} pending hardfork retirement"
    print(message)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as exc:
        sys.exit(f"SmartAccount v4.1 IDL check failed: {exc}")
